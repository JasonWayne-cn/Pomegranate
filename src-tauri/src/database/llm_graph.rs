//! LLM 文档图谱的数据访问层。
//!
//! 抽取结果按笔记存储，查询时按 `norm_name` 跨笔记聚合为图。
//! 该层只做 SQL 与聚合，Prompt 与模型调用在 `services::llm_graph`。

use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    LlmEntityNote, LlmExtractionStatus, LlmGraphData, LlmGraphEdge, LlmGraphNode,
};

/// 待写入的单篇实体
pub struct LlmEntityRow {
    pub norm_name: String,
    pub name: String,
    pub entity_type: String,
    pub description: String,
}

/// 待写入的单篇关系
pub struct LlmRelationRow {
    pub source_norm: String,
    pub target_norm: String,
    pub description: String,
    pub keywords: String,
}

/// 作用域内单篇笔记的图谱状态原始数据。
pub struct LlmGraphScopeNoteRow {
    /// 正文长度（字符数，SQLite LENGTH 对 TEXT 按字符计）
    pub content_len: i64,
    /// 当前正文的 SHA-256（notes.content_hash）
    pub note_hash: String,
    /// 最近一次抽取状态；None = 尚未抽取
    pub run_status: Option<String>,
    /// 最近一次成功抽取时记录的正文哈希
    pub run_hash: Option<String>,
}

struct NoteEntityRow {
    note_id: i64,
    note_title: String,
    norm_name: String,
    name: String,
    entity_type: String,
    description: String,
}

struct NoteRelationRow {
    note_id: i64,
    source_norm: String,
    target_norm: String,
    description: String,
    keywords: String,
}

impl Database {
    /// 原子替换一篇笔记的抽取结果，并写入运行状态。
    pub fn replace_llm_graph(
        &self,
        note_id: i64,
        content_hash: &str,
        model_id: &str,
        prompt_version: i32,
        entities: &[LlmEntityRow],
        relations: &[LlmRelationRow],
    ) -> Result<(), AppError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let tx = conn.transaction()?;

        tx.execute(
            "DELETE FROM llm_graph_relations WHERE note_id = ?1",
            params![note_id],
        )?;
        tx.execute(
            "DELETE FROM llm_graph_entities WHERE note_id = ?1",
            params![note_id],
        )?;

        for e in entities {
            tx.execute(
                "INSERT OR REPLACE INTO llm_graph_entities
                    (note_id, norm_name, name, entity_type, description)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![note_id, e.norm_name, e.name, e.entity_type, e.description],
            )?;
        }
        for r in relations {
            tx.execute(
                "INSERT OR REPLACE INTO llm_graph_relations
                    (note_id, source_norm, target_norm, description, keywords)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![note_id, r.source_norm, r.target_norm, r.description, r.keywords],
            )?;
        }

        tx.execute(
            "INSERT INTO llm_graph_runs
                (note_id, content_hash, model_id, prompt_version, status,
                 entity_count, relation_count, error, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'done', ?5, ?6, NULL, datetime('now','localtime'))
             ON CONFLICT(note_id) DO UPDATE SET
                content_hash = excluded.content_hash,
                model_id = excluded.model_id,
                prompt_version = excluded.prompt_version,
                status = 'done',
                entity_count = excluded.entity_count,
                relation_count = excluded.relation_count,
                error = NULL,
                updated_at = excluded.updated_at",
            params![
                note_id,
                content_hash,
                model_id,
                prompt_version,
                entities.len() as i64,
                relations.len() as i64
            ],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// 记录抽取失败（保留旧实体/关系，便于继续使用上次结果）。
    pub fn mark_llm_graph_failed(
        &self,
        note_id: i64,
        content_hash: &str,
        model_id: &str,
        prompt_version: i32,
        error: &str,
    ) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO llm_graph_runs
                (note_id, content_hash, model_id, prompt_version, status,
                 entity_count, relation_count, error, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'failed', 0, 0, ?5, datetime('now','localtime'))
             ON CONFLICT(note_id) DO UPDATE SET
                content_hash = excluded.content_hash,
                model_id = excluded.model_id,
                prompt_version = excluded.prompt_version,
                status = 'failed',
                error = excluded.error,
                updated_at = excluded.updated_at",
            params![note_id, content_hash, model_id, prompt_version, error],
        )?;
        Ok(())
    }

    /// 删除一篇笔记的全部 LLM 图谱数据。
    pub fn delete_llm_graph(&self, note_id: i64) -> Result<(), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "DELETE FROM llm_graph_relations WHERE note_id = ?1",
            params![note_id],
        )?;
        conn.execute(
            "DELETE FROM llm_graph_entities WHERE note_id = ?1",
            params![note_id],
        )?;
        conn.execute(
            "DELETE FROM llm_graph_runs WHERE note_id = ?1",
            params![note_id],
        )?;
        Ok(())
    }

    /// 查询单篇笔记的抽取状态。
    pub fn get_llm_extraction_status(
        &self,
        note_id: i64,
    ) -> Result<Option<LlmExtractionStatus>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let result = conn
            .query_row(
                "SELECT note_id, status, entity_count, relation_count,
                        model_id, prompt_version, error, updated_at
                 FROM llm_graph_runs WHERE note_id = ?1",
                params![note_id],
                |r| {
                    Ok(LlmExtractionStatus {
                        note_id: r.get(0)?,
                        status: r.get(1)?,
                        entity_count: r.get(2)?,
                        relation_count: r.get(3)?,
                        model_id: r.get(4)?,
                        prompt_version: r.get(5)?,
                        error: r.get(6)?,
                        updated_at: r.get(7)?,
                    })
                },
            )
            .optional()?;
        Ok(result)
    }

    /// 读取增量判断所需的运行信息：(content_hash, model_id, prompt_version, entity_count, relation_count)。
    pub fn get_llm_graph_run(
        &self,
        note_id: i64,
    ) -> Result<Option<(String, String, i32, i64, i64)>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let result = conn
            .query_row(
                "SELECT content_hash, model_id, prompt_version, entity_count, relation_count
                 FROM llm_graph_runs WHERE note_id = ?1 AND status = 'done'",
                params![note_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i32>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()?;
        Ok(result)
    }

    /// 按规范化实体名查询包含它的文档（用于“相关文档”列表）。
    pub fn list_llm_entity_notes(
        &self,
        norm_name: &str,
        limit: usize,
    ) -> Result<Vec<LlmEntityNote>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, e.entity_type, e.description
             FROM llm_graph_entities e
             JOIN notes n ON n.id = e.note_id
             WHERE e.norm_name = ?1 AND n.is_deleted = 0 AND n.is_hidden = 0
             ORDER BY n.updated_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![norm_name, limit.max(1) as i64], |r| {
            Ok(LlmEntityNote {
                note_id: r.get(0)?,
                note_title: r.get(1)?,
                entity_type: r.get(2)?,
                description: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 列出作用域内需要抽取的笔记（按更新时间倒序）。
    pub fn list_llm_graph_note_ids(
        &self,
        folder_id: Option<i64>,
        limit: usize,
    ) -> Result<Vec<i64>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let limit = limit.max(1) as i64;

        let mut ids = Vec::new();
        if let Some(root) = folder_id {
            let mut stmt = conn.prepare(
                "WITH RECURSIVE sub(id) AS (
                     SELECT ?1
                     UNION
                     SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
                 )
                 SELECT n.id FROM notes n
                 WHERE n.is_deleted = 0 AND n.is_hidden = 0
                   AND n.folder_id IN (SELECT id FROM sub)
                 ORDER BY n.updated_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![root, limit], |r| r.get::<_, i64>(0))?;
            for row in rows {
                ids.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id FROM notes
                 WHERE is_deleted = 0 AND is_hidden = 0
                 ORDER BY updated_at DESC
                 LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit], |r| r.get::<_, i64>(0))?;
            for row in rows {
                ids.push(row?);
            }
        }
        Ok(ids)
    }

    /// 列出作用域内笔记的图谱状态原始数据（不加载正文，只取长度与哈希）。
    ///
    /// 状态聚合放在 service 层：这里只负责把「笔记内容指纹」与「抽取运行记录」
    /// 一次查询出来，避免 N+1。
    pub fn list_llm_graph_scope_notes(
        &self,
        folder_id: Option<i64>,
    ) -> Result<Vec<LlmGraphScopeNoteRow>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        let mut out = Vec::new();
        if let Some(root) = folder_id {
            let mut stmt = conn.prepare(
                "WITH RECURSIVE sub(id) AS (
                     SELECT ?1
                     UNION
                     SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
                 )
                 SELECT LENGTH(n.content), COALESCE(n.content_hash, ''),
                        r.status, r.content_hash
                 FROM notes n
                 LEFT JOIN llm_graph_runs r ON r.note_id = n.id
                 WHERE n.is_deleted = 0 AND n.is_hidden = 0
                   AND n.folder_id IN (SELECT id FROM sub)",
            )?;
            let rows = stmt.query_map(params![root], |r| {
                Ok(LlmGraphScopeNoteRow {
                    content_len: r.get(0)?,
                    note_hash: r.get(1)?,
                    run_status: r.get(2)?,
                    run_hash: r.get(3)?,
                })
            })?;
            for row in rows {
                out.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT LENGTH(n.content), COALESCE(n.content_hash, ''),
                        r.status, r.content_hash
                 FROM notes n
                 LEFT JOIN llm_graph_runs r ON r.note_id = n.id
                 WHERE n.is_deleted = 0 AND n.is_hidden = 0",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(LlmGraphScopeNoteRow {
                    content_len: r.get(0)?,
                    note_hash: r.get(1)?,
                    run_status: r.get(2)?,
                    run_hash: r.get(3)?,
                })
            })?;
            for row in rows {
                out.push(row?);
            }
        }
        Ok(out)
    }

    /// 聚合作用域内的 LLM 图谱。
    pub fn get_llm_graph_data(
        &self,
        folder_id: Option<i64>,
        note_id: Option<i64>,
        max_nodes: usize,
    ) -> Result<LlmGraphData, AppError> {
        let (entities, relations) = self.load_llm_rows(folder_id, note_id)?;

        // 实体聚合：norm_name -> (name, type, description, note_ids)
        struct Agg {
            name: String,
            entity_type: String,
            description: String,
            note_ids: HashSet<i64>,
        }
        let mut map: HashMap<String, Agg> = HashMap::new();
        let mut note_titles: HashMap<i64, String> = HashMap::new();
        for row in entities {
            note_titles
                .entry(row.note_id)
                .or_insert_with(|| row.note_title.clone());
            let entry = map.entry(row.norm_name).or_insert_with(|| Agg {
                name: row.name.clone(),
                entity_type: row.entity_type.clone(),
                description: row.description.clone(),
                note_ids: HashSet::new(),
            });
            entry.note_ids.insert(row.note_id);
            if row.description.len() > entry.description.len() {
                entry.description = row.description;
            }
            if entry.entity_type.is_empty() || entry.entity_type == "concept" {
                if !row.entity_type.is_empty() {
                    entry.entity_type = row.entity_type;
                }
            }
            // 保留首次出现的展示名，避免长描述型名称覆盖规范名
        }

        // 关系聚合：(source, target, description) -> note_ids
        struct RelAgg {
            source: String,
            target: String,
            description: String,
            keywords: String,
            note_ids: HashSet<i64>,
        }
        let mut rel_map: HashMap<(String, String, String), RelAgg> = HashMap::new();
        for row in relations {
            if !map.contains_key(&row.source_norm) || !map.contains_key(&row.target_norm) {
                continue;
            }
            let key = (
                row.source_norm.clone(),
                row.target_norm.clone(),
                row.description.clone(),
            );
            let entry = rel_map.entry(key).or_insert_with(|| RelAgg {
                source: row.source_norm,
                target: row.target_norm,
                description: row.description,
                keywords: row.keywords,
                note_ids: HashSet::new(),
            });
            entry.note_ids.insert(row.note_id);
        }

        // 度数
        let mut degree: HashMap<String, i64> = HashMap::new();
        for rel in rel_map.values() {
            *degree.entry(rel.source.clone()).or_insert(0) += 1;
            *degree.entry(rel.target.clone()).or_insert(0) += 1;
        }

        let mut names: Vec<String> = map.keys().cloned().collect();
        names.sort_by(|a, b| {
            let da = degree.get(a).copied().unwrap_or(0);
            let db = degree.get(b).copied().unwrap_or(0);
            db.cmp(&da).then_with(|| a.cmp(b))
        });
        let keep: HashSet<String> = names.into_iter().take(max_nodes.max(1)).collect();

        let mut id_map: HashMap<String, i64> = HashMap::new();
        let mut nodes: Vec<LlmGraphNode> = Vec::with_capacity(keep.len());
        for (idx, norm) in keep.iter().enumerate() {
            let agg = &map[norm];
            let id = idx as i64 + 1;
            id_map.insert(norm.clone(), id);
            nodes.push(LlmGraphNode {
                id,
                name: agg.name.clone(),
                entity_type: agg.entity_type.clone(),
                description: agg.description.clone(),
                note_ids: {
                    let mut v: Vec<i64> = agg.note_ids.iter().copied().collect();
                    v.sort_unstable();
                    v
                },
                degree: degree.get(norm).copied().unwrap_or(0),
            });
        }

        let mut edges: Vec<LlmGraphEdge> = Vec::new();
        for rel in rel_map.values() {
            let (Some(&s), Some(&t)) = (id_map.get(&rel.source), id_map.get(&rel.target)) else {
                continue;
            };
            edges.push(LlmGraphEdge {
                source: s,
                target: t,
                description: rel.description.clone(),
                keywords: rel.keywords.clone(),
                note_ids: {
                    let mut v: Vec<i64> = rel.note_ids.iter().copied().collect();
                    v.sort_unstable();
                    v
                },
            });
        }

        let note_count = note_titles.len() as i64;
        let mut titles: Vec<String> = note_titles.into_values().collect();
        titles.sort();
        titles.truncate(20);

        Ok(LlmGraphData {
            nodes,
            edges,
            note_count,
            note_titles: titles,
        })
    }

    fn load_llm_rows(
        &self,
        folder_id: Option<i64>,
        note_id: Option<i64>,
    ) -> Result<(Vec<NoteEntityRow>, Vec<NoteRelationRow>), AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // note_id 优先：直接按单篇文档过滤；否则按文件夹子树 / 全库
        let by_note = note_id.is_some();
        let by_folder = !by_note && folder_id.is_some();

        let cte = if by_folder {
            "WITH RECURSIVE sub(id) AS (
                 SELECT ?1
                 UNION
                 SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
             ) "
        } else {
            ""
        };
        let scope_e = if by_note {
            " AND e.note_id = ?1"
        } else if by_folder {
            " AND n.folder_id IN (SELECT id FROM sub)"
        } else {
            ""
        };
        let scope_r = if by_note {
            " AND r.note_id = ?1"
        } else if by_folder {
            " AND n.folder_id IN (SELECT id FROM sub)"
        } else {
            ""
        };

        let sql_entities = format!(
            "{cte}
             SELECT e.note_id, n.title, e.norm_name, e.name, e.entity_type, e.description
             FROM llm_graph_entities e
             JOIN notes n ON n.id = e.note_id
             WHERE n.is_deleted = 0 AND n.is_hidden = 0{scope_e}
             ORDER BY e.id"
        );
        let sql_relations = format!(
            "{cte}
             SELECT r.note_id, r.source_norm, r.target_norm, r.description, r.keywords
             FROM llm_graph_relations r
             JOIN notes n ON n.id = r.note_id
             WHERE n.is_deleted = 0 AND n.is_hidden = 0{scope_r}
             ORDER BY r.id"
        );

        let mut entities = Vec::new();
        {
            let mut stmt = conn.prepare(&sql_entities)?;
            let mut rows = if let Some(nid) = note_id {
                stmt.query(params![nid])?
            } else if let Some(root) = folder_id {
                stmt.query(params![root])?
            } else {
                stmt.query([])?
            };
            while let Some(r) = rows.next()? {
                entities.push(NoteEntityRow {
                    note_id: r.get(0)?,
                    note_title: r.get(1)?,
                    norm_name: r.get(2)?,
                    name: r.get(3)?,
                    entity_type: r.get(4)?,
                    description: r.get(5)?,
                });
            }
        }

        let mut relations = Vec::new();
        {
            let mut stmt = conn.prepare(&sql_relations)?;
            let mut rows = if let Some(nid) = note_id {
                stmt.query(params![nid])?
            } else if let Some(root) = folder_id {
                stmt.query(params![root])?
            } else {
                stmt.query([])?
            };
            while let Some(r) = rows.next()? {
                relations.push(NoteRelationRow {
                    note_id: r.get(0)?,
                    source_norm: r.get(1)?,
                    target_norm: r.get(2)?,
                    description: r.get(3)?,
                    keywords: r.get(4)?,
                });
            }
        }

        Ok((entities, relations))
    }
}
