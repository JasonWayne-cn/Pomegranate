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

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::database::Database;
use crate::error::AppError;
use crate::models::extension::{
    PptDraftPage, PptJob, PptJobInput, PptLocalFileSource, PptMetaSource, PptMetaSuggestion,
    PptPlan, PptSourceMeta,
};
use crate::services::ai::AiService;
use crate::services::doc_extract::DocExtractService;
use crate::services::excel_import::ExcelImportService;
use crate::services::extension::ExtensionService;
use crate::services::extension_runner;
use crate::services::import::read_text_auto_encoding;
use crate::services::note::NoteService;
use crate::services::pdf::PdfService;
use crate::services::ppt_plan;
use crate::services::safe_filename;

const MAX_SOURCE_CHARS: usize = 200_000;
const MAX_PER_SOURCE_CHARS: usize = 40_000;
const DEFAULT_TIMEOUT_SECS: u64 = 900;
const DEFAULT_PLANNING_TIMEOUT_SECS: u64 = 180;
const MAX_PLANNING_ATTEMPTS: usize = 2;
const MAX_DRAFT_PAGES: usize = 120;
const MAX_DRAFT_PAGE_BYTES: u64 = 8 * 1024 * 1024;

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
        emit_system_log(app.as_ref(), "AI 正在规划大纲...");
        let plan = build_plan_with_ai(
            db,
            &input,
            &source_md,
            app.as_ref(),
            &cancel,
            planning_timeout,
        )
        .await?;
        let slide_count = plan.slides.len();
        emit_system_log(app.as_ref(), &format!("大纲已生成：{} 页", slide_count));

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

        fs::write(input_dir.join("source.md"), &source_md)?;
        fs::write(
            input_dir.join("source_manifest.json"),
            serde_json::to_vec_pretty(&sources)?,
        )?;
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
        Self::start_job_stage(app, db, cancels, job_id, PptRunStage::Export, export_dir)
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
            return Err(AppError::InvalidInput(
                "作业正在运行，不能重新生成大纲".into(),
            ));
        }
        let job_dir = PathBuf::from(&job.workspace_path);
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

        emit_system_log(app.as_ref(), "正在重新生成大纲...");
        let plan = build_plan_with_ai(
            db,
            &input,
            &source,
            app.as_ref(),
            &cancel,
            Duration::from_secs(DEFAULT_PLANNING_TIMEOUT_SECS),
        )
        .await?;

        ppt_plan::write_plan(&job_dir, &plan)?;
        update_job_json_plan(&job_dir, &plan)?;
        update_job_json_plan_options(&job_dir, slide_count, model_id)?;
        clear_draft_pages(&job_dir)?;
        clear_output_pptx(&job_dir)?;

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
        emit_system_log(
            app.as_ref(),
            &format!("大纲已重新生成：{} 页", plan.slides.len()),
        );
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
        cancels: &Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        job_id: &str,
    ) -> Result<(), AppError> {
        let map = cancels
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let flag = map
            .get(job_id)
            .ok_or_else(|| AppError::NotFound("作业不在运行中".into()))?;
        flag.store(true, Ordering::SeqCst);
        Ok(())
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

async fn build_plan_with_ai(
    db: &Database,
    input: &PptJobInput,
    source: &str,
    app: Option<&AppHandle>,
    cancel: &Arc<AtomicBool>,
    planning_timeout: Duration,
) -> Result<PptPlan, AppError> {
    let page_instruction = match input.slide_count {
        Some(count) => format!(
            "请根据素材生成约 {} 页左右的演示大纲。",
            count.clamp(1, 40)
        ),
        None => "页数不固定，请根据素材内容自行决定合适的页数（通常 6–15 页）。".to_string(),
    };
    let prompt = format!(
        "你是 PPT 内容规划助手。{page_instruction}\n\
         标题：{title}\n听众：{audience}\n额外要求：{extra}\n\
         每页 bullets 必须使用“短标题：具体说明”的格式：冒号前是不超过 12 字的短标题，冒号后是 20–60 字的说明。\n\
         不要把整句长文本当作标题，也不要把同一句话同时写成标题和说明。\n\
         每页根据素材实际内容写 3–6 条要点；内容不足时减少条目，不要为凑满模板而重复、拆分或编造内容。\n\
         不要生成没有素材依据的时间周期、数量或结论。\n\
         如果某页适合用图表表达数据，请在对应 slide 中增加 chart 字段：\n\
         {{\"type\":\"line|column|bar|pie|donut|area|gantt|radar|scatter\",\"categories\":[\"...\"],\"series\":[{{\"name\":\"...\",\"values\":[数字]}}]}}\n\
         只输出 JSON，不要 markdown 代码块。JSON 结构：\n\
         {{\"title\":\"...\",\"slides\":[{{\"page\":1,\"title\":\"...\",\"coreMessage\":\"...\",\"bullets\":[\"...\"],\"chart\":null}}]}}\n\n\
         素材：\n{source}",
        page_instruction = page_instruction,
        title = input.title,
        audience = input.audience,
        extra = input.extra_requirements.clone().unwrap_or_default(),
        source = source.chars().take(12_000).collect::<String>(),
    );

    let mut last_reason = String::new();
    for attempt in 0..MAX_PLANNING_ATTEMPTS {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Custom("已取消大纲生成".into()));
        }
        emit_system_log(
            app,
            &format!("AI 规划第 {} 次尝试…", attempt + 1),
        );
        let future = AiService::complete_once(db, &prompt, input.model_id);
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
                            return Ok(plan);
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
            emit_system_log(app, &format!("AI 规划失败：{}；准备重试", last_reason));
        }
    }

    emit_system_log(
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
}
