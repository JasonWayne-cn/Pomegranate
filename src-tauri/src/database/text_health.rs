//! 数据库 TEXT 列的 UTF-8 健康：**降级读取** + **一键体检 / 修复**
//!
//! ## 为什么需要这个模块
//!
//! SQLite 的 TEXT 列只是"声明为文本"，实际存的是**任意字节序列** —— SQLite 不校验 UTF-8。
//! Rust 侧的 `String` 写不出非法 UTF-8，所以正常写入路径永远产不出坏数据；但下面这些
//! 外部因素会让 db 文件里出现非法字节：
//!
//! - 跨平台 / 运行中直接拷 `app.db`（漏拷 `-wal` / `-shm`，或拷到一半）
//! - 数据目录放在 OneDrive / 坚果云等双向同步盘里，页级冲突合并
//! - 磁盘坏道、异常断电导致的页损坏
//!
//! 一旦某个 cell 有非法字节，`row.get::<_, String>(i)` 会返回
//! `Conversion error from type Text at index: i, invalid utf-8 sequence...`，
//! 于是**整条查询失败** —— 用户表现为"同步/拉取整个失败"，几千条好笔记被一行坏数据拖死。
//!
//! ## 两层应对
//!
//! 1. [`get_text_lossy`] / [`get_opt_text_lossy`]：热点批量查询改用降级读，
//!    坏 cell 用 `U+FFFD` 替换字符顶上并 `warn` 日志，**不中断整条查询**。
//! 2. [`Database::check_text_health`]：全库体检，可选 `repair` 把坏 cell lossy 修正写回。
//!    挂在设置页给用户自助，也在同步报错时引导用户来点。

use rusqlite::types::ValueRef;
use rusqlite::Row;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

use super::Database;

// ─────────────────────────── 降级读工具 ───────────────────────────

/// 日志里坏字节预览的最大长度（字符数），避免把整篇笔记打进日志
const PREVIEW_CHARS: usize = 80;

/// 截断字符串用于日志 / 报告展示（按**字符**截断，不会切碎多字节字符）
fn preview(s: &str) -> String {
    if s.chars().count() <= PREVIEW_CHARS {
        return s.to_string();
    }
    let head: String = s.chars().take(PREVIEW_CHARS).collect();
    format!("{}…", head)
}

/// 读一个**非空** TEXT 列；遇到非法 UTF-8 时降级为 `from_utf8_lossy` 而不是让整条查询失败。
///
/// `loc` 只用于日志定位，形如 `"notes.updated_at"`。
///
/// 语义与 `row.get::<_, String>(idx)` 完全一致，**只有**"列里是 Text/Blob 但字节非法 UTF-8"
/// 这一种情况会走降级；NULL、整数列、列越界等错误照常上抛，不掩盖真正的代码 BUG。
pub fn get_text_lossy(row: &Row<'_>, idx: usize, loc: &str) -> rusqlite::Result<String> {
    match row.get::<_, String>(idx) {
        Ok(s) => Ok(s),
        Err(e) => {
            let raw = match row.get_ref(idx) {
                Ok(v) => v,
                // 拿 ValueRef 都失败（列越界等）→ 返回原始错误，信息更准确
                Err(_) => return Err(e),
            };
            match raw {
                ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
                    let fixed = String::from_utf8_lossy(bytes).into_owned();
                    log::warn!(
                        "[text-health] {} 含非法 UTF-8（{} 字节），本次读取已降级修正为: {}",
                        loc,
                        bytes.len(),
                        preview(&fixed)
                    );
                    Ok(fixed)
                }
                // NULL / Integer / Real：不是本模块要救的场景，保持原错误语义
                _ => Err(e),
            }
        }
    }
}

/// [`get_text_lossy`] 的 `Option` 版本：列为 NULL 时返回 `None`。
pub fn get_opt_text_lossy(row: &Row<'_>, idx: usize, loc: &str) -> rusqlite::Result<Option<String>> {
    match row.get::<_, Option<String>>(idx) {
        Ok(v) => Ok(v),
        Err(e) => {
            let raw = match row.get_ref(idx) {
                Ok(v) => v,
                Err(_) => return Err(e),
            };
            match raw {
                ValueRef::Null => Ok(None),
                ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
                    let fixed = String::from_utf8_lossy(bytes).into_owned();
                    log::warn!(
                        "[text-health] {} 含非法 UTF-8（{} 字节），本次读取已降级修正为: {}",
                        loc,
                        bytes.len(),
                        preview(&fixed)
                    );
                    Ok(Some(fixed))
                }
                _ => Err(e),
            }
        }
    }
}

// ─────────────────────────── 体检 / 修复 ───────────────────────────

/// 一个坏 cell 的定位信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHealthIssue {
    /// 表名
    pub table: String,
    /// 列名
    pub column: String,
    /// 该行主键值（`notes.id` 等）
    pub row_id: i64,
    /// 修正后的内容预览（截断到 80 字符）—— 给用户定位是哪条笔记
    pub preview: String,
    /// 是否已写回修复（`repair = false` 时恒为 false）
    pub repaired: bool,
}

/// 体检报告
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHealthReport {
    /// 实际扫过的 TEXT cell 数
    pub scanned_cells: i64,
    /// 发现的问题（按表 → 行顺序）
    pub issues: Vec<TextHealthIssue>,
    /// 成功写回修复的 cell 数
    pub repaired_cells: i64,
    /// 修复过程中写回失败的说明（不中断整体流程）
    pub errors: Vec<String>,
}

/// 参与体检的目标：`(表名, 主键列, TEXT 列清单)`
///
/// 这些标识符**全部是本文件里的字面量常量**（非用户输入），拼进 SQL 无注入风险。
/// 实际执行前还会用 `PRAGMA table_info` 过滤掉当前库里不存在的列，兼容老库。
const TEXT_TARGETS: &[(&str, &str, &[&str])] = &[
    (
        "notes",
        "id",
        &[
            "title",
            "content",
            "content_hash",
            "title_normalized",
            "created_at",
            "updated_at",
            "deleted_at",
            "stable_uuid",
            "daily_date",
            "search_text",
        ],
    ),
    ("folders", "id", &["name", "created_at", "updated_at"]),
    ("tags", "id", &["name", "created_at"]),
    ("tasks", "id", &["title", "note", "created_at", "updated_at"]),
    ("projects", "id", &["name", "description", "created_at", "updated_at"]),
    ("task_categories", "id", &["name", "color", "icon", "created_at"]),
    ("app_config", "rowid", &["key", "value"]),
];

impl Database {
    /// 全库 TEXT 列 UTF-8 体检。`repair = true` 时把坏 cell 的 lossy 修正结果写回。
    ///
    /// ## 修复的连带处理（仅 `notes` 表）
    /// - 改了 `content` → 重算 `content_hash`（否则同步 diff 会与远端对不上）
    /// - 改了 `title` → 重算 `title_normalized`（wiki 链接查找依赖它）
    ///
    /// FTS5 索引由 `notes` 上的 AFTER UPDATE 触发器自动跟随，无需手工重建。
    ///
    /// 单个 cell 写回失败只记进 `errors`，不中断整体扫描 —— 体检的价值就在于
    /// "尽可能多修"，不能因为一行修不了就整体放弃。
    pub fn check_text_health(&self, repair: bool) -> Result<TextHealthReport, AppError> {
        let conn = self.conn_lock()?;
        let mut report = TextHealthReport::default();

        for (table, pk, columns) in TEXT_TARGETS {
            // 表不存在（老库 / 未来删表）→ 跳过
            if !table_exists(&conn, table)? {
                continue;
            }
            let existing = column_set(&conn, table)?;
            let cols: Vec<&str> = columns
                .iter()
                .copied()
                .filter(|c| *c == "rowid" || existing.iter().any(|e| e == c))
                .collect();
            if cols.is_empty() {
                continue;
            }

            // 逐列独立扫：一次只读一列，避免把整行（含大 content）都拉进内存。
            // `typeof(col) = 'text'` 让 SQLite 先过滤掉 NULL / 数值行，减少回传量。
            for col in &cols {
                let sql = format!(
                    "SELECT {pk}, {col} FROM {table} WHERE typeof({col}) = 'text'",
                    pk = pk,
                    col = col,
                    table = table
                );
                let mut stmt = conn.prepare(&sql)?;
                let mut rows = stmt.query([])?;
                while let Some(row) = rows.next()? {
                    report.scanned_cells += 1;
                    let row_id: i64 = row.get(0)?;
                    let raw = row.get_ref(1)?;
                    let bytes = match raw {
                        ValueRef::Text(b) => b,
                        // typeof = 'text' 已过滤，其它类型属防御分支
                        _ => continue,
                    };
                    if std::str::from_utf8(bytes).is_ok() {
                        continue;
                    }
                    let fixed = String::from_utf8_lossy(bytes).into_owned();
                    report.issues.push(TextHealthIssue {
                        table: (*table).to_string(),
                        column: (*col).to_string(),
                        row_id,
                        preview: preview(&fixed),
                        repaired: false,
                    });
                    log::warn!(
                        "[text-health] 发现非法 UTF-8: {}.{} (rowid={}) → {}",
                        table,
                        col,
                        row_id,
                        preview(&fixed)
                    );
                    // 这里**不**立即写回：读游标还开着，同一连接上边读边改同一张表
                    // 语义脆弱（可能重复访问已改行）。统一放到下面的写回阶段。
                }
            }
        }

        if !repair || report.issues.is_empty() {
            return Ok(report);
        }

        // ── 统一写回阶段（所有读游标已释放）
        for issue in report.issues.iter_mut() {
            // 重新按 rowid 读一次原始字节（上面只留了截断预览，写回要完整内容）
            let sql = format!(
                "SELECT {col} FROM {table} WHERE {pk} = ?1",
                col = issue.column,
                table = issue.table,
                pk = pk_of(&issue.table)
            );
            let full: Option<String> = match conn.query_row(&sql, [issue.row_id], |r| {
                match r.get_ref(0)? {
                    ValueRef::Text(b) | ValueRef::Blob(b) => {
                        Ok(Some(String::from_utf8_lossy(b).into_owned()))
                    }
                    _ => Ok(None),
                }
            }) {
                Ok(v) => v,
                Err(e) => {
                    report
                        .errors
                        .push(format!("{}.{} (rowid={}) 重读失败: {}", issue.table, issue.column, issue.row_id, e));
                    continue;
                }
            };
            let Some(fixed) = full else { continue };

            let upd = format!(
                "UPDATE {table} SET {col} = ?1 WHERE {pk} = ?2",
                table = issue.table,
                col = issue.column,
                pk = pk_of(&issue.table)
            );
            if let Err(e) = conn.execute(&upd, rusqlite::params![fixed, issue.row_id]) {
                report
                    .errors
                    .push(format!("{}.{} (rowid={}) 写回失败: {}", issue.table, issue.column, issue.row_id, e));
                continue;
            }

            // notes 的派生列跟随修正，否则同步 diff / wiki 链接会与主字段脱节
            if issue.table == "notes" {
                let derived = match issue.column.as_str() {
                    "content" => Some((
                        "content_hash",
                        crate::services::hash::sha256_hex(&fixed),
                    )),
                    "title" => Some((
                        "title_normalized",
                        crate::database::links::normalize_title(&fixed),
                    )),
                    _ => None,
                };
                if let Some((dcol, dval)) = derived {
                    let dsql = format!("UPDATE notes SET {} = ?1 WHERE id = ?2", dcol);
                    if let Err(e) = conn.execute(&dsql, rusqlite::params![dval, issue.row_id]) {
                        report
                            .errors
                            .push(format!("notes.{} (id={}) 派生列更新失败: {}", dcol, issue.row_id, e));
                    }
                }
            }

            issue.repaired = true;
            report.repaired_cells += 1;
        }

        log::info!(
            "[text-health] 体检完成：扫描 {} cell，发现 {} 处，修复 {} 处，失败 {} 处",
            report.scanned_cells,
            report.issues.len(),
            report.repaired_cells,
            report.errors.len()
        );

        Ok(report)
    }
}

/// 查 `TEXT_TARGETS` 里某表用的主键列名（写回阶段用；表名一定在表里，兜底 `rowid`）
fn pk_of(table: &str) -> &'static str {
    TEXT_TARGETS
        .iter()
        .find(|(t, _, _)| *t == table)
        .map(|(_, pk, _)| *pk)
        .unwrap_or("rowid")
}

fn table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, AppError> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn column_set(conn: &rusqlite::Connection, table: &str) -> Result<Vec<String>, AppError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

