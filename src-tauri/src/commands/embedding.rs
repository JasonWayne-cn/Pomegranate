//! Embedding 配置 Commands

use tauri::{Emitter, State};

use crate::models::{EmbeddingConfig, EmbeddingConfigInput, ReindexResult};
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

/// 全量重建笔记向量（后台串行，进度通过 `ai:reindex_progress` 事件回报）。
///
/// 前置：embedding 已配置、启用且维度已知（先 test_embedding 再 save）。
#[tauri::command]
pub async fn reindex_notes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ReindexResult, String> {
    let cfg = state
        .db
        .get_embedding_config()
        .map_err(|e| e.to_string())?
        .ok_or("未配置 embedding 模型")?;
    if !cfg.is_enabled || cfg.dim <= 0 {
        return Err("embedding 未启用或维度未知，请先测试连接并保存".into());
    }

    let notes = state
        .db
        .list_notes_for_embedding()
        .map_err(|e| e.to_string())?;
    let total = notes.len();

    let mut done = 0usize;
    let mut failed = 0usize;
    for (id, content) in notes {
        match crate::services::embedding::embed(&cfg, &content).await {
            Ok(vec) => {
                if let Err(e) = state
                    .db
                    .upsert_note_embedding(id, &content, &vec, &cfg.model_id, cfg.dim)
                {
                    log::warn!("[reindex] 笔记 {} 向量入库失败: {}", id, e);
                    failed += 1;
                }
            }
            Err(e) => {
                log::warn!("[reindex] 笔记 {} embed 失败: {}", id, e);
                failed += 1;
            }
        }
        done += 1;
        let _ = app.emit(
            "ai:reindex_progress",
            serde_json::json!({ "done": done, "total": total, "failed": failed }),
        );
    }

    log::info!("[reindex] 完成 total={} failed={}", total, failed);
    Ok(ReindexResult { total, done, failed })
}
