//! 插件受控 HTTP 代理
//!
//! 设计目标：
//! - 只允许访问白名单内的公共学术 API，避免插件变成任意 SSRF 通道
//! - 禁用自动重定向，防止 302 绕过白名单
//! - 限制方法、请求头、请求体与响应体大小
//! - 统一超时，避免插件请求长期挂起

use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::services::http_client::shared_guarded;

/// 允许插件访问的公共学术数据源。
const ALLOWED_HOSTS: &[&str] = &[
    "api.crossref.org",
    "www.ebi.ac.uk",
    "export.arxiv.org",
    "arxiv.org",
    "dblp.org",
    "eutils.ncbi.nlm.nih.gov",
    "api.semanticscholar.org",
];

const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const MAX_TIMEOUT_MS: u64 = 30_000;
const MAX_REQUEST_BODY: usize = 100 * 1024;
const MAX_RESPONSE_BODY: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpResponse {
    pub status: u16,
    pub body: String,
}

pub async fn request(input: PluginHttpRequest) -> Result<PluginHttpResponse, AppError> {
    let url = Url::parse(input.url.trim())
        .map_err(|_| AppError::InvalidInput("无效的请求 URL".into()))?;

    if url.scheme() != "https" {
        return Err(AppError::InvalidInput("仅允许 https 请求".into()));
    }
    if url.username() != "" || url.password().is_some() {
        return Err(AppError::InvalidInput("URL 不允许包含账号信息".into()));
    }
    if let Some(port) = url.port() {
        if port != 443 {
            return Err(AppError::InvalidInput("仅允许 443 端口".into()));
        }
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::InvalidInput("URL 缺少主机名".into()))?;
    if !ALLOWED_HOSTS.contains(&host) {
        return Err(AppError::InvalidInput(format!(
            "插件网络权限未覆盖该域名: {host}"
        )));
    }

    let method = match input.method.as_deref().unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return Err(AppError::InvalidInput("仅允许 GET / POST".into())),
    };

    let body = input.body.unwrap_or_default();
    if body.len() > MAX_REQUEST_BODY {
        return Err(AppError::InvalidInput("请求体超过 100KB 限制".into()));
    }
    if method == Method::GET && !body.is_empty() {
        return Err(AppError::InvalidInput("GET 请求不允许携带请求体".into()));
    }

    let timeout = Duration::from_millis(
        input
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(5_000, MAX_TIMEOUT_MS),
    );

    let mut req = shared_guarded()
        .request(method.clone(), url)
        .timeout(timeout)
        .header("User-Agent", "Pomegranate-Research-Assistant/1.0");

    // 只透传少量安全请求头，忽略其余头，避免伪造 Cookie / Authorization。
    if let Some(headers) = input.headers {
        for (key, value) in headers {
            let lower = key.to_ascii_lowercase();
            if lower == "accept" {
                if let Ok(v) = value.parse::<reqwest::header::HeaderValue>() {
                    req = req.header(ACCEPT, v);
                }
            } else if lower == "content-type" {
                if let Ok(v) = value.parse::<reqwest::header::HeaderValue>() {
                    req = req.header(CONTENT_TYPE, v);
                }
            }
        }
    }

    if method == Method::POST {
        req = req.body(body);
    }

    let response = req
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("网络请求失败: {e}")))?;

    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::Custom(format!("读取响应失败: {e}")))?;

    if bytes.len() > MAX_RESPONSE_BODY {
        return Err(AppError::Custom("响应体超过 5MB 限制".into()));
    }
    if !status.is_success() {
        let snippet = String::from_utf8_lossy(&bytes);
        let snippet: String = snippet.chars().take(300).collect();
        return Err(AppError::Custom(format!(
            "上游返回 {}: {}",
            status.as_u16(),
            snippet
        )));
    }

    Ok(PluginHttpResponse {
        status: status.as_u16(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}
