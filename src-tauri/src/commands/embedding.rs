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
    let previous = state.db.get_embedding_config().ok().flatten();

    state
        .db
        .save_embedding_config(&input, dim)
        .map_err(|e| e.to_string())?;

    // 模型 / 维度变化：旧向量不可复用，清空后后台重建
    let model_changed = previous
        .as_ref()
        .map_or(true, |p| p.model_id != input.model_id || p.dim != dim);
    if model_changed {
        state
            .db
            .clear_all_note_embeddings()
            .map_err(|e| e.to_string())?;
    }

    let was_disabled = previous.as_ref().map_or(true, |p| !p.is_enabled);
    if input.is_enabled && dim > 0 && (model_changed || was_disabled) {
        crate::services::index_queue::enqueue_all();
    }

    Ok(())
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

    // 全量重建：先清空旧向量，避免笔记变短后残留旧的 chunk
    state
        .db
        .clear_all_note_embeddings()
        .map_err(|e| e.to_string())?;

    // 单块字符上限：阿里云 text-embedding 单次输入 8192 token，保守取 6000 字符留余量
    const CHUNK_CHARS: usize = 6000;

    let mut done = 0usize;
    let mut failed = 0usize;
    for (id, content) in notes {
        // 长笔记分块，每块单独 embed，避免超过 API 单次输入上限
        let chunks = crate::services::embedding::chunk_text(&content, CHUNK_CHARS);
        let mut note_failed = false;
        for (idx, chunk) in chunks.iter().enumerate() {
            match crate::services::embedding::embed(&cfg, chunk).await {
                Ok(vec) => {
                    if let Err(e) = state.db.upsert_note_embedding(
                        id,
                        idx as i64,
                        chunk,
                        &vec,
                        &cfg.model_id,
                        cfg.dim,
                    ) {
                        log::warn!("[reindex] 笔记 {} chunk {} 入库失败: {}", id, idx, e);
                        note_failed = true;
                    }
                }
                Err(e) => {
                    log::warn!("[reindex] 笔记 {} chunk {} embed 失败: {}", id, idx, e);
                    note_failed = true;
                }
            }
        }
        if note_failed {
            failed += 1;
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
