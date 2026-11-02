//! 用户 PPT 模板（导入自 PPT-Master 的版式工作区）。
//!
//! 模板是纯数据：`app_data/ppt-templates/<id>/` 下的 SVG + 可选图片，
//! 应用只读取，不执行其中任何内容。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 已安装的用户模板（DB 行，也是返回给前端的结构）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptUserTemplate {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub dir_path: String,
    /// layout / deck
    pub source_kind: String,
    pub source_pack: Option<String>,
    pub canvas_format: String,
    pub canvas_width: i64,
    pub canvas_height: i64,
    pub page_count: i64,
    pub page_types: Vec<String>,
    pub supports_structured: bool,
    pub supports_legacy: bool,
    pub cover_file: Option<String>,
    pub content_hash: Option<String>,
    pub enabled: bool,
    /// ok / missing / invalid
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Inspect 阶段返回的模板预览，不落盘。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptTemplatePreview {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub source_kind: String,
    pub source_pack: Option<String>,
    pub canvas_format: String,
    pub canvas_width: i64,
    pub canvas_height: i64,
    pub page_count: i64,
    pub page_types: Vec<String>,
    pub supports_structured: bool,
    pub supports_legacy: bool,
    pub cover_file: Option<String>,
    /// 封面 SVG 内容，供导入弹窗预览（限制大小）。
    pub cover_svg: Option<String>,
    pub warnings: Vec<String>,
    /// 已存在同 id 模板时给出提示。
    pub conflict: Option<String>,
    /// 页型重命名映射（原始页型 -> 去重后页型）。
    pub page_type_map: BTreeMap<String, String>,
}

/// 安装时的冲突策略。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PptTemplateConflictPolicy {
    /// 已存在则拒绝（默认）
    #[default]
    Reject,
    /// 覆盖已有模板
    Overwrite,
    /// 自动改名 `<id>-2`、`<id>-3`
    Rename,
}

/// 单个模板的安装选择。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptTemplateInstallSelection {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub conflict: Option<PptTemplateConflictPolicy>,
    /// 默认 true；false 时丢弃模板自带图片。
    #[serde(default)]
    pub keep_images: Option<bool>,
}

/// 安装请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptTemplateInstallInput {
    /// 文件夹或 zip 路径
    pub path: String,
    pub selections: Vec<PptTemplateInstallSelection>,
}

/// 单个模板安装失败信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptTemplateInstallFailure {
    pub id: String,
    pub message: String,
}

/// 安装结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptTemplateInstallResult {
    pub installed: Vec<PptUserTemplate>,
    pub failed: Vec<PptTemplateInstallFailure>,
    pub warnings: Vec<String>,
}

/// 启动/手动重扫结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptTemplateReconcileReport {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
    pub missing: Vec<String>,
    pub warnings: Vec<String>,
}

/// 合并后的 catalog 条目。
///
/// 字段命名刻意保持与扩展包 `layouts_index.json` 一致（snake_case + 少量 camelCase），
/// 前端可以直接复用原有版式卡片逻辑。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PptTemplateCatalogEntry {
    pub id: String,
    #[serde(rename = "nameZh", default, skip_serializing_if = "Option::is_none")]
    pub name_zh: Option<String>,
    #[serde(rename = "descriptionZh", default, skip_serializing_if = "Option::is_none")]
    pub description_zh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub canvas_format: String,
    pub page_count: i64,
    pub page_types: Vec<String>,
    /// extension / user
    pub source: String,
    pub structured: i64,
    pub legacy: i64,
    #[serde(rename = "supportsStructured")]
    pub supports_structured: bool,
    #[serde(rename = "supportsLegacy")]
    pub supports_legacy: bool,
}

/// 合并后的 catalog。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptTemplateCatalog {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_version: Option<String>,
    pub layouts: BTreeMap<String, PptTemplateCatalogEntry>,
    #[serde(default)]
    pub charts: serde_json::Value,
}
