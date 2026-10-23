//! Dataview（v0.1 最简版）：5 个固定模板查询。
//!
//! 不解析 DSL、不拼 SQL —— 全部预定义 prepared statement，
//! 用户传入参数走 `?` 占位符。零注入面，零 schema 风险。
//!
//! 返回统一 `DataviewRow`：title / subtitle / link_kind / link_id / updated_at。
//! 前端用一套渲染逻辑展示，无需关心查询来源。

use rusqlite::params;

use crate::error::AppError;
use crate::models::DataviewRow;

/// 每个查询的硬上限（防止用户填超大 limit 撑死前端）
const HARD_LIMIT: i64 = 200;

fn clamp_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(20).clamp(1, HARD_LIMIT)
}

impl super::Database {
    /// 最近修改的笔记（排除已删/隐藏/日记，逻辑同主列表）
    ///
    /// 🔴 `updated_at` 只精确到秒：同一秒内改过的几条会并列，并列行的相对顺序 SQL 不保证。
    /// 各处排序都补 `id DESC` 作次级键（自增 id = 写入先后），否则「最新在前」只对跨秒的成立。
    pub fn dataview_recent_notes(&self, limit: Option<i64>) -> Result<Vec<DataviewRow>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, title, updated_at
             FROM notes
             WHERE is_deleted = 0 AND is_hidden = 0 AND is_scratch = 0 AND is_daily = 0
             ORDER BY updated_at DESC, id DESC
             LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![clamp_limit(limit)], |row| {
                Ok(DataviewRow {
                    title: row.get(1)?,
                    subtitle: None,
                    link_kind: "note".to_string(),
                    link_id: row.get::<_, i64>(0)?,
                    updated_at: row.get(2)?,
                    extra: None,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按标签筛选笔记（按 tag name 匹配；嵌套标签暂只查精确节点，不递归子孙）
    pub fn dataview_notes_by_tag(
        &self,
        tag: &str,
        limit: Option<i64>,
    ) -> Result<Vec<DataviewRow>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, n.updated_at
             FROM notes n
             INNER JOIN note_tags nt ON n.id = nt.note_id
             INNER JOIN tags t ON nt.tag_id = t.id
             WHERE n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_scratch = 0 AND n.is_daily = 0
               AND t.name = ?1
             ORDER BY n.updated_at DESC, n.id DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![tag, clamp_limit(limit)], |row| {
                Ok(DataviewRow {
                    title: row.get(1)?,
                    subtitle: None,
                    link_kind: "note".to_string(),
                    link_id: row.get::<_, i64>(0)?,
                    updated_at: row.get(2)?,
                    extra: None,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按文件夹筛选笔记（递归子文件夹）
    pub fn dataview_notes_by_folder(
        &self,
        folder_id: i64,
        limit: Option<i64>,
    ) -> Result<Vec<DataviewRow>, AppError> {
        // 复用 list_notes 的递归收集逻辑，避免重复代码
        let descendant_ids = self.collect_descendant_folder_ids(folder_id)?;
        if descendant_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let placeholders = std::iter::repeat("?")
            .take(descendant_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, title, updated_at
             FROM notes
             WHERE is_deleted = 0 AND is_hidden = 0 AND is_scratch = 0 AND is_daily = 0
               AND folder_id IN ({})
             ORDER BY updated_at DESC, id DESC
             LIMIT ?",
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let lim = clamp_limit(limit);
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> =
            descendant_ids.into_iter().map(|i| Box::new(i) as Box<dyn rusqlite::ToSql>).collect();
        binds.push(Box::new(lim));
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(binds.iter().map(|b| b.as_ref())),
                |row| {
                    Ok(DataviewRow {
                        title: row.get(1)?,
                        subtitle: None,
                        link_kind: "note".to_string(),
                        link_id: row.get::<_, i64>(0)?,
                        updated_at: row.get(2)?,
                        extra: None,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 未完成任务（status=0），按 priority + due_date 排序
    pub fn dataview_pending_tasks(&self, limit: Option<i64>) -> Result<Vec<DataviewRow>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, title, due_date, priority, updated_at
             FROM tasks
             WHERE status = 0 AND parent_task_id IS NULL
             ORDER BY priority ASC, (due_date IS NULL) ASC, due_date ASC
             LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![clamp_limit(limit)], |row| {
                let priority: i32 = row.get(3)?;
                let due_date: Option<String> = row.get(2)?;
                let priority_label = match priority {
                    0 => "紧急",
                    2 => "不急",
                    _ => "一般",
                };
                let subtitle = match (due_date.as_deref(), priority_label) {
                    (Some(d), p) => Some(format!("{} · {}", p, d)),
                    (None, p) => Some(p.to_string()),
                };
                Ok(DataviewRow {
                    title: row.get(1)?,
                    subtitle,
                    link_kind: "task".to_string(),
                    link_id: row.get::<_, i64>(0)?,
                    updated_at: row.get(4)?,
                    extra: None,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 项目下的任务（含已完成）
    pub fn dataview_tasks_by_project(
        &self,
        project_id: i64,
        limit: Option<i64>,
    ) -> Result<Vec<DataviewRow>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, title, due_date, status, updated_at
             FROM tasks
             WHERE project_id = ?1 AND parent_task_id IS NULL
             ORDER BY status ASC, (due_date IS NULL) ASC, due_date ASC, updated_at DESC, id DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![project_id, clamp_limit(limit)], |row| {
                let status: i32 = row.get(3)?;
                let due_date: Option<String> = row.get(2)?;
                let mut parts = Vec::new();
                parts.push(if status == 0 { "进行中" } else { "已完成" });
                if let Some(d) = due_date.as_deref() {
                    parts.push(d);
                }
                Ok(DataviewRow {
                    title: row.get(1)?,
                    subtitle: Some(parts.join(" · ")),
                    link_kind: "task".to_string(),
                    link_id: row.get::<_, i64>(0)?,
                    updated_at: row.get(4)?,
                    extra: None,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

