use std::collections::HashMap;

use crate::models::AppConfig;
use crate::services::config::ConfigService;
use crate::state::AppState;

/// 获取所有配置
#[tauri::command]
pub fn get_all_config(state: tauri::State<'_, AppState>) -> Result<Vec<AppConfig>, String> {
    ConfigService::get_all(&state.db).map_err(|e| e.to_string())
}

/// 获取单个配置
#[tauri::command]
pub fn get_config(state: tauri::State<'_, AppState>, key: String) -> Result<String, String> {
    ConfigService::get(&state.db, &key).map_err(|e| e.to_string())
}

/// 批量获取配置
#[tauri::command]
pub fn get_configs(
    state: tauri::State<'_, AppState>,
    keys: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    ConfigService::get_many(&state.db, &keys).map_err(|e| e.to_string())
}

/// 设置配置
#[tauri::command]
pub fn set_config(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    ConfigService::set(&state.db, &key, &value).map_err(|e| e.to_string())
}

/// 批量写入配置（事务）
#[tauri::command]
pub fn set_configs(
    state: tauri::State<'_, AppState>,
    entries: Vec<AppConfig>,
) -> Result<(), String> {
    ConfigService::set_many(&state.db, &entries).map_err(|e| e.to_string())
}

/// 删除配置
#[tauri::command]
pub fn delete_config(state: tauri::State<'_, AppState>, key: String) -> Result<(), String> {
    ConfigService::delete(&state.db, &key).map_err(|e| e.to_string())
}
