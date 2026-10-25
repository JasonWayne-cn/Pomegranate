//! Embedding 配置 Commands

use tauri::State;

use crate::models::{EmbeddingConfig, EmbeddingConfigInput};
use crate::state::AppState;

/// 获取 embedding 配置（未配置则 None）
#[tauri::command]
pub fn get_embedding_config(
    state: State<'_, AppState>,
) -> Result<Option<EmbeddingConfig>, String> {
    state.db.get_embedding_config().map_err(|e| e.to_string())
}

/// 探活 embedding API：发一次 embed("ping")，返回探测到的向量维度。
///
/// 不回填数据库——前端拿到维度后，在 save_embedding_config 时显式传入。
#[tauri::command]
pub async fn test_embedding(input: EmbeddingConfigInput) -> Result<i64, String> {
    let config = EmbeddingConfig {
        api_url: input.api_url,
        api_key: input.api_key.filter(|k| !k.is_empty()),
        model_id: input.model_id,
        dim: 0,
        is_enabled: input.is_enabled,
    };
    let vec = crate::services::embedding::embed(&config, "ping")
        .await
        .map_err(|e| e.to_string())?;
    Ok(vec.len() as i64)
}

/// 保存 embedding 配置（`dim` 由前端 test_embedding 探测后传入）。
#[tauri::command]
pub fn save_embedding_config(
    state: State<'_, AppState>,
    input: EmbeddingConfigInput,
    dim: i64,
) -> Result<(), String> {
    state
        .db
        .save_embedding_config(&input, dim)
        .map_err(|e| e.to_string())
}
