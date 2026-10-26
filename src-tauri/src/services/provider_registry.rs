//! AI Provider 注册表 — 借鉴 WorkAny BaseProviderRegistry 的泛型注册表模式
//!
//! 管理多个 AI 提供商（DeepSeek / OpenAI 兼容 / Ollama）的注册、切换和生命周期。
//!
//! API 对照 WorkAny:
//! - register()              → BaseProviderRegistry.register()
//! - unregister()            → BaseProviderRegistry.unregister()
//! - has()                   → BaseProviderRegistry.has()
//! - get_metadata()          → BaseProviderRegistry.getMetadata()
//! - get_all_metadata()      → BaseProviderRegistry.getAllMetadata()
//! - list_registered()       → BaseProviderRegistry.getRegistered()
//! - switch()                → ProviderManagerImpl.switchAgentProvider()
//! - get_active()            → ProviderManagerImpl.getAgentProvider()
//! - get_active_type()       → 新增

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, OnceLock, RwLock};

use futures::stream::{Stream, StreamExt};
use reqwest::Client;
use serde_json::{json, Value};
use std::pin::Pin;

use crate::error::AppError;
use crate::models::ai_provider::{
    AiCapabilities, AiProvider, AiProviderConfig, AiProviderMetadata, AiProviderPlugin,
    ProviderProtocol, ProviderStream, ProviderStreamEvent,
};
use crate::services::ai::{
    build_ollama_client, build_openai_chat_url, format_ollama_send_error, format_openai_api_error,
};
use crate::services::http_client;

// ─── 全局单例 ──────────────────────────────────

static REGISTRY: std::sync::LazyLock<AiProviderRegistry> =
    std::sync::LazyLock::new(AiProviderRegistry::new);

/// 获取全局 AI Provider 注册表单例
pub fn get_provider_registry() -> &'static AiProviderRegistry {
    &REGISTRY
}

// ─── 注册表实现 ─────────────────────────────────

/// AI Provider 注册表
///
/// 线程安全：plugins 在初始化后只读，active 通过 RwLock 保护。
pub struct AiProviderRegistry {
    /// 已注册的 Provider 插件（按 provider_type 索引）
    plugins: RwLock<HashMap<String, AiProviderPlugin>>,
    /// 当前活跃的 Provider 实例
    active: RwLock<Option<Arc<dyn AiProvider>>>,
    /// 当前活跃 Provider 的类型
    active_type: RwLock<String>,
    /// 当前活跃 Provider 对应的完整配置（用于复用实例）
    active_config: RwLock<Option<AiProviderConfig>>,
}

impl AiProviderRegistry {
    /// 创建空的注册表
    fn new() -> Self {
        Self {
            plugins: RwLock::new(HashMap::new()),
            active: RwLock::new(None),
            active_type: RwLock::new(String::new()),
            active_config: RwLock::new(None),
        }
    }

    // ─── Provider 解析 ─────────────────────────

    /// 根据模型配置解析出可用的 Provider 实例。
    ///
    /// 若当前活跃 Provider 的配置完全一致则直接复用，否则按协议创建新实例。
    pub fn resolve(&self, config: &AiProviderConfig) -> Result<Arc<dyn AiProvider>, AppError> {
        if let Some(active) = self.get_active() {
            let matches = self
                .active_config
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .is_some_and(|active_cfg| active_cfg == config);
            if matches {
                return Ok(active);
            }
        }
        self.create(config)
    }

    /// 按配置创建（不切换 active），供按会话模型懒解析。
    fn create(&self, config: &AiProviderConfig) -> Result<Arc<dyn AiProvider>, AppError> {
        let key = match config.protocol_kind() {
            ProviderProtocol::Ollama => "ollama",
            ProviderProtocol::OpenAiCompatible
                if config.provider_type.eq_ignore_ascii_case("deepseek") =>
            {
                "deepseek"
            }
            ProviderProtocol::OpenAiCompatible => "openai_compatible",
        };

        let plugins = self.plugins.read().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] plugins lock poisoned: {}", e);
            e.into_inner()
        });

        // 未注册的具体厂商（claude / zhipu / lmstudio / custom …）统一回退到
        // OpenAI 兼容实现；协议差异由配置推导的能力表达。
        let plugin = plugins
            .get(key)
            .or_else(|| plugins.get("openai_compatible"))
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "Provider 类型未注册: {}。已注册: {:?}",
                    key,
                    plugins.keys().collect::<Vec<_>>()
                ))
            })?;

        (plugin.factory)(config.clone())
    }

    // ─── 注册 / 注销 ──────────────────────────

    /// 注册一个 Provider 插件
    ///
    /// 如果同类型已存在，会覆盖（并打印警告日志）。
    pub fn register(&self, plugin: AiProviderPlugin) {
        let provider_type = plugin.metadata.provider_type.clone();
        let mut plugins = self.plugins.write().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] plugins lock poisoned: {}", e);
            e.into_inner()
        });

        if plugins.contains_key(&provider_type) {
            log::warn!(
                "[ProviderRegistry] Overwriting existing provider: {}",
                provider_type
            );
        }

        log::info!(
            "[ProviderRegistry] Registered provider: {} ({})",
            provider_type,
            plugin.metadata.display_name
        );

        plugins.insert(provider_type, plugin);
    }

    /// 注销一个 Provider
    pub fn unregister(&self, provider_type: &str) {
        let mut plugins = self.plugins.write().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] plugins lock poisoned: {}", e);
            e.into_inner()
        });

        if plugins.remove(provider_type).is_some() {
            log::info!("[ProviderRegistry] Unregistered provider: {}", provider_type);
        }
    }

    /// 检查 Provider 类型是否已注册
    pub fn has(&self, provider_type: &str) -> bool {
        let plugins = self.plugins.read().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] plugins lock poisoned: {}", e);
            e.into_inner()
        });
        plugins.contains_key(provider_type)
    }

    // ─── 元数据查询 ────────────────────────────

    /// 获取指定 Provider 的元数据
    pub fn get_metadata(&self, provider_type: &str) -> Option<AiProviderMetadata> {
        let plugins = self.plugins.read().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] plugins lock poisoned: {}", e);
            e.into_inner()
        });
        plugins.get(provider_type).map(|p| p.metadata.clone())
    }

    /// 获取所有已注册 Provider 的元数据
    pub fn get_all_metadata(&self) -> Vec<AiProviderMetadata> {
        let plugins = self.plugins.read().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] plugins lock poisoned: {}", e);
            e.into_inner()
        });
        plugins.values().map(|p| p.metadata.clone()).collect()
    }

    /// 列出所有已注册的 Provider 类型
    pub fn list_registered(&self) -> Vec<String> {
        let plugins = self.plugins.read().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] plugins lock poisoned: {}", e);
            e.into_inner()
        });
        plugins.keys().cloned().collect()
    }

    // ─── 活跃 Provider 管理 ─────────────────────

    /// 切换到指定 Provider
    ///
    /// 根据 provider_type 查找已注册的插件，调用工厂创建实例，
    /// 并设为活跃。旧的活跃 Provider 会被 shutdown。
    pub async fn switch(&self, config: AiProviderConfig) -> Result<(), AppError> {
        let provider_type = config.provider_type.clone();

        // 1. 创建 Provider 实例（工厂调用不耗时）
        let new_provider = self.create(&config)?;

        // 2. 初始化新 Provider
        new_provider.init().await?;

        // 3. 关闭旧 Provider
        let old = {
            let mut active = self.active.write().unwrap_or_else(|e| {
                log::error!("[ProviderRegistry] active lock poisoned: {}", e);
                e.into_inner()
            });
            let old = active.take();
            *active = Some(new_provider);
            old
        };
        {
            let mut at = self.active_type.write().unwrap_or_else(|e| {
                log::error!("[ProviderRegistry] active_type lock poisoned: {}", e);
                e.into_inner()
            });
            *at = provider_type.clone();
        }
        {
            let mut ac = self.active_config.write().unwrap_or_else(|e| {
                log::error!("[ProviderRegistry] active_config lock poisoned: {}", e);
                e.into_inner()
            });
            *ac = Some(config);
        }

        if let Some(old) = old {
            if let Err(e) = old.shutdown().await {
                log::warn!("[ProviderRegistry] 关闭旧 Provider 失败: {}", e);
            }
        }

        log::info!("[ProviderRegistry] 已切换到 Provider: {}", provider_type);
        Ok(())
    }

    /// 获取当前活跃的 Provider 实例
    pub fn get_active(&self) -> Option<Arc<dyn AiProvider>> {
        let active = self.active.read().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] active lock poisoned: {}", e);
            e.into_inner()
        });
        active.clone()
    }

    /// 获取当前活跃 Provider 的类型标识
    pub fn get_active_type(&self) -> String {
        let active_type = self.active_type.read().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] active_type lock poisoned: {}", e);
            e.into_inner()
        });
        active_type.clone()
    }

    /// 关闭所有 Provider
    pub async fn shutdown_all(&self) {
        let mut active = self.active.write().unwrap_or_else(|e| {
            log::error!("[ProviderRegistry] active lock poisoned: {}", e);
            e.into_inner()
        });
        if let Some(provider) = active.take() {
            if let Err(e) = provider.shutdown().await {
                log::warn!("[ProviderRegistry] shutdown 失败: {}", e);
            }
        }
        *self
            .active_config
            .write()
            .unwrap_or_else(|e| e.into_inner()) = None;
        log::info!("[ProviderRegistry] 所有 Provider 已关闭");
    }
}

// ─── 内置 Provider: OpenAI 兼容（DeepSeek / OpenAI / Ollama 通用）───

/// 默认能力：支持流式，不支持视觉 / 工具 / JSON 原生模式
const DEFAULT_CAPABILITIES: AiCapabilities = AiCapabilities {
    supports_streaming: true,
    supports_vision: false,
    supports_function_calling: false,
    supports_json_mode: false,
    max_output_tokens: None,
};

/// OpenAI 兼容 Provider — 通用 HTTP 流式客户端
///
/// 通过调整 base_url + model 可兼容 DeepSeek / OpenAI / OpenRouter 等
/// 所有提供 OpenAI 兼容 API 的服务。
pub struct OpenAiCompatibleProvider {
    metadata: AiProviderMetadata,
    config: RwLock<AiProviderConfig>,
    http_client: &'static Client,
}

impl OpenAiCompatibleProvider {
    pub fn new(config: AiProviderConfig) -> Self {
        let metadata = metadata_for_config(&config, config.provider_type.clone());
        Self {
            metadata,
            config: RwLock::new(config),
            http_client: http_client::shared(),
        }
    }
}

#[async_trait::async_trait]
impl AiProvider for OpenAiCompatibleProvider {
    fn metadata(&self) -> &AiProviderMetadata {
        &self.metadata
    }

    fn capabilities(&self) -> &AiCapabilities {
        &self.metadata.capabilities
    }

    fn protocol(&self) -> ProviderProtocol {
        ProviderProtocol::OpenAiCompatible
    }

    async fn stream_chat(
        &self,
        messages: Vec<Value>,
        tools: Vec<Value>,
    ) -> Result<ProviderStream, AppError> {
        // 提取配置值后立即 drop 锁守卫（RwLockReadGuard 不是 Send，不能跨 await）
        let (api_url, model_id, api_key) = {
            let config = self
                .config
                .read()
                .map_err(|e| AppError::Custom(format!("Config lock error: {}", e)))?;
            (
                config.api_url.clone(),
                config.model_id.clone(),
                config.api_key.clone(),
            )
        };

        let url = build_openai_chat_url(&api_url);
        let mut body = json!({
            "model": model_id,
            "messages": messages,
            "stream": true,
        });
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            body["tool_choice"] = json!("auto");
        }

        let mut request = self
            .http_client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body);

        if let Some(ref key) = api_key {
            if !key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }

        let response = request
            .send()
            .await
            .map_err(|e| AppError::Custom(format!("API 请求失败: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format_openai_api_error(status, &body)));
        }

        Ok(Box::pin(openai_event_stream(response.bytes_stream())))
    }
}

/// Ollama 原生 Provider — `/api/chat` NDJSON 流
pub struct OllamaProvider {
    metadata: AiProviderMetadata,
    config: RwLock<AiProviderConfig>,
}

impl OllamaProvider {
    pub fn new(config: AiProviderConfig) -> Self {
        let metadata = metadata_for_config(&config, "Ollama".to_string());
        Self {
            metadata,
            config: RwLock::new(config),
        }
    }
}

#[async_trait::async_trait]
impl AiProvider for OllamaProvider {
    fn metadata(&self) -> &AiProviderMetadata {
        &self.metadata
    }

    fn capabilities(&self) -> &AiCapabilities {
        &self.metadata.capabilities
    }

    fn protocol(&self) -> ProviderProtocol {
        ProviderProtocol::Ollama
    }

    async fn stream_chat(
        &self,
        messages: Vec<Value>,
        _tools: Vec<Value>,
    ) -> Result<ProviderStream, AppError> {
        let (api_url, model_id) = {
            let config = self
                .config
                .read()
                .map_err(|e| AppError::Custom(format!("Config lock error: {}", e)))?;
            (config.api_url.clone(), config.model_id.clone())
        };
        let url = format!("{}/api/chat", api_url.trim_end_matches('/'));

        let response = build_ollama_client()
            .post(&url)
            .json(&json!({
                "model": model_id,
                "messages": messages,
                "stream": true,
            }))
            .send()
            .await
            .map_err(|e| AppError::Custom(format_ollama_send_error(&e, &url)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Custom(format!(
                "Ollama 返回错误 {}: {}",
                status, body
            )));
        }

        Ok(Box::pin(ollama_event_stream(response.bytes_stream())))
    }
}

/// 根据配置构造元数据（能力由 `AiProviderConfig::capabilities` 推导）
fn metadata_for_config(config: &AiProviderConfig, display_name: String) -> AiProviderMetadata {
    AiProviderMetadata {
        provider_type: config.provider_type.clone(),
        display_name,
        description: format!("{} @ {}", config.model_id, config.api_url),
        default_base_url: config.api_url.clone(),
        default_model: config.model_id.clone(),
        capabilities: config.capabilities(),
    }
}

// ─── 流解析器 ──────────────────────────────────

/// OpenAI SSE 解析：字节流 → 协议无关事件流
fn openai_event_stream<S>(byte_stream: S) -> impl Stream<Item = Result<ProviderStreamEvent, AppError>> + Send
where
    S: Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
{
    let state = OpenAiStreamState {
        inner: Box::pin(byte_stream),
        buffer: Vec::new(),
        pending: VecDeque::new(),
        finished: false,
        errored: false,
        finish_emitted: false,
        finish_reason: None,
    };

    futures::stream::unfold(state, |mut st| async move {
        loop {
            if let Some(event) = st.pending.pop_front() {
                return Some((Ok(event), st));
            }

            if st.finished {
                if !st.errored && !st.finish_emitted {
                    st.finish_emitted = true;
                    return Some((
                        Ok(ProviderStreamEvent::Finish {
                            reason: st.finish_reason.take(),
                        }),
                        st,
                    ));
                }
                return None;
            }

            // 优先消费缓冲区里的完整行
            if let Some(pos) = st.buffer.iter().position(|b| *b == b'\n') {
                let line_bytes: Vec<u8> = st.buffer.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes);
                let line = line.trim_end_matches(&['\r', '\n'][..]).to_string();
                parse_openai_line(&line, &mut st.pending, &mut st.finish_reason);
                continue;
            }

            match st.inner.next().await {
                Some(Ok(bytes)) => st.buffer.extend_from_slice(&bytes),
                Some(Err(e)) => {
                    st.finished = true;
                    st.errored = true;
                    st.buffer.clear();
                    return Some((Err(AppError::Custom(format!("流读取错误: {}", e))), st));
                }
                None => {
                    // 流末尾未以 \n 结尾的 leftover 也要 flush
                    if !st.buffer.is_empty() {
                        let line = String::from_utf8_lossy(&st.buffer);
                        let line = line.trim_end_matches(&['\r', '\n'][..]).to_string();
                        st.buffer.clear();
                        parse_openai_line(&line, &mut st.pending, &mut st.finish_reason);
                    }
                    st.finished = true;
                }
            }
        }
    })
}

struct OpenAiStreamState {
    inner: Pin<Box<dyn Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send>>,
    buffer: Vec<u8>,
    pending: VecDeque<ProviderStreamEvent>,
    finished: bool,
    errored: bool,
    finish_emitted: bool,
    finish_reason: Option<String>,
}

/// 解析单行 OpenAI SSE，把增量事件推入 pending。
fn parse_openai_line(
    line: &str,
    pending: &mut VecDeque<ProviderStreamEvent>,
    finish_reason: &mut Option<String>,
) {
    if line.is_empty() || line == "data: [DONE]" {
        return;
    }
    let Some(json_str) = line.strip_prefix("data: ") else {
        return;
    };
    let Ok(data) = serde_json::from_str::<Value>(json_str) else {
        return;
    };

    let choice = &data["choices"][0];
    if let Some(reason) = choice["finish_reason"].as_str() {
        *finish_reason = Some(reason.to_string());
    }

    let delta = &choice["delta"];
    if let Some(content) = delta["content"].as_str() {
        if !content.is_empty() {
            pending.push_back(ProviderStreamEvent::Content(content.to_string()));
        }
    }
    // reasoning 模型（deepseek-r1 / qwq / o1）的思考过程
    if let Some(reasoning) = delta["reasoning_content"].as_str() {
        if !reasoning.is_empty() {
            pending.push_back(ProviderStreamEvent::Reasoning(reasoning.to_string()));
        }
    }
    // tool_calls 分片
    if let Some(tool_calls) = delta["tool_calls"].as_array() {
        for tc in tool_calls {
            pending.push_back(ProviderStreamEvent::ToolCallDelta {
                index: tc["index"].as_u64().unwrap_or(0),
                id: tc["id"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
                name: tc["function"]["name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                arguments: tc["function"]["arguments"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            });
        }
    }
}

/// Ollama NDJSON 解析：`{"message":{"content":"..."},"done":false}`
fn ollama_event_stream<S>(byte_stream: S) -> impl Stream<Item = Result<ProviderStreamEvent, AppError>> + Send
where
    S: Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
{
    let state = OllamaStreamState {
        inner: Box::pin(byte_stream),
        buffer: Vec::new(),
        pending: VecDeque::new(),
        finished: false,
        errored: false,
    };

    futures::stream::unfold(state, |mut st| async move {
        loop {
            if let Some(event) = st.pending.pop_front() {
                return Some((Ok(event), st));
            }
            if st.finished {
                return None;
            }

            if let Some(pos) = st.buffer.iter().position(|b| *b == b'\n') {
                let line_bytes: Vec<u8> = st.buffer.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes);
                let line = line.trim();
                parse_ollama_line(line, &mut st.pending, &mut st.finished);
                continue;
            }

            match st.inner.next().await {
                Some(Ok(bytes)) => st.buffer.extend_from_slice(&bytes),
                Some(Err(e)) => {
                    st.finished = true;
                    st.errored = true;
                    st.buffer.clear();
                    return Some((Err(AppError::Custom(format!("流读取错误: {}", e))), st));
                }
                None => {
                    if !st.buffer.is_empty() {
                        let line = String::from_utf8_lossy(&st.buffer).trim().to_string();
                        st.buffer.clear();
                        parse_ollama_line(&line, &mut st.pending, &mut st.finished);
                    }
                    st.finished = true;
                }
            }
        }
    })
}

struct OllamaStreamState {
    inner: Pin<Box<dyn Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send>>,
    buffer: Vec<u8>,
    pending: VecDeque<ProviderStreamEvent>,
    finished: bool,
    errored: bool,
}

fn parse_ollama_line(
    line: &str,
    pending: &mut VecDeque<ProviderStreamEvent>,
    finished: &mut bool,
) {
    if line.is_empty() {
        return;
    }
    let Ok(data) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if let Some(content) = data["message"]["content"].as_str() {
        if !content.is_empty() {
            pending.push_back(ProviderStreamEvent::Content(content.to_string()));
        }
    }
    if data["done"].as_bool() == Some(true) {
        pending.push_back(ProviderStreamEvent::Finish { reason: None });
        *finished = true;
    }
}

// ─── 内置 Provider 工厂 ─────────────────────────

/// DeepSeek Provider 元数据
fn deepseek_metadata() -> AiProviderMetadata {
    AiProviderMetadata {
        provider_type: "deepseek".to_string(),
        display_name: "DeepSeek".to_string(),
        description: "DeepSeek API（OpenAI 兼容），支持 Chat V3 / Reasoner".to_string(),
        default_base_url: "https://api.deepseek.com".to_string(),
        default_model: "deepseek-chat".to_string(),
        capabilities: AiCapabilities {
            supports_streaming: true,
            supports_vision: false,
            supports_function_calling: true,
            supports_json_mode: true,
            max_output_tokens: Some(8192),
        },
    }
}

/// OpenAI Provider 元数据（可复用为 OpenAI / OpenRouter / 自定义端点）
fn openai_compatible_metadata() -> AiProviderMetadata {
    AiProviderMetadata {
        provider_type: "openai_compatible".to_string(),
        display_name: "OpenAI 兼容".to_string(),
        description: "通用 OpenAI 兼容 API（支持 OpenAI / OpenRouter / 自定义端点）".to_string(),
        default_base_url: "https://api.openai.com".to_string(),
        default_model: "gpt-4o-mini".to_string(),
        capabilities: AiCapabilities {
            supports_streaming: true,
            supports_vision: true,
            supports_function_calling: true,
            supports_json_mode: true,
            max_output_tokens: Some(16384),
        },
    }
}

/// Ollama Provider 元数据
fn ollama_metadata() -> AiProviderMetadata {
    AiProviderMetadata {
        provider_type: "ollama".to_string(),
        display_name: "Ollama".to_string(),
        description: "本地 Ollama 原生 API（/api/chat，不支持工具与 JSON 模式）".to_string(),
        default_base_url: "http://localhost:11434".to_string(),
        default_model: "llama3".to_string(),
        capabilities: DEFAULT_CAPABILITIES,
    }
}

/// 注册所有内置 Provider
pub fn register_builtin_providers(registry: &AiProviderRegistry) {
    // DeepSeek
    registry.register(AiProviderPlugin {
        metadata: deepseek_metadata(),
        factory: Box::new(|config: AiProviderConfig| {
            Ok(Arc::new(OpenAiCompatibleProvider::new(config)) as Arc<dyn AiProvider>)
        }),
    });

    // OpenAI 兼容（未单独注册的厂商统一回退到这里）
    registry.register(AiProviderPlugin {
        metadata: openai_compatible_metadata(),
        factory: Box::new(|config: AiProviderConfig| {
            Ok(Arc::new(OpenAiCompatibleProvider::new(config)) as Arc<dyn AiProvider>)
        }),
    });

    // Ollama 原生
    registry.register(AiProviderPlugin {
        metadata: ollama_metadata(),
        factory: Box::new(|config: AiProviderConfig| {
            Ok(Arc::new(OllamaProvider::new(config)) as Arc<dyn AiProvider>)
        }),
    });

    log::info!(
        "[ProviderRegistry] 内置 Provider 已注册: {}",
        registry.list_registered().join(", ")
    );
}

/// 确保内置 Provider 只注册一次（进程生命周期内）。
pub fn ensure_builtin() {
    static BUILTIN_INIT: OnceLock<()> = OnceLock::new();
    BUILTIN_INIT.get_or_init(|| register_builtin_providers(get_provider_registry()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunks(parts: &[&str]) -> impl Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static {
        let owned: Vec<Result<bytes::Bytes, reqwest::Error>> = parts
            .iter()
            .map(|p| Ok(bytes::Bytes::from(p.to_string())))
            .collect();
        futures::stream::iter(owned)
    }

    fn collect_events(stream: ProviderStream) -> Vec<ProviderStreamEvent> {
        futures::executor::block_on(async move {
            stream
                .filter_map(|item| async move { item.ok() })
                .collect::<Vec<_>>()
                .await
        })
    }

    /// reqwest 依赖 Tokio reactor，HTTP 回环测试必须在 Tokio runtime 内消费流。
    fn run_tokio<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Runtime::new()
            .expect("create tokio runtime")
            .block_on(future)
    }

    #[test]
    fn openai_stream_emits_content_reasoning_and_tool_calls() {
        let stream = openai_event_stream(chunks(&[
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\
             \"function\":{\"name\":\"search_notes\",\"arguments\":\"{\\\"query\\\":\\\"x\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"finish_reason\":\"tool_calls\",\"delta\":{}}]}\n\n",
            "data: [DONE]\n\n",
        ]));

        let events = collect_events(Box::pin(stream));
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut tool_name = String::new();
        let mut tool_args = String::new();
        let mut finish = None;

        for event in events {
            match event {
                ProviderStreamEvent::Content(c) => content.push_str(&c),
                ProviderStreamEvent::Reasoning(r) => reasoning.push_str(&r),
                ProviderStreamEvent::ToolCallDelta { name, arguments, .. } => {
                    if let Some(n) = name {
                        tool_name.push_str(&n);
                    }
                    if let Some(a) = arguments {
                        tool_args.push_str(&a);
                    }
                }
                ProviderStreamEvent::Finish { reason } => finish = reason,
            }
        }

        assert_eq!(content, "你好");
        assert_eq!(reasoning, "思考");
        assert_eq!(tool_name, "search_notes");
        assert_eq!(tool_args, r#"{"query":"x"}"#);
        assert_eq!(finish.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn ollama_stream_emits_content_then_finish() {
        let stream = ollama_event_stream(chunks(&[
            "{\"message\":{\"content\":\"你好\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"世界\"},\"done\":true}\n",
        ]));

        let events = collect_events(Box::pin(stream));
        let content: String = events
            .iter()
            .filter_map(|e| match e {
                ProviderStreamEvent::Content(c) => Some(c.as_str()),
                _ => None,
            })
            .collect();
        let finished = events
            .iter()
            .any(|e| matches!(e, ProviderStreamEvent::Finish { .. }));

        assert_eq!(content, "你好世界");
        assert!(finished);
    }

    /// 启动一次性本地 HTTP 服务，返回 (base_url, 读取到的请求文本)
    fn spawn_once_server(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let addr = listener.local_addr().expect("local addr");
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .ok();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                match socket.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let request = String::from_utf8_lossy(&buf).to_string();
            socket.write_all(response.as_bytes()).ok();
            socket.flush().ok();
            request
        });
        (format!("http://{}", addr), handle)
    }

    fn smoke_config(provider_type: &str, base_url: &str) -> AiProviderConfig {
        AiProviderConfig {
            provider_type: provider_type.into(),
            protocol: Some("openai_compatible".into()),
            api_url: base_url.into(),
            api_key: Some("sk-test".into()),
            model_id: "test-model".into(),
            max_context: Some(8192),
            supports_tools: Some(true),
            supports_vision: Some(false),
            max_output_tokens: None,
        }
    }

    #[test]
    fn openai_provider_round_trip_over_http() {
        const RESPONSE: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"}}]}\n\n\
data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{}}]}\n\n\
data: [DONE]\n\n";

        let (base, server) = spawn_once_server(RESPONSE);
        let provider = OpenAiCompatibleProvider::new(smoke_config("openai", &base));
        let events = run_tokio(async move {
            let stream = provider
                .stream_chat(
                    vec![json!({"role": "user", "content": "hi"})],
                    vec![json!({"type": "function", "function": {"name": "search_notes"}})],
                )
                .await
                .expect("stream starts");
            stream
                .filter_map(|item| async move { item.ok() })
                .collect::<Vec<_>>()
                .await
        });
        let content: String = events
            .iter()
            .filter_map(|e| match e {
                ProviderStreamEvent::Content(c) => Some(c.as_str()),
                _ => None,
            })
            .collect();

        assert_eq!(content, "你好，世界");
        let request = server.join().expect("server thread");
        assert!(request.starts_with("POST /v1/chat/completions "), "{}", request);
        assert!(request.to_lowercase().contains("authorization: bearer sk-test"));
        assert!(request.contains("\"tools\""));
        assert!(request.contains("\"tool_choice\":\"auto\""));
    }

    #[test]
    fn ollama_provider_round_trip_over_http() {
        const RESPONSE: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\n\
{\"message\":{\"content\":\"你好\"},\"done\":false}\n\
{\"message\":{\"content\":\"，本地\"},\"done\":true}\n";

        let (base, server) = spawn_once_server(RESPONSE);
        let provider = OllamaProvider::new(AiProviderConfig {
            protocol: Some("ollama".into()),
            ..smoke_config("ollama", &base)
        });
        let events = run_tokio(async move {
            let stream = provider
                .stream_chat(vec![json!({"role": "user", "content": "hi"})], Vec::new())
                .await
                .expect("stream starts");
            stream
                .filter_map(|item| async move { item.ok() })
                .collect::<Vec<_>>()
                .await
        });
        let content: String = events
            .iter()
            .filter_map(|e| match e {
                ProviderStreamEvent::Content(c) => Some(c.as_str()),
                _ => None,
            })
            .collect();

        assert_eq!(content, "你好，本地");
        let request = server.join().expect("server thread");
        assert!(request.starts_with("POST /api/chat "), "{}", request);
        assert!(!request.to_lowercase().contains("authorization"));
    }

    #[test]
    fn protocol_and_capabilities_are_derived_from_config() {
        let ollama = AiProviderConfig {
            provider_type: "ollama".into(),
            protocol: Some("openai_compatible".into()), // 存量数据常见：protocol 未同步
            api_url: "http://localhost:11434".into(),
            api_key: None,
            model_id: "llama3".into(),
            max_context: Some(8192),
            supports_tools: None,
            supports_vision: None,
            max_output_tokens: None,
        };
        assert_eq!(ollama.protocol_kind(), ProviderProtocol::Ollama);
        assert!(!ollama.capabilities().supports_json_mode);
        assert!(!ollama.capabilities().supports_function_calling);

        let claude = AiProviderConfig {
            provider_type: "claude".into(),
            protocol: Some("openai_compatible".into()),
            ..ollama
        };
        assert_eq!(claude.protocol_kind(), ProviderProtocol::OpenAiCompatible);
        assert!(!claude.capabilities().supports_json_mode);
        assert!(claude.capabilities().supports_function_calling);
    }
}
