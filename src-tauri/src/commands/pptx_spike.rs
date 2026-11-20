//! PPTX Spike 的 IPC 入口。
//!
//! 读：返回原始字节（`ArrayBuffer`），避免 JSON 数组膨胀。
//! 写：原始字节走 `InvokeBody::Raw`，路径通过 `x-pptx-path` 头传 base64。

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::error::AppError;
use crate::services::office_preview;
use crate::services::pptx_spike;

#[tauri::command]
pub fn pptx_spike_read(path: String) -> Result<Response, String> {
    pptx_spike::read(&path)
        .map(Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pptx_spike_write(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("pptx_spike_write 需要原始字节请求体".into());
    };
    let encoded = request
        .headers()
        .get("x-pptx-path")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::InvalidInput("缺少 x-pptx-path 请求头".into()).to_string())?;
    let raw = STANDARD
        .decode(encoded)
        .map_err(|e| AppError::InvalidInput(format!("x-pptx-path 解码失败: {e}")).to_string())?;
    let path = String::from_utf8(raw)
        .map_err(|e| AppError::InvalidInput(format!("x-pptx-path 不是 UTF-8: {e}")).to_string())?;
    pptx_spike::write_atomic(&path, bytes).map_err(|e| e.to_string())
}

/// 导出产物（PNG/SVG）写入：与文档保存分离，避免把 Office 扩展名校验套到导出文件上。
#[tauri::command]
pub fn office_export_write(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("office_export_write 需要原始字节请求体".into());
    };
    let encoded = request
        .headers()
        .get("x-export-path")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::InvalidInput("缺少 x-export-path 请求头".into()).to_string())?;
    let raw = STANDARD
        .decode(encoded)
        .map_err(|e| AppError::InvalidInput(format!("x-export-path 解码失败: {e}")).to_string())?;
    let path = String::from_utf8(raw)
        .map_err(|e| AppError::InvalidInput(format!("x-export-path 不是 UTF-8: {e}")).to_string())?;
    pptx_spike::write_export_atomic(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pptx_spike_display_name(path: String) -> Result<String, String> {
    Ok(pptx_spike::display_name(&path))
}

#[tauri::command]
pub fn office_file_size(path: String) -> Result<u64, String> {
    pptx_spike::file_size(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn office_xlsx_preview(
    path: String,
) -> Result<Vec<office_preview::XlsxSheetPreview>, String> {
    office_preview::xlsx_preview(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn office_pdf_preview(
    path: String,
    max_pages: Option<u32>,
) -> Result<Vec<office_preview::PdfPagePreview>, String> {
    office_preview::pdf_preview(&path, max_pages).map_err(|e| e.to_string())
}

/// PDF 总页数（前端分批加载用）。
#[tauri::command]
pub fn office_pdf_page_count(path: String) -> Result<u32, String> {
    office_preview::pdf_page_count(&path).map_err(|e| e.to_string())
}

/// 按页范围渲染 PDF（`start` 从 0 开始；单次最多 24 页）。
#[tauri::command]
pub fn office_pdf_render_pages(
    path: String,
    start: u32,
    count: u32,
) -> Result<Vec<office_preview::PdfPagePreview>, String> {
    office_preview::pdf_render_pages(&path, start, count).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn office_xlsx_set_cell(
    path: String,
    sheet: String,
    cell: String,
    value: String,
) -> Result<Vec<office_preview::XlsxSheetPreview>, String> {
    office_preview::xlsx_set_cell(&path, &sheet, &cell, &value).map_err(|e| e.to_string())?;
    office_preview::xlsx_preview(&path).map_err(|e| e.to_string())
}
