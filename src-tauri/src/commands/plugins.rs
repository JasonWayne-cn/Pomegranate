//! 插件系统 Commands
//!
//! 薄 IPC 包装：接收参数 → 调用 PluginService → 转换错误。

use std::collections::HashMap;

use tauri::State;

use crate::models::{
    PluginActivationState, PluginInfo, PluginInspection, PluginManifest, PluginQuarantineEntry,
    PluginVersionEntry,
};
use crate::services::plugins::PluginService;
use crate::state::AppState;

/// 列出已安装插件
#[tauri::command]
pub fn list_plugins(state: State<'_, AppState>) -> Result<Vec<PluginInfo>, String> {
    PluginService::list(&state.db).map_err(|e| e.to_string())
}

/// 扫描应用数据目录下的 plugins 文件夹，并同步 manifest 到数据库
#[tauri::command]
pub fn scan_plugins(state: State<'_, AppState>) -> Result<Vec<PluginInfo>, String> {
    PluginService::scan(&state.db, &state.data_dir).map_err(|e| e.to_string())
}

/// 从本地目录安装插件
#[tauri::command]
pub fn install_plugin_from_dir(
    state: State<'_, AppState>,
    path: String,
) -> Result<PluginInfo, String> {
    PluginService::install_from_dir(&state.db, &state.data_dir, &path).map_err(|e| e.to_string())
}

/// 预检插件 zip（安装前展示清单、文件数与解压体积）
#[tauri::command]
pub fn inspect_plugin_zip(
    state: State<'_, AppState>,
    path: String,
) -> Result<PluginInspection, String> {
    PluginService::inspect_zip(&state.data_dir, &path).map_err(|e| e.to_string())
}

/// 从本地 zip 压缩包安装插件
#[tauri::command]
pub fn install_plugin_from_zip(
    state: State<'_, AppState>,
    path: String,
) -> Result<PluginInfo, String> {
    PluginService::install_from_zip(&state.db, &state.data_dir, &path).map_err(|e| e.to_string())
}

/// 启用插件（递增运行代际并失效旧会话）
#[tauri::command]
pub fn enable_plugin(state: State<'_, AppState>, plugin_id: String) -> Result<(), String> {
    PluginService::enable(&state.db, &state.plugin_tokens, &plugin_id).map_err(|e| e.to_string())
}

/// 禁用插件（先关门再失效会话）
#[tauri::command]
pub fn disable_plugin(state: State<'_, AppState>, plugin_id: String) -> Result<(), String> {
    PluginService::disable(&state.db, &state.plugin_tokens, &plugin_id).map_err(|e| e.to_string())
}

/// 卸载插件（目录移入隔离区，可恢复）
#[tauri::command]
pub fn uninstall_plugin(state: State<'_, AppState>, plugin_id: String) -> Result<bool, String> {
    PluginService::uninstall(&state.db, &state.data_dir, &state.plugin_tokens, &plugin_id)
        .map_err(|e| e.to_string())
}

/// 列出插件版本（当前 + 已归档）
#[tauri::command]
pub fn list_plugin_versions(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<Vec<PluginVersionEntry>, String> {
    PluginService::list_versions(&state.db, &state.data_dir, &plugin_id)
        .map_err(|e| e.to_string())
}

/// 回滚到已归档版本（要求插件已禁用）
#[tauri::command]
pub fn rollback_plugin(
    state: State<'_, AppState>,
    plugin_id: String,
    target_version: String,
) -> Result<PluginInfo, String> {
    PluginService::rollback(&state.db, &state.data_dir, &plugin_id, &target_version)
        .map_err(|e| e.to_string())
}

/// 从隔离区恢复插件
#[tauri::command]
pub fn restore_quarantined_plugin(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<PluginInfo, String> {
    PluginService::restore_quarantined(&state.db, &state.data_dir, &plugin_id)
        .map_err(|e| e.to_string())
}

/// 列出卸载隔离区条目
#[tauri::command]
pub fn list_plugin_quarantine(
    state: State<'_, AppState>,
) -> Result<Vec<PluginQuarantineEntry>, String> {
    PluginService::list_quarantined(&state.db).map_err(|e| e.to_string())
}

/// 查询插件运行状态（代际 / 活跃会话）
#[tauri::command]
pub fn get_plugin_activation_state(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<PluginActivationState, String> {
    PluginService::activation_state(&state.db, &state.plugin_tokens, &plugin_id)
        .map_err(|e| e.to_string())
}

/// 获取插件 manifest
#[tauri::command]
pub fn get_plugin_manifest(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<PluginManifest, String> {
    PluginService::get_manifest(&state.db, &plugin_id).map_err(|e| e.to_string())
}

/// 授权插件权限
#[tauri::command]
pub fn grant_plugin_permissions(
    state: State<'_, AppState>,
    plugin_id: String,
    permissions: Vec<String>,
) -> Result<usize, String> {
    PluginService::grant_permissions(&state.db, &plugin_id, permissions).map_err(|e| e.to_string())
}

/// 撤销插件权限
#[tauri::command]
pub fn revoke_plugin_permissions(
    state: State<'_, AppState>,
    plugin_id: String,
    permissions: Vec<String>,
) -> Result<usize, String> {
    PluginService::revoke_permissions(&state.db, &plugin_id, permissions).map_err(|e| e.to_string())
}

/// 获取插件设置
#[tauri::command]
pub fn get_plugin_settings(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<HashMap<String, serde_json::Value>, String> {
    PluginService::get_settings(&state.db, &plugin_id).map_err(|e| e.to_string())
}

/// 全量保存插件设置
#[tauri::command]
pub fn set_plugin_settings(
    state: State<'_, AppState>,
    plugin_id: String,
    settings: serde_json::Value,
) -> Result<(), String> {
    PluginService::set_settings(&state.db, &plugin_id, settings).map_err(|e| e.to_string())
}

/// 读取插件目录内的文本资源
#[tauri::command]
pub fn read_plugin_asset(
    state: State<'_, AppState>,
    plugin_id: String,
    relative_path: String,
) -> Result<String, String> {
    PluginService::read_asset(&state.db, &state.data_dir, &plugin_id, &relative_path)
        .map_err(|e| e.to_string())
}
