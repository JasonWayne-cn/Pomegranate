use std::sync::atomic::{AtomicBool, Ordering};
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
    let pause = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = state.ppt_plan_cancel.lock() {
        map.insert(planning_id.clone(), cancel.clone());
    }
    if let Ok(mut map) = state.ppt_plan_pause.lock() {
        map.insert(planning_id.clone(), pause.clone());
    }
    let result = PptExtensionService::create_job(
        &db,
        &data_dir,
        input,
        Some(app),
        cancel,
        pause,
        Duration::from_secs(420),
    )
    .await;
    if let Ok(mut map) = state.ppt_plan_cancel.lock() {
        map.remove(&planning_id);
    }
    if let Ok(mut map) = state.ppt_plan_pause.lock() {
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

/// 暂停大纲规划（在阶段/分块边界生效）。
#[tauri::command]
pub fn ppt_extension_pause_planning(
    state: State<'_, AppState>,
    planning_id: String,
) -> Result<(), String> {
    let mut map = state.ppt_plan_pause.lock().map_err(|e| e.to_string())?;
    let flag = map
        .entry(planning_id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)));
    flag.store(true, Ordering::SeqCst);
    Ok(())
}

/// 继续已暂停的大纲规划。
#[tauri::command]
pub fn ppt_extension_resume_planning(
    state: State<'_, AppState>,
    planning_id: String,
) -> Result<(), String> {
    let mut map = state.ppt_plan_pause.lock().map_err(|e| e.to_string())?;
    let flag = map
        .entry(planning_id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)));
    flag.store(false, Ordering::SeqCst);
    Ok(())
}

/// 查询大纲规划是否处于暂停状态（重新进入页面时恢复按钮）。
#[tauri::command]
pub fn ppt_extension_planning_paused(
    state: State<'_, AppState>,
    planning_id: String,
) -> Result<bool, String> {
    let map = state.ppt_plan_pause.lock().map_err(|e| e.to_string())?;
    Ok(map
        .get(&planning_id)
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false))
}

/// 读取历史作业的素材清单（打开历史作业时恢复素材来源）。
#[tauri::command]
pub fn ppt_extension_job_sources(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Vec<crate::models::extension::PptSourceMeta>, String> {
    PptExtensionService::job_sources(&state.db, &job_id).map_err(Into::into)
}

/// 移除历史作业的一项素材，并同步 source.md 与素材清单。
#[tauri::command]
pub fn ppt_extension_remove_job_source(
    state: State<'_, AppState>,
    job_id: String,
    source_id: i64,
    path: Option<String>,
) -> Result<Vec<crate::models::extension::PptSourceMeta>, String> {
    PptExtensionService::remove_job_source(&state.db, &job_id, source_id, path)
        .map_err(Into::into)
}

/// 读取素材理解（understanding.md）。
#[tauri::command]
pub fn ppt_extension_read_understanding(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<String, String> {
    PptExtensionService::read_understanding(&state.db, &job_id).map_err(Into::into)
}

/// 返回素材理解文件路径。
#[tauri::command]
pub fn ppt_extension_understanding_file(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<String, String> {
    PptExtensionService::understanding_file(&state.db, &job_id).map_err(Into::into)
}

/// 读取已落盘的步骤日志（素材处理/理解/大纲/引擎）。
#[tauri::command]
pub fn ppt_extension_read_step_logs(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Value, String> {
    PptExtensionService::read_step_logs(&state.db, &job_id).map_err(Into::into)
}

/// 返回补充素材文件路径（不存在时为空）。
#[tauri::command]
pub fn ppt_extension_manual_source_file(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Option<String>, String> {
    PptExtensionService::manual_source_file(&state.db, &job_id).map_err(Into::into)
}

/// 返回单条素材对应的源文件路径。
#[tauri::command]
pub fn ppt_extension_source_item_file(
    state: State<'_, AppState>,
    job_id: String,
    source_id: i64,
    path: Option<String>,
) -> Result<String, String> {
    PptExtensionService::source_item_file(&state.db, &job_id, source_id, path)
        .map_err(Into::into)
}

/// 删除补充素材 manual.md。
#[tauri::command]
pub fn ppt_extension_delete_manual_source(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    PptExtensionService::delete_manual_source(&state.db, &job_id).map_err(Into::into)
}

/// 生成或重新生成素材理解。
#[tauri::command]
pub async fn ppt_extension_build_understanding(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    model_id: Option<i64>,
    force: Option<bool>,
) -> Result<String, String> {
    PptExtensionService::build_understanding(
        &state.db,
        &job_id,
        model_id,
        force.unwrap_or(false),
        Some(app),
    )
    .await
    .map_err(Into::into)
}

/// 向历史作业追加素材。
#[tauri::command]
pub fn ppt_extension_append_job_sources(
    state: State<'_, AppState>,
    job_id: String,
    note_ids: Vec<i64>,
    local_files: Vec<crate::models::extension::PptLocalFileInput>,
    manual_text: Option<String>,
) -> Result<Vec<crate::models::extension::PptSourceMeta>, String> {
    PptExtensionService::append_job_sources(
        &state.db,
        &job_id,
        note_ids,
        local_files,
        manual_text.unwrap_or_default(),
    )
    .map_err(Into::into)
}

/// 仅更新单页大纲（不清空已有草稿）。
#[tauri::command]
pub fn ppt_extension_patch_plan_slide(
    state: State<'_, AppState>,
    job_id: String,
    slide: Value,
) -> Result<(), String> {
    PptExtensionService::patch_plan_slide(&state.db, &job_id, slide).map_err(Into::into)
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
    let pause = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = state.ppt_plan_cancel.lock() {
        map.insert(planning_id.clone(), cancel.clone());
    }
    if let Ok(mut map) = state.ppt_plan_pause.lock() {
        map.insert(planning_id.clone(), pause.clone());
    }
    let result = PptExtensionService::regenerate_plan(
        &state.db,
        &job_id,
        slide_count,
        model_id,
        cancel,
        pause,
        Some(app),
    )
    .await;
    if let Ok(mut map) = state.ppt_plan_cancel.lock() {
        map.remove(&planning_id);
    }
    if let Ok(mut map) = state.ppt_plan_pause.lock() {
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
    model_id: Option<i64>,
) -> Result<PptJob, String> {
    PptExtensionService::update_job_options(
        &state.db,
        &job_id,
        layout_id,
        chart_ids,
        native_charts,
        timeout_secs,
        model_id,
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

/// 生成草稿：只渲染 SVG，不导出 PPTX。kind=preview 写 svg_preview，formal 写 svg_output。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ppt_extension_render_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    plan: Option<Value>,
    layout_id: Option<String>,
    chart_ids: Option<Vec<String>>,
    native_charts: Option<bool>,
    kind: Option<String>,
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
        crate::services::ppt_extension::PptDraftKind::parse(kind.as_deref()),
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
        state.ppt_job_pause.clone(),
        job_id,
        candidate_count.unwrap_or(3).clamp(1, 3),
        crate::services::ppt_extension::DraftGenerationMode::parse(mode.as_deref()),
    )
    .await
    .map_err(Into::into)
}

/// 暂停 AI 草稿生成（在页块边界生效；已完成的页保持不变）。
#[tauri::command]
pub fn ppt_extension_pause_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    let mut map = state.ppt_job_pause.lock().map_err(|e| e.to_string())?;
    let flag = map
        .entry(job_id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)));
    flag.store(true, Ordering::SeqCst);
    Ok(())
}

/// 重新进入页面时恢复作业：若 running 但本进程已无生成循环，标记为中断失败。
#[tauri::command]
pub fn ppt_extension_recover_job(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Option<PptJob>, String> {
    PptExtensionService::recover_inactive_job(
        &state.db,
        &state.ppt_job_cancel,
        &app,
        &job_id,
    )
    .map_err(Into::into)
}

/// 查询作业当前是否处于暂停状态（重新进入页面时恢复按钮状态用）。
#[tauri::command]
pub fn ppt_extension_job_paused(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<bool, String> {
    let map = state.ppt_job_pause.lock().map_err(|e| e.to_string())?;
    Ok(map
        .get(&job_id)
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false))
}

/// 继续已暂停的 AI 草稿生成。
#[tauri::command]
pub fn ppt_extension_resume_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    let mut map = state.ppt_job_pause.lock().map_err(|e| e.to_string())?;
    // 保留同一条 flag：再次暂停要作用在渲染循环持有的那个 Arc 上
    let flag = map
        .entry(job_id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)));
    flag.store(false, Ordering::SeqCst);
    Ok(())
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
    instruction: Option<String>,
) -> Result<(), String> {
    PptExtensionService::regenerate_ai_page(
        app,
        state.db.clone(),
        state.ppt_job_cancel.clone(),
        job_id,
        page,
        candidate_count.unwrap_or(3).clamp(1, 3),
        model_id,
        instruction,
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
#[allow(clippy::too_many_arguments)]
pub fn ppt_extension_rerender_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    plan: Option<Value>,
    layout_id: Option<String>,
    chart_ids: Option<Vec<String>>,
    native_charts: Option<bool>,
    kind: Option<String>,
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
        crate::services::ppt_extension::PptDraftKind::parse(kind.as_deref()),
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

/// 读取草稿页级指纹状态（fresh/order_stale/partial/stale/missing）。
#[tauri::command]
pub fn ppt_extension_draft_status(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<crate::services::ppt_draft_manifest::DraftStatus, String> {
    PptExtensionService::draft_status(&state.db, &job_id).map_err(Into::into)
}

/// 列出草稿页（preview→svg_preview，formal→svg_output）。
#[tauri::command]
pub fn ppt_extension_list_draft_pages(
    state: State<'_, AppState>,
    job_id: String,
    kind: Option<String>,
) -> Result<Vec<PptDraftPage>, String> {
    PptExtensionService::list_draft_pages(
        &state.db,
        &job_id,
        crate::services::ppt_extension::PptDraftKind::parse(kind.as_deref()),
    )
    .map_err(Into::into)
}

/// 读取单页草稿 SVG。
#[tauri::command]
pub fn ppt_extension_read_draft_page(
    state: State<'_, AppState>,
    job_id: String,
    file: String,
    kind: Option<String>,
) -> Result<String, String> {
    PptExtensionService::read_draft_page(
        &state.db,
        &job_id,
        &file,
        crate::services::ppt_extension::PptDraftKind::parse(kind.as_deref()),
    )
    .map_err(Into::into)
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
