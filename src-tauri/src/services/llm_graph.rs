//! LLM 文档图谱抽取服务（P1）。
//!
//! 复用现有 AI 模型配置与 `AiService::complete_once`：按 6000 字符分块，
//! 逐块让模型输出实体/关系 JSON，合并后按文档写入 SQLite。
//!
//! 设计约束：
//! - 只使用显式原文信息，Prompt 禁止推测；
//! - 关系两端必须落在实体集合内，避免悬空边；
//! - 分块与整体数量都有上限，控制单篇成本。

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde::Deserialize;
use serde_json::Value;
use tauri::Emitter;

use crate::database::llm_graph::{LlmEntityRow, LlmRelationRow};
use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    LlmExtractBatchItem, LlmExtractResult, LlmGraphProgress, LlmGraphScopeStatus,
};
use crate::services::ai::AiService;
use crate::services::embedding::chunk_text;
use crate::services::hash::sha256_hex;

const PROGRESS_EVENT: &str = "llm-graph:progress";

/// 抽取进度上下文（单篇或批量）。
pub struct ExtractProgress<'a> {
    pub app: Option<&'a tauri::AppHandle>,
    /// "note" | "folder"
    pub scope: &'a str,
    pub note_index: usize,
    pub note_total: usize,
    pub start: Instant,
}

impl<'a> ExtractProgress<'a> {
    #[allow(clippy::too_many_arguments)]
    fn emit(
        &self,
        phase: &str,
        note_id: i64,
        note_title: &str,
        chunk: usize,
        chunks: usize,
        entities: usize,
        relations: usize,
        error: Option<String>,
    ) {
        let Some(app) = self.app else {
            return;
        };
        let payload = LlmGraphProgress {
            scope: self.scope.to_string(),
            phase: phase.to_string(),
            note_id,
            note_title: note_title.to_string(),
            note_index: self.note_index,
            note_total: self.note_total,
            chunk,
            chunks,
            elapsed_ms: self.start.elapsed().as_millis() as u64,
            entities,
            relations,
            error,
        };
        if let Err(e) = app.emit(PROGRESS_EVENT, payload) {
            log::debug!("[llm-graph] 进度事件发送失败: {}", e);
        }
    }
}

/// Prompt 版本：调整抽取规则或 JSON schema 时递增。
/// v2：收紧描述的事实约束、实体名不翻译、同义合并、弱关系过滤。
pub const PROMPT_VERSION: i32 = 2;

const CHUNK_CHARS: usize = 6000;
const MAX_CHUNKS: usize = 8;
const MAX_ENTITIES: usize = 120;
const MAX_RELATIONS: usize = 240;

const ALLOWED_TYPES: [&str; 8] = [
    "artifact",
    "concept",
    "method",
    "data",
    "person",
    "content",
    "organization",
    "event",
];

#[derive(Deserialize)]
struct RawPayload {
    #[serde(default)]
    entities: Vec<RawEntity>,
    #[serde(default)]
    relations: Vec<RawRelation>,
}

#[derive(Deserialize)]
struct RawEntity {
    #[serde(default)]
    name: String,
    #[serde(default, alias = "entity_type", alias = "type")]
    entity_type: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
struct RawRelation {
    #[serde(default, alias = "from")]
    source: String,
    #[serde(default, alias = "to")]
    target: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    keywords: Value,
}

/// 规范化实体名：拆分 camelCase / 分隔符、折叠空白、去首尾标点、统一小写。
///
/// 作为跨文档聚合键，使 `PipeSequenceService`、`pipe_sequence_service`、
/// `pipe sequence service` 落到同一个实体上。
pub fn normalize_entity_name(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::with_capacity(name.len() + 8);
    let mut prev: Option<char> = None;

    for (i, &c) in chars.iter().enumerate() {
        if matches!(c, '_' | '-' | ':' | '/' | '\\' | '·' | '|') {
            out.push(' ');
            prev = Some(' ');
            continue;
        }
        if c.is_uppercase() {
            if let Some(p) = prev {
                // camelCase：小写/数字后接大写
                if p.is_lowercase() || p.is_ascii_digit() {
                    out.push(' ');
                // 缩写边界：连续大写后接小写（HTTPServer → HTTP Server）
                } else if p.is_uppercase()
                    && chars.get(i + 1).is_some_and(|next| next.is_lowercase())
                {
                    out.push(' ');
                }
            }
        }
        out.push(c);
        prev = Some(c);
    }

    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .trim_matches(|c: char| {
            c.is_ascii_punctuation()
                || matches!(
                    c,
                    '“' | '”' | '‘' | '’' | '《' | '》' | '（' | '）' | '【' | '】'
                )
        })
        .to_lowercase()
}

/// 从分块中选择最多 `max` 块，均匀覆盖首、中、尾。
fn select_chunks<'a>(chunks: Vec<&'a str>, max: usize) -> Vec<&'a str> {
    let n = chunks.len();
    if max == 0 {
        return Vec::new();
    }
    if n <= max {
        return chunks;
    }
    if max == 1 {
        return vec![chunks[0]];
    }
    (0..max)
        .map(|i| chunks[i * (n - 1) / (max - 1)])
        .collect()
}

/// 正文指纹。与 `notes.content_hash` 使用同一算法（SHA-256），
/// 这样作用域状态查询可以直接用 SQL 比较，不必把每篇正文读进内存。
fn content_hash(content: &str) -> String {
    sha256_hex(content)
}

/// 超过该长度的文档只会抽取 `MAX_CHUNKS` 个采样块，视为“部分建图”。
fn partial_char_limit() -> i64 {
    (MAX_CHUNKS * CHUNK_CHARS) as i64
}

/// 聚合一个作用域（文件夹子树 / 全库）的建图状态。
pub fn scope_status(
    db: &Database,
    folder_id: Option<i64>,
) -> Result<LlmGraphScopeStatus, AppError> {
    let rows = db.list_llm_graph_scope_notes(folder_id)?;
    // 空文档没有可抽取内容，不计入“需要建图”的总数，
    // 否则永远无法达到“全建图”。
    let total = rows.iter().filter(|r| r.content_len > 0).count() as i64;
    let mut built = 0i64;
    let mut partial = 0i64;
    let mut stale = 0i64;
    let mut failed = 0i64;

    for row in rows {
        if row.content_len == 0 {
            continue;
        }
        match row.run_status.as_deref() {
            Some("done") => {
                if row.run_hash.as_deref() != Some(row.note_hash.as_str()) {
                    stale += 1;
                } else if row.content_len > partial_char_limit() {
                    partial += 1;
                } else {
                    built += 1;
                }
            }
            Some("failed") => failed += 1,
            _ => {}
        }
    }

    let state = if total == 0 {
        "none"
    } else if stale > 0 {
        // 有更新优先暴露，提示用户重新抽取
        "stale"
    } else if built + partial == total {
        if partial > 0 {
            "partial"
        } else {
            "full"
        }
    } else if built + partial > 0 {
        "partial"
    } else {
        "none"
    };

    Ok(LlmGraphScopeStatus {
        state: state.to_string(),
        total,
        built,
        partial,
        stale,
        failed,
    })
}

fn build_prompt(title: &str, chunk: &str) -> String {
    format!(
        r#"你是知识图谱抽取器。只依据给定原文，不补充外部知识，不做推测。

输出严格 JSON：
{{"entities":[{{"name":"","type":"artifact|concept|method|data|person|content|organization|event","description":""}}],"relations":[{{"source":"实体名","target":"实体名","description":"","keywords":["关键词"]}}]}}

规则：
- 实体名使用原文写法并保留原语言；不要翻译、不要缩写、不要附加版本号或编号；
- 同一事物的不同写法（中英文、缩写、全称）合并为一个实体；
- description 只能写原文明确出现的事实；禁止补充原文没有的原因、效果、数字、版本、评价；
- 关系只保留原文可直接陈述的；仅在同一段落共现、没有明确语义关系时不要输出；
- 关系两端必须出现在 entities 中；
- 短文本也要覆盖全部关键实体；
- 最多 40 个实体、60 条关系；
- 只输出 JSON，不要代码块标记或解释。

文档标题：{title}

原文：
{chunk}"#
    )
}

fn parse_payload(text: &str) -> Option<RawPayload> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&text[start..=end]).ok()
}

fn keywords_to_string(value: &Value) -> String {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        Value::String(s) => s.trim().to_string(),
        _ => String::new(),
    }
}

/// 抽取单篇文档并落库。
pub async fn extract_note(
    db: &Database,
    note_id: i64,
    progress: &ExtractProgress<'_>,
) -> Result<LlmExtractResult, AppError> {
    let note = db
        .get_note(note_id)?
        .ok_or_else(|| AppError::NotFound("文档不存在".into()))?;

    let model = db.get_default_ai_model()?;
    let model_id = model.model_id.clone();
    let hash = content_hash(&note.content);

    // 增量：内容、模型、Prompt 版本均未变化时直接复用上次结果
    if let Some((cached_hash, cached_model, cached_version, entities, relations)) =
        db.get_llm_graph_run(note_id)?
    {
        if cached_hash == hash
            && cached_model == model_id
            && cached_version == PROMPT_VERSION
        {
            progress.emit(
                "note-done",
                note_id,
                &note.title,
                0,
                0,
                entities as usize,
                relations as usize,
                None,
            );
            return Ok(LlmExtractResult {
                note_id,
                entity_count: entities as usize,
                relation_count: relations as usize,
                chunks: 0,
                model_id,
                prompt_version: PROMPT_VERSION,
            });
        }
    }

    if note.content.trim().is_empty() {
        db.replace_llm_graph(note_id, &hash, &model_id, PROMPT_VERSION, &[], &[])?;
        progress.emit("note-done", note_id, &note.title, 0, 0, 0, 0, None);
        return Ok(LlmExtractResult {
            note_id,
            entity_count: 0,
            relation_count: 0,
            chunks: 0,
            model_id,
            prompt_version: PROMPT_VERSION,
        });
    }

    // 长文档均匀取块，覆盖开头、中段与结尾，而不是只取前 8 块
    let chunks = select_chunks(chunk_text(&note.content, CHUNK_CHARS), MAX_CHUNKS);
    let chunk_count = chunks.len();

    // norm -> 实体；description 取最长的一版
    let mut entities: HashMap<String, LlmEntityRow> = HashMap::new();
    // (source, target, description) -> 关系
    let mut relations: HashMap<(String, String, String), LlmRelationRow> = HashMap::new();
    let mut success_chunks = 0usize;
    let mut last_error: Option<String> = None;

    progress.emit(
        "note-start",
        note_id,
        &note.title,
        0,
        chunk_count,
        0,
        0,
        None,
    );

    for (i, chunk) in chunks.iter().enumerate() {
        let prompt = build_prompt(&note.title, chunk);
        progress.emit(
            "chunk-start",
            note_id,
            &note.title,
            i + 1,
            chunk_count,
            entities.len(),
            relations.len(),
            None,
        );
        match AiService::complete_once(db, &prompt, None).await {
            Ok(text) => match parse_payload(&text) {
                Some(payload) => {
                    success_chunks += 1;
                    merge_payload(&mut entities, &mut relations, payload);
                }
                None => {
                    last_error = Some("模型输出不是有效 JSON".into());
                    log::warn!(
                        "[llm-graph] 文档 {} 的某个分块解析失败，已跳过",
                        note_id
                    );
                }
            },
            Err(e) => {
                last_error = Some(e.to_string());
                log::warn!("[llm-graph] 文档 {} 抽取失败: {}", note_id, e);
            }
        }
        progress.emit(
            "chunk-done",
            note_id,
            &note.title,
            i + 1,
            chunk_count,
            entities.len(),
            relations.len(),
            None,
        );
    }

    if success_chunks == 0 {
        let msg = last_error.unwrap_or_else(|| "抽取未返回有效结果".into());
        db.mark_llm_graph_failed(note_id, &hash, &model_id, PROMPT_VERSION, &msg)?;
        progress.emit(
            "note-error",
            note_id,
            &note.title,
            0,
            chunk_count,
            0,
            0,
            Some(msg.clone()),
        );
        return Err(AppError::Custom(format!("LLM 图谱抽取失败: {}", msg)));
    }

    // 数量上限（保持插入顺序不可控，按名称排序以保证稳定）
    let mut entity_rows: Vec<LlmEntityRow> = entities.into_values().collect();
    entity_rows.sort_by(|a, b| a.norm_name.cmp(&b.norm_name));
    entity_rows.truncate(MAX_ENTITIES);
    let kept: HashSet<&str> = entity_rows.iter().map(|e| e.norm_name.as_str()).collect();

    let mut relation_rows: Vec<LlmRelationRow> = relations
        .into_values()
        .filter(|r| kept.contains(r.source_norm.as_str()) && kept.contains(r.target_norm.as_str()))
        .collect();
    relation_rows.sort_by(|a, b| {
        (a.source_norm.as_str(), a.target_norm.as_str(), a.description.as_str()).cmp(&(
            b.source_norm.as_str(),
            b.target_norm.as_str(),
            b.description.as_str(),
        ))
    });
    relation_rows.truncate(MAX_RELATIONS);

    db.replace_llm_graph(
        note_id,
        &hash,
        &model_id,
        PROMPT_VERSION,
        &entity_rows,
        &relation_rows,
    )?;

    progress.emit(
        "note-done",
        note_id,
        &note.title,
        chunk_count,
        chunk_count,
        entity_rows.len(),
        relation_rows.len(),
        None,
    );

    Ok(LlmExtractResult {
        note_id,
        entity_count: entity_rows.len(),
        relation_count: relation_rows.len(),
        chunks: chunk_count,
        model_id,
        prompt_version: PROMPT_VERSION,
    })
}

fn merge_payload(
    entities: &mut HashMap<String, LlmEntityRow>,
    relations: &mut HashMap<(String, String, String), LlmRelationRow>,
    payload: RawPayload,
) {
    for raw in payload.entities {
        let name = raw.name.trim();
        let norm = normalize_entity_name(name);
        if norm.is_empty() {
            continue;
        }
        let entity_type = if ALLOWED_TYPES.contains(&raw.entity_type.as_str()) {
            raw.entity_type
        } else {
            "concept".to_string()
        };
        let description = raw.description.trim().to_string();
        match entities.get_mut(&norm) {
            Some(existing) => {
                if description.len() > existing.description.len() {
                    existing.description = description;
                }
                if existing.entity_type == "concept" && entity_type != "concept" {
                    existing.entity_type = entity_type;
                }
            }
            None => {
                entities.insert(
                    norm.clone(),
                    LlmEntityRow {
                        norm_name: norm,
                        name: name.to_string(),
                        entity_type,
                        description,
                    },
                );
            }
        }
    }

    for raw in payload.relations {
        let source = normalize_entity_name(&raw.source);
        let target = normalize_entity_name(&raw.target);
        if source.is_empty() || target.is_empty() || source == target {
            continue;
        }
        let description = raw.description.trim().to_string();
        if description.is_empty() {
            continue;
        }
        let keywords = keywords_to_string(&raw.keywords);
        relations
            .entry((source.clone(), target.clone(), description.clone()))
            .or_insert(LlmRelationRow {
                source_norm: source,
                target_norm: target,
                description,
                keywords,
            });
    }
}

/// 批量抽取（顺序执行，避免瞬时打满模型配额）。
pub async fn extract_notes(
    db: &Database,
    note_ids: &[i64],
    app: Option<&tauri::AppHandle>,
) -> Vec<LlmExtractBatchItem> {
    let mut out = Vec::with_capacity(note_ids.len());
    let total = note_ids.len();
    let start = Instant::now();
    for (i, id) in note_ids.iter().enumerate() {
        let progress = ExtractProgress {
            app,
            scope: "folder",
            note_index: i + 1,
            note_total: total,
            start,
        };
        match extract_note(db, *id, &progress).await {
            Ok(result) => out.push(LlmExtractBatchItem {
                note_id: *id,
                ok: true,
                error: None,
                result: Some(result),
            }),
            Err(e) => out.push(LlmExtractBatchItem {
                note_id: *id,
                ok: false,
                error: Some(e.to_string()),
                result: None,
            }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_entity_name_collapses_and_lowercases() {
        assert_eq!(normalize_entity_name("  Loquat   PIPE "), "loquat pipe");
        assert_eq!(normalize_entity_name("《导管》"), "导管");
    }

    #[test]
    fn normalize_entity_name_splits_camel_and_separators() {
        assert_eq!(
            normalize_entity_name("PipeSequenceService"),
            "pipe sequence service"
        );
        assert_eq!(
            normalize_entity_name("pipe_sequence_service"),
            "pipe sequence service"
        );
        assert_eq!(
            normalize_entity_name("QMessageBox::warning"),
            "q message box warning"
        );
        assert_eq!(normalize_entity_name("HTTPServer"), "http server");
    }

    #[test]
    fn select_chunks_covers_first_middle_last() {
        let chunks = vec!["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
        assert_eq!(select_chunks(chunks, 3), vec!["0", "4", "9"]);
    }

    #[test]
    fn parse_payload_tolerates_code_fence() {
        let text = "```json\n{\"entities\":[{\"name\":\"A\",\"type\":\"concept\",\"description\":\"d\"}],\"relations\":[]}\n```";
        let payload = parse_payload(text).expect("parse");
        assert_eq!(payload.entities.len(), 1);
        assert_eq!(payload.entities[0].entity_type, "concept");
    }

    #[test]
    fn merge_payload_dedups_and_skips_self_relation() {
        let mut entities = HashMap::new();
        let mut relations = HashMap::new();
        let payload = RawPayload {
            entities: vec![RawEntity {
                name: "A".into(),
                entity_type: "concept".into(),
                description: "a".into(),
            }],
            relations: vec![
                RawRelation {
                    source: "A".into(),
                    target: "B".into(),
                    description: "r".into(),
                    keywords: Value::Array(vec![Value::String("k".into())]),
                },
                RawRelation {
                    source: "A".into(),
                    target: "A".into(),
                    description: "self".into(),
                    keywords: Value::Null,
                },
            ],
        };
        merge_payload(&mut entities, &mut relations, payload);
        assert_eq!(entities.len(), 1);
        assert_eq!(relations.len(), 1);
    }
}
