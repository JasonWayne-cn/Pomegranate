//! T-024 同步 V1：sync_backends + sync_remote_state DAO
//!
//! 不和老 `database/sync.rs`（V0 ZIP 模式的 vacuum_into 等辅助）混在一起，
//! 单独成模块。老代码保留兼容 V0 流程。

use rusqlite::params;
use rusqlite::OptionalExtension;

use crate::error::AppError;
use crate::models::{SyncBackend, SyncBackendInput, SyncBackendKind, SyncRemoteState};

use super::Database;

fn parse_kind(s: &str) -> SyncBackendKind {
    match s {
        "local" => SyncBackendKind::Local,
        "webdav" => SyncBackendKind::Webdav,
        "s3" => SyncBackendKind::S3,
        "lan" => SyncBackendKind::Lan,
        // git 已下线（曾在原型阶段保留）；老数据兜底为 Local，让用户在 UI 上重选
        _ => SyncBackendKind::Local,
    }
}

fn kind_to_str(k: SyncBackendKind) -> &'static str {
    match k {
        SyncBackendKind::Local => "local",
        SyncBackendKind::Webdav => "webdav",
        SyncBackendKind::S3 => "s3",
        SyncBackendKind::Lan => "lan",
    }
}

// ─── 凭据字段加密（DAO 边界，上层无感）────────────
//
// 算法 / 密钥复用 crate::crypto 的 `enc:v1:` 字段加密（与 AI Key、V0 WebDAV 密码同一套）：
// 密钥由本机 hostname 派生，防的是 "app.db 被拷走后密码明文泄漏"。代价：换机器 / 改主机名后
// 解不开，需重填一次密码 —— 解不开时打 `_secretUnreadable` 标记，parse_auth 据此给出明确提示，
// 而不是拿密文当密码去请求、最后报一个让人摸不着头脑的 401。

/// 该 kind 的 config_json 里哪些字段是凭据（字段名与 services::sync_v1::backend::parse_auth 一致）
fn secret_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "webdav" => &["password"],
        "s3" => &["secretKey"],
        // 配对令牌 = 访问那台电脑的凭据，和密码一样加密存
        "lan" => &["token"],
        _ => &[],
    }
}

/// 解密失败时写进 config_json 的标记字段，见 [`open_config_json`]
pub const SECRET_UNREADABLE_KEY: &str = "_secretUnreadable";

/// 把 config_json 里的凭据字段加密后返回（幂等：已是密文的不再套一层）。
///
/// - 解析不了的 JSON 原样返回：这里不负责校验，坏配置会在 parse_auth 处报错
/// - 只有在「所有凭据字段都能正常使用（刚加密的明文 / 可解密的旧密文）」时才去掉
///   `_secretUnreadable` 标记。否则保留标记 —— 否则用户点一次保存，警告消失但密码仍不可用
pub(crate) fn seal_config_json(kind: &str, json: &str) -> Result<String, AppError> {
    let fields = secret_fields(kind);
    let Ok(serde_json::Value::Object(mut map)) = serde_json::from_str::<serde_json::Value>(json)
    else {
        return Ok(json.to_string());
    };
    let mut all_usable = true;
    for f in fields {
        match map.get(*f) {
            Some(serde_json::Value::String(v)) if !v.is_empty() => {
                if crate::crypto::is_encrypted_field(v) {
                    // 旧密文：解不开说明是换机器 / 改主机名，保留标记让用户重填
                    if crate::crypto::decrypt_field(v).is_err() {
                        all_usable = false;
                    }
                } else {
                    let sealed = crate::crypto::encrypt_field(v)?;
                    map.insert((*f).to_string(), serde_json::Value::String(sealed));
                }
            }
            // 缺字段（可能由 keep_unsent_secrets 补过）或空串：不算"可用"
            _ => all_usable = false,
        }
    }
    if all_usable {
        map.remove(SECRET_UNREADABLE_KEY);
    }
    serde_json::to_string(&serde_json::Value::Object(map))
        .map_err(|e| AppError::Custom(format!("config_json 序列化失败: {}", e)))
}

/// 编辑保存时补回没传的凭据：新 config_json 里缺某个凭据字段 → 沿用库里原来的（密文原样搬）。
///
/// 移动端编辑表单不回显密码，「密码留空 / 没重新扫码」时就不带该字段，语义是「不修改」；
/// 不补的话整份覆盖会把凭据清掉，下次同步才报认证失败。传了（含空串）就以传入为准。
fn keep_unsent_secrets(kind: &str, new_json: &str, old_raw: &str) -> String {
    let fields = secret_fields(kind);
    let (Ok(serde_json::Value::Object(mut map)), Ok(serde_json::Value::Object(old))) = (
        serde_json::from_str::<serde_json::Value>(new_json),
        serde_json::from_str::<serde_json::Value>(old_raw),
    ) else {
        return new_json.to_string();
    };
    let mut changed = false;
    for f in fields {
        if map.contains_key(*f) {
            continue;
        }
        if let Some(v) = old.get(*f) {
            map.insert((*f).to_string(), v.clone());
            changed = true;
        }
    }
    if !changed {
        return new_json.to_string();
    }
    serde_json::to_string(&serde_json::Value::Object(map)).unwrap_or_else(|_| new_json.to_string())
}

/// 把 config_json 里的凭据字段解密后返回。
///
/// - 历史明文（无 `enc:v1:` 前缀）原样返回，兼容迁移前 / 迁移失败的行
/// - 解不开（换机器 / 改主机名）：字段置空 + 打 `_secretUnreadable: true` 标记，不让整个列表失败
///   （否则设置页打空，用户连重填的入口都找不到）
pub(crate) fn open_config_json(kind: &str, json: &str, backend_id: i64) -> String {
    let fields = secret_fields(kind);
    if fields.is_empty() {
        return json.to_string();
    }
    let Ok(serde_json::Value::Object(mut map)) = serde_json::from_str::<serde_json::Value>(json)
    else {
        return json.to_string();
    };
    let mut unreadable = false;
    for f in fields {
        let Some(serde_json::Value::String(stored)) = map.get(*f) else {
            continue;
        };
        // 明文（迁移失败 / 老数据）原样保留，不强行解密
        if !crate::crypto::is_encrypted_field(stored) {
            continue;
        }
        let plain = match crate::crypto::decrypt_field(stored) {
            Ok(p) => p,
            Err(e) => {
                log::warn!(
                    "[sync-v1] backend #{} 的 {} 解密失败（通常是换了机器 / 改了主机名），\
                     需在同步设置里重新填写: {}",
                    backend_id,
                    f,
                    e
                );
                unreadable = true;
                String::new()
            }
        };
        map.insert((*f).to_string(), serde_json::Value::String(plain));
    }
    if unreadable {
        map.insert(SECRET_UNREADABLE_KEY.into(), serde_json::Value::Bool(true));
    }
    serde_json::to_string(&serde_json::Value::Object(map)).unwrap_or_else(|_| json.to_string())
}

/// 行映射（list / get 共用）。列顺序须与 [`BACKEND_COLUMNS`] 一致。
fn row_to_backend(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncBackend> {
    let kind_str: String = row.get(1)?;
    let id: i64 = row.get(0)?;
    let raw_config: String = row.get(3)?;
    Ok(SyncBackend {
        id,
        kind: parse_kind(&kind_str),
        name: row.get(2)?,
        config_json: open_config_json(&kind_str, &raw_config, id),
        enabled: row.get::<_, i32>(4)? != 0,
        auto_sync: row.get::<_, i32>(5)? != 0,
        sync_interval_min: row.get(6)?,
        last_push_ts: row.get(7)?,
        last_pull_ts: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_error: row.get(11)?,
        last_error_at: row.get(12)?,
    })
}

const BACKEND_COLUMNS: &str = "id, kind, name, config_json, enabled, auto_sync, sync_interval_min,
     last_push_ts, last_pull_ts, created_at, updated_at, last_error, last_error_at";

impl Database {
    // ─── sync_backends ─────────────────────────

    pub fn list_sync_backends(&self) -> Result<Vec<SyncBackend>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM sync_backends ORDER BY id ASC",
            BACKEND_COLUMNS
        ))?;
        let rows = stmt
            .query_map([], row_to_backend)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_sync_backend(&self, id: i64) -> Result<Option<SyncBackend>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let row = conn
            .query_row(
                &format!("SELECT {} FROM sync_backends WHERE id = ?1", BACKEND_COLUMNS),
                [id],
                row_to_backend,
            )
            .ok();
        Ok(row)
    }

    pub fn create_sync_backend(&self, input: &SyncBackendInput) -> Result<i64, AppError> {
        // 加密放在拿锁之前：纯 CPU 计算，没必要占着主连接
        let sealed = seal_config_json(kind_to_str(input.kind), &input.config_json)?;
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO sync_backends
             (kind, name, config_json, enabled, auto_sync, sync_interval_min)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                kind_to_str(input.kind),
                input.name,
                sealed,
                input.enabled.unwrap_or(true) as i32,
                input.auto_sync.unwrap_or(false) as i32,
                input.sync_interval_min.unwrap_or(30),
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_sync_backend(&self, id: i64, input: &SyncBackendInput) -> Result<(), AppError> {
        let kind = kind_to_str(input.kind);
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        // 没传的凭据沿用原值（只在类型没变时；换了类型旧凭据没意义）
        let old: Option<(String, String)> = conn
            .query_row(
                "SELECT kind, config_json FROM sync_backends WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let merged = match &old {
            Some((old_kind, old_raw)) if old_kind == kind => {
                keep_unsent_secrets(kind, &input.config_json, old_raw)
            }
            _ => input.config_json.clone(),
        };
        let sealed = seal_config_json(kind, &merged)?;
        let affected = conn.execute(
            "UPDATE sync_backends SET
                kind = ?1, name = ?2, config_json = ?3,
                enabled = ?4, auto_sync = ?5, sync_interval_min = ?6,
                updated_at = datetime('now', 'localtime')
             WHERE id = ?7",
            params![
                kind,
                input.name,
                sealed,
                input.enabled.unwrap_or(true) as i32,
                input.auto_sync.unwrap_or(false) as i32,
                input.sync_interval_min.unwrap_or(30),
                id,
            ],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("sync_backend {} 不存在", id)));
        }
        Ok(())
    }

    /// 只改 config_json（凭据字段照常加密）。给程序自动修正配置用，如局域网同步写回
    /// mDNS 找到的新地址；不动 `updated_at` 以外的列
    pub fn set_sync_backend_config_json(
        &self,
        id: i64,
        kind: SyncBackendKind,
        config_json: &str,
    ) -> Result<(), AppError> {
        let sealed = seal_config_json(kind_to_str(kind), config_json)?;
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE sync_backends SET config_json = ?1, updated_at = datetime('now', 'localtime')
             WHERE id = ?2",
            params![sealed, id],
        )?;
        Ok(())
    }

    /// 记录 / 清除 backend 最近一次同步错误。`Some` 写入并打时间戳，`None` 清空。
    ///
    /// 不碰 `updated_at`：那是配置的修改时间，同步结果不算改配置。
    pub fn set_sync_backend_error(&self, id: i64, error: Option<&str>) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        match error {
            Some(msg) => conn.execute(
                "UPDATE sync_backends
                 SET last_error = ?2, last_error_at = datetime('now', 'localtime')
                 WHERE id = ?1",
                params![id, msg],
            )?,
            None => conn.execute(
                "UPDATE sync_backends SET last_error = NULL, last_error_at = NULL
                 WHERE id = ?1 AND last_error IS NOT NULL",
                [id],
            )?,
        };
        Ok(())
    }

    pub fn delete_sync_backend(&self, id: i64) -> Result<bool, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute("DELETE FROM sync_backends WHERE id = ?1", [id])?;
        Ok(affected > 0)
    }

    pub fn touch_sync_backend_push(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE sync_backends
             SET last_push_ts = datetime('now', 'localtime'),
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    pub fn touch_sync_backend_pull(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE sync_backends
             SET last_pull_ts = datetime('now', 'localtime'),
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    // ─── sync_remote_state ─────────────────────

    /// 拿某 backend 下所有文档的同步状态，hash map 返回（按 note_id 索引）
    pub fn list_remote_state(
        &self,
        backend_id: i64,
    ) -> Result<std::collections::HashMap<i64, SyncRemoteState>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT backend_id, note_id, remote_path, last_synced_hash, last_synced_ts, tombstone
             FROM sync_remote_state WHERE backend_id = ?1",
        )?;
        let rows = stmt
            .query_map([backend_id], |row| {
                Ok(SyncRemoteState {
                    backend_id: row.get(0)?,
                    note_id: row.get(1)?,
                    remote_path: row.get(2)?,
                    last_synced_hash: row.get(3)?,
                    last_synced_ts: row.get(4)?,
                    tombstone: row.get::<_, i32>(5)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().map(|s| (s.note_id, s)).collect())
    }

    /// upsert 一条同步状态（推送/拉取成功后调）
    pub fn upsert_remote_state(
        &self,
        backend_id: i64,
        note_id: i64,
        remote_path: &str,
        content_hash: &str,
        updated_ts: &str,
        tombstone: bool,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO sync_remote_state
                (backend_id, note_id, remote_path, last_synced_hash, last_synced_ts, tombstone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(backend_id, note_id) DO UPDATE SET
                remote_path      = excluded.remote_path,
                last_synced_hash = excluded.last_synced_hash,
                last_synced_ts   = excluded.last_synced_ts,
                tombstone        = excluded.tombstone",
            params![
                backend_id,
                note_id,
                remote_path,
                content_hash,
                updated_ts,
                tombstone as i32,
            ],
        )?;
        Ok(())
    }

    /// 清空某 backend 下所有 sync_remote_state 行
    ///
    /// 用于 hash 算法升级（v1 → v2）：远端 manifest 是旧算法时调本方法，
    /// 本机失去与该远端的同步状态映射 → 下次 push 会把本地全部文档当作新增上传，
    /// 下次 pull 跳过（避免按旧 hash 误 diff）。
    pub fn clear_remote_state_for_backend(&self, backend_id: i64) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected =
            conn.execute("DELETE FROM sync_remote_state WHERE backend_id = ?1", [backend_id])?;
        Ok(affected)
    }

    /// 物理删除已确认 tombstone 推送完成的状态行
    ///
    /// 预留给 T-024 后续阶段：tombstone 同步成功后清理 sync_remote_state
    #[allow(dead_code)]
    pub fn purge_remote_state(&self, backend_id: i64, note_id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "DELETE FROM sync_remote_state WHERE backend_id = ?1 AND note_id = ?2",
            [backend_id, note_id],
        )?;
        Ok(())
    }

    /// P2-c：清理 `sync_remote_state` 里的死数据行。
    ///
    /// 删除条件：state 行的 `note_id` 已不在 `compute_local_manifest` 的范围内 ——
    /// 即文档被硬删（不在 `notes` 表）、或软删且 `deleted_at` 早于 `tombstone_cutoff`
    /// （超 tombstone 保留期）。这类文档永不再进 manifest、diff 不会处理它们，
    /// 对应的 state 行是纯死数据。
    ///
    /// `tombstone_cutoff` 由调用方传 `compute_local_manifest` 同款的 30 天前阈值。
    /// 文档若被 restore（`is_deleted` 1→0）会重回 manifest 范围 → 不被本方法删。
    /// 一条 SQL 清所有 backend（某文档超期 → 所有 backend 的 manifest 都不带它）。
    ///
    /// 返回删除的行数。
    pub fn gc_sync_remote_state(&self, tombstone_cutoff: &str) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let affected = conn.execute(
            "DELETE FROM sync_remote_state
             WHERE note_id NOT IN (
                 SELECT id FROM notes
                 WHERE is_deleted = 0
                    OR (is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at >= ?1)
             )",
            params![tombstone_cutoff],
        )?;
        Ok(affected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{NoteInput, SyncBackendInput, SyncBackendKind};

    /// P2-c：gc_sync_remote_state 删孤儿行 + 超期 tombstone 行，
    /// 保留活文档 / 30 天内软删的 state 行
    #[test]
    fn gc_sync_remote_state_removes_dead_rows() {
        let db = Database::init(":memory:").unwrap();

        let backend_id = db
            .create_sync_backend(&SyncBackendInput {
                kind: SyncBackendKind::Local,
                name: "t".into(),
                config_json: "{}".into(),
                enabled: Some(true),
                auto_sync: Some(false),
                sync_interval_min: Some(30),
            })
            .unwrap();

        let n_alive = db
            .create_note(&NoteInput {
                title: "活".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        let n_recent = db
            .create_note(&NoteInput {
                title: "近删".into(),
                content: "y".into(),
                folder_id: None,
            })
            .unwrap();
        let n_old = db
            .create_note(&NoteInput {
                title: "久删".into(),
                content: "z".into(),
                folder_id: None,
            })
            .unwrap();

        // 三条真文档 + 一条孤儿（note_id 不存在，模拟硬删）都登记 sync_remote_state
        for nid in [n_alive.id, n_recent.id, n_old.id, 999_999] {
            db.upsert_remote_state(backend_id, nid, "notes/x.md", "h", "2026-01-01", false)
                .unwrap();
        }

        // n_recent 最近软删（deleted_at = now）
        db.soft_delete_note(n_recent.id).unwrap();
        // n_old 改成 60 天前删（超 30 天阈值）
        let old_ts = (chrono::Local::now() - chrono::Duration::days(60))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
                params![old_ts, n_old.id],
            )
            .unwrap();
        }

        let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let removed = db.gc_sync_remote_state(&cutoff).unwrap();
        assert_eq!(removed, 2, "应删：n_old（超 30 天软删）+ 999999（孤儿）");

        let states = db.list_remote_state(backend_id).unwrap();
        assert!(states.contains_key(&n_alive.id), "活文档 state 必须保留");
        assert!(states.contains_key(&n_recent.id), "30 天内软删 state 必须保留");
        assert!(!states.contains_key(&n_old.id), "超 30 天软删 state 应删除");
        assert!(!states.contains_key(&999_999), "孤儿 state 应删除");
    }

    /// 文档被 restore（is_deleted 1→0）→ 重回 manifest 范围 → GC 不应删它的 state
    #[test]
    fn gc_keeps_state_of_restored_note() {
        let db = Database::init(":memory:").unwrap();
        let backend_id = db
            .create_sync_backend(&SyncBackendInput {
                kind: SyncBackendKind::Local,
                name: "t".into(),
                config_json: "{}".into(),
                enabled: Some(true),
                auto_sync: Some(false),
                sync_interval_min: Some(30),
            })
            .unwrap();
        let n = db
            .create_note(&NoteInput {
                title: "复活".into(),
                content: "x".into(),
                folder_id: None,
            })
            .unwrap();
        db.upsert_remote_state(backend_id, n.id, "notes/x.md", "h", "2026-01-01", false)
            .unwrap();

        // 软删到 60 天前 → 再 restore
        let old_ts = (chrono::Local::now() - chrono::Duration::days(60))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
                params![old_ts, n.id],
            )
            .unwrap();
        }
        db.restore_note(n.id).unwrap();

        let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let removed = db.gc_sync_remote_state(&cutoff).unwrap();
        assert_eq!(removed, 0, "已 restore 的文档重回 manifest 范围 → 不删 state");
        assert!(db.list_remote_state(backend_id).unwrap().contains_key(&n.id));
    }

    fn raw_config(db: &Database, id: i64) -> String {
        let conn = db.conn_lock().unwrap();
        conn.query_row(
            "SELECT config_json FROM sync_backends WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn webdav_input(password: Option<&str>) -> SyncBackendInput {
        let mut cfg = serde_json::json!({"url": "https://dav", "username": "u"});
        if let Some(p) = password {
            cfg["password"] = serde_json::Value::String(p.into());
        }
        SyncBackendInput {
            kind: SyncBackendKind::Webdav,
            name: "wd".into(),
            config_json: cfg.to_string(),
            enabled: Some(true),
            auto_sync: Some(false),
            sync_interval_min: Some(30),
        }
    }

    fn password_of(json: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(json)
            .ok()?
            .get("password")?
            .as_str()
            .map(String::from)
    }

    /// create 落库即密文；DAO 读出是明文
    #[test]
    fn create_seals_credentials_and_reads_plain() {
        let db = Database::init(":memory:").unwrap();
        let id = db.create_sync_backend(&webdav_input(Some("s3cret"))).unwrap();

        let raw = raw_config(&db, id);
        assert!(
            crate::crypto::is_encrypted_field(&password_of(&raw).unwrap()),
            "落库必须是 enc:v1 密文: {raw}"
        );
        let got = db.get_sync_backend(id).unwrap().unwrap();
        assert_eq!(password_of(&got.config_json).as_deref(), Some("s3cret"));
        assert!(!got.config_json.contains(SECRET_UNREADABLE_KEY));
    }

    /// 编辑不带密码 = 沿用旧密文；传空串 = 清空
    #[test]
    fn update_keeps_unsent_secret_and_accepts_empty() {
        let db = Database::init(":memory:").unwrap();
        let id = db.create_sync_backend(&webdav_input(Some("old"))).unwrap();
        let sealed_old = password_of(&raw_config(&db, id)).unwrap();

        db.update_sync_backend(id, &webdav_input(None)).unwrap();
        assert_eq!(
            password_of(&raw_config(&db, id)).as_deref(),
            Some(sealed_old.as_str()),
            "没传密码应保留原密文，不能整份覆盖清掉"
        );
        assert_eq!(
            password_of(&db.get_sync_backend(id).unwrap().unwrap().config_json).as_deref(),
            Some("old")
        );

        db.update_sync_backend(id, &webdav_input(Some(""))).unwrap();
        assert_eq!(
            password_of(&raw_config(&db, id)).as_deref(),
            Some(""),
            "传空串表示用户主动清空"
        );
    }

    /// 换机器 / 改主机名：解不开 → 字段置空 + 标记；保存时标记不能被无条件抹掉
    #[test]
    fn unreadable_secret_sets_flag_and_seal_keeps_it() {
        let db = Database::init(":memory:").unwrap();
        let id = db.create_sync_backend(&webdav_input(Some("x"))).unwrap();
        let broken = "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        {
            let conn = db.conn_lock().unwrap();
            conn.execute(
                "UPDATE sync_backends SET config_json = ?1 WHERE id = ?2",
                params![format!(r#"{{"url":"https://dav","username":"u","password":"{broken}"}}"#), id],
            )
            .unwrap();
        }

        let got = db.get_sync_backend(id).unwrap().unwrap();
        assert_eq!(password_of(&got.config_json).as_deref(), Some(""));
        assert!(got.config_json.contains(SECRET_UNREADABLE_KEY));

        // 模拟「用户在编辑框没重填密码直接保存」：keep 保留旧密文，seal 必须保留标记
        db.update_sync_backend(id, &webdav_input(None)).unwrap();
        let still = db.get_sync_backend(id).unwrap().unwrap();
        assert!(
            still.config_json.contains(SECRET_UNREADABLE_KEY),
            "凭据仍不可解密时必须继续提示重填: {}",
            still.config_json
        );
    }

    /// set_sync_backend_config_json 也要加密；last_error 写入 / 清空
    #[test]
    fn set_config_json_and_last_error() {
        let db = Database::init(":memory:").unwrap();
        let id = db.create_sync_backend(&webdav_input(Some("p"))).unwrap();

        db.set_sync_backend_config_json(
            id,
            SyncBackendKind::Webdav,
            r#"{"url":"https://dav2","username":"u","password":"new"}"#,
        )
        .unwrap();
        let raw = raw_config(&db, id);
        assert!(crate::crypto::is_encrypted_field(&password_of(&raw).unwrap()));
        assert_eq!(
            password_of(&db.get_sync_backend(id).unwrap().unwrap().config_json).as_deref(),
            Some("new")
        );

        db.set_sync_backend_error(id, Some("pull 失败: boom")).unwrap();
        let b = db.get_sync_backend(id).unwrap().unwrap();
        assert_eq!(b.last_error.as_deref(), Some("pull 失败: boom"));
        assert!(b.last_error_at.is_some());

        db.set_sync_backend_error(id, None).unwrap();
        let b = db.get_sync_backend(id).unwrap().unwrap();
        assert!(b.last_error.is_none() && b.last_error_at.is_none());
    }

    /// LAN 令牌同样走字段加密
    #[test]
    fn lan_token_is_sealed() {
        let db = Database::init(":memory:").unwrap();
        let id = db
            .create_sync_backend(&SyncBackendInput {
                kind: SyncBackendKind::Lan,
                name: "lan".into(),
                config_json: r#"{"hosts":["192.168.1.2"],"port":47321,"fp":"AA","token":"tkn"}"#
                    .into(),
                enabled: Some(true),
                auto_sync: Some(false),
                sync_interval_min: Some(30),
            })
            .unwrap();
        let raw: serde_json::Value = serde_json::from_str(&raw_config(&db, id)).unwrap();
        assert!(crate::crypto::is_encrypted_field(
            raw["token"].as_str().unwrap()
        ));
        let plain: serde_json::Value =
            serde_json::from_str(&db.get_sync_backend(id).unwrap().unwrap().config_json).unwrap();
        assert_eq!(plain["token"], "tkn");
    }
}
