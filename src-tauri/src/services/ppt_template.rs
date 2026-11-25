//! 用户 PPT 模板导入。
//!
//! 设计约束：
//! - 只导入数据，不执行模板中的任何内容；
//! - 模板写入 `app_data/ppt-templates/<id>/`，不修改扩展包；
//! - 文件系统是资产权威，数据库只保存索引；
//! - 导入可来自文件夹或 zip，支持一个包内多套模板。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use quick_xml::events::Event;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::database::Database;
use crate::error::AppError;
use crate::models::extension::ExtensionInfo;
use crate::models::ppt_template::{
    PptTemplateCatalog, PptTemplateCatalogEntry, PptTemplateConflictPolicy,
    PptTemplateInstallFailure, PptTemplateInstallInput, PptTemplateInstallResult,
    PptTemplatePreview, PptTemplateReconcileReport, PptUserTemplate,
};
use crate::services::extension::ExtensionService;
use crate::services::safe_archive;

const MAX_TEMPLATE_FILES: usize = 5_000;
const MAX_TEMPLATE_BYTES: u64 = 200 * 1024 * 1024;
const MAX_SVG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;
const MAX_UNITS_PER_PACK: usize = 50;
const MAX_PAGES: usize = 200;
const META_NAME: &str = "meta.json";

pub struct PptTemplateService;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateMeta {
    schema_version: u32,
    id: String,
    display_name: String,
    description: Option<String>,
    source_kind: String,
    source_pack: Option<String>,
    canvas_format: String,
    canvas_width: i64,
    canvas_height: i64,
    page_count: i64,
    page_types: Vec<String>,
    supports_structured: bool,
    supports_legacy: bool,
    cover_file: Option<String>,
    content_hash: Option<String>,
    imported_at: String,
}

#[derive(Debug)]
struct PreparedSource {
    root: PathBuf,
    temp: Option<PathBuf>,
}

impl Drop for PreparedSource {
    fn drop(&mut self) {
        if let Some(temp) = &self.temp {
            let _ = fs::remove_dir_all(temp);
        }
    }
}

#[derive(Debug, Clone)]
struct UnitInfo {
    roster_dir: PathBuf,
    asset_root: PathBuf,
    spec_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct PageInfo {
    source: PathBuf,
    /// 原始文件名（用于错误提示）
    source_name: String,
    /// 去重后的页型
    page_type: String,
}

#[derive(Debug, Clone)]
struct TemplateUnit {
    id: String,
    display_name: String,
    description: Option<String>,
    source_kind: String,
    source_pack: Option<String>,
    roster_dir: PathBuf,
    asset_root: PathBuf,
    spec_path: Option<PathBuf>,
    pages: Vec<PageInfo>,
    page_type_map: BTreeMap<String, String>,
    canvas_format: String,
    canvas_width: i64,
    canvas_height: i64,
    supports_structured: bool,
    supports_legacy: bool,
    warnings: Vec<String>,
}

/// 模板解析结果，供 Rust 渲染链路使用。
#[derive(Debug, Clone)]
pub struct ResolvedPptLayout {
    /// 版式工作区根目录（含 templates/ 与可选 images/）
    pub workspace_root: PathBuf,
    /// 实际存放 SVG 的目录
    pub roster_dir: PathBuf,
    pub source: String,
}

impl PptTemplateService {
    pub fn templates_dir(data_dir: &Path) -> PathBuf {
        data_dir.join("ppt-templates")
    }

    pub fn list(db: &Database) -> Result<Vec<PptUserTemplate>, AppError> {
        let mut items = db.list_ppt_user_templates()?;
        for item in &mut items {
            item.display_name = display_name_for(
                &item.display_name,
                item.source_pack.as_deref(),
                &item.id,
            );
        }
        Ok(items)
    }

    /// 预览文件夹/zip 中的模板，不落盘。
    pub fn inspect(
        db: &Database,
        data_dir: &Path,
        path: &str,
    ) -> Result<Vec<PptTemplatePreview>, AppError> {
        let source = prepare_source(data_dir, path)?;
        let units = discover_units(&source.root, source_pack_name(path))?;
        if units.is_empty() {
            return Err(AppError::InvalidInput(
                "未在所选路径中找到可导入的模板（需要至少一个 SVG）".into(),
            ));
        }
        let builtins = extension_layout_ids(db);
        let templates_dir = Self::templates_dir(data_dir);
        let mut previews = Vec::new();
        for unit in units {
            let is_builtin = builtins.contains(&unit.id);
            let exists = db.get_ppt_user_template(&unit.id)?.is_some()
                || templates_dir.join(&unit.id).exists();
            let conflict = if is_builtin {
                Some(format!(
                    "模板 id {} 与内置模板冲突，导入时会自动改名",
                    unit.id
                ))
            } else if exists {
                Some(format!("模板 {} 已存在，导入时需要选择覆盖或另存为", unit.id))
            } else {
                None
            };
            let cover_file = pick_cover(&unit.pages);
            let mut warnings = unit.warnings.clone();
            let cover_svg = cover_file.as_ref().and_then(|file| {
                match read_cover_svg(&unit.roster_dir, file) {
                    Some((svg, warning)) => {
                        if let Some(w) = warning {
                            warnings.push(w);
                        }
                        Some(svg)
                    }
                    None => None,
                }
            });
            previews.push(PptTemplatePreview {
                id: unit.id,
                display_name: unit.display_name,
                description: unit.description,
                source_kind: unit.source_kind,
                source_pack: unit.source_pack,
                canvas_format: unit.canvas_format,
                canvas_width: unit.canvas_width,
                canvas_height: unit.canvas_height,
                page_count: unit.pages.len() as i64,
                page_types: unit.pages.iter().map(|p| p.page_type.clone()).collect(),
                supports_structured: unit.supports_structured,
                supports_legacy: unit.supports_legacy,
                cover_file,
                cover_svg,
                warnings,
                conflict,
                page_type_map: unit.page_type_map,
            });
        }
        Ok(previews)
    }

    /// 安装选中的模板。
    pub fn install(
        db: &Database,
        data_dir: &Path,
        input: PptTemplateInstallInput,
    ) -> Result<PptTemplateInstallResult, AppError> {
        if input.selections.is_empty() {
            return Err(AppError::InvalidInput("没有选择要安装的模板".into()));
        }
        let source = prepare_source(data_dir, &input.path)?;
        let units = discover_units(&source.root, source_pack_name(&input.path))?;
        if units.is_empty() {
            return Err(AppError::InvalidInput("未找到可导入的模板".into()));
        }
        let unit_map: HashMap<String, TemplateUnit> =
            units.into_iter().map(|u| (u.id.clone(), u)).collect();
        let builtins = extension_layout_ids(db);

        let templates_dir = Self::templates_dir(data_dir);
        fs::create_dir_all(&templates_dir)?;
        let stage_root = templates_dir.join(format!(".tmp-{}", Uuid::new_v4()));
        fs::create_dir_all(&stage_root)?;

        let mut result = PptTemplateInstallResult {
            installed: Vec::new(),
            failed: Vec::new(),
            warnings: Vec::new(),
        };

        for selection in input.selections {
            let Some(unit) = unit_map.get(&selection.id) else {
                result.failed.push(PptTemplateInstallFailure {
                    id: selection.id.clone(),
                    message: "所选模板不在来源包中".into(),
                });
                continue;
            };
            let policy = selection.conflict.unwrap_or_default();
            let target_id = match resolve_target_id(
                db,
                &templates_dir,
                &selection.id,
                policy,
                &builtins,
            ) {
                Ok(id) => id,
                Err(err) => {
                    result.failed.push(PptTemplateInstallFailure {
                        id: selection.id.clone(),
                        message: err.to_string(),
                    });
                    continue;
                }
            };
            if target_id != selection.id {
                result.warnings.push(format!(
                    "模板 {} 与现有模板冲突，已改名为 {}",
                    selection.id, target_id
                ));
            }

            let stage_target = stage_root.join(&target_id);
            match stage_and_install_unit(
                db,
                &templates_dir,
                &stage_target,
                &target_id,
                unit,
                &selection,
                source_pack_name(&input.path),
            ) {
                Ok(tpl) => result.installed.push(tpl),
                Err(err) => result.failed.push(PptTemplateInstallFailure {
                    id: selection.id.clone(),
                    message: err.to_string(),
                }),
            }
        }

        let _ = fs::remove_dir_all(&stage_root);
        Ok(result)
    }

    pub fn delete(db: &Database, data_dir: &Path, id: &str) -> Result<bool, AppError> {
        validate_id(id)?;
        let dir = Self::templates_dir(data_dir).join(id);
        if dir.exists() {
            let base = fs::canonicalize(Self::templates_dir(data_dir))?;
            let canonical = fs::canonicalize(&dir)?;
            if !canonical.starts_with(&base) {
                return Err(AppError::InvalidInput("模板目录越界".into()));
            }
            fs::remove_dir_all(&canonical)?;
        }
        db.delete_ppt_user_template(id)
    }

    pub fn set_enabled(db: &Database, id: &str, enabled: bool) -> Result<(), AppError> {
        db.set_ppt_user_template_enabled(id, enabled)
    }

    pub fn rename(
        db: &Database,
        data_dir: &Path,
        id: &str,
        display_name: &str,
        description: Option<&str>,
    ) -> Result<(), AppError> {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err(AppError::InvalidInput("模板名称不能为空".into()));
        }
        let dir = Self::templates_dir(data_dir).join(id);
        if dir.is_dir() {
            let meta_path = dir.join(META_NAME);
            if let Ok(text) = fs::read_to_string(&meta_path) {
                if let Ok(mut meta) = serde_json::from_str::<TemplateMeta>(&text) {
                    meta.display_name = display_name.to_string();
                    meta.description = description.map(str::to_string);
                    fs::write(&meta_path, serde_json::to_vec_pretty(&meta)?)?;
                }
            }
        }
        db.update_ppt_user_template_meta(id, display_name, description)
    }

    /// 读取封面 SVG。
    pub fn preview(db: &Database, id: &str) -> Result<String, AppError> {
        validate_id(id)?;
        let tpl = db
            .get_ppt_user_template(id)?
            .ok_or_else(|| AppError::NotFound(format!("用户模板 {} 不存在", id)))?;
        let base = fs::canonicalize(&tpl.dir_path)?;
        let mut candidates = Vec::new();
        if let Some(cover) = tpl.cover_file.as_deref() {
            candidates.push(base.join("templates").join(cover));
            candidates.push(base.join(cover));
        }
        for dir in [base.join("templates"), base.clone()] {
            if let Ok(entries) = fs::read_dir(&dir) {
                let mut svgs: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| {
                        p.is_file()
                            && p.extension()
                                .and_then(|e| e.to_str())
                                .map(|e| e.eq_ignore_ascii_case("svg"))
                                .unwrap_or(false)
                    })
                    .collect();
                svgs.sort();
                candidates.extend(svgs);
            }
        }
        for candidate in candidates {
            if !candidate.is_file() {
                continue;
            }
            let canonical = fs::canonicalize(&candidate)?;
            if !canonical.starts_with(&base) {
                continue;
            }
            let size = fs::metadata(&canonical)?.len();
            if size > MAX_SVG_BYTES {
                continue;
            }
            return Ok(fs::read_to_string(canonical)?);
        }
        Err(AppError::NotFound(format!("模板 {} 没有可预览的 SVG", id)))
    }

    /// 合并扩展包与用户模板的 catalog。
    pub fn catalog(db: &Database) -> Result<PptTemplateCatalog, AppError> {
        let mut layouts = BTreeMap::new();
        let mut extension_id = None;
        let mut extension_version = None;
        let mut charts = serde_json::Value::Null;

        if let Ok(catalog) = ExtensionService::ppt_catalog(db, "ppt-master") {
            extension_id = catalog
                .get("extensionId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            extension_version = catalog
                .get("extensionVersion")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            charts = catalog.get("charts").cloned().unwrap_or(serde_json::Value::Null);
            if let Some(map) = catalog.get("layouts").and_then(|v| v.as_object()) {
                for (id, meta) in map {
                    let page_types = meta
                        .get("page_types")
                        .and_then(|v| v.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|v| v.as_str().map(str::to_string))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let page_count = meta
                        .get("page_count")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(page_types.len() as i64);
                    layouts.insert(
                        id.clone(),
                        PptTemplateCatalogEntry {
                            id: id.clone(),
                            name_zh: meta
                                .get("nameZh")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            description_zh: meta
                                .get("descriptionZh")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            summary: meta
                                .get("summary")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            canvas_format: meta
                                .get("canvas_format")
                                .and_then(|v| v.as_str())
                                .unwrap_or("ppt169")
                                .to_string(),
                            page_count,
                            page_types,
                            source: "extension".into(),
                            structured: meta
                                .get("structured")
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0),
                            legacy: meta.get("legacy").and_then(|v| v.as_i64()).unwrap_or(0),
                            supports_structured: meta
                                .get("supportsStructured")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                            supports_legacy: meta
                                .get("supportsLegacy")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                        },
                    );
                }
            }
        }

        for tpl in db.list_ppt_user_templates()? {
            if !tpl.enabled || tpl.status != "ok" {
                continue;
            }
            if layouts.contains_key(&tpl.id) {
                log::warn!("用户模板 {} 与内置模板 id 冲突，已从 catalog 跳过", tpl.id);
                continue;
            }
            layouts.insert(
                tpl.id.clone(),
                PptTemplateCatalogEntry {
                    id: tpl.id.clone(),
                    name_zh: Some(display_name_for(
                        &tpl.display_name,
                        tpl.source_pack.as_deref(),
                        &tpl.id,
                    )),
                    description_zh: tpl.description.clone(),
                    summary: tpl.description.clone(),
                    canvas_format: tpl.canvas_format.clone(),
                    page_count: tpl.page_count,
                    page_types: tpl.page_types.clone(),
                    source: "user".into(),
                    structured: if tpl.supports_structured { tpl.page_count } else { 0 },
                    legacy: if tpl.supports_legacy { tpl.page_count } else { 0 },
                    supports_structured: tpl.supports_structured,
                    supports_legacy: tpl.supports_legacy,
                },
            );
        }

        Ok(PptTemplateCatalog {
            extension_id,
            extension_version,
            layouts,
            charts,
        })
    }

    /// 校验模板目录内容是否与导入时的哈希一致。
    pub fn verify(db: &Database, id: &str) -> Result<bool, AppError> {
        let tpl = db
            .get_ppt_user_template(id)?
            .ok_or_else(|| AppError::NotFound(format!("用户模板 {} 不存在", id)))?;
        let root = Path::new(&tpl.dir_path);
        if !root.is_dir() {
            return Ok(false);
        }
        let actual = hash_template_dir(root)?;
        Ok(tpl.content_hash.as_deref() == Some(actual.as_str()))
    }

    /// 把模板目录导出为可分享的 zip。
    pub fn export_pack(db: &Database, id: &str, target: &str) -> Result<String, AppError> {
        validate_id(id)?;
        let tpl = db
            .get_ppt_user_template(id)?
            .ok_or_else(|| AppError::NotFound(format!("用户模板 {} 不存在", id)))?;
        let root = PathBuf::from(&tpl.dir_path);
        if !root.is_dir() {
            return Err(AppError::NotFound(format!("模板目录不存在: {}", root.display())));
        }
        let target_path = PathBuf::from(target);
        let is_zip = target_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("zip"))
            .unwrap_or(false);
        if !is_zip {
            return Err(AppError::InvalidInput("导出文件必须是 .zip".into()));
        }
        if let Some(parent) = target_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let file = fs::File::create(&target_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for entry in WalkDir::new(&root).follow_links(false) {
            let entry = entry.map_err(|e| AppError::Custom(e.to_string()))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&root)
                .map_err(|e| AppError::Custom(e.to_string()))?;
            let rel_name = rel.to_string_lossy().replace('\\', "/");
            if rel_name.starts_with(".bak") || rel_name.starts_with(".tmp") {
                continue;
            }
            zip.start_file(rel_name, options)?;
            let mut source = fs::File::open(entry.path())?;
            io::copy(&mut source, &mut zip)?;
        }
        zip.finish()?;
        Ok(target_path.to_string_lossy().to_string())
    }

    /// 重新扫描模板目录，修复 DB 索引。
    pub fn reconcile(db: &Database, data_dir: &Path) -> Result<PptTemplateReconcileReport, AppError> {
        let templates_dir = Self::templates_dir(data_dir);
        fs::create_dir_all(&templates_dir)?;
        let mut report = PptTemplateReconcileReport::default();
        let existing: HashMap<String, PptUserTemplate> = db
            .list_ppt_user_templates()?
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        let mut seen = HashSet::new();

        let entries = fs::read_dir(&templates_dir)?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let meta_path = path.join(META_NAME);
            if let Ok(text) = fs::read_to_string(&meta_path) {
                if let Ok(meta) = serde_json::from_str::<TemplateMeta>(&text) {
                    if meta.id != name {
                        report.warnings.push(format!(
                            "模板目录 {} 的 meta.id={} 不一致，以 meta 为准",
                            name, meta.id
                        ));
                    }
                    if roster_dir(&path).is_none() {
                        db.set_ppt_user_template_status(&meta.id, "invalid")?;
                        seen.insert(meta.id.clone());
                        report.warnings.push(format!(
                            "模板 {} 的目录中没有 SVG，已标记为 invalid",
                            meta.id
                        ));
                        continue;
                    }
                    let enabled = existing
                        .get(&meta.id)
                        .map(|t| t.enabled)
                        .unwrap_or(true);
                    let tpl = meta_to_template(&meta, &path, enabled);
                    if let Some(prev) = existing.get(&meta.id) {
                        if same_template(prev, &tpl) {
                            seen.insert(meta.id.clone());
                            continue;
                        }
                        db.upsert_ppt_user_template(&tpl)?;
                        seen.insert(meta.id.clone());
                        report.updated.push(meta.id);
                    } else {
                        db.upsert_ppt_user_template(&tpl)?;
                        seen.insert(meta.id.clone());
                        report.added.push(meta.id);
                    }
                    continue;
                }
            }

            // 没有 meta.json：把目录当作单个模板重新解析。
            match build_unit(&path, None) {
                Ok(Some(unit)) => {
                    let enabled = existing
                        .get(&unit.id)
                        .map(|t| t.enabled)
                        .unwrap_or(true);
                    let hash = hash_template_dir(&path)?;
                    let tpl = unit_to_template(&unit, &path, enabled, Some(hash))?;
                    write_meta(&path, &tpl)?;
                    if let Some(prev) = existing.get(&tpl.id) {
                        if same_template(prev, &tpl) {
                            seen.insert(tpl.id.clone());
                            continue;
                        }
                        db.upsert_ppt_user_template(&tpl)?;
                        seen.insert(tpl.id.clone());
                        report.updated.push(tpl.id);
                    } else {
                        db.upsert_ppt_user_template(&tpl)?;
                        seen.insert(tpl.id.clone());
                        report.added.push(tpl.id);
                    }
                }
                Ok(None) => {
                    report.warnings.push(format!("目录 {} 不是有效模板，已跳过", name));
                }
                Err(err) => {
                    report
                        .warnings
                        .push(format!("目录 {} 解析失败: {}", name, err));
                }
            }
        }

        for (id, tpl) in existing {
            if seen.contains(&id) {
                continue;
            }
            if !Path::new(&tpl.dir_path).is_dir() {
                db.set_ppt_user_template_status(&id, "missing")?;
                report.missing.push(id);
            } else {
                db.set_ppt_user_template_status(&id, "invalid")?;
                report.warnings.push(format!("模板 {} 的目录存在但无法解析", id));
            }
        }

        Ok(report)
    }

    /// 解析版式工作区：优先用户模板，其次扩展包。
    pub fn resolve_layout(
        db: &Database,
        extension: &ExtensionInfo,
        layout_id: &str,
    ) -> Option<ResolvedPptLayout> {
        if let Ok(Some(tpl)) = db.get_ppt_user_template(layout_id) {
            let base = PathBuf::from(&tpl.dir_path);
            if let Some(roster) = roster_dir(&base) {
                return Some(ResolvedPptLayout {
                    workspace_root: base,
                    roster_dir: roster,
                    source: "user".into(),
                });
            }
        }
        let base = PathBuf::from(&extension.path)
            .join("templates")
            .join("layouts")
            .join(layout_id);
        if let Some(roster) = roster_dir(&base) {
            return Some(ResolvedPptLayout {
                workspace_root: base,
                roster_dir: roster,
                source: "extension".into(),
            });
        }
        None
    }

    /// 把版式快照复制到作业目录，保证历史作业可复现。
    pub fn ensure_job_template_snapshot(
        job_dir: &Path,
        resolved: &ResolvedPptLayout,
        layout_id: &str,
    ) -> Result<PathBuf, AppError> {
        validate_id(layout_id)?;
        let dest = job_dir
            .join("templates")
            .join(format!("layout_{}", layout_id));
        if let Some(roster) = roster_dir(&dest) {
            normalize_snapshot_roster(&roster)?;
            return Ok(roster);
        }
        copy_tree_filtered(&resolved.workspace_root, &dest)?;
        let roster = roster_dir(&dest).ok_or_else(|| {
            AppError::NotFound(format!("版式快照失败：{} 中没有 SVG", dest.display()))
        })?;
        normalize_snapshot_roster(&roster)?;
        Ok(roster)
    }
}

// ─────────────────────────────────────────────────────────────
// 内部实现
// ─────────────────────────────────────────────────────────────

fn prepare_source(data_dir: &Path, path: &str) -> Result<PreparedSource, AppError> {
    let p = Path::new(path);
    if p.is_dir() {
        let root = fs::canonicalize(p)?;
        return Ok(PreparedSource { root, temp: None });
    }
    if p.is_file() {
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default();
        if !ext.eq_ignore_ascii_case("zip") {
            return Err(AppError::InvalidInput("模板来源必须是文件夹或 zip 文件".into()));
        }
        let base = PptTemplateService::templates_dir(data_dir);
        fs::create_dir_all(&base)?;
        let temp = base.join(format!(".tmp-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp)?;
        if let Err(err) = safe_archive::extract_zip_safely(
            p,
            &temp,
            MAX_TEMPLATE_FILES,
            MAX_TEMPLATE_BYTES,
        ) {
            let _ = fs::remove_dir_all(&temp);
            return Err(err);
        }
        return Ok(PreparedSource {
            root: temp.clone(),
            temp: Some(temp),
        });
    }
    Err(AppError::NotFound(format!("模板来源不存在: {}", path)))
}

fn source_pack_name(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|v| v.to_str())
        .map(str::to_string)
}

fn discover_units(root: &Path, source_pack: Option<String>) -> Result<Vec<TemplateUnit>, AppError> {
    let mut units = Vec::new();
    let mut by_id: HashMap<String, PathBuf> = HashMap::new();
    let mut walker = WalkDir::new(root)
        .max_depth(5)
        .follow_links(false)
        .into_iter();
    while let Some(entry) = walker.next() {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_dir() {
            continue;
        }
        let Some(info) = unit_info(entry.path()) else {
            continue;
        };
        walker.skip_current_dir();
        if units.len() >= MAX_UNITS_PER_PACK {
            break;
        }
        match build_unit_from_info(entry.path(), info, source_pack.clone()) {
            Ok(Some(unit)) => {
                if let Some(prev) = by_id.get(&unit.id) {
                    log::warn!(
                        "模板 id {} 在 {} 与 {} 重复，跳过后者",
                        unit.id,
                        prev.display(),
                        entry.path().display()
                    );
                    continue;
                }
                by_id.insert(unit.id.clone(), entry.path().to_path_buf());
                units.push(unit);
            }
            Ok(None) => {}
            Err(err) => {
                log::warn!("解析模板目录 {} 失败: {}", entry.path().display(), err);
            }
        }
    }
    units.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(units)
}

fn unit_info(dir: &Path) -> Option<UnitInfo> {
    let templates = dir.join("templates");
    if templates.is_dir() && has_svg(&templates) {
        let spec_path = find_spec(&templates).or_else(|| find_spec(dir));
        return Some(UnitInfo {
            roster_dir: templates,
            asset_root: dir.to_path_buf(),
            spec_path,
        });
    }
    if has_svg(dir) {
        let asset_root = if dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("templates"))
            .unwrap_or(false)
        {
            dir.parent().unwrap_or(dir).to_path_buf()
        } else {
            dir.to_path_buf()
        };
        let spec_path = find_spec(dir).or_else(|| find_spec(&asset_root));
        return Some(UnitInfo {
            roster_dir: dir.to_path_buf(),
            asset_root,
            spec_path,
        });
    }
    None
}

/// 从压缩包名取可读的模板名，避免把解压临时目录名当名称。
fn pack_display_name(source_pack: Option<&str>) -> Option<String> {
    source_pack
        .and_then(|pack| Path::new(pack).file_stem())
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty() && !stem.starts_with(".tmp-"))
        .map(str::to_string)
}

fn unit_fallback_name(dir: &Path, source_pack: Option<&str>) -> String {
    let dir_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("").trim();
    let is_temp = dir_name.starts_with(".tmp-");
    let is_roster = dir_name.eq_ignore_ascii_case("templates");
    // templates 目录本身不适合作为名称，优先用其父目录（模板包名）。
    if is_roster {
        if let Some(parent) = dir
            .parent()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
        {
            if !parent.is_empty() && !parent.starts_with(".tmp-") {
                return parent.to_string();
            }
        }
    }
    if is_temp || is_roster || dir_name.is_empty() {
        if let Some(name) = pack_display_name(source_pack) {
            return name;
        }
    }
    if dir_name.is_empty() {
        "template".to_string()
    } else {
        dir_name.to_string()
    }
}

/// 旧数据兼容：历史导入可能把 `.tmp-<uuid>` 写进 display_name，
/// 读取时改用来源压缩包名显示（不修改数据库）。
fn display_name_for(display_name: &str, source_pack: Option<&str>, id: &str) -> String {
    let trimmed = display_name.trim();
    if !trimmed.starts_with(".tmp-") {
        return display_name.to_string();
    }
    pack_display_name(source_pack).unwrap_or_else(|| id.to_string())
}

fn build_unit(dir: &Path, source_pack: Option<String>) -> Result<Option<TemplateUnit>, AppError> {
    let Some(info) = unit_info(dir) else {
        return Ok(None);
    };
    build_unit_from_info(dir, info, source_pack)
}

fn build_unit_from_info(
    dir: &Path,
    info: UnitInfo,
    source_pack: Option<String>,
) -> Result<Option<TemplateUnit>, AppError> {
    let pages = scan_pages(&info.roster_dir)?;
    if pages.is_empty() {
        return Ok(None);
    }
    if pages.len() > MAX_PAGES {
        return Err(AppError::InvalidInput(format!(
            "模板页数过多（{} > {}）",
            pages.len(),
            MAX_PAGES
        )));
    }

    let spec = info
        .spec_path
        .as_deref()
        .and_then(read_frontmatter)
        .unwrap_or_default();
    let mut warnings = Vec::new();
    if info.spec_path.is_none() {
        warnings.push("未找到 design_spec.md，已从文件名推导页型".to_string());
    }

    let fallback_name = unit_fallback_name(dir, source_pack.as_deref());
    let id_raw = fm_str(&spec, "layout_id")
        .or_else(|| fm_str(&spec, "deck_id"))
        .or_else(|| fm_str(&spec, "id"))
        .unwrap_or_else(|| fallback_name.clone());
    let id = sanitize_id(&id_raw);
    let display_name = fm_str(&spec, "name")
        .or_else(|| fm_str(&spec, "display_name"))
        .or_else(|| fm_str(&spec, "title"))
        .unwrap_or_else(|| fallback_name.clone());
    let description = fm_str(&spec, "summary").or_else(|| fm_str(&spec, "description"));
    let source_kind = match fm_str(&spec, "kind").as_deref() {
        Some("deck") => "deck",
        _ => "layout",
    }
    .to_string();

    let page_type_map = pages
        .iter()
        .map(|p| (p.source_name.clone(), p.page_type.clone()))
        .collect();
    let page_types: Vec<String> = pages.iter().map(|p| p.page_type.clone()).collect();
    if page_types.len() != page_types.iter().collect::<HashSet<_>>().len() {
        warnings.push("存在重复页型，已在安装时自动重命名".to_string());
    }

    let mut supports_structured = false;
    let mut supports_legacy = false;
    let mut canvas: Option<(f64, f64)> = None;
    for page in &pages {
        let text = fs::read_to_string(&page.source)?;
        validate_svg_text(&text)?;
        if text.contains("data-pptx-placeholder") {
            supports_structured = true;
        }
        if text.contains("{{") {
            supports_legacy = true;
        }
        if canvas.is_none() {
            canvas = svg_canvas(&text);
        }
    }
    if !supports_structured && !supports_legacy {
        warnings.push(
            "SVG 中没有发现 data-pptx-placeholder 或 {{占位符}}，PPT 生成时会回退内置渲染器"
                .to_string(),
        );
    }

    let spec_canvas = match (
        fm_i64(&spec, "canvas_width"),
        fm_i64(&spec, "canvas_height"),
    ) {
        (Some(w), Some(h)) => Some((w as f64, h as f64)),
        _ => None,
    };
    let (canvas_width, canvas_height) = spec_canvas
        .or(canvas)
        .unwrap_or((1280.0, 720.0));
    let canvas_width = canvas_width.round() as i64;
    let canvas_height = canvas_height.round() as i64;
    let canvas_format = fm_str(&spec, "canvas_format").unwrap_or_else(|| {
        infer_canvas_format(canvas_width, canvas_height).to_string()
    });

    Ok(Some(TemplateUnit {
        id,
        display_name,
        description,
        source_kind,
        source_pack,
        roster_dir: info.roster_dir,
        asset_root: info.asset_root,
        spec_path: info.spec_path,
        pages,
        page_type_map,
        canvas_format,
        canvas_width,
        canvas_height,
        supports_structured,
        supports_legacy,
        warnings,
    }))
}

fn scan_pages(roster_dir: &Path) -> Result<Vec<PageInfo>, AppError> {
    let mut files: Vec<PathBuf> = fs::read_dir(roster_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("svg"))
                    .unwrap_or(false)
        })
        .collect();
    files.sort();
    let mut used: HashMap<String, usize> = HashMap::new();
    let mut pages = Vec::new();
    for file in files {
        let source_name = file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("page.svg")
            .to_string();
        let base_type = derive_page_type(&source_name);
        let count = used.entry(base_type.clone()).or_insert(0);
        *count += 1;
        let page_type = if *count == 1 {
            base_type
        } else {
            format!("{}_{}", base_type, *count)
        };
        pages.push(PageInfo {
            source: file,
            source_name,
            page_type,
        });
    }
    Ok(pages)
}

fn derive_page_type(file_name: &str) -> String {
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    let re = PREFIX.get_or_init(|| Regex::new(r"^\d+[a-z]?_").expect("页型前缀正则恒定"));
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or(file_name);
    let stripped = re.replace(stem, "");
    let mut out = String::new();
    for ch in stripped.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        } else if matches!(ch, '_' | '-') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() {
        "content".to_string()
    } else {
        out
    }
}

fn has_svg(dir: &Path) -> bool {
    fs::read_dir(dir)
        .ok()
        .map(|entries| {
            entries.flatten().any(|e| {
                e.path().is_file()
                    && e.path()
                        .extension()
                        .and_then(|v| v.to_str())
                        .map(|v| v.eq_ignore_ascii_case("svg"))
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn find_spec(dir: &Path) -> Option<PathBuf> {
    let direct = dir.join("design_spec.md");
    if direct.is_file() {
        return Some(direct);
    }
    let mut candidates: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| {
                        n.starts_with("design_spec.") && n.ends_with(".md")
                    })
                    .unwrap_or(false)
        })
        .collect();
    candidates.sort_by_key(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("design_spec.layout.") {
            0
        } else if name.starts_with("design_spec.deck.") {
            1
        } else {
            2
        }
    });
    candidates.into_iter().next()
}

fn read_frontmatter(path: &Path) -> Option<BTreeMap<String, serde_yml::Value>> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let rest = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))?;
    let mut idx = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" || trimmed == "..." {
            let yaml = &rest[..idx];
            return serde_yml::from_str::<BTreeMap<String, serde_yml::Value>>(yaml).ok();
        }
        idx += line.len();
    }
    None
}

fn fm_str(map: &BTreeMap<String, serde_yml::Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn fm_i64(map: &BTreeMap<String, serde_yml::Value>, key: &str) -> Option<i64> {
    map.get(key).and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
    })
}

fn svg_canvas(text: &str) -> Option<(f64, f64)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut reader = quick_xml::Reader::from_str(text);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.name().as_ref() != b"svg" {
                    continue;
                }
                let mut width = None;
                let mut height = None;
                let mut viewbox = None;
                for attr in e.attributes().flatten() {
                    let key = std::str::from_utf8(attr.key.as_ref()).ok()?;
                    let value = String::from_utf8_lossy(&attr.value).to_string();
                    match key {
                        "width" => width = parse_px(&value),
                        "height" => height = parse_px(&value),
                        "viewBox" | "viewbox" => viewbox = parse_viewbox(&value),
                        _ => {}
                    }
                }
                if let (Some(w), Some(h)) = (width, height) {
                    return Some((w, h));
                }
                return viewbox;
            }
            Ok(Event::Eof) => return None,
            Err(_) => return None,
            _ => {}
        }
    }
}

fn parse_px(value: &str) -> Option<f64> {
    value
        .trim()
        .trim_end_matches("px")
        .trim()
        .parse::<f64>()
        .ok()
}

fn parse_viewbox(value: &str) -> Option<(f64, f64)> {
    let parts: Vec<f64> = value
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter_map(|p| p.trim().parse::<f64>().ok())
        .collect();
    if parts.len() == 4 {
        Some((parts[2], parts[3]))
    } else {
        None
    }
}

fn infer_canvas_format(width: i64, height: i64) -> &'static str {
    if height > 0 {
        let ratio = width as f64 / height as f64;
        if (ratio - 16.0 / 9.0).abs() < 0.02 {
            return "ppt169";
        }
        if (ratio - 4.0 / 3.0).abs() < 0.02 {
            return "ppt43";
        }
        if (ratio - 9.0 / 16.0).abs() < 0.02 {
            return "story_vertical";
        }
    }
    "custom"
}

fn validate_svg_text(text: &str) -> Result<(), AppError> {
    if text.len() as u64 > MAX_SVG_BYTES {
        return Err(AppError::InvalidInput("SVG 文件过大".into()));
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // 完整解析，确保 XML 合法。
    let mut reader = quick_xml::Reader::from_str(text);
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(err) => {
                return Err(AppError::InvalidInput(format!("SVG 解析失败: {err}")));
            }
        }
    }
    if let Some(reason) = forbidden_svg_reason(text) {
        return Err(AppError::InvalidInput(reason));
    }
    Ok(())
}

fn forbidden_svg_reason(text: &str) -> Option<String> {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    static FOREIGN: OnceLock<Regex> = OnceLock::new();
    static EVENT: OnceLock<Regex> = OnceLock::new();
    static EXT_HREF: OnceLock<Regex> = OnceLock::new();
    static EXT_URL: OnceLock<Regex> = OnceLock::new();
    let script = SCRIPT.get_or_init(|| Regex::new(r"(?is)<\s*script\b").unwrap());
    let foreign = FOREIGN.get_or_init(|| Regex::new(r"(?is)<\s*foreignObject\b").unwrap());
    let event = EVENT.get_or_init(|| Regex::new(r"(?is)\son[a-z]+\s*=").unwrap());
    let ext_href = EXT_HREF.get_or_init(|| {
        Regex::new(r#"(?is)(?:xlink:)?href\s*=\s*["']\s*(?:https?:|javascript:|file:)"#).unwrap()
    });
    let ext_url = EXT_URL.get_or_init(|| {
        Regex::new(r#"(?is)url\(\s*["']?\s*(?:https?:|file:)"#).unwrap()
    });
    if script.is_match(text) {
        return Some("SVG 中不允许 <script>".into());
    }
    if foreign.is_match(text) {
        return Some("SVG 中不允许 <foreignObject>".into());
    }
    if event.is_match(text) {
        return Some("SVG 中不允许事件属性（on*）".into());
    }
    if ext_href.is_match(text) {
        return Some("SVG 中不允许外部或脚本链接".into());
    }
    if ext_url.is_match(text) {
        return Some("SVG 中不允许外部 url() 引用".into());
    }
    None
}

fn pick_cover(pages: &[PageInfo]) -> Option<String> {
    pages
        .iter()
        .find(|p| p.page_type == "cover")
        .or_else(|| pages.first())
        .map(|p| {
            p.source
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("cover.svg")
                .to_string()
        })
}

fn read_cover_svg(roster_dir: &Path, file: &str) -> Option<(String, Option<String>)> {
    let path = roster_dir.join(file);
    let size = fs::metadata(&path).ok()?.len();
    if size > MAX_PREVIEW_BYTES {
        return Some((String::new(), Some("封面 SVG 较大，已跳过预览".to_string())));
    }
    let text = fs::read_to_string(path).ok()?;
    Some((text, None))
}

fn sanitize_id(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if matches!(ch, '-' | '_') {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    let out = out.trim_matches(['-', '_']).to_string();
    if out.is_empty() || out == "." || out == ".." {
        format!("template-{}", short_hash(raw))
    } else {
        out
    }
}

fn validate_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() || id.len() > 80 {
        return Err(AppError::InvalidInput("模板 id 长度非法".into()));
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(AppError::InvalidInput("模板 id 包含非法路径".into()));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    {
        return Err(AppError::InvalidInput(
            "模板 id 只允许小写字母、数字、- _ .".into(),
        ));
    }
    Ok(())
}

fn short_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    format!("{:x}", digest)[..8].to_string()
}

fn roster_dir(base: &Path) -> Option<PathBuf> {
    let nested = base.join("templates");
    if nested.is_dir() && has_svg(&nested) {
        return Some(nested);
    }
    if base.is_dir() && has_svg(base) {
        return Some(base.to_path_buf());
    }
    None
}

fn extension_layout_ids(db: &Database) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(Some(info)) = db.get_extension("ppt-master") else {
        return ids;
    };
    let root = PathBuf::from(&info.path).join("templates").join("layouts");
    let index = root.join("layouts_index.json");
    if let Ok(text) = fs::read_to_string(index) {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&text) {
            ids.extend(map.keys().cloned());
            return ids;
        }
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                ids.insert(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    ids
}

fn target_id_exists(
    db: &Database,
    templates_dir: &Path,
    id: &str,
    builtins: &HashSet<String>,
) -> bool {
    builtins.contains(id)
        || templates_dir.join(id).exists()
        || db
            .get_ppt_user_template(id)
            .ok()
            .flatten()
            .is_some()
}

fn resolve_target_id(
    db: &Database,
    templates_dir: &Path,
    requested: &str,
    policy: PptTemplateConflictPolicy,
    builtins: &HashSet<String>,
) -> Result<String, AppError> {
    let requested = sanitize_id(requested);
    validate_id(&requested)?;
    let exists = target_id_exists(db, templates_dir, &requested, builtins);
    if !exists {
        return Ok(requested);
    }
    // 内置模板永不被覆盖。
    if builtins.contains(&requested) {
        return Ok(next_available_id(db, templates_dir, &requested, builtins));
    }
    match policy {
        PptTemplateConflictPolicy::Reject => Err(AppError::InvalidInput(format!(
            "模板 {} 已存在，请选择覆盖或另存为",
            requested
        ))),
        PptTemplateConflictPolicy::Overwrite => Ok(requested),
        PptTemplateConflictPolicy::Rename => {
            Ok(next_available_id(db, templates_dir, &requested, builtins))
        }
    }
}

fn next_available_id(
    db: &Database,
    templates_dir: &Path,
    base: &str,
    builtins: &HashSet<String>,
) -> String {
    for n in 2..10_000 {
        let candidate = format!("{}-{}", base, n);
        if !target_id_exists(db, templates_dir, &candidate, builtins) {
            return candidate;
        }
    }
    format!("{}-{}", base, Uuid::new_v4())
}

fn stage_and_install_unit(
    db: &Database,
    templates_dir: &Path,
    stage_target: &Path,
    target_id: &str,
    unit: &TemplateUnit,
    selection: &crate::models::ppt_template::PptTemplateInstallSelection,
    source_pack: Option<String>,
) -> Result<PptUserTemplate, AppError> {
    if stage_target.exists() {
        fs::remove_dir_all(stage_target)?;
    }
    let roster = stage_target.join("templates");
    fs::create_dir_all(&roster)?;

    let mut cover_file = None;
    for (index, page) in unit.pages.iter().enumerate() {
        let file_name = format!("{:03}_{}.svg", index + 1, page.page_type);
        let text = fs::read_to_string(&page.source)?;
        validate_svg_text(&text)?;
        fs::write(roster.join(&file_name), text)?;
        if page.page_type == "cover" && cover_file.is_none() {
            cover_file = Some(file_name);
        }
    }
    if cover_file.is_none() {
        cover_file = unit.pages.first().map(|p| format!("001_{}.svg", p.page_type));
    }
    if let Some(spec) = unit.spec_path.as_deref() {
        if spec.is_file() {
            fs::copy(spec, roster.join("design_spec.md"))?;
        }
    }

    let keep_images = selection.keep_images.unwrap_or(true);
    if keep_images {
        let images = unit.asset_root.join("images");
        if images.is_dir() {
            copy_tree_filtered(&images, &stage_target.join("images"))?;
        }
    }
    // 矢量图标不是位图，即使选择丢弃图片也保留，避免装饰层缺失。
    let icons = unit.asset_root.join("icons");
    if icons.is_dir() {
        copy_tree_filtered(&icons, &stage_target.join("icons"))?;
    }

    let display_name = selection
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(&unit.display_name)
        .to_string();
    let description = selection
        .description
        .clone()
        .or_else(|| unit.description.clone());

    let content_hash = hash_template_dir(stage_target)?;
    let imported_at = chrono::Local::now().to_rfc3339();
    let page_types: Vec<String> = unit.pages.iter().map(|p| p.page_type.clone()).collect();
    let meta = TemplateMeta {
        schema_version: 1,
        id: target_id.to_string(),
        display_name: display_name.clone(),
        description: description.clone(),
        source_kind: unit.source_kind.clone(),
        source_pack: source_pack.clone(),
        canvas_format: unit.canvas_format.clone(),
        canvas_width: unit.canvas_width,
        canvas_height: unit.canvas_height,
        page_count: unit.pages.len() as i64,
        page_types: page_types.clone(),
        supports_structured: unit.supports_structured,
        supports_legacy: unit.supports_legacy,
        cover_file: cover_file.clone(),
        content_hash: Some(content_hash.clone()),
        imported_at: imported_at.clone(),
    };
    fs::write(
        stage_target.join(META_NAME),
        serde_json::to_vec_pretty(&meta)?,
    )?;

    let final_dir = templates_dir.join(target_id);
    atomic_replace_dir(stage_target, &final_dir)?;

    let tpl = PptUserTemplate {
        id: target_id.to_string(),
        display_name,
        description,
        dir_path: final_dir.to_string_lossy().to_string(),
        source_kind: unit.source_kind.clone(),
        source_pack,
        canvas_format: unit.canvas_format.clone(),
        canvas_width: unit.canvas_width,
        canvas_height: unit.canvas_height,
        page_count: unit.pages.len() as i64,
        page_types,
        supports_structured: unit.supports_structured,
        supports_legacy: unit.supports_legacy,
        cover_file,
        content_hash: Some(content_hash),
        enabled: true,
        status: "ok".to_string(),
        created_at: String::new(),
        updated_at: String::new(),
    };
    db.upsert_ppt_user_template(&tpl)
}

fn atomic_replace_dir(stage: &Path, final_dir: &Path) -> Result<(), AppError> {
    if !final_dir.exists() {
        fs::rename(stage, final_dir)?;
        return Ok(());
    }
    let parent = final_dir
        .parent()
        .ok_or_else(|| AppError::Custom("模板目录没有父目录".into()))?;
    let backup = parent.join(format!(".bak-{}", Uuid::new_v4()));
    fs::rename(final_dir, &backup)?;
    match fs::rename(stage, final_dir) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&backup);
            Ok(())
        }
        Err(err) => {
            let _ = fs::rename(&backup, final_dir);
            Err(err.into())
        }
    }
}

fn hash_template_dir(root: &Path) -> Result<String, AppError> {
    let mut files = Vec::new();
    for sub in ["templates", "images", "icons"] {
        let dir = root.join(sub);
        if !dir.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&dir).follow_links(false) {
            let entry = entry.map_err(|e| AppError::Custom(e.to_string()))?;
            if entry.file_type().is_file() {
                files.push(entry.path().to_path_buf());
            }
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

/// 把快照中的 SVG 文件名规范化为唯一页型，避免 `entry.py` 的 dict 覆盖。
fn normalize_snapshot_roster(roster: &Path) -> Result<(), AppError> {
    let mut files: Vec<PathBuf> = fs::read_dir(roster)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("svg"))
                    .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.is_empty() {
        return Ok(());
    }
    let mut totals: HashMap<String, usize> = HashMap::new();
    for file in &files {
        let name = file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("page.svg");
        *totals.entry(derive_page_type(name)).or_insert(0) += 1;
    }
    let mut used: HashMap<String, usize> = HashMap::new();
    let mut remaining: HashSet<PathBuf> = files.iter().cloned().collect();
    let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let name = file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("page.svg");
        let base = derive_page_type(name);
        let count = used.entry(base.clone()).or_insert(0);
        *count += 1;
        // 唯一页型保持原文件名，避免无谓改动与 design_spec 名称不一致。
        if totals.get(&base).copied().unwrap_or(0) <= 1 || *count == 1 {
            continue;
        }
        let page_type = format!("{}_{}", base, *count);
        let mut target = roster.join(format!("{:03}_{}.svg", index + 1, page_type));
        let mut suffix = 2;
        while remaining.contains(&target) {
            target = roster.join(format!(
                "{:03}_{}_{}.svg",
                index + 1,
                page_type,
                suffix
            ));
            suffix += 1;
        }
        remaining.remove(file);
        remaining.insert(target.clone());
        if target != *file {
            plan.push((file.clone(), target));
        }
    }
    if plan.is_empty() {
        return Ok(());
    }
    // 两阶段改名，避免目标名与现有文件冲突。
    let mut temps = Vec::new();
    for (index, (source, _)) in plan.iter().enumerate() {
        let temp = roster.join(format!(".renaming-{}.svg", index));
        fs::rename(source, &temp)?;
        temps.push(temp);
    }
    for (index, (_, target)) in plan.iter().enumerate() {
        fs::rename(&temps[index], target)?;
    }
    Ok(())
}

fn copy_tree_filtered(src: &Path, dst: &Path) -> Result<(), AppError> {
    if !src.is_dir() {
        return Ok(());
    }
    let mut total_files = 0usize;
    let mut total_bytes = 0u64;
    for entry in WalkDir::new(src).follow_links(false) {
        let entry = entry.map_err(|e| AppError::Custom(e.to_string()))?;
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(|e| AppError::Custom(e.to_string()))?;
        if rel.components().any(|c| match c {
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                name == "__pycache__"
                    || name == ".git"
                    || name == "exports"
                    || name == META_NAME
            }
            _ => false,
        }) {
            continue;
        }
        if entry.file_type().is_symlink() {
            continue;
        }
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if entry.file_type().is_file() {
            total_files += 1;
            if total_files > MAX_TEMPLATE_FILES {
                return Err(AppError::InvalidInput("模板文件过多".into()));
            }
            let size = entry.metadata().map_err(|e| AppError::Custom(e.to_string()))?.len();
            total_bytes = total_bytes.saturating_add(size);
            if total_bytes > MAX_TEMPLATE_BYTES {
                return Err(AppError::InvalidInput("模板体积过大".into()));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn same_template(a: &PptUserTemplate, b: &PptUserTemplate) -> bool {
    a.id == b.id
        && a.display_name == b.display_name
        && a.description == b.description
        && a.dir_path == b.dir_path
        && a.source_kind == b.source_kind
        && a.source_pack == b.source_pack
        && a.canvas_format == b.canvas_format
        && a.canvas_width == b.canvas_width
        && a.canvas_height == b.canvas_height
        && a.page_count == b.page_count
        && a.page_types == b.page_types
        && a.supports_structured == b.supports_structured
        && a.supports_legacy == b.supports_legacy
        && a.cover_file == b.cover_file
        && a.content_hash == b.content_hash
        && a.status == b.status
        && a.enabled == b.enabled
}

fn meta_to_template(meta: &TemplateMeta, dir: &Path, enabled: bool) -> PptUserTemplate {
    PptUserTemplate {
        id: meta.id.clone(),
        display_name: display_name_for(
            &meta.display_name,
            meta.source_pack.as_deref(),
            &meta.id,
        ),
        description: meta.description.clone(),
        dir_path: dir.to_string_lossy().to_string(),
        source_kind: meta.source_kind.clone(),
        source_pack: meta.source_pack.clone(),
        canvas_format: meta.canvas_format.clone(),
        canvas_width: meta.canvas_width,
        canvas_height: meta.canvas_height,
        page_count: meta.page_count,
        page_types: meta.page_types.clone(),
        supports_structured: meta.supports_structured,
        supports_legacy: meta.supports_legacy,
        cover_file: meta.cover_file.clone(),
        content_hash: meta.content_hash.clone(),
        enabled,
        status: "ok".into(),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn unit_to_template(
    unit: &TemplateUnit,
    dir: &Path,
    enabled: bool,
    content_hash: Option<String>,
) -> Result<PptUserTemplate, AppError> {
    Ok(PptUserTemplate {
        id: unit.id.clone(),
        display_name: unit.display_name.clone(),
        description: unit.description.clone(),
        dir_path: dir.to_string_lossy().to_string(),
        source_kind: unit.source_kind.clone(),
        source_pack: unit.source_pack.clone(),
        canvas_format: unit.canvas_format.clone(),
        canvas_width: unit.canvas_width,
        canvas_height: unit.canvas_height,
        page_count: unit.pages.len() as i64,
        page_types: unit.pages.iter().map(|p| p.page_type.clone()).collect(),
        supports_structured: unit.supports_structured,
        supports_legacy: unit.supports_legacy,
        cover_file: pick_cover(&unit.pages),
        content_hash,
        enabled,
        status: "ok".into(),
        created_at: String::new(),
        updated_at: String::new(),
    })
}

fn write_meta(dir: &Path, tpl: &PptUserTemplate) -> Result<(), AppError> {
    let meta = TemplateMeta {
        schema_version: 1,
        id: tpl.id.clone(),
        display_name: tpl.display_name.clone(),
        description: tpl.description.clone(),
        source_kind: tpl.source_kind.clone(),
        source_pack: tpl.source_pack.clone(),
        canvas_format: tpl.canvas_format.clone(),
        canvas_width: tpl.canvas_width,
        canvas_height: tpl.canvas_height,
        page_count: tpl.page_count,
        page_types: tpl.page_types.clone(),
        supports_structured: tpl.supports_structured,
        supports_legacy: tpl.supports_legacy,
        cover_file: tpl.cover_file.clone(),
        content_hash: tpl.content_hash.clone(),
        imported_at: chrono::Local::now().to_rfc3339(),
    };
    fs::write(dir.join(META_NAME), serde_json::to_vec_pretty(&meta)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_page_types_and_suffixes() {
        assert_eq!(derive_page_type("01_cover.svg"), "cover");
        assert_eq!(derive_page_type("002_content.svg"), "content");
        assert_eq!(derive_page_type("001a_cover.svg"), "cover");
        assert_eq!(derive_page_type("封面 1.svg"), "封面_1");
    }

    #[test]
    fn sanitizes_ids() {
        assert_eq!(sanitize_id("Aviation Training Blue"), "aviation-training-blue");
        assert_eq!(sanitize_id("../../evil"), "evil");
        assert!(sanitize_id("模板").starts_with("template-"));
    }

    #[test]
    fn fallback_name_prefers_pack_name_over_temp_dir() {
        let temp = Path::new("/data/ppt-templates/.tmp-abc123");
        assert_eq!(
            unit_fallback_name(temp, Some("航空装备与系统培训课件.zip")),
            "航空装备与系统培训课件"
        );
        let roster = Path::new("/data/ppt-templates/.tmp-abc123/templates");
        assert_eq!(
            unit_fallback_name(roster, Some("航空装备与系统培训课件.zip")),
            "航空装备与系统培训课件"
        );
        let named = Path::new("/data/ppt-templates/.tmp-abc123/航空模板/templates");
        assert_eq!(unit_fallback_name(named, Some("pack.zip")), "航空模板");
        assert_eq!(unit_fallback_name(Path::new("/tmp/pack/templates"), None), "pack");
    }

    #[test]
    fn display_name_recovers_legacy_temp_names() {
        assert_eq!(
            display_name_for(".tmp-f4daaa8d", Some("航空课件.zip"), "tmp-f4daaa8d"),
            "航空课件"
        );
        assert_eq!(display_name_for(".tmp-abc", None, "tmp-abc"), "tmp-abc");
        assert_eq!(
            display_name_for("浅色学术", Some("pack.zip"), "light"),
            "浅色学术"
        );
    }

    #[test]
    fn rejects_script_and_external_links() {
        assert!(forbidden_svg_reason("<svg><script>x</script></svg>").is_some());
        assert!(forbidden_svg_reason("<svg><a href=\"https://x\"/></svg>").is_some());
        assert!(forbidden_svg_reason("<svg><rect onload=\"x\"/></svg>").is_some());
        assert!(forbidden_svg_reason("<svg><rect fill=\"#fff\"/></svg>").is_none());
    }

    #[test]
    fn catalog_entry_uses_frontend_compatible_keys() {
        let entry = PptTemplateCatalogEntry {
            id: "demo".into(),
            name_zh: Some("演示".into()),
            description_zh: None,
            summary: Some("summary".into()),
            canvas_format: "ppt169".into(),
            page_count: 3,
            page_types: vec!["cover".into()],
            source: "user".into(),
            structured: 3,
            legacy: 0,
            supports_structured: true,
            supports_legacy: false,
        };
        let value = serde_json::to_value(entry).unwrap();
        assert!(value.get("nameZh").is_some());
        assert!(value.get("canvas_format").is_some());
        assert!(value.get("page_count").is_some());
        assert!(value.get("supportsStructured").is_some());
        assert!(value.get("name_zh").is_none());
    }

    #[test]
    fn reads_canvas_from_svg() {
        let svg = r#"<svg width="1280" height="720" viewBox="0 0 1280 720"></svg>"#;
        assert_eq!(svg_canvas(svg), Some((1280.0, 720.0)));
        let svg = r#"<svg viewBox="0 0 960 720"></svg>"#;
        assert_eq!(svg_canvas(svg), Some((960.0, 720.0)));
    }

    #[test]
    fn dedups_duplicate_page_types() {
        let dir = std::env::temp_dir().join(format!("ppt-tpl-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        for name in ["01_cover.svg", "02_content.svg", "03_content.svg"] {
            fs::write(dir.join(name), "<svg></svg>").unwrap();
        }
        let pages = scan_pages(&dir).unwrap();
        let types: Vec<&str> = pages.iter().map(|p| p.page_type.as_str()).collect();
        assert_eq!(types, vec!["cover", "content", "content_2"]);
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_test_template(root: &Path, layout_id: &str) {
        let templates = root.join("templates");
        fs::create_dir_all(&templates).unwrap();
        fs::write(
            templates.join("design_spec.md"),
            format!(
                "---\nlayout_id: {layout_id}\nkind: layout\nsummary: 测试模板\ncanvas_format: ppt169\ncanvas_width: 1280\ncanvas_height: 720\n---\n# Test\n"
            ),
        )
        .unwrap();
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><g data-pptx-placeholder="title" data-pptx-bounds="80 50 1000 60"><text data-pptx-carrier="true">{{TITLE}}</text></g></svg>"#;
        fs::write(templates.join("01_cover.svg"), svg).unwrap();
        fs::write(templates.join("02_content.svg"), svg).unwrap();
        fs::write(templates.join("03_content.svg"), svg).unwrap();
        let images = root.join("images");
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("logo.png"), b"png").unwrap();
    }

    #[test]
    #[ignore = "依赖 test-data/ppt-templates 下的真实模板包"]
    fn imports_real_aviation_zip_pack() {
        let zip = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-data")
            .join("ppt-templates")
            .join("user")
            .join("aviation_training_blue-user.zip");
        if !zip.is_file() {
            return;
        }
        let root = std::env::temp_dir().join(format!("ppt-tpl-zip-{}", Uuid::new_v4()));
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        let db = Database::init(":memory:").unwrap();
        let previews = PptTemplateService::inspect(&db, &data, zip.to_str().unwrap()).unwrap();
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].page_count, 11);
        let result = PptTemplateService::install(
            &db,
            &data,
            PptTemplateInstallInput {
                path: zip.to_str().unwrap().to_string(),
                selections: vec![crate::models::ppt_template::PptTemplateInstallSelection {
                    id: "aviation_training_blue".into(),
                    display_name: None,
                    description: None,
                    conflict: Some(PptTemplateConflictPolicy::Reject),
                    keep_images: Some(true),
                }],
            },
        )
        .unwrap();
        assert_eq!(result.installed.len(), 1, "{:?}", result.failed);
        let dir = data.join("ppt-templates").join("aviation_training_blue");
        assert!(dir.join("images").join("AVIC-ICON.png").is_file());
        // exports/ 不应被安装。
        assert!(!dir.join("exports").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "依赖 test-data/ppt-templates 下的真实模板包"]
    fn imports_real_aviation_training_blue_pack() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-data")
            .join("ppt-templates")
            .join("user")
            .join("aviation_training_blue");
        if !source.is_dir() {
            return;
        }
        let root = std::env::temp_dir().join(format!("ppt-tpl-real-{}", Uuid::new_v4()));
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        let db = Database::init(":memory:").unwrap();
        let previews =
            PptTemplateService::inspect(&db, &data, source.to_str().unwrap()).unwrap();
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].id, "aviation_training_blue");
        assert_eq!(previews[0].page_count, 11);
        let result = PptTemplateService::install(
            &db,
            &data,
            PptTemplateInstallInput {
                path: source.to_str().unwrap().to_string(),
                selections: vec![crate::models::ppt_template::PptTemplateInstallSelection {
                    id: "aviation_training_blue".into(),
                    display_name: None,
                    description: None,
                    conflict: Some(PptTemplateConflictPolicy::Reject),
                    keep_images: Some(true),
                }],
            },
        )
        .unwrap();
        assert_eq!(result.installed.len(), 1, "{:?}", result.failed);
        let dir = data.join("ppt-templates").join("aviation_training_blue");
        assert!(dir.join("images").join("AVIC-ICON.png").is_file());
        assert!(PptTemplateService::verify(&db, "aviation_training_blue").unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_install_catalog_and_snapshot() {
        let root = std::env::temp_dir().join(format!("ppt-tpl-int-{}", Uuid::new_v4()));
        let source = root.join("source");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        write_test_template(&source, "test_layout");

        let db = Database::init(":memory:").unwrap();
        let previews = PptTemplateService::inspect(&db, &data, source.to_str().unwrap()).unwrap();
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].id, "test_layout");
        assert_eq!(previews[0].page_count, 3);
        assert_eq!(
            previews[0].page_types,
            vec!["cover".to_string(), "content".to_string(), "content_2".to_string()]
        );
        assert!(previews[0].supports_structured);
        assert!(previews[0].supports_legacy);

        let result = PptTemplateService::install(
            &db,
            &data,
            PptTemplateInstallInput {
                path: source.to_str().unwrap().to_string(),
                selections: vec![crate::models::ppt_template::PptTemplateInstallSelection {
                    id: "test_layout".into(),
                    display_name: Some("测试模板".into()),
                    description: None,
                    conflict: Some(PptTemplateConflictPolicy::Reject),
                    keep_images: Some(true),
                }],
            },
        )
        .unwrap();
        assert_eq!(result.installed.len(), 1);
        let installed = &result.installed[0];
        assert_eq!(installed.display_name, "测试模板");
        let dir = data.join("ppt-templates").join("test_layout");
        assert!(dir.join("meta.json").is_file());
        assert!(dir.join("templates").join("001_cover.svg").is_file());
        assert!(dir.join("templates").join("003_content_2.svg").is_file());
        assert!(dir.join("images").join("logo.png").is_file());
        assert!(PptTemplateService::verify(&db, "test_layout").unwrap());

        let catalog = PptTemplateService::catalog(&db).unwrap();
        assert_eq!(catalog.layouts.get("test_layout").unwrap().source, "user");

        let job = root.join("job");
        let resolved = ResolvedPptLayout {
            workspace_root: dir.clone(),
            roster_dir: dir.join("templates"),
            source: "user".into(),
        };
        let roster =
            PptTemplateService::ensure_job_template_snapshot(&job, &resolved, "test_layout")
                .unwrap();
        assert!(roster.join("001_cover.svg").is_file());
        assert!(job.join("templates").join("layout_test_layout").join("images").join("logo.png").is_file());

        // 冲突策略：默认拒绝；改名则生成 -2。
        let dup = PptTemplateService::install(
            &db,
            &data,
            PptTemplateInstallInput {
                path: source.to_str().unwrap().to_string(),
                selections: vec![crate::models::ppt_template::PptTemplateInstallSelection {
                    id: "test_layout".into(),
                    display_name: None,
                    description: None,
                    conflict: Some(PptTemplateConflictPolicy::Reject),
                    keep_images: None,
                }],
            },
        )
        .unwrap();
        assert_eq!(dup.failed.len(), 1);

        let renamed = PptTemplateService::install(
            &db,
            &data,
            PptTemplateInstallInput {
                path: source.to_str().unwrap().to_string(),
                selections: vec![crate::models::ppt_template::PptTemplateInstallSelection {
                    id: "test_layout".into(),
                    display_name: None,
                    description: None,
                    conflict: Some(PptTemplateConflictPolicy::Rename),
                    keep_images: None,
                }],
            },
        )
        .unwrap();
        assert_eq!(renamed.installed[0].id, "test_layout-2");

        let export = root.join("export.zip");
        PptTemplateService::export_pack(&db, "test_layout", export.to_str().unwrap()).unwrap();
        assert!(export.is_file());
        assert!(fs::metadata(&export).unwrap().len() > 0);

        let _ = fs::remove_dir_all(&root);
    }
}
