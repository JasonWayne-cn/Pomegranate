//! 插件运行时 Command：令牌生命周期

use crate::state::AppState;
use tauri::State;

/// 申领插件令牌
///
/// 校验：
/// 1. plugin_id 在 plugins 表存在
/// 2. status = "installed"
/// 3. enabled = true
#[tauri::command]
pub fn plugin_acquire_token(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<String, String> {
    let plugin = state
        .db
        .get_plugin(&plugin_id)
        .map_err(|e| e.to_string())?
        ;

    if plugin.status != "installed" {
        return Err(format!("插件 {} 状态非 installed", plugin_id));
    }
    if !plugin.enabled {
        return Err(format!("插件 {} 已禁用", plugin_id));
    }

    state.plugin_tokens.acquire(&plugin_id)
}

/// 作废插件令牌
#[tauri::command]
pub fn plugin_revoke_token(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<(), String> {
    state.plugin_tokens.revoke(&plugin_id)
}
