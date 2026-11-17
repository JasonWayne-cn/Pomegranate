/**
 * GenOffice PPTX 引擎适配层（P0 Spike）。
 *
 * 只做三件事：
 * 1. 字节 → OpenedPptx（解析）
 * 2. OpenedPptx → RenderSlide[]（布局数据）
 * 3. OpenedPptx → 字节（原字节/补丁保存）
 *
 * 引擎本体在 `src/vendor/genoffice/`，本文件不修改上游源码。
 */
import {
  openPptx,
  savePptx,
  type OpenedPptx,
  type TextElement,
} from "@genoffice/pptx-engine";
import { buildRenderSlide, type RenderSlide } from "@genoffice/pptx-render";

export interface PptxDeckInfo {
  slideCount: number;
  widthPx: number;
  heightPx: number;
  /** 原始文件的 SHA-256（引擎用于检测外部修改） */
  hash: string;
}

export interface PptxSlidePreview {
  index: number;
  widthPx: number;
  heightPx: number;
  render: RenderSlide;
}

export interface PptxSession {
  opened: OpenedPptx;
  info: PptxDeckInfo;
  /** 媒体引用 → dataUrl 缓存（图片填充/图片元素共用） */
  mediaCache: Map<string, string | undefined>;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function mediaDataUrl(session: PptxSession, ref: string): string | undefined {
  if (session.mediaCache.has(ref)) return session.mediaCache.get(ref);
  const bytes = session.opened.archive.readBytes(ref);
  let url: string | undefined;
  if (bytes) {
    const ext = ref.slice(ref.lastIndexOf(".") + 1).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (mime) url = `data:${mime};base64,${bytesToBase64(bytes)}`;
  }
  session.mediaCache.set(ref, url);
  return url;
}

export async function openPptxSession(bytes: Uint8Array): Promise<PptxSession> {
  const opened = await openPptx(bytes);
  const session: PptxSession = {
    opened,
    mediaCache: new Map(),
    info: {
      slideCount: opened.deck.slides.length,
      widthPx: 0,
      heightPx: 0,
      hash: opened.deck.originalHash,
    },
  };
  const first = renderPptxSlide(session, 0, 960);
  session.info.widthPx = first?.widthPx ?? 0;
  session.info.heightPx = first?.heightPx ?? 0;
  return session;
}

export function renderPptxSlides(session: PptxSession, fitWidthPx: number): PptxSlidePreview[] {
  return session.opened.deck.slides.map((_, index) => renderPptxSlide(session, index, fitWidthPx)!);
}

/** 只渲染单页，用于交互式编辑后的增量刷新。 */
export function renderPptxSlide(
  session: PptxSession,
  index: number,
  fitWidthPx: number,
): PptxSlidePreview | null {
  const slide = session.opened.deck.slides[index];
  if (!slide) return null;
  const render = buildRenderSlide(slide, session.opened.deck.size, {
    fitWidthPx,
    slideNo: index + 1,
    media: (ref) => mediaDataUrl(session, ref),
  });
  return {
    index,
    widthPx: render.widthPx,
    heightPx: render.heightPx,
    render,
  };
}

/** 幻灯片 px → EMU 的换算比例（节点坐标与页面像素同尺度）。 */
export function pptxEmuPerPx(session: PptxSession, widthPx: number): number {
  return widthPx > 0 ? session.opened.deck.size.cx / widthPx : 12700;
}

/** 无编辑保存：验证"打开 → 保存"字节保真链路。 */
export async function savePptxSession(session: PptxSession): Promise<Uint8Array> {
  return savePptx(session.opened);
}

export interface PptxTextItem {
  slideIndex: number;
  elementId: string;
  text: string;
  preview: string;
}

/** 列出所有可编辑文本框（用于最小编辑面板），最多 500 条。 */
export function listPptxTextItems(session: PptxSession): PptxTextItem[] {
  const out: PptxTextItem[] = [];
  for (const [slideIndex, slide] of session.opened.deck.slides.entries()) {
    for (const element of slide.elements) {
      if (out.length >= 500) return out;
      if (element.type !== "text" && element.type !== "shape") continue;
      const text = (element as TextElement).text;
      if (!text) continue;
      const value = text.paragraphs
        .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
        .join("\n");
      if (!value.trim()) continue;
      out.push({
        slideIndex,
        elementId: element.id,
        text: value,
        preview: `${slideIndex + 1} 页 · ${value.replace(/\s+/g, " ").slice(0, 40)}`,
      });
    }
  }
  return out;
}

/**
 * 修改文本框内容：保留首个 run 的格式，整段替换为单 run 文本。
 * 设置 dirty + textMoved 让 savePptx 重建 <p:txBody>。
 */
export function updatePptxText(
  session: PptxSession,
  slideIndex: number,
  elementId: string,
  newText: string,
): boolean {
  const slide = session.opened.deck.slides[slideIndex];
  if (!slide) return false;
  const element = slide.elements.find((item) => item.id === elementId);
  if (!element || (element.type !== "text" && element.type !== "shape")) return false;
  const textElement = element as TextElement;
  if (!textElement.text) return false;

  const firstParagraph = textElement.text.paragraphs[0];
  const firstRun = firstParagraph?.runs[0];
  const run = { ...(firstRun ?? { text: "" }), text: newText };
  textElement.text = {
    ...textElement.text,
    paragraphs: [{ ...(firstParagraph ?? {}), runs: [run] }],
  };
  textElement.dirty = true;
  textElement.textMoved = true;
  return true;
}
