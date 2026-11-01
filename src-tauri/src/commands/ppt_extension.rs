use std::sync::atomic::AtomicBool;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::models::extension::{
    PptDraftPage, PptJob, PptJobInput, PptLocalFileSource, PptMetaSource, PptMetaSuggestion,
    PptPlan,
};
use crate::services::extension::ExtensionService;
use crate::services::ppt_extension::PptExtensionService;
use crate::state::AppState;

/// PPT 扩展状态：是否安装、是否启用、是否提供 PPT 引擎。
#[tauri::command]
pub fn ppt_extension_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let platform = crate::services::extension::current_platform();
    let win7 = windows_is_legacy();
    match state.db.get_extension("ppt-master").map_err(|e| e.to_string())? {
        Some(info) => {
            let platform_compatible = info.manifest.platforms.is_empty()
                || info.manifest.platforms.iter().any(|item| item == &platform);
            Ok(json!({
                "installed": true,
                "enabled": info.enabled,
                "version": info.version,
                "supportsPpt": info.supports_ppt,
                "path": info.path,
                "platform": platform,
                "platformCompatible": platform_compatible,
                "win7": win7,
                "apiVersion": info.manifest.api_version,
                "protocolVersion": info.manifest.protocol_version,
                "embeddedPython": info
                    .manifest
                    .runtime
                    .python
                    .as_ref()
                    .and_then(|python| python.path.as_deref())
                    .map(|path| !path.trim().is_empty())
                    .unwrap_or(false),
            }))
        }
        None => Ok(json!({
            "installed": false,
            "enabled": false,
            "version": null,
            "supportsPpt": false,
            "platform": platform,
            "platformCompatible": true,
            "win7": win7,
            "extensions": ExtensionService::list(&state.db).map_err(|e| e.to_string())?,
        })),
    }
}

/// 粗略识别 Windows 7（6.1.x）。仅用于界面提示，不参与安全判断。
/// 结果缓存，避免每次进入页面都启动 `cmd /C ver`。
fn windows_is_legacy() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            use std::process::Command;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut command = Command::new("cmd");
            command.args(["/C", "ver"]);
            command.creation_flags(CREATE_NO_WINDOW);
            if let Ok(output) = command.output() {
                let text = String::from_utf8_lossy(&output.stdout);
                return text.contains("6.1.");
            }
            false
        }
        #[cfg(not(target_os = "windows"))]
        {
            false
        }
    })
}

/// 根据素材标题/摘要，AI 推断 PPT 标题与汇报对象。
#[tauri::command]
pub async fn ppt_extension_suggest_meta(
    state: State<'_, AppState>,
    sources: Vec<PptMetaSource>,
    model_id: Option<i64>,
) -> Result<PptMetaSuggestion, String> {
    PptExtensionService::suggest_meta(&state.db, &sources, model_id)
        .await
        .map_err(Into::into)
}

/// 读取本地 PDF / Word / Markdown 等文件，返回可加入素材源的纯文本。
#[tauri::command(async)]
pub fn ppt_extension_extract_local_file(
    path: String,
) -> Result<PptLocalFileSource, String> {
    PptExtensionService::extract_local_file(&path).map_err(Into::into)
}

#[tauri::command]
pub async fn ppt_extension_create_job(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PptJobInput,
) -> Result<PptJob, String> {
    let db = state.db.clone();
    let data_dir = state.data_dir.clone();
    let planning_id = input
        .planning_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = state.ppt_plan_cancel.lock() {
        map.insert(planning_id.clone(), cancel.clone());
    }
    let result = PptExtensionService::create_job(
        &db,
        &data_dir,
        input,
        Some(app),
        cancel,
        Duration::from_secs(420),
    )
    .await;
    if let Ok(mut map) = state.ppt_plan_cancel.lock() {
        map.remove(&planning_id);
    }
    result.map_err(Into::into)
}

/// 取消正在进行的大纲规划。
#[tauri::command]
pub fn ppt_extension_cancel_planning(
    state: State<'_, AppState>,
    planning_id: String,
) -> Result<(), String> {
    let map = state.ppt_plan_cancel.lock().map_err(|e| e.to_string())?;
    let flag = map
        .get(&planning_id)
        .ok_or_else(|| "大纲规划不在进行中".to_string())?;
    flag.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// 读取作业大纲（用于渲染前预览/编辑）。
#[tauri::command]
pub fn ppt_extension_get_plan(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<PptPlan, String> {
    PptExtensionService::get_plan(&state.db, &job_id).map_err(Into::into)
}

/// 更新作业大纲。返回规范化后的结果。
#[tauri::command]
pub fn ppt_extension_update_plan(
    state: State<'_, AppState>,
    job_id: String,
    plan: Value,
) -> Result<PptPlan, String> {
    PptExtensionService::update_plan(&state.db, &job_id, plan).map_err(Into::into)
}

/// 校验并规范化前端大纲，不写盘。
#[tauri::command]
pub fn ppt_extension_validate_plan(plan: Value) -> Result<PptPlan, String> {
    Ok(PptExtensionService::validate_plan(plan))
}

/// 复用现有素材与设置重新生成大纲；可指定页数与 AI 模型。
#[tauri::command]
pub async fn ppt_extension_regenerate_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    slide_count: Option<usize>,
    model_id: Option<i64>,
    planning_id: Option<String>,
) -> Result<PptPlan, String> {
    let planning_id = planning_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = state.ppt_plan_cancel.lock() {
        map.insert(planning_id.clone(), cancel.clone());
    }
    let result = PptExtensionService::regenerate_plan(
        &state.db,
        &job_id,
        slide_count,
        model_id,
        cancel,
        Some(app),
    )
    .await;
    if let Ok(mut map) = state.ppt_plan_cancel.lock() {
        map.remove(&planning_id);
    }
    result.map_err(Into::into)
}

/// 更新作业的版式/图表/导出选项，供“用当前大纲重新渲染”使用。
#[tauri::command]
pub fn ppt_extension_update_job_options(
    state: State<'_, AppState>,
    job_id: String,
    layout_id: Option<String>,
    chart_ids: Vec<String>,
    native_charts: bool,
    timeout_secs: Option<u64>,
) -> Result<PptJob, String> {
    PptExtensionService::update_job_options(
        &state.db,
        &job_id,
        layout_id,
        chart_ids,
        native_charts,
        timeout_secs,
    )
    .map_err(Into::into)
}

/// 复用原作业的素材与大纲创建新作业。
#[tauri::command]
pub fn ppt_extension_retry_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<PptJob, String> {
    PptExtensionService::retry_job(&state.db, &state.data_dir, &job_id).map_err(Into::into)
}

/// 删除单个作业及其工作目录。
#[tauri::command]
pub fn ppt_extension_delete_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<bool, String> {
    PptExtensionService::delete_job(&state.db, &job_id).map_err(Into::into)
}

/// 导出诊断 zip（job.json / plan.json / manifest / logs）。
#[tauri::command]
pub fn ppt_extension_export_diagnostics(
    state: State<'_, AppState>,
    job_id: String,
    target_dir: String,
) -> Result<String, String> {
    PptExtensionService::export_diagnostics(&state.db, &job_id, &target_dir).map_err(Into::into)
}

#[tauri::command]
pub fn ppt_extension_start_job(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    export_dir: Option<String>,
) -> Result<(), String> {
    PptExtensionService::start_job(
        app,
        state.db.clone(),
        state.ppt_job_cancel.clone(),
        job_id,
        export_dir,
    )
    .map_err(Into::into)
}

/// 生成草稿：只渲染 `project/svg_output/*.svg`，不导出 PPTX。
#[tauri::command]
pub fn ppt_extension_render_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    plan: Option<Value>,
    layout_id: Option<String>,
    chart_ids: Option<Vec<String>>,
    native_charts: Option<bool>,
) -> Result<(), String> {
    PptExtensionService::render_draft(
        app,
        state.db.clone(),
        state.ppt_job_cancel.clone(),
        job_id,
        plan,
        layout_id,
        chart_ids,
        native_charts,
    )
    .map_err(Into::into)
}

/// 逐页 AI 生成草稿；失败页自动回退模板渲染。
#[tauri::command]
pub async fn ppt_extension_render_ai_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    candidate_count: Option<usize>,
    mode: Option<String>,
) -> Result<(), String> {
    PptExtensionService::render_ai_draft(
        app,
        state.db.clone(),
        state.ppt_job_cancel.clone(),
        job_id,
        candidate_count.unwrap_or(3).clamp(1, 3),
        crate::services::ppt_extension::DraftGenerationMode::parse(mode.as_deref()),
    )
    .await
    .map_err(Into::into)
}

/// 单页重新生成 AI 草稿。
#[tauri::command]
pub async fn ppt_extension_regenerate_ai_page(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    page: u32,
    candidate_count: Option<usize>,
    model_id: Option<i64>,
) -> Result<(), String> {
    PptExtensionService::regenerate_ai_page(
        app,
        state.db.clone(),
        state.ppt_job_cancel.clone(),
        job_id,
        page,
        candidate_count.unwrap_or(3).clamp(1, 3),
        model_id,
    )
    .await
    .map_err(Into::into)
}

/// 读取作业渲染选项（生成方式、原生图表等）。
#[tauri::command]
pub fn ppt_extension_job_options(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Value, String> {
    PptExtensionService::job_options(&state.db, &job_id).map_err(Into::into)
}

/// 返回作业固化素材 source.md 的绝对路径。
#[tauri::command]
pub fn ppt_extension_source_file(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<String, String> {
    PptExtensionService::source_file(&state.db, &job_id).map_err(Into::into)
}

/// 读取逐页候选与评分。
#[tauri::command]
pub fn ppt_extension_page_selection(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Value, String> {
    PptExtensionService::page_selection(&state.db, &job_id).map_err(Into::into)
}

/// 读取程序化渲染的候选 SVG。
#[tauri::command]
pub fn ppt_extension_page_candidates(
    state: State<'_, AppState>,
    job_id: String,
    page: u32,
) -> Result<Value, String> {
    PptExtensionService::page_candidates(&state.db, &job_id, page).map_err(Into::into)
}

/// 手动选择一个结构候选。
#[tauri::command]
pub fn ppt_extension_select_page_candidate(
    state: State<'_, AppState>,
    job_id: String,
    page: u32,
    index: usize,
) -> Result<(), String> {
    PptExtensionService::select_page_candidate(&state.db, &job_id, page, index)
        .map_err(Into::into)
}

/// 修改大纲后重新生成草稿。
#[tauri::command]
pub fn ppt_extension_rerender_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    plan: Option<Value>,
    layout_id: Option<String>,
    chart_ids: Option<Vec<String>>,
    native_charts: Option<bool>,
) -> Result<(), String> {
    PptExtensionService::render_draft(
        app,
        state.db.clone(),
        state.ppt_job_cancel.clone(),
        job_id,
        plan,
        layout_id,
        chart_ids,
        native_charts,
    )
    .map_err(Into::into)
}

/// 确认草稿后执行最终导出。
#[tauri::command]
pub fn ppt_extension_export_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    export_dir: Option<String>,
) -> Result<(), String> {
    PptExtensionService::export_draft(
        app,
        state.db.clone(),
        state.ppt_job_cancel.clone(),
        job_id,
        export_dir,
    )
    .map_err(Into::into)
}

/// 列出草稿页（project/svg_output）。
#[tauri::command]
pub fn ppt_extension_list_draft_pages(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Vec<PptDraftPage>, String> {
    PptExtensionService::list_draft_pages(&state.db, &job_id).map_err(Into::into)
}

/// 读取单页草稿 SVG。
#[tauri::command]
pub fn ppt_extension_read_draft_page(
    state: State<'_, AppState>,
    job_id: String,
    file: String,
) -> Result<String, String> {
    PptExtensionService::read_draft_page(&state.db, &job_id, &file).map_err(Into::into)
}

#[tauri::command]
pub fn ppt_extension_cancel_job(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    PptExtensionService::cancel_job(&state.db, &state.ppt_job_cancel, Some(&app), &job_id)
        .map_err(Into::into)
}

#[tauri::command]
pub fn ppt_extension_get_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Option<PptJob>, String> {
    state
        .db
        .get_ppt_job(&job_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ppt_extension_list_jobs(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<PptJob>, String> {
    // 顺手回收崩溃/强杀后残留的 running 作业，避免一直显示"生成中"。
    let _ = PptExtensionService::recover_stale_jobs(&state.db);
    state
        .db
        .list_ppt_jobs(limit.unwrap_or(30).clamp(1, 200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ppt_extension_cleanup_jobs(
    state: State<'_, AppState>,
    keep_latest: Option<usize>,
) -> Result<usize, String> {
    PptExtensionService::cleanup_jobs(&state.db, keep_latest.unwrap_or(10))
        .map_err(Into::into)
}
