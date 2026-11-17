/**
 * Office 编辑器 Worker 协议（主线程 ↔ Worker 共用）。
 *
 * 只放纯类型，不引入 DOM / Tauri 依赖，Worker 与前端都可安全引用。
 */
import type { RenderSlide } from "@genoffice/pptx-render";

export interface PptxSlidePreviewData {
  index: number;
  svg: string;
  widthPx: number;
  heightPx: number;
}

export interface PptxInfo {
  slideCount: number;
  widthPx: number;
  heightPx: number;
  hash: string;
}

export interface PptxOpenedData {
  kind: "pptx";
  info: PptxInfo;
  slides: PptxSlidePreviewData[];
}

export interface DocxTextBlock {
  blockIndex: number;
  type: string;
  text: string;
  preview: string;
}

export interface DocxOpenedData {
  kind: "docx";
  info: {
    blockCount: number;
    headingCount: number;
    tableCount: number;
    imageCount: number;
    pageCount: number;
    truncated: boolean;
  };
  html: string;
  saved: Uint8Array;
  textBlocks: DocxTextBlock[];
}

export type OfficeOpenedData = PptxOpenedData | DocxOpenedData;

export interface DocxFontMetrics {
  family: string;
  matched_family: string | null;
  ascent: number;
  descent: number;
  line_gap: number;
  avg_latin: number;
  avg_cjk: number;
  space: number;
}

/** 单页场景：交互层用它做命中测试和选中框。 */
export interface PptxSceneResult {
  slide: number;
  scene: RenderSlide;
  svg: string;
  widthPx: number;
  heightPx: number;
  /** 页面 px → OOXML EMU 的比例 */
  emuPerPx: number;
  canUndo: boolean;
  canRedo: boolean;
  /** 结构操作（增删/排序/撤销）后返回全部缩略图，UI 据此刷新幻灯片栏。 */
  slides?: PptxSlidePreviewData[];
  pageCount?: number;
}

/** 幻灯片结构操作。 */
export type PptxSlideAction =
  | { kind: "insert-blank" }
  | { kind: "duplicate" }
  | { kind: "delete" }
  | { kind: "move"; to: number };

export interface PptxFontPatch {
  fontFamily?: string;
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
}

/** 前端提交的编辑动作（语义化，坐标一律用页面 px）。 */
export type PptxEditOp =
  | {
      kind: "transform";
      el: string;
      box: { x: number; y: number; w: number; h: number };
      rotDeg: number;
    }
  | { kind: "text"; el: string; text: string }
  | { kind: "fill"; el: string; color: string | null }
  | { kind: "stroke"; el: string; color: string | null; widthPt: number }
  | { kind: "font"; el: string; font: PptxFontPatch }
  | { kind: "align"; el: string; align: "left" | "center" | "right" | "justify" };

export interface PptxOpenResult {
  kind: "pptx";
  info: PptxInfo;
  slides: PptxSlidePreviewData[];
}

export type WorkerRequest = {
  id: number;
  method:
    | "open"
    | "get-scene"
    | "apply-op"
    | "slide-op"
    | "undo"
    | "redo"
    | "save"
    | "list-text"
    | "docx-list-text"
    | "docx-update-text";
  params?: unknown;
};

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
