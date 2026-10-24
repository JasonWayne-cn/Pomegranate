//! 外部目录挂载 DAO
//!
//! 外部 `.md` 文件仍在磁盘上，这里只维护它们在 `notes` / `folders` 中的影子行，
//! 让 FTS、标签、双链等既有能力复用同一套 note.id。

use std::path::Path;

use rusqlite::{params, OptionalExtension};

use crate::error::AppError;
use crate::models::{
    ExternalEntry, ExternalMount, ExternalMountInput, ExternalMountUpdate, MountScanResult,
    SyncTypeSettings,
};

fn parse_sync_types(raw: Option<String>) -> SyncTypeSettings {
    raw.and_then(|s| serde_json::from_str::<SyncTypeSettings>(&s).ok())
        .unwrap_or_default()
}

fn category_for_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "md" | "markdown" | "txt" | "text" => Some("text"),
        "pdf" => Some("pdf"),
        "docx" | "doc" => Some("word"),
        "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" | "csv" | "tsv" => Some("sheet"),
        _ => None,
    }
}

use super::Database;

/// 外部笔记的定位信息（Service 层读写文件时用）
#[derive(Debug, Clone)]
pub struct ExternalNoteMeta {
    pub note_id: i64,
    pub mount_id: i64,
    pub mount_name: String,
    pub root_path: String,
    pub rel_path: String,
    pub abs_path: String,
    pub read_only: bool,
    pub missing: bool,
    pub mtime: i64,
    pub size: i64,
    pub source_type: Option<String>,
    pub content_hash: Option<String>,
    pub indexed_hash: Option<String>,
    pub indexed_at: Option<String>,
    pub stale: bool,
    pub status: Option<String>,
    pub error: Option<String>,
}

/// 影子笔记的索引状态快照
#[derive(Debug, Clone)]
pub struct ExternalNoteRow {
    pub id: i64,
    pub source_hash: Option<String>,
    pub source_mtime: Option<i64>,
    pub source_size: Option<i64>,
    pub content_hash: Option<String>,
    pub indexed_hash: Option<String>,
    pub indexed_at: Option<String>,
    pub stale: bool,
    pub status: Option<String>,
    pub error: Option<String>,
    pub source_type: Option<String>,
}

impl ExternalNoteRow {
    /// 用户是否改过影子笔记正文（当前 content_hash 与上次抽取基线不同）
    pub fn user_edited(&self) -> bool {
        match (&self.content_hash, &self.indexed_hash) {
            (Some(cur), Some(base)) => cur != base,
            // 有内容但还没有抽取基线（升级前的老数据）→ 保守按未编辑处理，
            // 让下一次外部变化可以安全重建基线。
            (Some(_), None) => false,
            _ => false,
        }
    }
}

impl Database {
    // ─── 挂载点 CRUD ─────────────────────────────

    /// 新增挂载点，并创建对应的根文件夹
    pub fn create_external_mount(
        &self,
        input: &ExternalMountInput,
    ) -> Result<ExternalMount, AppError> {
        let mount_id = {
            let conn = self
                .conn
                .lock()
                .map_err(|e| AppError::Custom(e.to_string()))?;

            let sync_types_json = serde_json::to_string(&input.sync_types)
                .map_err(|e| AppError::Custom(format!("序列化同步类型失败: {}", e)))?;
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO external_mounts
                    (name, root_path, read_only, index_enabled, daily_mode, scan_interval, sync_types)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    input.name,
                    input.root_path,
                    input.read_only as i32,
                    input.index_enabled as i32,
                    input.daily_mode as i32,
                    input.scan_interval.max(2),
                    sync_types_json
                ],
            )?;
            let mount_id = tx.last_insert_rowid();

            // 根文件夹：ext_rel_path 为空串，便于唯一索引定位
            tx.execute(
                "INSERT INTO folders (name, parent_id, mount_id, ext_rel_path)
                 VALUES (?1, NULL, ?2, '')",
                params![input.name, mount_id],
            )?;
            let folder_id = tx.last_insert_rowid();
            tx.execute(
                "UPDATE external_mounts SET root_folder_id = ?1 WHERE id = ?2",
                params![folder_id, mount_id],
            )?;
            tx.commit()?;
            mount_id
        };

        self.get_external_mount_by_id(mount_id)?
            .ok_or_else(|| AppError::Custom("创建挂载点后读取失败".into()))
    }

    /// 列出全部挂载点，附带笔记数 / 缺失数 / 可用状态
    pub fn list_external_mounts(&self) -> Result<Vec<ExternalMount>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT m.id, m.name, m.root_path, m.root_folder_id,
                    m.read_only, m.index_enabled, m.daily_mode, m.scan_interval,
                    m.created_at, m.last_scan_at,
                    (SELECT COUNT(*) FROM notes n
                       WHERE n.mount_id = m.id AND n.is_deleted = 0 AND n.ext_missing = 0) AS note_count,
                    (SELECT COUNT(*) FROM notes n
                       WHERE n.mount_id = m.id AND n.is_deleted = 0 AND n.ext_missing = 1) AS missing_count,
                    m.sync_types
             FROM external_mounts m
             ORDER BY m.created_at, m.id",
        )?;

        let rows = stmt.query_map([], |row| {
            let root_path: String = row.get(2)?;
            Ok(ExternalMount {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: root_path.clone(),
                root_folder_id: row.get(3)?,
                read_only: row.get::<_, i32>(4)? != 0,
                index_enabled: row.get::<_, i32>(5)? != 0,
                daily_mode: row.get::<_, i32>(6)? != 0,
                scan_interval: row.get(7)?,
                sync_types: parse_sync_types(row.get(12)?),
                created_at: row.get(8)?,
                last_scan_at: row.get(9)?,
                note_count: row.get::<_, i64>(10)? as usize,
                missing_count: row.get::<_, i64>(11)? as usize,
                available: Path::new(&root_path).is_dir(),
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    /// 按 id 读取挂载点（不存在返回 None）
    pub fn get_external_mount_by_id(&self, id: i64) -> Result<Option<ExternalMount>, AppError> {
        Ok(self.list_external_mounts()?.into_iter().find(|m| m.id == id))
    }

    /// 更新最近扫描时间
    pub fn touch_external_mount_scan(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE external_mounts SET last_scan_at = datetime('now', 'localtime') WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// 更新挂载点设置（只更新传入字段；改名时同步镜像根文件夹）
    pub fn update_external_mount_settings(
        &self,
        id: i64,
        input: &ExternalMountUpdate,
    ) -> Result<(), AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;

        let root_folder_id: Option<i64> = tx
            .query_row(
                "SELECT root_folder_id FROM external_mounts WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten();

        let sync_types_json = match &input.sync_types {
            Some(s) => Some(
                serde_json::to_string(s)
                    .map_err(|e| AppError::Custom(format!("序列化同步类型失败: {}", e)))?,
            ),
            None => None,
        };

        let affected = tx.execute(
            "UPDATE external_mounts
             SET name = COALESCE(?1, name),
                 read_only = COALESCE(?2, read_only),
                 index_enabled = COALESCE(?3, index_enabled),
                 daily_mode = COALESCE(?4, daily_mode),
                 scan_interval = COALESCE(?5, scan_interval),
                 sync_types = COALESCE(?6, sync_types)
             WHERE id = ?7",
            params![
                input.name,
                input.read_only.map(|b| b as i32),
                input.index_enabled.map(|b| b as i32),
                input.daily_mode.map(|b| b as i32),
                input.scan_interval,
                sync_types_json,
                id
            ],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("挂载点 {} 不存在", id)));
        }

        if let (Some(name), Some(folder_id)) = (input.name.as_deref(), root_folder_id) {
            tx.execute(
                "UPDATE folders SET name = ?1 WHERE id = ?2",
                params![name, folder_id],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    /// 按文件类别暂停/恢复已索引笔记。
    ///
    /// 暂停时保留正文，只把状态改为 `paused`；恢复时清空状态，等下一轮扫描重抽。
    pub fn set_external_notes_paused(
        &self,
        mount_id: i64,
        extensions: &[&str],
        paused: bool,
    ) -> Result<usize, AppError> {
        if extensions.is_empty() {
            return Ok(0);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let placeholders = (0..extensions.len())
            .map(|i| format!("?{}", i + 4))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "UPDATE notes
             SET ext_index_status = ?1,
                 ext_stale = CASE WHEN ?2 = 1 THEN 0 ELSE ext_stale END
             WHERE mount_id = ?3 AND source_file_type IN ({})",
            placeholders
        );
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        values.push(Box::new(if paused {
            Some("paused")
        } else {
            None::<&str>
        }));
        values.push(Box::new(paused as i32));
        values.push(Box::new(mount_id));
        for ext in extensions {
            values.push(Box::new(ext.to_string()));
        }
        let refs: Vec<&dyn rusqlite::types::ToSql> =
            values.iter().map(|v| v.as_ref()).collect();
        let affected = conn.execute(&sql, refs.as_slice())?;
        Ok(affected)
    }

    /// 删除挂载点（级联删除影子笔记和镜像文件夹，不碰磁盘文件）
    pub fn delete_external_mount(&self, id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute("DELETE FROM external_mounts WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 卸载但保留内容：影子笔记转成普通本地笔记，文件夹树丢弃
    pub fn detach_external_mount(&self, id: i64) -> Result<(), AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;
        // 先把笔记移出外部文件夹，避免 folder 删除后 folder_id 指向不存在的行
        tx.execute("UPDATE notes SET folder_id = NULL WHERE mount_id = ?1", params![id])?;
        tx.execute("DELETE FROM folders WHERE mount_id = ?1", params![id])?;
        tx.execute(
            "UPDATE notes
             SET storage_kind = 'db', mount_id = NULL, ext_rel_path = NULL,
                 ext_missing = 0, ext_mtime = NULL, ext_size = NULL, ext_hash = NULL
             WHERE mount_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM external_mounts WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    // ─── 文件夹镜像 ─────────────────────────────

    /// 确保 mount 内某个相对目录存在，返回最深一层的 folder_id
    pub fn ensure_external_folder(
        &self,
        mount_id: i64,
        root_folder_id: Option<i64>,
        rel_dir: &str,
    ) -> Result<Option<i64>, AppError> {
        if rel_dir.trim().is_empty() {
            return Ok(root_folder_id);
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut current_parent = root_folder_id;
        let mut accumulated = String::new();

        for part in rel_dir.split('/').filter(|s| !s.is_empty()) {
            if !accumulated.is_empty() {
                accumulated.push('/');
            }
            accumulated.push_str(part);

            let existing: Option<i64> = conn
                .query_row(
                    "SELECT id FROM folders WHERE mount_id = ?1 AND ext_rel_path = ?2",
                    params![mount_id, accumulated],
                    |row| row.get(0),
                )
                .optional()?;

            let folder_id = match existing {
                Some(id) => id,
                None => {
                    conn.execute(
                        "INSERT INTO folders (name, parent_id, mount_id, ext_rel_path)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![part, current_parent, mount_id, accumulated],
                    )?;
                    conn.last_insert_rowid()
                }
            };
            current_parent = Some(folder_id);
        }

        Ok(current_parent)
    }

    // ─── 影子笔记 ───────────────────────────────

    /// 查找挂载内某个相对路径对应的活跃影子笔记
    pub fn find_external_note(
        &self,
        mount_id: i64,
        rel_path: &str,
    ) -> Result<Option<ExternalNoteRow>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let row = conn
            .query_row(
                "SELECT id, ext_hash, ext_mtime, ext_size, content_hash,
                        ext_indexed_hash, ext_indexed_at, ext_stale,
                        ext_index_status, ext_index_error, source_file_type
                 FROM notes
                 WHERE mount_id = ?1 AND ext_rel_path = ?2 AND is_deleted = 0",
                params![mount_id, rel_path],
                |row| {
                    Ok(ExternalNoteRow {
                        id: row.get(0)?,
                        source_hash: row.get(1)?,
                        source_mtime: row.get(2)?,
                        source_size: row.get(3)?,
                        content_hash: row.get(4)?,
                        indexed_hash: row.get(5)?,
                        indexed_at: row.get(6)?,
                        stale: row.get::<_, i32>(7)? != 0,
                        status: row.get(8)?,
                        error: row.get(9)?,
                        source_type: row.get(10)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// 插入或更新影子笔记；返回 (note_id, 是否新建)
    ///
    /// - `source_hash`：原文件指纹（二进制文件是二进制哈希，文本是内容哈希）
    /// - `content_hash`：本次抽取出的影子正文哈希
    /// - `indexed_hash`：抽取基线，用于判断用户是否编辑过影子笔记
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_external_note(
        &self,
        mount_id: i64,
        rel_path: &str,
        folder_id: Option<i64>,
        title: &str,
        content: &str,
        source_hash: &str,
        content_hash: &str,
        indexed_hash: &str,
        mtime: i64,
        size: i64,
        source_path: Option<&str>,
        source_type: Option<&str>,
        status: Option<&str>,
        error: Option<&str>,
    ) -> Result<(i64, bool), AppError> {
        let existing = self.find_external_note(mount_id, rel_path)?.map(|r| r.id);
        let normalized = crate::database::links::normalize_title(title);

        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        if let Some(id) = existing {
            conn.execute(
                "UPDATE notes
                 SET title = ?1, content = ?2, folder_id = ?3, title_normalized = ?4,
                     content_hash = ?5, ext_mtime = ?6, ext_size = ?7, ext_hash = ?8,
                     ext_indexed_hash = ?9,
                     ext_indexed_at = datetime('now', 'localtime'),
                     ext_stale = 0, ext_index_status = ?10, ext_index_error = ?11,
                     ext_missing = 0, source_file_path = ?12, source_file_type = ?13,
                     updated_at = datetime('now', 'localtime')
                 WHERE id = ?14",
                params![
                    title,
                    content,
                    folder_id,
                    normalized,
                    content_hash,
                    mtime,
                    size,
                    source_hash,
                    indexed_hash,
                    status,
                    error,
                    source_path,
                    source_type,
                    id
                ],
            )?;
            Ok((id, false))
        } else {
            let stable_uuid = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO notes
                    (title, content, folder_id, title_normalized, content_hash, stable_uuid,
                     storage_kind, mount_id, ext_rel_path, ext_mtime, ext_size, ext_hash,
                     ext_indexed_hash, ext_indexed_at, ext_stale,
                     ext_index_status, ext_index_error,
                     ext_missing, is_scratch, source_file_path, source_file_type, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                         'external', ?7, ?8, ?9, ?10, ?11,
                         ?12, datetime('now', 'localtime'), 0,
                         ?13, ?14,
                         0, 0, ?15, ?16,
                         COALESCE(
                             (SELECT MAX(sort_order) FROM notes
                              WHERE COALESCE(folder_id, -1) = COALESCE(?3, -1) AND is_deleted = 0),
                             -1000
                         ) + 1000)",
                params![
                    title,
                    content,
                    folder_id,
                    normalized,
                    content_hash,
                    stable_uuid,
                    mount_id,
                    rel_path,
                    mtime,
                    size,
                    source_hash,
                    indexed_hash,
                    status,
                    error,
                    source_path,
                    source_type
                ],
            )?;
            Ok((conn.last_insert_rowid(), true))
        }
    }

    /// 原文件已更新，但影子笔记有本地编辑：只标记 stale，不覆盖正文
    pub fn mark_external_stale(&self, note_id: i64, error: Option<&str>) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE notes
             SET ext_stale = 1, ext_index_status = 'stale', ext_index_error = ?1
             WHERE id = ?2",
            params![error, note_id],
        )?;
        Ok(())
    }

    /// 记录源文件指纹（抽取失败时用，避免每轮轮询都重试昂贵解析）
    pub fn set_external_source_fingerprint(
        &self,
        note_id: i64,
        source_hash: &str,
        mtime: i64,
        size: i64,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE notes SET ext_hash = ?1, ext_mtime = ?2, ext_size = ?3 WHERE id = ?4",
            params![source_hash, mtime, size, note_id],
        )?;
        Ok(())
    }

    /// 抽取失败：保留已有正文，记录错误状态
    pub fn set_external_index_status(
        &self,
        note_id: i64,
        status: &str,
        error: Option<&str>,
        stale: bool,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE notes
             SET ext_index_status = ?1, ext_index_error = ?2, ext_stale = ?3
             WHERE id = ?4",
            params![status, error, stale as i32, note_id],
        )?;
        Ok(())
    }

    /// 把本轮未见到的文件标记为缺失（不删除影子行，保留标签/反链）
    ///
    /// 实现注意：不能把几千个 seen id 拼进一条 `NOT IN (...)`（SQLite 变量数有上限），
    /// 先全量标记缺失，再分批把本轮见到的 id 恢复为 0。
    /// 返回操作后该挂载点的缺失总数。
    pub fn mark_external_missing_except(
        &self,
        mount_id: i64,
        seen_note_ids: &[i64],
    ) -> Result<usize, AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;

        tx.execute(
            "UPDATE notes SET ext_missing = 1
             WHERE mount_id = ?1 AND is_deleted = 0 AND ext_missing = 0
               AND COALESCE(ext_index_status, '') <> 'paused'",
            params![mount_id],
        )?;

        for chunk in seen_note_ids.chunks(500) {
            let placeholders: String = (1..=chunk.len())
                .map(|i| format!("?{}", i))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "UPDATE notes SET ext_missing = 0 WHERE id IN ({})",
                placeholders
            );
            let refs: Vec<&dyn rusqlite::types::ToSql> = chunk
                .iter()
                .map(|id| id as &dyn rusqlite::types::ToSql)
                .collect();
            tx.execute(&sql, refs.as_slice())?;
        }

        let missing: i64 = tx.query_row(
            "SELECT COUNT(*) FROM notes
             WHERE mount_id = ?1 AND is_deleted = 0 AND ext_missing = 1",
            params![mount_id],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(missing as usize)
    }

    /// 列出挂载内的文件条目（前端构建树用）
    pub fn list_external_entries(&self, mount_id: i64) -> Result<Vec<ExternalEntry>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, ext_rel_path, title, ext_missing, COALESCE(ext_mtime, 0),
                    ext_stale, ext_index_status, ext_index_error, source_file_type,
                    COALESCE(ext_size, 0), ext_indexed_at, content_hash, ext_indexed_hash
             FROM notes
             WHERE mount_id = ?1 AND is_deleted = 0 AND ext_rel_path IS NOT NULL
             ORDER BY ext_rel_path",
        )?;
        let rows = stmt.query_map(params![mount_id], |row| {
            let rel_path: String = row.get(1)?;
            let missing = row.get::<_, i32>(3)? != 0;
            let stale = row.get::<_, i32>(5)? != 0;
            let status: Option<String> = row.get(6)?;
            let source_type: Option<String> = row.get(8)?;
            let content_hash: Option<String> = row.get(11)?;
            let indexed_hash: Option<String> = row.get(12)?;
            let user_edited = match (&content_hash, &indexed_hash) {
                (Some(cur), Some(base)) => cur != base,
                _ => false,
            };
            let ext_for_category = source_type
                .clone()
                .unwrap_or_else(|| {
                    Path::new(&rel_path)
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_ascii_lowercase())
                        .unwrap_or_default()
                });
            let type_category =
                category_for_ext(&ext_for_category).map(|s| s.to_string());
            let sync_state = if status.as_deref() == Some("paused") {
                "paused"
            } else if missing {
                "missing"
            } else if status.as_deref() == Some("failed") {
                "failed"
            } else if stale {
                "stale"
            } else {
                "synced"
            };
            Ok(ExternalEntry {
                note_id: row.get(0)?,
                rel_path,
                title: row.get(2)?,
                missing,
                mtime: row.get(4)?,
                stale,
                status,
                error: row.get(7)?,
                source_type,
                size: row.get(9)?,
                user_edited,
                last_synced_at: row.get(10)?,
                sync_state: sync_state.to_string(),
                type_category,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    /// 读取影子笔记的挂载定位信息
    pub fn get_external_note_meta(
        &self,
        note_id: i64,
    ) -> Result<Option<ExternalNoteMeta>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let row = conn
            .query_row(
                "SELECT n.id, n.ext_rel_path, n.ext_mtime, n.ext_missing,
                        m.id, m.name, m.root_path, m.read_only,
                        n.source_file_type, n.content_hash, n.ext_indexed_hash,
                        n.ext_indexed_at, n.ext_stale, n.ext_index_status, n.ext_index_error,
                        n.ext_size
                 FROM notes n
                 JOIN external_mounts m ON m.id = n.mount_id
                 WHERE n.id = ?1 AND n.is_deleted = 0 AND n.storage_kind = 'external'",
                params![note_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, i32>(3)? != 0,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i32>(7)? != 0,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, i32>(12)? != 0,
                        row.get::<_, Option<String>>(13)?,
                        row.get::<_, Option<String>>(14)?,
                        row.get::<_, Option<i64>>(15)?,
                    ))
                },
            )
            .optional()?;

        Ok(row.and_then(
            |(id, rel, mtime, missing, mount_id, mount_name, root_path, read_only,
              source_type, content_hash, indexed_hash, indexed_at, stale, status, error, size)| {
                let rel_path = rel?;
                // 防御 DB 被篡改：只允许挂载根内的相对路径
                if Path::new(&rel_path).is_absolute()
                    || rel_path
                        .split('/')
                        .any(|p| p == ".." || p == ".")
                {
                    log::warn!(
                        "[mount] 拒绝可疑的外部相对路径: note={} rel={}",
                        id,
                        rel_path
                    );
                    return None;
                }
                let abs_path = Path::new(&root_path)
                    .join(&rel_path)
                    .to_string_lossy()
                    .to_string();
                Some(ExternalNoteMeta {
                    note_id: id,
                    mount_id,
                    mount_name,
                    root_path,
                    rel_path,
                    abs_path,
                    read_only,
                    missing,
                    mtime: mtime.unwrap_or(0),
                    size: size.unwrap_or(0),
                    source_type,
                    content_hash,
                    indexed_hash,
                    indexed_at,
                    stale,
                    status,
                    error,
                })
            },
        ))
    }

    /// 写回/外部变更后更新影子笔记缓存
    #[allow(clippy::too_many_arguments)]
    pub fn update_external_note_cache(
        &self,
        note_id: i64,
        content: &str,
        source_hash: &str,
        content_hash: &str,
        indexed_hash: &str,
        mtime: i64,
        size: i64,
        status: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "UPDATE notes
             SET content = ?1, content_hash = ?2, ext_mtime = ?3, ext_size = ?4,
                 ext_hash = ?5, ext_indexed_hash = ?6,
                 ext_indexed_at = datetime('now', 'localtime'),
                 ext_stale = 0, ext_index_status = ?7, ext_index_error = ?8,
                 ext_missing = 0,
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?9",
            params![
                content, content_hash, mtime, size, source_hash, indexed_hash,
                status, error, note_id
            ],
        )?;
        Ok(())
    }

    /// 扫描统计（供 Service 汇总）
    pub fn external_mount_stats(&self, mount_id: i64) -> Result<(usize, usize), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes
             WHERE mount_id = ?1 AND is_deleted = 0 AND ext_missing = 0",
            params![mount_id],
            |r| r.get(0),
        )?;
        let missing: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes
             WHERE mount_id = ?1 AND is_deleted = 0 AND ext_missing = 1",
            params![mount_id],
            |r| r.get(0),
        )?;
        Ok((total as usize, missing as usize))
    }
}

/// 供 Service 层复用的空扫描结果
pub fn empty_scan_result(mount_id: i64) -> MountScanResult {
    MountScanResult {
        mount_id,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_input() -> ExternalMountInput {
        ExternalMountInput {
            name: "测试挂载".into(),
            root_path: "C:\\tmp\\kb-mount-test".into(),
            read_only: false,
            index_enabled: true,
            daily_mode: false,
            scan_interval: 10,
            sync_types: SyncTypeSettings::default(),
        }
    }

    #[test]
    fn create_mount_and_upsert_shadow_note() {
        let db = Database::init(":memory:").unwrap();
        let mount = db.create_external_mount(&test_input()).unwrap();
        assert!(mount.root_folder_id.is_some());

        let folder = db
            .ensure_external_folder(mount.id, mount.root_folder_id, "sub")
            .unwrap();
        let (note_id, is_new) = db
            .upsert_external_note(
                mount.id,
                "sub/a.md",
                folder,
                "A",
                "# A\n\nhello #tag",
                "hash-a",
                "hash-a",
                "hash-a",
                100,
                12,
                Some("C:\\tmp\\kb-mount-test\\sub\\a.md"),
                Some("md"),
                Some("ok"),
                None,
            )
            .unwrap();
        assert!(is_new);

        let entries = db.list_external_entries(mount.id).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "sub/a.md");
        assert!(!entries[0].missing);

        // 同路径再次 upsert → 复用同一 note id
        let (same_id, was_new) = db
            .upsert_external_note(
                mount.id,
                "sub/a.md",
                folder,
                "A",
                "# A v2\n\nhello again",
                "hash-b",
                "hash-b",
                "hash-b",
                101,
                8,
                Some("C:\\tmp\\kb-mount-test\\sub\\a.md"),
                Some("md"),
                Some("ok"),
                None,
            )
            .unwrap();
        assert_eq!(same_id, note_id);
        assert!(!was_new);

        // 影子笔记必须能被全文搜索命中（FTS 触发器自动同步）
        let hits = db
            .search_notes_filtered("hello", 10, &Default::default())
            .unwrap();
        assert!(
            hits.iter().any(|r| r.id == note_id),
            "外部影子笔记应参与全文搜索"
        );

        // 标记缺失后再出现
        let missing = db.mark_external_missing_except(mount.id, &[]).unwrap();
        assert_eq!(missing, 1);
        let meta = db.get_external_note_meta(note_id).unwrap().unwrap();
        assert!(meta.missing);

        let missing = db
            .mark_external_missing_except(mount.id, &[note_id])
            .unwrap();
        assert_eq!(missing, 0);
    }

    #[test]
    fn user_edited_detection_uses_indexed_baseline() {
        let row = |content: &str, indexed: Option<&str>| ExternalNoteRow {
            id: 1,
            source_hash: Some("src".into()),
            source_mtime: Some(1),
            source_size: Some(1),
            content_hash: Some(content.into()),
            indexed_hash: indexed.map(|s| s.to_string()),
            indexed_at: None,
            stale: false,
            status: None,
            error: None,
            source_type: Some("pdf".into()),
        };
        assert!(!row("same", Some("same")).user_edited());
        assert!(row("edited", Some("same")).user_edited());
        // 老数据没有基线：保守按未编辑处理
        assert!(!row("anything", None).user_edited());
    }

    #[test]
    fn stale_and_status_roundtrip() {
        let db = Database::init(":memory:").unwrap();
        let mount = db.create_external_mount(&test_input()).unwrap();
        let (note_id, _) = db
            .upsert_external_note(
                mount.id,
                "a.pdf",
                mount.root_folder_id,
                "A",
                "<p>text</p>",
                "source-hash",
                "content-hash",
                "content-hash",
                1,
                7,
                Some("C:\\tmp\\kb-mount-test\\a.pdf"),
                Some("pdf"),
                Some("ok"),
                None,
            )
            .unwrap();

        db.set_external_index_status(note_id, "failed", Some("boom"), true)
            .unwrap();
        let meta = db.get_external_note_meta(note_id).unwrap().unwrap();
        assert!(meta.stale);
        assert_eq!(meta.status.as_deref(), Some("failed"));
        assert_eq!(meta.error.as_deref(), Some("boom"));
        assert_eq!(meta.source_type.as_deref(), Some("pdf"));

        db.mark_external_stale(note_id, Some("changed")).unwrap();
        let meta = db.get_external_note_meta(note_id).unwrap().unwrap();
        assert!(meta.stale);
    }

    #[test]
    fn detach_keeps_note_as_local() {
        let db = Database::init(":memory:").unwrap();
        let mount = db.create_external_mount(&test_input()).unwrap();
        let (note_id, _) = db
            .upsert_external_note(
                mount.id,
                "a.md",
                mount.root_folder_id,
                "A",
                "content",
                "hash",
                "hash",
                "hash",
                1,
                7,
                Some("C:\\tmp\\kb-mount-test\\a.md"),
                Some("md"),
                Some("ok"),
                None,
            )
            .unwrap();

        db.detach_external_mount(mount.id).unwrap();
        assert!(db.get_external_mount_by_id(mount.id).unwrap().is_none());
        let note = db.get_note(note_id).unwrap().unwrap();
        assert_eq!(note.title, "A");
        assert!(db.get_external_note_meta(note_id).unwrap().is_none());
    }
}
