//! 用户 PPT 模板导入相关 Commands。

use tauri::State;

use crate::models::ppt_template::{
    PptTemplateCatalog, PptTemplateInstallInput, PptTemplateInstallResult, PptTemplatePreview,
    PptTemplateReconcileReport, PptUserTemplate,
};
use crate::services::ppt_template::PptTemplateService;
use crate::state::AppState;

/// 预览文件夹/zip 中的模板，不安装。
#[tauri::command]
pub fn ppt_template_inspect(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<PptTemplatePreview>, String> {
    PptTemplateService::inspect(&state.db, &state.data_dir, &path)
        .map_err(|e| e.to_string())
}

/// 安装选中的模板。
#[tauri::command]
pub fn ppt_template_install(
    state: State<'_, AppState>,
    input: PptTemplateInstallInput,
) -> Result<PptTemplateInstallResult, String> {
    PptTemplateService::install(&state.db, &state.data_dir, input)
        .map_err(|e| e.to_string())
}

/// 列出已安装的用户模板。
#[tauri::command]
pub fn ppt_template_list(state: State<'_, AppState>) -> Result<Vec<PptUserTemplate>, String> {
    PptTemplateService::list(&state.db).map_err(|e| e.to_string())
}

/// 合并扩展包与用户模板的版式目录。
#[tauri::command]
pub fn ppt_template_catalog(state: State<'_, AppState>) -> Result<PptTemplateCatalog, String> {
    PptTemplateService::catalog(&state.db).map_err(|e| e.to_string())
}

/// 读取用户模板封面 SVG。
#[tauri::command]
pub fn ppt_template_preview(
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    PptTemplateService::preview(&state.db, &id)
        .map_err(|e| e.to_string())
}

/// 修改模板名称/描述。
#[tauri::command]
pub fn ppt_template_rename(
    state: State<'_, AppState>,
    id: String,
    display_name: String,
    description: Option<String>,
) -> Result<(), String> {
    PptTemplateService::rename(
        &state.db,
        &state.data_dir,
        &id,
        &display_name,
        description.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// 启用/禁用模板。
#[tauri::command]
pub fn ppt_template_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    PptTemplateService::set_enabled(&state.db, &id, enabled).map_err(|e| e.to_string())
}

/// 删除用户模板。
#[tauri::command]
pub fn ppt_template_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    PptTemplateService::delete(&state.db, &state.data_dir, &id).map_err(|e| e.to_string())
}

/// 校验模板内容哈希。
#[tauri::command]
pub fn ppt_template_verify(
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    PptTemplateService::verify(&state.db, &id).map_err(|e| e.to_string())
}

/// 导出模板为可分享的 zip。
#[tauri::command]
pub fn ppt_template_export(
    state: State<'_, AppState>,
    id: String,
    target: String,
) -> Result<String, String> {
    PptTemplateService::export_pack(&state.db, &id, &target).map_err(|e| e.to_string())
}

/// 重新扫描模板目录，修复索引。
#[tauri::command]
pub fn ppt_template_reconcile(
    state: State<'_, AppState>,
) -> Result<PptTemplateReconcileReport, String> {
    PptTemplateService::reconcile(&state.db, &state.data_dir).map_err(|e| e.to_string())
}
