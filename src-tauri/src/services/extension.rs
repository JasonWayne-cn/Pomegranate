//! 功能扩展包（Engine Pack）安装、校验与启停。
//!
//! 设计原则：
//! - 仅支持本地 zip 导入；
//! - 包内资源只读，业务数据写到 `app_data/ppt-workspace`；
//! - 安装前完整预检（路径穿越、大小、版本、平台、入口文件）；
//! - 安装后按内容哈希校验完整性。

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::database::Database;
use crate::error::AppError;
use crate::models::extension::{
    ExtensionInspection, ExtensionInfo, ExtensionManifest,
};

const MAX_UNCOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILE_COUNT: usize = 20_000;
const MANIFEST_NAME: &str = "extension.json";

pub struct ExtensionService;

impl ExtensionService {
    pub fn extensions_dir(data_dir: &Path) -> PathBuf {
        data_dir.join("extensions")
    }

    fn ensure_extensions_dir(data_dir: &Path) -> Result<PathBuf, AppError> {
        let dir = Self::extensions_dir(data_dir);
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    pub fn list(db: &Database) -> Result<Vec<ExtensionInfo>, AppError> {
        db.list_extensions()
    }

    pub fn get(db: &Database, id: &str) -> Result<ExtensionInfo, AppError> {
        db.get_extension(id)?
            .ok_or_else(|| AppError::NotFound(format!("扩展包 {} 未安装", id)))
    }

    /// 预检 zip：解压到临时目录，校验清单与资源，随后清理。
    pub fn inspect_zip(data_dir: &Path, zip_path: &str) -> Result<ExtensionInspection, AppError> {
        let (outer, _root, inspection) = Self::extract_and_inspect(data_dir, zip_path)?;
        let _ = fs::remove_dir_all(&outer);
        Ok(inspection)
    }

    /// 安装 zip。安装到 `app_data/extensions/<id>/versions/<version>/`。
    pub fn install_zip(
        db: &Database,
        data_dir: &Path,
        zip_path: &str,
    ) -> Result<ExtensionInfo, AppError> {
        let (outer, manifest_root, inspection) = Self::extract_and_inspect(data_dir, zip_path)?;

        let result = (|| -> Result<ExtensionInfo, AppError> {
            if !inspection.compatible {
                return Err(AppError::InvalidInput(
                    inspection
                        .reason
                        .clone()
                        .unwrap_or_else(|| "扩展包与当前应用不兼容".into()),
                ));
            }
            let id = inspection.manifest.id.clone();
            let version = inspection.manifest.version.clone();
            let ext_root = Self::ensure_extensions_dir(data_dir)?.join(&id);
            let versions_dir = ext_root.join("versions");
            fs::create_dir_all(&versions_dir)?;
            let dest = versions_dir.join(&version);
            if dest.exists() {
                return Err(AppError::InvalidInput(format!(
                    "扩展包 {} v{} 已安装",
                    id, version
                )));
            }

            // 临时目录可能包含一层外层目录；把清单所在目录整体移动到版本目录。
            move_dir_contents(&manifest_root, &dest)?;

            let current = json!({ "id": id, "version": version });
            fs::write(
                ext_root.join("current.json"),
                serde_json::to_vec_pretty(&current)?,
            )?;

            let supports_ppt = supports_ppt(&inspection.manifest);
            let info = db.upsert_extension(
                &inspection.manifest,
                &dest.to_string_lossy(),
                &inspection.content_hash,
                supports_ppt,
            )?;
            db.add_extension_version(&id, &version, &dest.to_string_lossy(), &inspection.content_hash)?;
            Ok(info)
        })();

        let _ = fs::remove_dir_all(&outer);
        result
    }

    pub fn set_enabled(db: &Database, id: &str, enabled: bool) -> Result<(), AppError> {
        db.set_extension_enabled(id, enabled)
    }

    pub fn list_versions(
        db: &Database,
        id: &str,
    ) -> Result<Vec<crate::models::extension::ExtensionVersionInfo>, AppError> {
        db.list_extension_versions(id)
    }

    /// 切换到已安装的其他版本（离线回滚）。
    pub fn rollback(
        db: &Database,
        data_dir: &Path,
        id: &str,
        version: &str,
    ) -> Result<ExtensionInfo, AppError> {
        validate_plugin_id(id)?;
        let versions = db.list_extension_versions(id)?;
        let target = versions
            .into_iter()
            .find(|item| item.version == version)
            .ok_or_else(|| AppError::NotFound(format!("扩展 {} 未安装版本 {}", id, version)))?;
        let root = PathBuf::from(&target.path);
        let manifest_path = root.join(MANIFEST_NAME);
        let manifest = read_manifest(&manifest_path)?;
        validate_manifest(&root, &manifest)?;
        verify_integrity(&root, &manifest)?;

        let info = db.upsert_extension(
            &manifest,
            &target.path,
            &target.content_hash,
            supports_ppt(&manifest),
        )?;
        db.add_extension_version(id, version, &target.path, &target.content_hash)?;
        let current = json!({ "id": id, "version": version });
        fs::write(
            Self::ensure_extensions_dir(data_dir)?
                .join(id)
                .join("current.json"),
            serde_json::to_vec_pretty(&current)?,
        )?;
        Ok(info)
    }

    pub fn uninstall(db: &Database, data_dir: &Path, id: &str) -> Result<bool, AppError> {
        validate_plugin_id(id)?;
        let dir = Self::ensure_extensions_dir(data_dir)?.join(id);
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        db.delete_extension(id)
    }

    /// 校验已安装扩展的内容哈希。
    pub fn verify(db: &Database, id: &str) -> Result<bool, AppError> {
        let info = Self::get(db, id)?;
        let hash = compute_dir_hash(Path::new(&info.path))?;
        Ok(hash == info.content_hash)
    }

    /// 读取扩展包内文本资源（限定在包目录内）。
    pub fn read_text_asset(db: &Database, id: &str, relative: &str) -> Result<String, AppError> {
        let info = Self::get(db, id)?;
        let base = fs::canonicalize(&info.path)?;
        let target = safe_join(&base, relative)?;
        let canonical = fs::canonicalize(&target)?;
        if !canonical.starts_with(&base) {
            return Err(AppError::InvalidInput("资源路径越界".into()));
        }
        let metadata = fs::metadata(&canonical)?;
        if metadata.len() > 2 * 1024 * 1024 {
            return Err(AppError::InvalidInput("资源文件过大".into()));
        }
        Ok(fs::read_to_string(canonical)?)
    }

    /// 读取 PPT 模板索引（layouts / charts）。
    pub fn ppt_catalog(db: &Database, id: &str) -> Result<Value, AppError> {
        let info = Self::get(db, id)?;
        if !info.supports_ppt {
            return Err(AppError::InvalidInput("该扩展包不提供 PPT 引擎".into()));
        }
        let base = PathBuf::from(&info.path);
        let (layouts_path, charts_path) = catalog_paths(&info.manifest);
        let layouts_file = base.join(&layouts_path);
        let layouts = read_json_optional(&layouts_file)?;
        let charts = read_json_optional(&base.join(charts_path))?;
        let layout_support = layout_support(Some(&layouts));
        Ok(json!({
            "extensionId": info.id,
            "extensionVersion": info.version,
            "layouts": layouts,
            "charts": charts,
            "layoutSupport": layout_support,
        }))
    }

    /// 读取版式封面 SVG，供风格确认阶段预览。
    /// 只允许读取 layouts 索引目录下的 `<layout_id>`，不接受任意路径。
    pub fn ppt_layout_preview(
        db: &Database,
        id: &str,
        layout_id: &str,
    ) -> Result<String, AppError> {
        let info = Self::get(db, id)?;
        if !info.supports_ppt {
            return Err(AppError::InvalidInput("该扩展包不提供 PPT 引擎".into()));
        }
        let layout_id = layout_id.trim();
        if layout_id.is_empty()
            || layout_id.contains('/')
            || layout_id.contains('\\')
            || layout_id.contains("..")
        {
            return Err(AppError::InvalidInput("版式 id 无效".into()));
        }

        let base = fs::canonicalize(&info.path)?;
        let (layouts_path, _) = catalog_paths(&info.manifest);
        let index_file = base.join(&layouts_path);
        let layouts_root = index_file
            .parent()
            .ok_or_else(|| AppError::InvalidInput("版式索引路径无效".into()))?;
        let layouts_root = fs::canonicalize(layouts_root)?;
        if !layouts_root.starts_with(&base) {
            return Err(AppError::InvalidInput("版式目录越界".into()));
        }

        let layout_dir = fs::canonicalize(layouts_root.join(layout_id))?;
        if !layout_dir.starts_with(&layouts_root) || !layout_dir.is_dir() {
            return Err(AppError::NotFound(format!("版式不存在: {}", layout_id)));
        }
        let templates_dir = if layout_dir.join("templates").is_dir() {
            layout_dir.join("templates")
        } else {
            layout_dir
        };
        let templates_dir = fs::canonicalize(templates_dir)?;
        if !templates_dir.starts_with(&layouts_root) {
            return Err(AppError::InvalidInput("版式模板目录越界".into()));
        }

        let mut svgs: Vec<PathBuf> = fs::read_dir(&templates_dir)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.is_file()
                    && path
                        .extension()
                        .and_then(|value| value.to_str())
                        .map(|value| value.eq_ignore_ascii_case("svg"))
                        .unwrap_or(false)
            })
            .collect();
        if svgs.is_empty() {
            return Err(AppError::NotFound(format!(
                "版式 {} 没有可预览的 SVG",
                layout_id
            )));
        }
        svgs.sort();
        let cover = svgs
            .iter()
            .find(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .map(|name| name.to_ascii_lowercase().contains("cover"))
                    .unwrap_or(false)
            })
            .or_else(|| svgs.first())
            .cloned()
            .ok_or_else(|| AppError::NotFound("未找到封面 SVG".into()))?;

        let canonical = fs::canonicalize(cover)?;
        if !canonical.starts_with(&templates_dir) {
            return Err(AppError::InvalidInput("封面路径越界".into()));
        }
        let metadata = fs::metadata(&canonical)?;
        if metadata.len() > 4 * 1024 * 1024 {
            return Err(AppError::InvalidInput("封面 SVG 文件过大".into()));
        }
        Ok(fs::read_to_string(canonical)?)
    }

    fn extract_and_inspect(
        data_dir: &Path,
        zip_path: &str,
    ) -> Result<(PathBuf, PathBuf, ExtensionInspection), AppError> {
        let path = PathBuf::from(zip_path);
        if !path.is_file() {
            return Err(AppError::InvalidInput("扩展包必须是 zip 文件".into()));
        }
        let temp_root = Self::ensure_extensions_dir(data_dir)?
            .join(format!(".tmp-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root)?;

        let extract_result = extract_zip_safely(&path, &temp_root);
        if let Err(err) = extract_result {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(err);
        }

        let (manifest_root, manifest) = match find_manifest_root(&temp_root) {
            Ok(value) => value,
            Err(err) => {
                let _ = fs::remove_dir_all(&temp_root);
                return Err(err);
            }
        };

        validate_manifest(&manifest_root, &manifest)?;
        verify_integrity(&manifest_root, &manifest)?;

        let file_count = count_files(&manifest_root)?;
        let uncompressed_bytes = dir_size(&manifest_root)?;
        if file_count > MAX_FILE_COUNT {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(AppError::InvalidInput(format!(
                "扩展包文件过多（{} > {}）",
                file_count, MAX_FILE_COUNT
            )));
        }
        if uncompressed_bytes > MAX_UNCOMPRESSED_BYTES {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(AppError::InvalidInput("扩展包解压体积过大".into()));
        }

        let content_hash = compute_dir_hash(&manifest_root)?;
        let (compatible, reason) = compatibility(&manifest);

        let inspection = ExtensionInspection {
            manifest,
            compatible,
            reason,
            file_count,
            uncompressed_bytes,
            content_hash,
            root_prefix: if manifest_root == temp_root {
                None
            } else {
                manifest_root
                    .strip_prefix(&temp_root)
                    .ok()
                    .map(|p| p.to_string_lossy().to_string())
            },
        };

        // 返回外层临时目录（用于清理）与清单所在目录（用于安装）。
        Ok((temp_root, manifest_root, inspection))
    }
}

fn catalog_paths(manifest: &ExtensionManifest) -> (String, String) {
    let ppt = manifest.contributes.get("ppt");
    let layouts = ppt
        .and_then(|v| v.get("layoutsIndex"))
        .and_then(|v| v.as_str())
        .unwrap_or("templates/layouts/layouts_index.json")
        .to_string();
    let charts = ppt
        .and_then(|v| v.get("chartsIndex"))
        .and_then(|v| v.as_str())
        .unwrap_or("templates/charts/charts_index.json")
        .to_string();
    (layouts, charts)
}

fn supports_ppt(manifest: &ExtensionManifest) -> bool {
    manifest.kind.contains("ppt") || manifest.contributes.get("ppt").is_some()
}

/// 从构建期写入的索引字段生成版式支持度，避免运行时扫描所有 SVG。
fn layout_support(layouts: Option<&Value>) -> Value {
    let Some(layouts) = layouts.and_then(Value::as_object) else {
        return json!({});
    };
    let mut result = serde_json::Map::new();
    for (id, meta) in layouts {
        let structured = meta.get("structured").and_then(Value::as_u64).unwrap_or(0);
        let legacy = meta.get("legacy").and_then(Value::as_u64).unwrap_or(0);
        let page_count = meta
            .get("page_count")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                meta.get("page_types")
                    .and_then(Value::as_array)
                    .map(|items| items.len() as u64)
                    .unwrap_or(0)
            });
        let page_types = meta
            .get("page_types")
            .cloned()
            .unwrap_or_else(|| json!([]));
        result.insert(
            id.clone(),
            json!({
                "pageCount": page_count,
                "pageTypes": page_types,
                "structured": structured,
                "legacy": legacy,
                "supportsStructured": meta
                    .get("supportsStructured")
                    .and_then(Value::as_bool)
                    .unwrap_or(structured > 0),
                "supportsLegacy": meta
                    .get("supportsLegacy")
                    .and_then(Value::as_bool)
                    .unwrap_or(legacy > 0),
            }),
        );
    }
    Value::Object(result)
}

fn read_json_optional(path: &Path) -> Result<Value, AppError> {
    if !path.is_file() {
        return Ok(Value::Null);
    }
    let text = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&text)?)
}

fn extract_zip_safely(zip_path: &Path, dest: &Path) -> Result<(), AppError> {
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut total: u64 = 0;
    let mut count = 0usize;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let enclosed = entry
            .enclosed_name()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| AppError::InvalidInput(format!("zip 条目路径非法: {}", entry.name())))?;

        if enclosed.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
            return Err(AppError::InvalidInput(format!(
                "zip 条目包含非法路径: {}",
                enclosed.display()
            )));
        }

        if let Some(mode) = entry.unix_mode() {
            // 0o120000 = symlink
            if mode & 0o170000 == 0o120000 {
                return Err(AppError::InvalidInput(format!(
                    "不允许符号链接: {}",
                    enclosed.display()
                )));
            }
        }

        count += 1;
        if count > MAX_FILE_COUNT {
            return Err(AppError::InvalidInput("zip 条目过多".into()));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNCOMPRESSED_BYTES {
            return Err(AppError::InvalidInput("zip 解压体积过大".into()));
        }

        let out_path = dest.join(&enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&out_path)?;
        io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

fn find_manifest_root(temp_root: &Path) -> Result<(PathBuf, ExtensionManifest), AppError> {
    let direct = temp_root.join(MANIFEST_NAME);
    if direct.is_file() {
        let manifest = read_manifest(&direct)?;
        return Ok((temp_root.to_path_buf(), manifest));
    }

    let mut candidates = Vec::new();
    for entry in fs::read_dir(temp_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let candidate = entry.path().join(MANIFEST_NAME);
        if candidate.is_file() {
            candidates.push((entry.path(), candidate));
        }
    }
    if candidates.len() != 1 {
        return Err(AppError::InvalidInput(
            "扩展包根目录缺少 extension.json（或存在多个候选目录）".into(),
        ));
    }
    let (root, manifest_path) = candidates.remove(0);
    let manifest = read_manifest(&manifest_path)?;
    Ok((root, manifest))
}

fn read_manifest(path: &Path) -> Result<ExtensionManifest, AppError> {
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidInput(format!("extension.json 解析失败: {e}")))
}

fn validate_manifest(root: &Path, manifest: &ExtensionManifest) -> Result<(), AppError> {
    validate_plugin_id(&manifest.id)?;
    if manifest.api_version != 1 {
        return Err(AppError::InvalidInput(format!(
            "不支持的扩展 API 版本: {}（当前支持 1）",
            manifest.api_version
        )));
    }
    if manifest.protocol_version != 1 {
        return Err(AppError::InvalidInput(format!(
            "不支持的扩展协议版本: {}（当前支持 1）",
            manifest.protocol_version
        )));
    }
    if manifest.version.trim().is_empty() {
        return Err(AppError::InvalidInput("扩展包版本不能为空".into()));
    }
    if manifest.name.trim().is_empty() {
        return Err(AppError::InvalidInput("扩展包名称不能为空".into()));
    }
    if !is_safe_relative_path(&manifest.runtime.entry) {
        return Err(AppError::InvalidInput("runtime.entry 路径非法".into()));
    }
    if !root.join(&manifest.runtime.entry).is_file() {
        return Err(AppError::InvalidInput(format!(
            "入口文件不存在: {}",
            manifest.runtime.entry
        )));
    }
    if let Some(python_path) = manifest
        .runtime
        .python
        .as_ref()
        .and_then(|p| p.path.as_deref())
    {
        if !python_path.trim().is_empty() {
            if !is_safe_relative_path(python_path) {
                return Err(AppError::InvalidInput("runtime.python.path 路径非法".into()));
            }
            if !root.join(python_path).is_file() {
                return Err(AppError::InvalidInput(format!(
                    "内嵌 Python 不存在: {}",
                    python_path
                )));
            }
        }
    }
    for permission in &manifest.permissions {
        if permission.trim().is_empty() || permission.len() > 80 {
            return Err(AppError::InvalidInput("扩展包权限声明非法".into()));
        }
    }
    if let Some(ppt) = manifest.contributes.get("ppt") {
        for key in ["layoutsIndex", "chartsIndex"] {
            if let Some(value) = ppt.get(key).and_then(|v| v.as_str()) {
                if !is_safe_relative_path(value) {
                    return Err(AppError::InvalidInput(format!(
                        "contributes.ppt.{} 路径非法",
                        key
                    )));
                }
            }
        }
    }
    Ok(())
}

/// 验签扩展包：签名覆盖 `checksums.json` 的内容，并逐个校验清单中的文件哈希。
fn verify_integrity(root: &Path, manifest: &ExtensionManifest) -> Result<(), AppError> {
    let signature = manifest
        .integrity
        .as_ref()
        .and_then(|integrity| integrity.signature.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(signature) = signature else {
        return Ok(());
    };

    let public_key = std::env::var("PPT_EXTENSION_PUBLIC_KEY")
        .or_else(|_| std::env::var("POMEGRANATE_EXTENSION_PUBLIC_KEY"))
        .map_err(|_| {
            AppError::InvalidInput(
                "扩展包带签名，但未配置 PPT_EXTENSION_PUBLIC_KEY，已拒绝安装".into(),
            )
        })?;
    let checksums_path = root.join("checksums.json");
    let checksums_bytes = fs::read(&checksums_path).map_err(|_| {
        AppError::InvalidInput("签名扩展包缺少 checksums.json".into())
    })?;
    if let Some(declared) = manifest
        .integrity
        .as_ref()
        .and_then(|integrity| integrity.sha256.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let actual = sha256_file(&checksums_path)?;
        if !actual.eq_ignore_ascii_case(declared) {
            return Err(AppError::InvalidInput(
                "扩展包 checksums.json 哈希与清单声明不一致".into(),
            ));
        }
    }
    verify_signature(&checksums_bytes, signature, &public_key)?;

    let checksums: BTreeMap<String, String> = serde_json::from_slice(&checksums_bytes)?;
    for (relative, expected) in checksums {
        // checksums.json 是签名对象本身，extension.json 在签名后写入，二者不参与逐文件校验。
        if relative == "checksums.json" || relative == "extension.json" {
            continue;
        }
        if !is_safe_relative_path(&relative) {
            return Err(AppError::InvalidInput(format!(
                "签名清单包含非法路径: {}",
                relative
            )));
        }
        let path = root.join(&relative);
        let actual = sha256_file(&path).map_err(|_| {
            AppError::InvalidInput(format!("签名清单中的文件缺失: {}", relative))
        })?;
        if !actual.eq_ignore_ascii_case(&expected) {
            return Err(AppError::InvalidInput(format!(
                "扩展包文件哈希不匹配: {}",
                relative
            )));
        }
    }
    Ok(())
}

fn verify_signature(message: &[u8], signature_b64: &str, public_key_b64: &str) -> Result<(), AppError> {
    let engine = base64::engine::general_purpose::STANDARD;
    let key_bytes = engine
        .decode(public_key_b64.trim())
        .map_err(|_| AppError::InvalidInput("扩展验证公钥不是合法 base64".into()))?;
    let key_array: [u8; 32] = key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| AppError::InvalidInput("扩展验证公钥长度必须为 32 字节".into()))?;
    let key = VerifyingKey::from_bytes(&key_array)
        .map_err(|_| AppError::InvalidInput("扩展验证公钥格式非法".into()))?;
    let signature_bytes = engine
        .decode(signature_b64.trim())
        .map_err(|_| AppError::InvalidInput("扩展签名不是合法 base64".into()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| AppError::InvalidInput("扩展签名长度非法".into()))?;
    key.verify_strict(message, &signature)
        .map_err(|_| AppError::InvalidInput("扩展包签名校验失败".into()))
}

fn sha256_file(path: &Path) -> Result<String, AppError> {
    let bytes = fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn compatibility(manifest: &ExtensionManifest) -> (bool, Option<String>) {
    let current = env!("CARGO_PKG_VERSION");
    if let Some(min) = manifest.min_app_version.as_deref() {
        if !version_gte(current, min) {
            return (
                false,
                Some(format!("需要应用版本 >= {}，当前 {}", min, current)),
            );
        }
    }
    if !manifest.platforms.is_empty() {
        let platform = current_platform();
        if !manifest.platforms.iter().any(|p| p == &platform) {
            return (
                false,
                Some(format!("当前平台 {} 不在支持列表内", platform)),
            );
        }
    }
    (true, None)
}

pub fn current_platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn version_gte(current: &str, required: &str) -> bool {
    let a = parse_version(current);
    let b = parse_version(required);
    for i in 0..3 {
        let left = a.get(i).copied().unwrap_or(0);
        let right = b.get(i).copied().unwrap_or(0);
        if left > right {
            return true;
        }
        if left < right {
            return false;
        }
    }
    true
}

fn parse_version(value: &str) -> Vec<u64> {
    value
        .split(['.', '-', '+'])
        .take(3)
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

fn validate_plugin_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() || id.len() > 64 {
        return Err(AppError::InvalidInput("扩展包 id 长度非法".into()));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    {
        return Err(AppError::InvalidInput(
            "扩展包 id 只允许小写字母、数字、- _ .".into(),
        ));
    }
    Ok(())
}

fn is_safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.trim().is_empty()
        && !path.is_absolute()
        && !path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn safe_join(base: &Path, relative: &str) -> Result<PathBuf, AppError> {
    if !is_safe_relative_path(relative) {
        return Err(AppError::InvalidInput("资源路径非法".into()));
    }
    Ok(base.join(relative))
}

fn move_dir_contents(source: &Path, dest: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            move_dir_contents(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn count_files(root: &Path) -> Result<usize, AppError> {
    let mut count = 0usize;
    for entry in walkdir::WalkDir::new(root) {
        let entry = entry.map_err(|e| AppError::Custom(e.to_string()))?;
        if entry.file_type().is_file() {
            count += 1;
        }
    }
    Ok(count)
}

fn dir_size(root: &Path) -> Result<u64, AppError> {
    let mut total = 0u64;
    for entry in walkdir::WalkDir::new(root) {
        let entry = entry.map_err(|e| AppError::Custom(e.to_string()))?;
        if entry.file_type().is_file() {
            total = total.saturating_add(
                entry
                    .metadata()
                    .map_err(|e| AppError::Custom(e.to_string()))?
                    .len(),
            );
        }
    }
    Ok(total)
}

fn compute_dir_hash(root: &Path) -> Result<String, AppError> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(root) {
        let entry = entry.map_err(|e| AppError::Custom(e.to_string()))?;
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        }
    }
    files.sort();
    let mut hasher = Sha256::new();
    for file in files {
        let rel = file
            .strip_prefix(root)
            .map_err(|e| AppError::Custom(e.to_string()))?;
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update([0u8]);
        hasher.update(fs::read(&file)?);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn write_test_zip(dir: &Path, manifest: &str) -> PathBuf {
        let path = dir.join("pack.zip");
        let file = fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        zip.start_file("extension.json", options).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file("entry.py", options).unwrap();
        zip.write_all(b"print('ok')\n").unwrap();
        zip.finish().unwrap();
        path
    }

    fn test_manifest() -> String {
        format!(
            r#"{{
  "schemaVersion": 1,
  "id": "ppt-master",
  "name": "Test PPT",
  "version": "1.0.0",
  "kind": "ppt-engine",
  "platforms": ["{}"],
  "runtime": {{ "type": "python-script", "entry": "entry.py", "python": {{ "path": "" }} }},
  "contributes": {{ "ppt": {{}} }}
}}"#,
            current_platform()
        )
    }

    #[test]
    fn rejects_parent_dir_paths() {
        assert!(!is_safe_relative_path("../evil.py"));
        assert!(!is_safe_relative_path("a/../../evil.py"));
        assert!(is_safe_relative_path("entry.py"));
    }

    #[test]
    fn version_compare_works() {
        assert!(version_gte("2.1.0", "2.1.0"));
        assert!(version_gte("2.2.0", "2.1.9"));
        assert!(!version_gte("2.0.9", "2.1.0"));
    }

    #[test]
    fn platform_string_is_not_empty() {
        assert!(!current_platform().is_empty());
    }

    #[test]
    fn verifies_ed25519_package_signature() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let message = b"checksums-json-bytes";
        let signature = key.sign(message);
        let engine = base64::engine::general_purpose::STANDARD;
        let public_key = engine.encode(key.verifying_key().as_bytes());
        let signature_b64 = engine.encode(signature.to_bytes());
        assert!(verify_signature(message, &signature_b64, &public_key).is_ok());
        assert!(verify_signature(b"tampered", &signature_b64, &public_key).is_err());
    }

    #[test]
    fn reads_structured_layout_support_from_index() {
        let layouts = json!({
            "demo": {
                "page_count": 2,
                "page_types": ["01_cover", "02_content"],
                "structured": 1,
                "legacy": 1,
                "supportsStructured": true,
                "supportsLegacy": true
            }
        });
        let support = layout_support(Some(&layouts));
        assert_eq!(support["demo"]["structured"], 1);
        assert_eq!(support["demo"]["legacy"], 1);
        assert_eq!(support["demo"]["supportsStructured"], true);
        assert_eq!(support["demo"]["pageCount"], 2);
    }

    #[test]
    fn inspect_and_install_zip_roundtrip() {
        let temp = std::env::temp_dir().join(format!("ppt-ext-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        let zip_path = write_test_zip(&temp, &test_manifest());

        let inspection = ExtensionService::inspect_zip(&temp, zip_path.to_str().unwrap()).unwrap();
        assert!(inspection.compatible);
        assert_eq!(inspection.manifest.id, "ppt-master");
        assert!(inspection.content_hash.len() == 64);

        let db = Database::init(":memory:").unwrap();
        let info = ExtensionService::install_zip(&db, &temp, zip_path.to_str().unwrap()).unwrap();
        assert_eq!(info.id, "ppt-master");
        assert!(info.enabled);
        assert!(Path::new(&info.path).join("entry.py").is_file());
        assert!(ExtensionService::verify(&db, "ppt-master").unwrap());

        let _ = fs::remove_dir_all(&temp);
    }
}
