//! 外部目录挂载 Commands（IPC 入口）
//!
//! 文件读写、索引、标签/双链重建全部在 `services::mount::MountService`。

use tauri::{AppHandle, Emitter, Manager, State};

use crate::models::{
    ExternalEntry, ExternalMount, ExternalMountInput, ExternalMountUpdate, MountNoteStatus,
    MountOpenResult, MountSaveResult, MountScanResult,
};
use crate::services::mount::MountService;
use crate::state::AppState;

/// 新增挂载点；成功后动态放行该目录的 asset 协议范围（外部图片可直接显示）
#[tauri::command]
pub fn mount_add(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ExternalMountInput,
) -> Result<ExternalMount, String> {
    let mount = MountService::add_mount(&state.db, &input).map_err(|e| e.to_string())?;
    allow_asset_scope(&app, &mount.root_path);
    Ok(mount)
}

/// 更新挂载点设置（同步间隔 / 只读 / 自动索引 / 名称）
#[tauri::command]
pub fn mount_update(
    state: State<'_, AppState>,
    id: i64,
    input: ExternalMountUpdate,
) -> Result<ExternalMount, String> {
    MountService::update_mount(&state.db, id, &input).map_err(|e| e.to_string())
}

/// 列出全部挂载点
#[tauri::command(async)]
pub fn mount_list(state: State<'_, AppState>) -> Result<Vec<ExternalMount>, String> {
    state.db.list_external_mounts().map_err(|e| e.to_string())
}

/// 删除挂载点。`detach=true` 保留影子文档并转为本地文档
#[tauri::command]
pub fn mount_remove(
    state: State<'_, AppState>,
    id: i64,
    detach: Option<bool>,
) -> Result<(), String> {
    MountService::remove_mount(&state.db, id, detach.unwrap_or(false))
        .map_err(|e| e.to_string())
}

/// 增量扫描一个挂载点，过程中推送 `mount:scan-progress`
#[tauri::command(async)]
pub fn mount_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    mount_id: i64,
) -> Result<MountScanResult, String> {
    let mounts = state
        .db
        .list_external_mounts()
        .map_err(|e| e.to_string())?;
    let mount = mounts
        .into_iter()
        .find(|m| m.id == mount_id)
        .ok_or_else(|| format!("挂载点 {} 不存在", mount_id))?;

    let result =
        MountService::scan_mount(&state.db, &mount, &app, true).map_err(|e| e.to_string())?;

    // 手动扫描同样广播：文档目录树/列表依赖 db:external-changed 刷新，
    // 否则外部归档后要等下一轮后台扫描页面才会应用新目录结构。
    let _ = app.emit("external:changed", mount_id);
    let _ = app.emit("db:external-changed", ());
    Ok(result)
}

/// 列出挂载内的文件条目（前端构建树）
#[tauri::command(async)]
pub fn mount_list_entries(
    state: State<'_, AppState>,
    mount_id: i64,
) -> Result<Vec<ExternalEntry>, String> {
    MountService::list_entries(&state.db, mount_id).map_err(|e| e.to_string())
}

/// 打开外部文件：读取磁盘最新内容并同步影子缓存
#[tauri::command(async)]
pub fn mount_open_file(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<MountOpenResult, String> {
    MountService::open_note(&state.db, note_id).map_err(|e| e.to_string())
}

/// 查询影子文档是否落后于原文件
#[tauri::command(async)]
pub fn mount_note_status(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<MountNoteStatus, String> {
    MountService::note_status(&state.db, note_id).map_err(|e| e.to_string())
}

/// 强制重新抽取（会覆盖影子文档的本地编辑）
#[tauri::command(async)]
pub fn mount_reextract(
    state: State<'_, AppState>,
    note_id: i64,
) -> Result<MountOpenResult, String> {
    MountService::reextract(&state.db, note_id).map_err(|e| e.to_string())
}

/// Office 工作台保存原文件后，按绝对路径立即刷新该文件的索引。
/// 路径不在任何挂载内时返回 `null`（不报错）。
#[tauri::command(async)]
pub fn mount_refresh_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<i64>, String> {
    MountService::refresh_path(&state.db, &path).map_err(|e| e.to_string())
}

/// 保存外部文件：写回磁盘并更新索引
#[tauri::command]
pub fn mount_save_file(
    state: State<'_, AppState>,
    note_id: i64,
    content: String,
) -> Result<MountSaveResult, String> {
    MountService::save_note(&state.db, note_id, &content).map_err(|e| e.to_string())
}

/// 启动时给已存在的挂载点补放 asset 协议范围
pub fn allow_mount_asset_scopes(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(mounts) = state.db.list_external_mounts() else {
        return;
    };
    for mount in mounts {
        allow_asset_scope(app, &mount.root_path);
    }
}

fn allow_asset_scope(app: &AppHandle, path: &str) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(path, true) {
        log::warn!("[mount] 放行 asset 协议范围失败 {}: {}", path, e);
    }
}
