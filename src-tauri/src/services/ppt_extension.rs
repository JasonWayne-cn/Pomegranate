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
    PptPlan, PptSlide, PptSourceMeta,
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

        emit_system_log(app.as_ref(), "AI 正在分块理解素材...");
        let understanding_timeout = planning_timeout.min(Duration::from_secs(150));
        let understanding = build_understanding_with_ai(
            db,
            &input,
            &source_md,
            app.as_ref(),
            &cancel,
            understanding_timeout,
        )
        .await?;
        fs::write(input_dir.join("understanding.md"), &understanding)?;
        emit_system_log(
            app.as_ref(),
            &format!(
                "素材理解完成：{} 字符",
                understanding.chars().count()
            ),
        );

        emit_system_log(app.as_ref(), "AI 正在规划大纲...");
        let plan = build_plan_with_ai(
            db,
            &input,
            &source_md,
            &understanding,
            app.as_ref(),
            &cancel,
            planning_timeout,
        )
        .await?;
        let slide_count = plan.slides.len();
        emit_system_log(app.as_ref(), &format!("大纲已生成：{} 页", slide_count));

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

        let understanding_path = job_dir.join("input").join("understanding.md");
        let understanding = if understanding_path.is_file() {
            fs::read_to_string(&understanding_path).unwrap_or_default()
        } else {
            emit_system_log(app.as_ref(), "正在补充素材理解...");
            match build_understanding_with_ai(
                db,
                &input,
                &source,
                app.as_ref(),
                &cancel,
                Duration::from_secs(DEFAULT_PLANNING_TIMEOUT_SECS),
            )
            .await
            {
                Ok(value) => {
                    let _ = fs::write(&understanding_path, &value);
                    value
                }
                Err(error) => {
                    emit_system_log(
                        app.as_ref(),
                        &format!("素材理解失败，使用素材节选继续：{}", error),
                    );
                    source.clone()
                }
            }
        };

        emit_system_log(app.as_ref(), "正在重新生成大纲...");
        let plan = build_plan_with_ai(
            db,
            &input,
            &source,
            &understanding,
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

const UNDERSTANDING_CHUNK_CHARS: usize = 8_000;
const UNDERSTANDING_MAX_CHUNKS: usize = 16;
const PLANNING_SOURCE_CHARS: usize = 60_000;
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
    drafts: &[String],
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
         主题：{title}\n受众：{audience}\n\n分块理解：\n{}",
        drafts.join("\n\n---\n\n")
    )
}

async fn build_understanding_with_ai(
    db: &Database,
    input: &PptJobInput,
    source: &str,
    app: Option<&AppHandle>,
    cancel: &Arc<AtomicBool>,
    timeout: Duration,
) -> Result<String, AppError> {
    let chunks = split_source_chunks(source, UNDERSTANDING_CHUNK_CHARS, UNDERSTANDING_MAX_CHUNKS);
    if chunks.is_empty() {
        return Ok(String::new());
    }
    let mut drafts: Vec<String> = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Custom("已取消大纲生成".into()));
        }
        emit_system_log(
            app,
            &format!(
                "AI 正在理解素材 {}/{}（{} 字）...",
                index + 1,
                chunks.len(),
                chunk.chars().count()
            ),
        );
        let prompt = understanding_chunk_prompt(&input.title, chunk, index + 1, chunks.len());
        let future = AiService::complete_once(db, &prompt, input.model_id);
        match await_cancellable(future, cancel, timeout).await {
            Ok(text) if !text.trim().is_empty() => drafts.push(text.trim().to_string()),
            Ok(_) => {}
            Err(PlanRunError::Cancelled) => {
                return Err(AppError::Custom("已取消大纲生成".into()));
            }
            Err(PlanRunError::Timeout) => emit_system_log(
                app,
                &format!("素材第 {} 块理解超时，已跳过", index + 1),
            ),
            Err(PlanRunError::Ai(error)) => emit_system_log(
                app,
                &format!("素材第 {} 块理解失败：{}", index + 1, error),
            ),
        }
    }

    if drafts.is_empty() {
        emit_system_log(app, "素材理解不可用，规划阶段回退到素材节选");
        return Ok(source.chars().take(PLANNING_SOURCE_CHARS).collect());
    }
    if drafts.len() == 1 {
        return Ok(drafts.remove(0));
    }

    emit_system_log(app, "AI 正在合并分块理解...");
    let prompt = merge_understanding_prompt(&input.title, &input.audience, &drafts);
    let future = AiService::complete_once(db, &prompt, input.model_id);
    match await_cancellable(future, cancel, timeout).await {
        Ok(text) if !text.trim().is_empty() => Ok(text.trim().to_string()),
        Ok(_) => Ok(drafts.join("\n\n---\n\n")),
        Err(PlanRunError::Cancelled) => Err(AppError::Custom("已取消大纲生成".into())),
        Err(error) => {
            let reason = match error {
                PlanRunError::Timeout => "合并理解超时".to_string(),
                PlanRunError::Ai(message) => message,
                PlanRunError::Cancelled => "已取消".to_string(),
            };
            emit_system_log(
                app,
                &format!("{}，使用分块理解原文继续", reason),
            );
            Ok(drafts.join("\n\n---\n\n"))
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

fn plan_repair_prompt(
    input: &PptJobInput,
    plan: &PptPlan,
    issues: &[String],
    understanding: &str,
) -> String {
    let plan_json = serde_json::to_string_pretty(plan).unwrap_or_default();
    format!(
        "修复这份 PPT 结构化大纲。只输出 JSON，不要 markdown。\n\
         必须保持与原文相同的主题和事实，不要编造数字、年份、排名或奖项。\n\
         修复问题：{}\n\n\
         要求：\n\
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
         {{\"title\":\"...\",\"slides\":[{{\"page\":1,\"title\":\"...\",\"pageTheme\":\"...\",\"mainClaim\":\"...\",\"contentScope\":\"...\",\"coreMessage\":\"...\",\"contentBlocks\":[{{\"label\":\"...\",\"text\":\"...\",\"detail\":\"...\"}}],\"evidence\":[\"...\"],\"relation\":\"none\",\"chartType\":\"cards\",\"density\":\"balanced\",\"visualIntent\":\"...\",\"bullets\":[\"...\"],\"speakerNote\":\"...\",\"chart\":null}}]}}\n\n\
         标题：{title}\n听众：{audience}\n\n\
         素材理解：\n{understanding}\n\n当前大纲：\n{plan_json}",
        issues.join("；"),
        title = input.title,
        audience = input.audience,
        understanding = understanding.chars().take(PLANNING_SOURCE_CHARS).collect::<String>(),
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
) -> Result<PptPlan, AppError> {
    let prompt = plan_repair_prompt(input, plan, issues, understanding);
    for attempt in 0..PLAN_CONTENT_REPAIR_ATTEMPTS {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Custom("已取消大纲生成".into()));
        }
        emit_system_log(
            app,
            &format!("大纲内容修复第 {} 次尝试...", attempt + 1),
        );
        let future = AiService::complete_once(db, &prompt, input.model_id);
        match await_cancellable(future, cancel, planning_timeout).await {
            Ok(text) => {
                if let Some(value) = extract_json(&text)
                    .and_then(|json| serde_json::from_str::<Value>(&json).ok())
                {
                    return Ok(ppt_plan::normalize_plan(
                        value,
                        &input.title,
                        understanding,
                        input.slide_count,
                    ));
                }
            }
            Err(PlanRunError::Cancelled) => {
                return Err(AppError::Custom("已取消大纲生成".into()));
            }
            Err(PlanRunError::Timeout) => {
                emit_system_log(app, "大纲内容修复超时");
            }
            Err(PlanRunError::Ai(message)) => {
                emit_system_log(app, &format!("大纲内容修复失败：{}", message));
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
    let understanding_excerpt: String = understanding
        .chars()
        .take(PLANNING_SOURCE_CHARS)
        .collect();
    let source_excerpt: String = source.chars().take(PLANNING_SOURCE_CHARS).collect();
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
         素材理解：\n{understanding}\n\n\
         素材节选：\n{source}",
        page_instruction = page_instruction,
        title = input.title,
        audience = input.audience,
        extra = input.extra_requirements.clone().unwrap_or_default(),
        understanding = if understanding_excerpt.trim().is_empty() {
            "（暂无，直接依据素材节选规划）"
        } else {
            understanding_excerpt.as_str()
        },
        source = source_excerpt,
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
                            let issues = validate_plan_content(&plan);
                            if !issues.is_empty() {
                                emit_system_log(
                                    app,
                                    &format!(
                                        "大纲内容校验发现 {} 项问题，尝试修复",
                                        issues.len()
                                    ),
                                );
                                match repair_plan_with_ai(
                                    db,
                                    input,
                                    &plan,
                                    &issues,
                                    understanding,
                                    app,
                                    cancel,
                                    planning_timeout,
                                )
                                .await
                                {
                                    Ok(repaired) => {
                                        let remaining = validate_plan_content(&repaired);
                                        if remaining.is_empty() {
                                            return Ok(repaired);
                                        }
                                        emit_system_log(
                                            app,
                                            &format!(
                                                "修复后仍有 {} 项问题，保留原始大纲",
                                                remaining.len()
                                            ),
                                        );
                                    }
                                    Err(AppError::Custom(message))
                                        if message.contains("取消") =>
                                    {
                                        return Err(AppError::Custom(message));
                                    }
                                    Err(error) => emit_system_log(
                                        app,
                                        &format!("大纲内容修复失败：{}", error),
                                    ),
                                }
                            }
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

// ───────────────────────── P1：逐页 AI 生成与质量闭环 ─────────────────────────

const AI_PAGE_MIN_SCORE: i32 = 55;
const AI_PAGE_TIMEOUT_SECS: u64 = 180;
const AI_PROMPT_UNDERSTANDING_CHARS: usize = 8_000;

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
    template_hint: &str,
) -> String {
    let slide_json = serde_json::to_string_pretty(slide).unwrap_or_default();
    let understanding: String = understanding
        .chars()
        .take(AI_PROMPT_UNDERSTANDING_CHARS)
        .collect();
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
         8. 本次采用方向：{}。\n\n\
         【spec_lock】\n{}\n\n\
         【模板结构参考】\n{}\n\n\
         【全局信息】\n标题：{}\n总页数：{}\n上一页：{}\n下一页：{}\n\n\
         【素材理解】\n{}\n\n\
         【当前页】\n{}\n\n\
         请输出完整 SVG：",
        layout_hint(slide),
        direction,
        spec_lock,
        template_hint,
        plan.title,
        plan.slides.len(),
        if previous_title.is_empty() { "无" } else { previous_title },
        if next_title.is_empty() { "无" } else { next_title },
        if understanding.trim().is_empty() { "无" } else { understanding.as_str() },
        slide_json,
    )
}

fn score_svg_candidate(
    svg: &str,
    slide: &PptSlide,
    allowed_colors: &std::collections::HashSet<String>,
    previous_svg: Option<&str>,
) -> PageCandidateScore {
    let mut score = 100i32;
    let mut issues = Vec::new();
    let mut hard_fail = false;

    if !svg.contains("<svg") || !svg.contains("</svg>") {
        hard_fail = true;
        issues.push("缺少完整 SVG".to_string());
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
    if let Some(previous) = previous_svg {
        let current_lead: String = svg.chars().take(600).collect();
        let previous_lead: String = previous.chars().take(600).collect();
        if !current_lead.trim().is_empty() && current_lead == previous_lead {
            score -= 20;
            issues.push("与上一页结构过于相似".to_string());
        }
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

fn update_draft_selection(
    project: &Path,
    page: u32,
    selected: &PageCandidateScore,
    candidates: &[PageCandidateScore],
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
        "selected": 0,
        "score": selected.score,
        "issues": selected.issues,
        "candidates": candidates.iter().map(|candidate| json!({
            "score": candidate.score,
            "issues": candidate.issues,
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
    /// 逐页生成 AI SVG 草稿；失败页回退到扩展模板渲染。
    pub async fn render_ai_draft(
        app: AppHandle,
        db: Arc<Database>,
        cancels: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
        job_id: String,
        candidate_count: usize,
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
        let spec = load_job_spec(&job_dir);
        let model_id = job_model_id(&spec);
        let understanding = fs::read_to_string(job_dir.join("input").join("understanding.md"))
            .unwrap_or_default();
        let extension = ExtensionService::get(&db, &job.extension_id)?;
        let layout_id = job.template_id.clone().unwrap_or_default();
        let template_base = PathBuf::from(&extension.path)
            .join("templates")
            .join("layouts")
            .join(&layout_id);
        let template_dir = if template_base.join("templates").is_dir() {
            template_base.join("templates")
        } else {
            template_base.clone()
        };
        let template_dir = template_dir.is_dir().then_some(template_dir);
        if let Some(dir) = template_dir.as_ref() {
            if let Ok(template) = fs::read_to_string(
                dir.join("06_content_cards.svg"),
            ) {
                let hint: String = template.chars().take(2_500).collect();
                fs::write(project.join("template_hint.svg"), hint)?;
            }
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
        emit_system_log(
            Some(&app),
            &format!(
                "开始逐页 AI 生成：{} 页 × {} 候选",
                plan.slides.len(),
                candidate_count.max(1)
            ),
        );

        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = cancels.lock() {
            map.insert(job.id.clone(), cancel.clone());
        }

        let directions = [
            "结构优先：清晰标题层级、编号/分组与稳定网格",
            "视觉优先：大数字、色块、图表或强对比图形，减少文字块",
            "叙事优先：用一条主线组织内容，强调因果/流程/对比关系",
        ];
        let mut failures: Vec<u32> = Vec::new();
        let mut previous_svg: Option<String> = None;
        let mut selected_pages = 0usize;

        for (index, slide) in plan.slides.iter().enumerate() {
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
            emit_system_log(
                Some(&app),
                &format!("P{:02} 正在生成 {} 个候选...", slide.page, candidate_count.max(1)),
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
            let template_hint = fs::read_to_string(project.join("template_hint.svg"))
                .unwrap_or_default();
            let mut candidates: Vec<PageCandidateScore> = Vec::new();
            for candidate_index in 0..candidate_count.max(1) {
                let direction = directions[candidate_index % directions.len()];
                let prompt = page_generation_prompt(
                    &plan,
                    slide,
                    &spec_lock,
                    &understanding,
                    previous_title,
                    next_title,
                    direction,
                    &template_hint,
                );
                let future = AiService::complete_once(&db, &prompt, model_id);
                match await_cancellable(
                    future,
                    &cancel,
                    Duration::from_secs(AI_PAGE_TIMEOUT_SECS),
                )
                .await
                {
                    Ok(text) => {
                        if let Some(svg) = extract_svg_block(&text) {
                            let scored = score_svg_candidate(
                                &svg,
                                slide,
                                &allowed_colors,
                                previous_svg.as_deref(),
                            );
                            candidates.push(scored);
                        }
                    }
                    Err(PlanRunError::Cancelled) => break,
                    Err(PlanRunError::Timeout) => emit_system_log(
                        Some(&app),
                        &format!("P{:02} 候选 {} 超时", slide.page, candidate_index + 1),
                    ),
                    Err(PlanRunError::Ai(message)) => emit_system_log(
                        Some(&app),
                        &format!("P{:02} 候选 {} 失败：{}", slide.page, candidate_index + 1, message),
                    ),
                }
            }
            candidates.sort_by(|left, right| right.score.cmp(&left.score));
            if candidates.len() >= 2 && candidates[0].score - candidates[1].score <= 5 {
                if let Some(index) =
                    review_candidates_with_ai(&db, slide, &candidates, model_id, &cancel).await
                {
                    if index > 0 && index < candidates.len() {
                        let picked = candidates.remove(index);
                        candidates.insert(0, picked);
                        emit_system_log(
                            Some(&app),
                            &format!("P{:02} AI 评审改选了候选 {}", slide.page, index + 1),
                        );
                    }
                }
            }
            let Some(mut chosen) = candidates.first().cloned() else {
                failures.push(slide.page);
                emit_system_log(
                    Some(&app),
                    &format!("P{:02} 未获得可用 SVG，改用模板兜底", slide.page),
                );
                continue;
            };
            if chosen.hard_fail || chosen.score < AI_PAGE_MIN_SCORE {
                emit_system_log(
                    Some(&app),
                    &format!(
                        "P{:02} 候选未达门槛（{}），带错误信息进行一次修复重试",
                        slide.page, chosen.score
                    ),
                );
                let repair_prompt = format!(
                    "{}\n\n上一次生成存在以下问题：{}\n请只修复这些问题并重新输出完整 SVG。",
                    page_generation_prompt(
                        &plan,
                        slide,
                        &spec_lock,
                        &understanding,
                        previous_title,
                        next_title,
                        directions[0],
                        &template_hint,
                    ),
                    chosen.issues.join("；"),
                );
                let future = AiService::complete_once(&db, &repair_prompt, model_id);
                if let Ok(text) = await_cancellable(
                    future,
                    &cancel,
                    Duration::from_secs(AI_PAGE_TIMEOUT_SECS),
                )
                .await
                {
                    if let Some(svg) = extract_svg_block(&text) {
                        let repaired = score_svg_candidate(
                            &svg,
                            slide,
                            &allowed_colors,
                            previous_svg.as_deref(),
                        );
                        if !repaired.hard_fail && repaired.score > chosen.score {
                            chosen = repaired.clone();
                        }
                        candidates.push(repaired);
                    }
                }
            }
            update_draft_selection(&project, slide.page, &chosen, &candidates)?;
            if chosen.hard_fail || chosen.score < AI_PAGE_MIN_SCORE {
                failures.push(slide.page);
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
            previous_svg = Some(cleaned_svg);
            selected_pages += 1;
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
        let model_id = job_model_id(&spec);
        let understanding = fs::read_to_string(job_dir.join("input").join("understanding.md"))
            .unwrap_or_default();
        let extension = ExtensionService::get(&db, &job.extension_id)?;
        let layout_id = job.template_id.clone().unwrap_or_default();
        let template_base = PathBuf::from(&extension.path)
            .join("templates")
            .join("layouts")
            .join(&layout_id);
        let template_dir = if template_base.join("templates").is_dir() {
            template_base.join("templates")
        } else {
            template_base.clone()
        };
        let template_dir = template_dir.is_dir().then_some(template_dir);
        let spec_lock = fs::read_to_string(project.join("spec_lock.md"))
            .unwrap_or_else(|_| build_spec_lock(template_dir.as_deref(), &plan));
        let allowed_colors = template_colors(template_dir.as_deref());
        let template_hint = fs::read_to_string(project.join("template_hint.svg"))
            .unwrap_or_default();
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
        let directions = [
            "结构优先：清晰标题层级、编号/分组与稳定网格",
            "视觉优先：大数字、色块、图表或强对比图形，减少文字块",
        ];
        let mut candidates = Vec::new();
        for (candidate_index, direction) in directions.iter().enumerate().take(candidate_count.max(1)) {
            let prompt = page_generation_prompt(
                &plan,
                &slide,
                &spec_lock,
                &understanding,
                previous_title,
                next_title,
                direction,
                &template_hint,
            );
            let future = AiService::complete_once(&db, &prompt, model_id);
            match await_cancellable(future, &cancel, Duration::from_secs(AI_PAGE_TIMEOUT_SECS)).await {
                Ok(text) => {
                    if let Some(svg) = extract_svg_block(&text) {
                        candidates.push(score_svg_candidate(
                            &svg,
                            &slide,
                            &allowed_colors,
                            existing.as_deref(),
                        ));
                    }
                }
                Err(PlanRunError::Cancelled) => break,
                Err(error) => emit_system_log(
                    Some(&app),
                    &format!("第 {page} 页候选 {} 失败：{:?}", candidate_index + 1, error),
                ),
            }
        }
        if let Ok(mut map) = cancels.lock() {
            map.remove(&format!("{job_id}:page:{page}"));
        }
        candidates.sort_by(|left, right| right.score.cmp(&left.score));
        let Some(best) = candidates.first().cloned() else {
            return Err(AppError::Custom("未获得可用 SVG".into()));
        };
        if best.hard_fail || best.score < AI_PAGE_MIN_SCORE {
            return Err(AppError::Custom(format!(
                "候选未达门槛：score={} {}",
                best.score,
                best.issues.join("；")
            )));
        }
        fs::write(
            page_svg_path(&project, page),
            sanitize_ai_svg(&best.svg),
        )?;
        update_draft_selection(&project, page, &best, &candidates)?;
        emit_system_log(
            Some(&app),
            &format!("第 {page} 页已重新生成：score={}", best.score),
        );
        Ok(())
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
        let score = score_svg_candidate(good, &slide, &std::collections::HashSet::new(), None);
        assert!(!score.hard_fail);
        assert!(score.score > 40);

        let bad =
            "<svg viewBox=\"0 0 1280 720\"><use href=\"#x\"/><text>Prompt</text></svg>";
        let score = score_svg_candidate(bad, &slide, &std::collections::HashSet::new(), None);
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
}
