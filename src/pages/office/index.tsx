/**
 * Office 工作台（Phase 0）。
 *
 * - 多文档会话：每个文档一个 Worker，元数据进 Zustand，重对象留在页面 runtime Map
 * - PPTX：画布编辑器（选中/拖动/缩放/内联文本/撤销）
 * - DOCX / XLSX / PDF：只读预览（编辑能力按路线图后续阶段开放）
 * - 显式保存、另存为、关闭拦截、最近文件
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  Input,
  Modal,
  Segmented,
  Select,
  Spin,
  Table,
  Tabs,
  message,
  theme as antdTheme,
} from "antd";
import "@/styles/office-sheet-tabs.css";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import type {
  PdfPagePreview,
  XlsxSheetPreview,
} from "@/lib/api/pptxSpike";
import { pptxSpikeApi } from "@/lib/api/pptxSpike";
import { mountApi } from "@/lib/api";
import { fontMetricsApi, type FontMetrics } from "@/lib/api/fontMetrics";
import {
  PptxWorkerClient,
  type OfficeOpenedData,
  type PptxSlidePreviewData,
} from "@/lib/office/pptxWorkerClient";
import { EditorCanvas } from "@/lib/office/editor/EditorCanvas";
import { usePptxEditor } from "@/lib/office/editor/usePptxEditor";
import { collectEditableNodes } from "@/lib/office/editor/geometry";
import { cycleIndex, moveTarget } from "@/lib/office/editor/slideActions";
import type { PptxSceneResult } from "@/lib/office/editor/protocol";
import {
  FORMAT_EXTENSION,
  FORMAT_LABEL,
  OFFICE_OPEN_FILTERS,
  baseName,
  formatOf,
  stripExtension,
  type OfficeFormat,
} from "@/lib/office/formats";
import { useOfficeStore, type OfficeSessionMeta } from "@/store/office";
import { OfficeTopBar } from "@/components/office/OfficeTopBar";
import { OfficeTabStrip } from "@/components/office/OfficeTabStrip";
import { OfficeEmptyState } from "@/components/office/OfficeEmptyState";
import { OfficeStatusBar } from "@/components/office/OfficeStatusBar";
import { SaveGuardDialog } from "@/components/office/SaveGuardDialog";
import { OfficePptxCommandBar } from "@/components/office/OfficePptxCommandBar";
import { OfficePropertyPanel } from "@/components/office/OfficePropertyPanel";
import { DocxPageView } from "@/components/office/DocxPageView";
import { OfficeSidePane } from "@/components/office/OfficeSidePane";
import {
  buildSheetGrid,
  columnLabel,
  excelRowNumber,
  pushCapped,
  type SheetGridRow,
} from "@/lib/office/sheets";
import { sha256Hex } from "@/lib/office/hash";
import {
  SESSION_STORAGE_KEY,
  parseSessionSnapshot,
  type OfficeSessionSnapshot,
} from "@/lib/office/sessionSnapshot";

const DEFAULT_FONT_FAMILIES = [
  "Calibri",
  "Arial",
  "Times New Roman",
  "Cambria",
  "Segoe UI",
  "Aptos",
  "Microsoft YaHei",
  "SimSun",
  "SimHei",
  "KaiTi",
];

let fontMetricsCache: Record<string, FontMetrics> | null = null;

async function loadFontMetrics(): Promise<Record<string, FontMetrics> | undefined> {
  if (fontMetricsCache) return fontMetricsCache;
  try {
    const measured = await fontMetricsApi.measure(DEFAULT_FONT_FAMILIES);
    fontMetricsCache = Object.fromEntries(
      measured.map((metrics) => [metrics.family.toLowerCase(), metrics]),
    );
  } catch {
    fontMetricsCache = {};
  }
  return fontMetricsCache;
}

interface SessionRuntime {
  client: PptxWorkerClient;
  slides: PptxSlidePreviewData[];
  docxHtml?: string;
  docxSaved?: Uint8Array;
  docxTextBlocks?: Array<{ blockIndex: number; type: string; text: string; preview: string }>;
  docxCanUndo?: boolean;
  docxCanRedo?: boolean;
  xlsx?: XlsxSheetPreview[];
  /** 当前磁盘上的 xlsx 字节（撤销/重做写回用） */
  xlsxBytes?: Uint8Array;
  xlsxUndo: Uint8Array[];
  xlsxRedo: Uint8Array[];
  pdf?: PdfPagePreview[];
  /** PDF 总页数（分批加载进度） */
  pdfTotal?: number;
  /** 正在加载更多 PDF 页 */
  pdfLoadingMore?: boolean;
  slide: number;
  /** 打开/最近一次保存时的文件 SHA-256，用于检测外部修改 */
  fileHash?: string;
}

function isEditableFormat(format: OfficeFormat): boolean {
  return format === "pptx" || format === "docx";
}

/** PDF 每批渲染页数：一次 IPC 控制在几页，避免大文件把 base64 payload 顶爆 */
const PDF_PAGE_BATCH = 4;

/**
 * Windows 扩展路径（`\\?\D:\...`）不接受正斜杠；挂载相对路径在 DB 里用 `/`
 * 拼接旧会话时可能混入 `/`，统一转成 `\` 再交给 Rust/pdfium。
 */
function normalizeFsPath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    return path.replace(/\//g, "\\");
  }
  return path;
}

export default function OfficeWorkspacePage() {
  const { token } = antdTheme.useToken();
  const sessions = useOfficeStore((state) => state.sessions);
  const activeId = useOfficeStore((state) => state.activeId);
  const recent = useOfficeStore((state) => state.recent);
  const addSession = useOfficeStore((state) => state.addSession);
  const updateSession = useOfficeStore((state) => state.updateSession);
  const removeSession = useOfficeStore((state) => state.removeSession);
  const setActive = useOfficeStore((state) => state.setActive);
  const addRecent = useOfficeStore((state) => state.addRecent);
  const removeRecent = useOfficeStore((state) => state.removeRecent);
  const clearRecent = useOfficeStore((state) => state.clearRecent);

  const [activeSlide, setActiveSlide] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [pdfViewMode, setPdfViewMode] = useState<"single" | "continuous" | "multi">(
    "continuous",
  );
  /** PDF 页面在 100% 时的基准宽度（按滚动容器实测，避免百分比宽度被 flex 压缩） */
  const [pdfBaseWidth, setPdfBaseWidth] = useState(900);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<{ id: string; name: string } | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [docxBusy, setDocxBusy] = useState(false);
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const [xlsxCell, setXlsxCell] = useState("");
  const [xlsxValue, setXlsxValue] = useState("");
  const [restorable, setRestorable] = useState<OfficeSessionSnapshot | null>(null);
  const [version, setVersion] = useState(0);

  const runtimesRef = useRef<Map<string, SessionRuntime>>(new Map());
  /** 已自动重开过的 PDF 路径，避免 HMR/重载后反复重建 */
  const autoReopenRef = useRef<Set<string>>(new Set());
  /** PDF 滚动容器（连续阅读自动加载 / 单页滚轮翻页用） */
  const pdfScrollRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const activeSlideRef = useRef(0);
  const clientRef = useRef<PptxWorkerClient | null>(null);
  // 外部挂载跳转：/office?path=<绝对路径>&readonly=<0|1>
  const [searchParams] = useSearchParams();

  useEffect(() => {
    activeSlideRef.current = activeSlide;
  }, [activeSlide]);

  const bump = useCallback(() => setVersion((value) => value + 1), []);

  const activeSession = useMemo(
    () => sessions.find((item) => item.id === activeId) ?? null,
    [sessions, activeId],
  );
  const runtime = activeId ? runtimesRef.current.get(activeId) : undefined;

  const handleThumbnail = useCallback(
    (slide: number, svg: string) => {
      const id = activeIdRef.current;
      if (!id) return;
      const rt = runtimesRef.current.get(id);
      if (!rt) return;
      rt.slide = slide;
      rt.slides = rt.slides.map((item) => (item.index === slide ? { ...item, svg } : item));
      setActiveSlide(slide);
      bump();
    },
    [bump],
  );

  const handleApplied = useCallback(() => {
    const id = activeIdRef.current;
    if (id) updateSession(id, { dirty: true });
  }, [updateSession]);

  const handleError = useCallback((cause: unknown) => {
    message.error(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const handleDeck = useCallback(
    (result: PptxSceneResult) => {
      const id = activeIdRef.current;
      if (!id) return;
      const rt = runtimesRef.current.get(id);
      if (!rt) return;
      if (result.slides) rt.slides = result.slides;
      rt.slide = result.slide;
      setActiveSlide(result.slide);
      updateSession(id, {
        pageCount: result.pageCount ?? result.slides?.length ?? rt.slides.length,
      });
      bump();
    },
    [bump, updateSession],
  );

  const editor = usePptxEditor({
    clientRef,
    onThumbnail: handleThumbnail,
    onError: handleError,
    onApplied: handleApplied,
    onDeck: handleDeck,
  });

  useEffect(() => {
    return () => {
      for (const rt of runtimesRef.current.values()) rt.client.terminate();
      runtimesRef.current.clear();
    };
  }, []);

  // 启动时提供“恢复上次会话”，不自动打开，避免一次加载多个大文件。
  useEffect(() => {
    if (useOfficeStore.getState().sessions.length > 0) return;
    const snapshot = parseSessionSnapshot(localStorage.getItem(SESSION_STORAGE_KEY));
    if (snapshot) setRestorable(snapshot);
  }, []);

  useEffect(() => {
    if (sessions.length === 0) return;
    try {
      const paths = sessions.filter((item) => item.status !== "error").map((item) => item.path);
      if (paths.length === 0) return;
      const active = sessions.find((item) => item.id === activeId);
      const snapshot: OfficeSessionSnapshot = {
        paths,
        activePath: active?.path ?? null,
      };
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      /* 存储失败不影响会话 */
    }
  }, [sessions, activeId]);

  const activateSession = useCallback(
    (id: string) => {
      setActive(id);
      activeIdRef.current = id;
      const meta = useOfficeStore.getState().sessions.find((item) => item.id === id);
      const rt = runtimesRef.current.get(id);
      clientRef.current = rt?.client ?? null;
      setActiveSlide(rt?.slide ?? 0);
      setSheetIndex(0);
      // 先清空上一份文档的场景，避免切换瞬间看到旧画面。
      editor.reset();
      if (meta?.format === "pptx" && meta.status === "ready") {
        void editor.openSlide(rt?.slide ?? 0);
      }
      bump();
    },
    [bump, editor, setActive],
  );

  async function openDocument(pathArg?: string, readOnly = false) {
    let path = pathArg;
    if (!path) {
      const selected = await openDialog({ multiple: false, filters: OFFICE_OPEN_FILTERS });
      if (typeof selected !== "string") return;
      path = selected;
    }
    path = normalizeFsPath(path);
    // 每次显式打开都允许自动恢复再试一次
    autoReopenRef.current.delete(path);
    const format = formatOf(path);
    if (!format) {
      message.error("不支持的文件类型");
      return;
    }
    const existing = useOfficeStore
      .getState()
      .sessions.find((item) => item.path === path);
    if (existing) {
      const live = runtimesRef.current.get(existing.id);
      // 已经是 ready 但页列表为空：原地重新拉取页数/首页，不销毁会话。
      // 注意只在 ready 时判断：loading 阶段的 pdf 本来就是空的，不能重建（会打断在途打开）。
      const pdfReadyEmpty =
        existing.format === "pdf" &&
        existing.status === "ready" &&
        (!live?.pdf || live.pdf.length === 0);
      if (live && existing.status !== "error") {
        if (useOfficeStore.getState().activeId !== existing.id) {
          activateSession(existing.id);
        }
        if (pdfReadyEmpty) void reloadPdfPages(existing, live);
        return;
      }
      // HMR / 页面重载后 runtimesRef 会丢，而会话元数据仍在；
      // 直接激活会得到空白（PDF 表现为“无可渲染页面”）。重建会话。
      live?.client.terminate();
      runtimesRef.current.delete(existing.id);
      removeSession(existing.id);
    }

    const id = crypto.randomUUID();
    const name = baseName(path);
    addSession({
      id,
      path,
      name,
      format,
      status: "loading",
      dirty: false,
      saving: false,
      readOnly,
    });

    const rt: SessionRuntime = {
      client: new PptxWorkerClient(),
      slides: [],
      slide: 0,
      xlsxUndo: [],
      xlsxRedo: [],
    };
    runtimesRef.current.set(id, rt);
    activateSession(id);
    setOpening(true);

    try {
      if (format === "pptx" || format === "docx") {
        // 大文件保护：读取前给出提示（读取仍会继续，由用户决定是否等待）。
        try {
          const size = await pptxSpikeApi.fileSize(path);
          if (size > 80 * 1024 * 1024) {
            message.warning("文档超过 80MB，解析可能占用较多内存");
          }
        } catch {
          /* 大小查询失败不阻断打开 */
        }
        const bytes = await pptxSpikeApi.read(path);
        rt.fileHash = await sha256Hex(new Uint8Array(bytes));
        const fontMetrics = format === "docx" ? await loadFontMetrics() : undefined;
        const result: OfficeOpenedData = await rt.client.open(
          format,
          bytes,
          format === "pptx" ? 960 : 820,
          { fontMetrics },
        );
        if (result.kind === "pptx") {
          rt.slides = result.slides;
          updateSession(id, { status: "ready", pageCount: result.info.slideCount });
          if (activeIdRef.current === id) void editor.openSlide(0);
        } else {
          rt.docxHtml = result.html;
          rt.docxSaved = result.saved;
          rt.docxTextBlocks = result.textBlocks;
          rt.docxCanUndo = !!result.canUndo;
          rt.docxCanRedo = !!result.canRedo;
          updateSession(id, { status: "ready", pageCount: result.info.pageCount });
        }
      } else if (format === "xlsx") {
        const sheets = await pptxSpikeApi.xlsxPreview(path);
        rt.xlsx = sheets;
        rt.xlsxBytes = new Uint8Array(await pptxSpikeApi.read(path));
        rt.fileHash = await sha256Hex(rt.xlsxBytes);
        updateSession(id, { status: "ready", pageCount: sheets.length });
      } else {
        // 先拿总页数，再分批渲染首批；剩余页由「加载更多 / 加载全部」按需拉取。
        const total = await pptxSpikeApi.pdfPageCount(path);
        const pages =
          total > 0 ? await pptxSpikeApi.pdfRenderPages(path, 0, PDF_PAGE_BATCH) : [];
        rt.pdf = pages;
        rt.pdfTotal = total;
        setActiveSlide(0);
        updateSession(id, { status: "ready", pageCount: total });
      }
      addRecent({ path, name, format });
      bump();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error("[office] 打开文档失败", path, error);
      updateSession(id, { status: "error", error: text });
      rt.client.terminate();
      message.error(text);
    } finally {
      setOpening(false);
    }
  }

  // HMR / 页面重载后，Zustand 里的会话元数据可能还在，但页面内的 runtime
  // （Worker、PDF 页、场景）已随组件重建丢失。此时标签会显示空白，
  // PDF 则表现为“无可渲染页面”。挂载时清理这些孤儿会话，并重开当前激活文件。
  async function restoreLastSession() {
    const snapshot = restorable;
    if (!snapshot) return;
    setRestorable(null);
    setOpening(true);
    try {
      for (const path of snapshot.paths) {
        await openDocument(path);
      }
      if (snapshot.activePath) {
        const target = useOfficeStore
          .getState()
          .sessions.find((item) => item.path === snapshot.activePath);
        if (target) activateSession(target.id);
      }
    } finally {
      setOpening(false);
    }
  }

  // 外部挂载文件树跳转：带 path 参数进入时打开原文件；已打开则切到该会话
  useEffect(() => {
    const path = searchParams.get("path");
    if (!path) return;
    const state = useOfficeStore.getState();
    const existing = state.sessions.find((item) => item.path === path);
    if (existing) {
      if (state.activeId !== existing.id) activateSession(existing.id);
      return;
    }
    void openDocument(path, searchParams.get("readonly") === "1");
    // openDocument / activateSession 每次渲染重建，这里只响应 query 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function confirmOverwriteIfChanged(
    rt: SessionRuntime,
    meta: OfficeSessionMeta,
  ): Promise<boolean> {
    if (!rt.fileHash) return true;
    try {
      const current = new Uint8Array(await pptxSpikeApi.read(meta.path));
      if ((await sha256Hex(current)) === rt.fileHash) return true;
    } catch {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: "文件已被外部修改",
        content: `「${meta.name}」在打开后被其他程序修改。继续写入会覆盖这些修改。`,
        okText: "覆盖",
        cancelText: "取消",
        okButtonProps: { danger: true },
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  const saveSession = useCallback(
    async (id: string, saveAs = false): Promise<boolean> => {
      const meta = useOfficeStore.getState().sessions.find((item) => item.id === id);
      const rt = runtimesRef.current.get(id);
      if (!meta || !rt || !isEditableFormat(meta.format)) return false;
      if (meta.readOnly) {
        message.warning("该文件位于只读挂载点，无法保存回原文件");
        return false;
      }

      let target = meta.path;
      if (saveAs) {
        const chosen = await saveDialog({
          defaultPath: meta.name,
          filters: [
            {
              name: FORMAT_LABEL[meta.format],
              extensions: [FORMAT_EXTENSION[meta.format]],
            },
          ],
        });
        if (!chosen) return false;
        target = chosen;
      }

      if (!saveAs && !(await confirmOverwriteIfChanged(rt, meta))) return false;

      updateSession(id, { saving: true });
      try {
        const bytes = await rt.client.save();
        await pptxSpikeApi.write(target, bytes);
        // 挂载内的文件立刻重抽索引，避免搜索 / RAG 在下一轮轮询前命中旧正文。
        void mountApi.refreshPath(target).catch(() => {});
        rt.fileHash = await sha256Hex(bytes);
        const name = baseName(target);
        updateSession(id, { saving: false, dirty: false, path: target, name });
        addRecent({ path: target, name, format: meta.format });
        message.success("已保存");
        bump();
        return true;
      } catch (error) {
        updateSession(id, { saving: false });
        message.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [addRecent, bump, updateSession],
  );

  const handleDocxCommit = useCallback(
    async (blockIndex: number, text: string) => {
      const id = activeIdRef.current;
      const meta = useOfficeStore.getState().sessions.find((item) => item.id === id);
      const rt = id ? runtimesRef.current.get(id) : null;
      if (!id || !meta || !rt || meta.format !== "docx" || meta.readOnly) return;
      setDocxBusy(true);
      try {
        const result = await rt.client.updateDocxText(blockIndex, text);
        rt.docxHtml = result.html;
        rt.docxSaved = result.saved;
        rt.docxTextBlocks = result.textBlocks;
        rt.docxCanUndo = !!result.canUndo;
        rt.docxCanRedo = !!result.canRedo;
        updateSession(id, { dirty: true, pageCount: result.info.pageCount });
        bump();
        message.success("已更新段落");
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      } finally {
        setDocxBusy(false);
      }
    },
    [bump, updateSession],
  );

  const docxHistory = useCallback(
    async (action: "undo" | "redo") => {
      const id = activeIdRef.current;
      const meta = useOfficeStore.getState().sessions.find((item) => item.id === id);
      const rt = id ? runtimesRef.current.get(id) : null;
      if (!id || !meta || !rt || meta.format !== "docx" || meta.readOnly) return;
      setDocxBusy(true);
      try {
        const result =
          action === "undo" ? await rt.client.undoDocx() : await rt.client.redoDocx();
        rt.docxHtml = result.html;
        rt.docxSaved = result.saved;
        rt.docxTextBlocks = result.textBlocks;
        rt.docxCanUndo = !!result.canUndo;
        rt.docxCanRedo = !!result.canRedo;
        updateSession(id, { dirty: true, pageCount: result.info.pageCount });
        bump();
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      } finally {
        setDocxBusy(false);
      }
    },
    [bump, updateSession],
  );

  const handleXlsxCell = useCallback(async () => {
    const id = activeIdRef.current;
    const meta = useOfficeStore.getState().sessions.find((item) => item.id === id);
    const rt = id ? runtimesRef.current.get(id) : null;
    const cell = xlsxCell.trim();
    const sheet = rt?.xlsx?.[sheetIndex]?.name;
    if (!id || !meta || !rt || meta.format !== "xlsx" || meta.readOnly || !cell || !sheet) {
      return;
    }
    if (!(await confirmOverwriteIfChanged(rt, meta))) return;
    setXlsxBusy(true);
    try {
      const before = rt.xlsxBytes ?? new Uint8Array(await pptxSpikeApi.read(meta.path));
      const next = await pptxSpikeApi.xlsxSetCell(meta.path, sheet, cell, xlsxValue);
      rt.xlsx = next;
      rt.xlsxBytes = new Uint8Array(await pptxSpikeApi.read(meta.path));
      rt.fileHash = await sha256Hex(rt.xlsxBytes);
      rt.xlsxUndo = pushCapped(rt.xlsxUndo, before);
      rt.xlsxRedo = [];
      updateSession(id, { dirty: false });
      setXlsxCell("");
      setXlsxValue("");
      bump();
      message.success("单元格已写回文件");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setXlsxBusy(false);
    }
  }, [bump, sheetIndex, updateSession, xlsxCell, xlsxValue]);

  const xlsxHistory = useCallback(
    async (action: "undo" | "redo") => {
      const id = activeIdRef.current;
      const meta = useOfficeStore.getState().sessions.find((item) => item.id === id);
      const rt = id ? runtimesRef.current.get(id) : null;
      if (!id || !meta || !rt || meta.format !== "xlsx") return;
      const stack = action === "undo" ? rt.xlsxUndo : rt.xlsxRedo;
      if (stack.length === 0) {
        message.info(action === "undo" ? "没有可撤销的单元格写入" : "没有可重做的写入");
        return;
      }
      if (!(await confirmOverwriteIfChanged(rt, meta))) return;
      setXlsxBusy(true);
      try {
        const target = stack[stack.length - 1]!;
        const current = rt.xlsxBytes ?? new Uint8Array(await pptxSpikeApi.read(meta.path));
        await pptxSpikeApi.write(meta.path, target);
        rt.fileHash = await sha256Hex(target);
        const sheets = await pptxSpikeApi.xlsxPreview(meta.path);
        rt.xlsx = sheets;
        rt.xlsxBytes = target;
        if (action === "undo") {
          rt.xlsxUndo = rt.xlsxUndo.slice(0, -1);
          rt.xlsxRedo = pushCapped(rt.xlsxRedo, current);
        } else {
          rt.xlsxRedo = rt.xlsxRedo.slice(0, -1);
          rt.xlsxUndo = pushCapped(rt.xlsxUndo, current);
        }
        bump();
        message.success(action === "undo" ? "已撤销单元格写入" : "已重做单元格写入");
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      } finally {
        setXlsxBusy(false);
      }
    },
    [bump],
  );

  async function exportSlide(kind: "png" | "svg") {
    const sceneData = editor.scene;
    const id = activeIdRef.current;
    const meta = useOfficeStore.getState().sessions.find((item) => item.id === id);
    if (!sceneData || !meta || meta.format !== "pptx") return;
    const target = await saveDialog({
      defaultPath: `${stripExtension(meta.name)}-第${sceneData.slide + 1}页.${kind}`,
      filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
    });
    if (!target) return;
    try {
      if (kind === "svg") {
        await pptxSpikeApi.writeExport(target, new TextEncoder().encode(sceneData.svg));
      } else {
        const url = URL.createObjectURL(
          new Blob([sceneData.svg], { type: "image/svg+xml;charset=utf-8" }),
        );
        try {
          const image = new Image();
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("SVG 渲染失败"));
            image.src = url;
          });
          const scale = 2;
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(sceneData.widthPx * scale);
          canvas.height = Math.round(sceneData.heightPx * scale);
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("无法创建画布");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/png"),
          );
          if (!blob) throw new Error("PNG 编码失败");
          await pptxSpikeApi.writeExport(target, new Uint8Array(await blob.arrayBuffer()));
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      message.success("已导出");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  const closeSession = useCallback(
    (id: string) => {
      const rt = runtimesRef.current.get(id);
      rt?.client.terminate();
      runtimesRef.current.delete(id);
      removeSession(id);
      const nextId = useOfficeStore.getState().activeId;
      if (nextId) {
        activateSession(nextId);
      } else {
        activeIdRef.current = null;
        clientRef.current = null;
        editor.reset();
        setActiveSlide(0);
        try {
          localStorage.removeItem(SESSION_STORAGE_KEY);
        } catch {
          /* 忽略存储错误 */
        }
        setRestorable(null);
        bump();
      }
    },
    [activateSession, bump, editor, removeSession],
  );

  const requestClose = useCallback(
    (id: string) => {
      const meta = useOfficeStore.getState().sessions.find((item) => item.id === id);
      if (!meta) return;
      if (meta.dirty) setClosing({ id, name: meta.name });
      else closeSession(id);
    },
    [closeSession],
  );

  const activeMeta = activeSession;

  const selectedNode = useMemo(() => {
    if (!editor.scene || !editor.selectedId) return null;
    return (
      collectEditableNodes(editor.scene.scene).find(
        (node) => node.id === editor.selectedId,
      ) ?? null
    );
  }, [editor.scene, editor.selectedId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = useOfficeStore
        .getState()
        .sessions.find((item) => item.id === activeIdRef.current);
      if (!meta) return;
      const mod = event.ctrlKey || event.metaKey;
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (isEditableFormat(meta.format)) void saveSession(meta.id, event.shiftKey);
        return;
      }
      if (typing) return;
      const isPptx = meta.format === "pptx";
      const isDocx = meta.format === "docx";
      const isXlsx = meta.format === "xlsx";

      if (mod) {
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
          event.preventDefault();
          if (isPptx) {
            if (key === "y" || event.shiftKey) void editor.redo();
            else void editor.undo();
          } else if (isDocx) {
            void docxHistory(key === "y" || event.shiftKey ? "redo" : "undo");
          } else if (isXlsx) {
            void xlsxHistory(key === "y" || event.shiftKey ? "redo" : "undo");
          }
          return;
        }
        if (key === "w") {
          event.preventDefault();
          requestClose(meta.id);
          return;
        }
        if (!isPptx) return;
        if (event.shiftKey && key === "d") {
          event.preventDefault();
          void editor.duplicateSlide();
          return;
        }
        if (key === "m") {
          event.preventDefault();
          void editor.insertSlide();
          return;
        }
        return;
      }

      if (!isPptx) return;

      const nodes = editor.scene ? collectEditableNodes(editor.scene.scene) : [];
      const selected = editor.selectedId
        ? nodes.find((node) => node.id === editor.selectedId) ?? null
        : null;
      const passive = !target || target === document.body;

      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const pageCount = meta.pageCount ?? 1;
        const to = moveTarget(
          activeSlideRef.current,
          pageCount,
          event.key === "ArrowUp" ? -1 : 1,
        );
        if (to != null) void editor.moveSlide(to);
        return;
      }

      if (!passive) return;

      // 元素微移
      if (
        selected &&
        (event.key === "ArrowUp" ||
          event.key === "ArrowDown" ||
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight")
      ) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx =
          event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy =
          event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        void editor.commitTransform(selected, {
          x: selected.box.x + dx,
          y: selected.box.y + dy,
          w: selected.box.w,
          h: selected.box.h,
        });
        return;
      }

      // Tab 在元素间循环（已有选中时才接管，避免破坏焦点导航）
      if (event.key === "Tab" && selected) {
        event.preventDefault();
        const current = nodes.findIndex((node) => node.id === selected.id);
        const next = cycleIndex(current, nodes.length, event.shiftKey ? -1 : 1);
        if (next >= 0) editor.select(nodes[next]!);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [docxHistory, editor, requestClose, saveSession, xlsxHistory]);

  function externalOpen(meta: OfficeSessionMeta) {
    openPath(meta.path).catch((error) => {
      message.error(error instanceof Error ? error.message : String(error));
    });
  }

  /** 已有 runtime 但页列表为空：原地重新拉页数 + 首批，不销毁会话。 */
  async function reloadPdfPages(meta: OfficeSessionMeta, rt: SessionRuntime) {
    if (rt.pdfLoadingMore) return;
    rt.pdfLoadingMore = true;
    bump();
    try {
      const total = await pptxSpikeApi.pdfPageCount(meta.path);
      const pages =
        total > 0 ? await pptxSpikeApi.pdfRenderPages(meta.path, 0, PDF_PAGE_BATCH) : [];
      rt.pdf = pages;
      rt.pdfTotal = total;
      setActiveSlide(0);
      updateSession(meta.id, { status: "ready", pageCount: total, error: undefined });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error("[office] PDF 页加载失败", meta.path, error);
      updateSession(meta.id, { status: "error", error: text });
      message.error(text);
    } finally {
      rt.pdfLoadingMore = false;
      bump();
    }
  }

  /** 当前 PDF 会话页列表为空时：优先原地重载；runtime 丢失才重建会话。 */
  function reopenActivePdf() {
    if (!activeMeta || activeMeta.format !== "pdf") return;
    autoReopenRef.current.delete(activeMeta.path);
    const rt = runtimesRef.current.get(activeMeta.id);
    if (rt) {
      void reloadPdfPages(activeMeta, rt);
      return;
    }
    removeSession(activeMeta.id);
    void openDocument(activeMeta.path, !!activeMeta.readOnly);
  }

  /** 追加加载 PDF 页；`all=true` 时按批拉完剩余全部页。 */
  async function loadPdfPages(meta: OfficeSessionMeta, all: boolean) {
    const rt = runtimesRef.current.get(meta.id);
    if (!rt || rt.pdfLoadingMore) return;
    const loaded = rt.pdf?.length ?? 0;
    const total = rt.pdfTotal ?? loaded;
    if (loaded >= total) return;

    rt.pdfLoadingMore = true;
    bump();
    const hideLoading = all ? message.loading("正在渲染全部 PDF 页…", 0) : undefined;
    try {
      if (all) {
        let next = loaded;
        while (next < total) {
          const batch = await pptxSpikeApi.pdfRenderPages(meta.path, next, PDF_PAGE_BATCH);
          if (batch.length === 0) break;
          rt.pdf = [...(rt.pdf ?? []), ...batch];
          next = rt.pdf.length;
          bump();
        }
      } else {
        const batch = await pptxSpikeApi.pdfRenderPages(meta.path, loaded, PDF_PAGE_BATCH);
        rt.pdf = [...(rt.pdf ?? []), ...batch];
      }
    } catch (error) {
      message.error(
        `加载 PDF 页失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      hideLoading?.();
      rt.pdfLoadingMore = false;
      bump();
    }
  }

  /** 单页模式跳页；目标页未加载时按批补齐。 */
  async function goToPdfPage(meta: OfficeSessionMeta, index: number) {
    const rt = runtimesRef.current.get(meta.id);
    if (!rt) return;
    const total = rt.pdfTotal ?? 0;
    const target = Math.max(0, Math.min(index, Math.max(0, total - 1)));
    setActiveSlide(target);
    if (pdfScrollRef.current) pdfScrollRef.current.scrollTop = 0;
    let loaded = rt.pdf?.length ?? 0;
    while (loaded <= target && loaded < total) {
      await loadPdfPages(meta, false);
      const next = rt.pdf?.length ?? 0;
      if (next === loaded) break;
      loaded = next;
    }
  }

  /** 单页模式：滚轮到底自动翻下一页，顶部向上滚翻上一页。 */
  function handlePdfWheel(e: ReactWheelEvent<HTMLDivElement>) {
    if (pdfViewMode !== "single" || !activeMeta) return;
    const total = runtime?.pdfTotal ?? 0;
    if (total <= 1) return;
    const el = e.currentTarget;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const atTop = el.scrollTop <= 2;
    if (e.deltaY > 0 && atBottom && activeSlide < total - 1) {
      void goToPdfPage(activeMeta, activeSlide + 1);
    } else if (e.deltaY < 0 && atTop && activeSlide > 0) {
      void goToPdfPage(activeMeta, activeSlide - 1);
    }
  }

  /** 连续/多页模式：接近底部时自动追加下一批页面。 */
  function handlePdfScroll(e: ReactUIEvent<HTMLDivElement>) {
    if (pdfViewMode === "single" || !activeMeta) return;
    if (runtime?.pdfLoadingMore) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 480) {
      void loadPdfPages(activeMeta, false);
    }
  }

  // 切换视图模式时回到顶部，避免连续模式沿用单页的滚动位置
  useEffect(() => {
    if (pdfScrollRef.current) pdfScrollRef.current.scrollTop = 0;
  }, [pdfViewMode]);

  // 实测 PDF 滚动容器宽度，作为 100% 缩放基准（像素宽度不受 flex 压缩影响）
  useEffect(() => {
    if (activeMeta?.format !== "pdf") return;
    const el = pdfScrollRef.current;
    if (!el) return;
    const update = () => setPdfBaseWidth(Math.max(320, el.clientWidth - 32));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeMeta?.id, activeMeta?.format, activeMeta?.status]);

  // HMR / 页面重载后 runtime 会丢失，但会话元数据（pageCount）还在；
  // PDF 视图此时会显示“无可渲染页面”。自动重建一次，避免用户手动点“重新打开”。
  useEffect(() => {
    if (!activeMeta || activeMeta.format !== "pdf" || activeMeta.status !== "ready") {
      return;
    }
    const rt = runtimesRef.current.get(activeMeta.id);
    if (rt && (rt.pdf?.length ?? 0) > 0) return;
    if (autoReopenRef.current.has(activeMeta.path)) return;
    autoReopenRef.current.add(activeMeta.path);
    if (rt) void reloadPdfPages(activeMeta, rt);
    else reopenActivePdf();
    // reopenActivePdf 每次渲染重建，只对活跃 PDF 状态变化触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMeta?.id, activeMeta?.status, activeMeta?.pageCount, version]);

  function renderContent() {
    if (!activeMeta) return null;
    if (activeMeta.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center">
          <Spin tip="正在打开文档…" />
        </div>
      );
    }
    if (activeMeta.status === "error") {
      return (
        <div className="p-6">
          <Alert
            type="error"
            showIcon
            message="文档打开失败"
            description={
              <div className="space-y-2">
                <div>{activeMeta.error}</div>
                <a onClick={() => externalOpen(activeMeta)}>用系统默认程序打开</a>
              </div>
            }
          />
        </div>
      );
    }

    if (activeMeta.format === "pptx") {
      if (!editor.scene) {
        return (
          <div className="flex h-full items-center justify-center">
            <Spin tip="正在准备画布…" />
          </div>
        );
      }
      const pptxRuntime = runtime;
      return (
        <div className="flex min-h-0 flex-1">
          <OfficeSidePane storageKey="office.side.ppt" defaultWidth={160} min={110} max={420}>
            <div className="h-full overflow-y-auto p-2">
              {(pptxRuntime?.slides ?? []).map((slide) => (
                <button
                  key={slide.index}
                  type="button"
                  onClick={() => {
                    if (pptxRuntime) pptxRuntime.slide = slide.index;
                    setActiveSlide(slide.index);
                    void editor.openSlide(slide.index);
                  }}
                  className={`mb-2 block w-full rounded border-2 p-0 text-left ${
                    activeSlide === slide.index
                      ? "border-blue-500"
                      : "border-transparent hover:border-gray-300"
                  }`}
                >
                  <div
                    className="overflow-hidden bg-white [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
                    style={{ aspectRatio: `${slide.widthPx} / ${slide.heightPx}` }}
                    dangerouslySetInnerHTML={{ __html: slide.svg }}
                  />
                  <div className="px-1 py-0.5 text-[11px] text-gray-500">
                    第 {slide.index + 1} 页
                  </div>
                </button>
              ))}
            </div>
          </OfficeSidePane>
          <div className="min-h-0 flex-1 overflow-auto p-4" style={{ background: token.colorBgLayout }}>
            <div style={{ width: `${zoom}%`, margin: "0 auto" }}>
              <EditorCanvas
                scene={editor.scene.scene}
                svg={editor.scene.svg}
                selectedId={editor.selectedId}
                busy={editor.busy}
                onSelect={editor.select}
                onCommitTransform={(node, box) => void editor.commitTransform(node, box)}
                onCommitText={(node, text) => void editor.commitText(node, text)}
              />
            </div>
            <div className="mt-2 text-center text-[11px]" style={{ color: token.colorTextTertiary }}>
              单击选中 · 拖动移动 · 拖动控制点缩放 · 双击文本编辑（Ctrl+Enter 提交，Esc 取消）
            </div>
          </div>
          <OfficePropertyPanel
            node={selectedNode}
            disabled={editor.busy || !!activeMeta.readOnly}
            onChange={(edit) => void editor.commitStyle(edit)}
            onTransform={(node, box) => void editor.commitTransform(node, box)}
            onRotation={(node, rotDeg) => void editor.commitRotation(node, rotDeg)}
          />
        </div>
      );
    }

    if (activeMeta.format === "docx") {
      const html = runtime?.docxHtml;
      if (!html) {
        return (
          <div className="flex h-full items-center justify-center">
            <Spin tip="正在准备文档…" />
          </div>
        );
      }
      const headings = (runtime?.docxTextBlocks ?? []).filter(
        (block) => block.type === "heading",
      );
      return (
        <div className="flex min-h-0 flex-1">
          <OfficeSidePane storageKey="office.side.docx" defaultWidth={192} min={140} max={360}>
            <div className="h-full overflow-y-auto p-2">
              <div className="mb-2 text-[11px] font-medium" style={{ color: token.colorTextSecondary }}>
                标题导航
              </div>
              {headings.length === 0 ? (
                <div className="text-[11px]" style={{ color: token.colorTextTertiary }}>
                  未检测到标题
                </div>
              ) : (
                headings.map((block) => (
                  <button
                    key={block.blockIndex}
                    type="button"
                    className="mb-1 block w-full truncate rounded px-1 py-0.5 text-left text-[12px] hover:bg-black/5"
                    title={block.text}
                    onClick={() => {
                      document
                        .querySelector(`[data-block-index="${block.blockIndex}"]`)
                        ?.scrollIntoView({ block: "center", behavior: "smooth" });
                    }}
                  >
                    {block.text}
                  </button>
                ))
              )}
              <div className="mt-3 text-[11px]" style={{ color: token.colorTextTertiary }}>
                双击正文段落可编辑；Ctrl+Enter 提交，Esc 取消。
              </div>
            </div>
          </OfficeSidePane>
          <DocxPageView
            html={html}
            zoom={zoom}
            busy={docxBusy || !!activeMeta.readOnly}
            blocks={runtime?.docxTextBlocks}
            onCommit={(blockIndex, text) => void handleDocxCommit(blockIndex, text)}
          />
        </div>
      );
    }

    if (activeMeta.format === "xlsx") {
      const sheets = runtime?.xlsx ?? [];
      return (
        <div className="flex min-h-0 flex-1 flex-col px-3 pt-3">
          <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
            <Select
              size="small"
              style={{ width: 160 }}
              value={sheets[sheetIndex]?.name}
              onChange={(name) => {
                const index = sheets.findIndex((sheet) => sheet.name === name);
                if (index >= 0) setSheetIndex(index);
              }}
              options={sheets.map((sheet) => ({ value: sheet.name, label: sheet.name }))}
            />
            <Input
              size="small"
              style={{ width: 110 }}
              placeholder="单元格 A1"
              value={xlsxCell}
              disabled={!!activeMeta.readOnly}
              onChange={(event) => setXlsxCell(event.target.value)}
            />
            <Input
              size="small"
              style={{ width: 220 }}
              placeholder="新值"
              value={xlsxValue}
              disabled={!!activeMeta.readOnly}
              onChange={(event) => setXlsxValue(event.target.value)}
              onPressEnter={() => void handleXlsxCell()}
            />
            <Button
              type="primary"
              size="small"
              loading={xlsxBusy}
              disabled={!!activeMeta.readOnly || !xlsxCell.trim()}
              onClick={() => void handleXlsxCell()}
            >
              写入单元格
            </Button>
            <span className="text-[11px]" style={{ color: token.colorTextTertiary }}>
              修改即时写回原文件；当前预览前 40 行
            </span>
          </div>
          {sheets.length > 0 && (
            <Tabs
              className="office-sheet-tabs"
              activeKey={String(sheetIndex)}
              onChange={(key) => setSheetIndex(Number(key))}
              tabPosition="bottom"
              items={sheets.map((sheet, index) => ({
                key: String(index),
                label: sheet.name,
                children: (
                  <div className="office-sheet-scroll">
                    <Table
                      size="small"
                      bordered
                      className="office-sheet-table"
                      pagination={false}
                      scroll={{ x: "max-content" }}
                      dataSource={buildSheetGrid(sheet)}
                      columns={[
                        {
                          title: "",
                          dataIndex: "key",
                          width: 44,
                          render: (_: unknown, row: SheetGridRow) => excelRowNumber(row),
                        },
                        ...sheet.headers.map((_header, colIndex) => ({
                          title: columnLabel(colIndex),
                          width: 110,
                          render: (_: unknown, row: SheetGridRow) => (
                            <span className={row.header ? "font-medium" : undefined}>
                              {row.cells[colIndex] ?? ""}
                            </span>
                          ),
                        })),
                      ]}
                    />
                  </div>
                ),
              }))}
            />
          )}
        </div>
      );
    }

    const pages = runtime?.pdf ?? [];
    const total = runtime?.pdfTotal ?? pages.length;
    const allLoaded = pages.length >= total;
    const remaining = Math.max(0, total - pages.length);
    const current = Math.max(0, Math.min(activeSlide, Math.max(0, total - 1)));
    // 像素宽度：>100% 时整页变宽并可横向滚动；百分比宽度在 flex 容器里会被压回 100%
    const pdfPageWidth = Math.max(120, Math.round((pdfBaseWidth * zoom) / 100));
    const maxWidth = zoom > 100 ? undefined : pdfViewMode === "multi" ? 1600 : 1200;
    const pageCard = (page: PdfPagePreview) => (
      <div key={page.page} className="rounded bg-white p-2 shadow-sm">
        <img
          src={`data:image/png;base64,${page.png_base64}`}
          alt={`第 ${page.page} 页`}
          className="w-full rounded border"
        />
        <div className="pt-1 text-center text-[11px] text-gray-500">
          第 {page.page} 页
        </div>
      </div>
    );

    return (
      <div className="flex min-h-0 flex-1 flex-col bg-gray-100">
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2"
          style={{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }}
        >
          <Segmented
            size="small"
            value={pdfViewMode}
            onChange={(value) => setPdfViewMode(value as "single" | "continuous" | "multi")}
            options={[
              { label: "单页", value: "single" },
              { label: "连续", value: "continuous" },
              { label: "多页", value: "multi" },
            ]}
          />
          {pdfViewMode === "single" && (
            <div className="flex items-center gap-1.5">
              <Button
                size="small"
                disabled={current <= 0}
                onClick={() => void goToPdfPage(activeMeta, current - 1)}
              >
                上一页
              </Button>
              <span className="min-w-[72px] text-center text-xs tabular-nums">
                {total > 0 ? `${current + 1} / ${total}` : "0 / 0"}
              </span>
              <Button
                size="small"
                disabled={total === 0 || current >= total - 1}
                onClick={() => void goToPdfPage(activeMeta, current + 1)}
              >
                下一页
              </Button>
            </div>
          )}
          <div className="flex-1" />
          <span className="text-xs" style={{ color: token.colorTextTertiary }}>
            {total === 0
              ? "无页面"
              : allLoaded
                ? `共 ${total} 页（已全部加载）`
                : `已加载 ${pages.length} / ${total} 页`}
          </span>
          {!allLoaded && total > 0 && (
            <>
              <Button
                size="small"
                loading={runtime?.pdfLoadingMore}
                onClick={() => void loadPdfPages(activeMeta, false)}
              >
                加载更多（{Math.min(PDF_PAGE_BATCH, remaining)} 页）
              </Button>
              <Button
                size="small"
                disabled={runtime?.pdfLoadingMore}
                onClick={() => void loadPdfPages(activeMeta, true)}
              >
                加载全部
              </Button>
            </>
          )}
          {total === 0 && (
            <Button size="small" onClick={reopenActivePdf}>
              重新打开 PDF
            </Button>
          )}
        </div>

        <div
          ref={pdfScrollRef}
          onScroll={handlePdfScroll}
          onWheel={handlePdfWheel}
          className="min-h-0 flex-1 overflow-auto p-4"
        >
          {total === 0 ? (
            <div className="flex h-full items-center justify-center text-sm" style={{ color: token.colorTextSecondary }}>
              PDF 无可渲染页面；PDF 只读
            </div>
          ) : pdfViewMode === "single" ? (
            // 不用 flex 居中：flex 项默认 shrink，会把 >100% 的宽度压回容器宽
            <div className="w-full">
              <div
                className="mx-auto"
                style={{ width: pdfPageWidth, maxWidth, flexShrink: 0 }}
              >
                {pages[current] ? (
                  pageCard(pages[current]!)
                ) : (
                  <div className="flex justify-center py-16">
                    <Spin tip="正在加载该页…" />
                  </div>
                )}
              </div>
            </div>
          ) : pdfViewMode === "continuous" ? (
            // 连续阅读：页与页只留很窄的间距，滚到底部自动追加下一页
            <div
              className="mx-auto flex flex-col gap-2"
              style={{ width: pdfPageWidth, maxWidth, flexShrink: 0 }}
            >
              {pages.map(pageCard)}
            </div>
          ) : (
            <div
              className="grid grid-cols-1 gap-4 md:grid-cols-2"
              style={{ width: pdfPageWidth, maxWidth, flexShrink: 0 }}
            >
              {pages.map(pageCard)}
            </div>
          )}
          {!allLoaded && total > 0 && pdfViewMode !== "single" && (
            <div
              className="py-4 text-center text-xs"
              style={{ color: token.colorTextTertiary }}
            >
              {runtime?.pdfLoadingMore
                ? "正在加载更多页面…"
                : "继续向下滚动自动加载下一页…"}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: token.colorBgLayout }}>
      <OfficeTopBar
        session={activeMeta}
        canUndo={
          activeMeta?.format === "docx"
            ? !!runtime?.docxCanUndo
            : activeMeta?.format === "xlsx"
              ? !!runtime?.xlsxUndo.length
              : editor.canUndo
        }
        canRedo={
          activeMeta?.format === "docx"
            ? !!runtime?.docxCanRedo
            : activeMeta?.format === "xlsx"
              ? !!runtime?.xlsxRedo.length
              : editor.canRedo
        }
        busy={editor.busy || docxBusy || xlsxBusy}
        onOpen={() => void openDocument()}
        onSave={() => activeMeta && void saveSession(activeMeta.id)}
        onSaveAs={() => activeMeta && void saveSession(activeMeta.id, true)}
        onUndo={() => {
          if (activeMeta?.format === "docx") void docxHistory("undo");
          else if (activeMeta?.format === "xlsx") void xlsxHistory("undo");
          else void editor.undo();
        }}
        onRedo={() => {
          if (activeMeta?.format === "docx") void docxHistory("redo");
          else if (activeMeta?.format === "xlsx") void xlsxHistory("redo");
          else void editor.redo();
        }}
        onExternal={() => activeMeta && externalOpen(activeMeta)}
      />

      <OfficeTabStrip
        sessions={sessions}
        activeId={activeId}
        onActivate={activateSession}
        onClose={requestClose}
      />

      {activeMeta?.format === "pptx" && activeMeta.status === "ready" && (
        <OfficePptxCommandBar
          pageCount={activeMeta.pageCount ?? runtime?.slides.length ?? 1}
          activeSlide={activeSlide}
          busy={editor.busy}
          onInsert={() => void editor.insertSlide()}
          onDuplicate={() => void editor.duplicateSlide()}
          onDelete={() => void editor.deleteSlide()}
          onMove={(to) => void editor.moveSlide(to)}
          onExportPng={() => void exportSlide("png")}
          onExportSvg={() => void exportSlide("svg")}
        />
      )}

      {!activeMeta ? (
        <div className="min-h-0 flex-1">
          <OfficeEmptyState
            recent={recent}
            busy={opening}
            onOpen={() => void openDocument()}
            onOpenRecent={(path) => void openDocument(path)}
            onRemoveRecent={removeRecent}
            onClearRecent={clearRecent}
            restorable={
              restorable
                ? {
                    count: restorable.paths.length,
                    onRestore: () => void restoreLastSession(),
                    onDismiss: () => setRestorable(null),
                  }
                : null
            }
          />
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col">{renderContent()}</div>
          <OfficeStatusBar
            session={activeMeta}
            activeSlide={activeSlide}
            zoom={zoom}
            busy={editor.busy || docxBusy || xlsxBusy}
            onZoom={setZoom}
          />
        </>
      )}

      <SaveGuardDialog
        open={!!closing}
        fileName={closing?.name ?? ""}
        saving={!!closing && !!sessions.find((item) => item.id === closing.id)?.saving}
        onCancel={() => setClosing(null)}
        onDiscard={() => {
          if (closing) closeSession(closing.id);
          setClosing(null);
        }}
        onSave={() => {
          if (!closing) return;
          void saveSession(closing.id).then((ok) => {
            if (ok) closeSession(closing.id);
            setClosing(null);
          });
        }}
      />
    </div>
  );
}
