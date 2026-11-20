/**
 * PPTX Spike 文件 API。
 *
 * 读：Rust 返回 `tauri::ipc::Response`，前端拿到 ArrayBuffer。
 * 写：原始 Uint8Array 作为请求体，路径放 base64 头（避免非 ASCII 头值）。
 */
import { invoke } from "@tauri-apps/api/core";

function encodePathHeader(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface XlsxSheetPreview {
  name: string;
  headers: string[];
  rows: string[][];
  total_rows: number;
  truncated_rows: number;
}

export interface PdfPagePreview {
  page: number;
  width: number;
  height: number;
  png_base64: string;
}

export const pptxSpikeApi = {
  read: (path: string): Promise<ArrayBuffer> =>
    invoke<ArrayBuffer>("pptx_spike_read", { path }),

  write: (path: string, bytes: Uint8Array): Promise<void> =>
    invoke<void>("pptx_spike_write", bytes, {
      headers: { "x-pptx-path": encodePathHeader(path) },
    }),

  /** 导出 PNG/SVG 专用写入（Rust 侧仅校验 .png/.svg）。 */
  writeExport: (path: string, bytes: Uint8Array): Promise<void> =>
    invoke<void>("office_export_write", bytes, {
      headers: { "x-export-path": encodePathHeader(path) },
    }),

  displayName: (path: string): Promise<string> =>
    invoke<string>("pptx_spike_display_name", { path }),

  fileSize: (path: string): Promise<number> =>
    invoke<number>("office_file_size", { path }),

  xlsxPreview: (path: string): Promise<XlsxSheetPreview[]> =>
    invoke<XlsxSheetPreview[]>("office_xlsx_preview", { path }),

  pdfPreview: (path: string, maxPages = 3): Promise<PdfPagePreview[]> =>
    invoke<PdfPagePreview[]>("office_pdf_preview", { path, maxPages }),

  /** PDF 总页数（分批加载用）。 */
  pdfPageCount: (path: string): Promise<number> =>
    invoke<number>("office_pdf_page_count", { path }),

  /** 按页范围渲染（start 从 0 开始；后端单次最多 24 页）。 */
  pdfRenderPages: (path: string, start: number, count: number): Promise<PdfPagePreview[]> =>
    invoke<PdfPagePreview[]>("office_pdf_render_pages", { path, start, count }),

  xlsxSetCell: (path: string, sheet: string, cell: string, value: string) =>
    invoke<XlsxSheetPreview[]>("office_xlsx_set_cell", { path, sheet, cell, value }),
};
