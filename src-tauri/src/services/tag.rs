use crate::database::Database;
use crate::error::AppError;
use crate::models::{Note, PageResult, Tag};
use crate::services::mount::MountService;

/// 标签服务
pub struct TagService;

impl TagService {
    /// 创建标签
    pub fn create(db: &Database, name: &str, color: Option<&str>) -> Result<Tag, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("标签名称不能为空".into()));
        }
        db.create_tag(name, color, None)
    }

    /// 获取所有标签
    pub fn list(db: &Database) -> Result<Vec<Tag>, AppError> {
        db.list_tags()
    }

    /// 重命名标签
    pub fn rename(db: &Database, id: i64, name: &str) -> Result<(), AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("标签名称不能为空".into()));
        }
        db.rename_tag(id, name)
    }

    /// 修改标签颜色（传 None 清除）
    pub fn set_color(db: &Database, id: i64, color: Option<&str>) -> Result<(), AppError> {
        let normalized = color.map(|s| s.trim()).filter(|s| !s.is_empty());
        db.set_tag_color(id, normalized)
    }

    /// 删除标签
    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        let deleted = db.delete_tag(id)?;
        if !deleted {
            return Err(AppError::NotFound(format!("标签 {} 不存在", id)));
        }
        Ok(())
    }

    /// 给文档添加标签
    ///
    /// 挂载的 Markdown 文档会先把「现有标签 + 新标签」写回源文件 frontmatter，
    /// 再更新 DB 关联。写回失败（只读挂载 / mtime 冲突等）时 DB 不变，避免两边不一致。
    pub fn add_to_note(db: &Database, note_id: i64, tag_id: i64) -> Result<(), AppError> {
        let tag_name = db
            .get_tag_name(tag_id)?
            .ok_or_else(|| AppError::NotFound(format!("标签 {} 不存在", tag_id)))?;

        let mut names: Vec<String> = db
            .get_note_tags(note_id)?
            .into_iter()
            .map(|t| t.name)
            .collect();
        if !names.iter().any(|n| n == &tag_name) {
            names.push(tag_name);
        }

        MountService::write_tags_to_markdown(db, note_id, &names)?;
        db.add_tag_to_note(note_id, tag_id)
    }

    /// 移除文档的标签
    ///
    /// 挂载的 Markdown 文档会先把「剩余标签」写回源文件 frontmatter，再更新 DB 关联。
    pub fn remove_from_note(db: &Database, note_id: i64, tag_id: i64) -> Result<(), AppError> {
        let current = db.get_note_tags(note_id)?;
        if !current.iter().any(|t| t.id == tag_id) {
            return Ok(());
        }
        let names: Vec<String> = current
            .iter()
            .filter(|t| t.id != tag_id)
            .map(|t| t.name.clone())
            .collect();

        MountService::write_tags_to_markdown(db, note_id, &names)?;
        db.remove_tag_from_note(note_id, tag_id)?;
        Ok(())
    }

    /// 获取文档的所有标签
    pub fn get_note_tags(db: &Database, note_id: i64) -> Result<Vec<Tag>, AppError> {
        db.get_note_tags(note_id)
    }

    /// 获取标签下的文档列表（分页）
    pub fn list_notes_by_tag(
        db: &Database,
        tag_id: i64,
        page: Option<usize>,
        page_size: Option<usize>,
    ) -> Result<PageResult<Note>, AppError> {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).clamp(1, 100);

        let (items, total) = db.list_notes_by_tag(tag_id, page, page_size)?;

        Ok(PageResult {
            items,
            total,
            page,
            page_size,
        })
    }
}
