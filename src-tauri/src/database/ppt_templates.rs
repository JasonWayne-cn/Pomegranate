//! 用户 PPT 模板的数据访问层。
//!
//! 文件系统是模板资产权威，本表只保存索引与状态。

use rusqlite::{params, OptionalExtension, Row};

use crate::error::AppError;
use crate::models::ppt_template::PptUserTemplate;

use super::Database;

const COLUMNS: &str = "id, display_name, description, dir_path, source_kind, source_pack, \
    canvas_format, canvas_width, canvas_height, page_count, page_types_json, \
    supports_structured, supports_legacy, cover_file, content_hash, enabled, status, \
    created_at, updated_at";

fn map_row(row: &Row<'_>) -> rusqlite::Result<PptUserTemplate> {
    let page_types_json: String = row.get(10)?;
    let page_types = serde_json::from_str::<Vec<String>>(&page_types_json).unwrap_or_default();
    Ok(PptUserTemplate {
        id: row.get(0)?,
        display_name: row.get(1)?,
        description: row.get(2)?,
        dir_path: row.get(3)?,
        source_kind: row.get(4)?,
        source_pack: row.get(5)?,
        canvas_format: row.get(6)?,
        canvas_width: row.get(7)?,
        canvas_height: row.get(8)?,
        page_count: row.get(9)?,
        page_types,
        supports_structured: row.get::<_, i64>(11)? != 0,
        supports_legacy: row.get::<_, i64>(12)? != 0,
        cover_file: row.get(13)?,
        content_hash: row.get(14)?,
        enabled: row.get::<_, i64>(15)? != 0,
        status: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
    })
}

impl Database {
    /// 写入或更新模板索引。已存在时保留 `created_at`。
    pub fn upsert_ppt_user_template(&self, tpl: &PptUserTemplate) -> Result<PptUserTemplate, AppError> {
        let page_types_json = serde_json::to_string(&tpl.page_types)?;
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO ppt_user_templates
                (id, display_name, description, dir_path, source_kind, source_pack,
                 canvas_format, canvas_width, canvas_height, page_count, page_types_json,
                 supports_structured, supports_legacy, cover_file, content_hash, enabled, status,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                     datetime('now','localtime'), datetime('now','localtime'))
             ON CONFLICT(id) DO UPDATE SET
                display_name = excluded.display_name,
                description = excluded.description,
                dir_path = excluded.dir_path,
                source_kind = excluded.source_kind,
                source_pack = excluded.source_pack,
                canvas_format = excluded.canvas_format,
                canvas_width = excluded.canvas_width,
                canvas_height = excluded.canvas_height,
                page_count = excluded.page_count,
                page_types_json = excluded.page_types_json,
                supports_structured = excluded.supports_structured,
                supports_legacy = excluded.supports_legacy,
                cover_file = excluded.cover_file,
                content_hash = excluded.content_hash,
                enabled = excluded.enabled,
                status = excluded.status,
                updated_at = datetime('now','localtime')",
            params![
                tpl.id,
                tpl.display_name,
                tpl.description,
                tpl.dir_path,
                tpl.source_kind,
                tpl.source_pack,
                tpl.canvas_format,
                tpl.canvas_width,
                tpl.canvas_height,
                tpl.page_count,
                page_types_json,
                if tpl.supports_structured { 1 } else { 0 },
                if tpl.supports_legacy { 1 } else { 0 },
                tpl.cover_file,
                tpl.content_hash,
                if tpl.enabled { 1 } else { 0 },
                tpl.status,
            ],
        )?;
        drop(conn);
        self.get_ppt_user_template(&tpl.id)?
            .ok_or_else(|| AppError::Custom("用户模板写入失败".into()))
    }

    pub fn get_ppt_user_template(&self, id: &str) -> Result<Option<PptUserTemplate>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!("SELECT {COLUMNS} FROM ppt_user_templates WHERE id = ?1");
        let row = conn
            .query_row(&sql, params![id], map_row)
            .optional()?;
        Ok(row)
    }

    pub fn list_ppt_user_templates(&self) -> Result<Vec<PptUserTemplate>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {COLUMNS} FROM ppt_user_templates ORDER BY updated_at DESC, display_name"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn set_ppt_user_template_enabled(&self, id: &str, enabled: bool) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE ppt_user_templates
                SET enabled = ?2, updated_at = datetime('now','localtime')
              WHERE id = ?1",
            params![id, if enabled { 1 } else { 0 }],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("用户模板 {} 不存在", id)));
        }
        Ok(())
    }

    pub fn update_ppt_user_template_meta(
        &self,
        id: &str,
        display_name: &str,
        description: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE ppt_user_templates
                SET display_name = ?2, description = ?3,
                    updated_at = datetime('now','localtime')
              WHERE id = ?1",
            params![id, display_name, description],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("用户模板 {} 不存在", id)));
        }
        Ok(())
    }

    pub fn set_ppt_user_template_status(&self, id: &str, status: &str) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "UPDATE ppt_user_templates
                SET status = ?2, updated_at = datetime('now','localtime')
              WHERE id = ?1",
            params![id, status],
        )?;
        Ok(())
    }

    pub fn delete_ppt_user_template(&self, id: &str) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM ppt_user_templates WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }
}
