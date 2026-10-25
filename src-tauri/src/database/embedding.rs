//! Embedding 配置与笔记向量的数据访问层。
//!
//! 向量以 float32 小端序 BLOB 存储，检索用 sqlite-vec 的 `vec_distance_cosine`
//! 标量函数（维度不固定，切换 embedding 模型时按 model/dim 过滤即可）。

use rusqlite::{params, OptionalExtension};

use crate::error::AppError;
use crate::models::{EmbeddingConfig, EmbeddingConfigInput};

use super::Database;

impl Database {
    /// 获取 embedding 配置（单行，无则 None）
    pub fn get_embedding_config(&self) -> Result<Option<EmbeddingConfig>, AppError> {
        let conn = self.conn_lock()?;
        let row = conn
            .query_row(
                "SELECT api_url, api_key, model_id, dim, is_enabled
                 FROM ai_embedding_config WHERE id = 1",
                [],
                |r| {
                    Ok(EmbeddingConfig {
                        api_url: r.get(0)?,
                        api_key: r.get(1)?,
                        model_id: r.get(2)?,
                        dim: r.get(3)?,
                        is_enabled: r.get(4).map(|v: i64| v != 0)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// 保存 embedding 配置（单行 upsert）。
    ///
    /// `dim` 为探测到的向量维度（测试探活时回填）；`api_key: None` 表示保留旧值。
    pub fn save_embedding_config(
        &self,
        input: &EmbeddingConfigInput,
        dim: i64,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;

        // 保留旧 key：先查当前值
        let api_key = match &input.api_key {
            Some(k) => k.clone(),
            None => conn
                .query_row(
                    "SELECT api_key FROM ai_embedding_config WHERE id = 1",
                    [],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
                .unwrap_or_default(),
        };

        conn.execute(
            "INSERT INTO ai_embedding_config (id, api_url, api_key, model_id, dim, is_enabled, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, datetime('now','localtime'))
             ON CONFLICT(id) DO UPDATE SET
               api_url = excluded.api_url,
               api_key = excluded.api_key,
               model_id = excluded.model_id,
               dim = excluded.dim,
               is_enabled = excluded.is_enabled,
               updated_at = excluded.updated_at",
            params![
                input.api_url,
                api_key,
                input.model_id,
                dim,
                input.is_enabled as i64,
            ],
        )?;
        Ok(())
    }

    /// 保存/更新一篇笔记的向量（Phase 1 整篇一个向量，chunk_index=0）。
    pub fn upsert_note_embedding(
        &self,
        note_id: i64,
        content: &str,
        vector: &[f32],
        model: &str,
        dim: i64,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let blob = crate::services::embedding::to_bytes(vector);
        conn.execute(
            "INSERT INTO note_embeddings (note_id, chunk_index, content, vector, model, dim)
             VALUES (?1, 0, ?2, ?3, ?4, ?5)
             ON CONFLICT(note_id, chunk_index) DO UPDATE SET
               content = excluded.content,
               vector = excluded.vector,
               model = excluded.model,
               dim = excluded.dim",
            params![note_id, content, blob, model, dim],
        )?;
        Ok(())
    }

    /// 删除一篇笔记的全部向量。
    pub fn delete_note_embeddings(&self, note_id: i64) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "DELETE FROM note_embeddings WHERE note_id = ?1",
            params![note_id],
        )?;
        Ok(())
    }

    /// 向量检索：按余弦距离升序返回 top-k 命中（含标题与内容）。
    ///
    /// 返回 `(note_id, title, content, distance)`。`distance` 为余弦距离，越小越相似。
    pub fn search_notes_vector(
        &self,
        query_vec: &[f32],
        model: &str,
        dim: i64,
        top_k: usize,
    ) -> Result<Vec<(i64, String, String, f64)>, AppError> {
        let conn = self.conn_lock()?;
        let query_blob = crate::services::embedding::to_bytes(query_vec);

        let mut stmt = conn.prepare(
            "SELECT ne.note_id, n.title, ne.content,
                    vec_distance_cosine(ne.vector, ?1) AS distance
             FROM note_embeddings ne
             LEFT JOIN notes n ON n.id = ne.note_id
             WHERE ne.model = ?2 AND ne.dim = ?3
             ORDER BY distance ASC
             LIMIT ?4",
        )?;

        let rows = stmt
            .query_map(params![query_blob, model, dim, top_k as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }
}
