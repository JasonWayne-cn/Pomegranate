//! PPT 生成作业：多文档收集、AI 规划、扩展进程调度、产物校验。
//!
//! 作业目录：
//! `<data_dir>/ppt-workspace/<jobId>/{input,project,output,logs}`

use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::database::Database;
use crate::error::AppError;
use crate::models::AiModel;
use crate::models::extension::{
    ExtensionInfo, PptDraftPage, PptJob, PptJobInput, PptLocalFileSource, PptMetaSource,
    PptMetaSuggestion, PptPlan, PptSlide, PptSourceMeta,
};
use crate::services::ai::AiService;
use crate::services::doc_extract::DocExtractService;
use crate::services::excel_import::ExcelImportService;
use crate::services::extension::ExtensionService;
use crate::services::extension_runner;
use crate::services::import::read_text_auto_encoding;
use crate::services::note::NoteService;
use crate::services::pdf::PdfService;
use crate::services::ppt_programmatic_renderer;
use crate::services::ppt_plan;
use crate::services::ppt_template::PptTemplateService;
use crate::services::safe_filename;

const MAX_SOURCE_CHARS: usize = 200_000;
const MAX_PER_SOURCE_CHARS: usize = 40_000;
const DEFAULT_TIMEOUT_SECS: u64 = 900;
const DEFAULT_PLANNING_TIMEOUT_SECS: u64 = 420;
const MAX_PLANNING_ATTEMPTS: usize = 2;
const MAX_DRAFT_PAGES: usize = 120;
const MAX_DRAFT_PAGE_BYTES: u64 = 8 * 1024 * 1024;
/// running 作业超过该分钟数、且产物也长时间无更新，视为僵尸作业。
const STALE_JOB_MINUTES: i64 = 30;
/// 产物最近一次更新距今超过该分钟数，才允许判定为僵尸，避免误杀慢速渲染。
const STALE_ACTIVITY_MINUTES: u64 = 15;

pub const STAGE_OUTLINE_READY: &str = "outline_ready";
pub const STAGE_RENDERING_DRAFT: &str = "rendering_draft";
pub const STAGE_DRAFT_READY: &str = "draft_ready";
pub const STAGE_EXPORTING: &str = "exporting";
pub const STAGE_DONE: &str = "done";

/// 引擎运行阶段：写入 job.json 的 options.stage。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PptRunStage {
    Render,
    Export,
    Full,
}

impl PptRunStage {
    pub fn as_str(self) -> &'static str {
        match self {
            PptRunStage::Render => "render",
            PptRunStage::Export => "export",
            PptRunStage::Full => "full",
        }
    }

    fn running_stage(self) -> &'static str {
        match self {
            PptRunStage::Render | PptRunStage::Full => STAGE_RENDERING_DRAFT,
            PptRunStage::Export => STAGE_EXPORTING,
        }
    }
}

#[derive(Debug)]
enum PlanRunError {
    Cancelled,
    Timeout,
    Ai(String),
}

/// 草稿生成方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftGenerationMode {
    /// 每页 1 次 AI，连续生成，失败修复 1 次；接近上游 skill 的连续生成。
    OneShot,
    /// Rust 程序化渲染，每页 3 个 motif 候选选 1。
    Programmatic,
    /// 当前多候选：自适应 1–3 个 AI 候选 + 评分 + 评审。
    BestOf,
}

impl DraftGenerationMode {
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("bestOf").trim().to_ascii_lowercase().as_str() {
            "oneshot" | "one-shot" | "single" => Self::OneShot,
            "programmatic" | "program" | "rust" => Self::Programmatic,
            _ => Self::BestOf,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OneShot => "oneShot",
            Self::Programmatic => "programmatic",
            Self::BestOf => "bestOf",
        }
    }
}

pub struct PptExtensionService;

fn emit_system_log(app: Option<&AppHandle>, message: &str) {
    if let Some(app) = app {
        let _ = app.emit(
            "ppt-extension://log",
            json!({
                "jobId": "",
                "stream": "system",
                "line": message,
            }),
        );
    }
}

fn emit_plan_progress(
    app: Option<&AppHandle>,
    job_id: &str,
    stage: &str,
    current: usize,
    total: usize,
    message: &str,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "ppt-extension://plan-progress",
            json!({
                "jobId": job_id,
                "stage": stage,
                "current": current,
                "total": total,
                "message": message,
            }),
        );
    }
}

/// 大纲阶段日志同时落盘到 `<作业>/logs/plan.log`。
///
/// 之前 `emit_system_log` 只往前端发事件，窗口关掉或页面切换后日志就丢了，
/// 无法事后判断"这次重新生成大纲到底卡在哪一步、花了多久"。
struct PlanLog {
    file: Mutex<Option<fs::File>>,
}

impl PlanLog {
    fn for_job(job_dir: &Path) -> Self {
        let logs_dir = job_dir.join("logs");
        let _ = fs::create_dir_all(&logs_dir);
        let path = logs_dir.join("plan.log");
        let file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .ok();
        let log = Self {
            file: Mutex::new(file),
        };
        log.write(&format!(
            "=== 大纲生成开始 {} ===",
            chrono::Local::now().to_rfc3339()
        ));
        log
    }

    fn write(&self, message: &str) {
        let Ok(mut guard) = self.file.lock() else {
            return;
        };
        let Some(file) = guard.as_mut() else {
            return;
        };
        use std::io::Write;
        let line = format!(
            "[{}] {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            message
        );
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }

    fn emit(&self, app: Option<&AppHandle>, message: &str) {
        emit_system_log(app, message);
        self.write(message);
    }

    fn finish(&self, message: &str) {
        self.write(message);
        self.write(&format!(
            "=== 大纲生成结束 {} ===",
            chrono::Local::now().to_rfc3339()
        ));
    }
}

/// 作业最近一次产物写入时间（只扫有限目录，避免全盘遍历）。
fn latest_activity_time(job_dir: &Path) -> Option<std::time::SystemTime> {
    let mut latest: Option<std::time::SystemTime> = None;
    let files = [
        job_dir.join("job.json"),
        job_dir.join("plan.json"),
        job_dir.join("project").join("page_selection.json"),
    ];
    for path in files {
        if let Ok(modified) = fs::metadata(&path).and_then(|meta| meta.modified()) {
            latest = Some(latest.map_or(modified, |current| current.max(modified)));
        }
    }
    let dirs = [
        job_dir.join("project").join("svg_output"),
        job_dir.join("logs"),
        job_dir.join("output"),
    ];
    for dir in dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) {
                latest = Some(latest.map_or(modified, |current| current.max(modified)));
            }
        }
    }
    latest
}

fn job_started_at(job: &PptJob) -> Option<chrono::DateTime<chrono::Local>> {
    job.started_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Local))
}

/// 判定 running 作业是否已经失去进展。
fn job_is_stale(job: &PptJob) -> bool {
    if job.status != "running" {
        return false;
    }
    let started_stale = job_started_at(job)
        .map(|started| (chrono::Local::now() - started).num_minutes() >= STALE_JOB_MINUTES)
        .unwrap_or(true);
    if !started_stale {
        return false;
    }
    let job_dir = PathBuf::from(&job.workspace_path);
    latest_activity_time(&job_dir)
        .and_then(|time| time.elapsed().ok())
        .map(|elapsed| elapsed.as_secs() >= STALE_ACTIVITY_MINUTES * 60)
        .unwrap_or(true)
}

#[allow(clippy::too_many_arguments)]
fn emit_draft_page(
    app: &AppHandle,
    job_id: &str,
    page: u32,
    total: usize,
    status: &str,
    score: i32,
    candidate_count: usize,
    issues: &[String],
) {
    let _ = app.emit(
        "ppt-extension://draft-page",
        json!({
            "jobId": job_id,
            "page": page,
            "total": total,
            "status": status,
            "score": score,
            "candidateCount": candidate_count,
            "issues": issues,
        }),
    );
}

/// 单页重新生成的候选进度，供草稿页提示词弹窗展示。
#[allow(clippy::too_many_arguments)]
fn emit_page_regen_progress(
    app: &AppHandle,
    job_id: &str,
    page: u32,
    current: usize,
    total: usize,
    status: &str,
    message: &str,
) {
    let _ = app.emit(
        "ppt-extension://page-regenerate",
        json!({
            "jobId": job_id,
            "page": page,
            "current": current,
            "total": total,
            "status": status,
            "message": message,
        }),
    );
}

impl PptExtensionService {
    pub fn workspace_root(data_dir: &Path) -> PathBuf {
        data_dir.join("ppt-workspace")
    }

    /// 读取用户选择的本地文件并提取纯文本。
    pub fn extract_local_file(path: &str) -> Result<PptLocalFileSource, AppError> {
        let file = PathBuf::from(path);
        if !file.is_file() {
            return Err(AppError::NotFound(format!("文件不存在: {}", path)));
        }
        let ext = file
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();

        let text = match ext.as_str() {
            "md" | "markdown" | "txt" | "text" => read_text_auto_encoding(&file)?,
            "pdf" => PdfService::extract_text_only(&file)?,
            "doc" | "docx" => DocExtractService::extract_word_text(&file)?,
            "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" | "csv" | "tsv" => {
                ExcelImportService::extract_markdown(path)?.0
            }
            _ => {
                return Err(AppError::InvalidInput(format!(
                    "不支持的文件类型: .{}（支持 md/txt/pdf/doc/docx/xlsx）",
                    ext
                )))
            }
        };

        let mut text = text.trim().to_string();
        if text.is_empty() {
            return Err(AppError::InvalidInput(format!(
                "文件没有可提取的文本: {}",
                path
            )));
        }
        if text.chars().count() > MAX_PER_SOURCE_CHARS {
            text = text.chars().take(MAX_PER_SOURCE_CHARS).collect();
            text.push_str("\n\n[内容已截断]");
        }

        let title = file
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("本地文件")
            .to_string();

        Ok(PptLocalFileSource {
            path: path.to_string(),
            title,
            source_type: if ext.is_empty() { "file".into() } else { ext },
            word_count: text.chars().count(),
            text,
        })
    }

    pub fn collect_documents(
        db: &Database,
        input: &PptJobInput,
    ) -> Result<(String, Vec<PptSourceMeta>), AppError> {
        let mut ids: Vec<i64> = Vec::new();
        for id in input.note_ids.iter().chain(input.mount_note_ids.iter()) {
            if !ids.contains(id) {
                ids.push(*id);
            }
        }

        let mut sources = Vec::new();
        let mut parts: Vec<String> = Vec::new();
        let mut total_chars = 0usize;

        for id in ids {
            if total_chars >= MAX_SOURCE_CHARS {
                break;
            }
            let note = match NoteService::get(db, id) {
                Ok(note) => note,
                Err(_) => continue,
            };
            if note.is_encrypted {
                continue;
            }
            let content = note.content.trim();
            if content.is_empty() {
                continue;
            }
            let original_chars = content.chars().count();
            let mut text: String = content.chars().take(MAX_PER_SOURCE_CHARS).collect();
            let mut truncated = original_chars > MAX_PER_SOURCE_CHARS;
            if truncated {
                text.push_str("\n\n[内容已截断]");
            }
            let remaining = MAX_SOURCE_CHARS.saturating_sub(total_chars);
            if text.chars().count() > remaining {
                text = text.chars().take(remaining).collect();
                truncated = true;
            }
            if text.trim().is_empty() {
                continue;
            }
            let used_chars = text.chars().count();
            total_chars += used_chars;

            let source_type = if input.mount_note_ids.contains(&id) {
                "mount"
            } else {
                "document"
            }
            .to_string();

            parts.push(format!(
                "<!-- source: note:{} | {} | {} -->\n{}",
                id, source_type, note.title, text
            ));
            sources.push(PptSourceMeta {
                id,
                source_type,
                title: note.title,
                word_count: used_chars,
                updated_at: note.updated_at,
                path: None,
                original_chars: Some(original_chars),
                truncated,
            });
        }

        for (index, local) in input.local_files.iter().enumerate() {
            if total_chars >= MAX_SOURCE_CHARS {
                break;
            }
            let source = if local.text.trim().is_empty() {
                match Self::extract_local_file(&local.path) {
                    Ok(value) => value,
                    Err(_) => continue,
                }
            } else {
                let title = Path::new(&local.path)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("本地文件")
                    .to_string();
                let text: String = local
                    .text
                    .chars()
                    .take(MAX_PER_SOURCE_CHARS)
                    .collect();
                PptLocalFileSource {
                    path: local.path.clone(),
                    title: if local.title.trim().is_empty() {
                        title
                    } else {
                        local.title.clone()
                    },
                    source_type: if local.source_type.trim().is_empty() {
                        "file".into()
                    } else {
                        local.source_type.clone()
                    },
                    word_count: text.chars().count(),
                    text,
                }
            };

            let original_chars = source.text.chars().count();
            let mut text = source.text;
            let remaining = MAX_SOURCE_CHARS.saturating_sub(total_chars);
            let mut truncated = false;
            if text.chars().count() > remaining {
                text = text.chars().take(remaining).collect();
                truncated = true;
            }
            if text.trim().is_empty() {
                continue;
            }
            let used_chars = text.chars().count();
            if used_chars < original_chars {
                truncated = true;
            }
            total_chars += used_chars;
            parts.push(format!(
                "<!-- source: file:{} | {} | {} -->\n{}",
                source.path, source.source_type, source.title, text
            ));
            sources.push(PptSourceMeta {
                id: -(index as i64 + 1),
                source_type: source.source_type,
                title: source.title,
                word_count: used_chars,
                updated_at: chrono::Local::now().to_rfc3339(),
                path: Some(source.path),
                original_chars: Some(original_chars),
                truncated,
            });
        }

        let manual = input.manual_text.trim();
        if !manual.is_empty() {
            let remaining = MAX_SOURCE_CHARS.saturating_sub(total_chars);
            let text: String = manual.chars().take(remaining).collect();
            if !text.trim().is_empty() {
                parts.push(format!("<!-- source: manual -->\n{}", text));
            }
        }

        if parts.is_empty() {
            return Err(AppError::InvalidInput(
                "没有可用正文：请选择文档/本地文件，或填写补充材料".into(),
            ));
        }

        Ok((parts.join("\n\n---\n\n"), sources))
    }

    pub async fn create_job(
        db: &Database,
        data_dir: &Path,
        input: PptJobInput,
        app: Option<AppHandle>,
        cancel: Arc<AtomicBool>,
        planning_timeout: Duration,
    ) -> Result<PptJob, AppError> {
        let extension = db
            .get_extension("ppt-master")?
            .ok_or_else(|| AppError::NotFound("PPT 扩展包未安装".into()))?;
        if !extension.enabled {
            return Err(AppError::InvalidInput("PPT 扩展包已禁用".into()));
        }
        if !extension.supports_ppt {
            return Err(AppError::InvalidInput("该扩展包不提供 PPT 引擎".into()));
        }
        if input.title.trim().is_empty() {
            return Err(AppError::InvalidInput("PPT 标题不能为空".into()));
        }

        emit_system_log(app.as_ref(), "正在收集素材...");
        let (source_md, sources) = Self::collect_documents(db, &input)?;
        emit_system_log(
            app.as_ref(),
            &format!(
                "已收集 {} 个素材，共 {} 字符",
                sources.len(),
                source_md.chars().count()
            ),
        );
        let truncated_count = sources.iter().filter(|source| source.truncated).count();
        if truncated_count > 0 {
            emit_system_log(
                app.as_ref(),
                &format!(
                    "有 {} 个素材超过单源/总素材上限，已截断；完整原文仍保留在本地",
                    truncated_count
                ),
            );
        }
        emit_system_log(app.as_ref(), "正在创建作业目录...");
        let job_id = Uuid::new_v4().to_string();
        let workspace = Self::workspace_root(data_dir).join(&job_id);
        let input_dir = workspace.join("input");
        let project_dir = workspace.join("project");
        let output_dir = workspace.join("output");
        let logs_dir = workspace.join("logs");
        for dir in [&input_dir, &project_dir, &output_dir, &logs_dir] {
            fs::create_dir_all(dir)?;
        }

        let plan_log = PlanLog::for_job(&workspace);
        plan_log.emit(
            app.as_ref(),
            &format!(
                "已收集 {} 个素材，共 {} 字符（{} 个被截断）",
                sources.len(),
                source_md.chars().count(),
                truncated_count
            ),
        );

        fs::write(input_dir.join("source.md"), &source_md)?;
        fs::write(
            input_dir.join("source_manifest.json"),
            serde_json::to_vec_pretty(&sources)?,
        )?;

        plan_log.emit(app.as_ref(), "AI 正在分块理解素材...");
        let understanding = build_understanding_with_ai(
            db,
            &input,
            &source_md,
            &job_id,
            app.as_ref(),
            &cancel,
            &plan_log,
        )
        .await?;
        fs::write(input_dir.join("understanding.md"), &understanding)?;
        plan_log.emit(
            app.as_ref(),
            &format!(
                "素材理解完成：{} 字符",
                understanding.chars().count()
            ),
        );

        plan_log.emit(app.as_ref(), "AI 正在规划大纲...");
        let plan = build_plan_with_ai(
            db,
            &input,
            &source_md,
            &understanding,
            &job_id,
            app.as_ref(),
            &cancel,
            planning_timeout,
            &plan_log,
        )
        .await?;
        let slide_count = plan.slides.len();
        plan_log.emit(app.as_ref(), &format!("大纲已生成：{} 页", slide_count));

        ppt_plan::write_plan(&workspace, &plan)?;

        let job_spec = json!({
            "jobId": job_id,
            "extensionId": extension.id,
            "source": {
                "markdownPath": "input/source.md",
                "manifestPath": "input/source_manifest.json",
                "title": input.title,
            },
            "plan": plan,
            "templates": {
                "layoutId": input.layout_id,
                "chartIds": input.chart_ids,
            },
            "options": {
                "slideCount": input.slide_count,
                "language": input.language.unwrap_or_else(|| "zh-CN".into()),
                "audience": input.audience,
                "extraRequirements": input.extra_requirements,
                "timeoutSecs": input.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(30, 7200),
                "nativeCharts": input.native_charts.unwrap_or(false),
                "modelId": input.model_id,
            },
            "templatesDir": "templates",
            "outputDir": "output",
            "projectDir": "project",
        });
        fs::write(
            workspace.join("job.json"),
            serde_json::to_vec_pretty(&job_spec)?,
        )?;

        let job = PptJob {
            id: job_id,
            extension_id: extension.id,
            status: "ready".into(),
            stage: STAGE_OUTLINE_READY.into(),
            title: input.title,
            template_id: input.layout_id,
            workspace_path: workspace.to_string_lossy().to_string(),
            project_path: Some(project_dir.to_string_lossy().to_string()),
            pptx_path: None,
            final_pptx_path: None,
            error_code: None,
            error_message: None,
            log_tail: None,
            created_at: chrono::Local::now().to_rfc3339(),
            started_at: None,
            finished_at: None,
        };
        db.insert_ppt_job(&job)?;
        plan_log.finish(&format!("作业已就绪：{} 页", slide_count));
        emit_system_log(app.as_ref(), "作业已就绪，准备启动引擎");
        Ok(job)
    }

    pub fn start_job(
        app: AppHandle,
        db: Arc<Database>,
        cancels: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        job_id: String,
        export_dir: Option<String>,
    ) -> Result<(), AppError> {
        Self::start_job_stage(
            app,
            db,
            cancels,
            job_id,
            PptRunStage::Full,
            export_dir,
        )
    }

    /// 按阶段启动扩展引擎。render 只生成草稿，export 复用现有草稿导出。
    pub fn start_job_stage(
        app: AppHandle,
        db: Arc<Database>,
        cancels: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        job_id: String,
        stage: PptRunStage,
        export_dir: Option<String>,
    ) -> Result<(), AppError> {
        let mut job = db
            .get_ppt_job(&job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        if job.status == "running" {
            return Err(AppError::InvalidInput("作业正在运行".into()));
        }
        let extension = ExtensionService::get(&db, &job.extension_id)?;
        if !extension.enabled {
            return Err(AppError::InvalidInput("PPT 扩展包已禁用".into()));
        }
        let job_dir = PathBuf::from(&job.workspace_path);
        let plan_path = job_dir.join("plan.json");
        if !plan_path.is_file() {
            return Err(AppError::NotFound(
                "作业缺少 plan.json，请重新创建或从历史作业重试".into(),
            ));
        }
        if stage == PptRunStage::Export && count_draft_pages(&job_dir)? == 0 {
            return Err(AppError::InvalidInput(
                "草稿尚未生成，请先生成草稿再导出".into(),
            ));
        }
        if stage != PptRunStage::Render {
            clear_output_pptx(&job_dir)?;
        }
        update_job_json_stage(&job_dir, stage.as_str())?;

        job.status = "running".into();
        job.stage = stage.running_stage().into();
        job.started_at = Some(chrono::Local::now().to_rfc3339());
        job.error_code = None;
        job.error_message = None;
        db.update_ppt_job(&job)?;
        let _ = app.emit(
            "ppt-extension://job",
            json!({ "jobId": job.id, "status": "running", "stage": job.stage }),
        );
        emit_system_log(
            Some(&app),
            match stage {
                PptRunStage::Render => "正在启动扩展引擎，生成草稿页面...",
                PptRunStage::Export => "正在启动扩展引擎，导出已确认草稿...",
                PptRunStage::Full => "正在启动扩展引擎...",
            },
        );

        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = cancels.lock() {
            map.insert(job.id.clone(), cancel.clone());
        }

        let job_clone = job.clone();
        let db_clone = db.clone();
        let export = export_dir;
        let cancels_clone = cancels.clone();

        let log_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut job = job_clone;
            let job_dir = PathBuf::from(&job.workspace_path);
            let timeout_secs = job_timeout_secs(&job_dir);
            let outcome = extension_runner::run(
                app.clone(),
                &job.id,
                &extension,
                &job_dir,
                Duration::from_secs(timeout_secs),
                cancel,
            );

            if let Ok(mut map) = cancels_clone.lock() {
                map.remove(&job.id);
            }

            let mut result_ok = false;
            match outcome {
                Ok(run) => {
                    job.log_tail = Some(run.log_tail.clone());
                    if run.cancelled {
                        job.status = "cancelled".into();
                        job.error_code = Some("CANCELLED".into());
                        job.error_message = Some("用户取消了生成".into());
                    } else if run.timed_out {
                        job.status = "failed".into();
                        job.error_code = Some("TIMEOUT".into());
                        job.error_message = Some("生成超时".into());
                    } else if run.exit_code.unwrap_or(1) != 0 {
                        job.status = "failed".into();
                        job.error_code = Some("ENGINE_FAILED".into());
                        job.error_message = Some(format!(
                            "扩展进程退出码: {}",
                            run.exit_code
                                .map(|c| c.to_string())
                                .unwrap_or_else(|| "unknown".into())
                        ));
                    } else if stage == PptRunStage::Render {
                        match count_draft_pages(&job_dir) {
                            Ok(count) if count > 0 => {
                                job.stage = STAGE_DRAFT_READY.into();
                                job.status = "succeeded".into();
                                job.pptx_path = None;
                                job.final_pptx_path = None;
                                job.project_path =
                                    Some(job_dir.join("project").to_string_lossy().to_string());
                                result_ok = true;
                            }
                            Ok(_) => {
                                job.status = "failed".into();
                                job.error_code = Some("NO_DRAFT".into());
                                job.error_message = Some("引擎未生成草稿页面".into());
                            }
                            Err(error) => {
                                job.status = "failed".into();
                                job.error_code = Some("NO_DRAFT".into());
                                job.error_message = Some(error.to_string());
                            }
                        }
                    } else {
                        match locate_output(&job_dir) {
                            Ok(pptx) => {
                                job.pptx_path = Some(pptx.to_string_lossy().to_string());
                                job.project_path = Some(
                                    job_dir.join("project").to_string_lossy().to_string(),
                                );
                                if let Some(dir) = export.as_deref().filter(|d| !d.trim().is_empty()) {
                                    match copy_to_export(&pptx, dir, &job.title) {
                                        Ok(final_path) => {
                                            job.final_pptx_path = Some(final_path);
                                            job.stage = STAGE_DONE.into();
                                            job.status = "succeeded".into();
                                            result_ok = true;
                                        }
                                        Err(e) => {
                                            job.status = "failed".into();
                                            job.error_code = Some("COPY_FAILED".into());
                                            job.error_message = Some(e.to_string());
                                        }
                                    }
                                } else {
                                    job.stage = STAGE_DONE.into();
                                    job.status = "succeeded".into();
                                    result_ok = true;
                                }
                            }
                            Err(e) => {
                                job.status = "failed".into();
                                job.error_code = Some("NO_OUTPUT".into());
                                job.error_message = Some(e.to_string());
                            }
                        }
                    }
                }
                Err(e) => {
                    job.status = "failed".into();
                    job.error_code = Some("RUNNER_ERROR".into());
                    job.error_message = Some(e.to_string());
                }
            }

            job.finished_at = Some(chrono::Local::now().to_rfc3339());
            let _ = db_clone.update_ppt_job(&job);

            let payload = json!({
                "jobId": job.id,
                "status": job.status,
                "stage": job.stage,
                "job": job,
            });
            let _ = if result_ok {
                app.emit("ppt-extension://done", payload)
            } else {
                app.emit("ppt-extension://error", payload)
            };
        });

        Ok(())
    }

    /// 生成草稿：可同时写入最新大纲与版式/图表选项。
    pub fn render_draft(
        app: AppHandle,
        db: Arc<Database>,
        cancels: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        job_id: String,
        plan: Option<Value>,
        layout_id: Option<String>,
        chart_ids: Option<Vec<String>>,
        native_charts: Option<bool>,
    ) -> Result<(), AppError> {
        if let Some(plan) = plan {
            Self::update_plan(&db, &job_id, plan)?;
        }
        if layout_id.is_some() || chart_ids.is_some() || native_charts.is_some() {
            Self::apply_render_options(&db, &job_id, layout_id, chart_ids, native_charts)?;
        }
        Self::start_job_stage(app, db, cancels, job_id, PptRunStage::Render, None)
    }

    pub fn export_draft(
        app: AppHandle,
        db: Arc<Database>,
        cancels: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        job_id: String,
        export_dir: Option<String>,
    ) -> Result<(), AppError> {
        if let Some(job) = db.get_ppt_job(&job_id)? {
            Self::sanitize_selected_ai_pages(&PathBuf::from(&job.workspace_path))?;
        }
        Self::start_job_stage(app, db, cancels, job_id, PptRunStage::Export, export_dir)
    }

    /// 导出前清理 AI 页面残留的模板结构元数据，兼容旧作业和旧扩展包。
    fn sanitize_selected_ai_pages(job_dir: &Path) -> Result<(), AppError> {
        let project = job_dir.join("project");
        let selection_path = project.join("page_selection.json");
        let Ok(text) = fs::read_to_string(&selection_path) else {
            return Ok(());
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return Ok(());
        };
        let pages: Vec<u32> = value
            .get("pages")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.get("page")
                            .and_then(Value::as_u64)
                            .map(|value| value as u32)
                    })
                    .collect()
            })
            .unwrap_or_default();
        for page in pages {
            let path = page_svg_path(&project, page);
            let Ok(svg) = fs::read_to_string(&path) else {
                continue;
            };
            let cleaned = sanitize_ai_svg(&svg);
            if cleaned != svg {
                fs::write(&path, cleaned)?;
            }
        }
        Ok(())
    }

    /// 只更新 job.json 中已有的渲染选项，未提供的字段保持原值。
    fn apply_render_options(
        db: &Database,
        job_id: &str,
        layout_id: Option<String>,
        chart_ids: Option<Vec<String>>,
        native_charts: Option<bool>,
    ) -> Result<(), AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        if job.status == "running" {
            return Err(AppError::InvalidInput("作业正在运行，不能修改渲染设置".into()));
        }
        let job_dir = PathBuf::from(&job.workspace_path);
        let spec_path = job_dir.join("job.json");
        let mut spec = if spec_path.is_file() {
            serde_json::from_str::<Value>(&fs::read_to_string(&spec_path)?)?
        } else {
            json!({})
        };
        if !spec.is_object() {
            spec = json!({});
        }
        let current_layout = spec
            .get("templates")
            .and_then(|value| value.get("layoutId"))
            .cloned()
            .unwrap_or(Value::Null);
        let current_charts = spec
            .get("templates")
            .and_then(|value| value.get("chartIds"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        let current_native = spec
            .get("options")
            .and_then(|value| value.get("nativeCharts"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        spec["templates"] = json!({
            "layoutId": layout_id.map(Value::String).unwrap_or(current_layout),
            "chartIds": chart_ids.map(|ids| json!(ids)).unwrap_or(current_charts),
        });
        if !spec.get("options").map(Value::is_object).unwrap_or(false) {
            spec["options"] = json!({});
        }
        spec["options"]["nativeCharts"] =
            json!(native_charts.unwrap_or(current_native));
        write_json_atomic(&spec_path, &spec)?;
        Ok(())
    }

    /// 列出草稿页，标题来自 plan.json。
    pub fn list_draft_pages(db: &Database, job_id: &str) -> Result<Vec<PptDraftPage>, AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        let job_dir = PathBuf::from(&job.workspace_path);
        let svg_dir = job_dir.join("project").join("svg_output");
        if !svg_dir.is_dir() {
            return Ok(Vec::new());
        }
        let plan = ppt_plan::read_plan(&job_dir, &job.title).ok();
        let titles: std::collections::HashMap<u32, String> = plan
            .as_ref()
            .map(|plan| {
                plan.slides
                    .iter()
                    .map(|slide| (slide.page, slide.title.clone()))
                    .collect()
            })
            .unwrap_or_default();

        let mut pages: Vec<(String, u32)> = Vec::new();
        for entry in fs::read_dir(&svg_dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file()
                || !path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| value.eq_ignore_ascii_case("svg"))
                    .unwrap_or(false)
            {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let page = parse_page_number(name).unwrap_or(pages.len() as u32 + 1);
            pages.push((name.to_string(), page));
        }
        pages.sort_by(|a, b| natural_page_cmp(&a.0, &b.0));
        pages.truncate(MAX_DRAFT_PAGES);

        Ok(pages
            .into_iter()
            .map(|(file, page)| PptDraftPage {
                title: titles
                    .get(&page)
                    .cloned()
                    .unwrap_or_else(|| format!("第 {} 页", page)),
                file,
                page,
            })
            .collect())
    }

    /// 读取单页草稿 SVG；只允许 svg_output 下的 .svg 文件名。
    pub fn read_draft_page(db: &Database, job_id: &str, file: &str) -> Result<String, AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        let name = Path::new(file)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| AppError::InvalidInput("草稿页文件名无效".into()))?;
        if name != file || name.contains("..") {
            return Err(AppError::InvalidInput("草稿页只允许文件名".into()));
        }
        if !name.to_ascii_lowercase().ends_with(".svg") {
            return Err(AppError::InvalidInput("只允许读取 .svg 草稿页".into()));
        }
        let job_dir = fs::canonicalize(&job.workspace_path)?;
        let svg_dir = fs::canonicalize(job_dir.join("project").join("svg_output"))?;
        if !svg_dir.starts_with(&job_dir) {
            return Err(AppError::InvalidInput("草稿目录越界".into()));
        }
        let target = fs::canonicalize(svg_dir.join(name))?;
        if !target.starts_with(&svg_dir) {
            return Err(AppError::InvalidInput("草稿页路径越界".into()));
        }
        let metadata = fs::metadata(&target)?;
        if metadata.len() > MAX_DRAFT_PAGE_BYTES {
            return Err(AppError::InvalidInput("草稿页文件过大".into()));
        }
        Ok(fs::read_to_string(target)?)
    }

    /// 读取作业大纲。
    pub fn get_plan(db: &Database, job_id: &str) -> Result<PptPlan, AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        ppt_plan::read_plan(Path::new(&job.workspace_path), &job.title)
    }

    /// 用户编辑大纲后写回 plan.json 与 job.json。
    pub fn update_plan(db: &Database, job_id: &str, plan: Value) -> Result<PptPlan, AppError> {
        let mut job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        if job.status == "running" {
            return Err(AppError::InvalidInput("作业正在运行，不能修改大纲".into()));
        }
        let provided = plan
            .get("slides")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        if provided == 0 {
            return Err(AppError::InvalidInput("大纲至少需要保留 1 页".into()));
        }
        let job_dir = PathBuf::from(&job.workspace_path);
        let source_path = job_dir.join("input").join("source.md");
        let source = fs::read_to_string(&source_path).unwrap_or_default();
        let normalized = ppt_plan::normalize_plan(plan, &job.title, &source, None);
        ppt_plan::write_plan(&job_dir, &normalized)?;
        update_job_json_plan(&job_dir, &normalized)?;
        // 大纲变化会让现有草稿失效，清空旧页避免误导出。
        clear_draft_pages(&job_dir)?;
        job.stage = STAGE_OUTLINE_READY.into();
        job.status = "ready".into();
        job.pptx_path = None;
        job.final_pptx_path = None;
        job.error_code = None;
        job.error_message = None;
        job.log_tail = None;
        job.started_at = None;
        job.finished_at = None;
        db.update_ppt_job(&job)?;
        Ok(normalized)
    }

    /// 校验并规范化一份前端传来的大纲，不落盘。
    pub fn validate_plan(plan: Value) -> PptPlan {
        ppt_plan::normalize_plan(plan, "", "", None)
    }

    /// 复用现有素材与作业设置，重新调用 AI 生成大纲。
    pub async fn regenerate_plan(
        db: &Database,
        job_id: &str,
        slide_count: Option<usize>,
        model_id: Option<i64>,
        cancel: Arc<AtomicBool>,
        app: Option<AppHandle>,
    ) -> Result<PptPlan, AppError> {
        let mut job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        if job.status == "running" {
            if !job_is_stale(&job) {
                return Err(AppError::InvalidInput(
                    "作业正在运行，不能重新生成大纲".into(),
                ));
            }
            job.status = "failed".into();
            job.error_code = Some("stale_running".into());
            job.error_message = Some("上一次运行已长时间无进展，已自动终止".into());
            job.finished_at = Some(chrono::Local::now().to_rfc3339());
            db.update_ppt_job(&job)?;
        }

        let job_dir = PathBuf::from(&job.workspace_path);
        let plan_log = PlanLog::for_job(&job_dir);
        let started = Instant::now();

        job.status = "running".into();
        job.started_at = Some(chrono::Local::now().to_rfc3339());
        job.finished_at = None;
        job.error_code = None;
        job.error_message = None;
        db.update_ppt_job(&job)?;

        let result = Self::regenerate_plan_inner(
            db,
            &job,
            &job_dir,
            slide_count,
            model_id,
            &cancel,
            app.as_ref(),
            &plan_log,
        )
        .await;

        match &result {
            Ok(plan) => {
                job.status = "ready".into();
                job.stage = STAGE_OUTLINE_READY.into();
                job.pptx_path = None;
                job.final_pptx_path = None;
                job.error_code = None;
                job.error_message = None;
                job.log_tail = None;
                job.started_at = None;
                job.finished_at = None;
                plan_log.finish(&format!(
                    "大纲已重新生成：{} 页，耗时 {:.1}s",
                    plan.slides.len(),
                    started.elapsed().as_secs_f64()
                ));
            }
            Err(error) => {
                job.status = "failed".into();
                job.error_code = Some("planning_failed".into());
                job.error_message = Some(error.to_string());
                job.finished_at = Some(chrono::Local::now().to_rfc3339());
                plan_log.finish(&format!(
                    "大纲生成失败：{}（耗时 {:.1}s）",
                    error,
                    started.elapsed().as_secs_f64()
                ));
            }
        }
        db.update_ppt_job(&job)?;
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn regenerate_plan_inner(
        db: &Database,
        job: &PptJob,
        job_dir: &Path,
        slide_count: Option<usize>,
        model_id: Option<i64>,
        cancel: &Arc<AtomicBool>,
        app: Option<&AppHandle>,
        plan_log: &PlanLog,
    ) -> Result<PptPlan, AppError> {
        let source_path = job_dir.join("input").join("source.md");
        let source = fs::read_to_string(&source_path).map_err(|_| {
            AppError::NotFound("作业缺少 input/source.md，无法重新生成大纲".into())
        })?;
        if source.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "素材正文为空，无法重新生成大纲".into(),
            ));
        }

        let spec_path = job_dir.join("job.json");
        let spec = if spec_path.is_file() {
            serde_json::from_str::<Value>(&fs::read_to_string(&spec_path)?)?
        } else {
            json!({})
        };
        let options = spec.get("options").cloned().unwrap_or_else(|| json!({}));
        let title = spec
            .get("source")
            .and_then(|source| source.get("title"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(job.title.as_str())
            .to_string();
        let audience = options
            .get("audience")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let language = options
            .get("language")
            .and_then(Value::as_str)
            .map(str::to_string);
        let extra_requirements = options
            .get("extraRequirements")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let input = PptJobInput {
            note_ids: Vec::new(),
            mount_note_ids: Vec::new(),
            local_files: Vec::new(),
            manual_text: String::new(),
            title,
            audience,
            slide_count,
            layout_id: job.template_id.clone(),
            chart_ids: Vec::new(),
            language,
            extra_requirements,
            export_dir: None,
            model_id,
            planning_id: None,
            timeout_secs: None,
            native_charts: None,
        };

        let understanding_path = job_dir.join("input").join("understanding.md");
        let understanding = if understanding_path.is_file() {
            plan_log.emit(app, "复用已有素材理解（不重复分析素材）");
            fs::read_to_string(&understanding_path).unwrap_or_default()
        } else {
            plan_log.emit(app, "正在补充素材理解...");
            match build_understanding_with_ai(
                db,
                &input,
                &source,
                &job.id,
                app,
                cancel,
                plan_log,
            )
            .await
            {
                Ok(value) => {
                    let _ = fs::write(&understanding_path, &value);
                    value
                }
                Err(error) => {
                    plan_log.emit(
                        app,
                        &format!("素材理解失败，使用素材节选继续：{}", error),
                    );
                    source.clone()
                }
            }
        };

        plan_log.emit(app, "正在重新生成大纲...");
        let plan = build_plan_with_ai(
            db,
            &input,
            &source,
            &understanding,
            &job.id,
            app,
            cancel,
            Duration::from_secs(DEFAULT_PLANNING_TIMEOUT_SECS),
            plan_log,
        )
        .await?;

        ppt_plan::write_plan(job_dir, &plan)?;
        update_job_json_plan(job_dir, &plan)?;
        update_job_json_plan_options(job_dir, slide_count, model_id)?;
        clear_draft_pages(job_dir)?;
        clear_output_pptx(job_dir)?;
        Ok(plan)
    }

    /// 根据素材标题/摘要，推断一个 PPT 标题与最可能的汇报对象。
    pub async fn suggest_meta(
        db: &Database,
        sources: &[PptMetaSource],
        model_id: Option<i64>,
    ) -> Result<PptMetaSuggestion, AppError> {
        let material = sources
            .iter()
            .take(12)
            .filter_map(|source| {
                let title = source.title.trim();
                if title.is_empty() {
                    return None;
                }
                let kind = if source.source_type.trim().is_empty() {
                    "素材"
                } else {
                    source.source_type.trim()
                };
                let excerpt: String = source.excerpt.trim().chars().take(800).collect();
                if excerpt.is_empty() {
                    Some(format!("- [{kind}] {title}"))
                } else {
                    Some(format!("- [{kind}] {title}：{excerpt}"))
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if material.is_empty() {
            return Err(AppError::InvalidInput("没有可用于识别的素材".into()));
        }

        let prompt = format!(
            "你是 PPT 策划助手。根据下面的素材名称与摘要，推断一个适合作为 PPT 主题的中文标题，以及最可能的汇报对象。\n\
             要求：\n\
             1. 标题简洁具体，不超过 30 个汉字，不要书名号，不要“PPT”后缀。\n\
             2. 汇报对象用 2-10 个汉字，例如：本科教学、企业客户、技术评审、管理层、项目组、学术答辩。\n\
             3. 只输出 JSON，不要 markdown 代码块：{{\"title\":\"...\",\"audience\":\"...\"}}\n\n\
             素材：\n{material}"
        );

        let text = tokio::time::timeout(
            Duration::from_secs(60),
            AiService::complete_once(db, &prompt, model_id),
        )
        .await
        .map_err(|_| AppError::Custom("AI 识别素材超时".into()))??;

        let parsed = extract_json(&text)
            .and_then(|json| serde_json::from_str::<Value>(&json).ok());
        let title = parsed
            .as_ref()
            .and_then(|value| value.get("title"))
            .and_then(Value::as_str)
            .map(clean_meta_title)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback_meta_title(sources));
        let audience = parsed
            .as_ref()
            .and_then(|value| value.get("audience"))
            .and_then(Value::as_str)
            .map(clean_meta_audience)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "通用听众".to_string());

        Ok(PptMetaSuggestion { title, audience })
    }

    /// 更新作业的版式/图表/导出选项，供“用当前大纲重新渲染”使用。
    pub fn update_job_options(
        db: &Database,
        job_id: &str,
        layout_id: Option<String>,
        chart_ids: Vec<String>,
        native_charts: bool,
        timeout_secs: Option<u64>,
    ) -> Result<PptJob, AppError> {
        let mut job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        if job.status == "running" {
            return Err(AppError::InvalidInput("作业正在运行，不能修改渲染设置".into()));
        }
        let job_dir = PathBuf::from(&job.workspace_path);
        let spec_path = job_dir.join("job.json");
        let mut spec = if spec_path.is_file() {
            serde_json::from_str::<Value>(&fs::read_to_string(&spec_path)?)?
        } else {
            json!({})
        };
        if !spec.is_object() {
            spec = json!({});
        }
        spec["templates"] = json!({
            "layoutId": layout_id,
            "chartIds": chart_ids,
        });
        if !spec.get("options").map(Value::is_object).unwrap_or(false) {
            spec["options"] = json!({});
        }
        spec["options"]["nativeCharts"] = json!(native_charts);
        if let Some(timeout) = timeout_secs {
            spec["options"]["timeoutSecs"] = json!(timeout.clamp(30, 7200));
        }
        write_json_atomic(&spec_path, &spec)?;
        let _ = clear_draft_pages(&job_dir);

        job.template_id = layout_id;
        job.status = "ready".into();
        job.stage = STAGE_OUTLINE_READY.into();
        job.pptx_path = None;
        job.final_pptx_path = None;
        job.error_code = None;
        job.error_message = None;
        job.log_tail = None;
        job.started_at = None;
        job.finished_at = None;
        db.update_ppt_job(&job)?;
        Ok(job)
    }

    /// 复用已有作业的 source/plan 创建新作业，不重新调用 AI。
    pub fn retry_job(db: &Database, data_dir: &Path, job_id: &str) -> Result<PptJob, AppError> {
        let old = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        if old.status == "running" {
            return Err(AppError::InvalidInput("作业正在运行，不能重试".into()));
        }
        let old_dir = PathBuf::from(&old.workspace_path);
        let source_path = old_dir.join("input").join("source.md");
        if !source_path.is_file() {
            return Err(AppError::NotFound("原作业缺少 input/source.md，无法重试".into()));
        }
        let plan = ppt_plan::read_plan(&old_dir, &old.title)?;
        let old_spec_path = old_dir.join("job.json");
        let mut spec = if old_spec_path.is_file() {
            serde_json::from_str::<Value>(&fs::read_to_string(&old_spec_path)?)?
        } else {
            json!({})
        };

        let new_id = Uuid::new_v4().to_string();
        let workspace = Self::workspace_root(data_dir).join(&new_id);
        let input_dir = workspace.join("input");
        let project_dir = workspace.join("project");
        let output_dir = workspace.join("output");
        let logs_dir = workspace.join("logs");
        for dir in [&input_dir, &project_dir, &output_dir, &logs_dir] {
            fs::create_dir_all(dir)?;
        }

        fs::copy(&source_path, input_dir.join("source.md"))?;
        let manifest_path = old_dir.join("input").join("source_manifest.json");
        if manifest_path.is_file() {
            fs::copy(&manifest_path, input_dir.join("source_manifest.json"))?;
        }
        ppt_plan::write_plan(&workspace, &plan)?;

        if !spec.is_object() {
            spec = json!({});
        }
        spec["jobId"] = json!(new_id);
        spec["extensionId"] = json!(old.extension_id);
        spec["plan"] = serde_json::to_value(&plan)?;
        spec["source"] = json!({
            "markdownPath": "input/source.md",
            "manifestPath": "input/source_manifest.json",
            "title": old.title,
        });
        if !spec.get("options").map(Value::is_object).unwrap_or(false) {
            spec["options"] = json!({});
        }
        spec["templatesDir"] = json!("templates");
        spec["outputDir"] = json!("output");
        spec["projectDir"] = json!("project");
        write_json_atomic(&workspace.join("job.json"), &spec)?;

        let job = PptJob {
            id: new_id,
            extension_id: old.extension_id,
            status: "ready".into(),
            stage: STAGE_OUTLINE_READY.into(),
            title: old.title,
            template_id: old.template_id,
            workspace_path: workspace.to_string_lossy().to_string(),
            project_path: Some(project_dir.to_string_lossy().to_string()),
            pptx_path: None,
            final_pptx_path: None,
            error_code: None,
            error_message: None,
            log_tail: None,
            created_at: chrono::Local::now().to_rfc3339(),
            started_at: None,
            finished_at: None,
        };
        db.insert_ppt_job(&job)?;
        Ok(job)
    }

    /// 删除单个作业及其工作目录。
    pub fn delete_job(db: &Database, job_id: &str) -> Result<bool, AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        if job.status == "running" {
            return Err(AppError::InvalidInput("作业正在运行，不能删除".into()));
        }
        let _ = fs::remove_dir_all(&job.workspace_path);
        db.delete_ppt_job(job_id)
    }

    /// 把 job.json / plan.json / manifest / 日志打包为诊断 zip（不含 source.md 正文）。
    pub fn export_diagnostics(
        db: &Database,
        job_id: &str,
        target_dir: &str,
    ) -> Result<String, AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {} 不存在", job_id)))?;
        let dir = PathBuf::from(target_dir);
        if !dir.is_dir() {
            return Err(AppError::NotFound(format!("导出目录不存在: {}", dir.display())));
        }
        let job_dir = PathBuf::from(&job.workspace_path);
        let target = dir.join(format!("ppt-diagnostics-{}.zip", job.id));
        let file = fs::File::create(&target)?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();

        let add_file = |writer: &mut zip::ZipWriter<fs::File>, name: &str, path: &Path| {
            if !path.is_file() {
                return;
            }
            if writer.start_file(name, options).is_err() {
                return;
            }
            if let Ok(bytes) = fs::read(path) {
                use std::io::Write;
                let _ = writer.write_all(&bytes);
            }
        };

        add_file(&mut writer, "job.json", &job_dir.join("job.json"));
        add_file(&mut writer, "plan.json", &job_dir.join("plan.json"));
        add_file(
            &mut writer,
            "input/source_manifest.json",
            &job_dir.join("input").join("source_manifest.json"),
        );
        let logs_dir = job_dir.join("logs");
        if logs_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&logs_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let name = format!("logs/{}", entry.file_name().to_string_lossy());
                    add_file(&mut writer, &name, &path);
                }
            }
        }
        let readme = format!(
            "Pomegranate PPT 诊断包\n\
             作业：{} ({})\n\
             状态：{}\n\
             生成时间：{}\n\
             说明：出于隐私考虑，不包含 input/source.md 正文。\n",
            job.title,
            job.id,
            job.status,
            chrono::Local::now().to_rfc3339(),
        );
        if writer.start_file("README.txt", options).is_ok() {
            use std::io::Write;
            let _ = writer.write_all(readme.as_bytes());
        }
        writer.finish()?;
        Ok(target.to_string_lossy().to_string())
    }

    pub fn cancel_job(
        db: &Database,
        cancels: &Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        app: Option<&AppHandle>,
        job_id: &str,
    ) -> Result<(), AppError> {
        // 1) 进程还在跑：置取消标志，由 extension_runner 轮询后终止子进程。
        {
            let map = cancels
                .lock()
                .map_err(|e| AppError::Custom(e.to_string()))?;
            if let Some(flag) = map.get(job_id) {
                flag.store(true, Ordering::SeqCst);
                return Ok(());
            }
        }

        // 2) 内存里没有（应用重启 / 拉起进程前失败）：以数据库状态为准。
        //    过去这里直接返回 "作业不在进行中"，导致残留 running 的作业无法取消。
        let Some(mut job) = db.get_ppt_job(job_id)? else {
            return Err(AppError::NotFound(format!("作业 {} 不存在", job_id)));
        };
        if job.status != "running" {
            return Err(AppError::InvalidInput("作业已经结束，无需取消".into()));
        }
        job.status = "cancelled".into();
        job.error_code = Some("CANCELLED".into());
        job.error_message = Some("用户取消了生成".into());
        job.finished_at = Some(chrono::Local::now().to_rfc3339());
        db.update_ppt_job(&job)?;
        if let Some(app) = app {
            let _ = app.emit(
                "ppt-extension://job",
                json!({ "jobId": job.id, "status": "cancelled", "stage": job.stage }),
            );
        }
        Ok(())
    }

    /// 回收失去进展的 running 作业。
    ///
    /// 应用崩溃 / 被强杀时 DB 会残留 `status=running`，下次操作会被
    /// "作业正在运行"挡住，因此列表加载时顺手清理。
    pub fn recover_stale_jobs(db: &Database) -> Result<usize, AppError> {
        let jobs = db.list_ppt_jobs(usize::MAX)?;
        let mut recovered = 0usize;
        for mut job in jobs {
            if !job_is_stale(&job) {
                continue;
            }
            job.status = "failed".into();
            job.error_code = Some("stale_running".into());
            job.error_message = Some(format!(
                "作业超过 {} 分钟无进展，已自动标记失败，可重新生成",
                STALE_JOB_MINUTES
            ));
            job.finished_at = Some(chrono::Local::now().to_rfc3339());
            db.update_ppt_job(&job)?;
            recovered += 1;
        }
        Ok(recovered)
    }

    pub fn cleanup_jobs(db: &Database, keep_latest: usize) -> Result<usize, AppError> {
        let jobs = db.list_ppt_jobs(usize::MAX)?;
        let mut removed = 0usize;
        for job in jobs.into_iter().skip(keep_latest) {
            if job.status == "running" {
                continue;
            }
            let _ = fs::remove_dir_all(&job.workspace_path);
            if db.delete_ppt_job(&job.id)? {
                removed += 1;
            }
        }
        Ok(removed)
    }
}

const UNDERSTANDING_CHUNK_CHARS: usize = 8_000;
const UNDERSTANDING_MAX_CHUNKS: usize = 16;
/// 理解阶段并发度：块与块之间没有依赖，并发可把耗时压到接近 1/N。
const UNDERSTANDING_CONCURRENCY: usize = 3;
/// 单块理解超时；并发后不再需要 150 秒的长等待。
const UNDERSTANDING_CHUNK_TIMEOUT_SECS: u64 = 120;
/// 理解阶段总时长上限：超过后使用已完成的部分继续规划。
const UNDERSTANDING_TOTAL_TIMEOUT_SECS: u64 = 300;
/// 规划阶段只取素材理解（已是素材的提炼），避免再塞一份原始素材。
const PLANNING_CONTEXT_CHARS: usize = 30_000;
/// 理解结果过短时补一小段原始素材，避免信息不足。
const PLANNING_SOURCE_FALLBACK_CHARS: usize = 15_000;
const PLAN_CONTENT_REPAIR_ATTEMPTS: usize = 1;

const PLAN_PLACEHOLDER_PHRASES: &[&str] = &[
    "提炼用户材料中的关键信息",
    "围绕当前主题组织重点表达",
    "使用短句和结构化表达",
    "概括本主题的核心内容",
    "主题与一句话价值主张",
    "呈现主题的阶段、结构或层次",
    "待补充",
    "示例内容",
    "此处填写",
];

/// 按段落优先切分素材；单段超长时按字符切分，避免任何内容被直接丢弃。
fn split_source_chunks(source: &str, limit: usize, max_chunks: usize) -> Vec<String> {
    let limit = limit.max(1_000);
    let mut chunks = Vec::new();
    let mut current = String::new();
    for paragraph in source.split("\n\n") {
        let paragraph = paragraph.trim();
        if paragraph.is_empty() {
            continue;
        }
        if chunks.len() >= max_chunks {
            break;
        }
        let paragraph_len = paragraph.chars().count();
        let current_len = current.chars().count();
        if current_len > 0 && current_len + paragraph_len + 2 > limit {
            chunks.push(current.trim().to_string());
            current.clear();
            if chunks.len() >= max_chunks {
                break;
            }
        }
        if paragraph_len > limit {
            let mut buffer: Vec<char> = paragraph.chars().collect();
            while !buffer.is_empty() && chunks.len() < max_chunks {
                let take = limit.min(buffer.len());
                let part: String = buffer.drain(..take).collect();
                let part = part.trim();
                if !part.is_empty() {
                    chunks.push(part.to_string());
                }
            }
            continue;
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(paragraph);
    }
    if !current.trim().is_empty() && chunks.len() < max_chunks {
        chunks.push(current.trim().to_string());
    }
    if chunks.is_empty() && !source.trim().is_empty() {
        chunks.push(source.chars().take(limit).collect());
    }
    chunks
}

const REASONING_MODEL_HINTS: &[&str] = &[
    "reasoner",
    "thinking",
    "qwq",
    "deepseek-r1",
    "o1-preview",
    "o1-mini",
    "o3-",
    "o4-",
];
const FAST_MODEL_HINTS: &[&str] = &["flash", "mini", "turbo", "plus", "chat"];

fn looks_reasoning_model(model_id: &str) -> bool {
    let value = model_id.to_ascii_lowercase();
    REASONING_MODEL_HINTS
        .iter()
        .any(|hint| value.contains(hint))
}

fn looks_fast_model(model_id: &str) -> bool {
    let value = model_id.to_ascii_lowercase();
    FAST_MODEL_HINTS.iter().any(|hint| value.contains(hint))
}

/// 理解 / 合并这类"提炼"任务不需要推理能力。
///
/// 用户选的模型不是推理模型时原样沿用；只有用户选了 reasoner 一类的模型，
/// 才从已配置模型里挑一个非推理模型来跑理解阶段，规划阶段仍然使用用户模型。
fn fast_model_id(db: &Database, preferred: Option<i64>) -> Option<i64> {
    let user_model = match preferred {
        Some(id) => db.get_ai_model(id).ok(),
        None => db.get_default_ai_model().ok(),
    };
    let Some(user_model) = user_model else {
        return preferred;
    };
    let models = db.list_ai_models().unwrap_or_default();
    Some(pick_fast_model_id(&user_model, &models))
}

fn normalize_api_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// 为用户模型挑一个用于理解阶段的快模型。
///
/// 只在**同一 API 地址（同厂商）**内切换：不同厂商的 Key 不通用，
/// 跨厂商自动选择会直接 401，反而让理解阶段全线失败。
/// 没有同源快模型时沿用用户模型。
fn pick_fast_model_id(user: &AiModel, models: &[AiModel]) -> i64 {
    if !looks_reasoning_model(&user.model_id) {
        return user.id;
    }
    let user_api = normalize_api_url(&user.api_url);
    models
        .iter()
        .filter(|model| model.id != user.id)
        .filter(|model| normalize_api_url(&model.api_url) == user_api)
        .filter(|model| !looks_reasoning_model(&model.model_id))
        .min_by_key(|model| if looks_fast_model(&model.model_id) { 0 } else { 1 })
        .map(|model| model.id)
        .unwrap_or(user.id)
}

/// 按字符上限拼接多段文本，超出部分直接截断（用于控制合并理解的输入体积）。
fn join_with_limit(items: &[String], limit: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for item in items {
        if used >= limit {
            break;
        }
        if used > 0 {
            out.push_str("\n\n---\n\n");
            used += 5;
        }
        let remaining = limit.saturating_sub(used);
        for ch in item.chars().take(remaining) {
            out.push(ch);
            used += 1;
        }
    }
    out
}

fn understanding_chunk_prompt(title: &str, chunk: &str, index: usize, total: usize) -> String {
    format!(
        "你是 PPT 素材分析助手。主题：{title}。\n\
         下面是一份完整素材的第 {index}/{total} 块。只提炼本块中可直接用于 PPT 的信息，输出简洁中文 Markdown：\n\
         1. 子主题（3–6 条）\n\
         2. 可引用的事实、数据、年份、结论（逐条，保留出处或上下文线索）\n\
         3. 概念、方法、流程、关系\n\
         4. 适合的页面组织方式（时间线/分类/对比/因果/流程）\n\
         5. 不确定或缺失的信息\n\
         不要编造，不要大段复述原文。\n\n素材分块：\n{chunk}"
    )
}

fn merge_understanding_prompt(
    title: &str,
    audience: &str,
    drafts: &str,
) -> String {
    format!(
        "你是 PPT 策划助手。把下列分块理解合并成一份可直接用于制作 PPT 的完整理解，输出中文 Markdown：\n\
         1. 核心目标\n\
         2. 受众关切\n\
         3. 最值得突出的 3–5 个重点\n\
         4. 应弱化或合并的内容\n\
         5. 推荐叙事主线\n\
         6. 建议页面结构（每页一句话）\n\
         7. 关键证据清单\n\
         8. 仍需补充的信息\n\
         要求去重、合并冲突、不要编造、不要大段复述原文。\n\
         主题：{title}\n受众：{audience}\n\n分块理解：\n{drafts}"
    )
}

async fn build_understanding_with_ai(
    db: &Database,
    input: &PptJobInput,
    source: &str,
    job_id: &str,
    app: Option<&AppHandle>,
    cancel: &Arc<AtomicBool>,
    plan_log: &PlanLog,
) -> Result<String, AppError> {
    let chunks = split_source_chunks(source, UNDERSTANDING_CHUNK_CHARS, UNDERSTANDING_MAX_CHUNKS);
    if chunks.is_empty() {
        return Ok(String::new());
    }

    // 理解是"提炼"任务，不需要推理模型的思考开销。
    let model_id = fast_model_id(db, input.model_id);
    let total = chunks.len();
    let concurrency = UNDERSTANDING_CONCURRENCY.clamp(1, total);
    let chunk_timeout = Duration::from_secs(UNDERSTANDING_CHUNK_TIMEOUT_SECS);
    let total_timeout = Duration::from_secs(UNDERSTANDING_TOTAL_TIMEOUT_SECS);
    let started = Instant::now();

    plan_log.emit(
        app,
        &format!("AI 正在并行理解素材（{total} 块，并发 {concurrency}）..."),
    );
    emit_plan_progress(
        app,
        job_id,
        "understanding",
        0,
        total,
        &format!("AI 正在并行理解素材（0/{total}）"),
    );

    let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut stream = futures::stream::iter(
        chunks
            .into_iter()
            .enumerate()
            .map(move |(index, chunk)| {
                let prompt = understanding_chunk_prompt(&input.title, &chunk, index + 1, total);
                let cancel = cancel.clone();
                let completed = completed.clone();
                let app = app.cloned();
                let job_id = job_id.to_string();
                async move {
                    if cancel.load(Ordering::SeqCst) {
                        return (index, Err(PlanRunError::Cancelled));
                    }
                    let future = AiService::complete_once(db, &prompt, model_id);
                    let result = await_cancellable(future, &cancel, chunk_timeout).await;
                    let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                    plan_log.write(&format!("素材块 {}/{} 结束", index + 1, total));
                    emit_plan_progress(
                        app.as_ref(),
                        &job_id,
                        "understanding",
                        done,
                        total,
                        &format!("AI 已完成素材理解 {done}/{total}"),
                    );
                    (index, result)
                }
            }),
    )
    .buffer_unordered(concurrency);

    let mut finished: Vec<(usize, String)> = Vec::new();
    while let Some((index, result)) = stream.next().await {
        match result {
            Ok(text) if !text.trim().is_empty() => {
                finished.push((index, text.trim().to_string()))
            }
            Ok(_) => {}
            Err(PlanRunError::Cancelled) => {
                return Err(AppError::Custom("已取消大纲生成".into()));
            }
            Err(PlanRunError::Timeout) => plan_log.emit(
                app,
                &format!("素材第 {} 块理解超时，已跳过", index + 1),
            ),
            Err(PlanRunError::Ai(error)) => plan_log.emit(
                app,
                &format!("素材第 {} 块理解失败：{}", index + 1, error),
            ),
        }
        if started.elapsed() >= total_timeout {
            plan_log.emit(
                app,
                &format!(
                    "素材理解达到总时长上限 {} 秒，使用已完成的部分继续",
                    total_timeout.as_secs()
                ),
            );
            break;
        }
    }
    drop(stream);

    // 并发完成顺序不可控，按原始块序号恢复顺序，保证理解结果与素材顺序一致。
    finished.sort_by_key(|(index, _)| *index);
    let mut drafts: Vec<String> = finished.into_iter().map(|(_, text)| text).collect();

    if drafts.is_empty() {
        plan_log.emit(app, "素材理解不可用，规划阶段回退到素材节选");
        return Ok(source.chars().take(PLANNING_CONTEXT_CHARS).collect());
    }
    if drafts.len() == 1 {
        return Ok(drafts.remove(0));
    }

    plan_log.emit(app, "AI 正在合并分块理解...");
    let combined = join_with_limit(&drafts, PLANNING_CONTEXT_CHARS);
    let prompt = merge_understanding_prompt(&input.title, &input.audience, &combined);
    let future = AiService::complete_once(db, &prompt, model_id);
    match await_cancellable(future, cancel, chunk_timeout.max(Duration::from_secs(90))).await {
        Ok(text) if !text.trim().is_empty() => Ok(text.trim().to_string()),
        Ok(_) => Ok(combined),
        Err(PlanRunError::Cancelled) => Err(AppError::Custom("已取消大纲生成".into())),
        Err(error) => {
            let reason = match error {
                PlanRunError::Timeout => "合并理解超时".to_string(),
                PlanRunError::Ai(message) => message,
                PlanRunError::Cancelled => "已取消".to_string(),
            };
            plan_log.emit(app, &format!("{}，使用分块理解原文继续", reason));
            Ok(combined)
        }
    }
}

fn slide_full_text(slide: &PptSlide) -> String {
    let blocks = slide
        .content_blocks
        .iter()
        .map(|block| format!("{} {} {}", block.label, block.text, block.detail))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "{} {} {} {} {}",
        slide.title,
        slide.core_message,
        slide.main_claim,
        blocks,
        slide.bullets.join(" ")
    )
}

fn validate_plan_content(plan: &PptPlan) -> Vec<String> {
    let mut issues = Vec::new();
    let mut previous_theme: Option<&str> = None;
    for (index, slide) in plan.slides.iter().enumerate() {
        let page = slide.page.max(index as u32 + 1);
        if slide.title.trim().is_empty() {
            issues.push(format!("P{page:02} 缺少标题"));
        }
        if slide.page > 1 && slide.core_message.trim().is_empty() {
            issues.push(format!("P{page:02} 缺少 coreMessage"));
        }
        if slide.page > 1 && slide.content_blocks.len() < 2 {
            issues.push(format!(
                "P{page:02} 内容块过少（{}），至少需要 2 个",
                slide.content_blocks.len()
            ));
        }
        if slide.page > 1 && slide.evidence.is_empty() && slide.bullets.len() < 2 {
            issues.push(format!("P{page:02} 缺少证据或要点"));
        }
        let full_text = slide_full_text(slide);
        if PLAN_PLACEHOLDER_PHRASES
            .iter()
            .any(|phrase| full_text.contains(phrase))
        {
            issues.push(format!("P{page:02} 含占位文字"));
        }
        let theme = slide.page_theme.trim();
        if index > 0 && !theme.is_empty() && previous_theme == Some(theme) {
            issues.push(format!("P{page:02} 与上一页 pageTheme 重复"));
        }
        if !theme.is_empty() {
            previous_theme = Some(theme);
        }
    }
    issues
}

/// 从小节校验问题里提取页码，例如 `P07 缺少 coreMessage` → 7。
fn issue_pages(issues: &[String]) -> Vec<u32> {
    let mut pages: Vec<u32> = issues
        .iter()
        .filter_map(|issue| {
            let rest = issue.strip_prefix('P')?;
            let digits: String = rest
                .chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect();
            digits.parse::<u32>().ok()
        })
        .collect();
    pages.sort_unstable();
    pages.dedup();
    pages
}

fn plan_repair_prompt(
    input: &PptJobInput,
    plan: &PptPlan,
    issues: &[String],
    pages: &[u32],
    understanding: &str,
) -> String {
    // 只发送有问题的页面，修复后按 page 合并回去，避免整份大纲重生成。
    let selected: Vec<&PptSlide> = if pages.is_empty() {
        plan.slides.iter().collect()
    } else {
        plan.slides
            .iter()
            .filter(|slide| pages.contains(&slide.page))
            .collect()
    };
    let plan_json = serde_json::to_string_pretty(&selected).unwrap_or_default();
    let page_hint = if pages.is_empty() {
        "需要修复的页面：全部".to_string()
    } else {
        format!(
            "需要修复的页面：{}",
            pages
                .iter()
                .map(|page| format!("P{page:02}"))
                .collect::<Vec<_>>()
                .join("、")
        )
    };
    format!(
        "修复这份 PPT 大纲中**指定页面**。只输出 JSON，不要 markdown。\n\
         必须保持与原文相同的主题和事实，不要编造数字、年份、排名或奖项。\n\
         修复问题：{issues}\n{page_hint}\n\n\
         要求：\n\
         - 只输出需要修复的页面，保持每页 page 字段与输入一致，不要新增或删除页面。\n\
         - 第 1 页封面只保留 title 和 coreMessage，bullets 为空。\n\
         - 最后 1 页结束页 bullets 不超过 2 条。\n\
         - 中间页每页 3–6 个 contentBlocks，每个含 label/text/detail。\n\
         - 每页 evidence 来自素材或理解结果。\n\
         - 相邻页 pageTheme 不得重复。\n\
         - 删除所有占位文字和内部术语。\n\
         - relation 取 timeline/category/compare/cause/process/none。\n\
         - chartType 取 cards/timeline/process/matrix/compare/highlight/summary。\n\
         - density 取 anchor/dense/breathing/balanced。\n\n\
         JSON 结构：\n\
         {{\"slides\":[{{\"page\":1,\"title\":\"...\",\"pageTheme\":\"...\",\"mainClaim\":\"...\",\"contentScope\":\"...\",\"coreMessage\":\"...\",\"contentBlocks\":[{{\"label\":\"...\",\"text\":\"...\",\"detail\":\"...\"}}],\"evidence\":[\"...\"],\"relation\":\"none\",\"chartType\":\"cards\",\"density\":\"balanced\",\"visualIntent\":\"...\",\"bullets\":[\"...\"],\"speakerNote\":\"...\",\"chart\":null}}]}}\n\n\
         标题：{title}\n听众：{audience}\n\n\
         素材理解：\n{understanding}\n\n待修复页面：\n{plan_json}",
        issues = issues.join("；"),
        title = input.title,
        audience = input.audience,
        understanding = understanding
            .chars()
            .take(PLANNING_CONTEXT_CHARS)
            .collect::<String>(),
    )
}

async fn repair_plan_with_ai(
    db: &Database,
    input: &PptJobInput,
    plan: &PptPlan,
    issues: &[String],
    understanding: &str,
    app: Option<&AppHandle>,
    cancel: &Arc<AtomicBool>,
    planning_timeout: Duration,
    plan_log: &PlanLog,
) -> Result<PptPlan, AppError> {
    let pages = issue_pages(issues);
    let prompt = plan_repair_prompt(input, plan, issues, &pages, understanding);
    for attempt in 0..PLAN_CONTENT_REPAIR_ATTEMPTS {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Custom("已取消大纲生成".into()));
        }
        plan_log.emit(
            app,
            &format!(
                "大纲内容修复第 {} 次尝试（{} 页）...",
                attempt + 1,
                if pages.is_empty() { plan.slides.len() } else { pages.len() }
            ),
        );
        let future = AiService::complete_once(db, &prompt, input.model_id);
        match await_cancellable(future, cancel, planning_timeout).await {
            Ok(text) => {
                if let Some(value) = extract_json(&text)
                    .and_then(|json| serde_json::from_str::<Value>(&json).ok())
                {
                    let mut repaired = plan.clone();
                    let merged = ppt_plan::merge_repaired_slides(&mut repaired, &value);
                    if merged > 0 {
                        plan_log.emit(app, &format!("已局部修复 {} 页", merged));
                        return Ok(repaired);
                    }
                    plan_log.emit(app, "修复结果未包含可匹配的页面，保留原大纲");
                } else {
                    plan_log.emit(app, "大纲内容修复返回内容不是合法 JSON");
                }
            }
            Err(PlanRunError::Cancelled) => {
                return Err(AppError::Custom("已取消大纲生成".into()));
            }
            Err(PlanRunError::Timeout) => {
                plan_log.emit(app, "大纲内容修复超时");
            }
            Err(PlanRunError::Ai(message)) => {
                plan_log.emit(app, &format!("大纲内容修复失败：{}", message));
            }
        }
    }
    Err(AppError::Custom("大纲内容修复未返回可用结果".into()))
}

async fn build_plan_with_ai(
    db: &Database,
    input: &PptJobInput,
    source: &str,
    understanding: &str,
    job_id: &str,
    app: Option<&AppHandle>,
    cancel: &Arc<AtomicBool>,
    planning_timeout: Duration,
    plan_log: &PlanLog,
) -> Result<PptPlan, AppError> {
    // 指定页数时优先使用两阶段规划，进度可以精确到每一页；
    // 标题阶段或逐页扩展失败时回退到单次规划，保证仍有可用大纲。
    if input.slide_count.map(|count| count >= 3).unwrap_or(false) {
        match build_plan_two_stage(
            db,
            input,
            source,
            understanding,
            job_id,
            app,
            cancel,
            planning_timeout,
            plan_log,
        )
        .await
        {
            Ok(plan) => return Ok(plan),
            Err(AppError::Custom(message)) if message.contains("取消") => {
                return Err(AppError::Custom(message));
            }
            Err(error) => plan_log.emit(
                app,
                &format!("两阶段规划不可用（{error}），回退单次规划"),
            ),
        }
    }
    let page_instruction = match input.slide_count {
        Some(count) => format!(
            "请根据素材生成约 {} 页左右的演示大纲。",
            count.clamp(1, 40)
        ),
        None => "页数不固定，请根据素材内容自行决定合适的页数（通常 6–15 页）。".to_string(),
    };
    let expected_pages = input.slide_count.unwrap_or(0).clamp(0, 40);
    let planning_message = if expected_pages > 0 {
        format!("正在规划 {expected_pages} 页大纲")
    } else {
        "正在规划大纲（页数由素材决定）".to_string()
    };
    emit_plan_progress(
        app,
        job_id,
        "planning",
        0,
        expected_pages,
        &planning_message,
    );
    // 规划只发素材理解（它已经是素材的提炼）；理解过短时才补一小段原始素材。
    let understanding_excerpt: String = understanding
        .chars()
        .take(PLANNING_CONTEXT_CHARS)
        .collect();
    let source_excerpt: String = if understanding_excerpt.trim().chars().count() < 4_000 {
        source
            .chars()
            .take(PLANNING_SOURCE_FALLBACK_CHARS)
            .collect()
    } else {
        String::new()
    };
    let source_block = if source_excerpt.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n素材节选：\n{source_excerpt}")
    };
    let prompt = format!(
        "你是 PPT 内容规划助手。{page_instruction}\n\
         标题：{title}\n听众：{audience}\n额外要求：{extra}\n\
         大纲结构：第 1 页为封面，只填 title 和一句 coreMessage，bullets/contentBlocks 为空；最后 1 页为结束页，bullets 不超过 2 条；中间页按内容展开。\n\
         每页必须输出结构化字段：pageTheme、mainClaim、contentScope、contentBlocks、evidence、relation、chartType、density、visualIntent、speakerNote。\n\
         contentBlocks 每页 3–6 个，每个含 label（不超过 12 字）、text（20–60 字）、detail（可选的补充说明）。\n\
         evidence 必须来自素材或素材理解，不得编造数字、年份、排名、奖项。\n\
         相邻页 pageTheme 不得重复；内容不足时合并主题，不要为凑页数重复或拆分。\n\
         relation 取 timeline/category/compare/cause/process/none；chartType 取 cards/timeline/process/matrix/compare/highlight/summary；density 取 anchor/dense/breathing/balanced。\n\
         bullets 作为展示摘要，使用“短标题：具体说明”的格式，不要与 contentBlocks 逐字重复。\n\
         不要输出占位文字、内部术语或未核实的结论。\n\
         如果某页适合用图表表达数据，增加 chart 字段：\n\
         {{\"type\":\"line|column|bar|pie|donut|area|gantt|radar|scatter\",\"categories\":[\"...\"],\"series\":[{{\"name\":\"...\",\"values\":[数字]}}]}}\n\
         只输出 JSON，不要 markdown 代码块。JSON 结构：\n\
         {{\"title\":\"...\",\"slides\":[{{\"page\":1,\"title\":\"...\",\"pageTheme\":\"...\",\"mainClaim\":\"...\",\"contentScope\":\"...\",\"coreMessage\":\"...\",\"contentBlocks\":[{{\"label\":\"...\",\"text\":\"...\",\"detail\":\"...\"}}],\"evidence\":[\"...\"],\"relation\":\"none\",\"chartType\":\"cards\",\"density\":\"balanced\",\"visualIntent\":\"...\",\"bullets\":[\"...\"],\"speakerNote\":\"...\",\"chart\":null}}]}}\n\n\
         素材理解：\n{understanding}{source_block}",
        page_instruction = page_instruction,
        title = input.title,
        audience = input.audience,
        extra = input.extra_requirements.clone().unwrap_or_default(),
        understanding = if understanding_excerpt.trim().is_empty() {
            "（暂无）"
        } else {
            understanding_excerpt.as_str()
        },
        source_block = source_block,
    );

    let mut last_reason = String::new();
    for attempt in 0..MAX_PLANNING_ATTEMPTS {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Custom("已取消大纲生成".into()));
        }
        plan_log.emit(
            app,
            &format!(
                "AI 规划第 {} 次尝试…（输入 {} 字符）",
                attempt + 1,
                prompt.chars().count()
            ),
        );
        // 流式输出时按已出现的 "page" 字段估算已生成页数，给出真实增量进度。
        let progress_app = app.cloned();
        let progress_job = job_id.to_string();
        let mut tail = String::new();
        let mut page_count = 0usize;
        let mut last_reported = 0usize;
        let future = AiService::complete_once_with_progress(
            db,
            &prompt,
            input.model_id,
            move |chunk| {
                let mut probe = String::with_capacity(tail.len() + chunk.len());
                probe.push_str(&tail);
                probe.push_str(chunk);
                let added = probe
                    .matches("\"page\"")
                    .count()
                    .saturating_sub(tail.matches("\"page\"").count());
                page_count += added;
                let reported = if expected_pages > 0 {
                    page_count.min(expected_pages)
                } else {
                    page_count
                };
                if reported > last_reported {
                    last_reported = reported;
                    let message = if expected_pages > 0 {
                        format!("AI 已生成 {reported}/{expected_pages} 页")
                    } else {
                        format!("AI 已生成 {reported} 页")
                    };
                    emit_plan_progress(
                        progress_app.as_ref(),
                        &progress_job,
                        "planning",
                        reported,
                        expected_pages,
                        &message,
                    );
                }
                // 只保留尾部，避免同一个 "page" 在跨 chunk 时被重复计数。
                let chars: Vec<char> = probe.chars().collect();
                let start = chars.len().saturating_sub(16);
                tail = chars[start..].iter().collect();
            },
        );
        match await_cancellable(future, cancel, planning_timeout).await {
            Ok(text) => {
                let parsed = extract_json(&text)
                    .and_then(|json| serde_json::from_str::<Value>(&json).ok());
                match parsed {
                    Some(value) => {
                        let raw_slides = value
                            .get("slides")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let raw_has_title = raw_slides.iter().any(|slide| {
                            slide
                                .get("title")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .map(|title| !title.is_empty())
                                .unwrap_or(false)
                        });
                        if !raw_slides.is_empty() && raw_has_title {
                            let plan = ppt_plan::normalize_plan(
                                value,
                                &input.title,
                                source,
                                input.slide_count,
                            );
                            return finalize_plan_with_validation(
                                db,
                                input,
                                plan,
                                understanding,
                                job_id,
                                app,
                                cancel,
                                planning_timeout,
                                plan_log,
                            )
                            .await;
                        }
                        last_reason = "AI 返回的大纲为空或缺少页面标题".to_string();
                    }
                    None => last_reason = "AI 返回内容不是合法 JSON".to_string(),
                }
            }
            Err(PlanRunError::Cancelled) => {
                return Err(AppError::Custom("已取消大纲生成".into()));
            }
            Err(PlanRunError::Timeout) => {
                last_reason = format!("AI 规划超时（{} 秒）", planning_timeout.as_secs());
            }
            Err(PlanRunError::Ai(err)) => last_reason = err,
        }
        if attempt + 1 < MAX_PLANNING_ATTEMPTS {
            plan_log.emit(app, &format!("AI 规划失败：{}；准备重试", last_reason));
        }
    }

    plan_log.emit(
        app,
        &format!("AI 规划不可用（{}），已按文档标题生成降级大纲", last_reason),
    );
    Ok(ppt_plan::normalize_plan(
        json!({}),
        &input.title,
        source,
        input.slide_count,
    ))
}

/// 校验大纲内容；有问题时尝试修复，修复失败保留原大纲。
#[allow(clippy::too_many_arguments)]
async fn finalize_plan_with_validation(
    db: &Database,
    input: &PptJobInput,
    plan: PptPlan,
    understanding: &str,
    job_id: &str,
    app: Option<&AppHandle>,
    cancel: &Arc<AtomicBool>,
    planning_timeout: Duration,
    plan_log: &PlanLog,
) -> Result<PptPlan, AppError> {
    let issues = validate_plan_content(&plan);
    if issues.is_empty() {
        emit_plan_progress(app, job_id, "validating", 1, 1, "大纲校验通过");
        return Ok(plan);
    }
    emit_plan_progress(
        app,
        job_id,
        "validating",
        0,
        1,
        &format!("大纲校验发现 {} 项问题", issues.len()),
    );
    plan_log.emit(
        app,
        &format!("大纲内容校验发现 {} 项问题，尝试修复", issues.len()),
    );
    emit_plan_progress(app, job_id, "repairing", 1, 1, "正在修复大纲内容");
    match repair_plan_with_ai(
        db,
        input,
        &plan,
        &issues,
        understanding,
        app,
        cancel,
        planning_timeout,
        plan_log,
    )
    .await
    {
        Ok(repaired) => {
            let remaining = validate_plan_content(&repaired);
            if remaining.is_empty() {
                emit_plan_progress(
                    app,
                    job_id,
                    "validating",
                    1,
                    1,
                    "大纲修复完成并通过校验",
                );
                return Ok(repaired);
            }
            plan_log.emit(
                app,
                &format!(
                    "修复后仍有 {} 项问题，保留原始大纲",
                    remaining.len()
                ),
            );
        }
        Err(AppError::Custom(message)) if message.contains("取消") => {
            return Err(AppError::Custom(message));
        }
        Err(error) => plan_log.emit(
            app,
            &format!("大纲内容修复失败：{}", error),
        ),
    }
    Ok(plan)
}

/// 两阶段页级大纲：先确定页标题清单，再逐页扩展。
/// 只在用户明确指定页数时启用；第一阶段失败会回退到单次规划。
#[allow(clippy::too_many_arguments)]
async fn build_plan_two_stage(
    db: &Database,
    input: &PptJobInput,
    source: &str,
    understanding: &str,
    job_id: &str,
    app: Option<&AppHandle>,
    cancel: &Arc<AtomicBool>,
    planning_timeout: Duration,
    plan_log: &PlanLog,
) -> Result<PptPlan, AppError> {
    let page_count = input.slide_count.unwrap_or(0).clamp(3, 40);
    let understanding_excerpt: String = understanding
        .chars()
        .take(PLANNING_CONTEXT_CHARS)
        .collect();
    let titles_prompt = format!(
        "你是 PPT 内容规划助手。请先只规划页面标题清单，不展开正文。\n\
         标题：{title}\n听众：{audience}\n额外要求：{extra}\n\
         必须恰好输出 {page_count} 页：第 1 页是封面，最后 1 页是结束页，中间页覆盖素材的主要主题。\n\
         每页给出 page 和 title，pageTheme 用一句话概括该页主题；相邻页 pageTheme 不得重复。\n\
         只输出 JSON，不要 markdown 代码块：\n\
         {{\"title\":\"...\",\"slides\":[{{\"page\":1,\"title\":\"...\",\"pageTheme\":\"...\"}}]}}\n\n\
         素材理解：\n{understanding}",
        title = input.title,
        audience = input.audience,
        extra = input.extra_requirements.clone().unwrap_or_default(),
        page_count = page_count,
        understanding = if understanding_excerpt.trim().is_empty() {
            "（暂无）"
        } else {
            understanding_excerpt.as_str()
        },
    );
    plan_log.emit(
        app,
        &format!(
            "两阶段大纲：先生成 {page_count} 页标题清单（输入 {} 字符）",
            titles_prompt.chars().count()
        ),
    );
    emit_plan_progress(
        app,
        job_id,
        "planning",
        0,
        page_count,
        &format!("正在规划 {page_count} 页标题"),
    );
    let first_stage_timeout = planning_timeout.min(Duration::from_secs(180));
    let titles_text = await_cancellable(
        AiService::complete_once(db, &titles_prompt, input.model_id),
        cancel,
        first_stage_timeout,
    )
    .await
    .map_err(|error| match error {
        PlanRunError::Cancelled => AppError::Custom("已取消大纲生成".into()),
        PlanRunError::Timeout => AppError::Custom("标题规划超时".into()),
        PlanRunError::Ai(message) => AppError::Custom(message),
    })?;
    let titles = extract_json(&titles_text)
        .and_then(|json| serde_json::from_str::<Value>(&json).ok())
        .and_then(|value| value.get("slides").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let mut title_list: Vec<(String, String)> = titles
        .iter()
        .filter_map(|item| {
            let title = item.get("title").and_then(Value::as_str)?.trim().to_string();
            if title.is_empty() {
                return None;
            }
            let theme = item
                .get("pageTheme")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            Some((title, theme))
        })
        .collect();
    title_list.truncate(page_count);
    if title_list.len() < 3 || title_list.len() * 2 < page_count {
        return Err(AppError::Custom("标题清单不足，回退单次规划".into()));
    }
    // 补齐用户要求的页数：标题不足时在末尾补内容页占位，后续扩展会生成真实内容。
    while title_list.len() < page_count {
        let index = title_list.len() + 1;
        title_list.push((format!("第 {index} 部分"), String::new()));
    }
    emit_plan_progress(
        app,
        job_id,
        "planning",
        0,
        title_list.len(),
        &format!("标题清单已完成，共 {} 页，开始逐页扩展", title_list.len()),
    );

    let title_lines = title_list
        .iter()
        .enumerate()
        .map(|(index, (title, theme))| {
            if theme.is_empty() {
                format!("{}. {}", index + 1, title)
            } else {
                format!("{}. {}（{}）", index + 1, title, theme)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let source_excerpt: String = if understanding_excerpt.trim().chars().count() < 4_000 {
        source.chars().take(PLANNING_SOURCE_FALLBACK_CHARS).collect()
    } else {
        String::new()
    };
    let source_block = if source_excerpt.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n素材节选：\n{source_excerpt}")
    };

    let mut expanded: Vec<Option<Value>> = vec![None; title_list.len()];
    for chunk_start in (0..title_list.len()).step_by(2) {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Custom("已取消大纲生成".into()));
        }
        let chunk_end = (chunk_start + 2).min(title_list.len());
        let mut futures = Vec::new();
        for index in chunk_start..chunk_end {
            let (title, theme) = title_list[index].clone();
            let prompt = format!(
                "你是 PPT 内容规划助手。请只扩展第 {page} 页，输出该页完整结构化内容。\n\
                 总标题：{deck_title}\n听众：{audience}\n额外要求：{extra}\n\
                 完整页面清单：\n{title_lines}\n\n\
                 本页标题：{title}\n本页主题：{theme}\n\
                 {page_role}\n\
                 必须输出：pageTheme、mainClaim、contentScope、contentBlocks、evidence、relation、chartType、density、visualIntent、speakerNote、bullets。\n\
                 contentBlocks 3–6 个，每个含 label（不超过 12 字）、text（20–60 字）、detail（可选）。\n\
                 evidence 必须来自素材或素材理解，不得编造数字、年份、排名、奖项。\n\
                 relation 取 timeline/category/compare/cause/process/none；chartType 取 cards/timeline/process/matrix/compare/highlight/summary；density 取 anchor/dense/breathing/balanced。\n\
                 如果适合图表，增加 chart：{{\"type\":\"line|column|bar|pie|donut|area|gantt|radar|scatter\",\"categories\":[\"...\"],\"series\":[{{\"name\":\"...\",\"values\":[数字]}}]}}，否则 chart 为 null。\n\
                 只输出一个 JSON 对象，不要 markdown 代码块：\n\
                 {{\"page\":{page},\"title\":\"...\",\"pageTheme\":\"...\",\"mainClaim\":\"...\",\"contentScope\":\"...\",\"coreMessage\":\"...\",\"contentBlocks\":[{{\"label\":\"...\",\"text\":\"...\",\"detail\":\"...\"}}],\"evidence\":[\"...\"],\"relation\":\"none\",\"chartType\":\"cards\",\"density\":\"balanced\",\"visualIntent\":\"...\",\"bullets\":[\"...\"],\"speakerNote\":\"...\",\"chart\":null}}\n\n\
                 素材理解：\n{understanding}{source_block}",
                page = index + 1,
                deck_title = input.title,
                audience = input.audience,
                extra = input.extra_requirements.clone().unwrap_or_default(),
                title_lines = title_lines,
                title = title,
                theme = if theme.is_empty() { "（未指定）" } else { theme.as_str() },
                page_role = if index == 0 {
                    "这是封面页：只填 title 和一句 coreMessage，bullets/contentBlocks 为空。"
                } else if index + 1 == title_list.len() {
                    "这是结束页：bullets 不超过 2 条，简要收束全篇。"
                } else {
                    "这是内容页：围绕本页主题展开，不要与相邻页重复。"
                },
                understanding = if understanding_excerpt.trim().is_empty() {
                    "（暂无）"
                } else {
                    understanding_excerpt.as_str()
                },
                source_block = source_block,
            );
            futures.push(expand_plan_slide(
                db,
                prompt,
                input.model_id,
                cancel,
                index,
            ));
        }
        let results = if futures.len() == 1 {
            vec![futures.remove(0).await]
        } else {
            let first = futures.remove(0);
            let second = futures.remove(0);
            let (left, right) = tokio::join!(first, second);
            vec![left, right]
        };
        for result in results {
            if let Some((index, value)) = result {
                expanded[index] = Some(value);
                let done = expanded.iter().filter(|item| item.is_some()).count();
                emit_plan_progress(
                    app,
                    job_id,
                    "planning",
                    done,
                    title_list.len(),
                    &format!(
                        "AI 正在扩展第 {}/{} 页",
                        index + 1,
                        title_list.len()
                    ),
                );
            }
        }
    }
    let missing = expanded.iter().filter(|item| item.is_none()).count();
    if missing > 0 {
        return Err(AppError::Custom(format!(
            "{missing} 页扩展失败，回退单次规划"
        )));
    }
    let slides = expanded
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let mut value = value?;
            value["page"] = json!(index + 1);
            if value
                .get("title")
                .and_then(Value::as_str)
                .map(|title| title.trim().is_empty())
                .unwrap_or(true)
            {
                value["title"] = json!(title_list[index].0);
            }
            Some(value)
        })
        .collect::<Vec<_>>();
    let raw = json!({ "title": input.title, "slides": slides });
    let plan = ppt_plan::normalize_plan(raw, &input.title, source, input.slide_count);
    plan_log.emit(
        app,
        &format!("两阶段大纲完成：{} 页，开始内容校验", plan.slides.len()),
    );
    finalize_plan_with_validation(
        db,
        input,
        plan,
        understanding,
        job_id,
        app,
        cancel,
        planning_timeout,
        plan_log,
    )
    .await
}

async fn expand_plan_slide(
    db: &Database,
    prompt: String,
    model_id: Option<i64>,
    cancel: &Arc<AtomicBool>,
    index: usize,
) -> Option<(usize, Value)> {
    let text = await_cancellable(
        AiService::complete_once(db, &prompt, model_id),
        cancel,
        Duration::from_secs(150),
    )
    .await
    .ok()?;
    let value = extract_json(&text)
        .and_then(|json| serde_json::from_str::<Value>(&json).ok())?;
    if !value.as_object()?.contains_key("title") {
        return None;
    }
    Some((index, value))
}

/// 等待一个可能较慢的 Future，同时支持取消与超时。
async fn await_cancellable<F, T>(
    future: F,
    cancel: &AtomicBool,
    limit: Duration,
) -> Result<T, PlanRunError>
where
    F: Future<Output = Result<T, AppError>>,
{
    let started = Instant::now();
    tokio::pin!(future);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(PlanRunError::Cancelled);
        }
        if started.elapsed() >= limit {
            return Err(PlanRunError::Timeout);
        }
        tokio::select! {
            result = &mut future => {
                return result.map_err(|error| PlanRunError::Ai(error.to_string()));
            }
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        }
    }
}

fn extract_json(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if end > start {
            return Some(trimmed[start..=end].to_string());
        }
    }
    None
}

fn clean_meta_title(value: &str) -> String {
    let trimmed = value
        .trim()
        .trim_end_matches("PPT")
        .trim_end_matches("ppt")
        .trim();
    let trimmed = trimmed
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '“' | '”' | '「' | '」' | '《' | '》'))
        .trim();
    trimmed.chars().take(40).collect()
}

fn clean_meta_audience(value: &str) -> String {
    let trimmed = value
        .trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '“' | '”' | '「' | '」'))
        .trim();
    let first = trimmed
        .split(['，', ',', '、', ';', '；'])
        .next()
        .unwrap_or(trimmed)
        .trim();
    first.chars().take(12).collect()
}

fn fallback_meta_title(sources: &[PptMetaSource]) -> String {
    for source in sources {
        let title = source.title.trim();
        if title.is_empty() {
            continue;
        }
        let stem = Path::new(title)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(title)
            .trim();
        if !stem.is_empty() {
            return stem.chars().take(40).collect();
        }
    }
    "未命名演示".to_string()
}

fn job_timeout_secs(job_dir: &Path) -> u64 {
    let Ok(text) = fs::read_to_string(job_dir.join("job.json")) else {
        return DEFAULT_TIMEOUT_SECS;
    };
    let Ok(spec) = serde_json::from_str::<Value>(&text) else {
        return DEFAULT_TIMEOUT_SECS;
    };
    spec.get("options")
        .and_then(|options| options.get("timeoutSecs"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(30, 7200)
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("目标文件缺少父目录".into()))?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("job.json"),
        Uuid::new_v4()
    ));
    fs::write(&temp, serde_json::to_vec_pretty(value)?)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temp, path)?;
    Ok(())
}

fn update_job_json_stage(job_dir: &Path, stage: &str) -> Result<(), AppError> {
    let path = job_dir.join("job.json");
    let mut spec = if path.is_file() {
        serde_json::from_str::<Value>(&fs::read_to_string(&path)?)?
    } else {
        json!({})
    };
    if !spec.is_object() {
        spec = json!({});
    }
    if !spec.get("options").map(Value::is_object).unwrap_or(false) {
        spec["options"] = json!({});
    }
    spec["options"]["stage"] = json!(stage);
    write_json_atomic(&path, &spec)
}

fn count_draft_pages(job_dir: &Path) -> Result<usize, AppError> {
    let svg_dir = job_dir.join("project").join("svg_output");
    if !svg_dir.is_dir() {
        return Ok(0);
    }
    let mut count = 0usize;
    for entry in fs::read_dir(svg_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("svg"))
                .unwrap_or(false)
        {
            count += 1;
        }
    }
    Ok(count)
}

/// 清空草稿页；大纲或版式变化后旧页面不再有效。
fn clear_draft_pages(job_dir: &Path) -> Result<(), AppError> {
    let svg_dir = job_dir.join("project").join("svg_output");
    if !svg_dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(&svg_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file()
            && path
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

fn clear_output_pptx(job_dir: &Path) -> Result<(), AppError> {
    let output = job_dir.join("output");
    if !output.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(output)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("pptx"))
                .unwrap_or(false)
        {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

fn parse_page_number(file: &str) -> Option<u32> {
    let stem = Path::new(file).file_stem()?.to_str()?;
    let digits: String = stem
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u32>().ok()
    }
}

fn natural_page_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    match (parse_page_number(left), parse_page_number(right)) {
        (Some(a), Some(b)) => a.cmp(&b).then_with(|| left.cmp(right)),
        _ => left.cmp(right),
    }
}

fn update_job_json_plan_options(
    job_dir: &Path,
    slide_count: Option<usize>,
    model_id: Option<i64>,
) -> Result<(), AppError> {
    let path = job_dir.join("job.json");
    let mut spec = if path.is_file() {
        serde_json::from_str::<Value>(&fs::read_to_string(&path)?)?
    } else {
        json!({})
    };
    if !spec.is_object() {
        spec = json!({});
    }
    if !spec.get("options").map(Value::is_object).unwrap_or(false) {
        spec["options"] = json!({});
    }
    spec["options"]["slideCount"] = json!(slide_count);
    spec["options"]["modelId"] = json!(model_id);
    write_json_atomic(&path, &spec)
}

fn update_job_json_plan(job_dir: &Path, plan: &PptPlan) -> Result<(), AppError> {
    let path = job_dir.join("job.json");
    let mut spec = if path.is_file() {
        serde_json::from_str::<Value>(&fs::read_to_string(&path)?)?
    } else {
        json!({})
    };
    if !spec.is_object() {
        spec = json!({});
    }
    spec["plan"] = serde_json::to_value(plan)?;
    write_json_atomic(&path, &spec)
}

fn validate_pptx(path: &Path) -> Result<(), AppError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() == 0 {
        return Err(AppError::InvalidInput("生成的 pptx 为空文件".into()));
    }
    let file = fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| AppError::InvalidInput(format!("生成的 pptx 不是有效 zip: {error}")))?;
    let has_content_types = archive.by_name("[Content_Types].xml").is_ok();
    let has_presentation = archive.by_name("ppt/presentation.xml").is_ok();
    if !has_content_types || !has_presentation {
        return Err(AppError::InvalidInput(
            "生成的 pptx 缺少必要的 PowerPoint 结构".into(),
        ));
    }
    Ok(())
}

fn locate_output(job_dir: &Path) -> Result<PathBuf, AppError> {
    let output = job_dir.join("output");
    if !output.is_dir() {
        return Err(AppError::NotFound("扩展未生成 output 目录".into()));
    }
    let output_canonical = fs::canonicalize(&output)?;
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut last_error: Option<String> = None;
    for entry in fs::read_dir(&output)? {
        let entry = entry?;
        let path = entry.path();
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("pptx"))
            .unwrap_or(false)
        {
            continue;
        }
        let canonical = match fs::canonicalize(&path) {
            Ok(value) => value,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        if !canonical.starts_with(&output_canonical) {
            last_error = Some(format!("输出文件越界: {}", canonical.display()));
            continue;
        }
        if let Err(error) = validate_pptx(&canonical) {
            last_error = Some(error.to_string());
            continue;
        }
        let modified = fs::metadata(&canonical)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((modified, canonical));
    }
    candidates.sort_by_key(|(modified, _)| *modified);
    candidates
        .pop()
        .map(|(_, path)| path)
        .ok_or_else(|| {
            AppError::NotFound(match last_error {
                Some(reason) => format!("未找到有效的 .pptx：{reason}"),
                None => "未找到生成的 .pptx".into(),
            })
        })
}

fn copy_to_export(source: &Path, export_dir: &str, title: &str) -> Result<String, AppError> {
    let dir = PathBuf::from(export_dir);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!(
            "导出目录不存在: {}",
            dir.display()
        )));
    }
    let stem = safe_filename::sanitize_stem(title);
    let filename = format!(
        "{}_{}.pptx",
        if stem.is_empty() { "AI_PPT" } else { &stem },
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    let target = dir.join(filename);
    fs::copy(source, &target)?;
    Ok(target.to_string_lossy().to_string())
}

// ───────────────────────── P1：逐页 AI 生成与质量闭环 ─────────────────────────

const AI_PAGE_MIN_SCORE: i32 = 55;
const AI_PAGE_TIMEOUT_SECS: u64 = 180;
const AI_PROMPT_UNDERSTANDING_CHARS: usize = 8_000;
/// 单页模板参考最多注入的字符数，避免 prompt 过长。
const AI_TEMPLATE_PAGE_CHARS: usize = 8_000;
/// design_spec 中设计元素与页面清单最多注入的字符数。
const AI_TEMPLATE_ROSTER_CHARS: usize = 3_000;

#[derive(Debug, Clone)]
struct PageCandidateScore {
    score: i32,
    issues: Vec<String>,
    hard_fail: bool,
    svg: String,
}

fn extract_svg_block(text: &str) -> Option<String> {
    let start = text.find("<svg")?;
    let end = text.rfind("</svg>")?;
    if end <= start {
        return None;
    }
    Some(text[start..=end + 5].trim().to_string())
}

/// AI 生成的页面是整页绝对坐标，不能携带模板的 master/layout/bounds 元数据；
/// 否则 flat 导出会因结构校验失败而回退纯文本。
fn sanitize_ai_svg(svg: &str) -> String {
    let Ok(meta_re) = regex::Regex::new(r##"\s+data-pptx-[a-zA-Z0-9_-]+="[^"]*""##) else {
        return svg.to_string();
    };
    let mut cleaned = meta_re.replace_all(svg, "").to_string();
    // drawingml 转换器没有 dominant-baseline / dy 映射，直接移除；
    // 文本基线会有轻微偏移，但比整份 PPT 回退纯文本更可接受。
    for pattern in [
        r##"\s+dominant-baseline="[^"]*""##,
        r##"\s+alignment-baseline="[^"]*""##,
        r##"\s+paint-order="[^"]*""##,
        r##"\s+vector-effect="[^"]*""##,
        r##"\s+mix-blend-mode="[^"]*""##,
        r##"\s+isolation="[^"]*""##,
    ] {
        if let Ok(re) = regex::Regex::new(pattern) {
            cleaned = re.replace_all(&cleaned, "").to_string();
        }
    }
    cleaned
}

fn svg_visible_text(svg: &str) -> String {
    let Ok(re) = regex::Regex::new(r"(?s)<text[^>]*>(.*?)</text>") else {
        return String::new();
    };
    let tag_re = regex::Regex::new(r"<[^>]+>").ok();
    let mut out = String::new();
    for capture in re.captures_iter(svg) {
        let raw = capture.get(1).map(|m| m.as_str()).unwrap_or("");
        let cleaned = if let Some(tag_re) = tag_re.as_ref() {
            tag_re.replace_all(raw, " ").to_string()
        } else {
            raw.to_string()
        };
        out.push_str(&cleaned);
        out.push(' ');
    }
    out
}

/// 解析作业版式目录：优先用户模板，其次扩展包；同时快照到作业目录。
fn resolve_job_template_dir(
    db: &Database,
    extension: &ExtensionInfo,
    job_dir: &Path,
    layout_id: &str,
) -> Option<PathBuf> {
    if layout_id.trim().is_empty() {
        return None;
    }
    let resolved = PptTemplateService::resolve_layout(db, extension, layout_id)?;
    log::debug!(
        "版式 {} 来源={} 目录={}",
        layout_id,
        resolved.source,
        resolved.roster_dir.display()
    );
    match PptTemplateService::ensure_job_template_snapshot(job_dir, &resolved, layout_id) {
        Ok(dir) => Some(dir),
        Err(err) => {
            log::warn!("版式快照失败，回退直接读取: {}", err);
            Some(resolved.roster_dir)
        }
    }
}

fn template_colors(template_dir: Option<&Path>) -> std::collections::HashSet<String> {
    let mut colors = std::collections::HashSet::new();
    if let Some(dir) = template_dir {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("svg") {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                if let Ok(re) =
                    regex::Regex::new(r##"(?:fill|stroke)="#([0-9A-Fa-f]{6})""##)
                {
                    for capture in re.captures_iter(&text) {
                        if let Some(value) = capture.get(1) {
                            colors.insert(format!("#{}", value.as_str().to_uppercase()));
                        }
                    }
                }
            }
        }
    }
    for neutral in ["#FFFFFF", "#000000", "#1F2937", "#595959", "#D9E2EC"] {
        colors.insert(neutral.to_string());
    }
    colors
}

fn build_spec_lock(template_dir: Option<&Path>, plan: &PptPlan) -> String {
    let colors = template_colors(template_dir);
    let mut palette = colors.into_iter().collect::<Vec<_>>();
    palette.sort();
    let palette_text = palette
        .iter()
        .take(20)
        .map(|color| format!("- {color}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# Slide Spec Lock\n\n\
         主题：{}\n页数：{}\n\n\
         ## Palette\n{}\n\
         - 除以上颜色外，仅允许白色 #FFFFFF 与中性灰。\n\n\
         ## Typography\n\
         - 字体：Microsoft YaHei, PingFang SC, Arial, sans-serif\n\
         - 页面标题：30–40\n\
         - 模块标题：18–24\n\
         - 正文：14–18\n\
         - 注释/页码：10–12\n\
         - 最小字号：10\n\n\
         ## Layout\n\
         - 画布：1280 × 720，viewBox=\"0 0 1280 720\"\n\
         - 每页必须有标题、内容层级和页码\n\
         - 相邻页不得使用相同版式或相同视觉签名\n\
         - 留白节奏：anchor（少字大图）/ dense（多块结构）/ breathing（一主张一支撑）\n\n\
         ## Forbidden\n\
         - SVG 元素：use、foreignObject、style、filter、mask、clipPath、textPath、script、iframe\n\
         - 外部图片链接、rgba() 颜色\n\
         - 可见文本中不得出现 Prompt/spec_lock/design_spec/pageTheme/contentScope/chartType/Executor/Workflow/fallback 等内部术语或产品名\n",
        plan.title, plan.slides.len(), palette_text
    )
}

/// 模板中的单个页面引用，page_type 由文件名去掉编号前缀得到。
#[derive(Clone, Debug)]
struct TemplatePageRef {
    page_type: String,
    path: PathBuf,
}

/// 当前作业可用的模板参考：页面清单 + design_spec 摘要。
#[derive(Clone, Debug, Default)]
struct TemplateReference {
    layout_id: String,
    pages: Vec<TemplatePageRef>,
    roster: String,
}

impl TemplateReference {
    fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }

    /// 为当前页选择最贴近的模板页，并生成注入 prompt 的参考文本。
    fn hint_for(&self, slide: &PptSlide, index: usize, total: usize) -> String {
        let Some(page) = choose_template_page(&self.pages, slide, index, total) else {
            return String::new();
        };
        let Ok(svg) = fs::read_to_string(&page.path) else {
            return String::new();
        };
        let tokens = placeholder_tokens(&svg);
        let mut page_svg: String = svg.chars().take(AI_TEMPLATE_PAGE_CHARS).collect();
        if page_svg.chars().count() < svg.chars().count() {
            page_svg.push_str("\n<!-- 模板页已截断 -->");
        }
        let file_name = page
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let slot_text = if tokens.is_empty() {
            "无显式占位符，请按模板页的栅格与层级自行组织".to_string()
        } else {
            tokens.join("、")
        };
        format!(
            "当前页建议模板版式：{}/{}（{}）\n\
             模板槽位：{}\n\
             注意：以下 SVG 仅作版式、栅格、装饰与视觉层级参考；必须替换为当前页内容，\
             不能保留任何 {{{{TOKEN}}}} 占位符，也不能照抄模板中的示例文案。\n\n{}",
            self.layout_id, page.page_type, file_name, slot_text, page_svg
        )
    }
}

/// 从文件名推导页型：去掉 `01_` / `01a_` 前缀并转小写。
fn derive_template_page_type(stem: &str) -> String {
    let bytes = stem.as_bytes();
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index > 0 {
        if index < bytes.len() && bytes[index].is_ascii_lowercase() {
            index += 1;
        }
        if index < bytes.len() && bytes[index] == b'_' {
            index += 1;
        }
    }
    stem.get(index..).unwrap_or("").to_ascii_lowercase()
}

fn template_page_refs(template_dir: Option<&Path>) -> Vec<TemplatePageRef> {
    let Some(dir) = template_dir else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut pages: Vec<TemplatePageRef> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("svg")
        })
        .filter_map(|path| {
            let stem = path.file_stem()?.to_str()?;
            let page_type = derive_template_page_type(stem);
            (!page_type.is_empty()).then_some(TemplatePageRef { page_type, path })
        })
        .collect();
    pages.sort_by(|left, right| left.path.cmp(&right.path));
    pages
}

/// 提取 design_spec 中的设计元素与页面清单，限制长度避免 prompt 膨胀。
fn template_roster(template_dir: Option<&Path>) -> String {
    let Some(dir) = template_dir else {
        return String::new();
    };
    let Ok(text) = fs::read_to_string(dir.join("design_spec.md")) else {
        return String::new();
    };
    let mut sections = Vec::new();
    for marker in ["## IV. Signature Design Elements", "## V. Page Roster"] {
        if let Some(start) = text.find(marker) {
            let rest = &text[start..];
            let end = rest[marker.len()..]
                .find("\n## ")
                .map(|offset| marker.len() + offset)
                .unwrap_or(rest.len());
            sections.push(rest[..end].trim().to_string());
        }
    }
    let joined = sections.join("\n\n");
    joined.chars().take(AI_TEMPLATE_ROSTER_CHARS).collect()
}

fn build_template_reference(
    template_dir: Option<&Path>,
    layout_id: &str,
) -> TemplateReference {
    TemplateReference {
        layout_id: layout_id.to_string(),
        pages: template_page_refs(template_dir),
        roster: template_roster(template_dir),
    }
}

fn placeholder_tokens(svg: &str) -> Vec<String> {
    let Ok(re) = regex::Regex::new(r"\{\{([A-Z0-9_]+)\}\}") else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let mut tokens = Vec::new();
    for capture in re.captures_iter(svg) {
        if let Some(value) = capture.get(1) {
            let token = value.as_str().to_string();
            if seen.insert(token.clone()) {
                tokens.push(token);
            }
        }
    }
    tokens
}

fn pick_page_type(available: &[&str], candidates: &[&str]) -> Option<String> {
    candidates.iter().find_map(|candidate| {
        available
            .iter()
            .find(|page_type| page_type.eq_ignore_ascii_case(candidate))
            .map(|page_type| (*page_type).to_string())
    })
}

fn is_toc_title(title: &str) -> bool {
    let lower = title.to_ascii_lowercase();
    title.contains("目录")
        || lower.contains("agenda")
        || lower.contains("contents")
        || lower.contains("table of contents")
}

fn is_chapter_title(title: &str) -> bool {
    let trimmed = title.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("part ") || lower.starts_with("section ") {
        return true;
    }
    if let Some(rest) = trimmed.strip_prefix('第') {
        return !rest.is_empty()
            && rest
                .chars()
                .any(|ch| matches!(ch, '章' | '节' | '部' | '分'));
    }
    false
}

fn title_page_candidates(title: &str) -> Vec<&'static str> {
    let lower = title.to_ascii_lowercase();
    let rules: &[(&[&str], &[&str])] = &[
        (
            &["表格", "清单"],
            &["content_table", "performance_table", "summary_table"],
        ),
        (
            &["kpi", "指标", "完成情况", "达成", "绩效", "dashboard"],
            &[
                "kpi_overview",
                "metrics_dashboard",
                "performance_table",
                "importance_performance",
            ],
        ),
        (
            &[
                "核心发现",
                "关键发现",
                "主要发现",
                "发现",
                "洞察",
                "insight",
                "finding",
            ],
            &[
                "key_findings",
                "core_insight",
                "conclusions",
                "executive_summary",
            ],
        ),
        (
            &["执行摘要", "摘要", "executive summary"],
            &["executive_summary", "summary"],
        ),
        (
            &["趋势", "走势", "增长", "变化"],
            &["trend_chart", "data_comparison", "distribution"],
        ),
        (
            &["结构", "构成", "占比", "分布"],
            &["structure_breakdown", "distribution"],
        ),
        (
            &["风险", "预警", "隐患", "危机"],
            &["risk_gauge", "risk_matrix", "macro_crisis"],
        ),
        (
            &["对比", "比较", "差异", "vs"],
            &[
                "comparison",
                "comparison_table",
                "data_comparison",
                "core_difference",
            ],
        ),
        (
            &["年度", "回顾", "季度", "项目进展"],
            &["annual_review", "initiative_priority"],
        ),
        (
            &["汇总", "总结", "小结", "结论"],
            &["summary_table", "summary", "conclusions", "conclusion"],
        ),
        (
            &["流程", "步骤", "路线", "实施", "路径", "落地"],
            &["process_steps", "workflow", "roadmap", "decision_tree"],
        ),
        (
            &["原因", "根因", "为什么", "机理"],
            &["root_cause", "content"],
        ),
        (
            &["模型", "框架", "架构", "体系"],
            &[
                "model_diagram",
                "framework",
                "strategy_pillars",
                "research_architecture",
            ],
        ),
        (&["案例", "实践"], &["case_study", "modern_application"]),
        (
            &["概念", "定义", "含义", "溯源", "词源"],
            &["concept_definition", "etymology"],
        ),
        (
            &["参数", "规格", "技术"],
            &["technical_params", "product_card"],
        ),
        (
            &["商业模式", "融资", "资金"],
            &["business_model", "financing_structure"],
        ),
        (&["组合", "搭配"], &["combination"]),
        (
            &["参考", "阅读"],
            &["recommended_reading", "quick_reference", "appendix"],
        ),
        (&["展望", "规划"], &["outlook", "roadmap"]),
        (&["定位"], &["positioning", "project_positioning"]),
        (
            &["引用", "名言", "金句", "quote"],
            &["quote", "core_insight"],
        ),
        (
            &["决策", "decision"],
            &["decision_tree", "combination"],
        ),
        (&["附录", "appendix"], &["appendix", "quick_reference"]),
        (
            &["位置图", "位置"],
            &["position_map", "content_text_image"],
        ),
        (
            &["图文", "配图"],
            &["content_text_image", "content"],
        ),
        (&["卡片"], &["content_cards", "product_card"]),
        (&["法则", "规律"], &["four_laws", "core_insight"]),
        (&["六爻"], &["six_yao_overview", "yao_detail"]),
        (
            &["关系网络", "关系图谱"],
            &["relationship_network"],
        ),
        (
            &["现代应用", "当代应用"],
            &["modern_application"],
        ),
        (
            &["举措", "优先级"],
            &["initiative_priority", "importance_performance"],
        ),
        (
            &["看板", "仪表盘"],
            &["metrics_dashboard", "kpi_overview"],
        ),
        (&["速查"], &["quick_reference"]),
        (&["产品卡", "产品介绍"], &["product_card"]),
        (&["安全", "注意"], &["safety_notice"]),
    ];
    for (keywords, page_types) in rules {
        if keywords.iter().any(|keyword| lower.contains(keyword)) {
            return page_types.to_vec();
        }
    }
    Vec::new()
}

fn choose_template_page_type(
    slide: &PptSlide,
    index: usize,
    total: usize,
    available: &[&str],
) -> Option<String> {
    if available.is_empty() {
        return None;
    }
    if index == 0 {
        if let Some(cover) = pick_page_type(available, &["cover"]) {
            return Some(cover);
        }
    }
    if index + 1 == total && total > 2 && slide.bullets.len() < 3 {
        if let Some(ending) = pick_page_type(available, &["ending"]) {
            return Some(ending);
        }
    }
    if is_toc_title(&slide.title) {
        if let Some(toc) = pick_page_type(available, &["toc", "contents", "agenda"]) {
            return Some(toc);
        }
    }
    if is_chapter_title(&slide.title) {
        if let Some(chapter) = pick_page_type(available, &["chapter", "section"]) {
            return Some(chapter);
        }
    }

    let title_candidates = title_page_candidates(&slide.title);
    if let Some(found) = pick_page_type(available, &title_candidates) {
        return Some(found);
    }

    let chart_type = slide.chart_type.trim().to_ascii_lowercase();
    let chart_candidates: &[&str] = match chart_type.as_str() {
        "timeline" | "process" => &[
            "process_steps",
            "workflow",
            "roadmap",
            "annual_review",
        ],
        "compare" => &[
            "comparison",
            "comparison_table",
            "data_comparison",
            "content_table",
        ],
        "matrix" => &[
            "performance_table",
            "comparison_table",
            "content_table",
            "risk_matrix",
            "importance_performance",
        ],
        "cards" => &[
            "key_findings",
            "content_cards",
            "core_insight",
            "executive_summary",
            "strategy_pillars",
        ],
        "highlight" => &[
            "key_findings",
            "core_insight",
            "executive_summary",
            "risk_gauge",
            "safety_notice",
        ],
        "summary" => &[
            "summary_table",
            "summary",
            "conclusions",
            "conclusion",
            "executive_summary",
        ],
        "table" => &[
            "performance_table",
            "content_table",
            "comparison_table",
            "summary_table",
        ],
        _ => &[],
    };
    if let Some(found) = pick_page_type(available, chart_candidates) {
        return Some(found);
    }

    let relation = slide.relation.trim().to_ascii_lowercase();
    let relation_candidates: &[&str] = match relation.as_str() {
        "timeline" | "process" => &[
            "process_steps",
            "workflow",
            "roadmap",
            "annual_review",
        ],
        "compare" => &[
            "comparison",
            "comparison_table",
            "data_comparison",
            "content_table",
        ],
        "cause" => &["root_cause", "content"],
        "category" => &[
            "content_cards",
            "key_findings",
            "structure_breakdown",
            "executive_summary",
        ],
        "hierarchy" => &[
            "framework",
            "strategy_pillars",
            "model_diagram",
        ],
        _ => &[],
    };
    if let Some(found) = pick_page_type(available, relation_candidates) {
        return Some(found);
    }

    if slide.chart.is_some() {
        if let Some(found) = pick_page_type(
            available,
            &[
                "trend_chart",
                "data_comparison",
                "distribution",
                "metrics_dashboard",
            ],
        ) {
            return Some(found);
        }
    }

    let density = slide.density.trim().to_ascii_lowercase();
    let density_candidates: &[&str] = match density.as_str() {
        "dense" => &[
            "content_table",
            "performance_table",
            "summary_table",
            "content",
        ],
        "anchor" => &[
            "content",
            "content_text_image",
            "case_study",
            "core_insight",
        ],
        "breathing" => &["content", "content_text_image", "core_insight"],
        _ => &[],
    };
    if let Some(found) = pick_page_type(available, density_candidates) {
        return Some(found);
    }

    if let Some(found) = pick_page_type(
        available,
        &[
            "content",
            "executive_summary",
            "key_findings",
            "core_insight",
            "summary",
            "conclusions",
            "conclusion",
        ],
    ) {
        return Some(found);
    }

    available
        .iter()
        .find(|page_type| {
            !matches!(
                **page_type,
                "cover" | "toc" | "contents" | "agenda" | "chapter" | "ending"
            )
        })
        .map(|page_type| (*page_type).to_string())
}

fn choose_template_page<'a>(
    pages: &'a [TemplatePageRef],
    slide: &PptSlide,
    index: usize,
    total: usize,
) -> Option<&'a TemplatePageRef> {
    let available: Vec<&str> = pages.iter().map(|page| page.page_type.as_str()).collect();
    let page_type = choose_template_page_type(slide, index, total, &available)?;
    pages
        .iter()
        .find(|page| page.page_type.eq_ignore_ascii_case(&page_type))
}

fn layout_hint(slide: &PptSlide) -> &'static str {
    match slide.chart_type.as_str() {
        "timeline" => "横向时间线：至少 4 个节点，节点含年份/阶段与一句说明",
        "process" => "流程步骤：3–5 个带编号的步骤，用箭头或连接线表示顺序",
        "compare" => "左右对比：两栏结构，共享对比维度，避免每栏各说各话",
        "matrix" => "矩阵/二维分类：2×2 或表格化布局，每个格子有明确标签",
        "highlight" => "重点页：一个大数字/大引述 + 2–3 条支撑说明",
        "summary" => "总结页：3–5 条结论，层级清楚，避免长篇段落",
        "cards" => "卡片网格：2×2、2×3 或 3×2，每卡有短标题与 1–2 行说明",
        _ => match slide.relation.as_str() {
            "timeline" => "时间线或阶段结构",
            "process" => "流程/箭头结构",
            "compare" => "对比结构",
            "cause" => "因果结构：原因 → 机制 → 结果",
            "category" => "分组卡片结构",
            _ => "根据内容选择最能体现层级与关系的结构，不要默认全部用卡片",
        },
    }
}

fn page_generation_prompt(
    plan: &PptPlan,
    slide: &PptSlide,
    spec_lock: &str,
    understanding: &str,
    previous_title: &str,
    next_title: &str,
    direction: &str,
    template_page: &str,
    template_roster: &str,
    extra_instruction: &str,
) -> String {
    let slide_json = serde_json::to_string_pretty(slide).unwrap_or_default();
    let extra_instruction: String = extra_instruction.trim().chars().take(1000).collect();
    let instruction_block = if extra_instruction.is_empty() {
        String::new()
    } else {
        format!(
            "【本次修改要求】\n{}\n\n说明：以上为用户的单页修改意见，优先满足视觉与信息组织要求；\
             但仍须遵守事实、颜色、字体与禁用项约束，不得编造数据。\n\n",
            extra_instruction
        )
    };
    let understanding: String = understanding
        .chars()
        .take(AI_PROMPT_UNDERSTANDING_CHARS)
        .collect();
    let template_page = if template_page.trim().is_empty() {
        "无匹配模板页，请严格遵循 spec_lock 的通用规范。"
    } else {
        template_page
    };
    let template_roster = if template_roster.trim().is_empty() {
        "无"
    } else {
        template_roster
    };
    format!(
        "你是 ppt-master Executor。请为当前页手写一份完整 SVG，而不是生成占位框或简单文本框。\n\
         只输出完整 SVG，不要 markdown，不要解释。\n\n\
         硬性要求：\n\
         1. viewBox 必须是 \"0 0 1280 720\"，width=\"1280\" height=\"720\"。\n\
         2. 严格遵守 spec_lock 的颜色、字体、字号与禁用项。\n\
         3. 每页必须有明确视觉层级、留白节奏和页面角色差异。\n\
         4. 相邻页不得使用相同版式；本页建议：{}。\n\
         5. 可见文本必须来自当前页内容块、证据或素材理解，不得编造数字、年份、排名、奖项。\n\
         6. 不得出现内部术语或产品名。\n\
         7. 重复图形必须展开为真实元素，不能使用 <use>。\n\
         8. 本次采用方向：{}。\n\
         9. 必须优先复用【模板版式参考】中的栅格、装饰、字号层级与信息节奏；\
            模板中的示例文案与槽位只用于理解结构，最终内容必须来自当前页。\n\n\
         【spec_lock】\n{}\n\n\
         【模板版式参考】\n{}\n\n\
         【模板页面清单】\n{}\n\n\
         【全局信息】\n标题：{}\n总页数：{}\n上一页：{}\n下一页：{}\n\n\
         【素材理解】\n{}\n\n\
         【当前页】\n{}\n\n\
         {}\
         请输出完整 SVG：",
        layout_hint(slide),
        direction,
        spec_lock,
        template_page,
        template_roster,
        plan.title,
        plan.slides.len(),
        if previous_title.is_empty() { "无" } else { previous_title },
        if next_title.is_empty() { "无" } else { next_title },
        if understanding.trim().is_empty() { "无" } else { understanding.as_str() },
        slide_json,
        instruction_block,
    )
}

/// 视觉签名只取开头一段，用于跨页结构去重；并发渲染时以集合形式共享。
fn visual_signature(svg: &str) -> String {
    svg.chars().take(600).collect()
}

fn score_svg_candidate(
    svg: &str,
    slide: &PptSlide,
    allowed_colors: &std::collections::HashSet<String>,
    previous_svgs: &[String],
) -> PageCandidateScore {
    let mut score = 100i32;
    let mut issues = Vec::new();
    let mut hard_fail = false;

    if !svg.contains("<svg") || !svg.contains("</svg>") {
        hard_fail = true;
        issues.push("缺少完整 SVG".to_string());
    }
    if svg.contains("{{") && svg.contains("}}") {
        hard_fail = true;
        issues.push("保留了模板占位符".to_string());
    }
    if !svg.contains("0 0 1280 720") {
        score -= 25;
        issues.push("画布不是 1280×720".to_string());
    }
    for (needle, reason) in [
        ("<use", "使用了 <use>"),
        ("<foreignObject", "使用了 <foreignObject>"),
        ("<style", "使用了内联 <style>"),
        ("<script", "包含脚本"),
        ("<iframe", "包含 iframe"),
        ("filter=", "使用了 filter"),
        ("mask=", "使用了 mask"),
        ("clipPath", "使用了 clipPath"),
        ("textPath", "使用了 textPath"),
    ] {
        if svg.contains(needle) {
            hard_fail = true;
            issues.push(reason.to_string());
        }
    }
    if svg.contains("href=\"http") || svg.contains("xlink:href=\"http") {
        hard_fail = true;
        issues.push("引用了外部图片".to_string());
    }
    for term in [
        "Prompt",
        "spec_lock",
        "design_spec",
        "Pomegranate",
        "PPT Master",
        "slide_plan",
        "pageTheme",
        "contentScope",
        "chartType",
        "Executor",
        "Workflow",
        "fallback",
    ] {
        if svg.contains(term) {
            score -= 30;
            hard_fail = true;
            issues.push(format!("文本泄漏：{term}"));
            break;
        }
    }
    if svg.len() < 1_200 {
        score -= 20;
        issues.push("SVG 过于简单".to_string());
    }
    if let Ok(re) = regex::Regex::new(r##"(?:fill|stroke)="#([0-9A-Fa-f]{6})""##) {
        let mut bad_colors = 0usize;
        for capture in re.captures_iter(svg) {
            if let Some(value) = capture.get(1) {
                let color = format!("#{}", value.as_str().to_uppercase());
                if !allowed_colors.is_empty() && !allowed_colors.contains(&color) {
                    bad_colors += 1;
                }
            }
        }
        if bad_colors > 0 {
            score -= (bad_colors.min(10) as i32) * 2;
            issues.push(format!("{bad_colors} 处颜色不在 spec_lock 中"));
        }
    }
    if let Ok(re) = regex::Regex::new(r#"font-size="([0-9.]+)""#) {
        let mut bad_sizes = 0usize;
        for capture in re.captures_iter(svg) {
            if let Some(value) = capture.get(1) {
                if let Ok(size) = value.as_str().parse::<f32>() {
                    if !(10.0..=72.0).contains(&size) {
                        bad_sizes += 1;
                    }
                }
            }
        }
        if bad_sizes > 0 {
            score -= (bad_sizes.min(8) as i32) * 3;
            issues.push(format!("{bad_sizes} 处字号越界"));
        }
    }
    let visible = svg_visible_text(svg);
    let evidence_hits = slide
        .evidence
        .iter()
        .filter(|item| {
            let key: String = item.chars().take(8).collect();
            !key.trim().is_empty() && visible.contains(key.trim())
        })
        .count();
    if !slide.evidence.is_empty() && evidence_hits == 0 {
        score -= 15;
        issues.push("未覆盖 evidence".to_string());
    }
    let current_lead = visual_signature(svg);
    if !current_lead.trim().is_empty()
        && previous_svgs
            .iter()
            .any(|previous| visual_signature(previous) == current_lead)
    {
        score -= 20;
        issues.push("与已生成页面结构过于相似".to_string());
    }

    PageCandidateScore {
        score: score.max(0),
        issues,
        hard_fail,
        svg: svg.to_string(),
    }
}

fn svg_review_digest(svg: &str) -> String {
    let visible = svg_visible_text(svg);
    let visible: String = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    let visible: String = visible.chars().take(500).collect();
    let elements = ["<rect", "<circle", "<line", "<path", "<text", "<polygon"]
        .iter()
        .map(|tag| format!("{}={}", tag.trim_start_matches('<'), svg.matches(tag).count()))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "可见文本：{}\n元素统计：{}\nSVG 长度：{}",
        visible,
        elements,
        svg.len()
    )
}

/// 返回 (是否需要第 2 个候选, 是否需要第 3 个候选)。
fn adaptive_candidate_plan(
    first_score: Option<i32>,
    first_hard_fail: bool,
    max_candidates: usize,
) -> (bool, bool) {
    let first_strong = first_score
        .map(|score| !first_hard_fail && score >= 85)
        .unwrap_or(false);
    if first_strong || max_candidates <= 1 {
        return (false, false);
    }
    let need_third = max_candidates > 2
        && first_score
            .map(|score| first_hard_fail || score < 55)
            .unwrap_or(true);
    (true, need_third)
}

async fn request_candidate_score(
    db: &Database,
    model_id: Option<i64>,
    prompt: String,
    slide: &PptSlide,
    allowed_colors: &std::collections::HashSet<String>,
    previous_svgs: &[String],
    cancel: &AtomicBool,
) -> Option<PageCandidateScore> {
    let future = AiService::complete_once(db, &prompt, model_id);
    let text = await_cancellable(future, cancel, Duration::from_secs(AI_PAGE_TIMEOUT_SECS))
        .await
        .ok()?;
    let svg = extract_svg_block(&text)?;
    Some(score_svg_candidate(
        &svg,
        slide,
        allowed_colors,
        previous_svgs,
    ))
}

struct PageDraftOutcome {
    index: usize,
    chosen: Option<PageCandidateScore>,
    candidates: Vec<PageCandidateScore>,
}

/// 生成单页的全部候选（含自适应追加、LLM 评审与一次修复）。
/// 只负责生成与评分，落盘和 selection 更新由调用方串行完成。
#[allow(clippy::too_many_arguments)]
async fn generate_ai_page_candidates(
    app: &AppHandle,
    db: &Database,
    job_id: &str,
    plan: &PptPlan,
    slide: &PptSlide,
    index: usize,
    spec_lock: &str,
    understanding: &str,
    template_reference: &TemplateReference,
    allowed_colors: &std::collections::HashSet<String>,
    model_id: Option<i64>,
    effective_candidates: usize,
    previous_svgs: &[String],
    cancel: &AtomicBool,
) -> PageDraftOutcome {
    emit_draft_page(
        app,
        job_id,
        slide.page,
        plan.slides.len(),
        "generating",
        0,
        0,
        &[],
    );
    emit_system_log(
        Some(app),
        &format!(
            "P{:02} 正在生成候选（最多 {} 个）...",
            slide.page, effective_candidates
        ),
    );
    let previous_title = index
        .checked_sub(1)
        .and_then(|value| plan.slides.get(value))
        .map(|item| item.title.as_str())
        .unwrap_or("");
    let next_title = plan
        .slides
        .get(index + 1)
        .map(|item| item.title.as_str())
        .unwrap_or("");
    let directions = [
        "结构优先：清晰标题层级、编号/分组与稳定网格",
        "视觉优先：大数字、色块、图表或强对比图形，减少文字块",
        "叙事优先：用一条主线组织内容，强调因果/流程/对比关系",
    ];
    let template_hint = template_reference.hint_for(slide, index, plan.slides.len());
    let template_roster = template_reference.roster.as_str();
    if let Some(first) = template_hint
        .lines()
        .find(|line| !line.trim().is_empty())
    {
        emit_system_log(
            Some(app),
            &format!("P{:02} 模板参考：{}", slide.page, first.trim()),
        );
    } else {
        emit_system_log(
            Some(app),
            &format!("P{:02} 无匹配模板页，使用 spec_lock 通用规范", slide.page),
        );
    }
    let prompt_for = |candidate_index: usize| {
        page_generation_prompt(
            plan,
            slide,
            spec_lock,
            understanding,
            previous_title,
            next_title,
            directions[candidate_index % directions.len()],
            &template_hint,
            template_roster,
            "",
        )
    };
    let mut candidates: Vec<PageCandidateScore> = Vec::new();
    if let Some(first) = request_candidate_score(
        db,
        model_id,
        prompt_for(0),
        slide,
        allowed_colors,
        previous_svgs,
        cancel,
    )
    .await
    {
        candidates.push(first);
    }
    let first_score = candidates.first().map(|candidate| candidate.score);
    let first_hard_fail = candidates
        .first()
        .map(|candidate| candidate.hard_fail)
        .unwrap_or(false);
    let (need_second, need_third) =
        adaptive_candidate_plan(first_score, first_hard_fail, effective_candidates);
    if need_second {
        if need_third {
            let (second, third) = tokio::join!(
                request_candidate_score(
                    db,
                    model_id,
                    prompt_for(1),
                    slide,
                    allowed_colors,
                    previous_svgs,
                    cancel,
                ),
                request_candidate_score(
                    db,
                    model_id,
                    prompt_for(2),
                    slide,
                    allowed_colors,
                    previous_svgs,
                    cancel,
                )
            );
            if let Some(candidate) = second {
                candidates.push(candidate);
            }
            if let Some(candidate) = third {
                candidates.push(candidate);
            }
        } else if let Some(second) = request_candidate_score(
            db,
            model_id,
            prompt_for(1),
            slide,
            allowed_colors,
            previous_svgs,
            cancel,
        )
        .await
        {
            candidates.push(second);
        }
    }
    candidates.sort_by(|left, right| right.score.cmp(&left.score));
    if candidates.len() >= 2
        && candidates[0].score - candidates[1].score <= 5
        && candidates[0].score < 85
    {
        if let Some(position) =
            review_candidates_with_ai(db, slide, &candidates, model_id, cancel).await
        {
            if position > 0 && position < candidates.len() {
                let picked = candidates.remove(position);
                candidates.insert(0, picked);
                emit_system_log(
                    Some(app),
                    &format!("P{:02} AI 评审改选了候选 {}", slide.page, position + 1),
                );
            }
        }
    }
    let mut chosen = candidates.first().cloned();
    if let Some(current) = chosen.clone() {
        if current.hard_fail || current.score < AI_PAGE_MIN_SCORE {
            emit_system_log(
                Some(app),
                &format!(
                    "P{:02} 候选未达门槛（{}），带错误信息进行一次修复重试",
                    slide.page, current.score
                ),
            );
            let repair_prompt = format!(
                "{}\n\n上一次生成存在以下问题：{}\n请只修复这些问题并重新输出完整 SVG。",
                page_generation_prompt(
                    plan,
                    slide,
                    spec_lock,
                    understanding,
                    previous_title,
                    next_title,
                    directions[0],
                    &template_hint,
                    template_roster,
                    "",
                ),
                current.issues.join("；"),
            );
            let future = AiService::complete_once(db, &repair_prompt, model_id);
            if let Ok(text) = await_cancellable(
                future,
                cancel,
                Duration::from_secs(AI_PAGE_TIMEOUT_SECS),
            )
            .await
            {
                if let Some(svg) = extract_svg_block(&text) {
                    let repaired =
                        score_svg_candidate(&svg, slide, allowed_colors, previous_svgs);
                    if !repaired.hard_fail && repaired.score > current.score {
                        chosen = Some(repaired.clone());
                    }
                    candidates.push(repaired);
                }
            }
        }
    }
    // 修复重试可能让候选超过 3 个；保留选中项，移除最低分的额外候选。
    if candidates.len() > 3 {
        if let Some(chosen_svg) = chosen.as_ref().map(|candidate| &candidate.svg) {
            while candidates.len() > 3 {
                let remove_index = candidates
                    .iter()
                    .enumerate()
                    .filter(|(_, candidate)| &candidate.svg != chosen_svg)
                    .min_by_key(|(_, candidate)| candidate.score)
                    .map(|(index, _)| index);
                match remove_index {
                    Some(index) => {
                        candidates.remove(index);
                    }
                    None => break,
                }
            }
        }
    }
    PageDraftOutcome {
        index,
        chosen,
        candidates,
    }
}

async fn review_candidates_with_ai(
    db: &Database,
    slide: &PptSlide,
    candidates: &[PageCandidateScore],
    model_id: Option<i64>,
    cancel: &AtomicBool,
) -> Option<usize> {
    if candidates.len() < 2 {
        return None;
    }
    let digests = candidates
        .iter()
        .take(3)
        .enumerate()
        .map(|(index, candidate)| {
            format!(
                "候选 {}（评分 {}）：\n{}",
                index + 1,
                candidate.score,
                svg_review_digest(&candidate.svg)
            )
        })
        .collect::<Vec<_>>()
        .join("\n---\n");
    let blocks = slide
        .content_blocks
        .iter()
        .map(|block| format!("{}：{}", block.label, block.text))
        .collect::<Vec<_>>()
        .join("；");
    let prompt = format!(
        "你是 PPT 视觉评审。根据当前页内容与候选摘要，选择更适合正式汇报的一版。\n\
         只输出一个序号数字（1、2 或 3），不要解释。\n\n\
         当前页标题：{}\n内容块：{}\n证据：{}\n\n{}",
        slide.title,
        if blocks.is_empty() { "无" } else { blocks.as_str() },
        if slide.evidence.is_empty() {
            "无".to_string()
        } else {
            slide.evidence.join("；")
        },
        digests
    );
    let future = AiService::complete_once(db, &prompt, model_id);
    let text = await_cancellable(future, cancel, Duration::from_secs(60))
        .await
        .ok()?;
    let index = text
        .chars()
        .find(|ch| ch.is_ascii_digit())
        .and_then(|ch| ch.to_digit(10))
        .map(|value| value as usize)?;
    if index >= 1 && index <= candidates.len().min(3) {
        Some(index - 1)
    } else {
        None
    }
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), AppError> {
    let text = serde_json::to_string_pretty(value)?;
    fs::write(path, format!("{text}\n"))?;
    Ok(())
}

fn page_svg_path(project: &Path, page: u32) -> PathBuf {
    project.join("svg_output").join(format!("P{page:02}.svg"))
}

fn load_job_spec(job_dir: &Path) -> Value {
    fs::read_to_string(job_dir.join("job.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}))
}

fn job_model_id(spec: &Value) -> Option<i64> {
    spec.get("options")
        .and_then(|value| value.get("modelId"))
        .and_then(Value::as_i64)
}

/// 保存 AI 候选 SVG，并记录每个候选的文件、分数与选中项。
/// 返回的 selected 是选中候选在 `candidates` 中的下标。
fn update_ai_selection(
    project: &Path,
    page: u32,
    selected_svg: &str,
    candidates: &[PageCandidateScore],
) -> Result<(), AppError> {
    let candidates_dir = project.join("candidates");
    fs::create_dir_all(&candidates_dir)?;
    let mut files = Vec::with_capacity(candidates.len());
    for (index, candidate) in candidates.iter().enumerate() {
        let relative = format!("candidates/P{page:02}_{}.svg", index + 1);
        fs::write(project.join(&relative), sanitize_ai_svg(&candidate.svg))?;
        files.push(relative);
    }
    // 清理上一轮多出来的候选文件，避免候选缩略图串页。
    for index in candidates.len() + 1..=3 {
        let _ = fs::remove_file(
            candidates_dir.join(format!("P{page:02}_{index}.svg")),
        );
    }
    let selected = candidates
        .iter()
        .position(|candidate| candidate.svg == selected_svg)
        .unwrap_or(0);
    let selected_score = candidates
        .get(selected)
        .map(|candidate| candidate.score)
        .unwrap_or(0);
    let selected_issues = candidates
        .get(selected)
        .map(|candidate| candidate.issues.clone())
        .unwrap_or_default();
    let path = project.join("page_selection.json");
    let mut value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({ "pages": [] }));
    if !value.get("pages").map(Value::is_array).unwrap_or(false) {
        value["pages"] = json!([]);
    }
    let entry = json!({
        "page": page,
        "selected": selected,
        "score": selected_score,
        "issues": selected_issues,
        "mode": "ai",
        "candidates": candidates.iter().enumerate().map(|(index, candidate)| json!({
            "index": index,
            "motif": format!("候选 {}", index + 1),
            "score": candidate.score,
            "issues": candidate.issues,
            "file": files.get(index),
        })).collect::<Vec<_>>(),
    });
    if let Some(pages) = value.get_mut("pages").and_then(Value::as_array_mut) {
        pages.retain(|item| item.get("page").and_then(Value::as_u64) != Some(page as u64));
        pages.push(entry);
        pages.sort_by_key(|item| item.get("page").and_then(Value::as_u64).unwrap_or(0));
    }
    write_json_file(&path, &value)
}

fn update_programmatic_selection(
    project: &Path,
    page: u32,
    selected_index: usize,
    selected: &PageCandidateScore,
    details: &[ppt_programmatic_renderer::ProgrammaticCandidate],
) -> Result<(), AppError> {
    let path = project.join("page_selection.json");
    let mut value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({ "pages": [] }));
    if !value.get("pages").map(Value::is_array).unwrap_or(false) {
        value["pages"] = json!([]);
    }
    let entry = json!({
        "page": page,
        "selected": selected_index,
        "score": selected.score,
        "issues": selected.issues,
        "mode": "programmatic",
        "candidates": details.iter().enumerate().map(|(index, candidate)| json!({
            "index": index,
            "motif": candidate.motif,
            "score": candidate.score,
            "issues": candidate.issues,
            "file": format!("candidates/P{page:02}_{}.svg", index + 1),
        })).collect::<Vec<_>>(),
    });
    if let Some(pages) = value.get_mut("pages").and_then(Value::as_array_mut) {
        pages.retain(|item| item.get("page").and_then(Value::as_u64) != Some(page as u64));
        pages.push(entry);
        pages.sort_by_key(|item| item.get("page").and_then(Value::as_u64).unwrap_or(0));
    }
    write_json_file(&path, &value)
}

impl PptExtensionService {
    /// 程序化渲染草稿：不调用 AI 生成 SVG，每页 3 个 motif 候选选 1。
    pub async fn render_programmatic_draft(
        app: AppHandle,
        db: Arc<Database>,
        cancels: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        job_id: String,
    ) -> Result<(), AppError> {
        let mut job = db
            .get_ppt_job(&job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {job_id} 不存在")))?;
        if job.status == "running" {
            return Err(AppError::InvalidInput("作业正在运行".into()));
        }
        let job_dir = PathBuf::from(&job.workspace_path);
        let project = job_dir.join("project");
        fs::create_dir_all(project.join("svg_output"))?;
        let plan = ppt_plan::read_plan(&job_dir, &job.title)?;
        if plan.slides.is_empty() {
            return Err(AppError::InvalidInput("大纲为空，无法生成草稿".into()));
        }
        let mut spec = load_job_spec(&job_dir);
        if !spec.get("options").map(Value::is_object).unwrap_or(false) {
            spec["options"] = json!({});
        }
        spec["options"]["generationMode"] = json!("programmatic");
        write_json_file(&job_dir.join("job.json"), &spec)?;

        let extension = ExtensionService::get(&db, &job.extension_id)?;
        let layout_id = job.template_id.clone().unwrap_or_default();
        let template_dir = resolve_job_template_dir(&db, &extension, &job_dir, &layout_id);
        let spec_lock = build_spec_lock(template_dir.as_deref(), &plan);
        fs::write(project.join("spec_lock.md"), &spec_lock)?;
        let colors = template_colors(template_dir.as_deref());
        let palette = ppt_programmatic_renderer::ProgrammaticPalette::from_colors(&colors);

        job.status = "running".into();
        job.stage = "rendering_draft".into();
        job.started_at = Some(chrono::Local::now().to_rfc3339());
        job.finished_at = None;
        job.error_code = None;
        job.error_message = None;
        db.update_ppt_job(&job)?;
        let _ = app.emit(
            "ppt-extension://job",
            json!({ "jobId": job.id, "status": "running", "stage": job.stage }),
        );
        emit_system_log(
            Some(&app),
            &format!(
                "开始程序化渲染：{} 页 × 最多 3 个结构候选",
                plan.slides.len()
            ),
        );

        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = cancels.lock() {
            map.insert(job.id.clone(), cancel.clone());
        }

        let mut previous_motif: Option<String> = None;
        let mut motif_counts: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        for (index, slide) in plan.slides.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                if let Ok(mut map) = cancels.lock() {
                    map.remove(&job.id);
                }
                job.status = "cancelled".into();
                job.error_code = Some("CANCELLED".into());
                job.error_message = Some("用户取消了程序化渲染".into());
                job.finished_at = Some(chrono::Local::now().to_rfc3339());
                db.update_ppt_job(&job)?;
                let _ = app.emit(
                    "ppt-extension://error",
                    json!({ "jobId": job.id, "status": "cancelled", "stage": job.stage, "job": job }),
                );
                return Ok(());
            }
            emit_draft_page(
                &app,
                &job.id,
                slide.page,
                plan.slides.len(),
                "generating",
                0,
                3,
                &[],
            );
            let rendered =
                ppt_programmatic_renderer::render_programmatic_page_with_palette(
                    &plan,
                    slide,
                    index,
                    previous_motif.as_deref(),
                    &motif_counts,
                    &palette,
                );
            let candidates_dir = project.join("candidates");
            fs::create_dir_all(&candidates_dir)?;
            let details: Vec<_> = rendered
                .candidate_details
                .iter()
                .take(3)
                .cloned()
                .collect();
            for (index, candidate) in details.iter().enumerate() {
                fs::write(
                    candidates_dir.join(format!("P{:02}_{}.svg", slide.page, index + 1)),
                    &candidate.svg,
                )?;
            }
            fs::write(page_svg_path(&project, slide.page), &rendered.svg)?;
            let selected_index = details
                .iter()
                .position(|candidate| {
                    candidate.motif == rendered.motif && candidate.score == rendered.score
                })
                .unwrap_or(0);
            let selected = PageCandidateScore {
                score: rendered.score,
                issues: rendered.issues.clone(),
                hard_fail: false,
                svg: rendered.svg.clone(),
            };
            update_programmatic_selection(
                &project,
                slide.page,
                selected_index,
                &selected,
                &details,
            )?;
            if rendered.used_fallback || !rendered.issues.is_empty() {
                emit_system_log(
                    Some(&app),
                    &format!(
                        "P{:02} 布局回退/QA 问题：{}",
                        slide.page,
                        if rendered.issues.is_empty() {
                            "已回退到简单布局".to_string()
                        } else {
                            rendered.issues.join("；")
                        }
                    ),
                );
            }
            *motif_counts
                .entry(rendered.motif.to_string())
                .or_insert(0) += 1;
            previous_motif = Some(rendered.motif.to_string());
            emit_draft_page(
                &app,
                &job.id,
                slide.page,
                plan.slides.len(),
                "selected",
                rendered.score,
                rendered.candidates,
                &[],
            );
            emit_system_log(
                Some(&app),
                &format!(
                    "P{:02} 程序化渲染：layout={} motif={} score={}",
                    slide.page, rendered.layout, rendered.motif, rendered.score
                ),
            );
        }

        if let Ok(mut map) = cancels.lock() {
            map.remove(&job.id);
        }
        job.status = "succeeded".into();
        job.stage = STAGE_DRAFT_READY.into();
        job.pptx_path = None;
        job.final_pptx_path = None;
        job.project_path = Some(project.to_string_lossy().to_string());
        job.finished_at = Some(chrono::Local::now().to_rfc3339());
        db.update_ppt_job(&job)?;
        emit_system_log(
            Some(&app),
            &format!("程序化草稿完成：{} 页", plan.slides.len()),
        );
        let _ = app.emit(
            "ppt-extension://done",
            json!({ "jobId": job.id, "status": "succeeded", "stage": job.stage, "job": job }),
        );
        Ok(())
    }

    /// 逐页生成 AI SVG 草稿；失败页回退到扩展模板渲染。
    pub async fn render_ai_draft(
        app: AppHandle,
        db: Arc<Database>,
        cancels: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        job_id: String,
        candidate_count: usize,
        mode: DraftGenerationMode,
    ) -> Result<(), AppError> {
        let mut job = db
            .get_ppt_job(&job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {job_id} 不存在")))?;
        if job.status == "running" {
            return Err(AppError::InvalidInput("作业正在运行".into()));
        }
        if mode == DraftGenerationMode::Programmatic {
            return Self::render_programmatic_draft(app, db, cancels, job_id).await;
        }
        let job_dir = PathBuf::from(&job.workspace_path);
        let project = job_dir.join("project");
        fs::create_dir_all(project.join("svg_output"))?;
        let plan = ppt_plan::read_plan(&job_dir, &job.title)?;
        if plan.slides.is_empty() {
            return Err(AppError::InvalidInput("大纲为空，无法生成草稿".into()));
        }
        let mut spec = load_job_spec(&job_dir);
        if !spec.get("options").map(Value::is_object).unwrap_or(false) {
            spec["options"] = json!({});
        }
        spec["options"]["generationMode"] = json!(mode.as_str());
        write_json_file(&job_dir.join("job.json"), &spec)?;
        let model_id = job_model_id(&spec);
        let understanding = fs::read_to_string(job_dir.join("input").join("understanding.md"))
            .unwrap_or_default();
        let extension = ExtensionService::get(&db, &job.extension_id)?;
        let layout_id = job.template_id.clone().unwrap_or_default();
        let template_dir = resolve_job_template_dir(&db, &extension, &job_dir, &layout_id);
        let template_reference = build_template_reference(template_dir.as_deref(), &layout_id);
        if template_reference.is_empty() {
            emit_system_log(
                Some(&app),
                "未找到可用模板页，AI 草稿将仅依据 spec_lock 生成",
            );
        }
        let spec_lock = build_spec_lock(template_dir.as_deref(), &plan);
        fs::write(project.join("spec_lock.md"), &spec_lock)?;
        let allowed_colors = template_colors(template_dir.as_deref());

        job.status = "running".into();
        job.stage = "rendering_draft".into();
        job.started_at = Some(chrono::Local::now().to_rfc3339());
        job.finished_at = None;
        job.error_code = None;
        job.error_message = None;
        db.update_ppt_job(&job)?;
        let _ = app.emit(
            "ppt-extension://job",
            json!({ "jobId": job.id, "status": "running", "stage": job.stage }),
        );
        let effective_candidates = if mode == DraftGenerationMode::OneShot {
            1
        } else {
            candidate_count.max(1).min(3)
        };
        emit_system_log(
            Some(&app),
            &format!(
                "开始逐页 AI 生成：{} 页 × {} 候选（{}）",
                plan.slides.len(),
                effective_candidates,
                mode.as_str()
            ),
        );

        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = cancels.lock() {
            map.insert(job.id.clone(), cancel.clone());
        }

        let mut signatures: Vec<String> = Vec::new();
        let mut failures: Vec<u32> = Vec::new();
        let mut selected_pages = 0usize;
        // 断点续跑：已有且达标的页面直接复用。
        let mut reused_pages: std::collections::HashMap<u32, i32> =
            std::collections::HashMap::new();
        if let Ok(text) = fs::read_to_string(project.join("page_selection.json")) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(items) = value.get("pages").and_then(Value::as_array) {
                    for item in items {
                        let page = item
                            .get("page")
                            .and_then(Value::as_u64)
                            .map(|value| value as u32);
                        let score = item
                            .get("score")
                            .and_then(Value::as_i64)
                            .map(|value| value as i32);
                        if let (Some(page), Some(score)) = (page, score) {
                            if score >= 80 && page_svg_path(&project, page).is_file() {
                                reused_pages.insert(page, score);
                            }
                        }
                    }
                }
            }
        }

        // 页级并发 2：视觉签名以集合形式传递，避免并发页互相覆盖去重状态。
        let mut chunk_start = 0usize;
        while chunk_start < plan.slides.len() {
            if cancel.load(Ordering::SeqCst) {
                if let Ok(mut map) = cancels.lock() {
                    map.remove(&job.id);
                }
                job.status = "cancelled".into();
                job.error_code = Some("CANCELLED".into());
                job.error_message = Some("用户取消了 AI 草稿生成".into());
                job.finished_at = Some(chrono::Local::now().to_rfc3339());
                db.update_ppt_job(&job)?;
                let _ = app.emit(
                    "ppt-extension://error",
                    json!({ "jobId": job.id, "status": "cancelled", "stage": job.stage, "job": job }),
                );
                return Ok(());
            }
            let chunk_end = (chunk_start + 2).min(plan.slides.len());
            let mut pending: Vec<(usize, &PptSlide)> = Vec::new();
            for index in chunk_start..chunk_end {
                let slide = &plan.slides[index];
                if let Some(score) = reused_pages.get(&slide.page).copied() {
                    let path = page_svg_path(&project, slide.page);
                    if let Ok(existing) = fs::read_to_string(&path) {
                        let cleaned = sanitize_ai_svg(&existing);
                        if cleaned != existing {
                            let _ = fs::write(&path, &cleaned);
                        }
                        signatures.push(cleaned);
                    }
                    selected_pages += 1;
                    emit_draft_page(
                        &app,
                        &job.id,
                        slide.page,
                        plan.slides.len(),
                        "reused",
                        score,
                        0,
                        &[],
                    );
                    emit_system_log(
                        Some(&app),
                        &format!("P{:02} 复用已有草稿（score={score}）", slide.page),
                    );
                } else {
                    pending.push((index, slide));
                }
            }
            if !pending.is_empty() {
                let snapshot = signatures.clone();
                let outcomes = if pending.len() == 1 {
                    let (index, slide) = pending[0];
                    vec![generate_ai_page_candidates(
                        &app,
                        &db,
                        &job.id,
                        &plan,
                        slide,
                        index,
                        &spec_lock,
                        &understanding,
                        &template_reference,
                        &allowed_colors,
                        model_id,
                        effective_candidates,
                        &snapshot,
                        &cancel,
                    )
                    .await]
                } else {
                    let (left, right) = tokio::join!(
                        generate_ai_page_candidates(
                            &app,
                            &db,
                            &job.id,
                            &plan,
                            pending[0].1,
                            pending[0].0,
                            &spec_lock,
                            &understanding,
                            &template_reference,
                            &allowed_colors,
                            model_id,
                            effective_candidates,
                            &snapshot,
                            &cancel,
                        ),
                        generate_ai_page_candidates(
                            &app,
                            &db,
                            &job.id,
                            &plan,
                            pending[1].1,
                            pending[1].0,
                            &spec_lock,
                            &understanding,
                            &template_reference,
                            &allowed_colors,
                            model_id,
                            effective_candidates,
                            &snapshot,
                            &cancel,
                        )
                    );
                    vec![left, right]
                };
                if cancel.load(Ordering::SeqCst) {
                    if let Ok(mut map) = cancels.lock() {
                        map.remove(&job.id);
                    }
                    job.status = "cancelled".into();
                    job.error_code = Some("CANCELLED".into());
                    job.error_message = Some("用户取消了 AI 草稿生成".into());
                    job.finished_at = Some(chrono::Local::now().to_rfc3339());
                    db.update_ppt_job(&job)?;
                    let _ = app.emit(
                        "ppt-extension://error",
                        json!({ "jobId": job.id, "status": "cancelled", "stage": job.stage, "job": job }),
                    );
                    return Ok(());
                }
                for outcome in outcomes {
                    let slide = &plan.slides[outcome.index];
                    if !outcome.candidates.is_empty() {
                        let selected_svg = outcome
                            .chosen
                            .as_ref()
                            .map(|candidate| candidate.svg.as_str())
                            .unwrap_or("");
                        update_ai_selection(
                            &project,
                            slide.page,
                            selected_svg,
                            &outcome.candidates,
                        )?;
                    }
                    let Some(chosen) = outcome.chosen else {
                        failures.push(slide.page);
                        emit_draft_page(
                            &app,
                            &job.id,
                            slide.page,
                            plan.slides.len(),
                            "fallback",
                            0,
                            0,
                            &["未获得可用 SVG".to_string()],
                        );
                        emit_system_log(
                            Some(&app),
                            &format!("P{:02} 未获得可用 SVG，改用模板兜底", slide.page),
                        );
                        continue;
                    };
                    if chosen.hard_fail || chosen.score < AI_PAGE_MIN_SCORE {
                        failures.push(slide.page);
                        emit_draft_page(
                            &app,
                            &job.id,
                            slide.page,
                            plan.slides.len(),
                            "fallback",
                            chosen.score,
                            outcome.candidates.len(),
                            &chosen.issues,
                        );
                        emit_system_log(
                            Some(&app),
                            &format!(
                                "P{:02} 修复后仍未达门槛（{}），改用模板兜底：{}",
                                slide.page,
                                chosen.score,
                                chosen.issues.join("；")
                            ),
                        );
                        continue;
                    }
                    let path = page_svg_path(&project, slide.page);
                    let cleaned_svg = sanitize_ai_svg(&chosen.svg);
                    fs::write(&path, &cleaned_svg)?;
                    signatures.push(cleaned_svg);
                    selected_pages += 1;
                    emit_draft_page(
                        &app,
                        &job.id,
                        slide.page,
                        plan.slides.len(),
                        "selected",
                        chosen.score,
                        outcome.candidates.len(),
                        &chosen.issues,
                    );
                    emit_system_log(
                        Some(&app),
                        &format!(
                            "P{:02} 已选用候选：score={} issues={}",
                            slide.page,
                            chosen.score,
                            if chosen.issues.is_empty() {
                                "none".to_string()
                            } else {
                                chosen.issues.join("；")
                            }
                        ),
                    );
                }
            }
            chunk_start = chunk_end;
        }

        if let Ok(mut map) = cancels.lock() {
            map.remove(&job.id);
        }

        if failures.is_empty() {
            job.status = "succeeded".into();
            job.stage = STAGE_DRAFT_READY.into();
            job.pptx_path = None;
            job.final_pptx_path = None;
            job.project_path = Some(project.to_string_lossy().to_string());
            job.finished_at = Some(chrono::Local::now().to_rfc3339());
            db.update_ppt_job(&job)?;
            emit_system_log(
                Some(&app),
                &format!("AI 草稿生成完成：{} 页", selected_pages),
            );
            let _ = app.emit(
                "ppt-extension://done",
                json!({ "jobId": job.id, "status": "succeeded", "stage": job.stage, "job": job }),
            );
            return Ok(());
        }

        // 失败页交给扩展模板渲染；扩展只处理 fallbackPages，保留已生成的 AI 页。
        let mut spec = spec;
        if !spec.get("options").map(Value::is_object).unwrap_or(false) {
            spec["options"] = json!({});
        }
        spec["options"]["fallbackPages"] = json!(failures);
        write_json_file(&job_dir.join("job.json"), &spec)?;
        job.status = "ready".into();
        job.stage = STAGE_OUTLINE_READY.into();
        db.update_ppt_job(&job)?;
        emit_system_log(
            Some(&app),
            &format!(
                "{} 页需要模板兜底：{:?}",
                failures.len(),
                failures
            ),
        );
        Self::start_job_stage(
            app,
            db,
            cancels,
            job_id,
            PptRunStage::Render,
            None,
        )
    }

    /// 单页重新生成：用于草稿页的“重新生成此页”。
    pub async fn regenerate_ai_page(
        app: AppHandle,
        db: Arc<Database>,
        cancels: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        job_id: String,
        page: u32,
        candidate_count: usize,
        model_id_override: Option<i64>,
        instruction: Option<String>,
    ) -> Result<(), AppError> {
        let job = db
            .get_ppt_job(&job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {job_id} 不存在")))?;
        if job.status == "running" {
            return Err(AppError::InvalidInput("作业正在运行".into()));
        }
        let job_dir = PathBuf::from(&job.workspace_path);
        let project = job_dir.join("project");
        let plan = ppt_plan::read_plan(&job_dir, &job.title)?;
        let slide = plan
            .slides
            .iter()
            .find(|item| item.page == page)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("找不到第 {page} 页")))?;
        let index = plan
            .slides
            .iter()
            .position(|item| item.page == page)
            .unwrap_or(0);
        let spec = load_job_spec(&job_dir);
        let model_id = model_id_override.or_else(|| job_model_id(&spec));
        let understanding = fs::read_to_string(job_dir.join("input").join("understanding.md"))
            .unwrap_or_default();
        let extension = ExtensionService::get(&db, &job.extension_id)?;
        let layout_id = job.template_id.clone().unwrap_or_default();
        let template_dir = resolve_job_template_dir(&db, &extension, &job_dir, &layout_id);
        let spec_lock = fs::read_to_string(project.join("spec_lock.md"))
            .unwrap_or_else(|_| build_spec_lock(template_dir.as_deref(), &plan));
        let allowed_colors = template_colors(template_dir.as_deref());
        let template_reference = build_template_reference(template_dir.as_deref(), &layout_id);
        let template_hint = template_reference.hint_for(&slide, index, plan.slides.len());
        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = cancels.lock() {
            map.insert(format!("{job_id}:page:{page}"), cancel.clone());
        }
        let previous_title = index
            .checked_sub(1)
            .and_then(|value| plan.slides.get(value))
            .map(|item| item.title.as_str())
            .unwrap_or("");
        let next_title = plan
            .slides
            .get(index + 1)
            .map(|item| item.title.as_str())
            .unwrap_or("");
        let existing = fs::read_to_string(page_svg_path(&project, page)).ok();
        let existing_signatures: Vec<String> = existing.iter().cloned().collect();
        let directions = [
            "结构优先：清晰标题层级、编号/分组与稳定网格",
            "视觉优先：大数字、色块、图表或强对比图形，减少文字块",
        ];
        let effective_candidates = directions.len().min(candidate_count.max(1));
        emit_page_regen_progress(
            &app,
            &job_id,
            page,
            0,
            effective_candidates,
            "preparing",
            "正在准备候选提示词…",
        );
        let mut candidates = Vec::new();
        for (candidate_index, direction) in
            directions.iter().take(effective_candidates).enumerate()
        {
            emit_page_regen_progress(
                &app,
                &job_id,
                page,
                candidate_index,
                effective_candidates,
                "generating",
                &format!(
                    "正在生成候选 {} / {}（{}）",
                    candidate_index + 1,
                    effective_candidates,
                    direction
                ),
            );
            let prompt = page_generation_prompt(
                &plan,
                &slide,
                &spec_lock,
                &understanding,
                previous_title,
                next_title,
                direction,
                &template_hint,
                template_reference.roster.as_str(),
                instruction.as_deref().unwrap_or(""),
            );
            let future = AiService::complete_once(&db, &prompt, model_id);
            match await_cancellable(future, &cancel, Duration::from_secs(AI_PAGE_TIMEOUT_SECS)).await {
                Ok(text) => {
                    if let Some(svg) = extract_svg_block(&text) {
                        let scored = score_svg_candidate(
                            &svg,
                            &slide,
                            &allowed_colors,
                            &existing_signatures,
                        );
                        emit_page_regen_progress(
                            &app,
                            &job_id,
                            page,
                            candidate_index + 1,
                            effective_candidates,
                            "scored",
                            &format!(
                                "候选 {} 已生成，评分 {}",
                                candidate_index + 1,
                                scored.score
                            ),
                        );
                        candidates.push(scored);
                    } else {
                        emit_page_regen_progress(
                            &app,
                            &job_id,
                            page,
                            candidate_index + 1,
                            effective_candidates,
                            "scored",
                            &format!("候选 {} 未返回完整 SVG", candidate_index + 1),
                        );
                    }
                }
                Err(PlanRunError::Cancelled) => {
                    emit_page_regen_progress(
                        &app,
                        &job_id,
                        page,
                        candidate_index,
                        effective_candidates,
                        "failed",
                        "已取消生成",
                    );
                    break;
                }
                Err(error) => {
                    emit_system_log(
                        Some(&app),
                        &format!("第 {page} 页候选 {} 失败：{:?}", candidate_index + 1, error),
                    );
                    emit_page_regen_progress(
                        &app,
                        &job_id,
                        page,
                        candidate_index + 1,
                        effective_candidates,
                        "scored",
                        &format!("候选 {} 失败：{:?}", candidate_index + 1, error),
                    );
                }
            }
        }
        if let Ok(mut map) = cancels.lock() {
            map.remove(&format!("{job_id}:page:{page}"));
        }
        candidates.sort_by(|left, right| right.score.cmp(&left.score));
        let Some(best) = candidates.first().cloned() else {
            emit_page_regen_progress(
                &app,
                &job_id,
                page,
                0,
                effective_candidates,
                "failed",
                "未获得可用 SVG",
            );
            return Err(AppError::Custom("未获得可用 SVG".into()));
        };
        if best.hard_fail || best.score < AI_PAGE_MIN_SCORE {
            let message = format!(
                "候选未达门槛：score={} {}",
                best.score,
                best.issues.join("；")
            );
            emit_page_regen_progress(
                &app,
                &job_id,
                page,
                effective_candidates,
                effective_candidates,
                "failed",
                &message,
            );
            return Err(AppError::Custom(message));
        }
        fs::write(
            page_svg_path(&project, page),
            sanitize_ai_svg(&best.svg),
        )?;
        update_ai_selection(&project, page, &best.svg, &candidates)?;
        emit_system_log(
            Some(&app),
            &format!("第 {page} 页已重新生成：score={}", best.score),
        );
        emit_page_regen_progress(
            &app,
            &job_id,
            page,
            effective_candidates,
            effective_candidates,
            "selected",
            &format!("已应用最优候选，评分 {}", best.score),
        );
        Ok(())
    }

    /// 读取 job.json 的 options，供历史作业恢复生成方式与渲染设置。
    pub fn job_options(db: &Database, job_id: &str) -> Result<Value, AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {job_id} 不存在")))?;
        let spec = load_job_spec(&PathBuf::from(&job.workspace_path));
        let mut options = spec
            .get("options")
            .cloned()
            .unwrap_or_else(|| json!({}));
        // 设置页回显除了 options 还需要标题、版式与图表模板；
        // 之前只返回 options，历史作业返回设置时这些字段会显示为空。
        if let Some(object) = options.as_object_mut() {
            let title = spec
                .pointer("/source/title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(job.title.as_str())
                .to_string();
            object.insert("title".into(), Value::String(title));
            object.insert(
                "layoutId".into(),
                spec.pointer("/templates/layoutId")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            object.insert(
                "chartIds".into(),
                spec.pointer("/templates/chartIds")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            );
        }
        Ok(options)
    }

    /// 返回作业固化素材 `input/source.md` 的绝对路径，供前端打开查看。
    pub fn source_file(db: &Database, job_id: &str) -> Result<String, AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {job_id} 不存在")))?;
        let path = PathBuf::from(&job.workspace_path)
            .join("input")
            .join("source.md");
        if !path.is_file() {
            return Err(AppError::NotFound("作业缺少 input/source.md".into()));
        }
        Ok(path.to_string_lossy().to_string())
    }

    /// 读取逐页候选评分，供草稿页展示。
    pub fn page_selection(db: &Database, job_id: &str) -> Result<Value, AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {job_id} 不存在")))?;
        let project = PathBuf::from(&job.workspace_path).join("project");
        fs::read_to_string(project.join("page_selection.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(Ok)
            .unwrap_or_else(|| Ok(json!({ "pages": [] })))
    }

    /// 读取程序化渲染的候选 SVG，供草稿页预览和手动选择。
    pub fn page_candidates(
        db: &Database,
        job_id: &str,
        page: u32,
    ) -> Result<Value, AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {job_id} 不存在")))?;
        let project = PathBuf::from(&job.workspace_path).join("project");
        let selection = fs::read_to_string(project.join("page_selection.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| json!({ "pages": [] }));
        let entry = selection
            .get("pages")
            .and_then(Value::as_array)
            .and_then(|pages| {
                pages
                    .iter()
                    .find(|item| item.get("page").and_then(Value::as_u64) == Some(page as u64))
            });
        let selected = entry
            .and_then(|item| item.get("selected"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let mut candidates = Vec::new();
        if let Some(items) = entry
            .and_then(|item| item.get("candidates"))
            .and_then(Value::as_array)
        {
            for (index, item) in items.iter().enumerate() {
                let Some(file) = item.get("file").and_then(Value::as_str) else {
                    continue;
                };
                let Some(path) = safe_candidate_path(&project, file) else {
                    continue;
                };
                let Ok(svg) = fs::read_to_string(&path) else {
                    continue;
                };
                if svg.len() > 1_000_000 {
                    continue;
                }
                candidates.push(json!({
                    "index": index,
                    "motif": item.get("motif").cloned().unwrap_or(Value::Null),
                    "score": item.get("score").cloned().unwrap_or(json!(0)),
                    "issues": item.get("issues").cloned().unwrap_or(json!([])),
                    "svg": svg,
                }));
            }
        }
        Ok(json!({
            "page": page,
            "selected": selected,
            "candidates": candidates,
        }))
    }

    /// 手动选择一个结构候选，写回 svg_output 并更新 selection。
    pub fn select_page_candidate(
        db: &Database,
        job_id: &str,
        page: u32,
        index: usize,
    ) -> Result<(), AppError> {
        let job = db
            .get_ppt_job(job_id)?
            .ok_or_else(|| AppError::NotFound(format!("作业 {job_id} 不存在")))?;
        let project = PathBuf::from(&job.workspace_path).join("project");
        let selection_path = project.join("page_selection.json");
        let mut selection = fs::read_to_string(&selection_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| json!({ "pages": [] }));
        let Some(pages) = selection.get_mut("pages").and_then(Value::as_array_mut) else {
            return Err(AppError::InvalidInput("selection 结构无效".into()));
        };
        let Some(entry) = pages
            .iter_mut()
            .find(|item| item.get("page").and_then(Value::as_u64) == Some(page as u64))
        else {
            return Err(AppError::NotFound(format!("第 {page} 页没有候选记录")));
        };
        let (file, score, issues) = {
            let Some(items) = entry.get("candidates").and_then(Value::as_array) else {
                return Err(AppError::NotFound(format!("第 {page} 页没有候选")));
            };
            let Some(candidate) = items.get(index) else {
                return Err(AppError::InvalidInput("候选序号越界".into()));
            };
            let file = candidate
                .get("file")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::InvalidInput("候选缺少文件".into()))?
                .to_string();
            let score = candidate.get("score").cloned().unwrap_or(json!(0));
            let issues = candidate.get("issues").cloned().unwrap_or(json!([]));
            (file, score, issues)
        };
        let path = safe_candidate_path(&project, &file)
            .ok_or_else(|| AppError::NotFound("候选文件不存在或路径无效".into()))?;
        let svg = fs::read_to_string(path)?;
        fs::write(page_svg_path(&project, page), svg)?;
        entry["selected"] = json!(index);
        entry["score"] = score;
        entry["issues"] = issues;
        write_json_file(&selection_path, &selection)?;
        Ok(())
    }
}

fn safe_candidate_path(project: &Path, file: &str) -> Option<PathBuf> {
    let normalized = file.replace('\\', "/");
    if !normalized.starts_with("candidates/") || normalized.contains("..") {
        return None;
    }
    let path = project.join(&normalized);
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extracts_local_markdown() {
        let path = std::env::temp_dir().join(format!(
            "ppt-local-{}.md",
            uuid::Uuid::new_v4()
        ));
        let mut file = fs::File::create(&path).unwrap();
        writeln!(file, "# 标题\n\n正文内容").unwrap();
        drop(file);

        let source =
            PptExtensionService::extract_local_file(path.to_str().unwrap()).unwrap();
        assert_eq!(source.source_type, "md");
        assert!(source.text.contains("正文内容"));
        assert!(source.word_count > 0);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_local_file() {
        let path = std::env::temp_dir().join(format!(
            "ppt-local-{}.bin",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, b"not a document").unwrap();
        let result = PptExtensionService::extract_local_file(path.to_str().unwrap());
        assert!(result.is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cleans_ai_meta_suggestions() {
        assert_eq!(clean_meta_title("《机械制造工艺学》PPT"), "机械制造工艺学");
        assert_eq!(clean_meta_title("“第三章”"), "第三章");
        assert_eq!(clean_meta_audience("本科教学，企业客户"), "本科教学");
        assert_eq!(clean_meta_audience("技术评审；管理层"), "技术评审");
    }

    #[test]
    fn falls_back_to_first_source_title() {
        let sources = vec![PptMetaSource {
            title: "机械制造工艺学.md".into(),
            source_type: "md".into(),
            excerpt: String::new(),
        }];
        assert_eq!(fallback_meta_title(&sources), "机械制造工艺学");
    }

    #[test]
    fn parses_draft_page_numbers() {
        assert_eq!(parse_page_number("P01.svg"), Some(1));
        assert_eq!(parse_page_number("P12.svg"), Some(12));
        assert_eq!(parse_page_number("cover.svg"), None);
        assert!(natural_page_cmp("P02.svg", "P10.svg").is_lt());
    }

    #[test]
    fn persists_regenerate_options_without_losing_plan() {
        let dir = std::env::temp_dir().join(format!("ppt-opts-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("job.json"),
            serde_json::to_vec_pretty(&json!({
                "plan": { "title": "保留大纲", "slides": [] },
                "options": { "audience": "测试" }
            }))
            .unwrap(),
        )
        .unwrap();

        update_job_json_plan_options(&dir, Some(8), Some(3)).unwrap();
        let spec: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("job.json")).unwrap()).unwrap();
        assert_eq!(spec["options"]["slideCount"], 8);
        assert_eq!(spec["options"]["modelId"], 3);
        assert_eq!(spec["options"]["audience"], "测试");
        assert_eq!(spec["plan"]["title"], "保留大纲");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn counts_and_clears_only_svg_drafts() {
        let dir = std::env::temp_dir().join(format!("ppt-draft-{}", uuid::Uuid::new_v4()));
        let svg_dir = dir.join("project").join("svg_output");
        fs::create_dir_all(&svg_dir).unwrap();
        fs::write(svg_dir.join("P01.svg"), "<svg/>").unwrap();
        fs::write(svg_dir.join("P02.svg"), "<svg/>").unwrap();
        fs::write(svg_dir.join("note.txt"), "keep").unwrap();

        assert_eq!(count_draft_pages(&dir).unwrap(), 2);
        clear_draft_pages(&dir).unwrap();
        assert_eq!(count_draft_pages(&dir).unwrap(), 0);
        assert!(svg_dir.join("note.txt").is_file());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn splits_source_into_bounded_chunks() {
        let chunks = split_source_chunks("段落一。\n\n段落二。\n\n段落三。", 1000, 10);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].contains("段落三"));

        let long = "字".repeat(2_500);
        let chunks = split_source_chunks(&long, 1_000, 10);
        assert_eq!(chunks.len(), 3);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.chars().count() <= 1_000));
    }

    #[test]
    fn validates_structured_plan_content() {
        let mut plan = PptPlan {
            title: "测试".into(),
            slides: vec![
                PptSlide {
                    page: 1,
                    title: "封面".into(),
                    core_message: "一句话".into(),
                    ..Default::default()
                },
                PptSlide {
                    page: 2,
                    title: "内容".into(),
                    core_message: "核心".into(),
                    page_theme: "内容".into(),
                    ..Default::default()
                },
            ],
        };
        assert!(validate_plan_content(&plan)
            .iter()
            .any(|issue| issue.contains("内容块过少")));

        plan.slides[1].content_blocks = vec![
            crate::models::extension::PptContentBlock {
                label: "A".into(),
                text: "说明一".into(),
                detail: String::new(),
            },
            crate::models::extension::PptContentBlock {
                label: "B".into(),
                text: "说明二".into(),
                detail: String::new(),
            },
        ];
        plan.slides[1].evidence = vec!["事实一".into()];
        assert!(!validate_plan_content(&plan)
            .iter()
            .any(|issue| issue.contains("内容块过少")));
    }

    #[test]
    fn scores_and_rejects_svg_candidates() {
        let slide = PptSlide {
            page: 1,
            title: "标题".into(),
            evidence: vec!["关键事实".into()],
            ..Default::default()
        };
        let good = "<svg viewBox=\"0 0 1280 720\"><text x=\"100\" y=\"100\" font-size=\"20\">关键事实与说明</text></svg>";
        let score = score_svg_candidate(good, &slide, &std::collections::HashSet::new(), &[]);
        assert!(!score.hard_fail);
        assert!(score.score > 40);

        let bad =
            "<svg viewBox=\"0 0 1280 720\"><use href=\"#x\"/><text>Prompt</text></svg>";
        let score = score_svg_candidate(bad, &slide, &std::collections::HashSet::new(), &[]);
        assert!(score.hard_fail);
        assert!(score.issues.iter().any(|issue| issue.contains("use")));
    }

    #[test]
    fn extracts_svg_from_ai_text() {
        let text = "说明文字\n<svg viewBox=\"0 0 1280 720\"></svg>\n结束";
        let svg = extract_svg_block(text).unwrap();
        assert!(svg.starts_with("<svg"));
        assert!(svg.ends_with("</svg>"));
    }

    #[test]
    fn adaptive_candidate_plan_matches_thresholds() {
        assert_eq!(adaptive_candidate_plan(Some(90), false, 3), (false, false));
        assert_eq!(adaptive_candidate_plan(Some(70), false, 3), (true, false));
        assert_eq!(adaptive_candidate_plan(Some(40), false, 3), (true, true));
        assert_eq!(adaptive_candidate_plan(Some(40), true, 3), (true, true));
        assert_eq!(adaptive_candidate_plan(None, true, 3), (true, true));
        assert_eq!(adaptive_candidate_plan(Some(40), false, 1), (false, false));
    }

    #[test]
    fn parses_draft_generation_modes() {
        assert_eq!(DraftGenerationMode::parse(None), DraftGenerationMode::BestOf);
        assert_eq!(
            DraftGenerationMode::parse(Some("oneShot")),
            DraftGenerationMode::OneShot
        );
        assert_eq!(
            DraftGenerationMode::parse(Some("programmatic")),
            DraftGenerationMode::Programmatic
        );
        assert_eq!(
            DraftGenerationMode::parse(Some("bestOf")),
            DraftGenerationMode::BestOf
        );
    }

    #[test]
    fn rejects_candidate_path_traversal() {
        let project = std::env::temp_dir().join("ppt-safe-candidate-test");
        assert!(safe_candidate_path(&project, "../secret.svg").is_none());
        assert!(safe_candidate_path(&project, "candidates/../x.svg").is_none());
        assert!(safe_candidate_path(&project, "other/1.svg").is_none());
    }

    fn test_model(id: i64, model_id: &str, api_url: &str) -> AiModel {
        AiModel {
            id,
            name: model_id.to_string(),
            provider: "custom".into(),
            protocol: "openai_compatible".into(),
            api_url: api_url.into(),
            api_key: None,
            model_id: model_id.into(),
            is_default: false,
            max_context: 32_000,
            supports_tools: false,
            supports_vision: false,
            max_output_tokens: None,
            created_at: "2026-01-01T00:00:00+08:00".into(),
        }
    }

    #[test]
    fn fast_model_keeps_non_reasoning_user_model() {
        let user = test_model(1, "deepseek-chat", "https://api.deepseek.com");
        let models = vec![
            user.clone(),
            test_model(2, "qwen-plus", "https://dashscope.aliyuncs.com"),
        ];
        assert_eq!(pick_fast_model_id(&user, &models), 1);
    }

    #[test]
    fn fast_model_prefers_same_provider() {
        let user = test_model(1, "deepseek-reasoner", "https://api.deepseek.com");
        let models = vec![
            user.clone(),
            test_model(2, "qwen-plus", "https://dashscope.aliyuncs.com"),
            test_model(3, "deepseek-chat", "https://api.deepseek.com/"),
        ];
        // 同厂商的 deepseek-chat 优先，即使千问 id 更小且也命中快模型关键字。
        assert_eq!(pick_fast_model_id(&user, &models), 3);
    }

    #[test]
    fn fast_model_never_crosses_provider() {
        let user = test_model(1, "deepseek-reasoner", "https://api.deepseek.com");
        let models = vec![
            user.clone(),
            test_model(2, "qwen-plus", "https://dashscope.aliyuncs.com"),
        ];
        // 只有跨厂商快模型时沿用用户模型，避免 Key 不通用导致 401。
        assert_eq!(pick_fast_model_id(&user, &models), 1);
    }

    #[test]
    fn fast_model_ignores_same_provider_reasoning_models() {
        let user = test_model(1, "deepseek-reasoner", "https://api.deepseek.com");
        let models = vec![
            user.clone(),
            test_model(2, "deepseek-r1", "https://api.deepseek.com"),
        ];
        assert_eq!(pick_fast_model_id(&user, &models), 1);
    }

    fn setup_ppt_job(prefix: &str) -> (Database, PathBuf, PptJob) {
        let root = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let db = Database::init(root.join("test.db").to_str().unwrap()).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir_all(workspace.join("input")).unwrap();
        let job = PptJob {
            id: format!("job-{}", Uuid::new_v4()),
            extension_id: "ppt-master".into(),
            status: "ready".into(),
            stage: STAGE_OUTLINE_READY.into(),
            title: "测试演示".into(),
            template_id: Some("layout-a".into()),
            workspace_path: workspace.to_string_lossy().to_string(),
            project_path: None,
            pptx_path: None,
            final_pptx_path: None,
            error_code: None,
            error_message: None,
            log_tail: None,
            created_at: "2026-11-01T00:00:00+08:00".into(),
            started_at: None,
            finished_at: None,
        };
        db.insert_ppt_job(&job).unwrap();
        (db, root, job)
    }

    #[test]
    fn job_options_merges_source_and_template_fields() {
        let (db, root, job) = setup_ppt_job("ppt-options");
        let spec = json!({
            "source": { "title": "素材标题" },
            "templates": { "layoutId": "layout-x", "chartIds": ["area_chart"] },
            "options": {
                "generationMode": "bestOf",
                "nativeCharts": true,
                "slideCount": 8,
                "title": "旧标题"
            }
        });
        fs::write(
            PathBuf::from(&job.workspace_path).join("job.json"),
            serde_json::to_vec_pretty(&spec).unwrap(),
        )
        .unwrap();

        let options = PptExtensionService::job_options(&db, &job.id).unwrap();
        assert_eq!(options["title"], "素材标题");
        assert_eq!(options["layoutId"], "layout-x");
        assert_eq!(options["chartIds"][0], "area_chart");
        assert_eq!(options["generationMode"], "bestOf");
        assert_eq!(options["nativeCharts"], true);
        assert_eq!(options["slideCount"], 8);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_file_returns_fixed_source_path() {
        let (db, root, job) = setup_ppt_job("ppt-source");
        let source = PathBuf::from(&job.workspace_path)
            .join("input")
            .join("source.md");
        fs::write(&source, "# 素材\n\n正文").unwrap();

        let path = PptExtensionService::source_file(&db, &job.id).unwrap();
        assert_eq!(PathBuf::from(&path), source);
        assert!(Path::new(&path).is_file());

        fs::remove_file(&source).unwrap();
        assert!(PptExtensionService::source_file(&db, &job.id).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ai_selection_saves_candidates_and_cleans_stale_files() {
        let root = std::env::temp_dir().join(format!("ppt-ai-selection-{}", Uuid::new_v4()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let candidates = vec![
            PageCandidateScore {
                score: 92,
                issues: Vec::new(),
                hard_fail: false,
                // data-pptx 属性应在落盘时清除。
                svg: "<svg data-pptx-foo=\"1\"><text>A</text></svg>".into(),
            },
            PageCandidateScore {
                score: 80,
                issues: vec!["轻微越界".into()],
                hard_fail: false,
                svg: "<svg><text>B</text></svg>".into(),
            },
            PageCandidateScore {
                score: 60,
                issues: Vec::new(),
                hard_fail: false,
                svg: "<svg><text>C</text></svg>".into(),
            },
        ];
        update_ai_selection(&project, 2, &candidates[1].svg, &candidates).unwrap();

        for index in 1..=3 {
            let file = project.join(format!("candidates/P02_{index}.svg"));
            assert!(file.is_file(), "候选文件 {index} 应存在");
        }
        let saved = fs::read_to_string(project.join("candidates/P02_1.svg")).unwrap();
        assert!(!saved.contains("data-pptx-"));

        let selection: Value = serde_json::from_str(
            &fs::read_to_string(project.join("page_selection.json")).unwrap(),
        )
        .unwrap();
        let entry = &selection["pages"][0];
        assert_eq!(entry["page"], 2);
        assert_eq!(entry["selected"], 1);
        assert_eq!(entry["mode"], "ai");
        assert_eq!(entry["candidates"][1]["file"], "candidates/P02_2.svg");

        // 新一页只有 1 个候选时，旧的 2/3 候选文件应被清理。
        update_ai_selection(&project, 2, &candidates[0].svg, &candidates[..1]).unwrap();
        assert!(!project.join("candidates/P02_2.svg").exists());
        assert!(!project.join("candidates/P02_3.svg").exists());
        let _ = fs::remove_dir_all(root);
    }

    fn slide_with_title(title: &str) -> PptSlide {
        PptSlide {
            title: title.into(),
            ..Default::default()
        }
    }

    #[test]
    fn derives_template_page_types_from_file_names() {
        assert_eq!(derive_template_page_type("01_cover"), "cover");
        assert_eq!(derive_template_page_type("01a_cover"), "cover");
        assert_eq!(derive_template_page_type("06_structure_breakdown"), "structure_breakdown");
        assert_eq!(derive_template_page_type("content"), "content");
    }

    #[test]
    fn selects_template_page_by_title_semantics() {
        let kpi = [
            "cover",
            "toc",
            "key_findings",
            "kpi_overview",
            "trend_chart",
            "structure_breakdown",
            "performance_table",
            "risk_gauge",
            "comparison",
            "annual_review",
            "summary_table",
            "ending",
        ];
        assert_eq!(
            choose_template_page_type(&slide_with_title("核心指标总览"), 2, 8, &kpi).as_deref(),
            Some("kpi_overview")
        );
        assert_eq!(
            choose_template_page_type(&slide_with_title("核心发现"), 2, 8, &kpi).as_deref(),
            Some("key_findings")
        );
        assert_eq!(
            choose_template_page_type(&slide_with_title("趋势分析"), 2, 8, &kpi).as_deref(),
            Some("trend_chart")
        );
        assert_eq!(
            choose_template_page_type(&slide_with_title("风险提示"), 2, 8, &kpi).as_deref(),
            Some("risk_gauge")
        );
        assert_eq!(
            choose_template_page_type(&slide_with_title("方案对比"), 2, 8, &kpi).as_deref(),
            Some("comparison")
        );
    }

    #[test]
    fn selects_scenario_pages_across_templates() {
        let insight = [
            "cover",
            "key_findings",
            "concept_definition",
            "model_diagram",
            "comparison_table",
            "quote",
            "framework",
            "workflow",
            "case_study",
            "quick_reference",
            "recommended_reading",
            "ending",
        ];
        assert_eq!(
            choose_template_page_type(&slide_with_title("概念定义"), 2, 8, &insight).as_deref(),
            Some("concept_definition")
        );
        assert_eq!(
            choose_template_page_type(&slide_with_title("专家引用"), 2, 8, &insight).as_deref(),
            Some("quote")
        );
        assert_eq!(
            choose_template_page_type(&slide_with_title("案例复盘"), 2, 8, &insight).as_deref(),
            Some("case_study")
        );

        let mbb = [
            "cover",
            "executive_summary",
            "metrics_dashboard",
            "distribution",
            "importance_performance",
            "root_cause",
            "strategy_pillars",
            "initiative_priority",
            "roadmap",
        ];
        assert_eq!(
            choose_template_page_type(&slide_with_title("根因分析"), 2, 8, &mbb).as_deref(),
            Some("root_cause")
        );
        assert_eq!(
            choose_template_page_type(&slide_with_title("举措优先级"), 2, 8, &mbb).as_deref(),
            Some("initiative_priority")
        );

        let tech = [
            "cover",
            "positioning",
            "product_card",
            "core_difference",
            "data_comparison",
            "combination",
            "decision_tree",
            "comparison_table",
            "summary",
        ];
        assert_eq!(
            choose_template_page_type(&slide_with_title("决策树"), 2, 8, &tech).as_deref(),
            Some("decision_tree")
        );
        assert_eq!(
            choose_template_page_type(&slide_with_title("产品定位"), 2, 8, &tech).as_deref(),
            Some("positioning")
        );
    }

    #[test]
    fn selects_position_and_fallback_template_pages() {
        let kpi = [
            "cover",
            "toc",
            "key_findings",
            "kpi_overview",
            "comparison",
            "ending",
        ];
        assert_eq!(
            choose_template_page_type(&slide_with_title("任意标题"), 0, 8, &kpi).as_deref(),
            Some("cover")
        );
        assert_eq!(
            choose_template_page_type(&slide_with_title("谢谢"), 7, 8, &kpi).as_deref(),
            Some("ending")
        );

        let aviation = [
            "cover",
            "toc",
            "chapter",
            "content",
            "content_cards",
            "process_steps",
            "ending",
        ];
        let mut slide = slide_with_title("推进路径");
        slide.chart_type = "process".into();
        assert_eq!(
            choose_template_page_type(&slide, 2, 8, &aviation).as_deref(),
            Some("process_steps")
        );

        let fallback =
            choose_template_page_type(&slide_with_title("杂项说明"), 2, 8, &kpi).unwrap();
        assert_ne!(fallback, "cover");
        assert_ne!(fallback, "toc");
    }

    #[test]
    fn extracts_deduplicated_template_slots() {
        let svg = "<text>{{TITLE}}</text><text>{{TITLE}}</text><text>{{KPI_1_VALUE}}</text>";
        assert_eq!(
            placeholder_tokens(svg),
            vec!["TITLE".to_string(), "KPI_1_VALUE".to_string()]
        );
    }

    #[test]
    fn rejects_svg_with_template_placeholders() {
        let slide = slide_with_title("标题");
        let svg = "<svg viewBox=\"0 0 1280 720\"><text>{{TITLE}}</text></svg>";
        let score = score_svg_candidate(svg, &slide, &std::collections::HashSet::new(), &[]);
        assert!(score.hard_fail);
        assert!(score.issues.iter().any(|issue| issue.contains("占位符")));
    }

    #[test]
    fn prompt_includes_selected_template_page_and_roster() {
        let slide = slide_with_title("核心指标总览");
        let plan = PptPlan {
            title: "测试".into(),
            slides: vec![slide.clone()],
        };
        let prompt = page_generation_prompt(
            &plan,
            &slide,
            "spec",
            "understanding",
            "",
            "",
            "方向",
            "模板页参考-XYZ",
            "模板页面清单-ABC",
            "",
        );
        assert!(prompt.contains("【模板版式参考】"));
        assert!(prompt.contains("模板页参考-XYZ"));
        assert!(prompt.contains("【模板页面清单】"));
        assert!(prompt.contains("模板页面清单-ABC"));
    }

    #[test]
    fn builds_template_reference_from_design_spec_and_pages() {
        let root =
            std::env::temp_dir().join(format!("ppt-template-ref-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("01_cover.svg"),
            "<svg viewBox=\"0 0 1280 720\"><text>{{TITLE}}</text></svg>",
        )
        .unwrap();
        fs::write(
            root.join("04_kpi_overview.svg"),
            "<svg viewBox=\"0 0 1280 720\"><text>{{KPI_1_VALUE}}</text></svg>",
        )
        .unwrap();
        fs::write(
            root.join("design_spec.md"),
            "## IV. Signature Design Elements\n- 顶部识别线\n\n## V. Page Roster\n| 04_kpi_overview | KPI Overview |",
        )
        .unwrap();

        let reference = build_template_reference(Some(&root), "kpi_report_core");
        assert!(!reference.is_empty());
        assert!(reference.roster.contains("Page Roster"));
        let hint = reference.hint_for(&slide_with_title("核心指标总览"), 2, 8);
        assert!(hint.contains("kpi_report_core/kpi_overview"));
        assert!(hint.contains("04_kpi_overview.svg"));
        assert!(hint.contains("KPI_1_VALUE"));
        assert!(!hint.contains("06_content_cards"));

        let _ = fs::remove_dir_all(root);
    }
}
