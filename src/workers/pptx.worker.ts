/// <reference lib="webworker" />
/**
 * Office 文档 Worker（RPC v2）。
 *
 * - 请求带自增 id，主线程可并发多个请求并按 id 匹配结果（协议见
 *   `src/lib/office/editor/protocol.ts`）
 * - PPTX 模型常驻 Worker：编辑只重渲染当前页，保存时才序列化整个包
 * - 撤销/重做：单页快照栈（深拷贝单页，避免整簿克隆）
 */
// polyfills 必须是第一个 import：引擎在其他模块求值时就会用到 Buffer。
import "@/lib/office/polyfills";
import { runTxn, type Op } from "@genoffice/pptx-ops";
import type { Slide } from "@genoffice/pptx-engine";
import {
  listPptxTextItems,
  openPptxSession,
  pptxEmuPerPx,
  renderPptxSlide,
  renderPptxSlides,
  savePptxSession,
  type PptxSession,
  type PptxTextItem,
} from "@/lib/office/pptxEngine";
import { renderSlideSvg } from "@/lib/office/renderSlideSvg";
import type { DocxOpened } from "@/lib/office/docxEngine";
import type {
  DocxFontMetrics,
  DocxTextBlock,
  PptxEditOp,
  PptxOpenResult,
  PptxSceneResult,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/office/editor/protocol";

const MAX_UNDO = 30;

interface UndoEntry {
  slide: number;
  before: Slide;
  after: Slide;
}

let kind: "pptx" | "docx" | null = null;
let pptxSession: PptxSession | null = null;
let docxSession: DocxOpened | null = null;
let docxEdits: Record<number, string> = {};
let fitWidth = 960;
let undoStack: UndoEntry[] = [];
let redoStack: UndoEntry[] = [];

function respond(id: number, result: unknown, transfer: Transferable[] = []): void {
  self.postMessage({ id, ok: true, result } satisfies WorkerResponse, transfer);
}

function fail(id: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  self.postMessage({ id, ok: false, error: message } satisfies WorkerResponse);
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sceneOf(index: number): PptxSceneResult {
  if (!pptxSession) throw new Error("请先打开 PPTX");
  const preview = renderPptxSlide(pptxSession, index, fitWidth);
  if (!preview) throw new Error(`第 ${index + 1} 页不存在`);
  return {
    slide: index,
    scene: preview.render,
    svg: renderSlideSvg(preview.render),
    widthPx: preview.widthPx,
    heightPx: preview.heightPx,
    emuPerPx: pptxEmuPerPx(pptxSession, preview.widthPx),
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}

function deckSlide(index: number): Slide {
  if (!pptxSession) throw new Error("请先打开 PPTX");
  const slide = pptxSession.opened.deck.slides[index];
  if (!slide) throw new Error(`第 ${index + 1} 页不存在`);
  return slide;
}

/** 语义化编辑 → pptx-ops 操作。坐标用页面 px，这里换算成 EMU。 */
function buildOp(index: number, edit: PptxEditOp): Op {
  if (edit.kind === "transform") {
    const scale = pptxSession ? pptxEmuPerPx(pptxSession, fitWidth) : 12700;
    const round = (value: number) => Math.round(value * scale);
    return {
      op: "setTransform",
      target: { slide: index, el: edit.el },
      box: {
        x: round(edit.box.x),
        y: round(edit.box.y),
        cx: round(edit.box.w),
        cy: round(edit.box.h),
      },
      rotDeg: edit.rotDeg,
    };
  }
  // setText 的纯文本模式：不传 srcRun/srcPara，按位置继承原段落与主 run 的格式。
  const paragraphs = edit.text
    .split(/\r?\n/)
    .map((line) => ({ runs: [{ text: line }] }));
  return {
    op: "setText",
    target: { slide: index, el: edit.el },
    paragraphs,
  };
}

function applyEdit(index: number, edit: PptxEditOp): PptxSceneResult {
  if (!pptxSession) throw new Error("请先打开 PPTX");
  const before = structuredClone(deckSlide(index));
  const result = runTxn(pptxSession.opened, {
    ops: [buildOp(index, edit)],
    isolation: "per_op",
  });
  if (!result.applied) {
    // per_op 不回滚：手动恢复单页快照
    pptxSession.opened.deck.slides[index] = before;
    const detail = result.failures?.[0]?.error ?? "编辑未生效";
    throw new Error(detail);
  }
  const after = structuredClone(deckSlide(index));
  undoStack.push({ slide: index, before, after });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  return sceneOf(index);
}

function undo(): PptxSceneResult {
  if (!pptxSession) throw new Error("请先打开 PPTX");
  const entry = undoStack.pop();
  if (!entry) throw new Error("没有可撤销的操作");
  pptxSession.opened.deck.slides[entry.slide] = structuredClone(entry.before);
  redoStack.push(entry);
  return sceneOf(entry.slide);
}

function redo(): PptxSceneResult {
  if (!pptxSession) throw new Error("请先打开 PPTX");
  const entry = redoStack.pop();
  if (!entry) throw new Error("没有可重做的操作");
  pptxSession.opened.deck.slides[entry.slide] = structuredClone(entry.after);
  undoStack.push(entry);
  return sceneOf(entry.slide);
}

async function handleOpen(params: {
  kind: "pptx" | "docx";
  bytes: ArrayBuffer;
  fitWidth?: number;
  fontMetrics?: Record<string, DocxFontMetrics>;
}): Promise<{ result: unknown; transfer: Transferable[] }> {
  kind = params.kind;
  pptxSession = null;
  docxSession = null;
  docxEdits = {};
  undoStack = [];
  redoStack = [];
  fitWidth = params.fitWidth ?? 960;

  if (params.kind === "pptx") {
    pptxSession = await openPptxSession(new Uint8Array(params.bytes));
    const slides = renderPptxSlides(pptxSession, fitWidth).map((preview) => ({
      index: preview.index,
      svg: renderSlideSvg(preview.render),
      widthPx: preview.widthPx,
      heightPx: preview.heightPx,
    }));
    const result: PptxOpenResult = { kind: "pptx", info: pptxSession.info, slides };
    return { result, transfer: [] };
  }

  const { openDocxSession } = await import("@/lib/office/docxEngine");
  const opened = await openDocxSession(new Uint8Array(params.bytes), {
    fontMetrics: params.fontMetrics,
  });
  docxSession = opened;
  const buffer = toBuffer(opened.saved);
  return {
    result: {
      kind: "docx",
      info: opened.info,
      html: opened.html,
      saved: new Uint8Array(buffer),
      textBlocks: opened.textBlocks,
    },
    transfer: [],
  };
}

async function handle(request: WorkerRequest): Promise<void> {
  const { id, method, params } = request;
  try {
    if (method === "open") {
      const { result } = await handleOpen(
        params as {
          kind: "pptx" | "docx";
          bytes: ArrayBuffer;
          fitWidth?: number;
          fontMetrics?: Record<string, DocxFontMetrics>;
        },
      );
      respond(id, result);
      return;
    }

    if (method === "get-scene") {
      const { slide } = params as { slide: number };
      respond(id, sceneOf(slide));
      return;
    }

    if (method === "apply-op") {
      const { slide, edit } = params as { slide: number; edit: PptxEditOp };
      respond(id, applyEdit(slide, edit));
      return;
    }

    if (method === "undo") {
      respond(id, undo());
      return;
    }

    if (method === "redo") {
      respond(id, redo());
      return;
    }

    if (method === "save") {
      if (kind === "pptx" && pptxSession) {
        const bytes = await savePptxSession(pptxSession);
        const buffer = toBuffer(bytes);
        respond(id, { bytes: buffer }, [buffer]);
        return;
      }
      if (kind === "docx" && docxSession) {
        const buffer = toBuffer(docxSession.saved);
        respond(id, { bytes: buffer }, [buffer]);
        return;
      }
      throw new Error("没有已打开的文档");
    }

    if (method === "docx-list-text") {
      if (!docxSession) throw new Error("请先打开 DOCX");
      respond(id, { items: docxSession.textBlocks satisfies DocxTextBlock[] });
      return;
    }

    if (method === "docx-update-text") {
      if (!docxSession) throw new Error("请先打开 DOCX");
      const { blockIndex, text } = params as { blockIndex: number; text: string };
      docxEdits[blockIndex] = text;
      const { openDocxSession, saveDocxWithEdits } = await import("@/lib/office/docxEngine");
      const saved = await saveDocxWithEdits(docxSession.parsed, docxEdits);
      const reopened = await openDocxSession(saved);
      docxSession = reopened;
      docxEdits = {};
      respond(id, {
        kind: "docx",
        info: reopened.info,
        html: reopened.html,
        saved: reopened.saved,
        textBlocks: reopened.textBlocks,
      });
      return;
    }

    if (method === "list-text") {
      if (!pptxSession) throw new Error("请先打开 PPTX");
      respond(id, { items: listPptxTextItems(pptxSession) satisfies PptxTextItem[] });
      return;
    }

    throw new Error(`未知方法: ${method}`);
  } catch (error) {
    fail(id, error);
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
};

export {};
