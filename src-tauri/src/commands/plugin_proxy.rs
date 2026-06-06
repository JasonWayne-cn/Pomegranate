//! 插件 proxy Command —— 受控的 IPC 入口
//!
//! 安全模型：
//! 1. 所有调用必须带 token
//! 2. token 反查 plugin_id（无效 → 拒绝）
//! 3. 查询 plugin_permissions 表确认权限（缺失 → 拒绝）
//! 4. 通过 → 委托给对应 Service

use std::collections::HashMap;

use serde_json::Value;
use tauri::State;

use crate::error::AppError;
use crate::models::{Note, NoteInput, NoteQuery, PluginAuditLogEntry, SearchResult};
use crate::services::note::NoteService;
use crate::services::search::SearchService;
use crate::state::AppState;

/// 统一令牌+权限校验
///
/// 返回值：通过校验的 plugin_id
fn verify(
    state: &AppState,
    token: &str,
    required_permission: Option<&str>,
) -> Result<String, AppError> {
    // 1. 令牌反查
    let plugin_id = state
        .plugin_tokens
        .lookup(token)
        .map_err(AppError::Custom)?
        .ok_or(AppError::PluginPermissionDenied {
            plugin_id: None,
            required_permission: None,
        })?;

    // 2. 权限校验
    if let Some(perm) = required_permission {
        let granted = state
            .db
            .has_plugin_permission(&plugin_id, perm)
            .map_err(|e| AppError::Custom(e.to_string()))?;
        if !granted {
            return Err(AppError::PluginPermissionDenied {
                plugin_id: Some(plugin_id),
                required_permission: Some(perm.to_string()),
            });
        }
    }

    // 3. T25 审计日志（失败不阻业务）
    let _ = state.db.write_audit_log(
        &plugin_id,
        required_permission.unwrap_or("settings"),
        None,
    );

    Ok(plugin_id)
}

// ─── notes 域 6 个 Command ─────────────────────────────────

#[tauri::command]
pub fn plugin_proxy_notes_list(
    state: State<'_, AppState>,
    token: String,
    query: NoteQuery,
) -> Result<Vec<Note>, String> {
    verify(&state, &token, Some("notes:read")).map_err(|e| e.to_string())?;
    NoteService::list(&state.db, &query)
        .map(|page| page.items)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_proxy_notes_get(
    state: State<'_, AppState>,
    token: String,
    id: i64,
) -> Result<Note, String> {
    verify(&state, &token, Some("notes:read")).map_err(|e| e.to_string())?;
    NoteService::get(&state.db, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_proxy_notes_search(
    state: State<'_, AppState>,
    token: String,
    keyword: String,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    verify(&state, &token, Some("notes:read")).map_err(|e| e.to_string())?;
    SearchService::search(&state.db, &keyword, limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_proxy_notes_create(
    state: State<'_, AppState>,
    token: String,
    input: NoteInput,
) -> Result<Note, String> {
    verify(&state, &token, Some("notes:write")).map_err(|e| e.to_string())?;
    NoteService::create(&state.db, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_proxy_notes_update(
    state: State<'_, AppState>,
    token: String,
    id: i64,
    input: NoteInput,
) -> Result<Note, String> {
    verify(&state, &token, Some("notes:write")).map_err(|e| e.to_string())?;
    NoteService::update(&state.db, id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_proxy_notes_delete(
    state: State<'_, AppState>,
    token: String,
    id: i64,
) -> Result<(), String> {
    verify(&state, &token, Some("notes:write")).map_err(|e| e.to_string())?;
    NoteService::delete(&state.db, id).map_err(|e| e.to_string())
}

// ─── settings 域 3 个 Command ──────────────────────────────
//
// T23: 键名纵深防御 — 所有 key 自动加 plugin:<id>: 前缀。
// DB 层已有 plugin_id 列做隔离（主防线），前缀是第二道保险：
// 即使 token 校验被绕过，跨插件 key 碰撞也不会泄漏数据。

fn scoped_key(plugin_id: &str, key: &str) -> String {
    format!("plugin:{}:{}", plugin_id, key)
}

#[tauri::command]
pub fn plugin_proxy_settings_get(
    state: State<'_, AppState>,
    token: String,
    key: String,
) -> Result<Option<Value>, String> {
    let plugin_id = verify(&state, &token, None).map_err(|e| e.to_string())?;
    let scoped = scoped_key(&plugin_id, &key);
    state
        .db
        .get_plugin_setting(&plugin_id, &scoped)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_proxy_settings_set(
    state: State<'_, AppState>,
    token: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    let plugin_id = verify(&state, &token, None).map_err(|e| e.to_string())?;
    let scoped = scoped_key(&plugin_id, &key);
    state
        .db
        .set_plugin_setting(&plugin_id, &scoped, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_proxy_settings_get_all(
    state: State<'_, AppState>,
    token: String,
) -> Result<HashMap<String, Value>, String> {
    let plugin_id = verify(&state, &token, None).map_err(|e| e.to_string())?;
    let all = state
        .db
        .get_plugin_settings(&plugin_id)
        .map_err(|e| e.to_string())?;
    // 去掉前缀，插件视角 key 无感知
    let prefix = format!("plugin:{}:", plugin_id);
    Ok(all
        .into_iter()
        .filter_map(|(k, v)| k.strip_prefix(&prefix).map(|s| (s.to_string(), v)))
        .collect())
}

// ─── audit 域（T25：管理 UI 调用，不走 token 校验）────────

#[tauri::command]
pub fn plugin_audit_log_list(
    state: State<'_, AppState>,
    plugin_id: String,
    limit: Option<u32>,
) -> Result<Vec<PluginAuditLogEntry>, String> {
    let limit = limit.unwrap_or(50).min(200);
    state
        .db
        .get_plugin_audit_log(&plugin_id, limit)
        .map(|rows| {
            rows.into_iter()
                .map(|(id, pid, op, target, ts)| PluginAuditLogEntry {
                    id,
                    plugin_id: pid,
                    operation: op,
                    target,
                    timestamp: ts,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}
