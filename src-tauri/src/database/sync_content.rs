//! 文件夹 /（后续）内容同步的数据访问层
//!
//! 所有查询都要排除外部目录挂载产生的镜像文件夹（`folders.mount_id` 非空）：
//! 它们只是本机磁盘的影像，同步到别的设备没有意义，也不该被删除。

use rusqlite::{params, OptionalExtension};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    CardManifestEntry, CardReviewLogManifestEntry, FolderManifestEntry, NoteTemplateManifestEntry,
    PromptManifestEntry,
};

pub const TOMBSTONE_KIND_FOLDER: &str = "folder";
pub const TOMBSTONE_KIND_PROMPT: &str = "prompt";
pub const TOMBSTONE_KIND_NOTE_TEMPLATE: &str = "note_template";

/// `(id, stable_uuid, parent_id, name)`，首次同步配对用
pub type FolderSyncRow = (i64, Option<String>, Option<i64>, String);

impl Database {
    pub fn list_folders_for_sync(&self) -> Result<Vec<FolderManifestEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT f.stable_uuid, COALESCE(f.updated_at, f.created_at), f.name, p.stable_uuid,
                    f.sort_order, f.color
             FROM folders f
             LEFT JOIN folders p ON p.id = f.parent_id AND p.mount_id IS NULL
             WHERE f.stable_uuid IS NOT NULL AND f.mount_id IS NULL",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(FolderManifestEntry {
                    stable_id: r.get(0)?,
                    content_hash: String::new(),
                    updated_at: r.get(1)?,
                    name: r.get(2)?,
                    parent_stable_id: r.get(3)?,
                    sort_order: r.get(4)?,
                    color: r.get(5)?,
                    tombstone: false,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 全部可同步文件夹的 `(id, stable_uuid, parent_id, name)`
    pub fn list_folder_sync_rows(&self) -> Result<Vec<FolderSyncRow>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, stable_uuid, parent_id, name FROM folders WHERE mount_id IS NULL",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 首次同步配对：只改 uuid，不触发 `updated_at` 记时
    pub fn set_folder_stable_uuid(&self, id: i64, stable_uuid: &str) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "UPDATE folders SET stable_uuid = ?1 WHERE id = ?2",
            params![stable_uuid, id],
        )?;
        Ok(())
    }

    pub fn get_folder_id_by_stable_uuid(
        &self,
        stable_uuid: &str,
    ) -> Result<Option<i64>, AppError> {
        let conn = self.conn_lock()?;
        let id = conn
            .query_row(
                "SELECT id FROM folders WHERE stable_uuid = ?1 AND mount_id IS NULL",
                params![stable_uuid],
                |r| r.get(0),
            )
            .optional()?;
        Ok(id)
    }

    /// 拉取落库：有则覆盖（含挪父级），无则插入；同时清掉本地对它的删除记录。
    ///
    /// 两端同时把 A 挪进 B、B 挪进 A 时会拼出环 —— 新父级落在自己子树里就改放根层。
    pub fn upsert_folder_synced(
        &self,
        e: &FolderManifestEntry,
        parent_id: Option<i64>,
    ) -> Result<i64, AppError> {
        let mut conn = self.conn_lock()?;
        let tx = conn.transaction()?;
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM folders WHERE stable_uuid = ?1",
                params![e.stable_id],
                |r| r.get(0),
            )
            .optional()?;
        let id = match existing {
            Some(id) => {
                let parent_id = match parent_id {
                    Some(p)
                        if super::folders::bfs_descendant_ids(&tx, id)?.contains(&p) =>
                    {
                        log::warn!(
                            "[sync_v1] 文件夹「{}」的新父级在它自己的子树里，改放根层以免成环",
                            e.name
                        );
                        None
                    }
                    other => other,
                };
                tx.execute(
                    "UPDATE folders SET name = ?1, parent_id = ?2, sort_order = ?3, color = ?4,
                        updated_at = ?5
                     WHERE id = ?6",
                    params![e.name, parent_id, e.sort_order, e.color, e.updated_at, id],
                )?;
                id
            }
            None => {
                tx.execute(
                    "INSERT INTO folders (stable_uuid, name, parent_id, sort_order, color, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        e.stable_id,
                        e.name,
                        parent_id,
                        e.sort_order,
                        e.color,
                        e.updated_at
                    ],
                )?;
                tx.last_insert_rowid()
            }
        };
        tx.execute(
            "DELETE FROM sync_tombstones WHERE kind = ?1 AND stable_uuid = ?2",
            params![TOMBSTONE_KIND_FOLDER, e.stable_id],
        )?;
        tx.commit()?;
        Ok(id)
    }

    /// 按远端删除事件删掉本地文件夹：笔记由外键置为未分类、子文件夹提到根层；
    /// 墓碑时间改成远端的删除时间，避免本地删除时间更早导致对端反复复活。
    pub fn delete_folder_synced(
        &self,
        stable_uuid: &str,
        deleted_at: &str,
    ) -> Result<bool, AppError> {
        let mut conn = self.conn_lock()?;
        let tx = conn.transaction()?;
        let affected = tx.execute(
            "DELETE FROM folders WHERE stable_uuid = ?1 AND mount_id IS NULL",
            params![stable_uuid],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO sync_tombstones (kind, stable_uuid, deleted_at)
             VALUES (?1, ?2, ?3)",
            params![TOMBSTONE_KIND_FOLDER, stable_uuid, deleted_at],
        )?;
        tx.commit()?;
        Ok(affected > 0)
    }

    /// `deleted_at >= cutoff` 的墓碑（kind 由调用方指定）
    pub fn list_sync_tombstones(
        &self,
        kind: &str,
        cutoff: &str,
    ) -> Result<Vec<(String, String)>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT stable_uuid, deleted_at FROM sync_tombstones
             WHERE kind = ?1 AND deleted_at >= ?2",
        )?;
        let rows = stmt
            .query_map(params![kind, cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按 stable_uuid 删除提示词 / 笔记模板并记墓碑（文件夹走 [`delete_folder_synced`]）
    pub fn delete_synced_by_uuid(
        &self,
        kind: &str,
        stable_uuid: &str,
        deleted_at: &str,
    ) -> Result<bool, AppError> {
        let table = match kind {
            TOMBSTONE_KIND_PROMPT => "prompt_templates",
            TOMBSTONE_KIND_NOTE_TEMPLATE => "note_templates",
            _ => {
                return Err(AppError::Custom(format!(
                    "不支持按 uuid 删除的同步类型: {}",
                    kind
                )))
            }
        };
        let mut conn = self.conn_lock()?;
        let tx = conn.transaction()?;
        let sql = format!("DELETE FROM {} WHERE stable_uuid = ?1", table);
        let affected = tx.execute(&sql, params![stable_uuid])?;
        tx.execute(
            "INSERT OR REPLACE INTO sync_tombstones (kind, stable_uuid, deleted_at)
             VALUES (?1, ?2, ?3)",
            params![kind, stable_uuid, deleted_at],
        )?;
        tx.commit()?;
        Ok(affected > 0)
    }

    // ─── 闪卡 / 复习记录 ──────────────────────────────────────

    pub fn list_cards_for_sync(
        &self,
        tombstone_cutoff: &str,
    ) -> Result<Vec<CardManifestEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT c.stable_uuid, c.updated_at, c.front, c.back, c.deck, n.stable_uuid,
                    c.due, c.stability, c.difficulty, c.elapsed_days, c.scheduled_days,
                    c.reps, c.lapses, c.state, c.last_review, c.is_deleted
             FROM cards c LEFT JOIN notes n ON n.id = c.note_id
             WHERE c.stable_uuid IS NOT NULL
               AND (c.is_deleted = 0 OR c.updated_at >= ?1)",
        )?;
        let rows = stmt
            .query_map(params![tombstone_cutoff], |r| {
                Ok(CardManifestEntry {
                    stable_id: r.get(0)?,
                    content_hash: String::new(),
                    updated_at: r.get(1)?,
                    front: r.get(2)?,
                    back: r.get(3)?,
                    deck: r.get(4)?,
                    note_uuid: r.get(5)?,
                    due: r.get(6)?,
                    stability: r.get(7)?,
                    difficulty: r.get(8)?,
                    elapsed_days: r.get(9)?,
                    scheduled_days: r.get(10)?,
                    reps: r.get(11)?,
                    lapses: r.get(12)?,
                    state: r.get(13)?,
                    last_review: r.get(14)?,
                    tombstone: r.get::<_, i64>(15)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按 stable_uuid 找卡片（含已删除的 —— 远端复活 / 更新时要命中同一行）
    pub fn get_card_sync_ref(
        &self,
        stable_uuid: &str,
    ) -> Result<Option<(i64, Option<String>)>, AppError> {
        let conn = self.conn_lock()?;
        let row = conn
            .query_row(
                "SELECT id, last_review FROM cards WHERE stable_uuid = ?1",
                params![stable_uuid],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        Ok(row)
    }

    /// 拉取落库：本地没有 → 插入；有 → 覆盖内容。
    /// `keep_local_schedule=true` 时不动调度字段（本地复习得更晚）。
    pub fn upsert_card_synced(
        &self,
        e: &CardManifestEntry,
        note_id: Option<i64>,
        keep_local_schedule: bool,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM cards WHERE stable_uuid = ?1",
                params![e.stable_id],
                |r| r.get(0),
            )
            .optional()?;
        let deleted = i64::from(e.tombstone);
        match existing {
            None => {
                conn.execute(
                    "INSERT INTO cards (stable_uuid, note_id, front, back, deck, due, stability,
                        difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review,
                        is_deleted, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                    params![
                        e.stable_id,
                        note_id,
                        e.front,
                        e.back,
                        e.deck,
                        e.due,
                        e.stability,
                        e.difficulty,
                        e.elapsed_days,
                        e.scheduled_days,
                        e.reps,
                        e.lapses,
                        e.state,
                        e.last_review,
                        deleted,
                        e.updated_at,
                    ],
                )?;
            }
            Some(id) => {
                conn.execute(
                    "UPDATE cards SET note_id = ?1, front = ?2, back = ?3, deck = ?4,
                        is_deleted = ?5, updated_at = ?6 WHERE id = ?7",
                    params![note_id, e.front, e.back, e.deck, deleted, e.updated_at, id],
                )?;
                if !keep_local_schedule {
                    conn.execute(
                        "UPDATE cards SET due = ?1, stability = ?2, difficulty = ?3,
                            elapsed_days = ?4, scheduled_days = ?5, reps = ?6, lapses = ?7,
                            state = ?8, last_review = ?9 WHERE id = ?10",
                        params![
                            e.due,
                            e.stability,
                            e.difficulty,
                            e.elapsed_days,
                            e.scheduled_days,
                            e.reps,
                            e.lapses,
                            e.state,
                            e.last_review,
                            id,
                        ],
                    )?;
                }
            }
        }
        Ok(())
    }

    /// `review >= cutoff` 的复习记录（所属卡片要有 stable_uuid）
    pub fn list_card_logs_for_sync(
        &self,
        cutoff: &str,
    ) -> Result<Vec<CardReviewLogManifestEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT l.stable_uuid, c.stable_uuid, l.rating, l.state, l.due, l.stability,
                    l.difficulty, l.elapsed_days, l.last_elapsed_days, l.scheduled_days, l.review
             FROM card_review_logs l JOIN cards c ON c.id = l.card_id
             WHERE l.stable_uuid IS NOT NULL AND c.stable_uuid IS NOT NULL AND l.review >= ?1",
        )?;
        let rows = stmt
            .query_map(params![cutoff], |r| {
                Ok(CardReviewLogManifestEntry {
                    stable_id: r.get(0)?,
                    card_uuid: r.get(1)?,
                    rating: r.get(2)?,
                    state: r.get(3)?,
                    due: r.get(4)?,
                    stability: r.get(5)?,
                    difficulty: r.get(6)?,
                    elapsed_days: r.get(7)?,
                    last_elapsed_days: r.get(8)?,
                    scheduled_days: r.get(9)?,
                    review: r.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 插入一条远端复习记录；卡片在本端不存在时返回 Ok(false)，重复 stable_uuid 忽略
    pub fn insert_card_log_synced(&self, e: &CardReviewLogManifestEntry) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let card_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM cards WHERE stable_uuid = ?1",
                params![e.card_uuid],
                |r| r.get(0),
            )
            .optional()?;
        let Some(card_id) = card_id else {
            return Ok(false);
        };
        conn.execute(
            "INSERT OR IGNORE INTO card_review_logs (stable_uuid, card_id, rating, state, due,
                stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days, review)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                e.stable_id,
                card_id,
                e.rating,
                e.state,
                e.due,
                e.stability,
                e.difficulty,
                e.elapsed_days,
                e.last_elapsed_days,
                e.scheduled_days,
                e.review,
            ],
        )?;
        Ok(true)
    }

    // ─── 提示词 / 笔记模板 ────────────────────────────────────

    pub fn list_prompts_for_sync(&self) -> Result<Vec<PromptManifestEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT stable_uuid, updated_at, title, description, prompt, output_mode, icon,
                    builtin_code, sort_order, enabled
             FROM prompt_templates WHERE stable_uuid IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PromptManifestEntry {
                    stable_id: r.get(0)?,
                    content_hash: String::new(),
                    updated_at: r.get(1)?,
                    title: r.get(2)?,
                    description: r.get(3)?,
                    prompt: r.get(4)?,
                    output_mode: r.get(5)?,
                    icon: r.get(6)?,
                    builtin_code: r.get(7)?,
                    sort_order: r.get(8)?,
                    enabled: r.get::<_, i64>(9)? != 0,
                    tombstone: false,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 拉取落库：本地没有 → 插入（同时清掉删除记录）；有 → 覆盖
    pub fn upsert_prompt_synced(&self, e: &PromptManifestEntry) -> Result<(), AppError> {
        let mut conn = self.conn_lock()?;
        let tx = conn.transaction()?;
        let updated = tx.execute(
            "UPDATE prompt_templates SET title = ?1, description = ?2, prompt = ?3,
                output_mode = ?4, icon = ?5, sort_order = ?6, enabled = ?7, updated_at = ?8
             WHERE stable_uuid = ?9",
            params![
                e.title,
                e.description,
                e.prompt,
                e.output_mode,
                e.icon,
                e.sort_order,
                i64::from(e.enabled),
                e.updated_at,
                e.stable_id,
            ],
        )?;
        if updated == 0 {
            tx.execute(
                "INSERT INTO prompt_templates (stable_uuid, title, description, prompt, output_mode,
                    icon, is_builtin, builtin_code, sort_order, enabled, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    e.stable_id,
                    e.title,
                    e.description,
                    e.prompt,
                    e.output_mode,
                    e.icon,
                    i64::from(e.builtin_code.is_some()),
                    e.builtin_code,
                    e.sort_order,
                    i64::from(e.enabled),
                    e.updated_at,
                ],
            )?;
        }
        tx.execute(
            "DELETE FROM sync_tombstones WHERE kind = ?1 AND stable_uuid = ?2",
            params![TOMBSTONE_KIND_PROMPT, e.stable_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn list_note_templates_for_sync(&self) -> Result<Vec<NoteTemplateManifestEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT stable_uuid, COALESCE(updated_at, created_at), name, description, content
             FROM note_templates WHERE stable_uuid IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(NoteTemplateManifestEntry {
                    stable_id: r.get(0)?,
                    content_hash: String::new(),
                    updated_at: r.get(1)?,
                    name: r.get(2)?,
                    description: r.get(3)?,
                    content: r.get(4)?,
                    tombstone: false,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn upsert_note_template_synced(
        &self,
        e: &NoteTemplateManifestEntry,
    ) -> Result<(), AppError> {
        let mut conn = self.conn_lock()?;
        let tx = conn.transaction()?;
        let updated = tx.execute(
            "UPDATE note_templates SET name = ?1, description = ?2, content = ?3, updated_at = ?4
             WHERE stable_uuid = ?5",
            params![e.name, e.description, e.content, e.updated_at, e.stable_id],
        )?;
        if updated == 0 {
            tx.execute(
                "INSERT INTO note_templates (stable_uuid, name, description, content, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![e.stable_id, e.name, e.description, e.content, e.updated_at],
            )?;
        }
        tx.execute(
            "DELETE FROM sync_tombstones WHERE kind = ?1 AND stable_uuid = ?2",
            params![TOMBSTONE_KIND_NOTE_TEMPLATE, e.stable_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_note_folder_moved_at(
        &self,
        id: i64,
        at: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "UPDATE notes SET folder_moved_at = ?2 WHERE id = ?1",
            params![id, at],
        )?;
        Ok(())
    }
}
