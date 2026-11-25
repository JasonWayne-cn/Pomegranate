import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Pin,
  PinOff,
  Plus,
  MoreHorizontal,
  Folder as FolderIcon,
  FolderInput,
  Trash2,
  ExternalLink,
  Copy,
  RefreshCw,
  Tag as TagIcon,
} from "lucide-react";
import { message } from "antd";
import { noteApi, folderApi, trashApi, tagApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Folder, Note, NoteTagBrief } from "@/types";
import { relativeTime } from "@/lib/utils";
import { useLongPress } from "@/hooks/useLongPress";
import {
  ActionSheet,
  type ActionSheetItem,
} from "@/components/mobile/ActionSheet";
import { SwipeRow } from "@/components/mobile/SwipeRow";
import { FolderPickerSheet } from "@/components/mobile/FolderPickerSheet";

/**
 * 移动端文档列表。
 *
 * - 目录 chips：全部 / 未分类 / 各级文件夹（含层级缩进）
 * - 分页：page_size=20，滚到底用 IntersectionObserver 续拉
 * - 长按：底部 ActionSheet（打开/置顶/移动/复制链接/删除）
 * - 左滑：置顶 + 删除
 * - 行内展示标签、置顶/日记徽章、字数与相对时间
 */

const PAGE_SIZE = 20;

type Selection =
  | { kind: "all" }
  | { kind: "uncategorized" }
  | { kind: "folder"; id: number };

const TAG_COLOR_HEX: Record<string, string> = {
  blue: "#3b82f6",
  green: "#22c55e",
  orange: "#f97316",
  purple: "#a855f7",
  pink: "#ec4899",
  yellow: "#eab308",
  red: "#ef4444",
  cyan: "#06b6d4",
  slate: "#64748b",
};

function flattenFolders(
  list: Folder[],
  depth = 0,
): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  for (const f of list) {
    out.push({ folder: f, depth });
    if (f.children?.length) out.push(...flattenFolders(f.children, depth + 1));
  }
  return out;
}

export function MobileNotes() {
  const navigate = useNavigate();
  const [notes, setNotes] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [allTotal, setAllTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selection, setSelection] = useState<Selection>({ kind: "all" });
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tagMap, setTagMap] = useState<Map<number, NoteTagBrief[]>>(new Map());

  const [sheetNote, setSheetNote] = useState<Note | null>(null);
  const [moveTarget, setMoveTarget] = useState<Note | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const seqRef = useRef(0);

  const refreshTick = useAppStore((s) => s.notesRefreshTick);
  const foldersRefreshTick = useAppStore((s) => s.foldersRefreshTick);
  const bumpNotesRefresh = useAppStore((s) => s.bumpNotesRefresh);

  const loadPage = useCallback(
    async (pageToLoad: number, replace: boolean) => {
      const seq = ++seqRef.current;
      loadingRef.current = true;
      if (replace) setLoading(true);
      else setLoadingMore(true);
      try {
        const res = await noteApi.list({
          page: pageToLoad,
          page_size: PAGE_SIZE,
          folder_id: selection.kind === "folder" ? selection.id : undefined,
          uncategorized: selection.kind === "uncategorized" || undefined,
          include_external_docs: true,
          include_descendants: true,
        });
        if (seq !== seqRef.current) return;
        const items = res.items ?? [];
        setTotal(res.total ?? 0);
        setPage(pageToLoad);
        setNotes((prev) => {
          if (replace) return items;
          const seen = new Set(prev.map((n) => n.id));
          return [...prev, ...items.filter((n) => !seen.has(n.id))];
        });

        const ids = items.map((n) => n.id);
        if (ids.length > 0) {
          const map = await tagApi
            .getForNotes(ids)
            .catch(() => ({}) as Record<number, NoteTagBrief[]>);
          if (seq !== seqRef.current) return;
          setTagMap((prev) => {
            const next = replace
              ? new Map<number, NoteTagBrief[]>()
              : new Map(prev);
            for (const [k, v] of Object.entries(map)) {
              next.set(Number(k), v);
            }
            return next;
          });
        } else if (replace) {
          setTagMap(new Map());
        }
      } catch (e) {
        if (seq === seqRef.current) {
          message.error(`加载文档失败: ${e}`);
        }
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setLoadingMore(false);
          loadingRef.current = false;
        }
      }
    },
    [selection],
  );

  const loadAllTotal = useCallback(async () => {
    try {
      const res = await noteApi.list({ page: 1, page_size: 1 });
      setAllTotal(res.total ?? 0);
    } catch {
      /* 目录 chips 的计数失败不阻塞列表 */
    }
  }, []);

  const loadFolders = useCallback(async () => {
    try {
      setFolders(await folderApi.list());
    } catch {
      /* 目录树失败时保留"全部/未分类" */
    }
  }, []);

  // 目录切换 / 刷新 tick：重置分页并重拉
  useEffect(() => {
    void loadPage(1, true);
  }, [loadPage, refreshTick]);

  useEffect(() => {
    void loadAllTotal();
    void loadFolders();
  }, [loadAllTotal, loadFolders, refreshTick, foldersRefreshTick]);

  // 滚到底续拉
  const hasMore = notes.length < total;
  useEffect(() => {
    if (!hasMore || loading || loadingMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || loadingRef.current) return;
        void loadPage(page + 1, false);
      },
      { rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, page, loadPage]);

  const flatFolders = useMemo(() => flattenFolders(folders), [folders]);
  const pinned = notes.filter((n) => n.is_pinned);
  const others = notes.filter((n) => !n.is_pinned);

  function select(next: Selection) {
    setSelection(next);
    setNotes([]);
    setTotal(0);
    setPage(1);
  }

  async function togglePin(note: Note) {
    try {
      await noteApi.togglePin(note.id);
      setNotes((prev) =>
        prev.map((n) =>
          n.id === note.id ? { ...n, is_pinned: !n.is_pinned } : n,
        ),
      );
      message.success(note.is_pinned ? "已取消置顶" : "已置顶");
    } catch (e) {
      message.error(`操作失败: ${e}`);
    }
  }

  async function moveNote(folderId: number | null) {
    if (!moveTarget) return;
    try {
      await noteApi.moveToFolder(moveTarget.id, folderId);
      message.success("已移动");
      useAppStore.getState().bumpFoldersRefresh();
      bumpNotesRefresh();
      void loadPage(1, true);
      void loadAllTotal();
      void loadFolders();
    } catch (e) {
      message.error(`移动失败: ${e}`);
    } finally {
      setMoveTarget(null);
    }
  }

  async function trashNote(note: Note) {
    try {
      await trashApi.softDelete(note.id);
      message.success("已移到回收站");
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      setTotal((t) => Math.max(0, t - 1));
      setAllTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  function copyWikiLink(note: Note) {
    navigator.clipboard
      .writeText(`[[${note.title}]]`)
      .then(() => message.success("已复制 wiki 链接"))
      .catch((e) => message.error(`复制失败: ${e}`));
  }

  const sheetItems: ActionSheetItem[] = sheetNote
    ? [
        {
          key: "open",
          label: "打开",
          icon: <ExternalLink size={18} />,
          onClick: () => navigate(`/notes/${sheetNote.id}`),
        },
        {
          key: "pin",
          label: sheetNote.is_pinned ? "取消置顶" : "置顶",
          icon: sheetNote.is_pinned ? <PinOff size={18} /> : <Pin size={18} />,
          onClick: () => void togglePin(sheetNote),
        },
        {
          key: "move",
          label: "移动到目录",
          icon: <FolderInput size={18} />,
          onClick: () => setMoveTarget(sheetNote),
        },
        {
          key: "copy",
          label: "复制 wiki 链接",
          icon: <Copy size={18} />,
          onClick: () => copyWikiLink(sheetNote),
        },
        {
          key: "trash",
          label: "移到回收站",
          icon: <Trash2 size={18} />,
          danger: true,
          onClick: () => void trashNote(sheetNote),
        },
      ]
    : [];

  const menuItems: ActionSheetItem[] = [
    {
      key: "refresh",
      label: "刷新列表",
      icon: <RefreshCw size={18} />,
      onClick: () => {
        void loadPage(1, true);
        void loadAllTotal();
        void loadFolders();
      },
    },
    {
      key: "new",
      label: "新建文档",
      icon: <Plus size={18} />,
      onClick: () => navigate("/quick-create"),
    },
    {
      key: "tags",
      label: "标签管理",
      icon: <TagIcon size={18} />,
      onClick: () => navigate("/tags"),
    },
  ];

  return (
    <div className="text-[var(--m-ink-1)]">
      {/* 顶栏 */}
      <div className="bg-[var(--m-surface)] px-4 pt-3 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[var(--m-ink-1)]">文档</h1>
            <div className="mt-0.5 text-xs text-[var(--m-ink-3)]">
              共 {total} 篇
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => navigate("/search")}
              aria-label="搜索"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--m-well)] active:opacity-70"
            >
              <Search size={18} className="text-[var(--m-ink-2)]" />
            </button>
            <button
              onClick={() => setMenuOpen(true)}
              aria-label="更多"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--m-well)] active:opacity-70"
            >
              <MoreHorizontal size={18} className="text-[var(--m-ink-2)]" />
            </button>
          </div>
        </div>

        {/* 目录 chips */}
        <div className="m-scroll-x mt-3 flex gap-2 -mx-4 px-4 pb-1">
          <Chip
            active={selection.kind === "all"}
            onClick={() => select({ kind: "all" })}
          >
            全部 {allTotal}
          </Chip>
          <Chip
            active={selection.kind === "uncategorized"}
            onClick={() => select({ kind: "uncategorized" })}
          >
            未分类
          </Chip>
          {flatFolders.map(({ folder, depth }) => (
            <Chip
              key={folder.id}
              active={
                selection.kind === "folder" && selection.id === folder.id
              }
              onClick={() => select({ kind: "folder", id: folder.id })}
            >
              {depth > 0 ? "· " : ""}
              {folder.name}
              {folder.note_count > 0 ? ` ${folder.note_count}` : ""}
            </Chip>
          ))}
        </div>
      </div>

      {/* 列表 */}
      <div className="bg-[var(--m-page)] pb-24">
        {loading && notes.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--m-ink-3)]">
            加载中...
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-[var(--m-ink-3)]">
            <FolderIcon size={40} className="text-[var(--m-ink-3)]" />
            <span className="text-sm">
              {selection.kind === "all" ? "还没有文档" : "这个目录下没有文档"}
            </span>
            <span className="text-xs text-[var(--m-ink-3)]">
              点右下 + 按钮新建第一篇
            </span>
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <SectionLabel icon={<Pin size={12} />} text="置顶" />
                {pinned.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    tags={tagMap.get(note.id) ?? []}
                    onOpen={() => navigate(`/notes/${note.id}`)}
                    onLongPress={() => setSheetNote(note)}
                    onPin={() => void togglePin(note)}
                    onTrash={() => void trashNote(note)}
                  />
                ))}
              </>
            )}

            {others.length > 0 && (
              <>
                <SectionLabel text="最近" />
                {others.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    tags={tagMap.get(note.id) ?? []}
                    onOpen={() => navigate(`/notes/${note.id}`)}
                    onLongPress={() => setSheetNote(note)}
                    onPin={() => void togglePin(note)}
                    onTrash={() => void trashNote(note)}
                  />
                ))}
              </>
            )}

            <div ref={sentinelRef} className="h-8" />
            {loadingMore && (
              <div className="pb-4 text-center text-xs text-[var(--m-ink-3)]">
                加载更多…
              </div>
            )}
            {!hasMore && notes.length > 0 && (
              <div className="pb-4 text-center text-[11px] text-[var(--m-ink-3)]">
                已经到底了
              </div>
            )}
          </>
        )}
      </div>

      <ActionSheet
        open={!!sheetNote}
        title={sheetNote?.title || "未命名文档"}
        items={sheetItems}
        onClose={() => setSheetNote(null)}
      />

      <ActionSheet
        open={menuOpen}
        title="文档操作"
        items={menuItems}
        onClose={() => setMenuOpen(false)}
      />

      <FolderPickerSheet
        open={!!moveTarget}
        currentFolderId={moveTarget?.folder_id ?? null}
        onClose={() => setMoveTarget(null)}
        onPick={moveNote}
      />
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
        active
          ? "bg-[var(--m-primary)] text-[var(--m-on-primary)]"
          : "bg-[var(--m-well)] text-[var(--m-ink-2)]"
      }`}
    >
      {children}
    </button>
  );
}

function SectionLabel({
  text,
  icon,
}: {
  text: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 px-4 pt-3 pb-1 text-xs font-medium text-[var(--m-ink-3)]">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function NoteRow({
  note,
  tags,
  onOpen,
  onLongPress,
  onPin,
  onTrash,
}: {
  note: Note;
  tags: NoteTagBrief[];
  onOpen: () => void;
  onLongPress: () => void;
  onPin: () => void;
  onTrash: () => void;
}) {
  // 长按后紧接的 click 要吞掉，避免「长按弹面板 → 手抬起又进详情」
  const firedRef = useRef(false);
  const lp = useLongPress(
    () => {
      firedRef.current = true;
      onLongPress();
    },
    { delay: 500 },
  );

  const preview = (note.content || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return (
    <div className="mb-2 px-4">
      <SwipeRow
        actions={[
          {
            key: "pin",
            label: note.is_pinned ? "取消置顶" : "置顶",
            icon: note.is_pinned ? <PinOff size={18} /> : <Pin size={18} />,
            tone: "primary",
            onAction: onPin,
          },
          {
            key: "trash",
            label: "删除",
            icon: <Trash2 size={18} />,
            tone: "danger",
            onAction: onTrash,
          },
        ]}
      >
        <div
          {...lp}
          onTouchStart={() => {
            firedRef.current = false;
          }}
          onClick={() => {
            if (firedRef.current) {
              firedRef.current = false;
              return;
            }
            onOpen();
          }}
          className="block w-full rounded-2xl bg-[var(--m-surface)] p-4 text-left active:opacity-80 transition-opacity"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="flex-1 truncate text-base font-semibold text-[var(--m-ink-1)]">
              {note.title || "未命名文档"}
            </h3>
            {note.is_pinned && (
              <Pin size={14} className="mt-1 shrink-0 text-[var(--m-warning)]" />
            )}
          </div>
          {preview && (
            <p className="mt-1 line-clamp-2 text-sm text-[var(--m-ink-2)]">
              {preview}
            </p>
          )}
          {tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tags.slice(0, 4).map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--m-well)] px-2 py-0.5 text-[10px] text-[var(--m-ink-2)]"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background: TAG_COLOR_HEX[t.color ?? ""] ?? "var(--m-ink-3)",
                    }}
                  />
                  {t.name}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 text-xs text-[var(--m-ink-3)]">
            {note.is_daily && (
              <span className="rounded bg-[var(--m-tint-primary)] px-1.5 py-0.5 text-[10px] text-[var(--m-primary)]">
                日记
              </span>
            )}
            {note.word_count > 0 && <span>{note.word_count} 字</span>}
            <span className="ml-auto">{relativeTime(note.updated_at)}</span>
          </div>
        </div>
      </SwipeRow>
    </div>
  );
}
