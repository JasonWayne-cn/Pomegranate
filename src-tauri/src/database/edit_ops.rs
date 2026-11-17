//! Office 编辑操作日志（edit_ops）。
//!
//! 只记录"做了什么"，不保存文件内容；用于审计、撤销提示与后续协同。

use serde::Serialize;

use super::Database;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
pub struct EditOp {
    pub id: i64,
    pub domain: String,
    pub target: String,
    pub source: String,
    pub op_json: String,
    pub created_at: String,
}

impl Database {
    pub fn insert_edit_op(
        &self,
        domain: &str,
        target: &str,
        source: &str,
        op_json: &str,
    ) -> Result<i64, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        conn.execute(
            "INSERT INTO edit_ops (domain, target, source, op_json) VALUES (?1, ?2, ?3, ?4)",
            (domain, target, source, op_json),
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_edit_ops(&self, target: &str, limit: usize) -> Result<Vec<EditOp>, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, domain, target, source, op_json, created_at
             FROM edit_ops WHERE target = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map((target, limit as i64), |row| {
            Ok(EditOp {
                id: row.get(0)?,
                domain: row.get(1)?,
                target: row.get(2)?,
                source: row.get(3)?,
                op_json: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn clear_edit_ops(&self, target: &str) -> Result<usize, AppError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        Ok(conn.execute("DELETE FROM edit_ops WHERE target = ?1", [target])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_ops_roundtrip() {
        let db = Database::init(":memory:").expect("in-memory db");
        let id = db
            .insert_edit_op("pptx", "deck.pptx", "user", r#"{"kind":"setText"}"#)
            .expect("insert");
        assert!(id > 0);

        let ops = db.list_edit_ops("deck.pptx", 10).expect("list");
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].domain, "pptx");
        assert_eq!(ops[0].source, "user");

        let removed = db.clear_edit_ops("deck.pptx").expect("clear");
        assert_eq!(removed, 1);
        assert!(db.list_edit_ops("deck.pptx", 10).expect("list").is_empty());
    }
}
