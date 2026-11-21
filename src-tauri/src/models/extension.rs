use serde::{Deserialize, Serialize};

fn default_schema_version() -> u32 {
    1
}

fn default_kind() -> String {
    "engine".to_string()
}

/// 扩展包运行时描述（extension.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRuntime {
    /// python-script / python-embedded / executable
    #[serde(rename = "type")]
    pub runtime_type: String,
    /// 相对扩展包根目录的入口文件
    pub entry: String,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub python: Option<ExtensionPythonRuntime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPythonRuntime {
    #[serde(default)]
    pub min: Option<String>,
    #[serde(default)]
    pub max: Option<String>,
    /// 相对扩展包根目录的内嵌 Python 路径；为空时使用系统 python
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionIntegrity {
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
}

/// 扩展包清单（extension.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    /// 扩展清单 API 版本；当前支持 1
    #[serde(default = "default_schema_version")]
    pub api_version: u32,
    /// 运行协议版本；当前支持 1
    #[serde(default = "default_schema_version")]
    pub protocol_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub min_app_version: Option<String>,
    /// 例如 windows-x86_64 / darwin-aarch64；为空表示不限制
    #[serde(default)]
    pub platforms: Vec<String>,
    pub runtime: ExtensionRuntime,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// 扩展点声明。PPT 引擎读取 contributes.ppt.layoutsIndex / chartsIndex
    #[serde(default)]
    pub contributes: serde_json::Value,
    #[serde(default)]
    pub integrity: Option<ExtensionIntegrity>,
}

/// 已安装扩展包（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub path: String,
    pub enabled: bool,
    pub status: String,
    pub content_hash: String,
    pub permissions: Vec<String>,
    pub supports_ppt: bool,
    pub installed_at: String,
    pub updated_at: String,
    pub manifest: ExtensionManifest,
}

/// 已安装扩展的版本记录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionVersionInfo {
    pub version: String,
    pub path: String,
    pub content_hash: String,
    pub is_current: bool,
    pub installed_at: String,
}

/// zip 预检结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInspection {
    pub manifest: ExtensionManifest,
    pub compatible: bool,
    pub reason: Option<String>,
    pub file_count: usize,
    pub uncompressed_bytes: u64,
    pub content_hash: String,
    pub root_prefix: Option<String>,
}

/// 本地文件素材（由前端选择后提取）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptLocalFileSource {
    pub path: String,
    pub title: String,
    pub source_type: String,
    pub text: String,
    pub word_count: usize,
}

/// 创建作业时传入的本地文件（text 为空时后端重新提取）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptLocalFileInput {
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub source_type: String,
    #[serde(default)]
    pub text: String,
}

/// 用于 AI 推断标题/汇报对象的素材摘要（不传完整正文）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptMetaSource {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub source_type: String,
    #[serde(default)]
    pub excerpt: String,
}

/// AI 推断出的 PPT 标题与汇报对象
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptMetaSuggestion {
    pub title: String,
    pub audience: String,
}

/// PPT 作业输入（前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptJobInput {
    /// 普通文档 id
    #[serde(default)]
    pub note_ids: Vec<i64>,
    /// 挂载文件对应的影子文档 id（保留兼容）
    #[serde(default)]
    pub mount_note_ids: Vec<i64>,
    /// 用户选择的本地文件（PDF/Word/Markdown 等）
    #[serde(default)]
    pub local_files: Vec<PptLocalFileInput>,
    /// 用户手工补充/编辑的正文
    #[serde(default)]
    pub manual_text: String,
    pub title: String,
    #[serde(default)]
    pub audience: String,
    /// 为空表示由 AI 根据素材自动决定页数
    #[serde(default)]
    pub slide_count: Option<usize>,
    #[serde(default)]
    pub layout_id: Option<String>,
    #[serde(default)]
    pub chart_ids: Vec<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub extra_requirements: Option<String>,
    #[serde(default)]
    pub export_dir: Option<String>,
    #[serde(default)]
    pub model_id: Option<i64>,
    /// AI 规划阶段取消标识；由前端生成，允许在大纲生成期间取消
    #[serde(default)]
    pub planning_id: Option<String>,
    /// 引擎运行超时（秒），为空使用默认 900 秒
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// 是否优先导出 PowerPoint 原生图表（默认关闭，保持现有版式导出）
    #[serde(default)]
    pub native_charts: Option<bool>,
}

/// PPT 单页内容块（结构化规划的最小单元）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptContentBlock {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub detail: String,
}

/// PPT 单页大纲
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptSlide {
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub core_message: String,
    #[serde(default)]
    pub bullets: Vec<String>,
    /// 标准化后的图表数据：{ type, categories, series: [{name, values}] }
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    /// 页面主题（与相邻页不重复）
    #[serde(default)]
    pub page_theme: String,
    /// 本页一句话主张
    #[serde(default)]
    pub main_claim: String,
    /// 本页内容范围说明
    #[serde(default)]
    pub content_scope: String,
    /// 结构化内容块：label / text / detail
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content_blocks: Vec<PptContentBlock>,
    /// 来自素材的证据或事实
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    /// 内容关系：timeline / category / compare / cause / process / none
    #[serde(default)]
    pub relation: String,
    /// 推荐图表或版式：cards / timeline / process / matrix / compare / highlight / summary
    #[serde(default)]
    pub chart_type: String,
    /// 密度：anchor / dense / breathing / balanced
    #[serde(default)]
    pub density: String,
    /// 视觉意图说明，供逐页生成提示词使用
    #[serde(default)]
    pub visual_intent: String,
    /// 演讲备注
    #[serde(default)]
    pub speaker_note: String,
}

/// PPT 大纲（plan.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptPlan {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub slides: Vec<PptSlide>,
}

/// PPT 作业状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptJob {
    pub id: String,
    pub extension_id: String,
    pub status: String,
    /// 多阶段流程：style / outline_ready / rendering_draft / draft_ready / exporting / done
    pub stage: String,
    pub title: String,
    pub template_id: Option<String>,
    pub workspace_path: String,
    pub project_path: Option<String>,
    pub pptx_path: Option<String>,
    pub final_pptx_path: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub log_tail: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// 草稿页（project/svg_output/*.svg）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptDraftPage {
    /// 文件名，例如 P01.svg；只允许文件名，不含路径
    pub file: String,
    pub page: u32,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PptSourceMeta {
    pub id: i64,
    pub source_type: String,
    pub title: String,
    pub word_count: usize,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 原始字符数；与 word_count 不同时表示被截断
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_chars: Option<usize>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}
