//! 插件系统 DAO
//!
//! 仅负责插件元数据、权限授权与插件设置的 SQLite 持久化。
//! 插件目录扫描、manifest 校验、文件复制/删除都放在 Service 层。

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::Database;
use crate::error::AppError;
use crate::models::{PluginInfo, PluginManifest, PluginQuarantineEntry};

const SELECT_COLUMNS: &str = "id, name, version, description, author, path, main, styles, \
     min_app_version, manifest_json, enabled, status, installed_at, updated_at, content_hash, \
     install_source, package_hash, approved_hash";

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
        content_hash: row.get(14).unwrap_or_default(),
        install_source: row.get(15).unwrap_or_else(|_| "local-dir".to_string()),
        package_hash: row.get(16).unwrap_or_default(),
        approved_hash: row.get(17).unwrap_or_default(),
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
        content_hash: &str,
        install_source: &str,
        package_hash: &str,
    ) -> Result<PluginInfo, AppError> {
        let manifest_json = serde_json::to_string(manifest)?;
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO plugins
                (id, name, version, description, author, path, main, styles,
                 min_app_version, manifest_json, enabled, status,
                 content_hash, install_source, package_hash, approved_hash,
                 installed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 'installed',
                     ?11, ?12, ?13, ?13, datetime('now','localtime'), datetime('now','localtime'))
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
                 content_hash = excluded.content_hash,
                 install_source = excluded.install_source,
                 package_hash = excluded.package_hash,
                 approved_hash = excluded.approved_hash,
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
                content_hash,
                install_source,
                package_hash,
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

        // 授权事实随清单同步：不再声明的能力删除；仍在声明的能力绑定到新版本。
        // 版本升级新增的能力不会自动获得授权，需用户显式授权后才能调用。
        let authorized = conn
            .prepare("SELECT capability FROM plugin_authorizations WHERE plugin_id = ?1")?
            .query_map([manifest.id.as_str()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for capability in authorized {
            if requested.contains(&capability) {
                conn.execute(
                    "UPDATE plugin_authorizations SET version = ?2
                     WHERE plugin_id = ?1 AND capability = ?3",
                    params![manifest.id, manifest.version, capability],
                )?;
            } else {
                conn.execute(
                    "DELETE FROM plugin_authorizations WHERE plugin_id = ?1 AND capability = ?2",
                    params![manifest.id, capability],
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

    /// 检查插件是否已获得指定权限（T2: plugin_proxy 权限校验用）
    pub fn has_plugin_permission(&self, plugin_id: &str, perm: &str) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let granted: Option<i32> = conn
            .query_row(
                "SELECT granted FROM plugin_permissions
                 WHERE plugin_id = ?1 AND permission = ?2",
                params![plugin_id, perm],
                |row| row.get(0),
            )
            .optional()?;
        Ok(granted.unwrap_or(0) != 0)
    }

    /// 查询单个插件设置（T2: plugin_proxy_settings_get 用）
    pub fn get_plugin_setting(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, AppError> {
        let conn = self.conn_lock()?;
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM plugin_settings
                 WHERE plugin_id = ?1 AND key = ?2",
                params![plugin_id, key],
                |row| row.get(0),
            )
            .optional()?;
        match value {
            Some(v) => Ok(Some(
                serde_json::from_str(&v).unwrap_or(serde_json::Value::String(v)),
            )),
            None => Ok(None),
        }
    }

    /// Upsert 单个插件设置（T2: plugin_proxy_settings_set 用）
    pub fn set_plugin_setting(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let value_str = serde_json::to_string(value)?;
        conn.execute(
            "INSERT INTO plugin_settings (plugin_id, key, value, updated_at)
             VALUES (?1, ?2, ?3, datetime('now','localtime'))
             ON CONFLICT(plugin_id, key) DO UPDATE SET
                 value = excluded.value,
                 updated_at = excluded.updated_at",
            params![plugin_id, key, value_str],
        )?;
        Ok(())
    }

    /// T25: 写入插件审计日志
    pub fn write_audit_log(
        &self,
        plugin_id: &str,
        operation: &str,
        target: Option<&str>,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO plugin_audit_log (plugin_id, operation, target, timestamp)
             VALUES (?1, ?2, ?3, datetime('now','localtime'))",
            params![plugin_id, operation, target],
        )?;
        Ok(())
    }

    /// T25: 查询某插件的审计日志（最近 N 条）
    pub fn get_plugin_audit_log(
        &self,
        plugin_id: &str,
        limit: u32,
    ) -> Result<Vec<(i64, String, String, Option<String>, String)>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, plugin_id, operation, target, timestamp
             FROM plugin_audit_log
             WHERE plugin_id = ?1
             ORDER BY id DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![plugin_id, limit], |row| {
                Ok((
                    row.get(0)?, // id
                    row.get(1)?, // plugin_id
                    row.get(2)?, // operation
                    row.get(3)?, // target
                    row.get(4)?, // timestamp
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    /// T26: 查询插件的 content_hash
    pub fn get_plugin_content_hash(&self, plugin_id: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn_lock()?;
        Ok(conn.query_row(
            "SELECT content_hash FROM plugins WHERE id = ?1",
            [plugin_id],
            |row| row.get(0),
        ).optional()?)
    }

    // ─── 运行代际（A1/A2） ──────────────────────

    /// 读取当前启用代际；从未启用过的插件返回 0。
    pub fn get_activation_generation(&self, plugin_id: &str) -> Result<i64, AppError> {
        let conn = self.conn_lock()?;
        let generation: Option<i64> = conn
            .query_row(
                "SELECT generation FROM plugin_activation_generations WHERE plugin_id = ?1",
                [plugin_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(generation.unwrap_or(0))
    }

    /// 启用时递增代际并清空停用时间；返回新代际。
    pub fn bump_activation_generation(&self, plugin_id: &str) -> Result<i64, AppError> {
        let conn = self.conn_lock()?;
        let tx = conn.unchecked_transaction()?;
        let exists: Option<i32> = tx
            .query_row("SELECT 1 FROM plugins WHERE id = ?1", [plugin_id], |row| {
                row.get(0)
            })
            .optional()?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("插件 {} 不存在", plugin_id)));
        }
        tx.execute(
            "INSERT INTO plugin_activation_generations (plugin_id, generation, activated_at)
             VALUES (?1, 1, datetime('now','localtime'))
             ON CONFLICT(plugin_id) DO UPDATE SET
                 generation = generation + 1,
                 activated_at = datetime('now','localtime'),
                 deactivated_at = NULL",
            [plugin_id],
        )?;
        let generation: i64 = tx.query_row(
            "SELECT generation FROM plugin_activation_generations WHERE plugin_id = ?1",
            [plugin_id],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(generation)
    }

    /// 记录停用时间；插件从未启用过时插入一条 generation=0 的记录。
    pub fn mark_plugin_deactivated(&self, plugin_id: &str) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO plugin_activation_generations (plugin_id, generation, deactivated_at)
             VALUES (?1, 0, datetime('now','localtime'))
             ON CONFLICT(plugin_id) DO UPDATE SET
                 deactivated_at = datetime('now','localtime')",
            [plugin_id],
        )?;
        Ok(())
    }

    /// 读取代际与启停时间，供状态查询。
    pub fn get_activation_state(
        &self,
        plugin_id: &str,
    ) -> Result<(i64, Option<String>, Option<String>), AppError> {
        let conn = self.conn_lock()?;
        let row: Option<(i64, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT generation, activated_at, deactivated_at
                 FROM plugin_activation_generations WHERE plugin_id = ?1",
                [plugin_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        Ok(row.unwrap_or((0, None, None)))
    }

    // ─── 授权事实（C1/C2） ──────────────────────

    /// 授权能力：写入授权事实，绑定当前插件版本。
    pub fn grant_plugin_authorizations(
        &self,
        plugin_id: &str,
        version: &str,
        capabilities: &[String],
    ) -> Result<usize, AppError> {
        let conn = self.conn_lock()?;
        let mut affected = 0;
        for capability in capabilities {
            affected += conn.execute(
                "INSERT INTO plugin_authorizations (plugin_id, version, capability, scope)
                 VALUES (?1, ?2, ?3, '*')
                 ON CONFLICT(plugin_id, capability) DO UPDATE SET
                     version = excluded.version,
                     granted_at = datetime('now','localtime')",
                params![plugin_id, version, capability],
            )?;
        }
        Ok(affected)
    }

    /// 撤销能力授权。
    pub fn revoke_plugin_authorizations(
        &self,
        plugin_id: &str,
        capabilities: &[String],
    ) -> Result<usize, AppError> {
        let conn = self.conn_lock()?;
        let mut affected = 0;
        for capability in capabilities {
            affected += conn.execute(
                "DELETE FROM plugin_authorizations WHERE plugin_id = ?1 AND capability = ?2",
                params![plugin_id, capability],
            )?;
        }
        Ok(affected)
    }

    /// 授权事实校验：能力已授权且授权版本与当前安装版本一致。
    pub fn has_plugin_authorization(
        &self,
        plugin_id: &str,
        capability: &str,
    ) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let found: Option<i32> = conn
            .query_row(
                "SELECT 1 FROM plugin_authorizations a
                 JOIN plugins p ON p.id = a.plugin_id
                 WHERE a.plugin_id = ?1 AND a.capability = ?2 AND a.version = p.version
                 LIMIT 1",
                params![plugin_id, capability],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    // ─── 卸载隔离区（C4） ──────────────────────

    /// 记录一条隔离条目，返回条目 ID。
    pub fn insert_quarantine(
        &self,
        plugin_id: &str,
        version: &str,
        original_path: &str,
        quarantine_path: &str,
        package_hash: &str,
    ) -> Result<i64, AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO plugin_uninstall_quarantine
                (plugin_id, version, original_path, quarantine_path, package_hash)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![plugin_id, version, original_path, quarantine_path, package_hash],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 查询某插件最近一条未恢复的隔离条目。
    pub fn latest_unrestored_quarantine(
        &self,
        plugin_id: &str,
    ) -> Result<Option<PluginQuarantineEntry>, AppError> {
        let conn = self.conn_lock()?;
        let entry = conn
            .query_row(
                "SELECT id, plugin_id, version, quarantine_path, package_hash,
                        quarantined_at, restored_at
                 FROM plugin_uninstall_quarantine
                 WHERE plugin_id = ?1 AND restored_at IS NULL
                 ORDER BY id DESC LIMIT 1",
                [plugin_id],
                row_to_quarantine,
            )
            .optional()?;
        Ok(entry)
    }

    /// 列出全部隔离条目（最近在前）。
    pub fn list_quarantines(&self) -> Result<Vec<PluginQuarantineEntry>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, plugin_id, version, quarantine_path, package_hash,
                    quarantined_at, restored_at
             FROM plugin_uninstall_quarantine
             ORDER BY id DESC",
        )?;
        let rows = stmt
            .query_map([], row_to_quarantine)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 标记隔离条目已恢复。
    pub fn mark_quarantine_restored(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "UPDATE plugin_uninstall_quarantine
             SET restored_at = datetime('now','localtime') WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }
}

fn row_to_quarantine(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginQuarantineEntry> {
    Ok(PluginQuarantineEntry {
        id: row.get(0)?,
        plugin_id: row.get(1)?,
        version: row.get(2)?,
        quarantine_path: row.get(3)?,
        package_hash: row.get(4)?,
        quarantined_at: row.get(5)?,
        restored_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    /// 创建测试用 Database（:memory: 模式，不走文件系统）
    fn setup_test_db() -> Database {
        Database::init(":memory:").expect("创建内存数据库失败")
    }

    /// 向测试数据库插入一个测试插件
    fn insert_test_plugin(db: &Database, id: &str, enabled: bool, status: &str) {
        let conn = db.conn_lock().unwrap();
        conn.execute(
            "INSERT INTO plugins (id, name, version, description, author, path, main, manifest_json, enabled, status)
             VALUES (?1, ?2, '1.0', '', '', '/tmp', 'main.js', '{}', ?3, ?4)",
            params![id, id, enabled as i32, status],
        )
        .unwrap();
    }

    /// 向测试数据库插入一条权限授权记录
    fn grant_permission(db: &Database, plugin_id: &str, permission: &str) {
        let conn = db.conn_lock().unwrap();
        conn.execute(
            "INSERT INTO plugin_permissions (plugin_id, permission, granted)
             VALUES (?1, ?2, 1)",
            params![plugin_id, permission],
        )
        .unwrap();
    }

    // ─── §10.15 越权测试用例（针对 Database 层的 has_plugin_permission） ───

    /// 用例 5：有效令牌 + 缺 notes:read → has_plugin_permission 返回 false
    #[test]
    fn case_5_missing_notes_read() {
        let db = setup_test_db();
        insert_test_plugin(&db, "cc", true, "installed");
        let has = db.has_plugin_permission("cc", "notes:read").unwrap();
        assert!(!has, "未授权 notes:read 应返回 false");
    }

    /// 用例 6：有效令牌 + 缺 notes:write（仅授 notes:read）→ false
    #[test]
    fn case_6_missing_notes_write() {
        let db = setup_test_db();
        insert_test_plugin(&db, "cc", true, "installed");
        grant_permission(&db, "cc", "notes:read");
        let has = db.has_plugin_permission("cc", "notes:write").unwrap();
        assert!(!has, "缺 notes:write 应返回 false");
    }

    /// 用例 7：有效令牌 + 完整权限 → has_plugin_permission 返回 true
    #[test]
    fn case_7_full_permissions() {
        let db = setup_test_db();
        insert_test_plugin(&db, "cc", true, "installed");
        grant_permission(&db, "cc", "notes:read");
        let has = db.has_plugin_permission("cc", "notes:read").unwrap();
        assert!(has, "已授权 notes:read 应返回 true");
    }

    /// 不存在的插件查询权限 → 返回 false（不 panic）
    #[test]
    fn case_nonexistent_plugin_permission_false() {
        let db = setup_test_db();
        let has = db.has_plugin_permission("nonexistent", "notes:read").unwrap();
        assert!(!has, "不存在的插件应返回 false");
    }

    /// 用例 8：跨插件设置隔离
    /// A 插件的 settings_get_all 应只返回 A 的设置，不返回 B 的
    #[test]
    fn case_8_plugin_settings_isolation() {
        let db = setup_test_db();
        insert_test_plugin(&db, "plugin-a", true, "installed");
        insert_test_plugin(&db, "plugin-b", true, "installed");

        db.set_plugin_setting(
            "plugin-a",
            "keyA",
            &serde_json::Value::String("valueA".into()),
        )
        .unwrap();
        db.set_plugin_setting(
            "plugin-b",
            "keyB",
            &serde_json::Value::String("valueB".into()),
        )
        .unwrap();

        let a_settings = db.get_plugin_settings("plugin-a").unwrap();
        assert_eq!(a_settings.get("keyA").unwrap(), "valueA");
        assert!(!a_settings.contains_key("keyB"), "A 不应看到 B 的设置");

        let b_settings = db.get_plugin_settings("plugin-b").unwrap();
        assert_eq!(b_settings.get("keyB").unwrap(), "valueB");
        assert!(!b_settings.contains_key("keyA"), "B 不应看到 A 的设置");
    }

    /// 设置持久化和再次读取的一致性（Upsert 覆盖）
    #[test]
    fn case_settings_upsert_consistency() {
        let db = setup_test_db();
        insert_test_plugin(&db, "cc", true, "installed");

        db.set_plugin_setting(
            "cc",
            "theme",
            &serde_json::Value::String("dark".into()),
        )
        .unwrap();
        let v1 = db.get_plugin_setting("cc", "theme").unwrap();
        assert_eq!(v1.unwrap(), "dark");

        db.set_plugin_setting(
            "cc",
            "theme",
            &serde_json::Value::String("light".into()),
        )
        .unwrap();
        let v2 = db.get_plugin_setting("cc", "theme").unwrap();
        assert_eq!(v2.unwrap(), "light");
    }
}
