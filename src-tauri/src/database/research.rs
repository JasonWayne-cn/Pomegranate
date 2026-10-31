//! 助研模块数据访问层（课题 / 文献 / 产出）

use rusqlite::{params, OptionalExtension, Row};

use crate::error::AppError;
use crate::models::research::{
    ResearchLiterature, ResearchLiteratureInput, ResearchOutput, ResearchOutputInput,
    ResearchProject, ResearchProjectInput,
};

use super::Database;

fn project_status(input: &ResearchProjectInput) -> String {
    input
        .status
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "active".to_string())
}

fn literature_status(input: &ResearchLiteratureInput) -> String {
    input
        .status
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "to_read".to_string())
}

fn map_project(row: &Row<'_>) -> rusqlite::Result<ResearchProject> {
    Ok(ResearchProject {
        id: row.get(0)?,
        title: row.get(1)?,
        field: row.get(2)?,
        description: row.get(3)?,
        keywords: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_literature(row: &Row<'_>) -> rusqlite::Result<ResearchLiterature> {
    Ok(ResearchLiterature {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        authors: row.get(3)?,
        year: row.get(4)?,
        venue: row.get(5)?,
        abstract_text: row.get(6)?,
        url: row.get(7)?,
        file_path: row.get(8)?,
        notes: row.get(9)?,
        tags: row.get(10)?,
        status: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn map_output(row: &Row<'_>) -> rusqlite::Result<ResearchOutput> {
    Ok(ResearchOutput {
        id: row.get(0)?,
        project_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        content: row.get(4)?,
        source_ref: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const PROJECT_COLS: &str =
    "id, title, field, description, keywords, status, created_at, updated_at";
const LITERATURE_COLS: &str = "id, project_id, title, authors, year, venue, abstract_text, \
     url, file_path, notes, tags, status, created_at, updated_at";
const OUTPUT_COLS: &str = "id, project_id, kind, title, content, source_ref, created_at, updated_at";

impl Database {
    // ─── 课题 ───────────────────────────────────

    pub fn list_research_projects(&self) -> Result<Vec<ResearchProject>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {PROJECT_COLS} FROM research_projects ORDER BY updated_at DESC, id DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], map_project)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_research_project(&self, id: i64) -> Result<Option<ResearchProject>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!("SELECT {PROJECT_COLS} FROM research_projects WHERE id = ?1");
        let row = conn.query_row(&sql, params![id], map_project).optional()?;
        Ok(row)
    }

    pub fn create_research_project(
        &self,
        input: &ResearchProjectInput,
    ) -> Result<ResearchProject, AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO research_projects
                (title, field, description, keywords, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5,
                     datetime('now','localtime'), datetime('now','localtime'))",
            params![
                input.title,
                input.field,
                input.description,
                input.keywords,
                project_status(input)
            ],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_research_project(id)?
            .ok_or_else(|| AppError::Custom("课题创建失败".into()))
    }

    pub fn update_research_project(
        &self,
        id: i64,
        input: &ResearchProjectInput,
    ) -> Result<ResearchProject, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE research_projects SET
                title = ?1, field = ?2, description = ?3, keywords = ?4,
                status = ?5, updated_at = datetime('now','localtime')
             WHERE id = ?6",
            params![
                input.title,
                input.field,
                input.description,
                input.keywords,
                project_status(input),
                id
            ],
        )?;
        drop(conn);
        if affected == 0 {
            return Err(AppError::NotFound(format!("课题 {id} 不存在")));
        }
        self.get_research_project(id)?
            .ok_or_else(|| AppError::NotFound(format!("课题 {id} 不存在")))
    }

    pub fn delete_research_project(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM research_projects WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    // ─── 文献 ───────────────────────────────────

    pub fn list_research_literature(
        &self,
        project_id: i64,
    ) -> Result<Vec<ResearchLiterature>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {LITERATURE_COLS} FROM research_literature
             WHERE project_id = ?1
             ORDER BY COALESCE(year, 0) DESC, updated_at DESC, id DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params![project_id], map_literature)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_research_literature(
        &self,
        id: i64,
    ) -> Result<Option<ResearchLiterature>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!("SELECT {LITERATURE_COLS} FROM research_literature WHERE id = ?1");
        let row = conn.query_row(&sql, params![id], map_literature).optional()?;
        Ok(row)
    }

    /// 按传入顺序取一批文献（综述生成用）。
    pub fn get_research_literature_batch(
        &self,
        ids: &[i64],
    ) -> Result<Vec<ResearchLiterature>, AppError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn_lock()?;
        let sql = format!("SELECT {LITERATURE_COLS} FROM research_literature WHERE id = ?1");
        let mut stmt = conn.prepare(&sql)?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(item) = stmt.query_row(params![id], map_literature).optional()? {
                out.push(item);
            }
        }
        Ok(out)
    }

    pub fn create_research_literature(
        &self,
        project_id: i64,
        input: &ResearchLiteratureInput,
    ) -> Result<ResearchLiterature, AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO research_literature
                (project_id, title, authors, year, venue, abstract_text, url, file_path,
                 notes, tags, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                     datetime('now','localtime'), datetime('now','localtime'))",
            params![
                project_id,
                input.title,
                input.authors,
                input.year,
                input.venue,
                input.abstract_text,
                input.url,
                input.file_path,
                input.notes,
                input.tags,
                literature_status(input)
            ],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_research_literature(id)?
            .ok_or_else(|| AppError::Custom("文献创建失败".into()))
    }

    pub fn update_research_literature(
        &self,
        id: i64,
        input: &ResearchLiteratureInput,
    ) -> Result<ResearchLiterature, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE research_literature SET
                title = ?1, authors = ?2, year = ?3, venue = ?4, abstract_text = ?5,
                url = ?6, file_path = ?7, notes = ?8, tags = ?9, status = ?10,
                updated_at = datetime('now','localtime')
             WHERE id = ?11",
            params![
                input.title,
                input.authors,
                input.year,
                input.venue,
                input.abstract_text,
                input.url,
                input.file_path,
                input.notes,
                input.tags,
                literature_status(input),
                id
            ],
        )?;
        drop(conn);
        if affected == 0 {
            return Err(AppError::NotFound(format!("文献 {id} 不存在")));
        }
        self.get_research_literature(id)?
            .ok_or_else(|| AppError::NotFound(format!("文献 {id} 不存在")))
    }

    pub fn delete_research_literature(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected =
            conn.execute("DELETE FROM research_literature WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    // ─── 产出 ───────────────────────────────────

    pub fn list_research_outputs(
        &self,
        project_id: i64,
    ) -> Result<Vec<ResearchOutput>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {OUTPUT_COLS} FROM research_outputs
             WHERE project_id = ?1 ORDER BY updated_at DESC, id DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params![project_id], map_output)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_research_output(&self, id: i64) -> Result<Option<ResearchOutput>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!("SELECT {OUTPUT_COLS} FROM research_outputs WHERE id = ?1");
        let row = conn.query_row(&sql, params![id], map_output).optional()?;
        Ok(row)
    }

    pub fn create_research_output(
        &self,
        project_id: i64,
        input: &ResearchOutputInput,
    ) -> Result<ResearchOutput, AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "INSERT INTO research_outputs
                (project_id, kind, title, content, source_ref, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5,
                     datetime('now','localtime'), datetime('now','localtime'))",
            params![
                project_id,
                input.kind,
                input.title,
                input.content,
                input.source_ref
            ],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_research_output(id)?
            .ok_or_else(|| AppError::Custom("产出创建失败".into()))
    }

    pub fn update_research_output(
        &self,
        id: i64,
        title: &str,
        content: &str,
    ) -> Result<ResearchOutput, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute(
            "UPDATE research_outputs SET
                title = ?1, content = ?2, updated_at = datetime('now','localtime')
             WHERE id = ?3",
            params![title, content, id],
        )?;
        drop(conn);
        if affected == 0 {
            return Err(AppError::NotFound(format!("产出 {id} 不存在")));
        }
        self.get_research_output(id)?
            .ok_or_else(|| AppError::NotFound(format!("产出 {id} 不存在")))
    }

    pub fn delete_research_output(&self, id: i64) -> Result<bool, AppError> {
        let conn = self.conn_lock()?;
        let affected = conn.execute("DELETE FROM research_outputs WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }
}
