//! 助研模块 Commands（IPC 入口）

use tauri::State;

use crate::models::research::{
    ResearchAiRequest, ResearchAiResponse, ResearchLiterature, ResearchLiteratureInput,
    ResearchOutput, ResearchOutputInput, ResearchProject, ResearchProjectInput,
};
use crate::models::Note;
use crate::services::research::ResearchService;
use crate::state::AppState;

// ─── 课题 ───────────────────────────────────────

#[tauri::command]
pub fn research_list_projects(state: State<'_, AppState>) -> Result<Vec<ResearchProject>, String> {
    ResearchService::list_projects(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_create_project(
    state: State<'_, AppState>,
    input: ResearchProjectInput,
) -> Result<ResearchProject, String> {
    ResearchService::create_project(&state.db, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_update_project(
    state: State<'_, AppState>,
    id: i64,
    input: ResearchProjectInput,
) -> Result<ResearchProject, String> {
    ResearchService::update_project(&state.db, id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_delete_project(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    ResearchService::delete_project(&state.db, id).map_err(|e| e.to_string())
}

// ─── 文献 ───────────────────────────────────────

#[tauri::command]
pub fn research_list_literature(
    state: State<'_, AppState>,
    project_id: i64,
) -> Result<Vec<ResearchLiterature>, String> {
    ResearchService::list_literature(&state.db, project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_create_literature(
    state: State<'_, AppState>,
    project_id: i64,
    input: ResearchLiteratureInput,
) -> Result<ResearchLiterature, String> {
    ResearchService::create_literature(&state.db, project_id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_update_literature(
    state: State<'_, AppState>,
    id: i64,
    input: ResearchLiteratureInput,
) -> Result<ResearchLiterature, String> {
    ResearchService::update_literature(&state.db, id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_delete_literature(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    ResearchService::delete_literature(&state.db, id).map_err(|e| e.to_string())
}

// ─── 产出 ───────────────────────────────────────

#[tauri::command]
pub fn research_list_outputs(
    state: State<'_, AppState>,
    project_id: i64,
) -> Result<Vec<ResearchOutput>, String> {
    ResearchService::list_outputs(&state.db, project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_create_output(
    state: State<'_, AppState>,
    project_id: i64,
    input: ResearchOutputInput,
) -> Result<ResearchOutput, String> {
    ResearchService::create_output(&state.db, project_id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_update_output(
    state: State<'_, AppState>,
    id: i64,
    title: String,
    content: String,
) -> Result<ResearchOutput, String> {
    ResearchService::update_output(&state.db, id, &title, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_delete_output(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    ResearchService::delete_output(&state.db, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn research_export_output_to_note(
    state: State<'_, AppState>,
    output_id: i64,
    folder_id: Option<i64>,
) -> Result<Note, String> {
    ResearchService::export_output_to_note(&state.db, output_id, folder_id)
        .map_err(|e| e.to_string())
}

// ─── AI 生成 ────────────────────────────────────

#[tauri::command]
pub async fn research_ai_generate(
    state: State<'_, AppState>,
    request: ResearchAiRequest,
) -> Result<ResearchAiResponse, String> {
    let db = state.db.clone();
    ResearchService::ai_generate(&db, request)
        .await
        .map_err(|e| e.to_string())
}
