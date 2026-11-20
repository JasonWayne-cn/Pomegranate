pub mod ai_provider;
pub mod extension;
pub mod ppt_template;
pub mod research;
// 将常用 Provider 类型提升到 models 层，方便 commands 层直接 use
pub use ai_provider::{
    ActiveProviderInfo, AiCapabilities, AiProviderConfig, AiProviderMetadata, SwitchProviderInput,
};
pub mod session;

use serde::{Deserialize, Serialize};

/// 应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub key: String,
    pub value: String,
}

// ─── 插件系统 ───────────────────────────────────

/// 插件 manifest 中声明的命令入口
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandContribution {
    pub id: String,
    pub title: String,
}

/// 插件 manifest 中声明的侧边栏视图入口
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginViewContribution {
    pub id: String,
    pub title: String,
}

/// 插件声明的扩展点
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContributes {
    #[serde(default)]
    pub commands: Vec<PluginCommandContribution>,
    #[serde(default)]
    pub sidebar_views: Vec<PluginViewContribution>,
    #[serde(default)]
    pub settings: bool,
}

/// 插件 manifest（plugin.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    pub main: String,
    #[serde(default)]
    pub styles: Option<String>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: PluginContributes,
}

/// 插件管理页展示的数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub path: String,
    pub main: String,
    pub styles: Option<String>,
    pub min_app_version: Option<String>,
    pub enabled: bool,
    pub status: String,
    pub permissions: Vec<String>,
    pub granted_permissions: Vec<String>,
    pub manifest: PluginManifest,
    pub installed_at: String,
    pub updated_at: String,
    /// T26: main.js 的 SHA-256 哈希，用于完整性校验
    pub content_hash: String,
}

/// T25: 插件审计日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAuditLogEntry {
    pub id: i64,
    pub plugin_id: String,
    pub operation: String,
    pub target: Option<String>,
    pub timestamp: String,
}

/// 插件 AI 对话输入
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAiChatInput {
    pub messages: Vec<PluginAiMessage>,
    pub request_id: String,
    #[serde(default)]
    pub model_id: Option<i64>,
}

/// 插件 AI 消息
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAiMessage {
    pub role: String,
    pub content: String,
}

/// 插件 AI 流式 token 事件负载
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAiTokenPayload {
    pub token: String,
    pub full_text: Option<String>,
    pub done: bool,
    pub error: Option<String>,
}

/// 插件可见的 AI 模型信息（不暴露 api_key）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAiModelInfo {
    pub id: i64,
    pub name: String,
    pub provider: String,
    pub protocol: String,
    pub api_url: String,
    pub model_id: String,
    pub is_default: bool,
    pub max_context: i64,
    pub supports_tools: bool,
    pub supports_vision: bool,
    pub max_output_tokens: Option<i64>,
}

/// 全局快捷键绑定信息（返回给前端的视图模型）
///
/// - `accel = ""` 表示「禁用」（用户主动关掉这条热键）
/// - `is_custom`：用户改过键（与 `default_accel` 不同 / 已禁用）
/// - 注：仅 global scope 的热键经过 Rust 侧绑定；app/editor 内键不参与此模型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub id: String,
    pub accel: String,
    pub default_accel: String,
    pub is_custom: bool,
    pub disabled: bool,
}

/// 系统信息
///
/// `instance_id` / `is_dev` 用于 UI 区分多开实例（默认实例 = None；多开 = Some(N)）。
/// `data_dir` 永远是当前实例的数据根目录（多开 = `app_data_dir/instance-N`），不是 app_data_dir。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub data_dir: String,
    pub images_dir: String,
    /// 多开实例编号；None = 默认实例
    pub instance_id: Option<u32>,
    /// 是否运行在 debug build 下（前端徽章追加 [DEV] 标识）
    pub is_dev: bool,
}

// ─── Git 信息 ─────────────────────────────────

/// Git 仓库状态快照
///
/// 由 `get_git_info` Command 通过 shell out `git` CLI 获取。
/// 非 git 仓库时返回 Default（branch: None, is_clean: true）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    /// 当前分支名；非 git 仓库为 None
    pub branch: Option<String>,
    /// 工作区干净（无修改/暂存/未跟踪）
    pub is_clean: bool,
    /// 已修改未暂存的文件数
    pub changed: i32,
    /// 已暂存的文件数
    pub staged: i32,
    /// 未跟踪的文件数
    pub untracked: i32,
    /// 领先远程的提交数；无 upstream 时为 0
    pub ahead: i32,
    /// 落后远程的提交数；无 upstream 时为 0
    pub behind: i32,
}

// ─── 笔记 ─────────────────────────────────────

/// 笔记（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub title: String,
    /// 明文 content。加密笔记这里是"🔒 已加密"占位符；真实内容需调 decrypt_note 拿
    pub content: String,
    pub folder_id: Option<i64>,
    pub is_daily: bool,
    pub daily_date: Option<String>,
    pub is_pinned: bool,
    /// T-003: 是否"隐藏"。默认视图全部过滤；wiki link 跳转仍可打开
    pub is_hidden: bool,
    /// T-007: 是否加密。前端据此决定是否显示"已加密"/"解锁查看"按钮
    pub is_encrypted: bool,
    /// 临时编辑（外部 .md 临时打开，不入主列表/搜索/双链）
    #[serde(default)]
    pub is_scratch: bool,
    pub word_count: i64,
    pub created_at: String,
    pub updated_at: String,
    /// 关联的原始文件相对路径（相对 app_data_dir），为 None 表示纯笔记
    pub source_file_path: Option<String>,
    /// 原始文件类型："pdf" / "docx" / "doc" / null
    pub source_file_type: Option<String>,
    /// 同一 folder 内的自定义排序值，越小越靠前（间隔 1000 留空隙）
    /// 默认按 updated_at DESC 初始化；只有用户在"自定义排序"模式下拖拽过才与时间序偏离
    pub sort_order: i64,
    /// 笔记类型："markdown"（默认）/ "whiteboard"
    #[serde(default = "default_note_type")]
    pub note_type: String,
}

fn default_note_type() -> String {
    "markdown".to_string()
}

// ─── T-007 笔记加密保险库 ──────────────────────

/// Vault 整体状态
///
/// 三元状态机：
/// - `NotSet`：还没设置过主密码，首次使用前要走 setup
/// - `Locked`：已设置但未解锁（会话启动态 / 手动锁定后）
/// - `Unlocked`：会话内存里缓存了主密钥；可以加/解密
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VaultStatus {
    NotSet,
    Locked,
    Unlocked,
}

/// 创建/更新笔记的入参
#[derive(Debug, Clone, Deserialize)]
pub struct NoteInput {
    pub title: String,
    pub content: String,
    pub folder_id: Option<i64>,
}

/// 笔记列表查询参数
#[derive(Debug, Clone, Deserialize)]
pub struct NoteQuery {
    pub folder_id: Option<i64>,
    pub keyword: Option<String>,
    pub page: Option<usize>,
    pub page_size: Option<usize>,
    /// true 时只返回 folder_id IS NULL 的笔记（"未分类"虚拟文件夹）。
    /// 与 folder_id 互斥（同时传 folder_id 优先生效）。
    pub uncategorized: Option<bool>,
    /// true 时点父文件夹连同所有子孙文件夹的笔记一起返回。
    /// 仅当传了 folder_id 时生效；未传时无意义。前端默认 true，符合用户直觉。
    pub include_descendants: Option<bool>,
    /// 排序模式（默认 None=按 is_pinned DESC, updated_at DESC）
    /// - None / "default" → is_pinned DESC, updated_at DESC（旧行为）
    /// - "custom" → is_pinned DESC, sort_order ASC, updated_at DESC（用户自定义）
    /// - "created" → is_pinned DESC, created_at DESC
    /// - "title" → is_pinned DESC, title ASC
    pub sort_by: Option<String>,
    /// 是否返回外部二进制文档（PDF/Word/Excel，`ext_index_only = 1`）。
    /// 文档树需要展示这些文件；主文档列表默认不传，保持旧行为。
    #[serde(default)]
    pub include_external_docs: Option<bool>,
}

// ─── 文件夹 ───────────────────────────────────

/// 文件夹（返回给前端，含子文件夹树）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub sort_order: i32,
    pub children: Vec<Folder>,
    pub note_count: usize,
    /// 非空表示这是外部目录挂载镜像文件夹（前端用不同的同步文件夹图标）
    #[serde(default)]
    pub mount_id: Option<i64>,
}

// ─── 标签 ─────────────────────────────────────

/// 标签（返回给前端，含关联笔记数）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub note_count: usize,
    #[serde(default)]
    pub parent_id: Option<i64>,
}

/// 笔记列表「标签」列用的轻量标签。
#[derive(Debug, Clone, Serialize)]
pub struct NoteTagBrief {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

/// 创建/更新标签的入参
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct TagInput {
    pub name: String,
    pub color: Option<String>,
}

// ─── 搜索 ─────────────────────────────────────

/// 全文搜索结果
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub id: i64,
    pub title: String,
    pub snippet: String,
    pub updated_at: String,
    pub folder_id: Option<i64>,
    pub note_type: String,
    /// 外部挂载文件的磁盘绝对路径；普通笔记为 None。
    pub abs_path: Option<String>,
    /// 外部二进制文档仅作索引（点击应进 Office 工作台而非影子笔记）。
    pub ext_index_only: bool,
    /// 所在挂载点是否只读（供 Office 打开时禁用保存）。
    pub read_only: bool,
}

// ─── 回收站 ───────────────────────────────────

/// 回收站笔记查询参数
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct TrashQuery {
    pub page: Option<usize>,
    pub page_size: Option<usize>,
}

// ─── 笔记链接 ─────────────────────────────────

/// 笔记链接（反向链接信息）
#[derive(Debug, Clone, Serialize)]
pub struct NoteLink {
    pub source_id: i64,
    pub source_title: String,
    pub context: Option<String>,
    pub updated_at: String,
}

// ─── 知识图谱 ─────────────────────────────────

/// 图谱节点（笔记或文件夹）
#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: i64,
    pub title: String,
    /// "note" = 笔记，"folder" = 文件夹
    pub node_type: String,
    pub is_daily: bool,
    pub is_pinned: bool,
    pub tag_count: usize,
    pub link_count: usize,
    /// 文件夹自定义颜色（笔记恒为 None）
    pub color: Option<String>,
    /// 仅按文件夹限定范围时出现：范围外但与范围内笔记有链接的"边界节点"
    #[serde(default)]
    pub is_boundary: bool,
}

/// 图谱边
#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub source: i64,
    pub target: i64,
    /// "link" = wiki 双链，"folder_child" = 父子文件夹，"folder_note" = 文件夹归属
    pub edge_type: String,
}

/// 知识图谱数据
#[derive(Debug, Clone, Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

// ─── AI 知识问答 ─────────────────────────────

/// AI 模型配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModel {
    pub id: i64,
    pub name: String,
    /// 模型提供商: openai / claude / ollama
    pub provider: String,
    /// 协议: openai_compatible / anthropic / ollama
    pub protocol: String,
    /// API 基础 URL
    pub api_url: String,
    /// API Key（可为空，如 Ollama 本地模型）
    pub api_key: Option<String>,
    /// 模型标识 (如 gpt-4o-mini, claude-sonnet-4-20250514, llama3)
    pub model_id: String,
    /// 是否为默认模型
    pub is_default: bool,
    /// 模型支持的最大上下文 token 数（用户填，默认 32000）
    /// 用于在 send_message 拼附加笔记时动态算每篇截断阈值
    pub max_context: i64,
    /// 是否支持工具调用/Function Calling
    pub supports_tools: bool,
    /// 是否支持视觉输入
    pub supports_vision: bool,
    /// 最大输出 token 数（None = 模型决定）
    pub max_output_tokens: Option<i64>,
    pub created_at: String,
}

/// AI 模型连通性测试结果
///
/// 测试按钮专用：发一次极小请求（OpenAI 兼容 max_tokens=1，Ollama num_predict=1），
/// 失败原因走 `format_*_error` 中文化，前端 Modal.error 直接展示。
#[derive(Debug, Clone, Serialize)]
pub struct AiModelTestResult {
    /// 是否连通成功
    pub ok: bool,
    /// 端到端往返耗时（毫秒）
    pub latency_ms: u64,
    /// 服务端样本（成功时取首段回复前 N 字；失败时为空，错误走 Err 路径）
    pub sample: Option<String>,
}

/// 创建/更新 AI 模型入参
#[derive(Debug, Clone, Deserialize)]
pub struct AiModelInput {
    pub name: String,
    pub provider: String,
    /// 协议: openai_compatible / anthropic / ollama
    pub protocol: Option<String>,
    pub api_url: String,
    /// API Key: None = 保留旧值（更新时）, "" = 清空, 其他 = 更新
    pub api_key: Option<String>,
    pub model_id: String,
    /// 可选：缺省时按 32000 入库（覆盖大多数中端模型）
    pub max_context: Option<i64>,
    /// 是否支持工具调用，缺省 true
    pub supports_tools: Option<bool>,
    /// 是否支持视觉输入，缺省 false
    pub supports_vision: Option<bool>,
    /// 最大输出 token 数，缺省 None（模型决定）
    pub max_output_tokens: Option<i64>,
}

/// Embedding 模型配置（对应 ai_embedding_config 单行表）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingConfig {
    pub api_url: String,
    pub api_key: Option<String>,
    pub model_id: String,
    /// 向量维度（0 = 未探测/未知）
    pub dim: i64,
    pub is_enabled: bool,
}

/// 保存/测试 Embedding 配置入参
#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingConfigInput {
    pub api_url: String,
    /// api_key: None = 保留旧值, Some("") = 清空
    pub api_key: Option<String>,
    pub model_id: String,
    pub is_enabled: bool,
}

/// 全量重建向量结果
#[derive(Debug, Clone, Serialize)]
pub struct ReindexResult {
    pub total: usize,
    pub done: usize,
    pub failed: usize,
}

/// AI 对话
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConversation {
    pub id: i64,
    pub title: String,
    pub model_id: i64,
    /// 附加给本对话的笔记 ID 列表（JSON 数组反序列化后）
    /// 整个对话共享，类比 ChatGPT 项目里的 attached files
    pub attached_note_ids: Vec<i64>,
    /// Agent 工具调用轮数上限（1-30）
    pub agent_max_rounds: i64,
    /// 单个工具调用超时（秒，5-300）
    pub agent_tool_timeout: i64,
    /// 是否启用外部 MCP 工具
    pub agent_mcp_enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// AI 消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMessage {
    pub id: i64,
    pub conversation_id: i64,
    /// 角色: user / assistant
    pub role: String,
    pub content: String,
    /// 引用的笔记 ID 列表 (JSON 数组)
    pub references: Option<String>,
    /// 本条 assistant 消息里 AI 调用了哪些 skill（JSON 序列化的 SkillCall 数组）
    ///
    /// 前端拿到后反序列化成 SkillCall[] 渲染折叠卡片；为 None 表示没调用过工具。
    /// 只在 role="assistant" 且启用 skills 的对话里会写入。
    pub skill_calls: Option<String>,
    /// 一轮回复的收尾信息（JSON 序列化的 TurnMeta）；存量消息为 None
    pub turn_meta: Option<String>,
    pub created_at: String,
}

/// 一轮回复的收尾信息
///
/// 前端据此把历史消息还原成和流式期间一致的「回复卡片」：
/// 思考过程、各轮工具时间线、耗时、失败/停止结局。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnMeta {
    /// "done" / "stopped" / "error"
    pub end_reason: String,
    /// end_reason = "error" 时的错误原文
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 从收到提问到这一轮结束的耗时
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// 各轮调工具前模型说的话，下标 = 轮次
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_texts: Option<Vec<String>>,
    /// 推理模型 reasoning_content 的思考过程
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

/// AI 聊天请求
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct AiChatRequest {
    pub conversation_id: i64,
    pub message: String,
    /// 是否启用 RAG（检索笔记作为上下文）
    pub use_rag: Option<bool>,
}

// ─── 首页统计 ─────────────────────────────────

/// 首页统计数据
#[derive(Debug, Clone, Serialize)]
pub struct DashboardStats {
    pub total_notes: usize,
    pub total_folders: usize,
    pub total_tags: usize,
    pub total_links: usize,
    pub today_updated: usize,
    pub total_words: usize,
}

// ─── 导入 ─────────────────────────────────────

/// 扫描到的文件条目（供前端预览勾选）
///
/// match_kind + existing_note_id 在扫描阶段就告诉前端"该文件是否已经导入过"，
/// 用户可据此选择冲突策略（跳过/副本）。
#[derive(Debug, Clone, Serialize)]
pub struct ScannedFile {
    /// 文件绝对路径
    pub path: String,
    /// 相对扫描根的父目录，斜杠统一为 '/'；根层文件为空串
    /// 示例：扫描 "D:/foo/11"，文件 "D:/foo/11/子A/note.md" → "子A"
    pub relative_dir: String,
    /// 文件名（不含扩展名）
    pub name: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 去重匹配结果：
    /// - "new"   全新文件，未找到任何已有笔记
    /// - "path"  按 canonical source_file_path 命中（最精确）
    /// - "fuzzy" 按 (title, content_hash) 兜底命中（用户可能搬动过源文件）
    pub match_kind: String,
    /// match_kind 非 "new" 时，指向已存在笔记的 id
    pub existing_note_id: Option<i64>,
    /// 从文件夹名/文件名识别出的日期 YYYY-MM-DD
    pub detected_date: Option<String>,
    /// 文件夹名与文件名解析出的日期不一致
    pub date_conflict: bool,
}

/// 导入冲突策略：遇到已存在的文件怎么处理
///
/// 仅在 `import_selected_files` 批量导入场景生效；
/// 单文件 `open_markdown_file` 另有同步回写语义，不走这里。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportConflictPolicy {
    /// 跳过（默认，最安全）：扫描标记为 path/fuzzy 的文件不重新创建笔记
    Skip,
    /// 创建副本：标题加 " (2)" 后缀新建独立笔记，原笔记保持不变
    Duplicate,
}

impl Default for ImportConflictPolicy {
    fn default() -> Self {
        Self::Skip
    }
}

/// 导入结果
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportResult {
    /// 新建的笔记数
    pub imported: usize,
    /// 跳过的数量（空文件 / 去重时按 Skip 策略跳过）
    pub skipped: usize,
    /// 按 Duplicate 策略新建的副本数
    pub duplicated: usize,
    pub errors: Vec<String>,
    /// T-009: 从 frontmatter 解析并自动关联的标签条数（每个笔记 × 每个标签计 1）
    #[serde(default)]
    pub tags_attached: usize,
    /// T-009: 成功解析到 frontmatter 的笔记数
    #[serde(default)]
    pub frontmatter_parsed: usize,
    /// T-009 Commit 2: 复制到 kb_assets/images 的图片张数
    #[serde(default)]
    pub attachments_copied: usize,
    /// T-009 Commit 2: 缺失的图片清单（"笔记标题: 原始引用"格式，已去重）
    #[serde(default)]
    pub attachments_missing: Vec<String>,
    /// 本次新建的笔记 ID（按文件参数顺序，含 Duplicate 副本）。
    /// 前端用它做"导入后跳转"：1 篇直接打开编辑器，多篇跳列表。
    #[serde(default, rename = "noteIds")]
    pub note_ids: Vec<i64>,
    /// 命中已有笔记并按 Skip 策略跳过时记录的现有笔记 ID。
    /// 前端"重复命中也跳"逻辑用：用户拖个旧文件想打开它，能直达。
    #[serde(default, rename = "existingNoteIds")]
    pub existing_note_ids: Vec<i64>,
    /// 按「日期文件夹」识别并标记为日记的篇数
    #[serde(default)]
    pub daily_marked: usize,
    /// 同一天多篇时，未成为日记的篇数
    #[serde(default)]
    pub daily_extra_notes: usize,
}

/// 导入进度（通过事件推送）
#[derive(Debug, Clone, Serialize)]
pub struct ImportProgress {
    pub current: usize,
    pub total: usize,
    pub file_name: String,
}

/// "打开单个 md 文件"返回结果：含新建/复用的 note id + 是否触发了内容同步
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMarkdownResult {
    pub note_id: i64,
    /// true = 检测到源文件内容有变化，已覆盖回笔记（前端可据此提示）
    pub was_synced: bool,
    /// 这条笔记当前是否为「临时编辑」状态
    pub is_scratch: bool,
}

// ─── 附件 ─────────────────────────────────────

/// 附件信息（保存后回传给前端，用于插入 Tiptap 链接）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    /// 绝对路径（前端用来构造 file:// 链接给 opener 打开）
    pub path: String,
    /// 原始文件名（用户能看懂的文本，显示在链接里）
    pub file_name: String,
    /// 字节数（用于显示 "1.2 MB"）
    pub size: u64,
    /// MIME 类型（按扩展名映射；未知为 application/octet-stream）
    pub mime: String,
}

// ─── 孤儿素材（统一）─────────────────────────────
//
// 五类素材：images / videos / attachments / pdfs / sources
// 每类独立扫描器；UI 用 Tabs 分组展示。

/// 单条孤儿素材
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanItem {
    /// 素材类型：image / video / attachment / pdf / source
    pub kind: String,
    /// 绝对路径
    pub path: String,
    /// 按 note_id 分目录的素材有；纯平铺的 images 没有
    pub note_id: Option<i64>,
    pub size: u64,
    /// 孤儿原因：notePurged / unreferenced
    pub reason: String,
}

/// 单类素材的孤儿组（用于 UI Tab 内）
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrphanGroup {
    /// 实际孤儿数（不含截断）
    pub count: usize,
    pub total_bytes: u64,
    /// 孤儿明细（最多 500 条）
    pub items: Vec<OrphanItem>,
    /// items 是否被截断显示
    pub truncated: bool,
}

/// 全量孤儿扫描结果
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAssetScan {
    pub images: OrphanGroup,
    pub videos: OrphanGroup,
    pub attachments: OrphanGroup,
    pub pdfs: OrphanGroup,
    pub sources: OrphanGroup,
}

/// 孤儿素材清理结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAssetClean {
    pub deleted: usize,
    pub freed_bytes: u64,
    pub failed: Vec<String>,
}

// ─── 导出 ─────────────────────────────────────

/// 导出结果
#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub exported: usize,
    pub errors: Vec<String>,
    /// 用户选择的父目录（与入参一致，便于前端展示）
    pub output_dir: String,
    /// 实际创建的导出根目录（在 output_dir 下自动包一层时间戳目录）
    pub root_dir: String,
    /// 拷贝到 .assets/ 目录的资产文件总数（图片 + 附件，按物理文件去重）
    pub assets_copied: usize,
}

/// 单篇导出结果
#[derive(Debug, Clone, Serialize)]
pub struct SingleExportResult {
    /// 实际创建的笔记根目录（含 .md 和 assets/）
    pub root_dir: String,
    /// .md 文件绝对路径
    pub file_path: String,
    /// 拷贝到 assets/ 的资产文件数
    pub assets_copied: usize,
}

/// 导出进度（通过事件推送）
#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub current: usize,
    pub total: usize,
    pub file_name: String,
}

// ─── 写作趋势 ─────────────────────────────────

/// 每日写作统计
#[derive(Debug, Clone, Serialize)]
pub struct DailyWritingStat {
    /// 日期 (YYYY-MM-DD)
    pub date: String,
    /// 当日更新的笔记数
    pub note_count: usize,
    /// 当日总字数（更新过的笔记的字数之和）
    pub word_count: usize,
}

// ─── 笔记模板 ─────────────────────────────────

/// 笔记模板
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteTemplate {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub content: String,
    pub created_at: String,
}

/// 创建/更新模板入参
#[derive(Debug, Clone, Deserialize)]
pub struct NoteTemplateInput {
    pub name: String,
    pub description: String,
    pub content: String,
}

// ─── 通用 ─────────────────────────────────────

/// 分页响应
#[derive(Debug, Clone, Serialize)]
pub struct PageResult<T: Serialize> {
    pub items: Vec<T>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

/// 批量恢复笔记的结果
///
/// `to_root` = 其中有多少条因原文件夹已不存在而落到了根目录。
/// 用于前端在 message 里给"X 条恢复到根目录"的提示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBatchResult {
    pub restored: usize,
    pub to_root: usize,
}

// ─── 同步 ─────────────────────────────────────

/// 同步范围：控制本次同步包含哪些数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScope {
    /// 笔记元数据（app.db 的 notes 及关联表）
    pub notes: bool,
    /// 图片资产（kb_assets/images/）
    pub images: bool,
    /// PDF 原文件（pdfs/）
    pub pdfs: bool,
    /// Word 源文件（sources/）
    pub sources: bool,
    /// 应用设置（settings.json）
    pub settings: bool,
}

impl Default for SyncScope {
    fn default() -> Self {
        // V1/V2 默认全部勾选（资产也勾，符合用户预期）
        Self {
            notes: true,
            images: true,
            pdfs: true,
            sources: true,
            settings: true,
        }
    }
}

/// 导入模式：合并 or 覆盖
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncImportMode {
    /// 合并：已有的保留，新增的导入
    Merge,
    /// 覆盖：先清空本地 DB/资产，再用同步包替换
    Overwrite,
}

/// WebDAV 配置（不含密码——密码走 keyring）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    /// 仅在前端传入时使用；后端读取时从 keyring 取
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

/// 云端同步文件的清单信息（用于 preview）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifest {
    /// manifest 版本号（格式升级用）
    pub schema_version: u32,
    /// 设备名
    pub device: String,
    /// 导出时间（ISO 8601 本地时间）
    pub exported_at: String,
    /// 应用版本
    pub app_version: String,
    /// 本次同步包含的范围
    pub scope: SyncScope,
    /// 元数据统计（仅用于预览展示）
    pub stats: SyncStats,
    /// 导出端是否为 dev build。
    /// import 端会用此字段强校验：dev 包不能导入 prod 实例反之亦然
    /// （否则资产路径前缀不一致会变孤儿数据）。
    /// `Option`：None = 老版本导出（在引入校验之前），按宽容模式放行 + 日志告警。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_dev: Option<bool>,
    /// 导出端数据库 schema 版本（恢复时检查是否过高）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_user_version: Option<i32>,
}

/// 同步数据统计
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub notes_count: usize,
    pub folders_count: usize,
    pub tags_count: usize,
    pub images_count: usize,
    pub pdfs_count: usize,
    pub sources_count: usize,
    /// 资产总大小（字节）
    pub assets_size: u64,
}

/// 同步操作结果
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// 实际同步的条数/文件数（视具体范围而定）
    pub stats: SyncStats,
    /// 完成时间
    pub finished_at: String,
}

/// 同步历史记录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryItem {
    pub id: i64,
    /// "export" / "import" / "push" / "pull"
    pub direction: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub success: bool,
    pub error: Option<String>,
    pub stats_json: String,
}

// ─── 待办任务 ───────────────────────────────────

/// 任务关联：挂到笔记 / 本地路径 / URL
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLink {
    pub id: i64,
    pub task_id: i64,
    /// "note" / "path" / "url"
    pub kind: String,
    /// note → note_id 字符串；path → 绝对路径；url → 完整 URL
    pub target: String,
    /// 显示文案（如笔记标题）
    pub label: Option<String>,
}

/// 任务（含关联列表）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    /// 0=urgent / 1=normal / 2=low
    pub priority: i32,
    pub important: bool,
    /// 0=todo / 1=done
    pub status: i32,
    /// 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS'；前者视作当天 23:59:59
    pub due_date: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// 提前 N 分钟提醒；None=不提醒；需要 due_date 带时分才精确
    pub remind_before_minutes: Option<i32>,
    /// 上次触发提醒的时刻（ISO 'YYYY-MM-DD HH:MM:SS'），去重用
    pub reminded_at: Option<String>,
    /// 循环规则: "none" / "daily" / "weekly" / "monthly"
    pub repeat_kind: String,
    /// 每 N 个单位，默认 1
    pub repeat_interval: i32,
    /// 每周的哪几天，ISO 1=Mon..7=Sun，逗号分隔；仅 weekly 有效
    pub repeat_weekdays: Option<String>,
    /// 循环终止日期 'YYYY-MM-DD'
    pub repeat_until: Option<String>,
    /// 总触发次数上限（含首次）
    pub repeat_count: Option<i32>,
    /// 已触发次数
    pub repeat_done_count: i32,
    /// 批次来源标识（AI 批量导入用，同次生成共享同一个 UUID）；手动创建为 NULL
    pub source_batch_id: Option<String>,
    /// 一级分类 ID；None = 未分类
    pub category_id: Option<i64>,
    /// 父任务 ID；None = 主任务，Some(id) = 子任务
    pub parent_task_id: Option<i64>,
    /// 工作流看板列：'todo' / 'doing' / 'done'
    #[serde(default = "default_kanban_stage")]
    pub kanban_stage: String,
    /// 所属项目 ID；None = 未挂项目
    #[serde(default)]
    pub project_id: Option<i64>,
    /// 甘特图开始日期 'YYYY-MM-DD'
    #[serde(default)]
    pub start_date: Option<String>,
    /// 跨端同步稳定标识
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable_uuid: Option<String>,
    /// 软删墓碑标记
    #[serde(default)]
    pub is_deleted: bool,
    /// 已完成子任务数（仅主任务有意义；子任务恒为 0）
    #[serde(default)]
    pub subtask_done: i32,
    /// 总子任务数（同上）
    #[serde(default)]
    pub subtask_total: i32,
    /// 附件数（列表角标）
    #[serde(default)]
    pub attachment_count: i32,
    /// 「稍后提醒」时间
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snooze_until: Option<String>,
    pub links: Vec<TaskLink>,
}

fn default_kanban_stage() -> String {
    "todo".to_string()
}

/// 创建任务入参
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTaskInput {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub important: Option<bool>,
    pub due_date: Option<String>,
    pub remind_before_minutes: Option<i32>,
    pub links: Option<Vec<TaskLinkInput>>,
    /// 循环规则: "none"/"daily"/"weekly"/"monthly"，缺省按 "none"
    pub repeat_kind: Option<String>,
    pub repeat_interval: Option<i32>,
    pub repeat_weekdays: Option<String>,
    pub repeat_until: Option<String>,
    pub repeat_count: Option<i32>,
    /// AI 批量导入时同批次共享一个 UUID，用于一键撤销整批
    pub source_batch_id: Option<String>,
    /// 一级分类 ID；None = 未分类
    pub category_id: Option<i64>,
    /// 父任务 ID（创建子任务时传）；None = 创建主任务
    pub parent_task_id: Option<i64>,
    /// 所属项目 ID；None = 无项目
    pub project_id: Option<i64>,
    /// 甘特图开始日期 'YYYY-MM-DD'
    pub start_date: Option<String>,
}

/// 更新任务入参（字段缺省表示不改动）
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTaskInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub important: Option<bool>,
    pub due_date: Option<String>,
    /// 传 true 显式清空 due_date
    pub clear_due_date: Option<bool>,
    pub remind_before_minutes: Option<i32>,
    /// 传 true 显式清空 remind_before_minutes
    pub clear_remind_before_minutes: Option<bool>,
    /// 循环规则；传 "none" 或传 clear_repeat=true 表示关闭循环
    pub repeat_kind: Option<String>,
    pub repeat_interval: Option<i32>,
    pub repeat_weekdays: Option<String>,
    pub clear_repeat_weekdays: Option<bool>,
    pub repeat_until: Option<String>,
    pub clear_repeat_until: Option<bool>,
    pub repeat_count: Option<i32>,
    pub clear_repeat_count: Option<bool>,
    /// 一级分类 ID（None 不动；传 Some(id) 改）
    pub category_id: Option<i64>,
    /// 传 true 显式清空 category_id（落到"未分类"）
    pub clear_category_id: Option<bool>,
    /// 所属项目 ID；None 不动；传 Some(id) 改
    pub project_id: Option<i64>,
    /// 传 true 显式清空 project_id（落到"无项目"）
    pub clear_project_id: Option<bool>,
    /// 甘特图开始日期 'YYYY-MM-DD'；None 不动
    pub start_date: Option<String>,
    /// 传 true 显式清空 start_date
    pub clear_start_date: Option<bool>,
}

/// 任务关联入参（新建任务时一起传）
#[derive(Debug, Clone, Deserialize)]
pub struct TaskLinkInput {
    pub kind: String,
    pub target: String,
    pub label: Option<String>,
}

/// 任务查询筛选条件
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TaskQuery {
    /// Some(0) = 只看未完成, Some(1) = 只看已完成, None = 全部
    pub status: Option<i32>,
    /// 关键词（标题 / 描述 LIKE）
    pub keyword: Option<String>,
    /// 某个优先级
    pub priority: Option<i32>,
    /// 某个分类（与 uncategorized 互斥，同时传 category_id 优先生效）
    pub category_id: Option<i64>,
    /// true 时只返回 category_id IS NULL 的任务（"未分类"虚拟分类）
    pub uncategorized: Option<bool>,
}

/// 顶栏 Ctrl+K 搜索的任务命中（轻量）
///
/// 不复用 Task 是为了少传字段，搜索面板只展示这几条，结构更扁平
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSearchHit {
    pub id: i64,
    pub title: String,
    /// 简短上下文片段：description 截断后；description 为空时回退用 due_date 描述
    pub snippet: String,
    /// 0=todo / 1=done（前端可据此显示已完成置灰）
    pub status: i32,
    /// 0=urgent / 1=normal / 2=low
    pub priority: i32,
    pub due_date: Option<String>,
}

/// 待办分类（一级，扁平）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCategory {
    pub id: i64,
    pub name: String,
    /// 圆点颜色，如 "#1677ff"
    pub color: String,
    /// 可选 emoji 或 lucide 图标名
    pub icon: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    /// 跨端同步稳定标识
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable_uuid: Option<String>,
    /// 父分类 id（多级分类）；None = 顶层
    #[serde(default)]
    pub parent_id: Option<i64>,
}

/// 创建分类入参
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTaskCategoryInput {
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub parent_id: Option<i64>,
}

/// 更新分类入参（字段缺省 = 不改）
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTaskCategoryInput {
    pub name: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub clear_icon: Option<bool>,
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub parent_id: Option<i64>,
    #[serde(default)]
    pub clear_parent: Option<bool>,
}

/// 任务统计（首页卡片 / 侧边栏徽章）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStats {
    pub total_todo: usize,
    pub total_done: usize,
    pub urgent_todo: usize,
    pub overdue: usize,
    pub due_today: usize,
}

// ─── AI 提示词库 ─────────────────────────────

/// AI 提示词模板（返回给前端）
///
/// - 内置模板 `is_builtin=1`，`builtin_code` 是旧硬编码 action（continue/summarize…）的别名，便于兼容。
/// - 用户自定义模板 `is_builtin=0`，`builtin_code=None`。
/// - `output_mode` 决定前端 AI 菜单拿到结果后默认怎么插入：
///     · `replace` 替换选区
///     · `append`  追加到选区末尾（续写场景）
///     · `popup`   只展示，不自动插入（总结场景）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub prompt: String,
    /// 'replace' | 'append' | 'popup'
    pub output_mode: String,
    /// Lucide 图标名，如 "ArrowRight"
    pub icon: Option<String>,
    pub is_builtin: bool,
    pub builtin_code: Option<String>,
    /// 所属分组；None 视为默认组（快捷指令）
    pub group_id: Option<i64>,
    /// 组内排序（同组内升序）
    pub sort_order: i32,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// AI 提示词分组
///
/// 划词快捷框为每组渲染一个折叠下拉。内置组：
/// - `quick`    快捷指令（内置写作类模板 + 用户自建模板）
/// - `translate` 翻译（译英 / 译中）
///
/// 内置组允许改名，但 `builtin_code` 不变；内置组不可删除。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptGroup {
    pub id: i64,
    pub name: String,
    pub is_builtin: bool,
    pub builtin_code: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

// ─── AI Skills（T-004） ────────────────────

/// AI 调用的一次 Skill（工具）记录
///
/// 从模型流里解析出 tool_calls 后 dispatch 执行，得到结果一起打包给前端展示/持久化。
/// 字段设计模仿 OpenAI tool_calls 的结构但做了扁平化：
///   · `args_json` / `result` 都是字符串，便于直接渲染
///   · `status` 统一用 "ok" / "error" / "running"，前端状态机好画
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCall {
    /// OpenAI 返回的 tool_call_id（同一次请求里唯一）
    pub id: String,
    pub name: String,
    /// 反序列化后的参数（JSON 字符串，供前端 pretty-print 展示）
    pub args_json: String,
    /// Skill 执行结果，一般是 JSON 或截断后的文本
    pub result: String,
    /// "ok" / "error" / "running"（服务器侧持久化时只会写 ok/error）
    pub status: String,
    /// 第几轮发起的调用（从 0 开始）；存量记录没有
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<usize>,
    /// 工具执行耗时（毫秒）；running 时没有
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

// ─── AI 规划今日待办（T-005） ──────────────

/// 前端发起"AI 规划今日"的入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTodayRequest {
    /// 用户输入的"今日目标"（可选），AI 会据此定向推荐
    pub goal: Option<String>,
    /// 是否把"昨日未完成 + 过期未完成"顺延进来；默认 true
    #[serde(default = "default_true")]
    pub include_yesterday_unfinished: bool,
}

fn default_true() -> bool {
    true
}

/// AI 对一条待办的建议（未真正写入数据库）
///
/// 前端把这些建议展示在 Modal 表格，用户可编辑/勾选后调用现有 `taskApi.create`
/// 批量写入 tasks 表。与 `CreateTaskInput` 刻意保持字段兼容，方便前端直接映射。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSuggestion {
    pub title: String,
    /// 0=紧急重要，1=普通，2=低；默认 1
    #[serde(default)]
    pub priority: Option<i32>,
    /// 艾森豪威尔重要性维度
    #[serde(default)]
    pub important: Option<bool>,
    /// 截止日期 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS'，一般是今天
    pub due_date: Option<String>,
    /// 提前提醒时间（分钟）。null = 不提醒；0 = 准时提醒；正整数 = 提前 N 分钟。
    /// AI 根据四象限自动判断：Q1 紧急多用 0/15；Q2 重要多用 60/1440；Q4 多用 null。
    ///
    /// `rename = "remindBefore"`：序列化和反序列化都用 `remindBefore` —— 与现有
    /// AI prompt（plan_today / draft_note）和前端 TS `TaskSuggestion.remindBefore` 对齐。
    /// `alias = "remindBeforeMinutes"` 兼容旧版本可能输出的 camelCase 字段名。
    #[serde(
        default,
        rename = "remindBefore",
        alias = "remindBeforeMinutes"
    )]
    pub remind_before_minutes: Option<i32>,
    /// AI 给出的推荐理由（可选，用于 UI 折叠展示）
    pub reason: Option<String>,
}

/// AI 规划今日的返回结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTodayResponse {
    pub tasks: Vec<TaskSuggestion>,
    /// 一句总结 AI 对今日安排的思路；可选
    pub summary: Option<String>,
}

// ─── AI 智能规划（目标驱动）─────────────────

/// "目标驱动 AI 规划"入参：用户给一个长期目标，AI 自己拆成多条待办 + 阶段里程碑
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFromGoalRequest {
    /// 用户描述的目标，例如"180 天减肥到 55 公斤"
    pub goal: String,
    /// 计划周期总天数；默认 30
    #[serde(default = "default_horizon_days")]
    pub horizon_days: i32,
    /// 起始日期 'YYYY-MM-DD'；缺省取今天
    pub start_date: Option<String>,
    /// 用户额外补充信息（可选），例如作息/兴趣/约束
    pub profile_hint: Option<String>,
}

fn default_horizon_days() -> i32 {
    30
}

/// 阶段里程碑（项目级节点，例如「第 1 月：身体激活」）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneDraft {
    pub title: String,
    /// 日期范围文本（如 "5月1日-5月31日"），AI 自由格式
    pub date_range: Option<String>,
    /// 该阶段的核心任务/目标描述
    pub description: Option<String>,
}

/// "目标驱动 AI 规划"返回结构：批次内一次性生成所有产出，由前端在预览页勾选后落库
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFromGoalResponse {
    /// AI 拆出的待办（带四象限标注）
    pub tasks: Vec<TaskSuggestion>,
    /// AI 拆出的阶段里程碑（用户可参考但不强制落库）
    #[serde(default)]
    pub milestones: Vec<MilestoneDraft>,
    /// 整体规划思路（一段话）
    pub summary: Option<String>,
    /// 此次生成的批次 ID（服务端生成），前端落库时每条任务都要带上，
    /// 后续可用 undo_task_batch(batch_id) 一键撤销整批。
    /// AI 输出 JSON 时不包含此字段，由 service 层填充，因此反序列化时缺省为空。
    #[serde(default)]
    pub batch_id: String,
    /// 服务端给前端的友好警告（如"Excel 太大，已截断 X 个 Sheet"）；可空
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// "Excel 文件 → AI 规划"入参：用户选一个 Excel/ODS 文件，AI 据此拆任务
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFromExcelRequest {
    /// 用户选择的 Excel 文件绝对路径（来自 Tauri dialog）
    pub file_path: String,
    /// 计划周期天数；默认 30
    #[serde(default = "default_horizon_days")]
    pub horizon_days: i32,
    /// 起始日期 'YYYY-MM-DD'；缺省取今天
    pub start_date: Option<String>,
    /// 用户对 Excel 内容的额外说明（可选），例如"重点关注健身部分"
    pub extra_goal: Option<String>,
}

// ─── AI 会话附件（路线 A：导入文件给 AI 会话用） ──────────

/// Excel/ODS 附件解析预览。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelPreview {
    pub file_path: String,
    pub display_name: String,
    pub markdown: String,
    pub total_rows: usize,
    pub truncated_sheets: Vec<String>,
    pub chars_estimated: usize,
}

/// 文本类附件（md / txt / json / 代码等）解析预览。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub file_path: String,
    pub display_name: String,
    pub content: String,
    pub total_lines: usize,
    pub chars_estimated: usize,
    /// 单文件超 60k 字符时尾部被截断
    pub truncated: bool,
}

/// PDF 附件解析预览（仅文字层抽取）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPreview {
    pub file_path: String,
    pub display_name: String,
    pub content: String,
    pub chars_estimated: usize,
    pub truncated: bool,
}

/// 统一的附件解析预览（按文件扩展名自动分发到 Excel/Text/PDF）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachmentPreview {
    Excel(ExcelPreview),
    Text(TextPreview),
    Pdf(PdfPreview),
}

/// 发送给 AI 的消息附件。tagged enum：kind=excel/text/pdf。
/// 内容字段已是预解析结果，直接拼到 user message 前，发送时不再读盘
/// （避免文件被改/删后行为不一致）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(dead_code)] // file_path 仅用于反序列化追溯，build_message_with_attachments 不读
pub enum MessageAttachment {
    Excel {
        #[serde(rename = "filePath")]
        file_path: String,
        #[serde(rename = "displayName")]
        display_name: String,
        markdown: String,
        #[serde(rename = "totalRows")]
        total_rows: usize,
        #[serde(rename = "truncatedSheets", default)]
        truncated_sheets: Vec<String>,
    },
    Text {
        #[serde(rename = "filePath")]
        file_path: String,
        #[serde(rename = "displayName")]
        display_name: String,
        content: String,
        #[serde(default)]
        truncated: bool,
    },
    Pdf {
        #[serde(rename = "filePath")]
        file_path: String,
        #[serde(rename = "displayName")]
        display_name: String,
        content: String,
        #[serde(default)]
        truncated: bool,
    },
}

// ─── AI 写笔记并归档（T-006） ──────────────

/// 笔记目标长度
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetLength {
    Short,  // 短，100~300 字
    Medium, // 中等，300~800 字（默认）
    Long,   // 长篇，800~2000 字
}

impl Default for TargetLength {
    fn default() -> Self {
        Self::Medium
    }
}

impl TargetLength {
    /// 给模型看的字数要求提示
    pub fn word_hint(&self) -> &'static str {
        match self {
            Self::Short => "100~300 字",
            Self::Medium => "300~800 字",
            Self::Long => "800~2000 字",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftNoteRequest {
    /// 笔记主题（必填）
    pub topic: String,
    /// 参考材料（可选；用户提供的背景/要点/链接等）
    pub reference: Option<String>,
    /// 目标长度；缺省用 Medium
    #[serde(default)]
    pub target_length: TargetLength,
}

/// AI 生成的笔记草稿（未写入 DB；前端 Modal 展示后用户确认才真正保存）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftNoteResponse {
    pub title: String,
    /// Markdown 正文
    pub content: String,
    /// AI 建议的目录路径，如 "工作/周报"；空串 = 根目录
    pub folder_path: String,
    /// AI 给出的"为什么归到这个目录"的理由；前端折叠展示
    pub reason: Option<String>,
}

/// 创建提示词模板的入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplateInput {
    pub title: String,
    pub description: Option<String>,
    pub prompt: String,
    /// 'replace' | 'append' | 'popup'，省略则用 'replace'
    pub output_mode: Option<String>,
    pub icon: Option<String>,
    /// 所属分组；新建省略时落到默认组（快捷指令）
    pub group_id: Option<i64>,
    /// 省略视为末尾（会取同组 max(sort_order)+10）
    pub sort_order: Option<i32>,
    /// 省略视为启用
    pub enabled: Option<bool>,
}

// ─── T-024 同步架构 V1 ─────────────────────────

/// 同步后端类型
///
/// `local` 写到用户磁盘上的某个目录（最简单、零网络风险，常用作"挂同步盘"路径）；
/// `webdav` 走现有 WebDAV 客户端；`s3` / `git` 后续阶段实现
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SyncBackendKind {
    Local,
    Webdav,
    S3,
}

/// 同步后端配置（DB 行）
///
/// `config_json` 内的字段随 `kind` 不同：
/// - `Local`：`{"path": "..."}`
/// - `Webdav`：`{"url": "...", "username": "...", "password_encrypted": "..."}`
/// - `S3`：`{"endpoint": "...", "region": "...", "bucket": "...", "access_key": "...", "secret_key_encrypted": "..."}`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBackend {
    pub id: i64,
    pub kind: SyncBackendKind,
    pub name: String,
    pub config_json: String,
    pub enabled: bool,
    pub auto_sync: bool,
    pub sync_interval_min: i64,
    pub last_push_ts: Option<String>,
    pub last_pull_ts: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建/更新同步后端配置入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBackendInput {
    pub kind: SyncBackendKind,
    pub name: String,
    pub config_json: String,
    pub enabled: Option<bool>,
    pub auto_sync: Option<bool>,
    pub sync_interval_min: Option<i64>,
}

/// 远端同步状态（DB 行，per-backend per-note）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRemoteState {
    pub backend_id: i64,
    pub note_id: i64,
    pub remote_path: String,
    pub last_synced_hash: String,
    pub last_synced_ts: String,
    pub tombstone: bool,
}

/// V1 同步 manifest 中的单条记录
///
/// 序列化为 manifest.json 上传到远端。设计要点：
/// 1. **note_id 不直接用本地自增 id**：用 stable_uuid（笔记表加列存）防止多端 id 冲突
///    - **本会话先用本地 id 当 stable_uuid**，T-024 后续阶段再加 uuid 列做严格去重
/// 2. **content_hash 是 SHA-256(title + "\n" + body)**：标题改动也算变更
/// 3. **tombstone**：删除的笔记保留一条 manifest 项让其他端知道要删
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// 稳定 ID（v1 临时 = 本地笔记 id 的字符串形式）
    pub stable_id: String,
    pub title: String,
    /// 笔记内容指纹，hex 小写
    pub content_hash: String,
    /// ISO-8601 / 本地时间字符串（来自 notes.updated_at）
    pub updated_at: String,
    /// 远端 .md 文件路径（相对 vault 根，正斜杠分隔）
    pub remote_path: String,
    /// 是否已删除（tombstone）
    #[serde(default)]
    pub tombstone: bool,
    /// 文件夹路径（如 "工作/周报"）；根层为空串。
    #[serde(default)]
    pub folder_path: String,
    /// 是否加密笔记
    #[serde(default)]
    pub encrypted: bool,
    /// 是否每日笔记
    #[serde(default)]
    pub is_daily: bool,
    /// 每日笔记日期
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_date: Option<String>,
    /// 是否隐藏笔记
    #[serde(default)]
    pub is_hidden: bool,
    /// 标签名列表；None = 旧客户端（不动本地关联）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// 笔记类型："markdown" / "whiteboard"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_type: Option<String>,
}

/// V1 同步顶层携带的 vault 元数据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultMeta {
    pub salt: String,
    pub verifier: String,
}

/// V1 同步 manifest（远端 manifest.json 全文）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifestV1 {
    /// manifest schema 版本（恒为 1）
    pub manifest_version: u32,
    /// 应用版本（生成 manifest 的客户端，仅供调试）
    pub app_version: String,
    /// 设备名（hostname；多端冲突排查用）
    pub device: String,
    /// 生成时间
    pub generated_at: String,
    /// 全部笔记条目（含 tombstone）
    pub entries: Vec<ManifestEntry>,
    /// hash 算法标识："v2" = SHA-256(title + "\n" + notes.content_hash)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash_algo: Option<String>,
    /// vault 元数据（salt + verifier）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault: Option<VaultMeta>,
    /// sidecar CAS 附件清单
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentEntry>,
    /// 项目跨端同步条目（必须排在 tasks 之前）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<ProjectManifestEntry>,
    /// 任务跨端同步条目
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tasks: Vec<TaskManifestEntry>,
    /// 任务分类条目
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_categories: Vec<TaskCategoryManifestEntry>,
}

impl SyncManifestV1 {
    pub const VERSION: u32 = 1;
    pub const HASH_ALGO_V2: &'static str = "v2";
}

/// 推送结果
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResult {
    /// 上传新增 / 修改的笔记数
    pub uploaded: usize,
    /// 推送删除（tombstone）笔记数
    pub deleted_remote: usize,
    /// 跳过（无变更）数
    pub skipped: usize,
    /// 上传的附件数
    #[serde(default)]
    pub attachments_uploaded: usize,
    /// 跳过的附件数
    #[serde(default)]
    pub attachments_skipped: usize,
    /// 错误清单
    pub errors: Vec<String>,
}

/// 拉取结果
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResult {
    /// 拉取新增 / 更新的笔记数
    pub downloaded: usize,
    /// 应用远端删除标记到本地的笔记数
    pub deleted_local: usize,
    /// 冲突数（远端有变更 + 本地也有变更 → 走 last-write-wins，落败方进 .conflicts/）
    pub conflicts: usize,
    /// 下载的附件数
    #[serde(default)]
    pub attachments_downloaded: usize,
    /// 因 vault meta 不匹配而跳过的加密笔记数
    #[serde(default)]
    pub encrypted_skipped: usize,
    /// 错误清单
    pub errors: Vec<String>,
}

// ─── M5-2: 外部 MCP server 注册表 ─────────────────────────────────

/// 用户在「设置 → MCP 服务器」里添加的一个外部 MCP server。
/// 主应用通过 services::mcp_client::McpClientManager spawn 子进程并维持 client。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: i64,
    /// 用户取的别名（如 "github" / "高德地图"），唯一
    pub name: String,
    /// 传输方式："stdio"（v1 仅此一种）
    pub transport: String,
    /// 可执行文件路径或命令名
    pub command: String,
    /// 命令行参数（前端传 string[]，后端用 JSON 串持久化）
    pub args: Vec<String>,
    /// 环境变量（前端传 Record<string, string>）
    pub env: std::collections::HashMap<String, String>,
    /// 启用 / 禁用
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建/更新 server 时前端传入的 payload
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    pub name: String,
    #[serde(default = "default_transport")]
    pub transport: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_transport() -> String {
    "stdio".into()
}
fn default_enabled() -> bool {
    true
}

// ─── 语音识别（ASR）─────────────────────────────
//
// 抽象一层 AsrProvider，先实现阿里云 DashScope（qwen3-asr-flash-filetrans / paraformer-v2）。
// 配置存到 app_config 表（KV 形式），key 前缀 `asr.*`：
//   asr.provider / asr.api_key / asr.model / asr.region / asr.enabled

/// ASR 服务商类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AsrProviderKind {
    /// 阿里云百炼 DashScope
    Dashscope,
}

impl AsrProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Dashscope => "dashscope",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "dashscope" => Some(Self::Dashscope),
            _ => None,
        }
    }
}

/// ASR 配置（前端展示与保存共用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrConfig {
    pub provider: AsrProviderKind,
    /// API Key（明文存 app_config，与现有 ai_models.api_key 风格一致）
    pub api_key: String,
    /// 模型 ID，如 `qwen3-asr-flash-filetrans` / `paraformer-v2`
    pub model: String,
    /// 区域："beijing"（默认）/ "singapore"
    pub region: String,
    pub enabled: bool,
}

impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            provider: AsrProviderKind::Dashscope,
            api_key: String::new(),
            // 同步多模态 API，支持 base64 直传，无需轮询
            model: "qwen3-asr-flash".into(),
            region: "beijing".into(),
            enabled: false,
        }
    }
}

/// 转录请求入参（前端把录音 base64 + mime 传过来）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    /// 音频 base64（不含 data:xxx;base64, 前缀）
    pub audio_base64: String,
    /// 音频 MIME，如 "audio/wav" / "audio/mpeg" / "audio/webm;codecs=opus"
    pub mime: String,
    /// 语言提示，可选（zh / en / auto）；缺省 auto
    pub language: Option<String>,
}

/// 转录结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeResult {
    /// 识别出的完整文本
    pub text: String,
    /// 端到端耗时（毫秒，含轮询）
    pub latency_ms: u64,
    /// 实际使用的模型
    pub model: String,
}

/// 连接测试结果（"测试连接"按钮用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    /// 失败时的简短中文原因；成功时为 None
    pub message: Option<String>,
}

// ─── 闪卡 + FSRS 复习 ───────────────────────────────────────────

/// 闪卡：正反两面 + FSRS 调度状态。
///
/// FSRS state 取值（与 ts-fsrs State 枚举一致）：
///   0=New（新卡）, 1=Learning（学习中）, 2=Review（复习中）, 3=Relearning（重学）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: i64,
    /// 关联的笔记 ID（从笔记中提炼时设置；笔记删除后变 NULL，卡片仍可保留）
    pub note_id: Option<i64>,
    pub front: String,
    pub back: String,
    /// 套牌名，默认 "default"
    pub deck: String,

    // FSRS 调度状态
    pub due: String,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: i32,
    pub scheduled_days: i32,
    pub reps: i32,
    pub lapses: i32,
    pub state: i32,
    pub last_review: Option<String>,

    pub is_deleted: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建卡片入参（前端 → Rust）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCardInput {
    pub front: String,
    pub back: String,
    /// 缺省时使用 "default"
    pub deck: Option<String>,
    /// 缺省时不关联笔记
    pub note_id: Option<i64>,
}

/// 复习一张卡片入参（前端用 ts-fsrs 算好新状态后传回）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCardInput {
    pub card_id: i64,
    /// 用户评分: 1=Again, 2=Hard, 3=Good, 4=Easy
    pub rating: i32,
    /// 前端 ts-fsrs 算出的新调度状态
    pub state: i32,
    pub due: String,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: i32,
    pub last_elapsed_days: i32,
    pub scheduled_days: i32,
}

/// 卡片复习历史（review_log）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardReviewLog {
    pub id: i64,
    pub card_id: i64,
    pub rating: i32,
    pub state: i32,
    pub due: String,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: i32,
    pub last_elapsed_days: i32,
    pub scheduled_days: i32,
    pub review: String,
}

/// 卡片统计（首页展示"今日待复习/学习中/总数"）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardStats {
    /// 今天到期（含已过期）的待复习数
    pub due_today: i64,
    /// 处于 Learning / Relearning 的卡数
    pub learning: i64,
    /// 处于 Review 的卡数
    pub review: i64,
    /// 状态 New（从未复习过）的卡数
    pub new_cards: i64,
    /// 总卡数（不含已删除）
    pub total: i64,
}

// ─── 插件化待办（阶段 2）─────────────────────────

/// 插件可见的任务过滤条件（精简版，不含内部字段）
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskFilter {
    pub category_id: Option<i64>,
    pub status: Option<String>,
    pub parent_task_id: Option<i64>,
    pub due_before: Option<String>,
    pub due_after: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// 插件可见的任务对象（脱敏，去掉 source_batch_id / reminded_at 等内部字段）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskView {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: i32,
    pub important: bool,
    pub due_at: Option<String>,
    pub remind_before_minutes: Option<i32>,
    pub category_id: Option<i64>,
    pub parent_task_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Task> for PluginTaskView {
    fn from(t: Task) -> Self {
        let status = match t.status {
            0 => "pending",
            1 => "completed",
            _ => "archived",
        };
        PluginTaskView {
            id: t.id,
            title: t.title,
            description: t.description,
            status: status.to_string(),
            priority: t.priority,
            important: t.important,
            due_at: t.due_date,
            remind_before_minutes: t.remind_before_minutes,
            category_id: t.category_id,
            parent_task_id: t.parent_task_id,
            created_at: t.created_at,
            updated_at: t.updated_at,
        }
    }
}

/// 插件可见的任务写入入参（脱敏版，不含内部字段）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCreateTaskInput {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub important: Option<bool>,
    pub due_at: Option<String>,
    pub remind_before_minutes: Option<i32>,
    pub category_id: Option<i64>,
    pub parent_task_id: Option<i64>,
}

/// 插件可见的任务更新入参（脱敏版，不含内部字段）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateTaskInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub important: Option<bool>,
    pub due_at: Option<String>,
    pub remind_before_minutes: Option<i32>,
    pub category_id: Option<i64>,
    pub clear_due_at: Option<bool>,
    pub clear_remind_before_minutes: Option<bool>,
    pub clear_category_id: Option<bool>,
}

// ─── Claude Code Agent Runner ────────────────────

/// Agent 会话状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeAgentStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl std::fmt::Display for ClaudeAgentStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Running => write!(f, "running"),
            Self::Completed => write!(f, "completed"),
            Self::Failed => write!(f, "failed"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}

/// 启动 Agent 入参
#[derive(Debug, Clone, Deserialize)]
pub struct StartClaudeAgentInput {
    pub project_path: String,
    pub prompt: String,
    pub permission_mode: String,
    pub session_name: Option<String>,
}

/// Agent 会话
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeAgentSession {
    pub id: String,
    pub project_path: String,
    pub prompt: String,
    pub session_name: Option<String>,
    pub permission_mode: String,
    pub status: String,
    pub pid: Option<i64>,
    pub exit_code: Option<i32>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// Agent 事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeAgentEvent {
    pub id: i64,
    pub session_id: String,
    pub kind: String,
    pub content: String,
    pub created_at: String,
}

/// 应用锁状态（KB 2.0 合并）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppLockStatus {
    pub enabled: bool,
    pub auto_lock_minutes: i64,
}

// ═══════════════════════════════════════════════════════════════
// KB 2.0 合并：白板 / 快照 / 定时推送模型
// ═══════════════════════════════════════════════════════════════

/// 笔记类型常量。值直接进 SQL、front-matter 与前端 JSON，保持字符串。
pub mod note_type {
    /// 普通 Markdown 笔记（存量默认值）。
    #[allow(dead_code)]
    pub const MARKDOWN: &str = "markdown";
    /// 白板笔记：`notes.content` 存 Excalidraw 场景 JSON。
    pub const WHITEBOARD: &str = "whiteboard";
}

/// 笔记内嵌白板保存后的资源路径（相对 data_dir 的 POSIX 路径）。
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddedWhiteboardSaved {
    /// Excalidraw 场景 JSON 文件
    pub scene_path: String,
    /// 供笔记里直接显示的 PNG 预览图
    pub preview_path: String,
}

/// 快照元信息（列表用，不含正文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSnapshotMeta {
    pub id: i64,
    pub note_id: i64,
    pub byte_size: i64,
    pub reason: String,
    pub created_at: String,
}

/// 快照完整内容（预览 / 回滚用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSnapshot {
    pub id: i64,
    pub note_id: i64,
    pub content: String,
    pub byte_size: i64,
    pub reason: String,
    pub created_at: String,
}

/// 单条笔记的快照占用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotNoteUsage {
    pub note_id: i64,
    pub title: String,
    pub note_type: String,
    pub count: i64,
    pub byte_size: i64,
}

/// 全库快照用量总览。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotUsage {
    pub total_count: i64,
    pub total_bytes: i64,
    pub top_notes: Vec<SnapshotNoteUsage>,
}

/// 白板「笔记卡片」展示的笔记摘要。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteExcerpt {
    pub note_id: i64,
    pub title: String,
    pub excerpt: String,
    pub missing: bool,
}

/// 一条定时推送（订阅）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushJob {
    pub id: i64,
    pub name: String,
    pub prompt: String,
    pub model_id: Option<i64>,
    pub source_kind: String,
    pub source_config: String,
    pub schedule_time: String,
    pub repeat_kind: String,
    pub repeat_weekdays: Option<String>,
    pub channels: String,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 新建推送入参。
#[derive(Debug, Clone, Deserialize)]
pub struct CreatePushJobInput {
    pub name: String,
    pub prompt: String,
    pub model_id: Option<i64>,
    pub source_kind: Option<String>,
    pub source_config: Option<String>,
    pub schedule_time: String,
    pub repeat_kind: Option<String>,
    pub repeat_weekdays: Option<String>,
    pub channels: Option<String>,
    pub enabled: Option<bool>,
}

/// 更新推送入参。
#[derive(Debug, Clone, Deserialize)]
pub struct UpdatePushJobInput {
    pub name: String,
    pub prompt: String,
    pub model_id: Option<i64>,
    pub source_kind: Option<String>,
    pub source_config: Option<String>,
    pub schedule_time: String,
    pub repeat_kind: Option<String>,
    pub repeat_weekdays: Option<String>,
    pub channels: Option<String>,
    pub enabled: Option<bool>,
}

/// 一次推送执行记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushRunLog {
    pub id: i64,
    pub job_id: i64,
    pub run_at: String,
    pub status: String,
    pub item_count: i32,
    pub payload: Option<String>,
    pub error: Option<String>,
}

/// 居中弹窗页所需的一次性数据。
#[derive(Debug, Clone, Serialize)]
pub struct PushPopupData {
    pub name: String,
    pub content: String,
    pub status: String,
    pub run_at: String,
}

// ═══════════════════════════════════════════════════════════════
// KB 2.0 合并：数据集 / 数据视图
// ═══════════════════════════════════════════════════════════════

/// 数据集元信息（Excel 导入后的一张表）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    pub id: i64,
    /// 相对 data_dir 的附件路径
    pub source_path: String,
    pub sheet_name: String,
    pub region_index: i64,
    /// 表头在原始行里的下标；None = 无表头
    pub header_row: Option<i64>,
    pub row_count: i64,
    pub col_count: i64,
    pub created_at: String,
}

/// 列画像。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetField {
    pub col_index: i64,
    pub name: String,
    /// number / date / boolean / text
    pub inferred_type: String,
    /// time / measure / identifier / status / category
    pub semantic_role: Option<String>,
    /// 非空率 0.0~1.0
    pub completeness: f64,
    pub distinct_count: i64,
}

/// 数据集详情 = 元信息 + 列画像。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSchema {
    #[serde(flatten)]
    pub dataset: Dataset,
    pub fields: Vec<DatasetField>,
}

/// 聚合口径白名单。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetMetric {
    Rows,
    Count,
    CountDistinct,
    Sum,
    Avg,
    Min,
    Max,
}

impl DatasetMetric {
    pub fn needs_column(self) -> bool {
        !matches!(self, DatasetMetric::Rows)
    }

    pub fn numeric_only(self) -> bool {
        matches!(self, DatasetMetric::Sum | DatasetMetric::Avg)
    }
}

/// 过滤算子白名单。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetFilterOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    StartsWith,
    EndsWith,
    In,
    IsEmpty,
    IsNotEmpty,
}

impl DatasetFilterOp {
    pub fn needs_value(self) -> bool {
        !matches!(self, DatasetFilterOp::IsEmpty | DatasetFilterOp::IsNotEmpty)
    }

    pub fn numeric_compare(self) -> bool {
        matches!(
            self,
            DatasetFilterOp::Gt | DatasetFilterOp::Gte | DatasetFilterOp::Lt | DatasetFilterOp::Lte
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetFilter {
    pub column: String,
    pub op: DatasetFilterOp,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetSortBy {
    Metric,
    Group,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetSortOrder {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetQueryPlan {
    pub dataset_id: i64,
    #[serde(default)]
    pub filters: Vec<DatasetFilter>,
    #[serde(default)]
    pub group_by: Option<String>,
    pub metric: DatasetMetric,
    #[serde(default)]
    pub metric_column: Option<String>,
    #[serde(default)]
    pub sort_by: Option<DatasetSortBy>,
    #[serde(default)]
    pub sort_order: Option<DatasetSortOrder>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetQueryResult {
    pub rows: Vec<DatasetQueryRow>,
    pub matched_rows: i64,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_values: Option<DatasetSuggestion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetQueryRow {
    pub group: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSuggestion {
    pub column: String,
    pub values: Vec<String>,
}

/// 数据视图的一行（笔记 / 任务统一成可点击条目）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataviewRow {
    pub title: String,
    pub subtitle: Option<String>,
    pub link_kind: String,
    pub link_id: i64,
    pub updated_at: String,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}

/// 任务附件（v65 `task_attachments`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskAttachment {
    pub id: i64,
    pub task_id: i64,
    /// 相对 data_dir 的 POSIX 路径
    pub rel_path: String,
    pub file_name: String,
    pub mime: String,
    pub size: i64,
    pub sort_order: i32,
    pub created_at: String,
}

/// 项目（任务的工作流容器）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub archived: bool,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub active_task_count: i64,
    #[serde(default)]
    pub done_task_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable_uuid: Option<String>,
    #[serde(default)]
    pub is_deleted: bool,
}

/// 创建项目入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// 更新项目入参（字段缺省表示不改）。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub clear_description: Option<bool>,
    pub color: Option<String>,
    pub start_date: Option<String>,
    pub clear_start_date: Option<bool>,
    pub end_date: Option<String>,
    pub clear_end_date: Option<bool>,
    pub archived: Option<bool>,
    pub sort_order: Option<i32>,
}

/// 粘贴图文时 HTML 里引用的图片（草稿预览用）。
#[derive(Debug, Clone, Serialize)]
pub struct PasteImage {
    pub file_name: String,
    pub mime: String,
    pub base64: String,
}

/// 日记条目（daily_import 与日记页共用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyEntry {
    pub id: i64,
    pub title: String,
    /// YYYY-MM-DD
    pub daily_date: String,
    pub updated_at: String,
}

/// 搜索筛选条件（fail-closed 语义）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    pub folder_ids: Option<Vec<i64>>,
    pub tag_ids: Option<Vec<i64>>,
    pub updated_after: Option<String>,
    pub updated_before: Option<String>,
    pub note_types: Option<Vec<String>>,
    pub created_after: Option<String>,
    pub created_before: Option<String>,
    pub title_only: Option<bool>,
}

impl SearchFilters {
    pub fn has_empty_selection(&self) -> bool {
        matches!(&self.folder_ids, Some(v) if v.is_empty())
            || matches!(&self.tag_ids, Some(v) if v.is_empty())
            || matches!(&self.note_types, Some(v) if v.is_empty())
    }
}

/// AI 引用笔记里抽出的图片清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteImageRef {
    pub note_id: i64,
    pub title: String,
    pub images: Vec<String>,
}

// ═══════════════════════════════════════════════════════════════
// KB 2.0 合并：sync_v1 附件与项目/任务清单条目
// ═══════════════════════════════════════════════════════════════

/// 远端 CAS 附件条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentEntry {
    pub hash: String,
    pub size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifestEntry {
    pub stable_id: String,
    pub name: String,
    pub content_hash: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub tombstone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskManifestEntry {
    pub stable_id: String,
    pub title: String,
    pub content_hash: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub important: bool,
    #[serde(default)]
    pub status: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub kanban_stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_uuid: Option<String>,
    #[serde(default)]
    pub repeat_kind: String,
    #[serde(default)]
    pub repeat_interval: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_weekdays: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_count: Option<i32>,
    #[serde(default)]
    pub tombstone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCategoryManifestEntry {
    pub stable_id: String,
    pub name: String,
    pub content_hash: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_stable_id: Option<String>,
}

/// Claude Code CLI 安装与版本信息（POM 专有）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeCliInfo {
    pub available: bool,
    pub version: Option<String>,
    pub config_path: Option<String>,
    pub config_exists: bool,
    pub mcp_installed: bool,
    pub mcp_writable: bool,
    pub error: Option<String>,
}

// ─── 外部目录挂载 ─────────────────────────────

/// 按文件类别开关同步
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncTypeSettings {
    #[serde(default = "sync_default_true")]
    pub text: bool,
    #[serde(default = "sync_default_true")]
    pub pdf: bool,
    #[serde(default = "sync_default_true")]
    pub word: bool,
    #[serde(default = "sync_default_true")]
    pub sheet: bool,
    /// PowerPoint（.pptx / .pptm）。旧挂载点 JSON 没有该字段时默认开启。
    #[serde(default = "sync_default_true")]
    pub slide: bool,
    /// 扫描件 PDF 是否用本地 OCR 补索引。默认关闭：OCR 明显慢于文本抽取。
    #[serde(default)]
    pub ocr: bool,
}

impl Default for SyncTypeSettings {
    fn default() -> Self {
        Self {
            text: true,
            pdf: true,
            word: true,
            sheet: true,
            slide: true,
            ocr: false,
        }
    }
}

impl SyncTypeSettings {
    pub fn enabled_category(&self, category: &str) -> bool {
        match category {
            "text" => self.text,
            "pdf" => self.pdf,
            "word" => self.word,
            "sheet" => self.sheet,
            "slide" => self.slide,
            _ => false,
        }
    }
}

fn sync_default_true() -> bool {
    true
}

/// 一个外部目录挂载点。文件仍在磁盘上，`notes` 表只保存索引用的影子行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMount {
    pub id: i64,
    pub name: String,
    pub root_path: String,
    pub root_folder_id: Option<i64>,
    pub read_only: bool,
    pub index_enabled: bool,
    pub daily_mode: bool,
    pub scan_interval: i64,
    #[serde(default)]
    pub sync_types: SyncTypeSettings,
    pub created_at: String,
    pub last_scan_at: Option<String>,
    /// 已索引的笔记数（不含缺失）
    pub note_count: usize,
    /// 源文件已消失的笔记数
    pub missing_count: usize,
    /// 根目录当前是否可访问
    pub available: bool,
}

/// 新增挂载点入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMountInput {
    pub name: String,
    pub root_path: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default = "mount_default_true")]
    pub index_enabled: bool,
    #[serde(default)]
    pub daily_mode: bool,
    #[serde(default = "mount_default_scan_interval")]
    pub scan_interval: i64,
    #[serde(default)]
    pub sync_types: SyncTypeSettings,
}

fn mount_default_true() -> bool {
    true
}

fn mount_default_scan_interval() -> i64 {
    10
}

/// 更新挂载点设置（只更新传入的字段）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMountUpdate {
    pub name: Option<String>,
    pub read_only: Option<bool>,
    pub index_enabled: Option<bool>,
    pub daily_mode: Option<bool>,
    pub scan_interval: Option<i64>,
    pub sync_types: Option<SyncTypeSettings>,
}

/// 一次扫描的结果
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountScanResult {
    pub mount_id: i64,
    pub scanned: usize,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub stale: usize,
    pub missing: usize,
    pub errors: Vec<String>,
}

/// 扫描进度（事件 `mount:scan-progress`）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountScanProgress {
    pub mount_id: i64,
    pub current: usize,
    pub total: usize,
    pub file_name: String,
}

/// 外部目录中的一个文件条目（前端用它构建树）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEntry {
    pub note_id: i64,
    pub rel_path: String,
    pub title: String,
    pub missing: bool,
    pub mtime: i64,
    /// 原文件已更新，但影子笔记有本地编辑，未自动覆盖
    pub stale: bool,
    /// 抽取状态：ok / failed / scanned / encrypted / unsupported
    pub status: Option<String>,
    pub error: Option<String>,
    /// 原文件类型：md / txt / pdf / docx / doc / xlsx / csv ...
    pub source_type: Option<String>,
    /// 原文件大小（字节）
    pub size: i64,
    /// 影子笔记是否被本地编辑过
    pub user_edited: bool,
    /// 上次抽取时间
    pub last_synced_at: Option<String>,
    /// synced / stale / failed / missing / paused
    pub sync_state: String,
    /// text / pdf / word / slide / sheet
    pub type_category: Option<String>,
    /// 原文件绝对路径（挂载根 + 相对路径），供 Office 工作台直接打开
    pub abs_path: String,
}

/// 打开外部文件的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountOpenResult {
    pub note_id: i64,
    pub content: String,
    pub rel_path: String,
    pub read_only: bool,
    pub missing: bool,
    /// 原文件已更新，但影子笔记有本地编辑，未自动覆盖
    pub stale: bool,
    /// 影子笔记是否被用户编辑过（content_hash != ext_indexed_hash）
    pub user_edited: bool,
    /// 抽取状态：ok / failed / scanned / encrypted / unsupported
    pub status: Option<String>,
    pub error: Option<String>,
    pub source_type: Option<String>,
}

/// 保存外部文件的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountSaveResult {
    pub note_id: i64,
    pub mtime: i64,
    pub size: i64,
    pub hash: String,
}

/// 外部影子笔记的陈旧状态（编辑器/挂载页查询用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountNoteStatus {
    pub note_id: i64,
    /// 是否外部挂载笔记
    pub external: bool,
    /// 挂载点是否只读（只读时不能写回标签 / 内容）
    pub read_only: bool,
    pub stale: bool,
    pub user_edited: bool,
    pub status: Option<String>,
    pub error: Option<String>,
    pub source_type: Option<String>,
    /// 源文件扩展名（小写）；只读挂载点没有 source_type 时靠它判断是否 Markdown
    pub source_ext: Option<String>,
    pub indexed_at: Option<String>,
    /// 源文件当前 mtime（秒）
    pub source_mtime: i64,
    /// 上次抽取时记录的源文件 mtime（秒）
    pub indexed_mtime: Option<i64>,
}
