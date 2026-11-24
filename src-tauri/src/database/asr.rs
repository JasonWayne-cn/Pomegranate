//! ASR 术语词表 DAO。
//!
//! 表结构见 `schema.rs` 的 v93 -> v94 迁移。
//! `aliases` 以 JSON 数组文本存储（空 = `[]`），读取时容错解析，
//! 避免历史数据被外部脚本改坏后整表不可读。
//!
//! 业务约定：
//! - `term` 唯一（`COLLATE NOCASE`），大小写不同的同名术语视为同一条目
//! - 新增时若已存在，合并别名而不是报错，减少用户重复录入的摩擦

use rusqlite::{params, OptionalExtension};

use super::Database;
use crate::error::AppError;
use crate::models::AsrVocabularyTerm;

fn row_to_term(row: &rusqlite::Row<'_>) -> rusqlite::Result<AsrVocabularyTerm> {
    let aliases_raw: String = row.get(2)?;
    let aliases = serde_json::from_str::<Vec<String>>(&aliases_raw).unwrap_or_default();
    Ok(AsrVocabularyTerm {
        id: row.get(0)?,
        term: row.get(1)?,
        aliases,
        created_at: row.get(3)?,
    })
}

impl Database {
    /// 按术语字母序列出全部词条。
    pub fn list_asr_vocabulary(&self) -> Result<Vec<AsrVocabularyTerm>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, term, aliases, created_at FROM asr_vocabulary ORDER BY term COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], row_to_term)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 新增术语；同 term（大小写不敏感）已存在时合并别名并返回已有 id。
    pub fn upsert_asr_vocabulary(&self, term: &str, aliases: &[String]) -> Result<i64, AppError> {
        let term = term.trim();
        if term.is_empty() {
            return Err(AppError::InvalidInput("术语不能为空".into()));
        }

        let mut incoming: Vec<String> = Vec::new();
        for a in aliases {
            let a = a.trim();
            if !a.is_empty() && !incoming.iter().any(|x| x.eq_ignore_ascii_case(a)) {
                incoming.push(a.to_string());
            }
        }

        let conn = self.conn_lock()?;
        let existing: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, aliases FROM asr_vocabulary WHERE term = ?1 COLLATE NOCASE",
                params![term],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        if let Some((id, aliases_raw)) = existing {
            let mut merged = serde_json::from_str::<Vec<String>>(&aliases_raw).unwrap_or_default();
            for a in incoming {
                if !merged.iter().any(|x| x.eq_ignore_ascii_case(&a)) {
                    merged.push(a);
                }
            }
            let json = serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into());
            conn.execute(
                "UPDATE asr_vocabulary SET aliases = ?1 WHERE id = ?2",
                params![json, id],
            )?;
            return Ok(id);
        }

        let json = serde_json::to_string(&incoming).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "INSERT INTO asr_vocabulary (term, aliases, created_at)
             VALUES (?1, ?2, datetime('now', 'localtime'))",
            params![term, json],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 删除一条词条；返回是否真的删掉了。
    pub fn remove_asr_vocabulary(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM asr_vocabulary WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Database {
        Database::init(":memory:").unwrap()
    }

    #[test]
    fn add_and_list() {
        let db = db();
        let id = db
            .upsert_asr_vocabulary("Tauri", &["涛瑞".into(), "陶瑞".into(), "  ".into()])
            .unwrap();
        assert!(id > 0);

        let list = db.list_asr_vocabulary().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].term, "Tauri");
        // 空白别名被丢弃
        assert_eq!(list[0].aliases, vec!["涛瑞", "陶瑞"]);
    }

    #[test]
    fn upsert_merges_aliases_case_insensitively() {
        let db = db();
        db.upsert_asr_vocabulary("tauri", &["涛瑞".into()]).unwrap();
        let id = db.upsert_asr_vocabulary("Tauri", &["涛瑞".into(), "TAORUI".into()]).unwrap();

        let list = db.list_asr_vocabulary().unwrap();
        assert_eq!(list.len(), 1, "大小写不同应视为同一条");
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].aliases, vec!["涛瑞", "TAORUI"]);
    }

    #[test]
    fn empty_term_rejected() {
        let db = db();
        assert!(db.upsert_asr_vocabulary("   ", &[]).is_err());
    }

    #[test]
    fn remove_works() {
        let db = db();
        let id = db.upsert_asr_vocabulary("Rust", &[]).unwrap();
        assert!(db.remove_asr_vocabulary(id).unwrap());
        assert!(!db.remove_asr_vocabulary(id).unwrap());
        assert!(db.list_asr_vocabulary().unwrap().is_empty());
    }
}
