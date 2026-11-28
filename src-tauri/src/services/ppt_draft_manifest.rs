//! PPT 草稿的页级指纹与整册一致性判定。
//!
//! 设计目标（与 docs/ppt-preview-plan.md 对齐）：
//! - 每页记录三种指纹：`outlineHash`（大纲内容）、`renderInputHash`
//!   （版式/图表/生成方式/模型）、`svgHash`（落盘产物）。
//! - 整册以「页序 + 每页指纹」判定是否改变；单页重新生成只更新该页，
//!   不会把整份草稿标记为未完成。
//! - 判定结果是派生状态，不写入 SQLite；manifest 以文件形式存放于
//!   `project/draft_manifest.json`，使用原子写。
//!
//! 「加页又删页」之所以能回到 fresh：只要最终 plan 与 manifest 的内容指纹
//! 一致，就不需要重新渲染，也不需要重新导出。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AppError;
use crate::models::extension::{PptPlan, PptSlide};
use crate::services::hash::{sha256_file_hex, sha256_hex};

pub const MANIFEST_FILE: &str = "draft_manifest.json";
const MANIFEST_VERSION: u32 = 1;

/// 单页草稿记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftPageEntry {
    pub page: u32,
    /// 大纲内容指纹（规范化 JSON 的 SHA-256）。
    pub outline_hash: String,
    /// 渲染输入指纹（大纲 + 版式 + 图表 + 生成方式 + 模型）。
    pub render_input_hash: String,
    /// 落盘 SVG 的 SHA-256。
    pub svg_hash: String,
    /// 相对 project 的 SVG 路径，如 `svg_output/P01.svg`。
    pub svg: String,
    /// 生成方式：programmatic / oneShot / bestOf / template。
    pub mode: String,
    pub status: String,
    pub generated_at: String,
}

/// 整册草稿清单。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DraftManifest {
    #[serde(default)]
    pub version: u32,
    /// 当前页序（plan 的 page 序列）。
    #[serde(default)]
    pub order: Vec<u32>,
    #[serde(default)]
    pub pages: Vec<DraftPageEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_deck_hash: Option<String>,
}

impl DraftManifest {
    pub fn page(&self, page: u32) -> Option<&DraftPageEntry> {
        self.pages.iter().find(|entry| entry.page == page)
    }
}

/// 页级判定结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftPageStatus {
    pub page: u32,
    /// ready / outline_changed / options_changed / missing
    pub status: String,
    pub message: String,
}

/// 整册判定结果。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DraftStatus {
    /// fresh / order_stale / partial / stale / missing
    pub status: String,
    pub order_changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deck_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_deck_hash: Option<String>,
    pub pages: Vec<DraftPageStatus>,
}

/// `update_plan` 逐页 diff 的结果。
#[derive(Debug, Clone, Default)]
pub struct PruneOutcome {
    /// 所有页的大纲指纹与落盘文件都匹配（可保持 draft_ready）。
    pub all_ready: bool,
}

pub fn manifest_path(job_dir: &Path) -> PathBuf {
    job_dir.join("project").join(MANIFEST_FILE)
}

pub fn read(job_dir: &Path) -> Option<DraftManifest> {
    let text = fs::read_to_string(manifest_path(job_dir)).ok()?;
    serde_json::from_str::<DraftManifest>(&text).ok()
}

/// 原子写入 manifest：临时文件 + 替换。
pub fn write(job_dir: &Path, manifest: &DraftManifest) -> Result<(), AppError> {
    let path = manifest_path(job_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = parent_or(&path).join(format!(
        ".{}.{}.tmp",
        MANIFEST_FILE,
        uuid::Uuid::new_v4()
    ));
    fs::write(&temp, serde_json::to_vec_pretty(manifest)?)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    fs::rename(&temp, &path)?;
    Ok(())
}

fn parent_or(path: &Path) -> &Path {
    path.parent().unwrap_or_else(|| Path::new("."))
}

fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

fn svg_rel(page: u32) -> String {
    format!("svg_output/P{page:02}.svg")
}

/// 大纲内容指纹。只纳入影响画面的字段，页面页码参与计算
/// （页序变化会被整册 order 单独捕捉，这里保留 page 便于单页定位）。
pub fn outline_hash(slide: &PptSlide) -> String {
    let canonical = json!({
        "page": slide.page,
        "title": slide.title,
        "coreMessage": slide.core_message,
        "bullets": slide.bullets,
        "chart": slide.chart,
        "images": slide.images,
        "pageTheme": slide.page_theme,
        "mainClaim": slide.main_claim,
        "contentScope": slide.content_scope,
        "contentBlocks": slide.content_blocks,
        "evidence": slide.evidence,
        "relation": slide.relation,
        "chartType": slide.chart_type,
        "density": slide.density,
        "visualIntent": slide.visual_intent,
    });
    let text = serde_json::to_string(&canonical).unwrap_or_default();
    sha256_hex(&text)
}

/// 渲染输入指纹。任何影响画面效果的选项变化都会让所有页失效
/// （但旧 SVG 仍保留用于预览，导出会被拦截）。
pub fn render_input_hash(outline_hash: &str, spec: &Value) -> String {
    let layout = spec
        .pointer("/templates/layoutId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut chart_ids: Vec<String> = spec
        .pointer("/templates/chartIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    chart_ids.sort();
    let native = spec
        .pointer("/options/nativeCharts")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mode = spec
        .pointer("/options/generationMode")
        .and_then(Value::as_str)
        .unwrap_or("");
    let model = spec
        .pointer("/options/modelId")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    sha256_hex(&format!(
        "outline={outline_hash}|layout={layout}|charts={}|native={native}|mode={mode}|model={model}",
        chart_ids.join(",")
    ))
}

pub fn mode_from_spec(spec: &Value) -> String {
    spec.pointer("/options/generationMode")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("programmatic")
        .to_string()
}

/// 落盘 SVG 的哈希；文件不存在返回 None。
pub fn svg_hash(job_dir: &Path, page: u32) -> Option<String> {
    let path = job_dir
        .join("project")
        .join("svg_output")
        .join(format!("P{page:02}.svg"));
    if !path.is_file() {
        return None;
    }
    sha256_file_hex(&path).ok()
}

/// 以当前 plan + 磁盘 SVG 重建整册 manifest（渲染结束、旧作业迁移时使用）。
/// `renderInputHash` 使用当前 spec，表示「这些 SVG 对应当前选项」。
pub fn rebuild(
    job_dir: &Path,
    plan: &PptPlan,
    spec: &Value,
) -> Result<DraftManifest, AppError> {
    let previous = read(job_dir);
    let default_mode = mode_from_spec(spec);
    let mut pages = Vec::new();
    for slide in &plan.slides {
        let Some(svg_hash) = svg_hash(job_dir, slide.page) else {
            continue;
        };
        let outline = outline_hash(slide);
        let mode = previous
            .as_ref()
            .and_then(|manifest| manifest.page(slide.page))
            .map(|entry| entry.mode.clone())
            .unwrap_or_else(|| default_mode.clone());
        pages.push(DraftPageEntry {
            page: slide.page,
            render_input_hash: render_input_hash(&outline, spec),
            outline_hash: outline,
            svg_hash,
            svg: svg_rel(slide.page),
            mode,
            status: "ready".into(),
            generated_at: now(),
        });
    }
    let manifest = DraftManifest {
        version: MANIFEST_VERSION,
        order: plan.slides.iter().map(|slide| slide.page).collect(),
        pages,
        exported_deck_hash: previous.and_then(|manifest| manifest.exported_deck_hash),
    };
    write(job_dir, &manifest)?;
    Ok(manifest)
}

/// 单页生成/重生成后更新该页记录（其他页保持不变）。
pub fn upsert_page(
    job_dir: &Path,
    plan: &PptPlan,
    spec: &Value,
    page: u32,
) -> Result<(), AppError> {
    let Some(slide) = plan.slides.iter().find(|slide| slide.page == page) else {
        return Ok(());
    };
    let Some(svg_hash) = svg_hash(job_dir, page) else {
        return Ok(());
    };
    let mut manifest = read(job_dir).unwrap_or_default();
    let outline = outline_hash(slide);
    let mode = manifest
        .page(page)
        .map(|entry| entry.mode.clone())
        .unwrap_or_else(|| mode_from_spec(spec));
    manifest.pages.retain(|entry| entry.page != page);
    manifest.pages.push(DraftPageEntry {
        page,
        render_input_hash: render_input_hash(&outline, spec),
        outline_hash: outline,
        svg_hash,
        svg: svg_rel(page),
        mode,
        status: "ready".into(),
        generated_at: now(),
    });
    manifest.pages.sort_by_key(|entry| entry.page);
    manifest.version = MANIFEST_VERSION;
    manifest.order = plan.slides.iter().map(|slide| slide.page).collect();
    write(job_dir, &manifest)
}

/// 仅刷新该页产物哈希（切换候选等）：保留原有大纲/渲染输入指纹，
/// 避免用当前 spec 覆盖历史条目而误判 options_changed 已修复。
pub fn refresh_page_svg(
    job_dir: &Path,
    plan: &PptPlan,
    spec: &Value,
    page: u32,
) -> Result<(), AppError> {
    let Some(svg_hash) = svg_hash(job_dir, page) else {
        return Ok(());
    };
    let Some(mut manifest) = read(job_dir) else {
        return upsert_page(job_dir, plan, spec, page);
    };
    if let Some(entry) = manifest.pages.iter_mut().find(|entry| entry.page == page) {
        entry.svg_hash = svg_hash;
        entry.status = "ready".into();
        entry.generated_at = now();
        manifest.version = MANIFEST_VERSION;
        write(job_dir, &manifest)
    } else {
        upsert_page(job_dir, plan, spec, page)
    }
}

/// 导出前会清洗 AI 页面的 SVG（移除不兼容属性），需要同步更新哈希，
/// 否则导出后状态会误判为「文件被修改」。
pub fn refresh_svg_hashes(job_dir: &Path, plan: &PptPlan) -> Result<(), AppError> {
    let Some(mut manifest) = read(job_dir) else {
        return Ok(());
    };
    let mut changed = false;
    let mut keep: Vec<DraftPageEntry> = Vec::new();
    for mut entry in manifest.pages.drain(..) {
        match svg_hash(job_dir, entry.page) {
            Some(hash) => {
                if hash != entry.svg_hash {
                    entry.svg_hash = hash;
                    changed = true;
                }
                if plan.slides.iter().any(|slide| slide.page == entry.page) {
                    keep.push(entry);
                } else {
                    changed = true;
                }
            }
            None => {
                changed = true;
            }
        }
    }
    manifest.pages = keep;
    if changed {
        manifest.version = MANIFEST_VERSION;
        write(job_dir, &manifest)?;
    }
    Ok(())
}

/// `update_plan` 的逐页 diff：
/// - 内容未变（同页号 + 同大纲指纹）且文件存在 → 保留；
/// - 内容变化 / 被删除 → 清理该页 SVG、候选与 selection 条目；
/// - 模板预览（svg_preview）始终清空。
pub fn prune_after_plan_change(
    job_dir: &Path,
    old_plan: &PptPlan,
    new_plan: &PptPlan,
) -> Result<PruneOutcome, AppError> {
    let project = job_dir.join("project");
    let mut manifest = read(job_dir).unwrap_or_default();

    for slide in &new_plan.slides {
        let keep = old_plan
            .slides
            .iter()
            .find(|old| old.page == slide.page)
            .map(|old| outline_hash(old) == outline_hash(slide))
            .unwrap_or(false)
            && svg_hash(job_dir, slide.page).is_some();
        if !keep {
            remove_page_assets(&project, slide.page)?;
            manifest.pages.retain(|entry| entry.page != slide.page);
        }
    }
    for old in &old_plan.slides {
        if new_plan.slides.iter().any(|slide| slide.page == old.page) {
            continue;
        }
        remove_page_assets(&project, old.page)?;
        manifest.pages.retain(|entry| entry.page != old.page);
    }

    clear_svg_dir(&project.join("svg_preview"))?;

    manifest.version = MANIFEST_VERSION;
    manifest.order = new_plan.slides.iter().map(|slide| slide.page).collect();
    write(job_dir, &manifest)?;

    let all_ready = !new_plan.slides.is_empty()
        && new_plan.slides.iter().all(|slide| {
            manifest
                .page(slide.page)
                .map(|entry| entry.outline_hash == outline_hash(slide))
                .unwrap_or(false)
                && svg_hash(job_dir, slide.page).is_some()
        });
    Ok(PruneOutcome { all_ready })
}

fn remove_page_assets(project: &Path, page: u32) -> Result<(), AppError> {
    let svg = project.join("svg_output").join(format!("P{page:02}.svg"));
    if svg.is_file() {
        let _ = fs::remove_file(&svg);
    }
    let candidates = project.join("candidates");
    if candidates.is_dir() {
        let prefix = format!("P{page:02}_");
        for entry in fs::read_dir(&candidates)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && name.ends_with(".svg") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    remove_selection_page(project, page)?;
    Ok(())
}

fn remove_selection_page(project: &Path, page: u32) -> Result<(), AppError> {
    let path = project.join("page_selection.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
        return Ok(());
    };
    let Some(pages) = value.get_mut("pages").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let before = pages.len();
    pages.retain(|item| item.get("page").and_then(Value::as_u64) != Some(page as u64));
    if pages.len() != before {
        fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&value)?))?;
    }
    Ok(())
}

fn clear_svg_dir(dir: &Path) -> Result<(), AppError> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("svg"))
            .unwrap_or(false)
        {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

/// 当前整册一致性判定。manifest 缺失或版本过旧时先按磁盘 SVG 迁移。
pub fn compare(job_dir: &Path, plan: &PptPlan, spec: &Value) -> DraftStatus {
    let manifest = match read(job_dir) {
        Some(manifest) if manifest.version == MANIFEST_VERSION => manifest,
        _ => rebuild(job_dir, plan, spec).unwrap_or_default(),
    };
    let order: Vec<u32> = plan.slides.iter().map(|slide| slide.page).collect();
    let order_changed = manifest.order != order;

    let mut pages = Vec::new();
    let mut ready = 0usize;
    let mut outline_changed = 0usize;
    let mut options_changed = 0usize;

    for slide in &plan.slides {
        let expected_outline = outline_hash(slide);
        let expected_render = render_input_hash(&expected_outline, spec);
        let entry = manifest.page(slide.page);
        let (status, message) = match entry {
            None => ("missing", "未生成"),
            Some(entry) if entry.outline_hash != expected_outline => {
                ("outline_changed", "大纲已修改")
            }
            Some(entry) if entry.render_input_hash != expected_render => {
                ("options_changed", "模板或生成方式已修改")
            }
            Some(entry) => match svg_hash(job_dir, slide.page) {
                Some(hash) if hash == entry.svg_hash => {
                    ready += 1;
                    ("ready", "已完成")
                }
                _ => ("missing", "草稿文件缺失"),
            },
        };
        match status {
            "outline_changed" => outline_changed += 1,
            "options_changed" => options_changed += 1,
            _ => {}
        }
        pages.push(DraftPageStatus {
            page: slide.page,
            status: status.into(),
            message: message.into(),
        });
    }

    let total = plan.slides.len();
    let status = if total == 0 {
        "missing"
    } else if ready == total {
        if order_changed {
            "order_stale"
        } else {
            "fresh"
        }
    } else if ready == 0 {
        "missing"
    } else if outline_changed > 0 || options_changed > 0 {
        "stale"
    } else {
        "partial"
    };

    let deck_hash = if ready == total {
        deck_hash(&manifest, plan)
    } else {
        None
    };

    DraftStatus {
        status: status.into(),
        order_changed,
        deck_hash,
        exported_deck_hash: manifest.exported_deck_hash.clone(),
        pages,
    }
}

/// 导出前置校验：仅 fresh / order_stale 放行。
pub fn export_guard(status: &DraftStatus) -> Result<(), AppError> {
    if status.status == "fresh" || status.status == "order_stale" {
        return Ok(());
    }
    let detail = status
        .pages
        .iter()
        .filter(|page| page.status != "ready")
        .take(6)
        .map(|page| format!("P{:02} {}", page.page, page.message))
        .collect::<Vec<_>>()
        .join("；");
    let suffix = if detail.is_empty() { String::new() } else { format!("：{detail}") };
    Err(AppError::InvalidInput(format!(
        "草稿未就绪，请先生成草稿后再导出{suffix}"
    )))
}

/// 导出成功后记录当前整册指纹，便于区分「需要重新导出」。
pub fn mark_exported(job_dir: &Path, plan: &PptPlan) -> Result<(), AppError> {
    let Some(mut manifest) = read(job_dir) else {
        return Ok(());
    };
    manifest.exported_deck_hash = deck_hash(&manifest, plan);
    manifest.version = MANIFEST_VERSION;
    write(job_dir, &manifest)
}

fn deck_hash(manifest: &DraftManifest, plan: &PptPlan) -> Option<String> {
    let mut parts = Vec::new();
    for slide in &plan.slides {
        let entry = manifest.page(slide.page)?;
        parts.push(format!(
            "{}:{}:{}:{}",
            slide.page, entry.outline_hash, entry.render_input_hash, entry.svg_hash
        ));
    }
    if parts.is_empty() {
        return None;
    }
    Some(sha256_hex(&parts.join("|")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::extension::PptSlide;

    fn slide(page: u32, title: &str) -> PptSlide {
        PptSlide {
            page,
            title: title.into(),
            core_message: format!("message {title}"),
            bullets: vec![format!("bullet {title}")],
            ..Default::default()
        }
    }

    fn plan(titles: &[&str]) -> PptPlan {
        PptPlan {
            title: "test".into(),
            slides: titles
                .iter()
                .enumerate()
                .map(|(index, title)| slide(index as u32 + 1, title))
                .collect(),
        }
    }

    fn temp_job() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ppt-manifest-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("project").join("svg_output")).unwrap();
        dir
    }

    fn write_svg(job: &Path, page: u32, body: &str) {
        fs::write(
            job.join("project").join("svg_output").join(format!("P{page:02}.svg")),
            format!("<svg xmlns=\"http://www.w3.org/2000/svg\">{body}</svg>"),
        )
        .unwrap();
    }

    #[test]
    fn add_then_remove_page_returns_fresh() {
        let job = temp_job();
        let base = plan(&["a", "b", "c"]);
        for slide in &base.slides {
            write_svg(&job, slide.page, &slide.title);
        }
        let spec = json!({ "options": { "generationMode": "oneShot" } });
        let manifest = rebuild(&job, &base, &spec).unwrap();
        assert_eq!(manifest.pages.len(), 3);

        // 新增页只存在于前端 plan，后端不感知 → partial
        let added = plan(&["a", "b", "c", "d"]);
        let status = compare(&job, &added, &spec);
        assert_eq!(status.status, "partial");

        // 删除回原计划 → fresh，且未调用任何重渲染
        let status = compare(&job, &base, &spec);
        assert_eq!(status.status, "fresh");
        let _ = fs::remove_dir_all(job);
    }

    #[test]
    fn single_page_regenerate_keeps_deck_fresh() {
        let job = temp_job();
        let base = plan(&["a", "b", "c"]);
        for slide in &base.slides {
            write_svg(&job, slide.page, &slide.title);
        }
        let spec = json!({ "options": { "generationMode": "oneShot" } });
        rebuild(&job, &base, &spec).unwrap();

        write_svg(&job, 2, "regenerated-b");
        upsert_page(&job, &base, &spec, 2).unwrap();

        let status = compare(&job, &base, &spec);
        assert_eq!(status.status, "fresh");
        let _ = fs::remove_dir_all(job);
    }

    #[test]
    fn outline_change_only_invalidates_that_page() {
        let job = temp_job();
        let base = plan(&["a", "b", "c"]);
        for slide in &base.slides {
            write_svg(&job, slide.page, &slide.title);
        }
        let spec = json!({ "options": { "generationMode": "oneShot" } });
        rebuild(&job, &base, &spec).unwrap();

        let mut changed = base.clone();
        changed.slides[1].bullets = vec!["updated".into()];
        let status = compare(&job, &changed, &spec);
        assert_eq!(status.status, "stale");
        assert_eq!(status.pages[1].status, "outline_changed");
        assert_eq!(status.pages[0].status, "ready");
        let _ = fs::remove_dir_all(job);
    }

    #[test]
    fn options_change_marks_all_pages_stale_but_keeps_files() {
        let job = temp_job();
        let base = plan(&["a"]);
        write_svg(&job, 1, "a");
        let spec = json!({ "options": { "generationMode": "oneShot" } });
        rebuild(&job, &base, &spec).unwrap();

        let next = json!({
            "options": { "generationMode": "oneShot" },
            "templates": { "layoutId": "some_template" }
        });
        let status = compare(&job, &base, &next);
        assert_eq!(status.pages[0].status, "options_changed");
        assert!(svg_hash(&job, 1).is_some());
        let _ = fs::remove_dir_all(job);
    }

    #[test]
    fn prune_keeps_prefix_and_drops_changed_pages() {
        let job = temp_job();
        let base = plan(&["a", "b", "c"]);
        for slide in &base.slides {
            write_svg(&job, slide.page, &slide.title);
        }
        let spec = json!({ "options": { "generationMode": "oneShot" } });
        rebuild(&job, &base, &spec).unwrap();

        // 删除中间页后，后续页面需要按新页序重新生成；前缀未变页保留。
        let next = plan(&["a", "c"]);
        let outcome = prune_after_plan_change(&job, &base, &next).unwrap();
        assert!(!outcome.all_ready);
        assert!(svg_hash(&job, 1).is_some());
        assert!(svg_hash(&job, 2).is_none());
        assert!(svg_hash(&job, 3).is_none());
        assert_eq!(read(&job).unwrap().pages.len(), 1);
        let _ = fs::remove_dir_all(job);
    }

    #[test]
    fn order_mismatch_is_reported_as_order_stale() {
        let job = temp_job();
        let base = plan(&["a", "b"]);
        for slide in &base.slides {
            write_svg(&job, slide.page, &slide.title);
        }
        let spec = json!({ "options": { "generationMode": "oneShot" } });
        let mut manifest = rebuild(&job, &base, &spec).unwrap();
        // 模拟 manifest 记录的页序与当前 plan 不一致（例如手工恢复的旧清单）。
        manifest.order = vec![2, 1];
        write(&job, &manifest).unwrap();

        let status = compare(&job, &base, &spec);
        assert!(status.order_changed);
        assert_eq!(status.status, "order_stale");
        let _ = fs::remove_dir_all(job);
    }
}
