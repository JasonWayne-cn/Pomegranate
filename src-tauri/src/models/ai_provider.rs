//! AI Provider 抽象层 — 数据模型与 Trait 定义
//!
//! 借鉴 WorkAny BaseProviderRegistry 的泛型注册表设计模式，
//! 在 Rust 侧实现多 AI 提供商（DeepSeek / OpenAI / Ollama）的统一抽象。

use async_trait::async_trait;
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::pin::Pin;

use crate::error::AppError;

// ─── 能力描述 ───────────────────────────────────

/// AI 提供商能力描述
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiCapabilities {
    /// 是否支持流式输出
    pub supports_streaming: bool,
    /// 是否支持视觉输入（图片理解）
    pub supports_vision: bool,
    /// 是否支持 Function Calling / Tool Use
    pub supports_function_calling: bool,
    /// 是否原生支持 `response_format: {"type":"json_object"}`
    ///
    /// Ollama 原生 /api/chat 与部分 Claude 代理不认这个字段，需要退化为
    /// prompt 约束（或直接拒绝 JSON 专用功能）。
    pub supports_json_mode: bool,
    /// 最大输出 token 数（None = 未知/模型决定）
    pub max_output_tokens: Option<u32>,
}

// ─── 协议 ───────────────────────────────────────

/// 提供商使用的线协议
///
/// 主链路只依赖此枚举做协议分发，不再比较 `provider` 字符串。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    /// OpenAI 兼容 `chat/completions`（OpenAI / DeepSeek / 智谱 / Claude 代理等）
    OpenAiCompatible,
    /// Ollama 原生 `/api/chat`
    Ollama,
}

// ─── 流式事件 ───────────────────────────────────

/// Provider 输出的协议无关流式事件
///
/// 由具体实现完成 SSE / NDJSON 解析，调用方只负责聚合与前端事件推送。
#[derive(Debug, Clone)]
pub enum ProviderStreamEvent {
    /// 正文增量
    Content(String),
    /// 推理模型思考过程增量（reasoning_content）
    Reasoning(String),
    /// 工具调用增量（OpenAI 流式分片，按 index 聚合）
    ToolCallDelta {
        index: u64,
        id: Option<String>,
        name: Option<String>,
        arguments: Option<String>,
    },
    /// 流正常结束
    Finish { reason: Option<String> },
}

/// 动态分发的 Provider 流
pub type ProviderStream =
    Pin<Box<dyn Stream<Item = Result<ProviderStreamEvent, AppError>> + Send>>;

// ─── 元数据 ─────────────────────────────────────

/// AI 提供商元数据（暴露给前端的选择列表）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProviderMetadata {
    /// 唯一标识: "deepseek" | "openai" | "ollama"
    pub provider_type: String,
    /// 显示名称: "DeepSeek" | "OpenAI" | "Ollama"
    pub display_name: String,
    /// 描述文本
    pub description: String,
    /// 默认 API 地址（用户可覆盖）
    pub default_base_url: String,
    /// 默认模型标识
    pub default_model: String,
    /// 此 Provider 的能力
    pub capabilities: AiCapabilities,
}

// ─── Provider 配置 ──────────────────────────────

/// AI Provider 运行时配置（从 AiModel 持久化记录派生）
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AiProviderConfig {
    /// 提供商类型: "deepseek" | "openai" | "ollama" | "claude" | ...
    pub provider_type: String,
    /// 协议（可选）：openai_compatible / anthropic / ollama
    #[serde(default)]
    pub protocol: Option<String>,
    /// API 基础 URL
    pub api_url: String,
    /// API Key（可为空，如本地 Ollama）
    pub api_key: Option<String>,
    /// 模型标识
    pub model_id: String,
    /// 模型最大上下文 token 数
    pub max_context: Option<i64>,
    /// 模型是否支持工具调用（来自 AiModel）
    #[serde(default)]
    pub supports_tools: Option<bool>,
    /// 模型是否支持视觉输入
    #[serde(default)]
    pub supports_vision: Option<bool>,
    /// 模型最大输出 token 数
    #[serde(default)]
    pub max_output_tokens: Option<i64>,
}

impl AiProviderConfig {
    /// 判定协议：优先使用显式 protocol 字段，兼容存量配置里的 `provider == "ollama"`。
    pub fn protocol_kind(&self) -> ProviderProtocol {
        if self.protocol.as_deref() == Some("ollama")
            || self.provider_type.eq_ignore_ascii_case("ollama")
        {
            ProviderProtocol::Ollama
        } else {
            ProviderProtocol::OpenAiCompatible
        }
    }

    /// 由配置推导能力，供主链路做能力驱动判断。
    pub fn capabilities(&self) -> AiCapabilities {
        let protocol = self.protocol_kind();
        let is_anthropic = self.protocol.as_deref() == Some("anthropic")
            || self.provider_type.to_ascii_lowercase().contains("claude");
        let is_ollama = protocol == ProviderProtocol::Ollama;

        AiCapabilities {
            supports_streaming: true,
            supports_vision: if is_ollama {
                false
            } else {
                self.supports_vision.unwrap_or(true)
            },
            supports_function_calling: if is_ollama {
                false
            } else {
                self.supports_tools.unwrap_or(true)
            },
            supports_json_mode: !is_ollama && !is_anthropic,
            max_output_tokens: self
                .max_output_tokens
                .and_then(|n| u32::try_from(n).ok()),
        }
    }
}

// ─── AI Provider Trait ──────────────────────────

/// AI 提供商统一接口
///
/// 每个具体的 AI Provider（DeepSeek / OpenAI / Ollama）必须实现此 trait。
/// 使用 `#[async_trait]` 以支持 async fn 在 trait 中。
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// 返回此 Provider 的元数据
    fn metadata(&self) -> &AiProviderMetadata;

    /// 返回此 Provider 的能力
    fn capabilities(&self) -> &AiCapabilities;

    /// 初始化 Provider（验证配置、预热连接等）
    async fn init(&self) -> Result<(), AppError> {
        Ok(())
    }

    /// 此 Provider 使用的线协议
    fn protocol(&self) -> ProviderProtocol {
        ProviderProtocol::OpenAiCompatible
    }

    /// 统一流式入口
    ///
    /// - `messages` 为 OpenAI 格式的完整消息数组（可含 tool / tool_calls）
    /// - `tools` 为空表示不启用工具调用
    ///
    /// 返回协议无关的事件流；取消、前端事件推送、tool_calls 聚合由调用方负责。
    async fn stream_chat(
        &self,
        messages: Vec<Value>,
        tools: Vec<Value>,
    ) -> Result<ProviderStream, AppError>;

    /// 关闭 Provider，释放资源
    async fn shutdown(&self) -> Result<(), AppError> {
        Ok(())
    }
}

// ─── Provider 插件（内部用，不序列化）───────────

/// AI Provider 插件定义
///
/// 由注册表持有，包含元数据和工厂函数。
/// 工厂闭包需要 `Send + Sync` 以支持跨线程注册。
pub struct AiProviderPlugin {
    /// 插件元数据
    pub metadata: AiProviderMetadata,
    /// 工厂函数：根据配置创建 AiProvider 实例
    /// 使用 `Arc<dyn AiProvider>` 方便注册表中共享引用
    pub factory: Box<
        dyn Fn(AiProviderConfig) -> Result<std::sync::Arc<dyn AiProvider>, AppError>
            + Send
            + Sync,
    >,
}

// ─── 工具函数 ──────────────────────────────────

/// 切换 Provider 入参（从 AiModel ID 懒加载配置）
#[derive(Debug, Clone, Deserialize)]
pub struct SwitchProviderInput {
    /// 目标 Provider 类型: "deepseek" | "openai_compatible"
    pub provider_type: String,
    /// 使用的 AiModel 记录 ID（从数据库加载完整配置）
    pub model_id: i64,
}

/// 活跃 Provider 信息（返回给前端，不包含 api_key）
#[derive(Debug, Clone, Serialize)]
pub struct ActiveProviderInfo {
    pub provider_type: String,
    pub display_name: String,
    pub model_id: String,
    pub capabilities: AiCapabilities,
}

/// 从现有 AiModel 记录构造 AiProviderConfig
///
/// 当用户选择"使用已保存的模型"时，从 DB 读取并转为注册表可用的配置。
impl AiProviderConfig {
    pub fn from_ai_model(
        provider: &super::AiModel,
    ) -> Self {
        Self {
            provider_type: provider.provider.clone(),
            protocol: Some(provider.protocol.clone()),
            api_url: provider.api_url.clone(),
            api_key: provider.api_key.clone(),
            model_id: provider.model_id.clone(),
            max_context: Some(provider.max_context),
            supports_tools: Some(provider.supports_tools),
            supports_vision: Some(provider.supports_vision),
            max_output_tokens: provider.max_output_tokens,
        }
    }
}
