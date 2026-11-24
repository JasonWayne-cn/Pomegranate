import { useState, useEffect, useMemo, useCallback, useRef, startTransition, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Table,
  Button,
  Input,
  Checkbox,
  Space,
  Typography,
  message,
  Modal,
  Popconfirm,
  Tooltip,
  Card,
  Row,
  Col,
  Segmented,
  Tag,
  Timeline,
  Popover,
  Tree,
  Divider,
  Pagination,
  Dropdown,
  theme as antdTheme,
} from "antd";
import {
  Search,
  Trash2,
  Archive,
  Edit3,
  Share,
  LayoutList,
  LayoutGrid,
  Clock,
  Pin,
  PinOff,
  RefreshCw,
  Calendar,
  Folder as FolderIcon,
  GitBranch,
  CornerUpLeft,
  Filter as FilterIcon,
  Bot,
  ChevronDown,
  ExternalLink,
  Copy,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColumnsType } from "antd/es/table";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  noteApi,
  exportApi,
  folderApi,
  tagApi,
  trashApi,
  moduleConfigApi,
  llmGraphApi,
  mountApi,
} from "@/lib/api";
import { MODULE_CONFIG_CHANGED_EVENT } from "@/modules/types";
import { MicButton } from "@/components/MicButton";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTabsStore } from "@/store/tabs";
import { useAppStore } from "@/store";
import { stripHtml, relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { FolderCreateButton } from "@/components/FolderCreateButton";
import { NewNoteButton } from "@/components/NewNoteButton";
import { createBlankAndOpen } from "@/lib/noteCreator";
import { startAiChatWithNotes } from "@/lib/aiAttach";
import { officePathForSource } from "@/lib/office/formats";
import { FileTypeIcon } from "@/components/FileTypeIcon";
// AntD 已有 Tag 组件同名，这里给类型起个别名避免冲突
import type {
  Note,
  PageResult,
  Folder,
  LlmGraphScopeStatus,
  Tag as NoteTag,
} from "@/types";

const { Title, Text, Paragraph } = Typography;

/**
 * 菜单项动作延迟到下拉关闭动画结束后再执行。
 *
 * 原生保存对话框会暂停 WebView 合成动画；若在菜单 leave 动画结束前同步打开，
 * rc-motion 收不到 animationend，菜单会永久卡在 pointer-events:none 的关闭态，
 * 之后点任何菜单项都没反应。
 */
function runAfterMenuClose(fn: () => void) {
  setTimeout(fn, 250);
}

type ViewMode = "list" | "card" | "timeline";

/**
 * 自定义排序模式下用的 antd Table 行：把每个 <tr> 包成 @dnd-kit/sortable 节点。
 * 通过 antd Table `components.body.row` 注入。activationConstraint 由父级 PointerSensor
 * 控制，避免 click 误触发拖拽（保证 checkbox / 行 click 仍能正常用）。
 */
function SortableTableRow(
  props: React.HTMLAttributes<HTMLTableRowElement> & {
    "data-row-key"?: string | number;
  },
) {
  const id = String(props["data-row-key"] ?? "");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: React.CSSProperties = {
    ...props.style,
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: "grab",
    ...(isDragging
      ? { position: "relative" as const, zIndex: 999, opacity: 0.7 }
      : {}),
  };
  return (
    <tr {...props} ref={setNodeRef} style={style} {...attributes} {...listeners} />
  );
}

/** 在文件夹树中按 id 查找节点 */
function findFolderNode(list: Folder[], id: number): Folder | null {
  for (const f of list) {
    if (f.id === id) return f;
    if (f.children.length) {
      const found = findFolderNode(f.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** 将文档按日期分组 */
function groupByDate(notes: Note[]): Map<string, Note[]> {
  const map = new Map<string, Note[]>();
  for (const note of notes) {
    const date = note.updated_at.slice(0, 10);
    if (!map.has(date)) map.set(date, []);
    map.get(date)!.push(note);
  }
  return map;
}

/** 格式化日期标签 */
function formatDateLabel(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === today) return "今天";
  if (dateStr === yesterday) return "昨天";
  return dateStr;
}

/** 文档标签装饰（React.memo 避免重渲染） */
const NoteDecorators = ({ note, warningColor }: { note: Note; warningColor: string }) => (
  <span className="inline-flex items-center gap-1 ml-1">
    {note.is_pinned && <Pin size={11} style={{ color: warningColor }} />}
    {note.is_daily && (
      <Tag color="blue" style={{ fontSize: 10, lineHeight: "14px", padding: "0 3px", margin: 0 }}>
        日记
      </Tag>
    )}
  </span>
);

/** 把 Folder[] 映射为 antd Tree 的节点结构（key = folder id） */
type FolderTreeNode = {
  key: number;
  title: ReactNode;
  children?: FolderTreeNode[];
};
function foldersToAntTree(folders: Folder[]): FolderTreeNode[] {
  return folders.map((f) => ({
    key: f.id,
    title: (
      <span className="inline-flex items-center gap-1.5" style={{ fontSize: 13 }}>
        <FolderIcon size={13} style={{ opacity: 0.6 }} />
        {f.name}
      </span>
    ),
    children: f.children?.length ? foldersToAntTree(f.children) : undefined,
  }));
}
function collectAllFolderKeys(nodes: FolderTreeNode[]): number[] {
  const out: number[] = [];
  for (const n of nodes) {
    out.push(n.key);
    if (n.children?.length) out.push(...collectAllFolderKeys(n.children));
  }
  return out;
}

/** 批量移动按钮：Popover 里用 Tree 选目标文件夹（含"移到根目录"快捷项）
 *  onMove 由父组件提供：负责调后端 + 清 selection + 刷新列表 */
function BatchMoveButton({
  folders,
  open,
  onOpenChange,
  onMove,
}: {
  folders: Folder[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onMove: (folderId: number | null) => void | Promise<void>;
}) {
  const treeData = useMemo(() => foldersToAntTree(folders), [folders]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  useEffect(() => {
    if (open) setExpandedKeys(collectAllFolderKeys(treeData));
  }, [open, treeData]);

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={onOpenChange}
      placement="bottomLeft"
      destroyOnHidden
      content={
        <div style={{ width: 260 }}>
          <div
            style={{
              maxHeight: 280,
              overflowY: "auto",
              margin: "0 -4px",
              padding: "0 4px",
            }}
          >
            {treeData.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "16px 8px",
                  fontSize: 12,
                  opacity: 0.6,
                }}
              >
                还没有文件夹
              </div>
            ) : (
              <Tree
                blockNode
                treeData={treeData}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                onSelect={(keys) => {
                  if (keys.length > 0) {
                    void onMove(keys[0] as number);
                  }
                }}
              />
            )}
          </div>
          <Divider style={{ margin: "8px 0" }} />
          <Button
            size="small"
            type="text"
            block
            icon={<CornerUpLeft size={13} />}
            onClick={() => void onMove(null)}
            style={{ textAlign: "left", justifyContent: "flex-start" }}
          >
            移到根目录
          </Button>
        </div>
      }
    >
      <Button size="small" type="primary">
        移动到…
      </Button>
    </Popover>
  );
}

/** 批量打标签按钮：Popover 里多选标签，确认后追加到所有选中文档（不清除原有）
 *  onDone 由父组件注入：调 API + 清 selection + 刷新 */
function BatchTagButton({
  noteIds,
  onDone,
}: {
  noteIds: number[];
  onDone: (tagIds: number[]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [allTags, setAllTags] = useState<NoteTag[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [filter, setFilter] = useState("");

  // 每次打开时拉一次最新标签，并重置选择
  useEffect(() => {
    if (!open) return;
    setPicked([]);
    setFilter("");
    tagApi
      .list()
      .then(setAllTags)
      .catch((e) => message.error(`加载标签失败: ${e}`));
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allTags;
    return allTags.filter((t) => t.name.toLowerCase().includes(q));
  }, [allTags, filter]);

  function toggle(id: number) {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function confirm() {
    if (picked.length === 0) {
      message.info("请选择要添加的标签");
      return;
    }
    await onDone(picked);
    setOpen(false);
  }

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
      destroyOnHidden
      content={
        <div style={{ width: 260 }}>
          <Input
            size="small"
            placeholder="筛选标签..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            allowClear
            style={{ marginBottom: 6 }}
          />
          <div
            style={{
              maxHeight: 220,
              overflowY: "auto",
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              padding: "2px 0",
            }}
          >
            {filtered.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "12px 8px",
                  fontSize: 12,
                  opacity: 0.6,
                  width: "100%",
                }}
              >
                {allTags.length === 0 ? "还没有标签" : "无匹配"}
              </div>
            ) : (
              filtered.map((tag) => {
                const active = picked.includes(tag.id);
                return (
                  <Tag
                    key={tag.id}
                    color={active ? tag.color || "blue" : undefined}
                    onClick={() => toggle(tag.id)}
                    style={{
                      cursor: "pointer",
                      padding: "2px 10px",
                      fontSize: 13,
                      fontWeight: active ? 600 : undefined,
                      opacity: active ? 1 : 0.75,
                    }}
                  >
                    {tag.name}
                  </Tag>
                );
              })
            )}
          </div>
          <Divider style={{ margin: "8px 0" }} />
          <div className="flex justify-between items-center">
            <span style={{ fontSize: 11, opacity: 0.6 }}>
              已选 {picked.length} 个 · 将应用到 {noteIds.length} 篇
            </span>
            <Space size={4}>
              <Button size="small" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                size="small"
                type="primary"
                disabled={picked.length === 0}
                onClick={confirm}
              >
                添加
              </Button>
            </Space>
          </div>
        </div>
      }
    >
      <Button size="small">打标签…</Button>
    </Popover>
  );
}

/** 文档列表"目录"列的单元格：
 *  - 展示当前文件夹名或"—"（无目录）
 *  - 点击 → Popover 里 Tree 选择新文件夹 → 调 moveToFolder → 刷新列表
 *  - 保留"筛选此文件夹"快捷入口（原表格里的跳转语义） */
function FolderChangeCell({
  noteId,
  currentFolderId,
  folders,
  folderMap,
  onChanged,
  onFilterClick,
}: {
  noteId: number;
  currentFolderId: number | null;
  folders: Folder[];
  folderMap: Map<number, string>;
  onChanged: () => void;
  onFilterClick: (folderId: number) => void;
}) {
  const { token } = antdTheme.useToken();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const treeData = useMemo(() => foldersToAntTree(folders), [folders]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  useEffect(() => {
    if (open) setExpandedKeys(collectAllFolderKeys(treeData));
  }, [open, treeData]);

  async function applyMove(folderId: number | null) {
    if (folderId === currentFolderId) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await noteApi.moveToFolder(noteId, folderId);
      useAppStore.getState().bumpFoldersRefresh();
      // 同时刷新侧边栏 NotesPanel 的「未分类」/ 目标文件夹文档列表
      useAppStore.getState().bumpNotesRefresh();
      onChanged();
      setOpen(false);
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  const currentName =
    currentFolderId != null ? folderMap.get(currentFolderId) ?? null : null;

  const popoverContent = (
    <div style={{ width: 240 }}>
      <div
        style={{
          fontSize: 11,
          color: token.colorTextTertiary,
          padding: "2px 4px 6px",
          letterSpacing: 0.3,
        }}
      >
        移动到
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto", margin: "0 -4px", padding: "0 4px" }}>
        {treeData.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "12px 8px",
              color: token.colorTextTertiary,
              fontSize: 12,
            }}
          >
            还没有文件夹
          </div>
        ) : (
          <Tree
            blockNode
            treeData={treeData}
            selectedKeys={currentFolderId != null ? [currentFolderId] : []}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpandedKeys(keys)}
            onSelect={(keys) => {
              if (keys.length > 0) applyMove(keys[0] as number);
            }}
            disabled={saving}
          />
        )}
      </div>
      <Divider style={{ margin: "8px 0" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Button
          size="small"
          type="text"
          block
          disabled={currentFolderId == null || saving}
          icon={<CornerUpLeft size={13} />}
          onClick={() => applyMove(null)}
          style={{ textAlign: "left", justifyContent: "flex-start" }}
        >
          移到根目录
        </Button>
        {currentFolderId != null && (
          <Button
            size="small"
            type="text"
            block
            icon={<FilterIcon size={13} />}
            onClick={() => {
              onFilterClick(currentFolderId);
              setOpen(false);
            }}
            style={{ textAlign: "left", justifyContent: "flex-start" }}
          >
            筛选此文件夹下的文档
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
      destroyOnHidden
      content={popoverContent}
    >
      {currentName ? (
        <a style={{ fontSize: 12 }} onClick={(e) => e.preventDefault()}>
          {currentName}
        </a>
      ) : (
        <span
          style={{ fontSize: 12, color: token.colorTextTertiary, cursor: "pointer" }}
        >
          —
        </span>
      )}
    </Popover>
  );
}

/** 桌面版原 NoteListPage（保留全部 1300+ 行实现） */
function DesktopNoteListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { token } = antdTheme.useToken();

  /** 外部 PDF/Word/Excel 进 Office 工作台；普通文档进编辑器。 */
  function openNoteOrOffice(note: Pick<Note, "id" | "source_file_path">) {
    navigate(officePathForSource(note.source_file_path) ?? `/notes/${note.id}`);
  }

  const [data, setData] = useState<PageResult<Note>>({
    items: [],
    total: 0,
    page: 1,
    page_size: 12,
  });
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState(searchParams.get("keyword") || "");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  /** 列表视图每页条数：持久化在 store（默认 30，上限 100） */
  const listPageSize = useAppStore((s) => s.notesPageSize);
  const setListPageSize = useAppStore((s) => s.setNotesPageSize);
  /** 列表排序模式（仅 list 视图生效）。"custom" 才启用拖拽排序 */
  const [sortBy, setSortBy] = useState<"default" | "custom" | "created" | "title">(
    "default",
  );
  /** 文档页搜索：是否同时检索正文（默认仅标题，偏好持久化） */
  const [searchContent, setSearchContent] = useState<boolean>(() => {
    try {
      return localStorage.getItem("notes.searchContent") === "1";
    } catch {
      return false;
    }
  });
  /** 文档页搜索：是否递归子文件夹（默认否，保持"只列直属"；偏好持久化） */
  const [searchRecursive, setSearchRecursive] = useState<boolean>(() => {
    try {
      return localStorage.getItem("notes.searchRecursive") === "1";
    } catch {
      return false;
    }
  });
  /** 列表视图下选中的文档 id，切换到其他视图/翻页自动清空 */
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  /** 导出全部为 ZIP 的进行中状态 */
  const [exportingZip, setExportingZip] = useState(false);
  /** 批量移动 Popover 的开关 */
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);

  const folderId = searchParams.get("folder");

  /** 当前真实文件夹 id（未分类 / 全库都视为 null，对应全库图谱范围） */
  const graphFolderId = useMemo<number | null>(() => {
    if (!folderId || folderId === "uncategorized") return null;
    const id = Number(folderId);
    return Number.isFinite(id) ? id : null;
  }, [folderId]);

  /** 当前作用域的建图状态：全建图 / 部分建图 / 未建图 / 有更新 */
  const [graphStatus, setGraphStatus] = useState<LlmGraphScopeStatus | null>(null);

  // 文件夹 id → name 映射（用于显示目录列）
  const [folderMap, setFolderMap] = useState<Map<number, string>>(new Map());
  // 原始文件夹树，供"目录"列的 Popover 选择器用
  const [folders, setFolders] = useState<Folder[]>([]);

  /** 外部挂载（同步文件夹）下的文件夹 id 集合：用于区分同步文档 */
  const syncedFolderIds = useMemo(() => {
    const ids = new Set<number>();
    const walk = (list: Folder[]) => {
      for (const f of list) {
        if (f.mount_id) ids.add(f.id);
        if (f.children?.length) walk(f.children);
      }
    };
    walk(folders);
    return ids;
  }, [folders]);

  /** 当前选中的文件夹名；null 表示"全库"（未选文件夹） */
  const selectedFolderName = useMemo(() => {
    if (!folderId) return null;
    if (folderId === "uncategorized") return "未分类";
    const fid = Number(folderId);
    return Number.isFinite(fid) ? folderMap.get(fid) ?? "文件夹" : "文件夹";
  }, [folderId, folderMap]);

  /** 退出文件夹选中，回到全库（保留其它查询参数，如关键字） */
  const exitFolderSelection = useCallback(() => {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        sp.delete("folder");
        return sp;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  /**
   * 当前目录的子文件夹。
   *
   * 点击文档目录树后，主区只列该目录的直属文档；子文件夹以入口按钮展示，
   * 不把子孙文件夹里的文档平铺进来。
   */
  const childFolders = useMemo(() => {
    if (!folderId || folderId === "uncategorized") return [];
    const id = Number(folderId);
    if (!Number.isFinite(id)) return [];
    return findFolderNode(folders, id)?.children ?? [];
  }, [folders, folderId]);

  /** 当前目录的父目录 id（顶层目录为 null） */
  const parentFolderId = useMemo(() => {
    if (!folderId || folderId === "uncategorized") return null;
    const id = Number(folderId);
    if (!Number.isFinite(id)) return null;
    return findFolderNode(folders, id)?.parent_id ?? null;
  }, [folders, folderId]);

  /** 父目录名称（用于「返回上级」按钮文案） */
  const parentFolderName =
    parentFolderId != null ? folderMap.get(parentFolderId) ?? null : null;

  /** 返回上级目录（保留关键字等其它查询参数） */
  const goToParentFolder = useCallback(() => {
    if (parentFolderId == null) return;
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        sp.set("folder", String(parentFolderId));
        return sp;
      },
      { replace: true },
    );
  }, [parentFolderId, setSearchParams]);

  // 依赖全局 foldersRefreshTick：Sidebar 新建/改名/删文件夹后自动重建 id→name 映射
  const foldersRefreshTick = useAppStore((s) => s.foldersRefreshTick);
  useEffect(() => {
    folderApi.list().then((list) => {
      setFolders(list);
      const map = new Map<number, string>();
      function flatten(flist: Folder[]) {
        for (const f of flist) {
          map.set(f.id, f.name);
          if (f.children?.length) flatten(f.children);
        }
      }
      flatten(list);
      setFolderMap(map);
    });
  }, [foldersRefreshTick]);

  useEffect(() => {
    loadNotes(1);
  }, [folderId]);

  // sortBy 切换时重新拉取（排序由后端决定）
  useEffect(() => {
    loadNotes(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortBy]);

  // 搜索模式（正文检索 / 含子文件夹）变化时，若已有搜索词则立即重搜
  useEffect(() => {
    if (keyword.trim()) loadNotes(1, keyword);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchContent, searchRecursive]);

  // 模块设置中心：读取「文档 → 默认排序」，并在抽屉保存后即时应用。
  // 读取失败或值不合法时保持页面默认排序，不打断列表加载。
  useEffect(() => {
    let alive = true;
    const SORT_VALUES = ["default", "custom", "created", "title"] as const;

    async function applyDefaultSort() {
      try {
        const stored = await moduleConfigApi.getMany(["module.notes.default_sort"]);
        const value = stored["module.notes.default_sort"];
        if (alive && value && (SORT_VALUES as readonly string[]).includes(value)) {
          setSortBy(value as (typeof SORT_VALUES)[number]);
        }
      } catch {
        // 配置读取失败时静默保留当前排序
      }
    }

    void applyDefaultSort();
    const onConfigChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: string }>).detail;
      if (detail?.view === "notes") void applyDefaultSort();
    };
    window.addEventListener(MODULE_CONFIG_CHANGED_EVENT, onConfigChanged);

    return () => {
      alive = false;
      window.removeEventListener(MODULE_CONFIG_CHANGED_EVENT, onConfigChanged);
    };
  }, []);

  // 监听全局"刷新"触发器：任何创建/导入流程完成后都会 bump，触发列表重拉
  const notesRefreshTick = useAppStore((s) => s.notesRefreshTick);
  useEffect(() => {
    if (notesRefreshTick > 0) loadNotes(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesRefreshTick]);

  // 建图状态：随当前文件夹与列表/文件夹刷新而变化
  useEffect(() => {
    let cancelled = false;
    llmGraphApi
      .getScopeStatus(graphFolderId)
      .then((s) => {
        if (!cancelled) setGraphStatus(s);
      })
      .catch(() => {
        if (!cancelled) setGraphStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [graphFolderId, notesRefreshTick, foldersRefreshTick]);

  useEffect(() => {
    const kw = searchParams.get("keyword");
    if (kw) {
      setKeyword(kw);
      loadNotes(1, kw);
    }
  }, [searchParams]);

  const loadNotes = useCallback(
    async (page: number, kw?: string, pageSizeOverride?: number) => {
      setLoading(true);
      try {
        const isUncategorized = folderId === "uncategorized";
        const result = await noteApi.list({
          page,
          page_size:
            viewMode === "timeline"
              ? 50
              : (pageSizeOverride ?? listPageSize),
          keyword: (kw ?? keyword) || undefined,
          // folder=uncategorized 是常驻"未分类"虚拟文件夹（folder_id IS NULL）
          folder_id: isUncategorized
            ? undefined
            : folderId
              ? Number(folderId)
              : undefined,
          uncategorized: isUncategorized || undefined,
          // 选中目录时默认只列直属文档；勾选「含子文件夹」才递归子孙目录。
          include_descendants:
            !isUncategorized && folderId ? searchRecursive : undefined,
          // 只 list 视图才让用户切换 sort_by；卡片/时间线沿用默认
          sort_by: viewMode === "list" ? sortBy : undefined,
          // 与左侧文档树一致：显示挂载目录里的 PDF/Word/Excel
          include_external_docs: true,
          // 默认仅标题检索；勾选「正文检索」时标题 + 正文（复用中文加权匹配）
          search_content: searchContent,
        });
        setData(result);
      } catch (e) {
        message.error(String(e));
      } finally {
        setLoading(false);
      }
    },
    [viewMode, keyword, folderId, listPageSize, sortBy, searchContent, searchRecursive],
  );

  /** 导出全部笔记为单个 ZIP（保留文件夹层级，含图片 / 附件资源） */
  async function handleExportAllZip() {
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const target = await save({
        defaultPath: `知识库导出_${stamp}.zip`,
        filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
      });
      if (!target) return;
      setExportingZip(true);
      const r = await exportApi.exportNotesZip(target, null, true);
      if (r.exported > 0) {
        message.success(
          `已导出 ${r.exported} 篇文档${r.assetsCopied > 0 ? `，资源 ${r.assetsCopied} 个` : ""}`,
        );
      } else {
        message.info("没有可导出的文档");
      }
      if (r.errors.length > 0) {
        message.warning(`${r.errors.length} 篇导出失败`);
      }
    } catch (e) {
      message.error(`导出失败: ${e}`);
    } finally {
      setExportingZip(false);
    }
  }

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await noteApi.delete(id);
        useTabsStore.getState().closeTab(id);
        message.success("删除成功");
        useAppStore.getState().bumpNotesRefresh();
        loadNotes(data.page);
      } catch (e) {
        message.error(String(e));
      }
    },
    [data.page, loadNotes],
  );

  /** 同步文档：按原文件强制重新抽取，覆盖影子文档的本地编辑 */
  const handleRefreshSynced = useCallback(
    async (record: Note) => {
      const hide = message.loading("正在按原文件刷新…", 0);
      try {
        const result = await mountApi.reextract(record.id);
        hide();
        if (result.missing) {
          message.warning("原文件已不存在，保留了现有影子文档");
        } else if (result.status === "failed") {
          message.warning(
            `已刷新索引，但内容抽取失败：${result.error ?? "未知错误"}`,
          );
        } else {
          message.success("已按原文件强制刷新");
        }
        // 编辑器里若打开着旧内容，关闭后由用户重新进入，避免旧内容覆盖新索引
        useTabsStore.getState().closeTab(record.id);
        useAppStore.getState().bumpNotesRefresh();
        loadNotes(data.page);
      } catch (e) {
        hide();
        message.error(`刷新失败：${e}`);
      }
    },
    [data.page, loadNotes],
  );

  const handleExport = useCallback(async (record: Note) => {
    const parentDir = await openDialog({
      directory: true,
      title: "选择导出目录",
    });
    if (!parentDir) return;
    try {
      const result = await exportApi.exportSingle(record.id, parentDir as string);
      Modal.success({
        title: "导出成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {result.assets_copied > 0
                ? `已导出 .md 与 ${result.assets_copied} 个资产文件，目录：`
                : "已导出 .md，目录："}
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.root_dir}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.root_dir).catch(() => {}),
        closable: true,
      });
    } catch (e) {
      message.error(`导出失败: ${e}`);
    }
  }, []);

  /** 批量导出：循环调单条 export，每篇文档会在父目录下生成 `{标题}/` 子目录 */
  const handleExportBatch = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    const parentDir = await openDialog({
      directory: true,
      title: `选择导出目录（共 ${ids.length} 篇）`,
    });
    if (!parentDir) return;
    const hide = message.loading(`正在导出 ${ids.length} 篇…`, 0);
    let success = 0;
    let totalAssets = 0;
    const failed: number[] = [];
    for (const id of ids) {
      try {
        const result = await exportApi.exportSingle(id, parentDir as string);
        success += 1;
        totalAssets += result.assets_copied;
      } catch (e) {
        failed.push(id);
        console.warn(`[export] 文档 ${id} 导出失败:`, e);
      }
    }
    hide();
    Modal.success({
      title: failed.length === 0 ? "导出完成" : "导出完成（部分失败）",
      content: (
        <div>
          <p style={{ marginBottom: 4 }}>
            成功 {success} 篇{failed.length > 0 ? `，失败 ${failed.length} 篇` : ""}；
            共复制资产 {totalAssets} 个。父目录：
          </p>
          <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
            {parentDir}
          </p>
        </div>
      ),
      okText: "打开所在文件夹",
      onOk: () => revealItemInDir(parentDir as string).catch(() => {}),
      closable: true,
    });
  }, []);

  /** 单条 Word 导出（save dialog 选最终 .docx 路径） */
  const handleExportWordSingle = useCallback(async (record: Note) => {
    const safeName = record.title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    const filePath = await save({
      defaultPath: `${safeName}.docx`,
      filters: [{ name: "Word", extensions: ["docx"] }],
    });
    if (!filePath) return;
    try {
      const result = await exportApi.exportSingleToWord(record.id, filePath);
      Modal.success({
        title: "导出 Word 成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {`嵌入图片 ${result.imagesEmbedded} 张` +
                (result.imagesMissing > 0
                  ? `（${result.imagesMissing} 张缺失，已用占位符替代）`
                  : "")}
              ，文件：
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.filePath}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.filePath).catch(() => {}),
        closable: true,
      });
    } catch (e) {
      message.error(`导出 Word 失败: ${e}`);
    }
  }, []);

  /** 单条 HTML 导出（save dialog 选最终 .html 路径） */
  const handleExportHtmlSingle = useCallback(async (record: Note) => {
    const safeName = record.title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    const filePath = await save({
      defaultPath: `${safeName}.html`,
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    });
    if (!filePath) return;
    try {
      const result = await exportApi.exportSingleToHtml(record.id, filePath);
      Modal.success({
        title: "导出 HTML 成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {`内嵌图片 ${result.imagesInlined} 张` +
                (result.imagesMissing > 0
                  ? `（${result.imagesMissing} 张缺失）`
                  : "")}
              ，文件：
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.filePath}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.filePath).catch(() => {}),
        closable: true,
      });
    } catch (e) {
      message.error(`导出 HTML 失败: ${e}`);
    }
  }, []);

  /** 批量 Word/HTML 导出：选一次目录，循环按 `{title}.{ext}` 命名；同名自动加序号 _2、_3 */
  const handleExportBatchSingleFile = useCallback(
    async (ids: number[], ext: "docx" | "html") => {
      if (ids.length === 0) return;
      const parentDir = await openDialog({
        directory: true,
        title: `选择导出目录（共 ${ids.length} 篇 → .${ext}）`,
      });
      if (!parentDir) return;

      const sep = (parentDir as string).includes("\\") ? "\\" : "/";
      // 同次批量内的命名去重：记录已用名（去 ext 后小写比较，模拟 Windows 不分大小写文件名冲突）
      const usedKeys = new Set<string>();
      const allocatePath = (rawTitle: string): string => {
        const base = rawTitle.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
        let candidate = base;
        let n = 2;
        while (usedKeys.has(candidate.toLowerCase())) {
          candidate = `${base}_${n}`;
          n += 1;
        }
        usedKeys.add(candidate.toLowerCase());
        return `${parentDir}${sep}${candidate}.${ext}`;
      };

      const hide = message.loading(`正在导出 ${ids.length} 篇 .${ext}…`, 0);
      let success = 0;
      let images = 0;
      const failed: number[] = [];
      for (const id of ids) {
        const note = data.items.find((n) => n.id === id);
        const targetPath = allocatePath(note?.title ?? `note-${id}`);
        try {
          if (ext === "docx") {
            const r = await exportApi.exportSingleToWord(id, targetPath);
            images += r.imagesEmbedded;
          } else {
            const r = await exportApi.exportSingleToHtml(id, targetPath);
            images += r.imagesInlined;
          }
          success += 1;
        } catch (e) {
          failed.push(id);
          console.warn(`[export] 文档 ${id} 导出 ${ext} 失败:`, e);
        }
      }
      hide();
      Modal.success({
        title: failed.length === 0 ? `导出 .${ext} 完成` : `导出 .${ext} 完成（部分失败）`,
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              成功 {success} 篇{failed.length > 0 ? `，失败 ${failed.length} 篇` : ""}；
              {ext === "docx" ? "嵌入" : "内嵌"} {images} 张图片。目录：
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {parentDir}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(parentDir as string).catch(() => {}),
        closable: true,
      });
    },
    [data.items],
  );

  const handleTrashAll = useCallback(() => {
    Modal.confirm({
      title: "全部移到回收站",
      content: `将全部 ${data.total} 篇文档移到回收站，可在回收站中恢复或彻底删除。`,
      okText: "确认移入回收站",
      cancelText: "取消",
      onOk: async () => {
        try {
          const count = await noteApi.trashAll();
          useTabsStore.getState().closeAllTabs();
          message.success(`已将 ${count} 篇文档移到回收站`);
          useAppStore.getState().bumpNotesRefresh();
          loadNotes(1);
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  }, [data.total, loadNotes]);


  const handleSearch = useCallback(() => {
    loadNotes(1, keyword);
  }, [loadNotes, keyword]);

  const handleViewChange = useCallback(
    (v: string) => {
      // startTransition 标记为非紧急，让 Segmented 滑块动画先跑完
      startTransition(() => {
        setViewMode(v as ViewMode);
        // 切到非列表视图时清空批量选择（只有 list 有 checkbox）
        if (v !== "list") setSelectedIds([]);
        if (v === "timeline") {
          loadNotes(1);
        }
      });
    },
    [loadNotes],
  );

  // ─── DnD 自定义排序（仅 list + sortBy=custom） ──────
  // PointerSensor 设 5px 激活距离，防止 click 误触发拖拽（checkbox / 行 click 仍正常）
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const dndEnabled = viewMode === "list" && sortBy === "custom";

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIdx = data.items.findIndex((n) => String(n.id) === String(active.id));
      const newIdx = data.items.findIndex((n) => String(n.id) === String(over.id));
      if (oldIdx < 0 || newIdx < 0) return;
      // 同档校验：list_notes 第一排序键是 is_pinned DESC，跨档拖排会被 ORDER BY 拉回原档，
      // 视觉上"跳到最上"非常迷惑 → 直接拒绝
      const dragNote = data.items[oldIdx];
      const dropNote = data.items[newIdx];
      if (dragNote.is_pinned !== dropNote.is_pinned) {
        message.info(
          dragNote.is_pinned
            ? "置顶文档不能拖到普通文档之间（先取消置顶）"
            : "普通文档不能拖到置顶文档之间（先置顶它）",
        );
        return;
      }
      const reordered = arrayMove(data.items, oldIdx, newIdx);
      // 乐观更新
      setData((prev) => ({ ...prev, items: reordered }));
      try {
        await noteApi.reorder(reordered.map((n) => n.id));
      } catch (e) {
        message.error(`排序保存失败：${e}`);
        loadNotes(data.page);
      }
    },
    [data.items, data.page, loadNotes],
  );

  // ─── 列表行右键菜单 ──────────────────────────
  const noteCtx = useContextMenu<Note>();
  const [renameTarget, setRenameTarget] = useState<Note | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleSoftDelete = useCallback(
    async (id: number) => {
      try {
        await trashApi.softDelete(id);
        useTabsStore.getState().closeTab(id);
        message.success("已移到回收站");
        useAppStore.getState().bumpNotesRefresh();
        loadNotes(data.page);
      } catch (e) {
        message.error(String(e));
      }
    },
    [data.page, loadNotes],
  );

  const handleTogglePin = useCallback(
    async (id: number) => {
      try {
        const next = await noteApi.togglePin(id);
        message.success(next ? "已置顶" : "已取消置顶");
        useAppStore.getState().bumpNotesRefresh();
        loadNotes(data.page);
      } catch (e) {
        message.error(String(e));
      }
    },
    [data.page, loadNotes],
  );

  const handleRenameSubmit = useCallback(async () => {
    if (!renameTarget) return;
    const newTitle = renameValue.trim();
    if (!newTitle) {
      message.warning("标题不能为空");
      return;
    }
    if (newTitle === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    try {
      await noteApi.update(renameTarget.id, {
        title: newTitle,
        content: renameTarget.content,
        folder_id: renameTarget.folder_id,
      });
      message.success("已重命名");
      setRenameTarget(null);
      useAppStore.getState().bumpNotesRefresh();
      loadNotes(data.page);
    } catch (e) {
      message.error(String(e));
    }
  }, [renameTarget, renameValue, data.page, loadNotes]);

  const noteCtxMenuItems = useMemo<ContextMenuEntry[]>(() => {
    const note = noteCtx.state.payload;
    if (!note) return [];
    return [
      {
        key: "open",
        label: "打开",
        icon: <ExternalLink size={13} />,
        onClick: () => {
          noteCtx.close();
          openNoteOrOffice(note);
        },
      },
      {
        key: "rename",
        label: "重命名",
        icon: <Edit3 size={13} />,
        onClick: () => {
          noteCtx.close();
          setRenameTarget(note);
          setRenameValue(note.title);
        },
      },
      {
        key: "copy-wiki",
        label: "复制 wiki 链接",
        icon: <Copy size={13} />,
        onClick: () => {
          noteCtx.close();
          navigator.clipboard
            .writeText(`[[${note.title}]]`)
            .then(() => message.success("已复制"))
            .catch((err) => message.error(String(err)));
        },
      },
      {
        key: "toggle-pin",
        label: note.is_pinned ? "取消置顶" : "置顶",
        icon: note.is_pinned ? <PinOff size={13} /> : <Pin size={13} />,
        onClick: () => {
          noteCtx.close();
          handleTogglePin(note.id);
        },
      },
      { type: "divider" },
      {
        key: "soft-delete",
        label: "移到回收站",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          noteCtx.close();
          handleSoftDelete(note.id);
        },
      },
    ];
  }, [noteCtx, navigate, handleTogglePin, handleSoftDelete]);

  const columns: ColumnsType<Note> = useMemo(
    () => [
      {
        // 绝对序号：跨页连续（(page-1)*pageSize + 行内索引 + 1），翻页不重置
        title: "#",
        key: "index",
        width: 36,
        align: "right" as const,
        onCell: () => ({ style: { paddingLeft: 4, paddingRight: 4 } }),
        render: (_: unknown, __: Note, index: number) => (
          <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>
            {(data.page - 1) * data.page_size + index + 1}
          </span>
        ),
      },
      {
        title: "标题",
        dataIndex: "title",
        key: "title",
        ellipsis: true,
        // 标题文字（尤其是被 ellipsis 截断时）会贴到下一列，给单元格右侧留点呼吸空间
        onCell: () => ({ style: { paddingRight: 24 } }),
        render: (title: string, record: Note) => {
          // 子文件夹文档标记：当前选中是某文件夹，且这条文档 folder_id 不等于该选中
          // → 文档其实在子孙文件夹下；前面加 ↳ 小箭头作为轻量视觉提示
          const numericFolderId =
            folderId && folderId !== "uncategorized" ? Number(folderId) : null;
          const isFromDescendant =
            numericFolderId !== null && record.folder_id !== numericFolderId;
          return (
            <span className="flex items-center">
              <span className="mr-1.5 inline-flex shrink-0">
                <FileTypeIcon type={record.source_file_type || "md"} size={14} />
              </span>
              {isFromDescendant && (
                <Tooltip
                  title={`来自子文件夹：${record.folder_id ? folderMap.get(record.folder_id) ?? "?" : "未分类"}`}
                >
                  <span
                    style={{
                      color: token.colorTextTertiary,
                      marginRight: 4,
                      fontSize: 12,
                    }}
                  >
                    ↳
                  </span>
                </Tooltip>
              )}
              <a onClick={() => openNoteOrOffice(record)}>{title}</a>
              <NoteDecorators note={record} warningColor={token.colorWarning} />
            </span>
          );
        },
      },
      {
        title: "目录",
        dataIndex: "folder_id",
        key: "folder",
        width: 120,
        ellipsis: true,
        render: (fid: number | null, record: Note) => (
          <FolderChangeCell
            noteId={record.id}
            currentFolderId={fid}
            folders={folders}
            folderMap={folderMap}
            onChanged={() => loadNotes(data.page)}
            onFilterClick={(id) => navigate(`/notes?folder=${id}`)}
          />
        ),
      },
      {
        title: "字数",
        dataIndex: "word_count",
        key: "word_count",
        width: 70,
        render: (val: number) => (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {val}
          </Text>
        ),
      },
      {
        title: "更新时间",
        dataIndex: "updated_at",
        key: "updated_at",
        width: 110,
        render: (val: string) => (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {relativeTime(val)}
          </Text>
        ),
      },
    ],
    [navigate, token.colorWarning, token.colorTextTertiary, folderMap, folders, loadNotes, data.page, data.page_size],
  );

  // 时间线分组（缓存）
  const dateGroups = useMemo(() => groupByDate(data.items), [data.items]);

  // 文档纯文本预览（缓存：仅当 data.items 变化才重算 stripHtml，避免每次 render 都跑）
  const notePreviews = useMemo(() => {
    const map = new Map<number, string>();
    for (const n of data.items) {
      map.set(n.id, n.content ? stripHtml(n.content) : "");
    }
    return map;
  }, [data.items]);

  // ─── 虚拟滚动（卡片视图） ────────────────────
  // 将文档按 3 列分行
  const cardRows = useMemo(() => {
    const rows: Note[][] = [];
    for (let i = 0; i < data.items.length; i += 3) {
      rows.push(data.items.slice(i, i + 3));
    }
    return rows;
  }, [data.items]);

  const cardContainerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: cardRows.length,
    getScrollElement: () => cardContainerRef.current,
    estimateSize: () => 182, // 170 card + 12 gap
    overscan: 3,
  });

  /** 建图状态颜色与文案：绿=已建图，蓝=部分建图，黄=未建图，红=有更新 */
  const graphStatusMeta = !graphStatus
    ? null
    : graphStatus.state === "full"
      ? { color: token.colorSuccess, label: "已建图" }
      : graphStatus.state === "partial"
        ? { color: token.colorInfo, label: "部分建图" }
        : graphStatus.state === "stale"
          ? { color: token.colorError, label: "有更新" }
          : { color: token.colorWarning, label: "未建图" };
  const graphStatusTip =
    graphStatus && graphStatusMeta
      ? `文档图谱 · ${graphStatusMeta.label}（共 ${graphStatus.total} 篇：已建 ${graphStatus.built}，部分 ${graphStatus.partial}，待更新 ${graphStatus.stale}，失败 ${graphStatus.failed}）`
      : "文档图谱";

  return (
    <div className="max-w-4xl mx-auto h-full flex flex-col min-h-0">
      {/* 顶部标题栏 */}
      <div
        className="flex items-center justify-between mb-2 flex-shrink-0"
        data-tour="notes-toolbar"
      >
        <div className="flex min-w-0 items-center gap-1">
          <Title
            level={3}
            ellipsis
            style={{ margin: 0, lineHeight: "32px", minWidth: 0 }}
          >
            文档-{selectedFolderName ?? "全库"}
          </Title>
          {folderId && (
            <Tooltip title="退出文件夹，查看全库">
              <Button
                type="text"
                size="small"
                icon={<X size={16} />}
                aria-label="退出文件夹"
                onClick={exitFolderSelection}
                style={{ flexShrink: 0 }}
              />
            </Tooltip>
          )}
        </div>
        <Space align="center">
          <Tooltip title={graphStatusTip}>
            <Button
              aria-label="文档图谱"
              icon={
                <GitBranch
                  size={16}
                  color={graphStatusMeta?.color ?? token.colorTextSecondary}
                />
              }
              onClick={() =>
                navigate(
                  graphFolderId ? `/graph?folder=${graphFolderId}` : "/graph",
                )
              }
            />
          </Tooltip>
          <Segmented
            value={viewMode}
            onChange={handleViewChange}
            options={[
              { value: "list", icon: <LayoutList size={14} />, title: "列表" },
              { value: "card", icon: <LayoutGrid size={14} />, title: "卡片" },
              { value: "timeline", icon: <Clock size={14} />, title: "时间线" },
            ]}
            size="small"
          />
          <FolderCreateButton parentId={graphFolderId} />
          <NewNoteButton folderId={folderId ? Number(folderId) : null} />
        </Space>
      </div>

      {/* 搜索栏：mic 在 Input 的 suffix 内（与首页搜索一致）；右侧 Input 和「搜索」
          按钮之间留 6px 间距，避免 Compact 紧贴模式让 suffix 显示拥挤。 */}
      <div
        className="mb-2 flex-shrink-0 flex items-stretch gap-1.5"
        data-tour="notes-search"
        style={{ width: "100%" }}
      >
        <Input
          size="large"
          placeholder={searchContent ? "搜索标题或正文..." : "搜索文档标题..."}
          prefix={<Search size={16} />}
          suffix={
            <MicButton
              size="small"
              stripTrailingPunctuation
              onTranscribed={(text) =>
                setKeyword((prev) => (prev ? `${prev} ${text}` : text))
              }
            />
          }
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={handleSearch}
          allowClear
          style={{ flex: 1 }}
        />
        <Button size="large" type="primary" onClick={handleSearch}>
          搜索
        </Button>
      </div>

      {/* 搜索模式：正文检索 / 含子文件夹（后者仅选中目录时可用） */}
      <div
        className="mb-2 flex flex-shrink-0 flex-wrap items-center gap-4"
        style={{ fontSize: 12 }}
      >
        <Checkbox
          checked={searchContent}
          onChange={(e) => {
            const v = e.target.checked;
            setSearchContent(v);
            try {
              localStorage.setItem("notes.searchContent", v ? "1" : "0");
            } catch {
              /* localStorage 不可用时忽略 */
            }
          }}
        >
          正文检索
        </Checkbox>
        {folderId && folderId !== "uncategorized" && (
          <Checkbox
            checked={searchRecursive}
            onChange={(e) => {
              const v = e.target.checked;
              setSearchRecursive(v);
              try {
                localStorage.setItem("notes.searchRecursive", v ? "1" : "0");
              } catch {
                /* localStorage 不可用时忽略 */
              }
            }}
          >
            含子文件夹
          </Checkbox>
        )}
      </div>

      {/* 返回上级目录：进入子文件夹后回退到父目录（顶层目录不显示） */}
      {parentFolderId != null && (
        <div
          className="mb-2 flex flex-shrink-0 items-center"
          data-tour="notes-parent-folder"
        >
          <Button
            size="small"
            icon={<CornerUpLeft size={13} />}
            onClick={goToParentFolder}
          >
            返回上级{parentFolderName ? `：${parentFolderName}` : ""}
          </Button>
        </div>
      )}

      {/* 当前目录的子文件夹入口：主区文档列表只展示直属文档 */}
      {childFolders.length > 0 && (
        <div
          className="mb-2 flex flex-wrap items-center gap-1.5 flex-shrink-0"
          data-tour="notes-child-folders"
        >
          <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
            子文件夹
          </span>
          {childFolders.map((f) => (
            <Button
              key={f.id}
              size="small"
              icon={<FolderIcon size={13} />}
              onClick={() => navigate(`/notes?folder=${f.id}`)}
            >
              {f.name}
              {f.note_count > 0 && (
                <span style={{ marginLeft: 6, opacity: 0.55 }}>
                  {f.note_count}
                </span>
              )}
            </Button>
          ))}
        </div>
      )}

      {/* 批量工具条：仅列表视图 + 有选中时显示 */}
      {viewMode === "list" && selectedIds.length > 0 && (
        <div
          className="mb-2 flex items-center gap-2 flex-shrink-0"
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            background: token.colorPrimaryBg,
            color: token.colorPrimary,
            border: `1px solid ${token.colorPrimaryBorder}`,
          }}
        >
          <span style={{ fontSize: 13 }}>已选 {selectedIds.length} 条</span>
          <Divider orientation="vertical" />
          <BatchMoveButton
            folders={folders}
            open={batchMoveOpen}
            onOpenChange={setBatchMoveOpen}
            onMove={async (folderId) => {
              try {
                const n = await noteApi.moveBatch(selectedIds, folderId);
                message.success(`已移动 ${n} 条到目标文件夹`);
                setSelectedIds([]);
                setBatchMoveOpen(false);
                await loadNotes(data.page);
                useAppStore.getState().bumpFoldersRefresh();
              } catch (e) {
                message.error(`移动失败: ${e}`);
              }
            }}
          />
          <BatchTagButton
            noteIds={selectedIds}
            onDone={async (tagIds) => {
              try {
                const n = await noteApi.addTagsBatch(selectedIds, tagIds);
                message.success(`已添加 ${n} 条关联`);
                setSelectedIds([]);
                await loadNotes(data.page);
                useAppStore.getState().bumpTagsRefresh();
              } catch (e) {
                message.error(`打标签失败: ${e}`);
              }
            }}
          />
          <Popconfirm
            title={`确认将 ${selectedIds.length} 篇文档移到回收站？`}
            okText="移到回收站"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                const n = await noteApi.trashBatch(selectedIds);
                message.success(`已移到回收站 ${n} 条`);
                setSelectedIds([]);
                useAppStore.getState().bumpNotesRefresh();
                await loadNotes(data.page);
              } catch (e) {
                message.error(`删除失败: ${e}`);
              }
            }}
          >
            <Button size="small" danger icon={<Trash2 size={14} />}>
              删除
            </Button>
          </Popconfirm>
          <Space.Compact size="small">
            <Tooltip title="批量导出为 Markdown">
              <Button
                size="small"
                icon={<Share size={14} />}
                onClick={() => handleExportBatch(selectedIds)}
              >
                批量导出
              </Button>
            </Tooltip>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "md",
                    label: "批量导出为 Markdown",
                    onClick: () => runAfterMenuClose(() => void handleExportBatch(selectedIds)),
                  },
                  {
                    key: "docx",
                    label: "批量导出为 Word (.docx)",
                    onClick: () => runAfterMenuClose(() => void handleExportBatchSingleFile(selectedIds, "docx")),
                  },
                  {
                    key: "html",
                    label: "批量导出为 HTML (单文件)",
                    onClick: () => runAfterMenuClose(() => void handleExportBatchSingleFile(selectedIds, "html")),
                  },
                ],
              }}
            >
              <Button size="small" icon={<ChevronDown size={12} />} title="更多导出格式" />
            </Dropdown>
          </Space.Compact>
          <Button
            size="small"
            icon={<Bot size={14} />}
            onClick={async () => {
              // 找第一篇文档的标题给新对话用作默认名
              const firstId = selectedIds[0];
              const firstTitle = data.items.find((n) => n.id === firstId)?.title;
              try {
                await startAiChatWithNotes(selectedIds, firstTitle, navigate);
              } catch (e) {
                message.error(`发起 AI 会话失败: ${e}`);
              }
            }}
          >
            发到 AI
          </Button>
          <Button size="small" onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </div>
      )}

      {/* 列表视图：表格 + 分页条共享同一个白色卡片，短列表底下不再露出页面背景 */}
      {viewMode === "list" && (
        <div
          className="flex-1 flex flex-col min-h-0 notes-list-flat"
          style={{
            background: token.colorBgContainer,
            borderRadius: "var(--kb-radius-card)",
            border: "1px solid var(--kb-border-card)",
            overflow: "hidden",
          }}
        >
          {/* 列表工具条：排序靠左，全部移到回收站靠右 */}
          <div
            className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-2"
            style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                排序
              </span>
              <Segmented
                size="small"
                value={sortBy}
                onChange={(v) =>
                  setSortBy(v as "default" | "custom" | "created" | "title")
                }
                options={[
                  { value: "default", label: "修改时间" },
                  { value: "created", label: "创建时间" },
                  { value: "title", label: "标题" },
                  { value: "custom", label: "自定义" },
                ]}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="small"
                loading={exportingZip}
                onClick={() => void handleExportAllZip()}
              >
                导出全部
              </Button>
              {data.total > 0 && (
                <Button
                  size="small"
                  icon={<Archive size={14} />}
                  onClick={handleTrashAll}
                >
                  全部移到回收站
                </Button>
              )}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-auto" data-tour="notes-list">
            {dndEnabled ? (
              <DndContext
                sensors={dndSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={data.items.map((n) => String(n.id))}
                  strategy={verticalListSortingStrategy}
                >
                  <Table
                    className="notes-list-table"
                    columns={columns}
                    dataSource={data.items}
                    rowKey="id"
                    loading={loading}
                    size="small"
                    pagination={false}
                    sticky
                    rowSelection={{
                      selectedRowKeys: selectedIds,
                      onChange: (keys) =>
                        setSelectedIds(keys.map((k) => Number(k))),
                      columnWidth: 40,
                    }}
                    components={{ body: { row: SortableTableRow } }}
                    onRow={(record) => ({
                      onContextMenu: (e: React.MouseEvent) => {
                        e.preventDefault();
                        noteCtx.open(
                          { clientX: e.clientX, clientY: e.clientY },
                          record,
                        );
                      },
                    })}
                  />
                </SortableContext>
              </DndContext>
            ) : (
              <Table
                className="notes-list-table"
                columns={columns}
                dataSource={data.items}
                rowKey="id"
                loading={loading}
                size="small"
                pagination={false}
                sticky
                rowSelection={{
                  selectedRowKeys: selectedIds,
                  onChange: (keys) => setSelectedIds(keys.map((k) => Number(k))),
                  columnWidth: 40,
                }}
                onRow={(record) => ({
                  onContextMenu: (e) => {
                    e.preventDefault();
                    noteCtx.open(
                      { clientX: e.clientX, clientY: e.clientY },
                      record,
                    );
                  },
                })}
              />
            )}
          </div>
          <div
            className="flex-shrink-0 flex justify-end items-center px-3 py-2"
          >
            <Pagination
              current={data.page}
              pageSize={data.page_size}
              total={data.total}
              showTotal={(total) => `共 ${total} 篇`}
              showSizeChanger
              pageSizeOptions={["12", "20", "30", "50", "100"]}
              onChange={(page, size) => {
                setSelectedIds([]);
                if (size !== listPageSize) {
                  // 改了每页条数 → 同步 state；loadNotes 用 override 立即生效，
                  // 不依赖 useCallback 重建后才生效（否则会闪一次旧 size）
                  setListPageSize(size);
                  loadNotes(page, undefined, size);
                } else {
                  loadNotes(page);
                }
              }}
              size="small"
            />
          </div>
        </div>
      )}

      {/* 卡片视图（虚拟滚动） */}
      {viewMode === "card" && (
        <>
          {loading ? (
            <Row gutter={[12, 12]}>
              {[1, 2, 3].map((i) => (
                <Col key={i} span={8}>
                  <Card loading style={{ height: 170 }} />
                </Col>
              ))}
            </Row>
          ) : data.items.length > 0 ? (
            <>
              <div
                ref={cardContainerRef}
                style={{
                  height: Math.min(cardRows.length * 182, 600),
                  overflow: "auto",
                }}
              >
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = cardRows[virtualRow.index];
                    return (
                      <div
                        key={virtualRow.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <Row gutter={[12, 12]}>
                          {row.map((note) => (
                            <Col key={note.id} xs={24} sm={12} md={8}>
                              <Card
                                hoverable
                                size="small"
                                onClick={() => openNoteOrOffice(note)}
                                style={{
                                  height: 170,
                                  display: "flex",
                                  flexDirection: "column",
                                  borderLeft: note.is_pinned
                                    ? `3px solid ${token.colorWarning}`
                                    : undefined,
                                }}
                                styles={{
                                  body: {
                                    flex: 1,
                                    overflow: "hidden",
                                    display: "flex",
                                    flexDirection: "column",
                                    padding: "10px 12px",
                                  },
                                }}
                              >
                                <div className="flex items-center gap-1 mb-1">
                                  <Title
                                    level={5}
                                    ellipsis
                                    style={{ marginBottom: 0, fontSize: 13, flex: 1 }}
                                  >
                                    {note.title}
                                  </Title>
                                  <NoteDecorators note={note} warningColor={token.colorWarning} />
                                </div>
                                <Paragraph
                                  type="secondary"
                                  ellipsis={{ rows: 3 }}
                                  style={{ fontSize: 11, flex: 1, marginBottom: 6 }}
                                >
                                  {notePreviews.get(note.id) || "暂无内容"}
                                </Paragraph>
                                <div className="flex items-center justify-between">
                                  <Text type="secondary" style={{ fontSize: 10 }}>
                                    {relativeTime(note.updated_at)}
                                    {note.word_count > 0 && ` · ${note.word_count} 字`}
                                  </Text>
                                  <Space size={0}>
                                    {note.folder_id != null &&
                                    syncedFolderIds.has(note.folder_id) ? (
                                      <Tooltip title="按原文件强制刷新（会覆盖本地编辑）">
                                        <Button
                                          type="text"
                                          size="small"
                                          icon={<RefreshCw size={11} />}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void handleRefreshSynced(note);
                                          }}
                                          style={{ height: 20, width: 20, padding: 0 }}
                                        />
                                      </Tooltip>
                                    ) : (
                                      <Dropdown
                                        trigger={["click"]}
                                        menu={{
                                          items: [
                                            {
                                              key: "md",
                                              label: "导出为 Markdown",
                                              onClick: () => runAfterMenuClose(() => void handleExport(note)),
                                            },
                                            {
                                              key: "docx",
                                              label: "导出为 Word (.docx)",
                                              onClick: () => runAfterMenuClose(() => void handleExportWordSingle(note)),
                                            },
                                            {
                                              key: "html",
                                              label: "导出为 HTML (单文件)",
                                              onClick: () => runAfterMenuClose(() => void handleExportHtmlSingle(note)),
                                            },
                                          ],
                                        }}
                                      >
                                        <Tooltip title="导出">
                                          <Button
                                            type="text"
                                            size="small"
                                            icon={<Share size={11} />}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ height: 20, width: 20, padding: 0 }}
                                          />
                                        </Tooltip>
                                      </Dropdown>
                                    )}
                                    <Popconfirm
                                      title="确认删除？"
                                      onConfirm={(e) => {
                                        e?.stopPropagation();
                                        handleDelete(note.id);
                                      }}
                                    >
                                      <Tooltip title="删除">
                                        <Button
                                          type="text"
                                          danger
                                          size="small"
                                          icon={<Trash2 size={11} />}
                                          onClick={(e) => e.stopPropagation()}
                                          style={{ height: 20, width: 20, padding: 0 }}
                                        />
                                      </Tooltip>
                                    </Popconfirm>
                                  </Space>
                                </div>
                              </Card>
                            </Col>
                          ))}
                        </Row>
                      </div>
                    );
                  })}
                </div>
              </div>

              {data.total > data.page_size && (
                <div className="flex justify-center mt-4">
                  <Button disabled={data.page <= 1} onClick={() => loadNotes(data.page - 1)}>
                    上一页
                  </Button>
                  <Text className="mx-4" style={{ lineHeight: "32px" }}>
                    {data.page} / {Math.ceil(data.total / data.page_size)}
                  </Text>
                  <Button
                    disabled={data.page >= Math.ceil(data.total / data.page_size)}
                    onClick={() => loadNotes(data.page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState
              description="暂无文档"
              actionText="创建第一篇文档"
              onAction={() =>
                createBlankAndOpen(
                  folderId ? Number(folderId) : null,
                  navigate,
                  { useDefaults: !folderId },
                )
              }
            />
          )}
        </>
      )}

      {/* 时间线视图 */}
      {viewMode === "timeline" && (
        <>
          {loading ? (
            <Card loading style={{ height: 200 }} />
          ) : data.items.length > 0 ? (
            <div className="pl-2">
              {Array.from(dateGroups.entries()).map(([date, notes]) => (
                <div key={date} className="mb-5">
                  <div
                    className="flex items-center gap-2 mb-2 pb-1"
                    style={{
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    }}
                  >
                    <Calendar size={13} style={{ color: token.colorPrimary }} />
                    <Text strong style={{ fontSize: 13, color: token.colorPrimary }}>
                      {formatDateLabel(date)}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {notes.length} 篇
                    </Text>
                  </div>
                  <Timeline
                    items={notes.map((note) => ({
                      color: note.is_pinned ? "gold" : note.is_daily ? "blue" : "gray",
                      children: (
                        <div
                          className="cursor-pointer group -mt-0.5"
                          onClick={() => openNoteOrOffice(note)}
                        >
                          <div className="flex items-center gap-1.5">
                            <Text
                              style={{ fontSize: 13 }}
                              className="group-hover:text-blue-500 transition-colors"
                            >
                              {note.title}
                            </Text>
                            <NoteDecorators note={note} warningColor={token.colorWarning} />
                            <Text
                              type="secondary"
                              style={{ fontSize: 10, marginLeft: "auto" }}
                            >
                              {note.updated_at.slice(11, 16)}
                            </Text>
                          </div>
                          {note.content && (
                            <Paragraph
                              type="secondary"
                              ellipsis={{ rows: 1 }}
                              style={{
                                fontSize: 11,
                                marginBottom: 0,
                                marginTop: 2,
                              }}
                            >
                              {(notePreviews.get(note.id) ?? "").slice(0, 100)}
                            </Paragraph>
                          )}
                        </div>
                      ),
                    }))}
                  />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              description="暂无文档"
              actionText="创建第一篇文档"
              onAction={() =>
                createBlankAndOpen(
                  folderId ? Number(folderId) : null,
                  navigate,
                  { useDefaults: !folderId },
                )
              }
            />
          )}
        </>
      )}

      {/* "新建文档"入口已统一到 NewNoteButton 分段按钮 */}

      {/* 列表行右键菜单（list 视图） */}
      <ContextMenuOverlay
        open={!!noteCtx.state.payload}
        x={noteCtx.state.x}
        y={noteCtx.state.y}
        items={noteCtxMenuItems}
        onClose={noteCtx.close}
      />

      {/* 重命名弹窗 */}
      <Modal
        title="重命名文档"
        open={!!renameTarget}
        onOk={handleRenameSubmit}
        onCancel={() => setRenameTarget(null)}
        okText="确定"
        cancelText="取消"
        destroyOnClose
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={handleRenameSubmit}
          placeholder="新标题"
          autoFocus
        />
      </Modal>

    </div>
  );
}

// ─── 移动端 Wrapper（T-M008 二期）───────────────────
import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileNotes } from "./MobileNotes";

export default function NoteListPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileNotes /> : <DesktopNoteListPage />;
}
