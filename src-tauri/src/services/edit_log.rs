//! Office 编辑操作日志服务。

use crate::database::edit_ops::EditOp;
use crate::database::Database;
use crate::error::AppError;

const MAX_OP_JSON_BYTES: usize = 64 * 1024;
const MAX_TARGET_BYTES: usize = 4096;
const MAX_LIST_LIMIT: usize = 200;

pub struct EditLogService;

impl EditLogService {
    pub fn record(
        db: &Database,
        domain: &str,
        target: &str,
        source: &str,
        op_json: &str,
    ) -> Result<i64, AppError> {
        if domain.trim().is_empty() {
            return Err(AppError::InvalidInput("domain 不能为空".into()));
        }
        if target.trim().is_empty() || target.len() > MAX_TARGET_BYTES {
            return Err(AppError::InvalidInput("target 无效".into()));
        }
        if op_json.len() > MAX_OP_JSON_BYTES {
            return Err(AppError::InvalidInput("op_json 过大".into()));
        }
        if !matches!(source, "user" | "ai" | "generate" | "import") {
            return Err(AppError::InvalidInput(format!("未知 source: {source}")));
        }
        db.insert_edit_op(domain, target, source, op_json)
    }

    pub fn list(db: &Database, target: &str, limit: Option<usize>) -> Result<Vec<EditOp>, AppError> {
        if target.trim().is_empty() {
            return Err(AppError::InvalidInput("target 不能为空".into()));
        }
        let limit = limit.unwrap_or(50).clamp(1, MAX_LIST_LIMIT);
        db.list_edit_ops(target, limit)
    }

    pub fn clear(db: &Database, target: &str) -> Result<usize, AppError> {
        if target.trim().is_empty() {
            return Err(AppError::InvalidInput("target 不能为空".into()));
        }
        db.clear_edit_ops(target)
    }
}
