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

    /// 保存/更新一篇笔记某个 chunk 的向量。
    pub fn upsert_note_embedding(
        &self,
        note_id: i64,
        chunk_index: i64,
        content: &str,
        vector: &[f32],
        model: &str,
        dim: i64,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let blob = crate::services::embedding::to_bytes(vector);
        conn.execute(
            "INSERT INTO note_embeddings (note_id, chunk_index, content, vector, model, dim)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(note_id, chunk_index) DO UPDATE SET
               content = excluded.content,
               vector = excluded.vector,
               model = excluded.model,
               dim = excluded.dim",
            params![note_id, chunk_index, content, blob, model, dim],
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

    /// 清空所有笔记向量（全量重建前调用，避免残留旧的 chunk）。
    pub fn clear_all_note_embeddings(&self) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute("DELETE FROM note_embeddings", [])?;
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
                    MIN(vec_distance_cosine(ne.vector, ?1)) AS distance
             FROM note_embeddings ne
             JOIN notes n ON n.id = ne.note_id
             WHERE ne.model = ?2 AND ne.dim = ?3
               AND n.is_deleted = 0 AND n.is_hidden = 0 AND n.is_encrypted = 0
             GROUP BY ne.note_id
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

    /// 列出所有可检索笔记的 `(id, content)`，用于全量重建向量。
    ///
    /// 回收站（is_deleted）与隐藏（is_hidden）笔记不参与索引，避免被 RAG 召回。
    pub fn list_notes_for_embedding(&self) -> Result<Vec<(i64, String)>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, content FROM notes
             WHERE content != '' AND is_deleted = 0 AND is_hidden = 0
               AND is_encrypted = 0",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 列出所有可检索笔记的 id（增量索引 `All` 任务用，不加载正文）。
    pub fn list_note_ids_for_embedding(&self) -> Result<Vec<i64>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT id FROM notes
             WHERE content != '' AND is_deleted = 0 AND is_hidden = 0
               AND is_encrypted = 0",
        )?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 读取单篇笔记正文用于增量索引。
    ///
    /// 已删除 / 隐藏 / 空正文返回 `None`，调用方据此删除旧向量。
    pub fn get_note_content_for_embedding(
        &self,
        note_id: i64,
    ) -> Result<Option<String>, AppError> {
        let conn = self.conn_lock()?;
        let row = conn
            .query_row(
                "SELECT content FROM notes
                 WHERE id = ?1 AND content != ''
                   AND is_deleted = 0 AND is_hidden = 0 AND is_encrypted = 0",
                params![note_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok(row)
    }
}
