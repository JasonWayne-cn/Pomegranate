//! 插件系统业务层
//!
//! 当前 MVP 只实现插件元数据管理：扫描 / 安装 / 启用 / 禁用 / 卸载 / 权限授权 / 设置读写。
//! 第三方 JS 插件运行时暂不执行，避免在没有沙箱前扩大安全边界。

use sha2::{Digest, Sha256};

/// T26: 计算 main.js 文件的 SHA-256 哈希（hex 编码）
fn compute_main_hash(plugin_dir: &std::path::Path, main: &str) -> Result<String, crate::error::AppError> {
    let main_path = plugin_dir.join(main);
    let bytes = std::fs::read(&main_path)
        .map_err(|e| crate::error::AppError::Io(e))?;
    let hash = Sha256::digest(&bytes);
    Ok(format!("{:x}", hash))
}

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use uuid::Uuid;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    PluginActivationState, PluginInfo, PluginInspection, PluginManifest, PluginQuarantineEntry,
    PluginVersionEntry,
};
use crate::services::plugin_integrity;
use crate::services::plugin_token::PluginTokenRegistry;
use crate::services::safe_archive;

const MANIFEST_FILE: &str = "plugin.json";
/// 回滚归档目录名（位于 `<data_dir>/plugins/<id>/versions/<version>`）
const VERSIONS_DIR: &str = "versions";
/// 卸载隔离目录名（位于 `<data_dir>/plugin-quarantine`）
const QUARANTINE_DIR: &str = "plugin-quarantine";

/// 插件 zip 安装限制：与扩展包保持同一量级，避免解压炸弹。
const MAX_PLUGIN_ZIP_FILES: usize = 2000;
const MAX_PLUGIN_ZIP_BYTES: u64 = 32 * 1024 * 1024;

/// 随安装包分发的内置插件 ID（资源目录：`resources/plugins/<id>`）。
/// 与 `scripts/sync-bundled-plugins.mjs` 中的 BUNDLED_PLUGINS 保持一致。
pub const BUNDLED_PLUGINS: &[&str] = &["research-assistant"];
/// 用户主动卸载内置插件后写入，避免下次启动又被装回。
const BUNDLED_DISMISSED_KEY_PREFIX: &str = "plugin_bundled_dismissed:";

fn bundled_dismissed_key(plugin_id: &str) -> String {
    format!("{BUNDLED_DISMISSED_KEY_PREFIX}{plugin_id}")
}

const VALID_PERMISSIONS: &[&str] = &[
    "editor:read",
    "editor:write",
    "workspace:read",
    "workspace:write",
    "notes:read",
    "notes:write",
    "settings:read",
    "settings:write",
    "files:read",
    "files:write",
    "network:request",
    "clipboard:read",
    "clipboard:write",
    // ─── 待办插件化权限 ──────────────────────
    "tasks.read",
    "tasks.write",
    "tasks.subscribe",
    "taskViews.register",
    // ─── AI 插件能力 ─────────────────────────
    "ai:chat",
    "ai:models",
];

pub struct PluginService;

impl PluginService {
    /// 列出已安装插件
    pub fn list(db: &Database) -> Result<Vec<PluginInfo>, AppError> {
        db.list_plugins()
    }

    /// 扫描 app data/plugins 下的插件目录，同步 manifest 到数据库
    pub fn scan(db: &Database, data_dir: &Path) -> Result<Vec<PluginInfo>, AppError> {
        let plugins_dir = ensure_plugins_dir(data_dir)?;
        for entry in fs::read_dir(&plugins_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            // 跳过安装/预检用的临时目录（.tmp-install-* / .tmp-inspect-*）
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let dir = entry.path();
            match Self::read_valid_manifest(&dir).and_then(|manifest| {
                ensure_declared_main_exists(&dir, &manifest)?;
                let path = dir.to_string_lossy().to_string();
                let hash = compute_main_hash(&dir, &manifest.main)?;
                let package_hash = plugin_integrity::compute_dir_hash(&dir)?;
                // 已入库的插件保留原来源标记，扫描不应改写安装来源
                let install_source = db
                    .get_plugin(&manifest.id)
                    .map(|info| info.install_source)
                    .unwrap_or_else(|_| "scan".to_string());
                db.upsert_plugin(&manifest, &path, &hash, &install_source, &package_hash)
            }) {
                Ok(_) => {}
                Err(e) => {
                    log::warn!("[plugins] 跳过无效插件目录 {}: {}", dir.display(), e);
                }
            }
        }
        db.list_plugins()
    }

    /// 从用户选择的目录安装插件。安装时复制到 app data/plugins/<plugin-id>。
    pub fn install_from_dir(
        db: &Database,
        data_dir: &Path,
        source_path: &str,
    ) -> Result<PluginInfo, AppError> {
        let source = PathBuf::from(source_path);
        if !source.is_dir() {
            return Err(AppError::InvalidInput("插件来源必须是目录".into()));
        }
        let manifest = Self::read_valid_manifest(&source)?;
        ensure_declared_main_exists(&source, &manifest)?;
        Self::install_prepared_source(db, data_dir, &source, manifest, "local-dir")
    }

    /// 预检插件 zip：解压到临时目录校验清单与入口，返回安装前展示信息。
    pub fn inspect_zip(data_dir: &Path, zip_path: &str) -> Result<PluginInspection, AppError> {
        let path = resolve_plugin_zip(zip_path)?;
        let temp_root = ensure_plugins_dir(data_dir)?
            .join(format!(".tmp-inspect-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root)?;

        let result = (|| {
            safe_archive::extract_zip_safely(
                &path,
                &temp_root,
                MAX_PLUGIN_ZIP_FILES,
                MAX_PLUGIN_ZIP_BYTES,
            )?;
            let source = find_manifest_root(&temp_root)?;
            let manifest = Self::read_valid_manifest(&source)?;
            ensure_declared_main_exists(&source, &manifest)?;
            Ok(PluginInspection {
                manifest,
                file_count: count_files(&source)?,
                uncompressed_bytes: dir_size(&source)?,
            })
        })();

        let _ = fs::remove_dir_all(&temp_root);
        result
    }

    /// 从 zip 压缩包安装插件。解压到临时目录校验后复制到 app data/plugins/<plugin-id>。
    pub fn install_from_zip(
        db: &Database,
        data_dir: &Path,
        zip_path: &str,
    ) -> Result<PluginInfo, AppError> {
        let path = resolve_plugin_zip(zip_path)?;
        let temp_root = ensure_plugins_dir(data_dir)?
            .join(format!(".tmp-install-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root)?;

        let result = (|| {
            safe_archive::extract_zip_safely(
                &path,
                &temp_root,
                MAX_PLUGIN_ZIP_FILES,
                MAX_PLUGIN_ZIP_BYTES,
            )?;
            let source = find_manifest_root(&temp_root)?;
            let manifest = Self::read_valid_manifest(&source)?;
            ensure_declared_main_exists(&source, &manifest)?;
            Self::install_prepared_source(db, data_dir, &source, manifest, "local-zip")
        })();

        let _ = fs::remove_dir_all(&temp_root);
        result
    }

    /// 已校验过的插件源目录 → 复制到 app data/plugins/<id> 并写入数据库。
    ///
    /// 安装规则：
    /// - 全新安装：直接落地；
    /// - 已安装且新版本更高：归档旧版本到 `versions/<ver>` 后替换，保留启停状态与设置；
    /// - 同版本或降级：拒绝（降级请走 `rollback`）；
    /// - 入口文件与发布者身份不可变。
    fn install_prepared_source(
        db: &Database,
        data_dir: &Path,
        source: &Path,
        manifest: PluginManifest,
        install_source: &str,
    ) -> Result<PluginInfo, AppError> {
        // staging 预校验：先算源目录哈希，安装后再比对
        let staging_hash = plugin_integrity::compute_dir_hash(source)?;
        if source.join(VERSIONS_DIR).exists() {
            return Err(AppError::InvalidInput(
                "插件包根目录不允许包含 versions/ 目录".into(),
            ));
        }

        let plugins_dir = ensure_plugins_dir(data_dir)?;
        let dest = plugins_dir.join(&manifest.id);

        let existing = match db.get_plugin(&manifest.id) {
            Ok(info) => Some(info),
            Err(AppError::NotFound(_)) => None,
            Err(error) => return Err(error),
        };

        let mut is_update = false;
        if let Some(existing) = &existing {
            let order = compare_versions(&manifest.version, &existing.version);
            if order < 0 {
                return Err(AppError::InvalidInput(format!(
                    "不允许降级安装：已安装 {}，待安装 {}；如需回退请使用回滚",
                    existing.version, manifest.version
                )));
            }
            if order == 0 {
                return Err(AppError::InvalidInput(format!(
                    "插件 {} 已安装版本 {}，同版本请先卸载或使用回滚",
                    manifest.id, existing.version
                )));
            }
            if manifest.main != existing.main {
                return Err(AppError::InvalidInput(
                    "更新包入口文件必须与已安装版本一致".into(),
                ));
            }
            if let (Some(old_author), Some(new_author)) = (&existing.author, &manifest.author) {
                if old_author != new_author {
                    return Err(AppError::InvalidInput(
                        "更新包发布者必须与已安装版本一致".into(),
                    ));
                }
            }
            // 归档旧版本 → 清空 live（保留 versions/）→ 复制新版本
            archive_current_version(&dest, &existing.version)?;
            clear_live_dir(&dest)?;
            is_update = true;
        } else if dest.exists() {
            // 目录存在但无数据库记录：视为残留，直接覆盖
            fs::remove_dir_all(&dest)?;
        }

        copy_plugin_dir(source, &dest)?;

        let installed_manifest = Self::read_valid_manifest(&dest)?;
        ensure_declared_main_exists(&dest, &installed_manifest)?;
        let installed_hash = plugin_integrity::compute_dir_hash(&dest)?;
        if installed_hash != staging_hash {
            return Err(AppError::Custom(format!(
                "插件 {} 安装后目录哈希与源不一致，可能被并发修改，已拒绝",
                manifest.id
            )));
        }
        let installed_path = dest.to_string_lossy().to_string();
        let hash = compute_main_hash(&dest, &installed_manifest.main)?;
        let info = db.upsert_plugin(
            &installed_manifest,
            &installed_path,
            &hash,
            install_source,
            &installed_hash,
        )?;
        let _ = db.write_audit_log(
            &info.id,
            if is_update { "update" } else { "install" },
            Some(&info.version),
        );
        // 用户手动重装了内置插件，清除“不要自动安装”标记。
        if BUNDLED_PLUGINS.contains(&info.id.as_str()) {
            let _ = db.delete_config(&bundled_dismissed_key(&info.id));
        }
        // 重装时恢复卸载前备份的插件设置，避免 plugin_settings 外键级联删除造成数据丢失。
        if let Err(error) = restore_plugin_settings(db, data_dir, &info.id) {
            log::warn!("[plugin] 恢复 {} 的数据失败: {}", info.id, error);
        }
        Ok(info)
    }

    /// 内置插件资源根目录（随安装包分发的 `resources/plugins`）。
    pub fn bundled_plugins_root(resource_dir: &Path) -> PathBuf {
        resource_dir.join("resources").join("plugins")
    }

    /// 首次启动时安装随安装包分发的内置插件。
    ///
    /// 规则：
    /// - 用户主动卸载过（dismissed）则不自动安装；
    /// - 已安装且版本不低于内置版本则跳过（尊重用户回滚/手动版本）；
    /// - 内置版本更高时覆盖升级，保留用户原有的启用状态；
    /// - 首次安装默认启用，权限仍由用户在插件页授权。
    pub fn install_bundled(
        db: &Database,
        data_dir: &Path,
        resource_dir: &Path,
    ) -> Result<Vec<PluginInfo>, AppError> {
        let root = Self::bundled_plugins_root(resource_dir);
        let mut installed = Vec::new();
        for &plugin_id in BUNDLED_PLUGINS {
            match Self::install_one_bundled(db, data_dir, &root, plugin_id) {
                Ok(Some(info)) => installed.push(info),
                Ok(None) => {}
                Err(error) => {
                    log::warn!("[plugins] 内置插件 {} 自动安装失败: {}", plugin_id, error)
                }
            }
        }
        Ok(installed)
    }

    fn install_one_bundled(
        db: &Database,
        data_dir: &Path,
        root: &Path,
        plugin_id: &str,
    ) -> Result<Option<PluginInfo>, AppError> {
        let source = root.join(plugin_id);
        if !source.is_dir() {
            return Ok(None);
        }
        if db.get_config(&bundled_dismissed_key(plugin_id))?.as_deref() == Some("1") {
            return Ok(None);
        }

        let bundled_manifest = Self::read_valid_manifest(&source)?;
        if bundled_manifest.id != plugin_id {
            return Err(AppError::InvalidInput(format!(
                "内置插件 ID 不匹配: 期望 {}，实际 {}",
                plugin_id, bundled_manifest.id
            )));
        }
        ensure_declared_main_exists(&source, &bundled_manifest)?;

        let dest = ensure_plugins_dir(data_dir)?.join(plugin_id);
        let existing = match db.get_plugin(plugin_id) {
            Ok(info) => Some(info),
            Err(AppError::NotFound(_)) => None,
            Err(error) => return Err(error),
        };

        if let Some(info) = &existing {
            if dest.is_dir() && compare_versions(&bundled_manifest.version, &info.version) <= 0 {
                return Ok(None);
            }
        }

        if dest.exists() {
            fs::remove_dir_all(&dest)?;
        }
        copy_plugin_dir(&source, &dest)?;

        let installed_manifest = Self::read_valid_manifest(&dest)?;
        ensure_declared_main_exists(&dest, &installed_manifest)?;
        let installed_path = dest.to_string_lossy().to_string();
        let hash = compute_main_hash(&dest, &installed_manifest.main)?;
        let package_hash = plugin_integrity::compute_dir_hash(&dest)?;
        let info = db.upsert_plugin(
            &installed_manifest,
            &installed_path,
            &hash,
            "bundled",
            &package_hash,
        )?;
        if existing.is_none() {
            // 首次内置安装默认启用；升级时保留用户原有开关状态。
            db.set_plugin_enabled(plugin_id, true)?;
            return Ok(Some(db.get_plugin(plugin_id)?));
        }
        Ok(Some(info))
    }

    /// 启用插件。
    ///
    /// 顺序：完整性校验 → 递增代际（旧令牌立即失效）→ 置 enabled → 清理旧会话。
    pub fn enable(
        db: &Database,
        tokens: &PluginTokenRegistry,
        plugin_id: &str,
    ) -> Result<(), AppError> {
        validate_plugin_id(plugin_id)?;
        let plugin = db.get_plugin(plugin_id)?;
        verify_plugin_files(&plugin)?;

        // 代际先 +1：即使随后 enabled 写失败，旧会话也已被判定过期
        let generation = db.bump_activation_generation(plugin_id)?;
        db.set_plugin_enabled(plugin_id, true)?;
        let revoked = tokens
            .revoke_plugin(plugin_id)
            .map_err(AppError::Custom)?;
        let _ = db.write_audit_log(
            plugin_id,
            "enable",
            Some(&format!("generation={generation}, revoked_sessions={revoked}")),
        );
        Ok(())
    }

    /// 禁用插件。
    ///
    /// 顺序：先置 enabled=false（权威门）→ 失效全部令牌 → 记录停用时间。
    pub fn disable(
        db: &Database,
        tokens: &PluginTokenRegistry,
        plugin_id: &str,
    ) -> Result<(), AppError> {
        validate_plugin_id(plugin_id)?;
        db.get_plugin(plugin_id)?;
        // 先关门，后续即使清理失败，令牌校验也会因 enabled=false 被拒绝
        db.set_plugin_enabled(plugin_id, false)?;
        let revoked = tokens
            .revoke_plugin(plugin_id)
            .map_err(AppError::Custom)?;
        db.mark_plugin_deactivated(plugin_id)?;
        let _ = db.write_audit_log(
            plugin_id,
            "disable",
            Some(&format!("revoked_sessions={revoked}")),
        );
        Ok(())
    }

    /// 卸载插件：停用 → 备份设置 → 目录移入隔离区 → 移除数据库记录。
    ///
    /// 隔离目录位于 `<data_dir>/plugin-quarantine/<id>-<uuid>/`，
    /// 可通过 `restore_quarantined` 恢复。
    pub fn uninstall(
        db: &Database,
        data_dir: &Path,
        tokens: &PluginTokenRegistry,
        plugin_id: &str,
    ) -> Result<bool, AppError> {
        validate_plugin_id(plugin_id)?;
        let plugin = db.get_plugin(plugin_id)?;

        // 1. 先关门并失效会话
        db.set_plugin_enabled(plugin_id, false)?;
        let _ = tokens.revoke_plugin(plugin_id);
        db.mark_plugin_deactivated(plugin_id)?;

        // 2. 备份设置，供恢复时使用
        match backup_plugin_settings(db, data_dir, plugin_id) {
            Ok(()) => {}
            Err(AppError::NotFound(_)) => {}
            Err(error) => return Err(error),
        }

        // 3. 目录移入隔离区（失败时不删库，避免留下无法恢复的残骸）
        let plugin_dir = ensure_plugins_dir(data_dir)?.join(plugin_id);
        if plugin_dir.exists() {
            let quarantine_root = data_dir.join(QUARANTINE_DIR);
            fs::create_dir_all(&quarantine_root)?;
            let quarantine_path = quarantine_root.join(format!("{plugin_id}-{}", Uuid::new_v4()));
            move_dir(&plugin_dir, &quarantine_path)?;
            db.insert_quarantine(
                plugin_id,
                &plugin.version,
                &plugin_dir.to_string_lossy(),
                &quarantine_path.to_string_lossy(),
                &plugin.package_hash,
            )?;
        }

        // 4. 移除数据库记录（设置随外键级联删除，已有备份）
        if BUNDLED_PLUGINS.contains(&plugin_id) {
            db.set_config(&bundled_dismissed_key(plugin_id), "1")?;
        }
        let deleted = db.delete_plugin(plugin_id)?;
        let _ = db.write_audit_log(plugin_id, "uninstall", Some(&plugin.version));
        Ok(deleted)
    }

    /// 从隔离区恢复最近一次卸载的插件。
    pub fn restore_quarantined(
        db: &Database,
        data_dir: &Path,
        plugin_id: &str,
    ) -> Result<PluginInfo, AppError> {
        validate_plugin_id(plugin_id)?;
        if db.get_plugin(plugin_id).is_ok() {
            return Err(AppError::InvalidInput(format!(
                "插件 {} 已安装，无需恢复",
                plugin_id
            )));
        }
        let entry = db
            .latest_unrestored_quarantine(plugin_id)?
            .ok_or_else(|| AppError::NotFound(format!("插件 {} 没有可恢复的隔离记录", plugin_id)))?;
        let quarantine_path = PathBuf::from(&entry.quarantine_path);
        if !quarantine_path.is_dir() {
            return Err(AppError::NotFound(format!(
                "隔离目录已不存在: {}",
                entry.quarantine_path
            )));
        }
        let dest = ensure_plugins_dir(data_dir)?.join(plugin_id);
        if dest.exists() {
            return Err(AppError::InvalidInput(format!(
                "目标目录已存在，拒绝覆盖: {}",
                dest.display()
            )));
        }

        move_dir(&quarantine_path, &dest)?;
        let manifest = Self::read_valid_manifest(&dest)?;
        ensure_declared_main_exists(&dest, &manifest)?;
        let package_hash = plugin_integrity::compute_dir_hash(&dest)?;
        if !entry.package_hash.is_empty() && package_hash != entry.package_hash {
            return Err(AppError::InvalidInput(
                "隔离目录内容已被修改，拒绝恢复".into(),
            ));
        }
        let main_hash = compute_main_hash(&dest, &manifest.main)?;
        let info = db.upsert_plugin(
            &manifest,
            &dest.to_string_lossy(),
            &main_hash,
            "restore",
            &package_hash,
        )?;
        if BUNDLED_PLUGINS.contains(&plugin_id) {
            let _ = db.delete_config(&bundled_dismissed_key(plugin_id));
        }
        if let Err(error) = restore_plugin_settings(db, data_dir, plugin_id) {
            log::warn!("[plugin] 恢复 {} 的设置失败: {}", plugin_id, error);
        }
        db.mark_quarantine_restored(entry.id)?;
        let _ = db.write_audit_log(plugin_id, "restore", Some(&entry.version));
        Ok(info)
    }

    /// 列出隔离区条目（含已恢复）。
    pub fn list_quarantined(db: &Database) -> Result<Vec<PluginQuarantineEntry>, AppError> {
        db.list_quarantines()
    }

    /// 回滚到已归档的旧版本。要求插件处于禁用状态。
    pub fn rollback(
        db: &Database,
        data_dir: &Path,
        plugin_id: &str,
        target_version: &str,
    ) -> Result<PluginInfo, AppError> {
        validate_plugin_id(plugin_id)?;
        if !is_safe_version(target_version) {
            return Err(AppError::InvalidInput("回滚版本号非法".into()));
        }
        let plugin = db.get_plugin(plugin_id)?;
        if plugin.enabled {
            return Err(AppError::InvalidInput(
                "回滚前请先禁用插件".into(),
            ));
        }
        if compare_versions(target_version, &plugin.version) >= 0 {
            return Err(AppError::InvalidInput(format!(
                "回滚目标 {} 必须低于当前版本 {}",
                target_version, plugin.version
            )));
        }
        let live = ensure_plugins_dir(data_dir)?.join(plugin_id);
        let version_dir = live.join(VERSIONS_DIR).join(target_version);
        if !version_dir.is_dir() {
            return Err(AppError::NotFound(format!(
                "版本 {} 未归档，无法回滚",
                target_version
            )));
        }

        archive_current_version(&live, &plugin.version)?;
        clear_live_dir(&live)?;
        copy_plugin_dir(&version_dir, &live)?;

        let manifest = Self::read_valid_manifest(&live)?;
        ensure_declared_main_exists(&live, &manifest)?;
        let package_hash = plugin_integrity::compute_dir_hash(&live)?;
        let main_hash = compute_main_hash(&live, &manifest.main)?;
        let info = db.upsert_plugin(
            &manifest,
            &live.to_string_lossy(),
            &main_hash,
            "rollback",
            &package_hash,
        )?;
        let _ = db.write_audit_log(
            plugin_id,
            "rollback",
            Some(&format!("{} -> {}", plugin.version, target_version)),
        );
        Ok(info)
    }

    /// 列出插件版本：当前版本 + `versions/` 下的归档版本（按版本号降序）。
    pub fn list_versions(
        db: &Database,
        data_dir: &Path,
        plugin_id: &str,
    ) -> Result<Vec<PluginVersionEntry>, AppError> {
        validate_plugin_id(plugin_id)?;
        let plugin = db.get_plugin(plugin_id)?;
        let live = ensure_plugins_dir(data_dir)?.join(plugin_id);
        let versions_dir = live.join(VERSIONS_DIR);

        let mut entries = Vec::new();
        if versions_dir.is_dir() {
            for entry in fs::read_dir(&versions_dir)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if is_safe_version(&name) && name != plugin.version {
                    entries.push(PluginVersionEntry {
                        version: name,
                        is_current: false,
                        archived: true,
                    });
                }
            }
        }
        entries.push(PluginVersionEntry {
            version: plugin.version,
            is_current: true,
            archived: false,
        });
        entries.sort_by(|a, b| compare_versions(&b.version, &a.version).cmp(&0));
        Ok(entries)
    }

    /// 查询插件运行状态（代际 + 活跃会话数）。
    pub fn activation_state(
        db: &Database,
        tokens: &PluginTokenRegistry,
        plugin_id: &str,
    ) -> Result<PluginActivationState, AppError> {
        validate_plugin_id(plugin_id)?;
        let plugin = db.get_plugin(plugin_id)?;
        let (generation, activated_at, deactivated_at) = db.get_activation_state(plugin_id)?;
        let active_sessions = tokens.session_count(plugin_id).unwrap_or(0);
        Ok(PluginActivationState {
            plugin_id: plugin.id,
            generation,
            enabled: plugin.enabled,
            active_sessions,
            activated_at,
            deactivated_at,
        })
    }

    /// 读取插件 manifest
    pub fn get_manifest(db: &Database, plugin_id: &str) -> Result<PluginManifest, AppError> {
        validate_plugin_id(plugin_id)?;
        Ok(db.get_plugin(plugin_id)?.manifest)
    }

    /// 授权权限
    pub fn grant_permissions(
        db: &Database,
        plugin_id: &str,
        permissions: Vec<String>,
    ) -> Result<usize, AppError> {
        validate_plugin_id(plugin_id)?;
        validate_permissions(&permissions)?;
        let plugin = db.get_plugin(plugin_id)?;
        ensure_permissions_declared(&plugin, &permissions)?;
        let affected = db.grant_plugin_permissions(plugin_id, &permissions)?;
        // 授权事实绑定当前版本，升级后新增能力需要重新授权
        db.grant_plugin_authorizations(plugin_id, &plugin.version, &permissions)?;
        let _ = db.write_audit_log(
            plugin_id,
            "grant_permissions",
            Some(&permissions.join(",")),
        );
        Ok(affected)
    }

    /// 撤销权限
    pub fn revoke_permissions(
        db: &Database,
        plugin_id: &str,
        permissions: Vec<String>,
    ) -> Result<usize, AppError> {
        validate_plugin_id(plugin_id)?;
        validate_permissions(&permissions)?;
        let plugin = db.get_plugin(plugin_id)?;
        ensure_permissions_declared(&plugin, &permissions)?;
        let affected = db.revoke_plugin_permissions(plugin_id, &permissions)?;
        db.revoke_plugin_authorizations(plugin_id, &permissions)?;
        let _ = db.write_audit_log(
            plugin_id,
            "revoke_permissions",
            Some(&permissions.join(",")),
        );
        Ok(affected)
    }

    /// 获取插件设置
    pub fn get_settings(
        db: &Database,
        plugin_id: &str,
    ) -> Result<HashMap<String, serde_json::Value>, AppError> {
        validate_plugin_id(plugin_id)?;
        db.get_plugin_settings(plugin_id)
    }

    /// 全量保存插件设置
    pub fn set_settings(
        db: &Database,
        plugin_id: &str,
        settings: serde_json::Value,
    ) -> Result<(), AppError> {
        validate_plugin_id(plugin_id)?;
        let obj = settings
            .as_object()
            .ok_or_else(|| AppError::InvalidInput("插件设置必须是 JSON 对象".into()))?;
        let map = obj
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<HashMap<_, _>>();
        db.set_plugin_settings(plugin_id, &map)
    }

    /// 读取插件目录内的静态资源文本。路径必须是插件目录内的相对路径。
    pub fn read_asset(
        db: &Database,
        data_dir: &Path,
        plugin_id: &str,
        relative_path: &str,
    ) -> Result<String, AppError> {
        validate_plugin_id(plugin_id)?;
        if !is_safe_relative_path(relative_path) {
            return Err(AppError::InvalidInput("资源路径非法".into()));
        }
        // 管理目录（历史版本归档）不对外暴露
        if Path::new(relative_path)
            .components()
            .next()
            .map(|c| c.as_os_str() == VERSIONS_DIR)
            .unwrap_or(false)
        {
            return Err(AppError::InvalidInput("资源路径非法".into()));
        }
        db.get_plugin(plugin_id)?;
        let plugin_dir = ensure_plugins_dir(data_dir)?.join(plugin_id);
        let asset_path = plugin_dir.join(relative_path);
        if !asset_path.is_file() {
            return Err(AppError::NotFound(format!(
                "插件资源不存在: {}",
                relative_path
            )));
        }
        Ok(fs::read_to_string(asset_path)?)
    }

    fn read_valid_manifest(plugin_dir: &Path) -> Result<PluginManifest, AppError> {
        let path = plugin_dir.join(MANIFEST_FILE);
        let content = fs::read_to_string(&path).map_err(|e| {
            AppError::Custom(format!("读取 {} 失败: {}", path.display(), e))
        })?;
        let manifest: PluginManifest = serde_json::from_str(&content)?;
        validate_manifest(&manifest)?;
        Ok(manifest)
    }
}

fn resolve_plugin_zip(zip_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(zip_path);
    if !path.is_file() {
        return Err(AppError::InvalidInput("插件包必须是 zip 文件".into()));
    }
    let is_zip = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);
    if !is_zip {
        return Err(AppError::InvalidInput("插件包必须是 .zip 文件".into()));
    }
    Ok(path)
}

fn count_files(root: &Path) -> Result<usize, AppError> {
    let mut count = 0;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_file() {
            count += 1;
        } else if ty.is_dir() {
            count += count_files(&entry.path())?;
        }
    }
    Ok(count)
}

fn dir_size(root: &Path) -> Result<u64, AppError> {
    let mut total = 0u64;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_file() {
            total = total.saturating_add(entry.metadata()?.len());
        } else if ty.is_dir() {
            total = total.saturating_add(dir_size(&entry.path())?);
        }
    }
    Ok(total)
}

/// 定位解压后的插件根目录：支持 `plugin.json` 直接在 zip 根目录，
/// 或 zip 内只有一层插件文件夹（常见于压缩文件夹的场景）。
fn find_manifest_root(temp_root: &Path) -> Result<PathBuf, AppError> {
    if temp_root.join(MANIFEST_FILE).is_file() {
        return Ok(temp_root.to_path_buf());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(temp_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if entry.path().join(MANIFEST_FILE).is_file() {
            candidates.push(entry.path());
        }
    }
    if candidates.len() != 1 {
        return Err(AppError::InvalidInput(
            "插件包根目录缺少 plugin.json（或存在多个候选目录）".into(),
        ));
    }
    Ok(candidates.remove(0))
}

fn ensure_plugins_dir(data_dir: &Path) -> Result<PathBuf, AppError> {
    let dir = data_dir.join("plugins");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 插件设置备份目录：放在 plugins 之外，避免被插件扫描器当作插件目录。
fn plugin_data_backup_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("plugin-data-backups")
}

fn backup_plugin_settings(
    db: &Database,
    data_dir: &Path,
    plugin_id: &str,
) -> Result<(), AppError> {
    let settings = db.get_plugin_settings(plugin_id)?;
    if settings.is_empty() {
        return Ok(());
    }
    let dir = plugin_data_backup_dir(data_dir);
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{plugin_id}.json"));
    fs::write(&path, serde_json::to_vec_pretty(&settings)?)?;
    Ok(())
}

fn restore_plugin_settings(
    db: &Database,
    data_dir: &Path,
    plugin_id: &str,
) -> Result<(), AppError> {
    let path = plugin_data_backup_dir(data_dir).join(format!("{plugin_id}.json"));
    if !path.is_file() {
        return Ok(());
    }
    let bytes = fs::read(&path)?;
    let settings: HashMap<String, serde_json::Value> = serde_json::from_slice(&bytes)?;
    if settings.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    db.set_plugin_settings(plugin_id, &settings)?;
    let _ = fs::remove_file(&path);
    Ok(())
}

fn validate_manifest(manifest: &PluginManifest) -> Result<(), AppError> {
    validate_plugin_id(&manifest.id)?;
    if manifest.name.trim().is_empty() {
        return Err(AppError::InvalidInput("插件名称不能为空".into()));
    }
    if !is_safe_version(&manifest.version) {
        return Err(AppError::InvalidInput(
            "插件版本只能包含字母、数字、点、连字符和加号（长度 1-32）".into(),
        ));
    }
    if !is_safe_relative_path(&manifest.main) {
        return Err(AppError::InvalidInput("插件 main 路径非法".into()));
    }
    if let Some(styles) = &manifest.styles {
        if !is_safe_relative_path(styles) {
            return Err(AppError::InvalidInput("插件 styles 路径非法".into()));
        }
    }
    validate_permissions(&manifest.permissions)?;
    for command in &manifest.contributes.commands {
        if command.id.trim().is_empty() || command.title.trim().is_empty() {
            return Err(AppError::InvalidInput("插件命令 id/title 不能为空".into()));
        }
    }
    for view in &manifest.contributes.sidebar_views {
        if view.id.trim().is_empty() || view.title.trim().is_empty() {
            return Err(AppError::InvalidInput("插件视图 id/title 不能为空".into()));
        }
    }
    Ok(())
}

fn validate_plugin_id(plugin_id: &str) -> Result<(), AppError> {
    if plugin_id.is_empty() || plugin_id.len() > 64 {
        return Err(AppError::InvalidInput("插件 ID 长度非法".into()));
    }
    if !plugin_id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(AppError::InvalidInput(
            "插件 ID 只能包含小写字母、数字和连字符".into(),
        ));
    }
    Ok(())
}

fn validate_permissions(permissions: &[String]) -> Result<(), AppError> {
    for permission in permissions {
        if !VALID_PERMISSIONS.contains(&permission.as_str()) {
            return Err(AppError::InvalidInput(format!(
                "未知插件权限: {}",
                permission
            )));
        }
    }
    Ok(())
}

fn ensure_permissions_declared(
    plugin: &PluginInfo,
    permissions: &[String],
) -> Result<(), AppError> {
    for permission in permissions {
        if !plugin.permissions.contains(permission) {
            return Err(AppError::InvalidInput(format!(
                "插件 {} 未声明权限 {}",
                plugin.id, permission
            )));
        }
    }
    Ok(())
}

fn is_safe_relative_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let path = Path::new(trimmed);
    !path.is_absolute()
        && path
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

fn ensure_declared_main_exists(plugin_dir: &Path, manifest: &PluginManifest) -> Result<(), AppError> {
    let main = plugin_dir.join(&manifest.main);
    if !main.is_file() {
        return Err(AppError::InvalidInput(format!(
            "插件入口文件不存在: {}",
            manifest.main
        )));
    }
    if let Some(styles) = &manifest.styles {
        let styles_path = plugin_dir.join(styles);
        if !styles_path.is_file() {
            return Err(AppError::InvalidInput(format!(
                "插件样式文件不存在: {}",
                styles
            )));
        }
    }
    Ok(())
}

fn compare_versions(left: &str, right: &str) -> i32 {
    let a = parse_version(left);
    let b = parse_version(right);
    for i in 0..3 {
        let l = a.get(i).copied().unwrap_or(0);
        let r = b.get(i).copied().unwrap_or(0);
        if l > r {
            return 1;
        }
        if l < r {
            return -1;
        }
    }
    0
}

fn parse_version(value: &str) -> Vec<u64> {
    value
        .split(['.', '-', '+'])
        .take(3)
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn copy_plugin_dir(source: &Path, dest: &Path) -> Result<(), AppError> {
    copy_dir_excluding(source, dest, &[])
}

/// 复制目录，跳过指定的顶层条目（用于归档时不把 versions/ 递归复制进去）。
fn copy_dir_excluding(source: &Path, dest: &Path, skip: &[&str]) -> Result<(), AppError> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if skip.iter().any(|s| *s == name) {
            continue;
        }
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            return Err(AppError::InvalidInput(format!(
                "插件目录不允许包含符号链接: {}",
                entry.path().display()
            )));
        }
        let target = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_excluding(&entry.path(), &target, &[])?;
        } else if ty.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// 校验插件已安装文件：优先整目录哈希，旧数据退化为入口哈希。
fn verify_plugin_files(plugin: &PluginInfo) -> Result<(), AppError> {
    if plugin.path.is_empty() {
        return Ok(());
    }
    let dir = PathBuf::from(&plugin.path);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!(
            "插件目录不存在: {}",
            plugin.path
        )));
    }
    if !plugin.package_hash.is_empty() {
        plugin_integrity::verify_dir(&dir, &plugin.package_hash)?;
    } else if !plugin.content_hash.is_empty() {
        let actual = compute_main_hash(&dir, &plugin.main)?;
        if actual != plugin.content_hash {
            return Err(AppError::InvalidInput(format!(
                "插件 {} 入口文件已被篡改，拒绝启用",
                plugin.id
            )));
        }
    }
    Ok(())
}

/// 把当前 live 目录归档到 `versions/<version>`（不递归 versions/）。
fn archive_current_version(live: &Path, version: &str) -> Result<(), AppError> {
    if !live.is_dir() {
        return Ok(());
    }
    let versions_dir = live.join(VERSIONS_DIR);
    fs::create_dir_all(&versions_dir)?;
    let target = versions_dir.join(version);
    if target.exists() {
        fs::remove_dir_all(&target)?;
    }
    copy_dir_excluding(live, &target, &[VERSIONS_DIR])
}

/// 清空 live 目录内容，但保留 versions/ 归档。
fn clear_live_dir(live: &Path) -> Result<(), AppError> {
    if !live.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(live)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy() == VERSIONS_DIR {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

/// 移动目录：优先 rename，跨盘失败时退化为复制后删除。
fn move_dir(source: &Path, dest: &Path) -> Result<(), AppError> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(source, dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_plugin_dir(source, dest)?;
            fs::remove_dir_all(source)?;
            Ok(())
        }
    }
}

fn is_safe_version(version: &str) -> bool {
    let trimmed = version.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 32
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pom-plugin-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_plugin_zip(dir: &Path, prefix: &str, manifest: &str) -> PathBuf {
        let zip_path = dir.join("plugin.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file(format!("{prefix}plugin.json"), options).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file(format!("{prefix}main.js"), options).unwrap();
        zip.write_all(b"module.exports = { onLoad: function() {} };").unwrap();
        zip.finish().unwrap();
        zip_path
    }

    const DEMO_MANIFEST: &str = r#"{"id":"demo-plugin","name":"Demo","version":"1.0.0","main":"main.js"}"#;

    #[test]
    fn find_manifest_root_supports_flat_and_nested() {
        let flat = temp_dir("flat");
        fs::write(flat.join(MANIFEST_FILE), DEMO_MANIFEST).unwrap();
        assert_eq!(find_manifest_root(&flat).unwrap(), flat);

        let nested = temp_dir("nested");
        let inner = nested.join("demo-plugin");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join(MANIFEST_FILE), DEMO_MANIFEST).unwrap();
        assert_eq!(find_manifest_root(&nested).unwrap(), inner);

        let _ = fs::remove_dir_all(&flat);
        let _ = fs::remove_dir_all(&nested);
    }

    #[test]
    fn find_manifest_root_rejects_multiple_candidates() {
        let root = temp_dir("multi");
        for name in ["a", "b"] {
            let inner = root.join(name);
            fs::create_dir_all(&inner).unwrap();
            fs::write(inner.join(MANIFEST_FILE), DEMO_MANIFEST).unwrap();
        }
        assert!(find_manifest_root(&root).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_zip_reads_manifest_and_counts_files() {
        let data_dir = temp_dir("data");
        let zip_path = write_plugin_zip(&data_dir, "", DEMO_MANIFEST);

        let inspection = PluginService::inspect_zip(&data_dir, zip_path.to_str().unwrap()).unwrap();
        assert_eq!(inspection.manifest.id, "demo-plugin");
        assert_eq!(inspection.file_count, 2);
        assert!(inspection.uncompressed_bytes > 0);

        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn inspect_zip_accepts_single_nested_folder() {
        let data_dir = temp_dir("data-nested");
        let zip_path = write_plugin_zip(&data_dir, "demo-plugin/", DEMO_MANIFEST);

        let inspection = PluginService::inspect_zip(&data_dir, zip_path.to_str().unwrap()).unwrap();
        assert_eq!(inspection.manifest.id, "demo-plugin");

        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn inspect_zip_rejects_missing_manifest() {
        let data_dir = temp_dir("data-bad");
        let zip_path = data_dir.join("bad.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("main.js", options).unwrap();
        zip.write_all(b"module.exports = {};").unwrap();
        zip.finish().unwrap();

        assert!(PluginService::inspect_zip(&data_dir, zip_path.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&data_dir);
    }

    // ─── A/B/C 生命周期用例 ──────────────────────

    fn make_plugin(
        root: &Path,
        id: &str,
        version: &str,
        permissions: &[&str],
        author: Option<&str>,
    ) -> PathBuf {
        let dir = root.join(format!("src-{id}-{version}"));
        fs::create_dir_all(dir.join("assets")).unwrap();
        let perms = permissions
            .iter()
            .map(|p| format!("\"{p}\""))
            .collect::<Vec<_>>()
            .join(",");
        let author_json = author
            .map(|a| format!("\"{a}\""))
            .unwrap_or_else(|| "null".to_string());
        let manifest = format!(
            r#"{{"id":"{id}","name":"Demo","version":"{version}","main":"main.js","author":{author_json},"permissions":[{perms}]}}"#
        );
        fs::write(dir.join(MANIFEST_FILE), manifest).unwrap();
        fs::write(dir.join("main.js"), format!("// main {version}")).unwrap();
        fs::write(dir.join("assets/data.txt"), version).unwrap();
        dir
    }

    fn setup() -> (Database, PathBuf) {
        let db = Database::init(":memory:").expect("内存数据库");
        let data_dir = temp_dir("lifecycle");
        (db, data_dir)
    }

    #[test]
    fn enable_bumps_generation_and_invalidates_sessions() {
        let (db, data) = setup();
        let tokens = PluginTokenRegistry::default();
        let src = make_plugin(&data, "demo", "1.0.0", &[], None);
        PluginService::install_from_dir(&db, &data, src.to_str().unwrap()).unwrap();

        PluginService::enable(&db, &tokens, "demo").unwrap();
        let gen1 = db.get_activation_generation("demo").unwrap();
        let (_token, _session) = tokens.acquire("demo", gen1).unwrap();
        assert_eq!(tokens.session_count("demo").unwrap(), 1);

        PluginService::enable(&db, &tokens, "demo").unwrap();
        let gen2 = db.get_activation_generation("demo").unwrap();
        assert!(gen2 > gen1, "再次启用必须递增代际");
        assert_eq!(tokens.session_count("demo").unwrap(), 0, "旧会话必须失效");

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn disable_closes_gate_and_revokes_sessions() {
        let (db, data) = setup();
        let tokens = PluginTokenRegistry::default();
        let src = make_plugin(&data, "demo", "1.0.0", &[], None);
        PluginService::install_from_dir(&db, &data, src.to_str().unwrap()).unwrap();
        PluginService::enable(&db, &tokens, "demo").unwrap();
        let generation = db.get_activation_generation("demo").unwrap();
        tokens.acquire("demo", generation).unwrap();

        PluginService::disable(&db, &tokens, "demo").unwrap();
        assert!(!db.get_plugin("demo").unwrap().enabled);
        assert_eq!(tokens.session_count("demo").unwrap(), 0);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn update_archives_previous_version_and_keeps_enabled() {
        let (db, data) = setup();
        let tokens = PluginTokenRegistry::default();
        let v1 = make_plugin(&data, "demo", "1.0.0", &[], None);
        PluginService::install_from_dir(&db, &data, v1.to_str().unwrap()).unwrap();
        PluginService::enable(&db, &tokens, "demo").unwrap();

        let v2 = make_plugin(&data, "demo", "1.1.0", &[], None);
        let info = PluginService::install_from_dir(&db, &data, v2.to_str().unwrap()).unwrap();
        assert_eq!(info.version, "1.1.0");
        assert!(info.enabled, "更新不应丢失启用状态");
        assert!(
            data.join("plugins/demo").join(VERSIONS_DIR).join("1.0.0").is_dir(),
            "旧版本必须归档以支持回滚"
        );
        let versions = PluginService::list_versions(&db, &data, "demo").unwrap();
        assert_eq!(versions.len(), 2);
        assert!(versions.iter().any(|v| v.is_current && v.version == "1.1.0"));
        assert!(versions.iter().any(|v| v.archived && v.version == "1.0.0"));
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn rejects_same_version_and_downgrade() {
        let (db, data) = setup();
        let v1 = make_plugin(&data, "demo", "1.0.0", &[], None);
        PluginService::install_from_dir(&db, &data, v1.to_str().unwrap()).unwrap();

        let same = make_plugin(&data, "demo", "1.0.0", &[], None);
        assert!(PluginService::install_from_dir(&db, &data, same.to_str().unwrap()).is_err());

        let older = make_plugin(&data, "demo", "0.9.0", &[], None);
        assert!(PluginService::install_from_dir(&db, &data, older.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn rollback_requires_disabled_and_restores_files() {
        let (db, data) = setup();
        let tokens = PluginTokenRegistry::default();
        let v1 = make_plugin(&data, "demo", "1.0.0", &[], None);
        PluginService::install_from_dir(&db, &data, v1.to_str().unwrap()).unwrap();
        let v2 = make_plugin(&data, "demo", "1.1.0", &[], None);
        PluginService::install_from_dir(&db, &data, v2.to_str().unwrap()).unwrap();
        PluginService::enable(&db, &tokens, "demo").unwrap();

        assert!(PluginService::rollback(&db, &data, "demo", "1.0.0").is_err(), "启用状态禁止回滚");

        PluginService::disable(&db, &tokens, "demo").unwrap();
        let info = PluginService::rollback(&db, &data, "demo", "1.0.0").unwrap();
        assert_eq!(info.version, "1.0.0");
        let main = fs::read_to_string(data.join("plugins/demo/main.js")).unwrap();
        assert!(main.contains("1.0.0"));
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn uninstall_quarantines_and_restore_recovers_settings() {
        let (db, data) = setup();
        let tokens = PluginTokenRegistry::default();
        let src = make_plugin(&data, "demo", "1.0.0", &[], None);
        PluginService::install_from_dir(&db, &data, src.to_str().unwrap()).unwrap();
        db.set_plugin_setting(
            "demo",
            "theme",
            &serde_json::Value::String("dark".into()),
        )
        .unwrap();

        assert!(PluginService::uninstall(&db, &data, &tokens, "demo").unwrap());
        assert!(db.get_plugin("demo").is_err());
        assert!(!data.join("plugins/demo").exists(), "目录应移入隔离区");
        assert_eq!(PluginService::list_quarantined(&db).unwrap().len(), 1);

        let info = PluginService::restore_quarantined(&db, &data, "demo").unwrap();
        assert_eq!(info.version, "1.0.0");
        assert!(data.join("plugins/demo/main.js").is_file());
        assert_eq!(
            db.get_plugin_setting("demo", "theme").unwrap(),
            Some(serde_json::Value::String("dark".into()))
        );
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn authorization_follows_version_and_requires_grant() {
        let (db, data) = setup();
        let tokens = PluginTokenRegistry::default();
        let v1 = make_plugin(&data, "demo", "1.0.0", &["notes:read"], None);
        PluginService::install_from_dir(&db, &data, v1.to_str().unwrap()).unwrap();
        assert!(!db.has_plugin_authorization("demo", "notes:read").unwrap());

        PluginService::grant_permissions(&db, "demo", vec!["notes:read".into()]).unwrap();
        assert!(db.has_plugin_authorization("demo", "notes:read").unwrap());

        // 升级后仍声明该能力 → 授权事实跟随版本，不失效
        let v2 = make_plugin(&data, "demo", "1.1.0", &["notes:read", "notes:write"], None);
        PluginService::install_from_dir(&db, &data, v2.to_str().unwrap()).unwrap();
        assert!(db.has_plugin_authorization("demo", "notes:read").unwrap());
        // 新增能力未授权 → 拒绝
        assert!(!db.has_plugin_authorization("demo", "notes:write").unwrap());
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn tampered_non_entry_file_blocks_enable() {
        let (db, data) = setup();
        let tokens = PluginTokenRegistry::default();
        let src = make_plugin(&data, "demo", "1.0.0", &[], None);
        PluginService::install_from_dir(&db, &data, src.to_str().unwrap()).unwrap();

        fs::write(data.join("plugins/demo/assets/data.txt"), "tampered").unwrap();
        assert!(
            PluginService::enable(&db, &tokens, "demo").is_err(),
            "非入口文件被篡改也必须拒绝启用"
        );
        let _ = fs::remove_dir_all(&data);
    }
}
