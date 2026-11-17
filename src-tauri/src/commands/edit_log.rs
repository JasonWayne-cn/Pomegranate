//! Office 编辑操作日志命令。

use tauri::State;

use crate::database::edit_ops::EditOp;
use crate::services::edit_log::EditLogService;
use crate::state::AppState;

#[tauri::command]
pub fn edit_log_record(
    state: State<'_, AppState>,
    domain: String,
    target: String,
    source: String,
    op_json: String,
) -> Result<i64, String> {
    EditLogService::record(&state.db, &domain, &target, &source, &op_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn edit_log_list(
    state: State<'_, AppState>,
    target: String,
    limit: Option<usize>,
) -> Result<Vec<EditOp>, String> {
    EditLogService::list(&state.db, &target, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn edit_log_clear(state: State<'_, AppState>, target: String) -> Result<usize, String> {
    EditLogService::clear(&state.db, &target).map_err(|e| e.to_string())
}
