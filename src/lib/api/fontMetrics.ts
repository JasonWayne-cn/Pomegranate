/**
 * 系统字体度量（Rust font-enumeration + ttf-parser）。
 *
 * 返回值按 em 归一化，前端用于 DOCX 行高/每行字数与分页估算。
 */
import { invoke } from "@tauri-apps/api/core";

export interface FontMetrics {
  family: string;
  matched_family: string | null;
  ascent: number;
  descent: number;
  line_gap: number;
  avg_latin: number;
  avg_cjk: number;
  space: number;
}

export const fontMetricsApi = {
  measure: (families: string[]): Promise<FontMetrics[]> =>
    invoke<FontMetrics[]>("office_font_metrics", { families }),
};
