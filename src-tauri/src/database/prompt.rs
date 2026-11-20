//! AI 提示词模板 DAO
//!
//! 表结构见 `schema.rs` 中的 v18 -> v19 迁移。
//! 业务层约定：
//! - 列表按 `sort_order ASC, id ASC` 展示，内置在前（sort 10..70），用户自定义从 100 开始递增
//! - 删除内置模板不做 UI 入口，但 DAO 不拦截（留给未来"重置"脚本用）
//! - 更新时不动 `is_builtin` / `builtin_code`，确保内置标记不被用户改坏

use rusqlite::{params, Connection};

use super::Database;
use crate::error::AppError;
use crate::models::{PromptGroup, PromptTemplate, PromptTemplateInput};

/// 把 SQLite 行映射为 `PromptTemplate`，DAO 内复用
fn row_to_prompt(row: &rusqlite::Row<'_>) -> rusqlite::Result<PromptTemplate> {
    Ok(PromptTemplate {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        prompt: row.get(3)?,
        output_mode: row.get(4)?,
        icon: row.get(5)?,
        is_builtin: row.get::<_, i32>(6)? != 0,
        builtin_code: row.get(7)?,
        group_id: row.get(8)?,
        sort_order: row.get(9)?,
        enabled: row.get::<_, i32>(10)? != 0,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn row_to_group(row: &rusqlite::Row<'_>) -> rusqlite::Result<PromptGroup> {
    Ok(PromptGroup {
        id: row.get(0)?,
        name: row.get(1)?,
        is_builtin: row.get::<_, i32>(2)? != 0,
        builtin_code: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const SELECT_COLUMNS: &str = "id, title, description, prompt, output_mode, icon, is_builtin, \
     builtin_code, group_id, sort_order, enabled, created_at, updated_at";

const SELECT_GROUP_COLUMNS: &str =
    "id, name, is_builtin, builtin_code, sort_order, created_at, updated_at";

/// 默认分组（快捷指令）的 id。
///
/// 迁移 v87 保证它一定存在；万一被外部脚本删干净，这里回退到最早创建的组，
/// 避免整条写入链路因为查不到默认组而失败。
fn default_group_id(conn: &Connection) -> Result<i64, AppError> {
    let id = conn
        .query_row(
            "SELECT id FROM prompt_groups WHERE builtin_code = 'quick'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .ok()
        .or_else(|| {
            conn.query_row(
                "SELECT id FROM prompt_groups ORDER BY sort_order ASC, id ASC LIMIT 1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .ok()
        })
        .ok_or_else(|| AppError::Custom("提示词分组不存在，请重启应用以重建默认分组".to_string()))?;
    Ok(id)
}

/// 同组内的下一个排序号（max + 10）
fn next_sort_in_group(conn: &Connection, group_id: Option<i64>) -> Result<i32, AppError> {
    let max: i32 = match group_id {
        Some(gid) => conn.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) FROM prompt_templates WHERE group_id = ?1",
            [gid],
            |r| r.get(0),
        )?,
        None => conn.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) FROM prompt_templates WHERE group_id IS NULL",
            [],
            |r| r.get(0),
        )?,
    };
    Ok(max + 10)
}

fn group_exists(conn: &Connection, group_id: i64) -> Result<bool, AppError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM prompt_groups WHERE id = ?1",
        [group_id],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

impl Database {
    /// 列出所有提示词（按 sort_order 排序）
    ///
    /// `only_enabled=true` 时仅返回启用项，供编辑器 AI 菜单使用；
    /// 管理页需要看到禁用项用于重新启用，因此传 false。
    pub fn list_prompts(&self, only_enabled: bool) -> Result<Vec<PromptTemplate>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {} FROM prompt_templates {} ORDER BY sort_order ASC, id ASC",
            SELECT_COLUMNS,
            if only_enabled {
                "WHERE enabled = 1"
            } else {
                ""
            }
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], row_to_prompt)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按 id 取单条
    pub fn get_prompt(&self, id: i64) -> Result<PromptTemplate, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {} FROM prompt_templates WHERE id = ?1",
            SELECT_COLUMNS
        );
        let prompt = conn.query_row(&sql, [id], row_to_prompt)?;
        Ok(prompt)
    }

    /// 按 builtin_code 取单条（没匹配返回 Ok(None)）
    ///
    /// 用途：兼容旧版本前端仍然传 "continue"/"summarize" 等字符串时，
    /// 后端能映射到 DB 里的内置模板。
    pub fn get_prompt_by_builtin_code(
        &self,
        code: &str,
    ) -> Result<Option<PromptTemplate>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {} FROM prompt_templates WHERE builtin_code = ?1",
            SELECT_COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query_map([code], row_to_prompt)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// 新建用户自定义 Prompt（is_builtin=0、builtin_code=NULL）
    pub fn create_prompt(&self, input: &PromptTemplateInput) -> Result<PromptTemplate, AppError> {
        let title = input.title.trim();
        if title.is_empty() {
            return Err(AppError::Custom("标题不能为空".to_string()));
        }
        let prompt_body = input.prompt.trim();
        if prompt_body.is_empty() {
            return Err(AppError::Custom("Prompt 内容不能为空".to_string()));
        }
        let mode = input.output_mode.as_deref().unwrap_or("replace");
        validate_output_mode(mode)?;

        let conn = self.conn_lock()?;
        // 未指定分组时放到默认组（快捷指令）
        let group_id = match input.group_id {
            Some(gid) => {
                if !group_exists(&conn, gid)? {
                    return Err(AppError::Custom(format!("提示词分组 #{} 不存在", gid)));
                }
                gid
            }
            None => default_group_id(&conn)?,
        };
        // sort_order 默认取同组 max + 10，放在组末尾
        let sort = match input.sort_order {
            Some(v) => v,
            None => next_sort_in_group(&conn, Some(group_id))?,
        };
        let enabled_i = i32::from(input.enabled.unwrap_or(true));

        conn.execute(
            "INSERT INTO prompt_templates
                (title, description, prompt, output_mode, icon, is_builtin, builtin_code, group_id, sort_order, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7, ?8)",
            params![
                title,
                input.description.clone().unwrap_or_default(),
                prompt_body,
                mode,
                input.icon,
                group_id,
                sort,
                enabled_i,
            ],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_prompt(id)
    }

    /// 更新 Prompt（内置模板可以改 title/description/prompt/output_mode/icon/sort/enabled，
    /// 不改 is_builtin/builtin_code）
    pub fn update_prompt(
        &self,
        id: i64,
        input: &PromptTemplateInput,
    ) -> Result<PromptTemplate, AppError> {
        let title = input.title.trim();
        if title.is_empty() {
            return Err(AppError::Custom("标题不能为空".to_string()));
        }
        let prompt_body = input.prompt.trim();
        if prompt_body.is_empty() {
            return Err(AppError::Custom("Prompt 内容不能为空".to_string()));
        }
        let mode = input.output_mode.as_deref().unwrap_or("replace");
        validate_output_mode(mode)?;

        let conn = self.conn_lock()?;
        // 目标分组校验 + 判断是否跨组移动
        let current: PromptTemplate = conn.query_row(
            &format!("SELECT {} FROM prompt_templates WHERE id = ?1", SELECT_COLUMNS),
            [id],
            row_to_prompt,
        )?;
        let group_changed = input.group_id.is_some() && input.group_id != current.group_id;
        if let Some(gid) = input.group_id {
            if !group_exists(&conn, gid)? {
                return Err(AppError::Custom(format!("提示词分组 #{} 不存在", gid)));
            }
        }
        // 跨组移动且没显式指定排序 → 落到目标组末尾
        let sort = if input.sort_order.is_some() {
            input.sort_order
        } else if group_changed {
            Some(next_sort_in_group(&conn, input.group_id)?)
        } else {
            None
        };

        let affected = conn.execute(
            "UPDATE prompt_templates
             SET title = ?1, description = ?2, prompt = ?3, output_mode = ?4,
                 icon = ?5, group_id = COALESCE(?6, group_id),
                 sort_order = COALESCE(?7, sort_order),
                 enabled = COALESCE(?8, enabled),
                 updated_at = datetime('now','localtime')
             WHERE id = ?9",
            params![
                title,
                input.description.clone().unwrap_or_default(),
                prompt_body,
                mode,
                input.icon,
                input.group_id,
                sort,
                input.enabled.map(i32::from),
                id,
            ],
        )?;
        if affected == 0 {
            return Err(AppError::Custom(format!("Prompt #{} 不存在", id)));
        }
        drop(conn);
        self.get_prompt(id)
    }

    /// 删除 Prompt
    ///
    /// 内置模板由 UI 层通过是否显示删除按钮控制；DAO 不设物理约束，
    /// 便于未来通过"重置内置模板"功能清空后重新插入。
    pub fn delete_prompt(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM prompt_templates WHERE id = ?1", [id])?;
        Ok(affected > 0)
    }

    /// 批量切换 enabled 状态（管理页"启用/禁用"开关复用）
    pub fn set_prompt_enabled(&self, id: i64, enabled: bool) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "UPDATE prompt_templates SET enabled = ?1, updated_at = datetime('now','localtime')
             WHERE id = ?2",
            params![i32::from(enabled), id],
        )?;
        Ok(())
    }

    // ─── 提示词分组 ─────────────────────────────

    /// 列出全部分组（按 sort_order, id）
    pub fn list_prompt_groups(&self) -> Result<Vec<PromptGroup>, AppError> {
        let conn = self.conn_lock()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM prompt_groups ORDER BY sort_order ASC, id ASC",
            SELECT_GROUP_COLUMNS
        ))?;
        let rows = stmt
            .query_map([], row_to_group)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 新建自定义分组，排到末尾
    pub fn create_prompt_group(&self, name: &str) -> Result<PromptGroup, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Custom("分组名称不能为空".to_string()));
        }
        let conn = self.conn_lock()?;
        let sort: i32 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) FROM prompt_groups",
            [],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO prompt_groups (name, is_builtin, builtin_code, sort_order)
             VALUES (?1, 0, NULL, ?2)",
            params![name, sort + 10],
        )?;
        let id = conn.last_insert_rowid();
        let group = conn.query_row(
            &format!("SELECT {} FROM prompt_groups WHERE id = ?1", SELECT_GROUP_COLUMNS),
            [id],
            row_to_group,
        )?;
        Ok(group)
    }

    /// 重命名分组（内置组也允许改名，builtin_code 不变）
    pub fn update_prompt_group(&self, id: i64, name: &str) -> Result<PromptGroup, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Custom("分组名称不能为空".to_string()));
        }
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE prompt_groups SET name = ?1, updated_at = datetime('now','localtime')
             WHERE id = ?2",
            params![name, id],
        )?;
        if affected == 0 {
            return Err(AppError::Custom(format!("分组 #{} 不存在", id)));
        }
        let group = conn.query_row(
            &format!("SELECT {} FROM prompt_groups WHERE id = ?1", SELECT_GROUP_COLUMNS),
            [id],
            row_to_group,
        )?;
        Ok(group)
    }

    /// 删除自定义分组：组内模板迁回默认组（排到末尾）。内置组禁止删除。
    pub fn delete_prompt_group(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let is_builtin: i32 = conn.query_row(
            "SELECT is_builtin FROM prompt_groups WHERE id = ?1",
            [id],
            |r| r.get(0),
        )?;
        if is_builtin != 0 {
            return Err(AppError::Custom("内置分组不可删除".to_string()));
        }
        let default_id = default_group_id(&conn)?;
        let tx = conn.unchecked_transaction()?;

        let ids = {
            let mut stmt = tx.prepare(
                "SELECT id FROM prompt_templates WHERE group_id = ?1
                 ORDER BY sort_order ASC, id ASC",
            )?;
            let rows = stmt
                .query_map([id], |r| r.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut sort: i32 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) FROM prompt_templates WHERE group_id = ?1",
            [default_id],
            |r| r.get(0),
        )?;
        for pid in ids {
            sort += 10;
            tx.execute(
                "UPDATE prompt_templates
                 SET group_id = ?1, sort_order = ?2, updated_at = datetime('now','localtime')
                 WHERE id = ?3",
                params![default_id, sort, pid],
            )?;
        }
        tx.execute("DELETE FROM prompt_groups WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(true)
    }

    /// 分组排序：按传入 id 顺序重写 sort_order（事务）
    pub fn reorder_prompt_groups(&self, ids: &[i64]) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        let tx = conn.unchecked_transaction()?;
        for (idx, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE prompt_groups
                 SET sort_order = ?1, updated_at = datetime('now','localtime')
                 WHERE id = ?2",
                params![(idx as i32 + 1) * 10, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 组内提示词排序：按传入 id 顺序重写 sort_order（事务）
    ///
    /// 校验每条模板确实属于该组，避免前端传错 id 把别的组的顺序改乱。
    pub fn reorder_prompts(&self, group_id: i64, ids: &[i64]) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        if !group_exists(&conn, group_id)? {
            return Err(AppError::Custom(format!("分组 #{} 不存在", group_id)));
        }
        let tx = conn.unchecked_transaction()?;
        for (idx, id) in ids.iter().enumerate() {
            let affected = tx.execute(
                "UPDATE prompt_templates
                 SET sort_order = ?1, updated_at = datetime('now','localtime')
                 WHERE id = ?2 AND group_id = ?3",
                params![(idx as i32 + 1) * 10, id, group_id],
            )?;
            if affected == 0 {
                return Err(AppError::Custom(format!(
                    "提示词 #{} 不属于分组 #{}",
                    id, group_id
                )));
            }
        }
        tx.commit()?;
        Ok(())
    }
}

/// 校验 output_mode 取值；非法值直接拒绝，避免脏数据写进 DB 后前端渲染异常
fn validate_output_mode(mode: &str) -> Result<(), AppError> {
    match mode {
        "replace" | "append" | "popup" => Ok(()),
        _ => Err(AppError::Custom(format!(
            "output_mode 非法：{}，只接受 replace/append/popup",
            mode
        ))),
    }
}
