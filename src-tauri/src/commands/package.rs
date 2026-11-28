//! 安装包类型识别 Command

use crate::models::PackageKind;
use crate::services::package;

/// 识别 zip 安装包类型（plugin / extension），供统一安装入口使用。
#[tauri::command]
pub fn detect_package_kind(path: String) -> Result<PackageKind, String> {
    package::detect_kind(&path).map_err(|e| e.to_string())
}
