use serde_json::Value;
use tauri::State;

use crate::models::extension::{ExtensionInfo, ExtensionInspection, ExtensionVersionInfo};
use crate::services::extension::ExtensionService;
use crate::state::AppState;

#[tauri::command]
pub fn extension_list(state: State<'_, AppState>) -> Result<Vec<ExtensionInfo>, String> {
    ExtensionService::list(&state.db).map_err(Into::into)
}

#[tauri::command]
pub fn extension_inspect_zip(
    state: State<'_, AppState>,
    path: String,
) -> Result<ExtensionInspection, String> {
    ExtensionService::inspect_zip(&state.data_dir, &path).map_err(Into::into)
}

#[tauri::command]
pub fn extension_install_zip(
    state: State<'_, AppState>,
    path: String,
) -> Result<ExtensionInfo, String> {
    ExtensionService::install_zip(&state.db, &state.data_dir, &path).map_err(Into::into)
}

#[tauri::command]
pub fn extension_enable(state: State<'_, AppState>, id: String) -> Result<(), String> {
    ExtensionService::set_enabled(&state.db, &id, true).map_err(Into::into)
}

#[tauri::command]
pub fn extension_disable(state: State<'_, AppState>, id: String) -> Result<(), String> {
    ExtensionService::set_enabled(&state.db, &id, false).map_err(Into::into)
}

#[tauri::command]
pub fn extension_uninstall(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    ExtensionService::uninstall(&state.db, &state.data_dir, &id).map_err(Into::into)
}

#[tauri::command]
pub fn extension_verify(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    ExtensionService::verify(&state.db, &id).map_err(Into::into)
}

#[tauri::command]
pub fn extension_read_text_asset(
    state: State<'_, AppState>,
    id: String,
    relative_path: String,
) -> Result<String, String> {
    ExtensionService::read_text_asset(&state.db, &id, &relative_path).map_err(Into::into)
}

#[tauri::command]
pub fn extension_ppt_catalog(
    state: State<'_, AppState>,
    id: String,
) -> Result<Value, String> {
    ExtensionService::ppt_catalog(&state.db, &id).map_err(Into::into)
}

#[tauri::command]
pub fn extension_ppt_layout_preview(
    state: State<'_, AppState>,
    id: String,
    layout_id: String,
) -> Result<String, String> {
    ExtensionService::ppt_layout_preview(&state.db, &id, &layout_id).map_err(Into::into)
}

#[tauri::command]
pub fn extension_list_versions(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<ExtensionVersionInfo>, String> {
    ExtensionService::list_versions(&state.db, &id).map_err(Into::into)
}

#[tauri::command]
pub fn extension_rollback(
    state: State<'_, AppState>,
    id: String,
    version: String,
) -> Result<ExtensionInfo, String> {
    ExtensionService::rollback(&state.db, &state.data_dir, &id, &version).map_err(Into::into)
}
