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
use crate::models::{PluginInfo, PluginManifest};
use crate::services::safe_archive;

const MANIFEST_FILE: &str = "plugin.json";

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
            let dir = entry.path();
            match Self::read_valid_manifest(&dir).and_then(|manifest| {
                ensure_declared_main_exists(&dir, &manifest)?;
                let path = dir.to_string_lossy().to_string();
                let hash = compute_main_hash(&dir, &manifest.main)?;
                db.upsert_plugin(&manifest, &path, &hash)
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
        Self::install_prepared_source(db, data_dir, &source, manifest)
    }

    /// 从 zip 压缩包安装插件。解压到临时目录校验后复制到 app data/plugins/<plugin-id>。
    pub fn install_from_zip(
        db: &Database,
        data_dir: &Path,
        zip_path: &str,
    ) -> Result<PluginInfo, AppError> {
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
            Self::install_prepared_source(db, data_dir, &source, manifest)
        })();

        let _ = fs::remove_dir_all(&temp_root);
        result
    }

    /// 已校验过的插件源目录 → 复制到 app data/plugins/<id> 并写入数据库。
    fn install_prepared_source(
        db: &Database,
        data_dir: &Path,
        source: &Path,
        manifest: PluginManifest,
    ) -> Result<PluginInfo, AppError> {
        let plugins_dir = ensure_plugins_dir(data_dir)?;
        let dest = plugins_dir.join(&manifest.id);
        if dest.exists() {
            return Err(AppError::InvalidInput(format!(
                "插件 {} 已存在，请先卸载后再安装",
                manifest.id
            )));
        }

        copy_plugin_dir(source, &dest)?;
        let installed_manifest = Self::read_valid_manifest(&dest)?;
        ensure_declared_main_exists(&dest, &installed_manifest)?;
        let installed_path = dest.to_string_lossy().to_string();
        let hash = compute_main_hash(&dest, &installed_manifest.main)?;
        let info = db.upsert_plugin(&installed_manifest, &installed_path, &hash)?;
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
        let info = db.upsert_plugin(&installed_manifest, &installed_path, &hash)?;
        if existing.is_none() {
            // 首次内置安装默认启用；升级时保留用户原有开关状态。
            db.set_plugin_enabled(plugin_id, true)?;
            return Ok(Some(db.get_plugin(plugin_id)?));
        }
        Ok(Some(info))
    }

    /// 启用插件。当前阶段只记录状态，不执行第三方代码。
    pub fn enable(db: &Database, plugin_id: &str) -> Result<(), AppError> {
        validate_plugin_id(plugin_id)?;
        db.set_plugin_enabled(plugin_id, true)
    }

    /// 禁用插件。当前阶段只记录状态，不执行第三方代码。
    pub fn disable(db: &Database, plugin_id: &str) -> Result<(), AppError> {
        validate_plugin_id(plugin_id)?;
        db.set_plugin_enabled(plugin_id, false)
    }

    /// 卸载插件：删除 app data/plugins/<plugin-id> 并移除数据库记录
    ///
    /// plugin_settings 通过外键级联删除；卸载前先把设置备份到
    /// `<data_dir>/plugin-data-backups/<plugin-id>.json`，重装时自动恢复。
    pub fn uninstall(db: &Database, data_dir: &Path, plugin_id: &str) -> Result<bool, AppError> {
        validate_plugin_id(plugin_id)?;
        match backup_plugin_settings(db, data_dir, plugin_id) {
            Ok(()) => {}
            Err(AppError::NotFound(_)) => {}
            Err(error) => return Err(error),
        }
        let plugin_dir = ensure_plugins_dir(data_dir)?.join(plugin_id);
        if plugin_dir.exists() {
            fs::remove_dir_all(&plugin_dir)?;
        }
        // 内置插件被用户主动卸载后，下次启动不再自动装回。
        if BUNDLED_PLUGINS.contains(&plugin_id) {
            db.set_config(&bundled_dismissed_key(plugin_id), "1")?;
        }
        db.delete_plugin(plugin_id)
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
        db.grant_plugin_permissions(plugin_id, &permissions)
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
        db.revoke_plugin_permissions(plugin_id, &permissions)
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
    if manifest.version.trim().is_empty() {
        return Err(AppError::InvalidInput("插件版本不能为空".into()));
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
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            return Err(AppError::InvalidInput(format!(
                "插件目录不允许包含符号链接: {}",
                entry.path().display()
            )));
        }
        let target = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_plugin_dir(&entry.path(), &target)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
