/**
 * Office 工作台（Phase 0）。
 *
 * - 多文档会话：每个文档一个 Worker，元数据进 Zustand，重对象留在页面 runtime Map
 * - PPTX：画布编辑器（选中/拖动/缩放/内联文本/撤销）
 * - DOCX / XLSX / PDF：只读预览（编辑能力按路线图后续阶段开放）
 * - 显式保存、另存为、关闭拦截、最近文件
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Spin, Table, Tabs, message, theme as antdTheme } from "antd";
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
  type OfficeFormat,
} from "@/lib/office/formats";
import { useOfficeStore, type OfficeSessionMeta } from "@/store/office";
import { OfficeTopBar } from "@/components/office/OfficeTopBar";
import { OfficeTabStrip } from "@/components/office/OfficeTabStrip";
import { OfficeEmptyState } from "@/components/office/OfficeEmptyState";
import { OfficeStatusBar } from "@/components/office/OfficeStatusBar";
import { SaveGuardDialog } from "@/components/office/SaveGuardDialog";
import { OfficePptxCommandBar } from "@/components/office/OfficePptxCommandBar";

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
  xlsx?: XlsxSheetPreview[];
  pdf?: PdfPagePreview[];
  slide: number;
}

function isEditableFormat(format: OfficeFormat): boolean {
  return format === "pptx" || format === "docx";
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

  const [activeSlide, setActiveSlide] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<{ id: string; name: string } | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [, setVersion] = useState(0);

  const runtimesRef = useRef<Map<string, SessionRuntime>>(new Map());
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
    const format = formatOf(path);
    if (!format) {
      message.error("不支持的文件类型");
      return;
    }
    const existing = useOfficeStore
      .getState()
      .sessions.find((item) => item.path === path);
    if (existing) {
      activateSession(existing.id);
      return;
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

    const rt: SessionRuntime = { client: new PptxWorkerClient(), slides: [], slide: 0 };
    runtimesRef.current.set(id, rt);
    activateSession(id);
    setOpening(true);

    try {
      if (format === "pptx" || format === "docx") {
        const bytes = await pptxSpikeApi.read(path);
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
          updateSession(id, { status: "ready", pageCount: result.info.pageCount });
        }
      } else if (format === "xlsx") {
        const sheets = await pptxSpikeApi.xlsxPreview(path);
        rt.xlsx = sheets;
        updateSession(id, { status: "ready", pageCount: sheets.length });
      } else {
        const pages = await pptxSpikeApi.pdfPreview(path, 3);
        rt.pdf = pages;
        updateSession(id, { status: "ready", pageCount: pages.length });
      }
      addRecent({ path, name, format });
      bump();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      updateSession(id, { status: "error", error: text });
      rt.client.terminate();
      message.error(text);
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

      updateSession(id, { saving: true });
      try {
        const bytes = await rt.client.save();
        await pptxSpikeApi.write(target, bytes);
        // 挂载内的文件立刻重抽索引，避免搜索 / RAG 在下一轮轮询前命中旧正文。
        void mountApi.refreshPath(target).catch(() => {});
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
      if (meta.format !== "pptx") return;

      const nodes = editor.scene ? collectEditableNodes(editor.scene.scene) : [];
      const selected = editor.selectedId
        ? nodes.find((node) => node.id === editor.selectedId) ?? null
        : null;
      const passive = !target || target === document.body;

      // 结构操作
      if (mod && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        void editor.duplicateSlide();
        return;
      }
      if (mod && event.key.toLowerCase() === "m") {
        event.preventDefault();
        void editor.insertSlide();
        return;
      }
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

      if (mod) {
        if (event.key.toLowerCase() === "z") {
          event.preventDefault();
          if (event.shiftKey) void editor.redo();
          else void editor.undo();
        } else if (event.key.toLowerCase() === "y") {
          event.preventDefault();
          void editor.redo();
        } else if (event.key.toLowerCase() === "w") {
          event.preventDefault();
          requestClose(meta.id);
        }
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
  }, [editor, requestClose, saveSession]);

  function externalOpen(meta: OfficeSessionMeta) {
    openPath(meta.path).catch((error) => {
      message.error(error instanceof Error ? error.message : String(error));
    });
  }

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
          <div
            className="w-40 shrink-0 overflow-y-auto p-2"
            style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}
          >
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
                  className="bg-white"
                  style={{ aspectRatio: `${slide.widthPx} / ${slide.heightPx}` }}
                  dangerouslySetInnerHTML={{ __html: slide.svg }}
                />
                <div className="px-1 py-0.5 text-[11px] text-gray-500">
                  第 {slide.index + 1} 页
                </div>
              </button>
            ))}
          </div>
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
        </div>
      );
    }

    if (activeMeta.format === "docx") {
      const html = runtime?.docxHtml;
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <Alert
            type="info"
            showIcon
            className="m-3 mb-0"
            message="DOCX 编辑将在后续版本开放，当前为只读预览"
          />
          <div className="min-h-0 flex-1 overflow-auto bg-gray-100 p-4">
            <div style={{ zoom: zoom / 100 }}>
              {html ? (
                <div dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <div className="flex h-40 items-center justify-center">
                  <Spin />
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (activeMeta.format === "xlsx") {
      const sheets = runtime?.xlsx ?? [];
      return (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <Alert
            type="info"
            showIcon
            className="mb-3"
            message="XLSX 编辑将在后续版本开放，当前为只读预览（前 40 行）"
          />
          {sheets.length > 0 && (
            <Tabs
              activeKey={String(sheetIndex)}
              onChange={(key) => setSheetIndex(Number(key))}
              items={sheets.map((sheet, index) => ({
                key: String(index),
                label: sheet.name,
                children: (
                  <Table
                    size="small"
                    bordered
                    pagination={false}
                    scroll={{ x: "max-content", y: 520 }}
                    dataSource={sheet.rows.map((row, rowIndex) => ({
                      key: rowIndex,
                      cells: row,
                    }))}
                    columns={[
                      { title: "#", dataIndex: "key", width: 52, render: (v: number) => v + 1 },
                      ...sheet.headers.map((header, colIndex) => ({
                        title: header || `列 ${colIndex + 1}`,
                        width: 160,
                        render: (_: unknown, row: { cells: string[] }) =>
                          row.cells[colIndex] ?? "",
                      })),
                    ]}
                  />
                ),
              }))}
            />
          )}
        </div>
      );
    }

    const pages = runtime?.pdf ?? [];
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-gray-100 p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {pages.map((page) => (
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
          ))}
        </div>
        <div className="pt-2 text-center text-[11px] text-gray-500">
          仅渲染前 3 页；PDF 只读
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: token.colorBgLayout }}>
      <OfficeTopBar
        session={activeMeta}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        busy={editor.busy}
        onOpen={() => void openDocument()}
        onSave={() => activeMeta && void saveSession(activeMeta.id)}
        onSaveAs={() => activeMeta && void saveSession(activeMeta.id, true)}
        onUndo={() => void editor.undo()}
        onRedo={() => void editor.redo()}
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
          />
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col">{renderContent()}</div>
          <OfficeStatusBar
            session={activeMeta}
            activeSlide={activeSlide}
            zoom={zoom}
            busy={editor.busy}
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
