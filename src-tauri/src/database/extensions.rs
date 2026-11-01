use rusqlite::{params, OptionalExtension};

use crate::error::AppError;
use crate::models::extension::{ExtensionInfo, ExtensionManifest, ExtensionVersionInfo, PptJob};

use super::Database;

impl Database {
    /// 写入/更新扩展包记录。已存在时保留 `enabled` 状态。
    pub fn upsert_extension(
        &self,
        manifest: &ExtensionManifest,
        path: &str,
        content_hash: &str,
        supports_ppt: bool,
    ) -> Result<ExtensionInfo, AppError> {
        let manifest_json = serde_json::to_string(manifest)?;
        let permissions_json = serde_json::to_string(&manifest.permissions)?;
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO extensions
                (id, name, version, kind, path, enabled, status, content_hash,
                 permissions_json, supports_ppt, manifest_json, installed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, 'installed', ?6, ?7, ?8, ?9,
                     datetime('now','localtime'), datetime('now','localtime'))
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                version = excluded.version,
                kind = excluded.kind,
                path = excluded.path,
                status = 'installed',
                content_hash = excluded.content_hash,
                permissions_json = excluded.permissions_json,
                supports_ppt = excluded.supports_ppt,
                manifest_json = excluded.manifest_json,
                updated_at = datetime('now','localtime')",
            params![
                manifest.id,
                manifest.name,
                manifest.version,
                manifest.kind,
                path,
                content_hash,
                permissions_json,
                if supports_ppt { 1 } else { 0 },
                manifest_json
            ],
        )?;
        // 必须释放连接锁后再重新查询，避免同一 Mutex 重入死锁。
        drop(conn);
        self.get_extension(&manifest.id)?
            .ok_or_else(|| AppError::Custom("扩展包写入失败".into()))
    }

    pub fn get_extension(&self, id: &str) -> Result<Option<ExtensionInfo>, AppError> {
        let conn = self.conn_lock()?;
        let row = conn
            .query_row(
                "SELECT id, name, version, kind, path, enabled, status, content_hash,
                        permissions_json, supports_ppt, manifest_json, installed_at, updated_at
                 FROM extensions WHERE id = ?1",
                params![id],
                map_extension_row,
            )
            .optional()?;
        Ok(row)
    }

    pub fn list_extensions(&self) -> Result<Vec<ExtensionInfo>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, version, kind, path, enabled, status, content_hash,
                    permissions_json, supports_ppt, manifest_json, installed_at, updated_at
             FROM extensions ORDER BY installed_at DESC",
        )?;
        let rows = stmt
            .query_map([], map_extension_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn set_extension_enabled(&self, id: &str, enabled: bool) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE extensions SET enabled = ?2, updated_at = datetime('now','localtime')
             WHERE id = ?1",
            params![id, if enabled { 1 } else { 0 }],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("扩展包 {} 不存在", id)));
        }
        Ok(())
    }

    pub fn delete_extension(&self, id: &str) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM extensions WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    pub fn add_extension_version(
        &self,
        id: &str,
        version: &str,
        path: &str,
        content_hash: &str,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO extension_versions
                (extension_id, version, path, content_hash, is_current, installed_at)
             VALUES (?1, ?2, ?3, ?4, 1, datetime('now','localtime'))
             ON CONFLICT(extension_id, version) DO UPDATE SET
                path = excluded.path,
                content_hash = excluded.content_hash,
                is_current = 1",
            params![id, version, path, content_hash],
        )?;
        conn.execute(
            "UPDATE extension_versions SET is_current = 0
             WHERE extension_id = ?1 AND version <> ?2",
            params![id, version],
        )?;
        Ok(())
    }

    pub fn list_extension_versions(
        &self,
        id: &str,
    ) -> Result<Vec<ExtensionVersionInfo>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT version, path, content_hash, is_current, installed_at
             FROM extension_versions WHERE extension_id = ?1
             ORDER BY installed_at DESC, version DESC",
        )?;
        let rows = stmt
            .query_map(params![id], |row| {
                Ok(ExtensionVersionInfo {
                    version: row.get(0)?,
                    path: row.get(1)?,
                    content_hash: row.get(2)?,
                    is_current: row.get::<_, i64>(3)? != 0,
                    installed_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn insert_ppt_job(&self, job: &PptJob) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO ppt_jobs
                (id, extension_id, status, title, template_id, workspace_path,
                 project_path, pptx_path, final_pptx_path, error_code, error_message,
                 log_tail, created_at, started_at, finished_at, stage)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                job.id,
                job.extension_id,
                job.status,
                job.title,
                job.template_id,
                job.workspace_path,
                job.project_path,
                job.pptx_path,
                job.final_pptx_path,
                job.error_code,
                job.error_message,
                job.log_tail,
                job.created_at,
                job.started_at,
                job.finished_at,
                job.stage
            ],
        )?;
        Ok(())
    }

    pub fn update_ppt_job(&self, job: &PptJob) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "UPDATE ppt_jobs SET
                status = ?2, project_path = ?3, pptx_path = ?4, final_pptx_path = ?5,
                error_code = ?6, error_message = ?7, log_tail = ?8,
                started_at = ?9, finished_at = ?10, template_id = ?11, stage = ?12
             WHERE id = ?1",
            params![
                job.id,
                job.status,
                job.project_path,
                job.pptx_path,
                job.final_pptx_path,
                job.error_code,
                job.error_message,
                job.log_tail,
                job.started_at,
                job.finished_at,
                job.template_id,
                job.stage
            ],
        )?;
        Ok(())
    }

    pub fn get_ppt_job(&self, id: &str) -> Result<Option<PptJob>, AppError> {
        let conn = self.conn_lock()?;
        conn.query_row(
            "SELECT id, extension_id, status, title, template_id, workspace_path,
                    project_path, pptx_path, final_pptx_path, error_code, error_message,
                    log_tail, created_at, started_at, finished_at, stage
             FROM ppt_jobs WHERE id = ?1",
            params![id],
            map_ppt_job_row,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list_ppt_jobs(&self, limit: usize) -> Result<Vec<PptJob>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, extension_id, status, title, template_id, workspace_path,
                    project_path, pptx_path, final_pptx_path, error_code, error_message,
                    log_tail, created_at, started_at, finished_at, stage
             FROM ppt_jobs ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], map_ppt_job_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delete_ppt_job(&self, id: &str) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM ppt_jobs WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }
}

fn map_extension_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExtensionInfo> {
    let manifest_json: String = row.get(10)?;
    let manifest: ExtensionManifest = serde_json::from_str(&manifest_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let permissions_json: String = row.get(8)?;
    let permissions: Vec<String> = serde_json::from_str(&permissions_json).unwrap_or_default();
    Ok(ExtensionInfo {
        id: row.get(0)?,
        name: row.get(1)?,
        version: row.get(2)?,
        kind: row.get(3)?,
        path: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        status: row.get(6)?,
        content_hash: row.get(7)?,
        permissions,
        supports_ppt: row.get::<_, i64>(9)? != 0,
        manifest,
        installed_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn map_ppt_job_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PptJob> {
    Ok(PptJob {
        id: row.get(0)?,
        extension_id: row.get(1)?,
        status: row.get(2)?,
        title: row.get(3)?,
        template_id: row.get(4)?,
        workspace_path: row.get(5)?,
        project_path: row.get(6)?,
        pptx_path: row.get(7)?,
        final_pptx_path: row.get(8)?,
        error_code: row.get(9)?,
        error_message: row.get(10)?,
        log_tail: row.get(11)?,
        created_at: row.get(12)?,
        started_at: row.get(13)?,
        finished_at: row.get(14)?,
        stage: row.get(15)?,
    })
}
