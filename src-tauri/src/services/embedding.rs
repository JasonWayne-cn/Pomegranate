//! 远程 Embedding 客户端（OpenAI 兼容 `/v1/embeddings`）
//!
//! 与 chat 共用同一套 OpenAI 兼容 URL 拼接逻辑（/v1 补全、chat/completions 端点替换），
//! 端点从 chat/completions 换成 embeddings。向量以 float32 小端序 BLOB 存储，
//! 检索时用 sqlite-vec 的 `vec_distance_cosine` 标量函数。

use serde_json::{json, Value};

use crate::error::AppError;
use crate::models::EmbeddingConfig;

/// 拼接 OpenAI 兼容 embeddings 端点 URL。
fn build_embeddings_url(api_url: &str) -> String {
    let base = api_url.trim_end_matches('/');
    if base.ends_with("/embeddings") {
        return base.to_string();
    }
    // 用户填了 chat/completions 端点 → 替换为 embeddings
    if base.ends_with("/chat/completions") {
        return format!("{}/embeddings", base.trim_end_matches("/chat/completions"));
    }
    // 最后一段是版本号（v1 / v2 ...）→ 补 /embeddings；否则补 /v1/embeddings
    let has_version_segment = base.rsplit('/').next().is_some_and(|seg| {
        seg.starts_with('v')
            && seg.len() > 1
            && seg[1..].chars().all(|c| c.is_ascii_digit() || c == '.')
    });
    if has_version_segment {
        format!("{}/embeddings", base)
    } else {
        format!("{}/v1/embeddings", base)
    }
}

/// 调用远程 embedding API，把一段文本转成 float32 向量。
pub async fn embed(config: &EmbeddingConfig, text: &str) -> Result<Vec<f32>, AppError> {
    let url = build_embeddings_url(&config.api_url);
    let client = crate::services::http_client::shared();

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&json!({
            "model": config.model_id,
            "input": text,
        }));

    if let Some(key) = &config.api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("embedding 请求失败: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Custom(format!(
            "embedding API 错误 {}: {}",
            status, body
        )));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Custom(format!("embedding JSON 解析失败: {}", e)))?;

    let vec = data["data"][0]["embedding"]
        .as_array()
        .ok_or_else(|| AppError::Custom("embedding 响应缺少 data[0].embedding".into()))?
        .iter()
        .map(|v| v.as_f64().map(|f| f as f32).unwrap_or(0.0))
        .collect::<Vec<f32>>();

    if vec.is_empty() {
        return Err(AppError::Custom("embedding 返回空向量".into()));
    }
    Ok(vec)
}

/// 把 float32 向量转成小端序字节（存 BLOB，检索时 sqlite-vec 直接读）。
pub fn to_bytes(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for f in vec {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// 把长文本按字符数切成多个块（embedding API 有单次输入上限）。
///
/// 阿里云 text-embedding 上限 8192 token（中文约 5~8K 字符），这里保守取 6000 字符，
/// 给 token 换算留余量。切分不保证语义完整，但能保证每块都低于 API 上限。
pub fn chunk_text(text: &str, max_chars: usize) -> Vec<&str> {
    if text.chars().count() <= max_chars {
        return vec![text];
    }
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let mut count = 0usize;
    for (i, c) in text.char_indices() {
        if count >= max_chars {
            chunks.push(&text[start..i]);
            start = i;
            count = 0;
        }
        count += 1;
        let _ = c;
    }
    if start < text.len() {
        chunks.push(&text[start..]);
    }
    chunks
}
