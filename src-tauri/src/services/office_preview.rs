//! Word / Excel / PDF 的只读预览（Spike 验证用）。
//!
//! - Excel：复用 `excel_parser`（calamine），返回每表头几行。
//! - PDF：复用 `pdf::with_pdfium` 渲染前 N 页为 PNG。
//! - Word：预览在 WebView 内由 GenOffice docx-engine 完成，这里不涉及。

use std::io::Cursor;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

use crate::error::AppError;
use crate::services::excel_parser;
use crate::services::pdf::with_pdfium;

const MAX_XLSX_SHEETS: usize = 12;
const MAX_PDF_PAGES: u32 = 5;
const PDF_RENDER_WIDTH: i32 = 1200;

#[derive(Debug, Serialize)]
pub struct XlsxSheetPreview {
    pub name: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub truncated_rows: usize,
}

pub fn xlsx_preview(path: &str) -> Result<Vec<XlsxSheetPreview>, AppError> {
    let summary = excel_parser::read_workbook_preview(path)?;
    Ok(summary
        .sheets
        .into_iter()
        .take(MAX_XLSX_SHEETS)
        .map(|sheet| XlsxSheetPreview {
            name: sheet.name,
            headers: sheet.headers,
            rows: sheet.rows,
            total_rows: sheet.total_rows,
            truncated_rows: sheet.truncated_rows,
        })
        .collect())
}

fn valid_cell_ref(cell: &str) -> bool {
    let mut letters = 0;
    let mut digits = 0;
    for ch in cell.chars() {
        if ch.is_ascii_alphabetic() && digits == 0 {
            letters += 1;
        } else if ch.is_ascii_digit() {
            digits += 1;
        } else {
            return false;
        }
    }
    letters > 0 && letters <= 3 && digits > 0 && digits <= 7
}

/// 修改一个单元格并原子写回 xlsx；返回更新后的预览由命令层调用 `xlsx_preview`。
pub fn xlsx_set_cell(path: &str, sheet: &str, cell: &str, value: &str) -> Result<(), AppError> {
    if !valid_cell_ref(cell) {
        return Err(AppError::InvalidInput(format!("无效的单元格地址: {cell}")));
    }
    if value.len() > 10_000 {
        return Err(AppError::InvalidInput("单元格内容过长".into()));
    }
    let mut book = umya_spreadsheet::reader::xlsx::read(path)
        .map_err(|e| AppError::Custom(format!("读取 xlsx 失败: {e}")))?;
    let worksheet = book
        .get_sheet_by_name_mut(sheet)
        .ok_or_else(|| AppError::NotFound(format!("工作表不存在: {sheet}")))?;
    worksheet.get_cell_mut(cell).set_value(value);

    let parent = std::path::Path::new(path)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("无法确定目标目录".into()))?;
    let tmp: PathBuf = parent.join(format!(".office-edit-{}.xlsx", uuid::Uuid::new_v4()));
    umya_spreadsheet::writer::xlsx::write(&book, &tmp)
        .map_err(|e| AppError::Custom(format!("写入 xlsx 失败: {e}")))?;
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct PdfPagePreview {
    pub page: u32,
    pub width: u32,
    pub height: u32,
    pub png_base64: String,
}

/// 单页 PNG 渲染（页码从 0 开始）。
fn render_pdf_page(
    document: &pdfium_render::prelude::PdfDocument,
    index: u32,
) -> Result<PdfPagePreview, String> {
    let page = document
        .pages()
        .get(index as u16)
        .map_err(|e| format!("读取第 {} 页失败: {e}", index + 1))?;
    let config = pdfium_render::prelude::PdfRenderConfig::new()
        .set_target_width(PDF_RENDER_WIDTH);
    let image = page
        .render_with_config(&config)
        .map_err(|e| format!("渲染第 {} 页失败: {e}", index + 1))?
        .as_image();
    let (width, height) = (image.width(), image.height());
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("编码第 {} 页失败: {e}", index + 1))?;
    Ok(PdfPagePreview {
        page: index + 1,
        width,
        height,
        png_base64: STANDARD.encode(png),
    })
}

/// PDF 总页数（前端据此决定加载多少批）。
pub fn pdf_page_count(path: &str) -> Result<u32, AppError> {
    with_pdfium(|pdfium| {
        let document = pdfium
            .load_pdf_from_file(path, None)
            .map_err(|e| format!("打开 PDF 失败: {e}"))?;
        Ok(document.pages().len() as u32)
    })
    .map_err(AppError::Custom)
}

/// 按范围渲染 PDF 页（`start` 从 0 开始）。单次最多 24 页，避免 IPC 载荷过大。
pub fn pdf_render_pages(
    path: &str,
    start: u32,
    count: u32,
) -> Result<Vec<PdfPagePreview>, AppError> {
    let count = count.clamp(1, 24);
    with_pdfium(|pdfium| {
        let document = pdfium
            .load_pdf_from_file(path, None)
            .map_err(|e| format!("打开 PDF 失败: {e}"))?;
        let total = document.pages().len() as u32;
        if total == 0 || start >= total {
            return Ok(Vec::new());
        }
        let end = start.saturating_add(count).min(total);
        (start..end)
            .map(|index| render_pdf_page(&document, index))
            .collect()
    })
    .map_err(AppError::Custom)
}

pub fn pdf_preview(path: &str, max_pages: Option<u32>) -> Result<Vec<PdfPagePreview>, AppError> {
    let limit = max_pages.unwrap_or(MAX_PDF_PAGES).clamp(1, MAX_PDF_PAGES);
    with_pdfium(|pdfium| {
        let document = pdfium
            .load_pdf_from_file(path, None)
            .map_err(|e| format!("打开 PDF 失败: {e}"))?;
        let total = document.pages().len() as u32;
        (0..total.min(limit))
            .map(|index| render_pdf_page(&document, index))
            .collect()
    })
    .map_err(AppError::Custom)
}

#[cfg(test)]
mod pdf_tests {
    use super::*;

    /// 验证「页数 + 按范围渲染」能真正出图。
    /// 需要真实 PDF：设置 `KB_PDF_TEST_FILE` 为绝对路径后运行；未设置时跳过。
    #[test]
    fn pdf_paging_renders_requested_pages() {
        let Ok(path) = std::env::var("KB_PDF_TEST_FILE") else {
            return;
        };
        crate::services::pdf::init_pdfium().expect("pdfium init");
        let count = pdf_page_count(&path).expect("page count");
        assert!(count >= 4, "count={count}");
        let pages = pdf_render_pages(&path, 0, 4).expect("render pages");
        assert_eq!(pages.len(), 4, "应渲染 4 页，实际 {}", pages.len());
        assert!(!pages[0].png_base64.is_empty(), "PNG base64 不应为空");
        assert_eq!(pages[0].page, 1);
        assert_eq!(pages[3].page, 4);
    }
}
