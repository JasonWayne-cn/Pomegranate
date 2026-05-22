//! 插件系统 DAO
//!
//! 仅负责插件元数据、权限授权与插件设置的 SQLite 持久化。
//! 插件目录扫描、manifest 校验、文件复制/删除都放在 Service 层。

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::Database;
use crate::error::AppError;
use crate::models::{PluginInfo, PluginManifest};

const SELECT_COLUMNS: &str = "id, name, version, description, author, path, main, styles, \
     min_app_version, manifest_json, enabled, status, installed_at, updated_at";

fn list_plugin_permissions(
    conn: &Connection,
    plugin_id: &str,
) -> Result<(Vec<String>, Vec<String>), AppError> {
    let mut stmt = conn.prepare(
        "SELECT permission, granted FROM plugin_permissions
         WHERE plugin_id = ?1
         ORDER BY permission ASC",
    )?;
    let rows = stmt
        .query_map([plugin_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)? != 0))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let permissions = rows.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>();
    let granted_permissions = rows
        .into_iter()
        .filter_map(|(p, granted)| granted.then_some(p))
        .collect::<Vec<_>>();

    Ok((permissions, granted_permissions))
}

fn row_to_plugin(conn: &Connection, row: &rusqlite::Row<'_>) -> Result<PluginInfo, AppError> {
    let id: String = row.get(0)?;
    let manifest_json: String = row.get(9)?;
    let manifest: PluginManifest = serde_json::from_str(&manifest_json)?;
    let (permissions, granted_permissions) = list_plugin_permissions(conn, &id)?;

    Ok(PluginInfo {
        id,
        name: row.get(1)?,
        version: row.get(2)?,
        description: row.get(3)?,
        author: row.get(4)?,
        path: row.get(5)?,
        main: row.get(6)?,
        styles: row.get(7)?,
        min_app_version: row.get(8)?,
        enabled: row.get::<_, i32>(10)? != 0,
        status: row.get(11)?,
        permissions,
        granted_permissions,
        manifest,
        installed_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

impl Database {
    /// 列出已安装插件
    pub fn list_plugins(&self) -> Result<Vec<PluginInfo>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!("SELECT {} FROM plugins ORDER BY name COLLATE NOCASE", SELECT_COLUMNS);
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut plugins = Vec::new();
        while let Some(row) = rows.next()? {
            plugins.push(row_to_plugin(&conn, row)?);
        }
        Ok(plugins)
    }

    /// 获取单个插件
    pub fn get_plugin(&self, plugin_id: &str) -> Result<PluginInfo, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!("SELECT {} FROM plugins WHERE id = ?1", SELECT_COLUMNS);
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query([plugin_id])?;
        match rows.next()? {
            Some(row) => row_to_plugin(&conn, row),
            None => Err(AppError::NotFound(format!("插件 {} 不存在", plugin_id))),
        }
    }

    /// 插入或更新插件元数据；enabled 状态保留用户原设置
    pub fn upsert_plugin(
        &self,
        manifest: &PluginManifest,
        plugin_path: &str,
    ) -> Result<PluginInfo, AppError> {
        let manifest_json = serde_json::to_string(manifest)?;
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO plugins
                (id, name, version, description, author, path, main, styles,
                 min_app_version, manifest_json, enabled, status, installed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 'installed',
                     datetime('now','localtime'), datetime('now','localtime'))
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 version = excluded.version,
                 description = excluded.description,
                 author = excluded.author,
                 path = excluded.path,
                 main = excluded.main,
                 styles = excluded.styles,
                 min_app_version = excluded.min_app_version,
                 manifest_json = excluded.manifest_json,
                 status = 'installed',
                 updated_at = excluded.updated_at",
            params![
                manifest.id,
                manifest.name,
                manifest.version,
                manifest.description,
                manifest.author,
                plugin_path,
                manifest.main,
                manifest.styles,
                manifest.min_app_version,
                manifest_json,
            ],
        )?;

        let requested = manifest
            .permissions
            .iter()
            .cloned()
            .collect::<HashSet<String>>();
        for permission in &requested {
            conn.execute(
                "INSERT OR IGNORE INTO plugin_permissions
                    (plugin_id, permission, granted, created_at, updated_at)
                 VALUES (?1, ?2, 0, datetime('now','localtime'), datetime('now','localtime'))",
                params![manifest.id, permission],
            )?;
        }

        let existing = conn
            .prepare("SELECT permission FROM plugin_permissions WHERE plugin_id = ?1")?
            .query_map([manifest.id.as_str()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for permission in existing {
            if !requested.contains(&permission) {
                conn.execute(
                    "DELETE FROM plugin_permissions WHERE plugin_id = ?1 AND permission = ?2",
                    params![manifest.id, permission],
                )?;
            }
        }

        drop(conn);
        self.get_plugin(&manifest.id)
    }

    /// 设置插件启用状态
    pub fn set_plugin_enabled(&self, plugin_id: &str, enabled: bool) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE plugins
             SET enabled = ?1, updated_at = datetime('now','localtime')
             WHERE id = ?2",
            params![i32::from(enabled), plugin_id],
        )?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("插件 {} 不存在", plugin_id)));
        }
        Ok(())
    }

    /// 删除插件元数据
    pub fn delete_plugin(&self, plugin_id: &str) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM plugins WHERE id = ?1", [plugin_id])?;
        Ok(affected > 0)
    }

    /// 授权指定权限
    pub fn grant_plugin_permissions(
        &self,
        plugin_id: &str,
        permissions: &[String],
    ) -> Result<usize, AppError> {
        let conn = self.conn_lock()?;
        let mut affected = 0;
        for permission in permissions {
            affected += conn.execute(
                "UPDATE plugin_permissions
                 SET granted = 1, updated_at = datetime('now','localtime')
                 WHERE plugin_id = ?1 AND permission = ?2",
                params![plugin_id, permission],
            )?;
        }
        Ok(affected)
    }

    /// 撤销指定权限
    pub fn revoke_plugin_permissions(
        &self,
        plugin_id: &str,
        permissions: &[String],
    ) -> Result<usize, AppError> {
        let conn = self.conn_lock()?;
        let mut affected = 0;
        for permission in permissions {
            affected += conn.execute(
                "UPDATE plugin_permissions
                 SET granted = 0, updated_at = datetime('now','localtime')
                 WHERE plugin_id = ?1 AND permission = ?2",
                params![plugin_id, permission],
            )?;
        }
        Ok(affected)
    }

    /// 读取插件设置，value 按 JSON 反序列化返回
    pub fn get_plugin_settings(
        &self,
        plugin_id: &str,
    ) -> Result<HashMap<String, serde_json::Value>, AppError> {
        let conn = self.conn_lock()?;
        let exists: Option<i32> = conn
            .query_row("SELECT 1 FROM plugins WHERE id = ?1", [plugin_id], |row| row.get(0))
            .optional()?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("插件 {} 不存在", plugin_id)));
        }

        let mut stmt = conn.prepare(
            "SELECT key, value FROM plugin_settings
             WHERE plugin_id = ?1
             ORDER BY key ASC",
        )?;
        let rows = stmt
            .query_map([plugin_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut map = HashMap::new();
        for (key, value) in rows {
            let parsed = serde_json::from_str(&value)
                .unwrap_or_else(|_| serde_json::Value::String(value));
            map.insert(key, parsed);
        }
        Ok(map)
    }

    /// 全量替换插件设置
    pub fn set_plugin_settings(
        &self,
        plugin_id: &str,
        settings: &HashMap<String, serde_json::Value>,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let exists: Option<i32> = conn
            .query_row("SELECT 1 FROM plugins WHERE id = ?1", [plugin_id], |row| row.get(0))
            .optional()?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("插件 {} 不存在", plugin_id)));
        }

        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM plugin_settings WHERE plugin_id = ?1", [plugin_id])?;
        for (key, value) in settings {
            tx.execute(
                "INSERT INTO plugin_settings (plugin_id, key, value, updated_at)
                 VALUES (?1, ?2, ?3, datetime('now','localtime'))",
                params![plugin_id, key, serde_json::to_string(value)?],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
