import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ChevronLeft,
  Pin,
  Code2,
  FileText,
  Network,
  Sparkles,
} from "lucide-react";
import { message } from "antd";
import { noteApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Note } from "@/types";
import { TiptapEditor } from "@/components/editor";
import { MarkdownSourceEditor } from "@/components/editor/MarkdownSourceEditor";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";

/**
 * 移动端文档编辑页。
 *
 * 与桌面共用同一套 Tiptap（扩展 / Markdown 序列化 / 图片管线），移动端只做外壳：
 * - 标题 + 自动保存状态机（沿用原有实现）
 * - 富文本 / Markdown 源码双模式；富文本工具栏由 TiptapEditor portal 到底部横滑条
 * - 图片粘贴/选择走 TiptapEditor 的 noteId 管线
 * - 思维导图全屏页、Pin、返回前 flush 保持不变
 *
 * 路由：/notes/:id（isMobile=true 时由 wrapper 加载本组件）。
 */

// 思维导图依赖 markmap / html-to-image，体积不小：用到才加载
const MobileMindMap = lazy(() =>
  import("@/components/mobile/MobileMindMap").then((m) => ({ default: m.MobileMindMap })),
);

const AUTOSAVE_DELAY_MS = 1200;
const SAVED_TOAST_MS = 2500;

type SaveStatus = "idle" | "dirty" | "saving" | "saved";

export function MobileNoteEditor() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id: idParam } = useParams<{ id: string }>();
  const noteId = Number(idParam);

  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [pinning, setPinning] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);
  const [mindMapOpen, setMindMapOpen] = useState(false);
  const [mindMapEditDefault, setMindMapEditDefault] = useState(false);
  const keyboardInset = useKeyboardInset();

  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const savedHideTimerRef = useRef<number | null>(null);
  /**
   * title / content 的 ref 镜像 — 解决 React 闭包陷阱：
   * onChange 内同步调用 scheduleSave 时，setState 还没生效，
   * 当前渲染作用域里的值仍是旧的。doSave 直接读 ref 拿最新。
   */
  const titleRef = useRef("");
  const contentRef = useRef("");

  const load = useCallback(async () => {
    if (!noteId || Number.isNaN(noteId)) return;
    try {
      const n = await noteApi.get(noteId);
      setNote(n);
      setTitle(n.title);
      setContent(n.content || "");
      titleRef.current = n.title;
      contentRef.current = n.content || "";
      dirtyRef.current = false;
      setStatus("idle");
    } catch (e) {
      message.error(`加载文档失败: ${e}`);
    }
  }, [noteId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 「新建思维导图」跳过来：直接打开导图并进编辑模式；用完把路由 state 清掉
  useEffect(() => {
    const st = location.state as { openMindMap?: string } | null;
    if (st?.openMindMap === "edit") {
      setMindMapEditDefault(true);
      setMindMapOpen(true);
      navigate(location.pathname + location.search, { replace: true, state: null });
    } else {
      setMindMapEditDefault(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  /** 导图里改了正文 / 标题：按正常编辑处理，标脏并由自动保存落盘 */
  function handleMindMapChange(next: string) {
    contentRef.current = next;
    setContent(next);
    scheduleSave();
  }

  function handleMindMapTitle(next: string) {
    titleRef.current = next;
    setTitle(next);
    scheduleSave();
  }

  /** Tiptap / 源码编辑器统一的正文变更入口 */
  function handleContentChange(markdown: string) {
    if (markdown === contentRef.current) return;
    contentRef.current = markdown;
    setContent(markdown);
    scheduleSave();
  }

  const doSave = useCallback(async () => {
    if (!note || !dirtyRef.current) return;
    setStatus("saving");
    try {
      await noteApi.update(note.id, {
        title: titleRef.current,
        content: contentRef.current,
        folder_id: note.folder_id,
      });
      dirtyRef.current = false;
      setStatus("saved");
      if (savedHideTimerRef.current) {
        window.clearTimeout(savedHideTimerRef.current);
      }
      savedHideTimerRef.current = window.setTimeout(() => {
        setStatus((s) => (s === "saved" ? "idle" : s));
      }, SAVED_TOAST_MS);
    } catch (e) {
      message.error(`保存失败: ${e}`);
      setStatus("idle");
    }
    // 仅依赖 note —— title/content 通过 ref 读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

  function scheduleSave() {
    dirtyRef.current = true;
    setStatus("dirty");
    if (savedHideTimerRef.current) {
      window.clearTimeout(savedHideTimerRef.current);
      savedHideTimerRef.current = null;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void doSave();
    }, AUTOSAVE_DELAY_MS);
  }

  /** 立即落盘 + 通知列表刷新，返回按钮前必须走到 */
  async function flushAndExit() {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (savedHideTimerRef.current) {
      window.clearTimeout(savedHideTimerRef.current);
      savedHideTimerRef.current = null;
    }
    if (dirtyRef.current) {
      await doSave();
    }
    useAppStore.getState().bumpNotesRefresh();
    navigate(-1);
  }

  // 离开页面（如系统返回手势）兜底保存
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (savedHideTimerRef.current)
        window.clearTimeout(savedHideTimerRef.current);
      if (dirtyRef.current) {
        void doSave().then(() => {
          useAppStore.getState().bumpNotesRefresh();
        });
      } else {
        useAppStore.getState().bumpNotesRefresh();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePin() {
    if (!note || pinning) return;
    setPinning(true);
    try {
      const next = await noteApi.togglePin(note.id);
      setNote({ ...note, is_pinned: next });
    } catch (e) {
      message.error(`切换置顶失败: ${e}`);
    } finally {
      setPinning(false);
    }
  }

  if (Number.isNaN(noteId)) {
    return (
      <div className="p-4 text-center text-sm text-[var(--m-ink-3)]">
        文档 ID 无效
      </div>
    );
  }

  const wordCount = content.length;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[var(--m-surface)] text-[var(--m-ink-1)]"
      style={{ paddingBottom: keyboardInset > 0 ? keyboardInset : undefined }}
    >
      {/* 顶栏 */}
      <header
        className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--m-line)] bg-[var(--m-surface)] px-2"
        style={{ marginTop: "env(safe-area-inset-top, 0px)" }}
      >
        <button
          onClick={() => void flushAndExit()}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-[var(--m-ink-2)]" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col items-center leading-tight">
          <span className="truncate text-sm font-semibold text-[var(--m-ink-1)]">
            编辑文档
          </span>
          <SaveBadge status={status} />
        </div>
        <div className="flex">
          <button
            onClick={() => setSourceMode((v) => !v)}
            aria-label={sourceMode ? "切换到富文本" : "切换到源码"}
            className="flex h-10 w-10 items-center justify-center"
          >
            {sourceMode ? (
              <FileText size={20} className="text-[var(--m-ink-2)]" />
            ) : (
              <Code2 size={20} className="text-[var(--m-ink-2)]" />
            )}
          </button>
          <button
            onClick={handlePin}
            aria-label={note?.is_pinned ? "取消置顶" : "置顶"}
            className="flex h-10 w-10 items-center justify-center"
          >
            <Pin
              size={20}
              className={
                note?.is_pinned
                  ? "fill-[var(--m-warning)] text-[var(--m-warning)]"
                  : "text-[var(--m-ink-2)]"
              }
            />
          </button>
        </div>
      </header>

      {/* 编辑区 */}
      <main className="flex-1 overflow-y-auto px-4 py-3">
        <input
          value={title}
          onChange={(e) => {
            const v = e.target.value;
            titleRef.current = v;
            setTitle(v);
            scheduleSave();
          }}
          placeholder="无标题文档"
          className="w-full bg-transparent text-2xl font-bold text-[var(--m-ink-1)] outline-none placeholder:text-[var(--m-ink-3)]"
        />

        <div className="mt-2 mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--m-ink-3)]">
          <span>
            {note ? new Date(note.updated_at).toLocaleDateString("zh-CN") : "—"}
            {" · "}
            {wordCount} 字
          </span>
          {note?.is_hidden && (
            <span className="rounded bg-[var(--m-tint-danger)] px-2 py-0.5 text-[var(--m-danger)]">
              已隐藏
            </span>
          )}
          {note?.is_encrypted && (
            <span className="rounded bg-[var(--m-tint-warning)] px-2 py-0.5 text-[var(--m-warning)]">
              已加密
            </span>
          )}
          {sourceMode && (
            <span className="rounded bg-[var(--m-well)] px-2 py-0.5">
              源码模式
            </span>
          )}
        </div>

        {sourceMode ? (
          <div className="min-h-[calc(100vh-260px)]">
            <MarkdownSourceEditor value={content} onChange={handleContentChange} />
          </div>
        ) : (
          <div className="min-h-[calc(100vh-260px)]">
            {toolbarEl && (
              <TiptapEditor
                content={content}
                onChange={handleContentChange}
                placeholder="在这里写下你的想法..."
                noteId={note?.id}
                showFooterStats={false}
                toolbarSlot={toolbarEl}
              />
            )}
          </div>
        )}
      </main>

      {/* 底部：快捷条 + Tiptap 工具栏 */}
      <footer
        className="shrink-0 border-t border-[var(--m-line)] bg-[var(--m-surface)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div ref={setToolbarEl} className="m-editor-toolbar m-scroll-x" />
        <div className="flex items-center gap-1 px-2 py-1">
          <QuickBarButton
            icon={<Network size={18} />}
            label="导图"
            onClick={() => setMindMapOpen(true)}
          />
          <QuickBarButton
            icon={<Sparkles size={18} />}
            label="AI"
            accent
            onClick={() => navigate("/ai")}
          />
          <span className="ml-auto pr-2 text-[10px] text-[var(--m-ink-3)]">
            {sourceMode ? "Markdown 源码" : "富文本"}
          </span>
        </div>
      </footer>

      {/* 思维导图：PC 是右侧分栏，手机改全屏 */}
      {mindMapOpen && (
        <Suspense fallback={null}>
          <div
            className="fixed inset-0 z-[70] flex flex-col bg-[var(--m-surface)]"
            style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
          >
            <MobileMindMap
              markdown={content}
              title={title}
              onClose={() => setMindMapOpen(false)}
              onMarkdownChange={handleMindMapChange}
              onTitleChange={handleMindMapTitle}
              defaultEditing={mindMapEditDefault}
              editBlockedReason={
                note?.is_encrypted ? "加密文档不能编辑导图，先解锁" : undefined
              }
            />
          </div>
        </Suspense>
      )}
    </div>
  );
}

function QuickBarButton({
  icon,
  label,
  accent = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium active:opacity-70 ${
        accent
          ? "bg-[var(--m-tint-accent)] text-[var(--m-accent)]"
          : "bg-[var(--m-well)] text-[var(--m-ink-2)]"
      }`}
      style={{ minHeight: 40 }}
    >
      {icon}
      {label}
    </button>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  if (status === "saving") {
    return (
      <span className="mt-0.5 text-[10px] text-[var(--m-warning)]">保存中…</span>
    );
  }
  if (status === "saved") {
    return (
      <span className="mt-0.5 text-[10px] text-[var(--m-success)]">
        已保存 · 刚刚
      </span>
    );
  }
  return <span className="mt-0.5 h-3.5 text-[10px]" aria-hidden />;
}
