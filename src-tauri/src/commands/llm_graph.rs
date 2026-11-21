//! LLM 文档图谱的 IPC 入口（P1）。

use std::time::Instant;

use tauri::{AppHandle, State};

use crate::models::{
    LlmEntityNote, LlmExtractBatchItem, LlmExtractResult, LlmExtractionStatus, LlmGraphData,
    LlmGraphScopeStatus,
};
use crate::services::llm_graph;
use crate::state::AppState;

/// 抽取单篇文档的实体/关系，结果写入本地数据库。
#[tauri::command]
pub async fn extract_note_llm_graph(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<LlmExtractResult, String> {
    let progress = llm_graph::ExtractProgress {
        app: Some(&app),
        scope: "note",
        note_index: 1,
        note_total: 1,
        start: Instant::now(),
    };
    llm_graph::extract_note(state.db.as_ref(), note_id, &progress)
        .await
        .map_err(|e| e.to_string())
}

/// 批量抽取：默认取作用域内最近更新的 20 篇，顺序执行。
#[tauri::command]
pub async fn extract_folder_llm_graph(
    app: AppHandle,
    state: State<'_, AppState>,
    folder_id: Option<i64>,
    limit: Option<u32>,
) -> Result<Vec<LlmExtractBatchItem>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 200) as usize;
    let ids = state
        .db
        .list_llm_graph_note_ids(folder_id, limit)
        .map_err(|e| e.to_string())?;
    Ok(llm_graph::extract_notes(state.db.as_ref(), &ids, Some(&app)).await)
}

/// 读取聚合后的 LLM 图谱（按规范化实体名跨文档合并）。
#[tauri::command]
pub fn get_llm_graph_data(
    state: State<'_, AppState>,
    folder_id: Option<i64>,
    note_id: Option<i64>,
    max_nodes: Option<u32>,
) -> Result<LlmGraphData, String> {
    let max_nodes = max_nodes.unwrap_or(2000).clamp(1, 5000) as usize;
    state
        .db
        .get_llm_graph_data(folder_id, note_id, max_nodes)
        .map_err(|e| e.to_string())
}

/// 查询包含指定实体的文档（“相关文档”列表）。
#[tauri::command]
pub fn get_llm_entity_notes(
    state: State<'_, AppState>,
    name: String,
    limit: Option<u32>,
) -> Result<Vec<LlmEntityNote>, String> {
    let norm = llm_graph::normalize_entity_name(&name);
    state
        .db
        .list_llm_entity_notes(&norm, limit.unwrap_or(20).clamp(1, 100) as usize)
        .map_err(|e| e.to_string())
}

/// 查询作用域（文件夹子树 / 全库）的建图状态：
/// 全建图 / 部分建图 / 未建图 / 有更新。
#[tauri::command]
pub fn get_llm_graph_scope_status(
    state: State<'_, AppState>,
    folder_id: Option<i64>,
) -> Result<LlmGraphScopeStatus, String> {
    llm_graph::scope_status(state.db.as_ref(), folder_id).map_err(|e| e.to_string())
}

/// 查询单篇文档的抽取状态。
#[tauri::command]
pub fn get_llm_extraction_status(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<Option<LlmExtractionStatus>, String> {
    state
        .db
        .get_llm_extraction_status(note_id)
        .map_err(|e| e.to_string())
}

/// 删除单篇文档的 LLM 图谱数据。
#[tauri::command]
pub fn delete_note_llm_graph(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<(), String> {
    state
        .db
        .delete_llm_graph(note_id)
        .map_err(|e| e.to_string())
}
