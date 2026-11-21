import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Input,
  Button,
  Space,
  Typography,
  Spin,
  Popconfirm,
  Select,
  Tag as AntTag,
  Divider,
  Tooltip,
  Modal,
  List,
  Popover,
  Tree,
  Badge,
  Dropdown,
  App as AntdApp,
  theme as antdTheme,
} from "antd";
import { ArrowLeft, Save, Trash2, Pin, FolderOpen, Tags, Link2, Share, Maximize2, Minimize2, FileText as FileTextIcon, ChevronRight, ChevronDown, CornerUpLeft, Folder as FolderIcon, Eye, EyeOff, Lock, Unlock, MessageSquare, ListTree, Network, ExternalLink, Printer, GitBranch } from "lucide-react";
import { CloseCircleFilled } from "@ant-design/icons";
import { useAppStore } from "@/store";
import { useTabsStore } from "@/store/tabs";
import { noteApi, tagApi, folderApi, linkApi, exportApi, sourceFileApi, vaultApi, sourceWritebackApi, mountApi } from "@/lib/api";
import { VaultModal } from "@/components/vault/VaultModal";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { relativeTime, stripHtml } from "@/lib/utils";
import { editorDomToSelfContainedHtml, printEditorContent } from "@/lib/printNote";
import { useModuleConfig } from "@/hooks/useModuleConfig";
import { TiptapEditor } from "@/components/editor";
import { getHeadingNumberEntries } from "@/components/editor/HeadingNumber";
import { EditorOutline } from "@/components/editor/EditorOutline";
import { EditorStats } from "@/components/editor/EditorStats";
import { TagColorPicker } from "@/components/TagColorPicker";
import { MicButton } from "@/components/MicButton";
import { NoteAiDrawer } from "@/components/ai/NoteAiDrawer";
import { AttachmentPreviewModal } from "@/components/preview/AttachmentPreviewModal";
import { MindMapView } from "@/components/notes/MindMapView";
import { NoteGraphView } from "@/components/notes/NoteGraphView";
import type { Note, Tag, Folder, NoteLink, MountNoteStatus, WordExportResult } from "@/types";

const { Text } = Typography;

// 当前 webview 的 label。同一 webview 内不变，模块级常量即可。
// popout 窗口的 label 形如 `popout-note-{id}`（由 popout_window.rs 创建），主窗口是 "main"。
const CURRENT_WINDOW_LABEL = (() => {
  try { return getCurrentWindow().label; }
  catch { return ""; }
})();
const IS_POPOUT_WINDOW = CURRENT_WINDOW_LABEL.startsWith("popout-");

/**
 * 直接读编辑器里"此刻"的 Markdown。
 *
 * 保存时不能只信父组件的 `content` state：点击保存按钮会先让编辑器失焦，
 * onBlur 里的 flush 走的是异步 setState，本次 handleSave 闭包读到的还是旧值，
 * 于是最后几个字/最后一次拖拽调整可能被漏存（表现为"点了保存但没保存上"）。
 */
function readEditorMarkdown(editor: unknown): string | null {
  const storage = (editor as {
    storage?: { markdown?: { getMarkdown?: () => string } };
  } | null)?.storage;
  try {
    const md = storage?.markdown?.getMarkdown?.();
    return typeof md === "string" ? md : null;
  } catch {
    return null;
  }
}

/** 从 HTML 内容中提取 [[文档标题]] 链接 */
function extractWikiLinks(html: string): string[] {
  const text = stripHtml(html);
  const regex = /\[\[([^\]]+)\]\]/g;
  const titles: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    titles.push(match[1].trim());
  }
  return [...new Set(titles)]; // 去重
}

/** 反向链接面板
 *
 * T-B08: 即使 0 条也显示空态卡片，让用户知道这个区域存在；用 id 锚定，
 * 顶部 Link2 按钮可滚动定位到此处。
 */
function BacklinksPanel({
  backlinks,
  onNavigate,
}: {
  backlinks: NoteLink[];
  onNavigate: (id: number) => void;
}) {
  return (
    <div id="backlinks-panel" className="mt-6 pt-4 border-t border-gray-100">
      <div className="flex items-center gap-2 mb-2">
        <Link2 size={14} className="text-gray-400" />
        <Text type="secondary" style={{ fontSize: 13 }}>
          反向链接 ({backlinks.length})
        </Text>
      </div>
      {backlinks.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          暂无其他文档链接到这里。在其他文档中输入 <Text code style={{ fontSize: 11 }}>[[本文档标题]]</Text> 即可建立反向链接。
        </Text>
      ) : (
        <div className="flex flex-col gap-1">
          {backlinks.map((link) => (
            <div
              key={link.source_id}
              className="flex items-center justify-between px-3 py-2 rounded-md cursor-pointer hover:bg-gray-50"
              onClick={() => onNavigate(link.source_id)}
            >
              <Text style={{ fontSize: 13 }}>{link.source_title}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {relativeTime(link.updated_at)}
              </Text>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 把树形文件夹映射为 antd Tree 的节点（key = 文件夹 id） */
type FolderTreeNode = {
  key: number;
  title: ReactNode;
  rawTitle: string;
  children?: FolderTreeNode[];
};
function foldersToAntTree(folders: Folder[]): FolderTreeNode[] {
  return folders.map((f) => ({
    key: f.id,
    rawTitle: f.name,
    title: (
      <span className="inline-flex items-center gap-1.5" style={{ fontSize: 13 }}>
        <FolderIcon size={13} style={{ opacity: 0.6 }} />
        {f.name}
      </span>
    ),
    children: f.children?.length ? foldersToAntTree(f.children) : undefined,
  }));
}

/** 收集树里所有节点 id，供 defaultExpandAll 用（antd Tree 的 defaultExpandAll
 *  只在首次挂载生效；这里直接算出全部 key 给 expandedKeys 便于受控展开） */
function collectAllKeys(nodes: FolderTreeNode[]): number[] {
  const out: number[] = [];
  for (const n of nodes) {
    out.push(n.key);
    if (n.children?.length) out.push(...collectAllKeys(n.children));
  }
  return out;
}

/** 根据目标 folderId 从树中回溯，得到祖先链（根 → 子 → … → 目标）
 *  返回 `[{id, name}]` 数组；找不到返回空数组。 */
function buildFolderPath(
  folders: Folder[],
  targetId: number,
): { id: number; name: string }[] {
  for (const f of folders) {
    if (f.id === targetId) {
      return [{ id: f.id, name: f.name }];
    }
    if (f.children?.length) {
      const sub = buildFolderPath(f.children, targetId);
      if (sub.length > 0) {
        return [{ id: f.id, name: f.name }, ...sub];
      }
    }
  }
  return [];
}

/** 面包屑路径 + Popover 里 TreeSelect 编辑的文件夹切换器
 *
 *  - 展示态：`🗂 工作 › 项目A`（未分类则显示"未分类"）
 *  - 点击 → Popover，含 TreeSelect（原生树形展开 + 搜索）和"移到根目录"快捷按钮
 *  - 选中即 onChange + 自动关闭 Popover */
function FolderPathEditor({
  folders,
  folderId,
  onChange,
}: {
  folders: Folder[];
  folderId: number | null;
  onChange: (folderId: number | null) => void;
}) {
  const { token } = antdTheme.useToken();
  const [open, setOpen] = useState(false);
  const path = useMemo(
    () => (folderId != null ? buildFolderPath(folders, folderId) : []),
    [folders, folderId],
  );
  const treeData = useMemo(() => foldersToAntTree(folders), [folders]);
  // 打开时默认展开所有节点，用户进来就能看全
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  useEffect(() => {
    if (open) {
      setExpandedKeys(collectAllKeys(treeData));
    }
  }, [open, treeData]);

  // 默认文件夹偏好（"全局新建文档"时套用）
  const defaultFolderId = useAppStore((s) => s.defaultFolderId);
  const setDefaultFolderId = useAppStore((s) => s.setDefaultFolderId);
  const defaultFolderName = useMemo(
    () =>
      defaultFolderId != null
        ? buildFolderPath(folders, defaultFolderId)
            .map((f) => f.name)
            .join(" › ")
        : null,
    [folders, defaultFolderId],
  );

  // antd Tree titleRender：标题右侧 hover 出图钉，已默认时常亮主题色
  const renderTreeTitle = (nodeData: { key: React.Key; title?: ReactNode }) => {
    const id = Number(nodeData.key);
    const isDefault = defaultFolderId === id;
    return (
      <div className="kb-folder-tree-row flex items-center justify-between w-full pr-1">
        <span className="truncate">{nodeData.title}</span>
        <Tooltip
          title={isDefault ? "取消默认（新建文档不再自动归此处）" : "设为默认（新建文档自动归此处）"}
          mouseEnterDelay={0.4}
        >
          <button
            className={`kb-folder-pin ${isDefault ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              void setDefaultFolderId(isDefault ? null : id);
            }}
            aria-label="设为默认文件夹"
          >
            <Pin
              size={12}
              fill={isDefault ? "currentColor" : "none"}
            />
          </button>
        </Tooltip>
      </div>
    );
  };

  const popoverContent = (
    <div style={{ width: 260 }}>
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
              color: token.colorTextTertiary,
              fontSize: 12,
            }}
          >
            还没有文件夹
            <br />
            <span style={{ fontSize: 11 }}>到侧边栏的"文件夹"里新建</span>
          </div>
        ) : (
          <Tree
            blockNode
            treeData={treeData}
            selectedKeys={folderId != null ? [folderId] : []}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpandedKeys(keys)}
            onSelect={(keys) => {
              if (keys.length > 0) {
                onChange(keys[0] as number);
                setOpen(false);
              }
            }}
            titleRender={renderTreeTitle}
          />
        )}
      </div>
      <Divider style={{ margin: "8px 0" }} />
      <Button
        size="small"
        type="text"
        block
        disabled={folderId == null}
        icon={<CornerUpLeft size={13} />}
        onClick={() => {
          onChange(null);
          setOpen(false);
        }}
        style={{ textAlign: "left", justifyContent: "flex-start" }}
      >
        移到根目录
      </Button>
      {/* 底部脚条：当前默认文件夹 + 一键清除 */}
      <div
        style={{
          marginTop: 6,
          padding: "6px 4px 2px",
          borderTop: `1px dashed ${token.colorBorderSecondary}`,
          fontSize: 11,
          color: token.colorTextTertiary,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <span className="truncate flex items-center gap-1">
          <Pin size={11} style={{ color: token.colorPrimary, flexShrink: 0 }} />
          <span className="truncate">
            默认：
            {defaultFolderName ?? <span style={{ opacity: 0.7 }}>未设置</span>}
          </span>
        </span>
        {defaultFolderId != null && (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, fontSize: 11, height: "auto" }}
            onClick={() => void setDefaultFolderId(null)}
          >
            清除
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
      content={popoverContent}
      destroyOnHidden
    >
      <div
        className="inline-flex items-center gap-1 cursor-pointer select-none"
        style={{
          padding: "2px 8px",
          borderRadius: 6,
          fontSize: 13,
          color: token.colorText,
          background: open ? token.colorFillTertiary : "transparent",
          transition: "background-color .15s",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = token.colorFillQuaternary)
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = open
            ? token.colorFillTertiary
            : "transparent")
        }
      >
        <FolderOpen size={14} style={{ color: token.colorTextTertiary }} />
        {path.length === 0 ? (
          <span style={{ color: token.colorTextTertiary }}>未分类</span>
        ) : (
          path.map((seg, idx) => (
            <span key={seg.id} className="inline-flex items-center">
              {idx > 0 && (
                <ChevronRight
                  size={12}
                  style={{ color: token.colorTextQuaternary, margin: "0 2px" }}
                />
              )}
              <span>{seg.name}</span>
            </span>
          ))
        )}
      </div>
    </Popover>
  );
}

/** 标签与文件夹元数据区域 */
function MetaBar({
  noteTags,
  allTags,
  folders,
  folderId,
  editor,
  showWordCount,
  onTagsChange,
  onFolderChange,
  onCreateTag,
  onChangeTagColor,
  tagsReadOnly,
  tagsReadOnlyHint,
}: {
  noteTags: Tag[];
  allTags: Tag[];
  folders: Folder[];
  folderId: number | null;
  editor: any | null;
  showWordCount: boolean;
  onTagsChange: (tagIds: number[]) => void;
  onFolderChange: (folderId: number | null) => void;
  onCreateTag: (name: string) => Promise<void>;
  onChangeTagColor: (tagId: number, color: string | null) => Promise<void>;
  /** 挂载的非 Markdown / 只读文档：标签仅展示，不可增删 */
  tagsReadOnly?: boolean;
  tagsReadOnlyHint?: string;
}) {
  const [tagSearch, setTagSearch] = useState("");
  const tagOptions = allTags.map((t) => ({
    label: t.name,
    value: t.id,
  }));

  const selectedTagIds = noteTags.map((t) => t.id);
  const trimmedSearch = tagSearch.trim();
  const exactExists = allTags.some((t) => t.name === trimmedSearch);
  const showCreate = trimmedSearch.length > 0 && !exactExists;

  // 默认标签偏好（"全局新建文档"自动附加）
  const defaultTagIds = useAppStore((s) => s.defaultTagIds);
  const setDefaultTagIds = useAppStore((s) => s.setDefaultTagIds);
  const defaultTagNames = useMemo(
    () =>
      defaultTagIds
        .map((id) => allTags.find((t) => t.id === id)?.name)
        .filter((n): n is string => !!n),
    [defaultTagIds, allTags],
  );
  // 当前选中和默认是否一致——决定"设为默认"按钮是否可用
  const sameAsDefault = useMemo(() => {
    if (selectedTagIds.length !== defaultTagIds.length) return false;
    const a = [...selectedTagIds].sort();
    const b = [...defaultTagIds].sort();
    return a.every((v, i) => v === b[i]);
  }, [selectedTagIds, defaultTagIds]);

  return (
    <div className="flex items-center gap-3 py-2 flex-wrap">
      {/* 文件夹路径面包屑（点击切换目录） */}
      <FolderPathEditor
        folders={folders}
        folderId={folderId}
        onChange={onFolderChange}
      />

      <Divider orientation="vertical" style={{ height: 20 }} />

      {/* 标签管理 */}
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <Tags size={14} className="text-gray-400 shrink-0" />
        <div className="flex items-center gap-1 flex-wrap flex-1">
          {noteTags.map((tag) => (
            <Popover
              key={tag.id}
              trigger="click"
              placement="bottom"
              title="调整颜色"
              content={
                <TagColorPicker
                  value={tag.color}
                  allowClear
                  onChange={(c) => onChangeTagColor(tag.id, c)}
                />
              }
            >
              <AntTag
                closable={!tagsReadOnly}
                color={tag.color ?? undefined}
                style={{ cursor: "pointer" }}
                onClose={(e) => {
                  // 阻止 Popover 触发 + close 走 onTagsChange
                  e.stopPropagation();
                  onTagsChange(selectedTagIds.filter((id) => id !== tag.id));
                }}
              >
                {tag.name}
              </AntTag>
            </Popover>
          ))}
          {tagsReadOnly ? (
            <span
              style={{
                fontSize: 12,
                color: "var(--ant-color-text-tertiary, #999)",
              }}
            >
              {tagsReadOnlyHint ?? "标签只读"}
            </span>
          ) : (
          <Select
            mode="multiple"
            size="small"
            placeholder={
              allTags.length === 0
                ? "输入标签名后回车创建"
                : "+ 添加 / 搜索 / 新建"
            }
            style={{ minWidth: 160, maxWidth: 240 }}
            value={selectedTagIds}
            onChange={onTagsChange}
            options={tagOptions}
            maxTagCount={0}
            maxTagPlaceholder={`+ 添加`}
            popupMatchSelectWidth={240}
            notFoundContent={
              trimmedSearch
                ? null
                : <div style={{ padding: "8px 12px", fontSize: 12, color: "#999" }}>
                    输入标签名后从下方点击创建
                  </div>
            }
            showSearch
            // searchValue 受控，便于在创建标签后清空输入框
            searchValue={tagSearch}
            onSearch={setTagSearch}
            filterOption={(input, option) =>
              String(option?.label ?? "")
                .toLowerCase()
                .includes(input.toLowerCase())
            }
            onInputKeyDown={async (e) => {
              // 回车直接创建（当输入不存在时）
              if (e.key === "Enter" && showCreate) {
                e.preventDefault();
                e.stopPropagation();
                await onCreateTag(trimmedSearch);
                setTagSearch("");
              }
            }}
            popupRender={(menu) => (
              <>
                {menu}
                {showCreate && (
                  <>
                    <Divider style={{ margin: "4px 0" }} />
                    <div
                      onMouseDown={(e) => {
                        // 阻止 Select 抢走焦点 + 关闭
                        e.preventDefault();
                        e.stopPropagation();
                        onCreateTag(trimmedSearch);
                        setTagSearch("");
                      }}
                      style={{
                        padding: "6px 12px",
                        cursor: "pointer",
                        fontSize: 13,
                        color: "var(--ant-color-primary, #1677ff)",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background =
                          "var(--ant-control-item-bg-hover, #f5f5f5)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "transparent")
                      }
                    >
                      + 创建标签「{trimmedSearch}」
                    </div>
                  </>
                )}
                {/* 默认标签管理脚条：把当前选中保存为默认 / 清除 */}
                <Divider style={{ margin: "4px 0" }} />
                <div
                  onMouseDown={(e) => e.preventDefault()}
                  style={{
                    padding: "6px 12px 8px",
                    fontSize: 11,
                    color: "var(--ant-color-text-tertiary, #999)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div className="flex items-center gap-1 truncate">
                    <Pin size={11} style={{ flexShrink: 0 }} />
                    <span className="truncate">
                      默认：
                      {defaultTagNames.length > 0
                        ? defaultTagNames.join("、")
                        : <span style={{ opacity: 0.7 }}>未设置</span>}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, fontSize: 11, height: "auto" }}
                      disabled={selectedTagIds.length === 0 || sameAsDefault}
                      onClick={() => void setDefaultTagIds(selectedTagIds)}
                    >
                      把当前选中设为默认
                    </Button>
                    {defaultTagIds.length > 0 && (
                      <Button
                        type="link"
                        size="small"
                        style={{ padding: 0, fontSize: 11, height: "auto" }}
                        onClick={() => void setDefaultTagIds([])}
                      >
                        清除
                      </Button>
                    )}
                  </div>
                </div>
              </>
            )}
          />
          )}
        </div>
      </div>

      {/* 字数统计：放在元数据栏末尾（与文件夹/标签同行），shrink-0 防被标签挤掉 */}
      {editor && showWordCount && (
        <div className="shrink-0 flex items-center gap-2">
          <Divider type="vertical" style={{ height: 20, margin: 0 }} />
          <EditorStats editor={editor} />
        </div>
      )}
    </div>
  );
}

function DesktopNoteEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // 上下文感知的 message / notification（避免静态方法丢主题、偶发不显示）
  const { message, notification } = AntdApp.useApp();
  const { token } = antdTheme.useToken();
  const { focusMode, setFocusMode } = useAppStore();
  const { openTab, updateTabTitle, setTabDirty, setDraft, getDraft, clearDraft } = useTabsStore();
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /**
   * 最后一次真正落库的版本。
   *
   * 用途：区分"内容真的改了"和"编辑器 blur / 打开思维导图时把 Markdown
   * 重新序列化了一遍"。后者字符串可能因换行/空列表等规范化而与原文不完全相同，
   * 但它不是用户修改——不能因此把状态标成未保存，否则会自动保存并反复刷写。
   */
  const savedRef = useRef<{ title: string; content: string }>({
    title: "",
    content: "",
  });
  // 模块设置中心：自动保存延迟 / 字数统计开关
  const { values: notesConfig } = useModuleConfig("notes", {
    auto_save_delay: 1.2,
    show_word_count: true,
  });
  /** 思维导图视图：在编辑器右侧以 flex 分栏方式渲染（不是浮层） */
  const [mindMapOpen, setMindMapOpen] = useState(false);
  /** 思维导图分栏宽度（像素，持久化到 localStorage 跨文档记忆） */
  const [mindMapWidth, setMindMapWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("editor.mindMapWidth"));
    return Number.isFinite(saved) && saved >= 320 ? saved : 480;
  });
  // latest 字段：handleMove 写入最新宽度，handleUp 关闭时读出落库（避免闭包陷阱）
  const splitterDragRef = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);

  /** 单文档 LLM 图谱：编辑器右侧分栏（与思维导图互斥，宽度共用） */
  const [graphPanelOpen, setGraphPanelOpen] = useState(false);

  /** 右侧大纲宽度（像素，持久化到 localStorage；双击分隔条还原到默认） */
  const OUTLINE_DEFAULT_WIDTH = 200;
  const [outlineWidth, setOutlineWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("editor.outlineWidth"));
    return Number.isFinite(saved) && saved >= 160 ? saved : OUTLINE_DEFAULT_WIDTH;
  });
  const outlineDragRef = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);

  // 标签状态
  const [noteTags, setNoteTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  // 文件夹状态（保留原始树形结构供 FolderPathEditor 的面包屑 / TreeSelect 使用）
  const [folders, setFolders] = useState<Folder[]>([]);

  // 反向链接状态
  const [backlinks, setBacklinks] = useState<NoteLink[]>([]);

  // 大纲：editor 实例（来自 TiptapEditor 的 onEditorReady 回调）+ 滚动容器 ref
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [editorInstance, setEditorInstance] = useState<any | null>(null);
  const editorBodyRef = useRef<HTMLDivElement | null>(null);

  // Ctrl/Cmd+A 全选文档内容。
  // 默认情况下焦点未落到 ProseMirror 编辑器时（比如刚打开文档还没点入正文），
  // WebView 会触发原生"选中整个文档"行为，把侧栏 / 工具栏 / 元属性区都选上。
  // 这里仅在事件来源是 body 或编辑器主体内部（且不在 input/textarea/contenteditable
  // 上）时拦截，转发到 editor.commands.selectAll —— 弹窗 / Modal / Select 等
  // 由 Ant Design portal 挂到 body 末尾的元素不会被 editorBodyRef.contains 命中,
  // 仍走原生默认行为，互不干扰。
  useEffect(() => {
    if (!editorInstance) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key !== "a" && e.key !== "A") return;

      const target = e.target as HTMLElement | null;
      if (!target) return;

      const tag = target.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (target.isContentEditable) return; // ProseMirror 自身已在 PM keymap 处理

      const insideEditorBody = !!editorBodyRef.current?.contains(target);
      if (target !== document.body && !insideEditorBody) return;

      e.preventDefault();
      editorInstance.chain().focus().selectAll().run();
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [editorInstance]);
  const outlineVisible = useAppStore((s) => s.outlineVisible);
  const toggleOutline = useAppStore((s) => s.toggleOutline);
  /**
   * 思维导图打开时自动暂时隐藏大纲——三栏（编辑器+大纲+导图）会挤压编辑可读宽度。
   * 不动用户在 store 里的偏好；mindMapOpen 切回 false 后大纲自动恢复。
   */
  const effectiveOutlineVisible =
    outlineVisible && !mindMapOpen && !graphPanelOpen;

  // 同名消歧 Modal 状态
  const [disambigOpen, setDisambigOpen] = useState(false);
  const [disambigItems, setDisambigItems] = useState<Note[]>([]);
  const [disambigTitle, setDisambigTitle] = useState("");

  // 右侧 AI 抽屉（方案 A：编辑文档时不离页问 AI；伴生对话存到 ai_conversations）
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  // 选段触发（方案 C）：携带的选中文本，抽屉里展示为引用 chip 而不是塞输入框
  const [aiSelection, setAiSelection] = useState<string | undefined>(undefined);

  // PDF 预览 Modal 状态
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string>("");
  /** PDF 原文件绝对路径（供 Modal 里"用系统应用打开"兜底按钮调 openPath） */
  const [pdfPreviewAbsPath, setPdfPreviewAbsPath] = useState<string>("");
  /** PDF 预览 Modal 是否最大化（全屏铺满） */
  const [pdfPreviewMaximized, setPdfPreviewMaximized] = useState(false);

  const noteId = Number(id);
  /** 外部挂载状态：决定标签是否可编辑（仅可写 Markdown 可写回） */
  const [mountStatus, setMountStatus] = useState<MountNoteStatus | null>(null);
  const mountExt = (
    mountStatus?.sourceExt ??
    mountStatus?.sourceType ??
    ""
  ).toLowerCase();
  const mountIsMarkdown = mountExt === "md" || mountExt === "markdown";
  const tagsReadOnly =
    !!mountStatus?.external && (mountStatus.readOnly || !mountIsMarkdown);
  const tagsReadOnlyHint = mountStatus?.readOnly
    ? "该挂载点为只读，标签不可编辑"
    : "挂载文档的标签来自源文件解析，仅 Markdown 文件可写回";

  /**
   * 当前 title/content 状态实际属于哪条文档。
   *
   * 路由切到新 noteId 时，React 复用同一个编辑器实例，title/content 仍是上一篇的，
   * 直到 loadData 落定才更新。这段时间里自动保存 / 草稿 effect 若按新 noteId 写入，
   * 就会把上一篇内容覆盖到新文档（白板被写成 Markdown 就是这么发生的）。
   * 所有"写"路径都先校验归属，未对齐则跳过。
   */
  const ownedNoteIdRef = useRef<number | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [noteData, tags, folderTree, existingTags, links] = await Promise.all([
        noteApi.get(noteId),
        tagApi.list(),
        folderApi.list(),
        tagApi.getNoteTags(noteId),
        linkApi.getBacklinks(noteId),
      ]);
      // 白板本质是 note_type='whiteboard' 的文档：直接替换到画布页，
      // 否则会把 Excalidraw 场景 JSON 当 Markdown 正文渲染出来。
      // 必须发生在 openTab 之前，避免给白板留下一个"文档编辑器"标签页。
      if (noteData.note_type === "whiteboard") {
        navigate(`/whiteboard/${noteData.id}`, { replace: true });
        return;
      }
      ownedNoteIdRef.current = noteData.id;
      setNote(noteData);
      setAllTags(tags);
      setNoteTags(existingTags);
      setFolders(folderTree);
      setBacklinks(links);
      openTab({
        id: noteData.id,
        title: noteData.title,
        sourceFileType: noteData.source_file_type,
        noteType: noteData.note_type,
      });

      // 如果 store 里有未保存的草稿（上次切 tab/跳转 wiki 时缓存），优先恢复
      const draft = getDraft(noteId);
      // 数据库里的版本始终是"已保存"基准，用于判断草稿/编辑是否真的偏离
      savedRef.current = {
        title: noteData.title,
        content: noteData.content,
      };
      if (draft && (draft.title !== noteData.title || draft.content !== noteData.content)) {
        setTitle(draft.title);
        setContent(draft.content);
        setDirty(true);
        // store dirty 保持 true（关闭 tab / 退出时确认提示能命中）
        setTabDirty(noteId, true);
      } else {
        setTitle(noteData.title);
        setContent(noteData.content);
        setDirty(false);
        // 干净加载：同时复位标签脏标记，避免标签残留 true 导致"打开未改却提示未保存"
        setTabDirty(noteId, false);
        // 草稿已和 DB 一致（其他场景 clear 漏了），主动清掉
        if (draft) clearDraft(noteId);
      }
    } catch (e) {
      message.error(String(e));
      navigate("/notes");
    } finally {
      setLoading(false);
    }
  }, [noteId, navigate, openTab, getDraft, clearDraft, setTabDirty]);

  useEffect(() => {
    if (id) loadData();
  }, [id, loadData]);

  // 外部挂载的 PDF / Word / Excel 影子文档：检测原文件是否已更新。
  // 未编辑时可安全重抽；已编辑时提示会覆盖本地修改。
  useEffect(() => {
    if (!noteId) return;
    let cancelled = false;
    setMountStatus(null);
    mountApi
      .noteStatus(noteId)
      .then((s) => {
        if (cancelled) return;
        setMountStatus(s.external ? s : null);
        if (!s.external) return;
        // 只对二进制文档提示；文本文件的写回/重抽是常规同步，不需要打扰
        const ext = (s.sourceExt ?? s.sourceType ?? "").toLowerCase();
        const binary = !!ext &&
          !["md", "markdown", "txt", "text"].includes(ext);
        if (!binary) return;
        if (!s.stale && s.status !== "failed") return;
        const failed = s.status === "failed";
        notification.warning({
          key: `mount-stale-${noteId}`,
          message: failed ? "原文件抽取失败" : "原文件已更新",
          description: (
            <div style={{ fontSize: 12 }}>
              <div>{s.error || "影子文档已落后于原文件。"}</div>
              <div style={{ marginTop: 6, opacity: 0.75 }}>
                {s.userEdited
                  ? "你对影子文档的编辑不会写回原文件；重新抽取会覆盖当前编辑。"
                  : "影子文档尚未编辑，可以安全重新抽取。"}
              </div>
            </div>
          ),
          duration: 0,
          actions: (
            <Button
              size="small"
              type="primary"
              onClick={async () => {
                try {
                  await mountApi.reextract(noteId);
                  notification.destroy(`mount-stale-${noteId}`);
                  message.success("已重新抽取原文件");
                  await loadData();
                } catch (e) {
                  message.error(`重新抽取失败: ${e}`);
                }
              }}
            >
              重新抽取
            </Button>
          ),
        });
      })
      .catch(() => {
        // 非外部文档 / 状态查询失败不打扰用户
      });
    return () => {
      cancelled = true;
    };
  }, [noteId, notification, message, loadData]);

  // 订阅全局 folders/tags tick：侧边栏/标签页 CRUD 后局部刷新下拉选项，
  // 无需关闭重开 tab。用 ref 跳过首次渲染，避免与 loadData 重复请求。
  const foldersTick = useAppStore((s) => s.foldersRefreshTick);
  const tagsTick = useAppStore((s) => s.tagsRefreshTick);
  const notesTick = useAppStore((s) => s.notesRefreshTick);
  const skipFoldersInit = useRef(true);
  const skipTagsInit = useRef(true);
  const skipNotesInit = useRef(true);
  useEffect(() => {
    if (skipFoldersInit.current) {
      skipFoldersInit.current = false;
      return;
    }
    folderApi
      .list()
      .then((folderTree) => setFolders(folderTree))
      .catch(() => {
        // 刷新失败不打断当前编辑，下次打开时 loadData 会再拉
      });
  }, [foldersTick]);
  useEffect(() => {
    if (skipTagsInit.current) {
      skipTagsInit.current = false;
      return;
    }
    tagApi.list().then(setAllTags).catch(() => {});
  }, [tagsTick]);

  // 文档自身 tick：侧边栏改名 / 外部更新时同步 title 输入框 + meta，
  // 但用户在编辑（dirty）时不动 title 字段，避免冲掉未保存的修改。
  // 用 ref 跳首次（与 loadData 重复）+ ref 读 dirty/title 避免循环依赖。
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  /**
   * 编辑器就绪回调。
   *
   * 除把实例交给大纲/打印等使用外，在首帧稳定后把「编辑器自身的 Markdown 序列化」
   * 作为脏基线：tiptap-markdown 反序列化再序列化会与库/源文件里的原文存在排版差异
   * （列表符号、硬换行、围栏代码块收尾等），这类差异不是用户修改，若按原文比较
   * 就会在"打开即关"时误报未保存。基线对齐后，只有真正的编辑才会落进 dirty。
   */
  const handleEditorReady = useCallback(
    (ed: unknown | null) => {
      setEditorInstance(ed);
      if (!ed) return;
      // 仅当当前是干净状态、且没有待恢复草稿时才对基线（避免把未保存内容当成已保存）
      window.setTimeout(() => {
        if (dirtyRef.current) return;
        if (getDraft(noteId)) return;
        const md = readEditorMarkdown(ed);
        if (typeof md === "string") savedRef.current.content = md;
      }, 0);
    },
    [noteId, getDraft],
  );

  // 跨窗口同步：另一个 webview（主窗 ↔ popout）保存了同一 id 的文档后，
  // 这里通过 Tauri 全局事件 `note:updated` 收到通知。Zustand store 是 per-webview 的，
  // 没法跨进程同步，所以走 Tauri 事件桥。
  // 冲突保护：当前 buffer dirty 时不强制覆盖，弹 notification 让用户决定。
  useEffect(() => {
    if (!noteId) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ id: number; sourceLabel: string }>("note:updated", async (e) => {
      if (cancelled) return;
      const payload = e.payload;
      if (payload.id !== noteId) return;
      if (payload.sourceLabel === CURRENT_WINDOW_LABEL) return; // 自己触发的，忽略

      const reload = async () => {
        try {
          const fresh = await noteApi.get(noteId);
          if (cancelled) return;
          savedRef.current = { title: fresh.title, content: fresh.content };
          setNote(fresh);
          setTitle(fresh.title);
          setContent(fresh.content);
          setDirty(false);
          setTabDirty(noteId, false);
          clearDraft(noteId);
        } catch {
          // 拉失败就不动 buffer
        }
      };

      if (dirtyRef.current) {
        notification.warning({
          key: `note-updated-${noteId}`,
          message: "其他窗口已更新此文档",
          description: "另一个窗口刚刚保存了内容。当前窗口有未保存修改——加载新版本会丢弃这些修改。",
          btn: (
            <Button
              size="small"
              type="primary"
              onClick={() => {
                notification.destroy(`note-updated-${noteId}`);
                void reload();
              }}
            >
              覆盖加载
            </Button>
          ),
          duration: 0, // 永不自动消失
        });
      } else {
        await reload();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [noteId, notification, setTabDirty, clearDraft]);
  useEffect(() => {
    if (skipNotesInit.current) {
      skipNotesInit.current = false;
      return;
    }
    if (!noteId) return;
    let cancelled = false;
    noteApi
      .get(noteId)
      .then((fresh) => {
        if (cancelled) return;
        setNote(fresh);
        if (!dirtyRef.current) {
          savedRef.current = {
            title: fresh.title,
            content: fresh.content,
          };
          setTitle(fresh.title);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [notesTick, noteId]);

  /**
   * 保存当前文档。
   * silent=true 用于"跳转前自动保存"场景：不弹"保存成功"toast，避免干扰用户操作；
   *             但若有未匹配的 wiki 链接仍会弹 warning（这种信息必须告知）。
   */
  async function handleSave(silent = false) {
    // 状态仍属于上一篇文档时禁止写入，避免切文档竞态把旧内容覆盖到新 id
    if (ownedNoteIdRef.current !== noteId) return;
    if (!title.trim()) {
      if (!silent) message.warning("标题不能为空");
      return;
    }

    // 以编辑器里的实时内容为准。点击保存 / Ctrl+S 的瞬间编辑器通常刚失焦，
    // 父组件的 content 还停留在上一次 onChange（300ms 防抖），直接用它保存会丢最后一段输入。
    const latestContent = readEditorMarkdown(editorInstance) ?? content;
    const nextTitle = title.trim();

    // 和已落库版本一致 → 没有真实修改（常见于"打开思维导图/点工具栏导致 blur"
    // 触发的 Markdown 重新序列化）。直接清掉脏标记，不做多余的 IPC + 写回文件。
    if (
      nextTitle === savedRef.current.title &&
      latestContent === savedRef.current.content
    ) {
      if (latestContent !== content) setContent(latestContent);
      setDirty(false);
      setTabDirty(noteId, false);
      clearDraft(noteId);
      if (!silent) message.success("没有需要保存的修改");
      return;
    }

    if (latestContent !== content) setContent(latestContent);

    setSaving(true);
    try {
      const updated = await noteApi.update(noteId, {
        title: nextTitle,
        content: latestContent,
        folder_id: note?.folder_id,
      });
      savedRef.current = { title: updated.title, content: latestContent };
      setNote(updated);
      // 保存期间用户可能继续输入：只有编辑器内容仍等于刚落库的版本才算"已保存"，
      // 否则保留脏标记，交给防抖/自动保存继续把新内容写下去。
      const afterSaveMd = readEditorMarkdown(editorInstance) ?? latestContent;
      const stillClean =
        afterSaveMd === latestContent && title.trim() === nextTitle;
      setDirty(!stillClean);
      setTabDirty(noteId, !stillClean);
      updateTabTitle(noteId, updated.title);
      // 内容已落库，清掉草稿快照
      clearDraft(noteId);

      // 解析 [[]] 链接并同步
      const wikiTitles = extractWikiLinks(latestContent);
      const missing: string[] = [];
      if (wikiTitles.length > 0) {
        const targetIds: number[] = [];
        for (const t of wikiTitles) {
          try {
            const id = await linkApi.findIdByTitle(t);
            if (id != null) {
              targetIds.push(id);
            } else {
              missing.push(t);
            }
          } catch {
            missing.push(t);
          }
        }
        await linkApi.syncLinks(noteId, targetIds).catch(() => {});
      } else {
        await linkApi.syncLinks(noteId, []).catch(() => {});
      }

      if (missing.length > 0) {
        notification.warning({
          message: `已保存，但 ${missing.length} 个 wiki 链接未能匹配到文档`,
          description: (
            <div>
              <ul style={{ margin: "4px 0 8px", paddingLeft: 20, maxHeight: 160, overflow: "auto" }}>
                {missing.map((t) => (
                  <li key={t} style={{ fontSize: 12, wordBreak: "break-all" }}>
                    <code>[[{t}]]</code>
                  </li>
                ))}
              </ul>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                <code>[[标题]]</code> 必须是<strong>完整且精确</strong>的文档标题（忽略首尾空白和大小写），不支持通配符 / 省略号。建议正文里输入 <code>[[</code> 从自动补全菜单选择。
              </div>
            </div>
          ),
          duration: 10,
          placement: "topRight",
        });
      } else if (!silent) {
        message.success("保存成功");
      }

      // 外部 .md 双向同步：若该文档是从 .md 文件打开来的，把当前内容写回原文件
      if (updated.source_file_type === "md" && updated.source_file_path) {
        try {
          const r = await sourceWritebackApi.writeBack(noteId, false);
          if (r.kind === "conflict") {
            // 弹 Modal 让用户选；选"覆盖外部"再调一次 force=true
            Modal.confirm({
              title: "原文件被外部改过",
              content: (
                <div>
                  <p style={{ marginBottom: 4 }}>检测到原文件在本应用之外被修改：</p>
                  <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
                    {r.file_path}
                  </p>
                  <p style={{ marginTop: 8 }}>选择"覆盖外部"会用本应用里的内容覆盖磁盘文件；选"取消"则保留外部修改，本应用的修改仅停留在数据库里。</p>
                </div>
              ),
              okText: "覆盖外部",
              okButtonProps: { danger: true },
              cancelText: "取消",
              onOk: async () => {
                try {
                  await sourceWritebackApi.writeBack(noteId, true);
                  message.success("已覆盖原文件");
                } catch (err) {
                  message.error(`写回失败: ${err}`);
                }
              },
            });
          } else if (r.kind === "missing") {
            notification.warning({
              message: "原文件已不可访问",
              description: "本应用与外部 .md 的双向同步暂时中断，但你的修改已保存到本地数据库。",
              duration: 6,
            });
          } else if (r.kind === "ok" && r.assets_copied > 0 && !silent) {
            message.info(`已同步原文件，新插入 ${r.assets_copied} 个图片复制到旁侧 .assets/`);
          }
        } catch (err) {
          // 写回失败不阻塞保存主流程，只静默记日志
          console.warn("[writeback] failed:", err);
        }
      }
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  // 模块设置中心：停止编辑 N 秒后静默自动保存。
  // 用 ref 持有最新 handleSave，避免定时器闭包拿到旧 state。
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  useEffect(() => {
    if (!dirty || saving || !title.trim()) return;
    const seconds = Number(notesConfig.auto_save_delay);
    const delayMs =
      (Number.isFinite(seconds) ? Math.max(0.5, Math.min(10, seconds)) : 1.2) * 1000;
    const timer = window.setTimeout(() => {
      // 定时器触发时可能刚好有一次手动保存在飞，跳过并等 saving 变化后重新计时
      if (savingRef.current) return;
      void handleSaveRef.current(true);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [dirty, saving, title, content, notesConfig.auto_save_delay]);

  /**
   * 跳转前保护：若当前有未保存修改，先静默保存再跳转，避免内容被新页面 loadData 覆盖丢失。
   * 用于所有 navigate 到其他文档/路由的场景（wiki 链接点击、消歧选择、模糊匹配等）。
   */
  async function ensureSavedBeforeNavigate() {
    if (dirty && title.trim()) {
      await handleSave(true);
    }
  }

  // dirty 时把 (title, content) 节流写入 store 草稿。
  // 用途：editor unmount 后（切 tab / 跳 wiki）下次回来能恢复；关 tab / 退出时能批量持久化。
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      // 同上：内容尚未切到当前文档时不写草稿，否则新文档会"继承"上一篇内容
      if (ownedNoteIdRef.current !== noteId) return;
      setDraft(noteId, { title, content });
    }, 400);
    return () => clearTimeout(t);
  }, [dirty, title, content, noteId, setDraft]);

  // unmount 时强制 flush 一次 draft（防止 400ms debounce 未触发的最后输入丢失）
  // 用 ref 捕获最新 state，避免闭包陷阱
  const flushRef = useRef<{ dirty: boolean; title: string; content: string }>({
    dirty: false, title: "", content: "",
  });
  flushRef.current = { dirty, title, content };
  useEffect(() => {
    return () => {
      const f = flushRef.current;
      if (f.dirty && f.title.trim()) {
        setDraft(noteId, { title: f.title, content: f.content });
      }
    };
  }, [noteId, setDraft]);

  // unmount 时同步把最新内容 fire-and-forget 入库（兜底：点侧边栏换路由 / 关 Tab 等
  // 场景 ensureSavedBeforeNavigate 没覆盖的路径，避免用户切其他功能后内容只活在 store
  // 草稿里、关 app 就丢。组件已卸载无法 await，但 Tauri 进程还在跑，IPC 能完成落库。
  const dbSaveOnUnmountRef = useRef<{
    dirty: boolean;
    title: string;
    content: string;
    folderId: number | null | undefined;
  }>({ dirty: false, title: "", content: "", folderId: null });
  dbSaveOnUnmountRef.current = {
    dirty,
    title,
    content,
    folderId: note?.folder_id,
  };
  useEffect(() => {
    return () => {
      const s = dbSaveOnUnmountRef.current;
      if (!s.dirty || !s.title.trim()) return;
      // 归属校验：卸载时若状态还不是当前 noteId 的内容，宁可不写也不能写错文档
      if (ownedNoteIdRef.current !== noteId) return;
      noteApi
        .update(noteId, {
          title: s.title.trim(),
          content: s.content,
          folder_id: s.folderId,
        })
        .then(() => {
          // 入库成功 → 清掉 store 草稿 & dirty 标记
          useTabsStore.getState().clearDraft(noteId);
          useTabsStore.getState().setTabDirty(noteId, false);
        })
        .catch(() => {
          // 入库失败时 store 里的 draft 保留，下次打开能恢复
        });
    };
  }, [noteId]);

  // Ctrl+S / Cmd+S 保存：用 ref 避免 useEffect 每次渲染都 re-subscribe
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = handleSave;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleDelete() {
    try {
      await noteApi.delete(noteId);
      message.success("删除成功");
      useTabsStore.getState().closeTab(noteId);
      useAppStore.getState().bumpNotesRefresh();
      navigate("/notes");
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleTogglePin() {
    try {
      const isPinned = await noteApi.togglePin(noteId);
      setNote((prev) => (prev ? { ...prev, is_pinned: isPinned } : prev));
      message.success(isPinned ? "已置顶" : "已取消置顶");
    } catch (e) {
      message.error(String(e));
    }
  }

  /**
   * T-003: 切换文档"隐藏"状态。
   * 隐藏后主界面看不到此文档，但保留在当前编辑器 tab 里以便继续编辑；
   * 取消隐藏立即回到普通可见态。
   */
  async function handleToggleHidden() {
    if (!note) return;
    const next = !note.is_hidden;
    try {
      await noteApi.setHidden(noteId, next);
      setNote((prev) => (prev ? { ...prev, is_hidden: next } : prev));
      message.success(next ? "已隐藏（主界面不可见）" : "已取消隐藏");
    } catch (e) {
      message.error(String(e));
    }
  }

  /**
   * T-007: 切换文档加密态。
   *
   * 前置：vault 必须已解锁。未解锁时弹 unlock/setup Modal，解锁后用户需再点一次本按钮。
   *
   * 加密时：读当前 content → 后端调 vault 加密 → content 变成 "🔒 已加密..." 占位；
   * 取消加密时：后端解密得到原文并写回 content。
   * 加密/取消后都重新 loadNote() 拿最新态。
   */
  const [vaultModal, setVaultModal] = useState<{
    open: boolean;
    mode: "setup" | "unlock";
  }>({ open: false, mode: "unlock" });

  async function handleToggleEncrypt() {
    if (!note) return;
    // 先确认 vault 状态
    let vs;
    try {
      vs = await vaultApi.status();
    } catch (e) {
      message.error(`读取 vault 状态失败：${e}`);
      return;
    }
    if (vs === "notset") {
      // 首次设置
      setVaultModal({ open: true, mode: "setup" });
      message.info("请先设置主密码，然后再点加密");
      return;
    }
    if (vs === "locked") {
      setVaultModal({ open: true, mode: "unlock" });
      message.info("请先解锁保险库，然后再点加密");
      return;
    }
    // unlocked
    try {
      if (note.is_encrypted) {
        await vaultApi.disableEncrypt(noteId);
        message.success("已取消加密");
      } else {
        // 先把当前编辑器未保存的 content 落库，否则 encrypt_note 读到的是老内容
        if (dirty) await handleSave(true);
        await vaultApi.encryptNote(noteId);
        message.success("已加密（主界面将显示占位文本）");
      }
      // 重新拉文档以拿到最新 is_encrypted / content 占位符
      const fresh = await noteApi.get(noteId);
      savedRef.current = { title: fresh.title, content: fresh.content };
      setNote(fresh);
      setContent(fresh.content);
      setTitle(fresh.title);
      setDirty(false);
    } catch (e) {
      message.error(String(e));
    }
  }

  /** Ctrl/Cmd + 点击 [[标题]] 时跳转到对应文档 */
  async function handleWikiLinkClick(wikiTitle: string) {
    try {
      const results = await linkApi.searchTargets(wikiTitle, 20);
      const exactMatches = results.filter((item) => item.title === wikiTitle);

      // 精确命中 1 条：直接跳
      if (exactMatches.length === 1) {
        await ensureSavedBeforeNavigate();
        navigate(`/notes/${exactMatches[0].id}`);
        return;
      }

      // 精确命中多条：弹消歧 Modal
      if (exactMatches.length > 1) {
        const notes = await Promise.all(
          exactMatches.map((item) => noteApi.get(item.id).catch(() => null)),
        );
        const valid = notes.filter((n): n is Note => n !== null);
        if (valid.length === 1) {
          await ensureSavedBeforeNavigate();
          navigate(`/notes/${valid[0].id}`);
          return;
        }
        setDisambigTitle(wikiTitle);
        setDisambigItems(valid);
        setDisambigOpen(true);
        return;
      }

      // 无精确匹配但有模糊匹配：跳转相近的第一条
      if (results.length > 0) {
        await ensureSavedBeforeNavigate();
        navigate(`/notes/${results[0].id}`);
        message.info(`未找到同名文档，跳转到相近的「${results[0].title}」`);
        return;
      }

      message.warning(`未找到文档「${wikiTitle}」`);
    } catch (e) {
      message.error(`跳转失败: ${e}`);
    }
  }

  async function handleDisambigSelect(targetId: number) {
    setDisambigOpen(false);
    await ensureSavedBeforeNavigate();
    navigate(`/notes/${targetId}`);
  }

  async function handleOpenSourceFile() {
    try {
      const abs = await sourceFileApi.getAbsolutePath(noteId);
      if (!abs) {
        message.warning("原始文件丢失或未关联");
        return;
      }
      // PDF 用内置 iframe Modal 预览；其他类型（Word 等）用系统默认应用打开
      if (note?.source_file_type === "pdf") {
        setPdfPreviewUrl(convertFileSrc(abs));
        setPdfPreviewAbsPath(abs);
        setPdfPreviewOpen(true);
      } else {
        await openPath(abs);
      }
    } catch (e) {
      message.error(`打开失败: ${e}`);
    }
  }

  async function handleExportNote() {
    const parentDir = await openDialog({
      directory: true,
      title: "选择导出目录",
    });
    if (!parentDir) return;
    try {
      const result = await exportApi.exportSingle(noteId, parentDir as string);
      // 通过 Modal.success 给两个明确的后续操作按钮
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
  }

  /**
   * 导出用的自包含 HTML：优先取编辑器实时 DOM，保住标题自动编号 / callout /
   * mermaid 等只活在渲染层的内容。编辑器未就绪或生成失败时返回 undefined，
   * 后端会退回 Markdown 重渲（批量导出、弹窗初始化等场景）。
   */
  async function buildExportBodyHtml(): Promise<string | undefined> {
    if (!editorInstance) return undefined;
    try {
      return await editorDomToSelfContainedHtml(editorInstance, title);
    } catch (e) {
      console.warn("[export] 生成自包含 HTML 失败，退回 Markdown 渲染:", e);
      return undefined;
    }
  }

  /**
   * 导出用的结构化文档模型：editor.getJSON() + 标题自动编号。
   *
   * 标题编号只活在 ProseMirror decoration 里，JSON 本身没有；按 heading 顺序
   * 单独传给后端，由结构化渲染器补到标题文本前。
   */
  function buildExportBodyJson():
    | { doc: Record<string, unknown>; headingNumbers: string[] }
    | undefined {
    if (!editorInstance) return undefined;
    try {
      return {
        doc: editorInstance.getJSON() as Record<string, unknown>,
        headingNumbers: getHeadingNumberEntries(editorInstance.state).map(
          (entry) => entry.label ?? "",
        ),
      };
    } catch (e) {
      console.warn("[export] 生成结构化 JSON 失败，退回 HTML / Markdown:", e);
      return undefined;
    }
  }

  /** Word 引擎提示：结构化导出最一致，转换器次之，内置生成器会简化复杂版式。 */
  function wordEngineHint(engine: WordExportResult["engine"]): string {
    if (engine === "structured") {
      return "按编辑器文档模型结构化生成，标题/列表/表格/代码块与复杂版式一致性更高";
    }
    return engine === "converter"
      ? "使用本机 Office / WPS / LibreOffice 转换，版式保真度较高"
      : "未检测到 Office / WPS / LibreOffice，已使用内置生成器（复杂版式可能简化）";
  }

  /** T-020: 导出为 Word (.docx) — 用 save dialog 选最终文件路径 */
  async function handleExportWord() {
    const safeName = title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    const filePath = await save({
      defaultPath: `${safeName}.docx`,
      filters: [{ name: "Word", extensions: ["docx"] }],
    });
    if (!filePath) return;
    // 实时 DOM 内嵌图片/附件需要时间，先给 loading 再生成
    const hideLoading = message.loading("正在生成 Word…", 0);
    try {
      // 结构化 JSON 优先（含复杂版式）；HTML 作为后端回退（转换器路径）保留。
      const bodyJson = buildExportBodyJson();
      const bodyHtml = await buildExportBodyHtml();
      const result = await exportApi.exportSingleToWord(
        noteId,
        filePath,
        bodyHtml,
        bodyJson?.doc,
        bodyJson?.headingNumbers,
      );
      hideLoading();
      const parts = [
        `嵌入图片 ${result.imagesEmbedded} 张`,
        result.imagesMissing > 0 ? `${result.imagesMissing} 张缺失，已用占位符替代` : "",
        result.attachmentsInlined > 0 ? `内嵌附件 ${result.attachmentsInlined} 个` : "",
        result.attachmentsCopied > 0
          ? `附件 ${result.attachmentsCopied} 个（已放到同名 .attachments 文件夹）`
          : "",
      ].filter(Boolean);
      Modal.success({
        title: "导出 Word 成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>{parts.join("，")}，文件：</p>
            <p style={{ marginBottom: 4, fontSize: 12, color: token.colorTextSecondary }}>
              {wordEngineHint(result.engine)}
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
      hideLoading();
      message.error(`导出 Word 失败: ${e}`);
    }
  }

  /** T-020: 导出为 HTML — 单文件，图片内嵌 base64，可独立分享 */
  async function handleExportHtml() {
    const safeName = title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    let hideLoading: (() => void) | null = null;
    try {
      // save() 也放进 try：对话框插件调用失败（权限/窗口异常）时若不捕获，
      // Promise 拒绝会被吞掉，用户看到的就是「点了没反应」。
      const filePath = await save({
        defaultPath: `${safeName}.html`,
        filters: [{ name: "HTML", extensions: ["html", "htm"] }],
      });
      if (!filePath) return;
      // 与 Word 相同：实时 DOM 才能保住标题编号 / callout / mermaid
      hideLoading = message.loading("正在生成 HTML…", 0);
      const bodyHtml = await buildExportBodyHtml();
      const result = await exportApi.exportSingleToHtml(noteId, filePath, bodyHtml);
      Modal.success({
        title: "导出 HTML 成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {`内嵌图片 ${result.imagesInlined} 张` +
                (result.imagesMissing > 0
                  ? `（${result.imagesMissing} 张缺失）`
                  : "")}
              {result.attachmentsInlined > 0
                ? `，内嵌附件 ${result.attachmentsInlined} 个`
                : ""}
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
    } finally {
      hideLoading?.();
    }
  }

  /**
   * 延迟到菜单关闭动画结束后再执行动作。
   *
   * 原生保存 / 打印对话框会暂停 WebView 的合成动画：若在菜单 leave 动画
   * 尚未结束时同步打开，rc-motion 永远收不到 animationend，菜单 DOM 会
   * 永久停在 `pointer-events: none` 的关闭态（表现为「点一次之后菜单再也点不动」）。
   */
  function runAfterMenuClose(fn: () => void) {
    setTimeout(fn, 250);
  }

  /** R-005b 打印 / 打印成 PDF：编辑器实时 DOM → 系统打印对话框（可另存为 PDF）。 */
  async function handlePrint() {
    if (!editorInstance) {
      message.warning("编辑器尚未就绪，请稍后再试");
      return;
    }
    // 图多的文档内嵌资源要几秒，先给个 loading；HTML 准备好并交给独立
    // 打印窗口后即可收起——真正的 window.print() 在独立窗口里执行。
    const hideLoading = message.loading("正在准备打印内容…", 0);
    try {
      await printEditorContent(editorInstance, title);
    } catch (e) {
      message.error(`打印准备失败: ${e}`);
    } finally {
      hideLoading();
    }
  }

  async function handleTagsChange(newTagIds: number[]) {
    const currentIds = noteTags.map((t) => t.id);
    const toAdd = newTagIds.filter((id) => !currentIds.includes(id));
    const toRemove = currentIds.filter((id) => !newTagIds.includes(id));

    try {
      for (const tagId of toAdd) {
        await tagApi.addToNote(noteId, tagId);
      }
      for (const tagId of toRemove) {
        await tagApi.removeFromNote(noteId, tagId);
      }
      // 刷新文档标签
      const updatedTags = await tagApi.getNoteTags(noteId);
      setNoteTags(updatedTags);
    } catch (e) {
      message.error(String(e));
    }
  }

  /** 调整单个标签的颜色（点击 tag chip 弹 Popover 触发） */
  async function handleChangeTagColor(tagId: number, color: string | null) {
    try {
      await tagApi.setColor(tagId, color);
      // 本地立即更新当前文档的标签显示，避免等 refresh
      setNoteTags((prev) =>
        prev.map((t) => (t.id === tagId ? { ...t, color } : t)),
      );
      setAllTags((prev) =>
        prev.map((t) => (t.id === tagId ? { ...t, color } : t)),
      );
      // 通知标签页等其他消费者刷新
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  /** 在编辑器里直接创建新标签并挂到当前文档 */
  async function handleCreateTag(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    // 同名已存在 → 直接复用（不重复创建）
    const existing = allTags.find((t) => t.name === trimmed);
    try {
      const tag = existing ?? (await tagApi.create(trimmed));
      if (!existing) {
        setAllTags((prev) => [...prev, tag]);
        // 通知其他消费者（标签页/其他编辑器 tab）刷新标签列表
        useAppStore.getState().bumpTagsRefresh();
      }
      await tagApi.addToNote(noteId, tag.id);
      const updatedTags = await tagApi.getNoteTags(noteId);
      setNoteTags(updatedTags);
      message.success(existing ? `已添加「${trimmed}」` : `已创建并添加「${trimmed}」`);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleFolderChange(folderId: number | null) {
    try {
      await noteApi.moveToFolder(noteId, folderId);
      setNote((prev) => (prev ? { ...prev, folder_id: folderId } : prev));
      // 通知侧边栏 NotesPanel 重拉「未分类」+「目标文件夹」文档列表，
      // 否则在编辑器里改完目录，左侧侧边栏对应位置不会出现这条文档
      useAppStore.getState().bumpNotesRefresh();
      useAppStore.getState().bumpFoldersRefresh();
      message.success("已移动");
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleTitleChange(val: string) {
    setTitle(val);
    // 只和"已落库版本"比较：blur / 打开思维导图时的无改动回传不应点亮"未保存"
    const nextDirty = val.trim() !== savedRef.current.title;
    setDirty(nextDirty);
    setTabDirty(noteId, nextDirty);
    updateTabTitle(noteId, val || "未命名");
  }

  function handleContentChange(val: string) {
    setContent(val);
    const nextDirty = val !== savedRef.current.content;
    setDirty(nextDirty);
    setTabDirty(noteId, nextDirty);
  }

  if (loading) {
    return (
      <div className="editor-page">
        <div className="flex items-center justify-center flex-1">
          <Spin size="large" />
        </div>
      </div>
    );
  }

  return (
    <div className="editor-page">
      {/* 顶部工具栏 */}
      <div className="editor-topbar">
        <Space align="center">
          <Button
            icon={<ArrowLeft size={16} />}
            onClick={() => {
              // 有历史栈（从 /tasks、/search、/daily 等跳进来）就 back
              // 否则回文档列表作为默认目的地
              if (window.history.length > 1) {
                navigate(-1);
              } else {
                navigate("/notes");
              }
            }}
          >
            返回
          </Button>
          {note && (
            <Text type="secondary">
              更新于 {relativeTime(note.updated_at)}
            </Text>
          )}
          {dirty && <Text type="warning">未保存</Text>}
        </Space>
        <Space align="center">
          <Tooltip title={focusMode ? "退出专注模式 (Esc)" : "专注模式 (F11)"}>
            <Button
              icon={focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              onClick={() => setFocusMode(!focusMode)}
            />
          </Tooltip>
          <Tooltip title={note?.is_pinned ? "取消置顶" : "置顶"}>
            <Button
              type={note?.is_pinned ? "primary" : "default"}
              icon={<Pin size={16} />}
              onClick={handleTogglePin}
            />
          </Tooltip>
          <Tooltip
            title={
              note?.is_hidden
                ? "取消隐藏（回到主列表）"
                : "隐藏此文档（主列表/搜索/图谱不可见）"
            }
          >
            <Button
              type={note?.is_hidden ? "primary" : "default"}
              icon={note?.is_hidden ? <EyeOff size={16} /> : <Eye size={16} />}
              onClick={handleToggleHidden}
            />
          </Tooltip>
          <Tooltip
            title={
              note?.is_encrypted
                ? "取消加密（恢复为普通文档）"
                : "加密此文档（需先设置并解锁主密码）"
            }
          >
            <Button
              type={note?.is_encrypted ? "primary" : "default"}
              icon={note?.is_encrypted ? <Lock size={16} /> : <Unlock size={16} />}
              onClick={handleToggleEncrypt}
            />
          </Tooltip>
          <Tooltip
            title={
              mindMapOpen || graphPanelOpen
                ? "右侧面板打开期间大纲已暂时隐藏（关闭面板后恢复）"
                : outlineVisible
                  ? "隐藏大纲"
                  : "显示大纲"
            }
          >
            <Button
              type={effectiveOutlineVisible ? "primary" : "default"}
              icon={<ListTree size={16} />}
              onClick={toggleOutline}
              disabled={mindMapOpen || graphPanelOpen}
            />
          </Tooltip>
          <Tooltip title="思维导图（只读视图）">
            <Button
              icon={<Network size={16} />}
              onClick={() => {
                setGraphPanelOpen(false);
                setMindMapOpen(true);
              }}
            />
          </Tooltip>
          <Tooltip title="文档图谱（右侧分栏）">
            <Button
              type={graphPanelOpen ? "primary" : "default"}
              icon={<GitBranch size={16} />}
              title="查看文档图谱"
              onClick={() => {
                if (!Number.isFinite(noteId)) return;
                setMindMapOpen(false);
                setGraphPanelOpen((v) => !v);
              }}
            />
          </Tooltip>
          {/* popout 窗口里再点这个按钮没有意义（同 id 只会前置已存在窗口），直接隐藏 */}
          {!IS_POPOUT_WINDOW && (
            <Tooltip title="新窗口打开">
              <Button
                icon={<ExternalLink size={16} />}
                onClick={async () => {
                  if (!noteId) return;
                  // 弹新窗口前先把未保存内容落库，避免 pop-out 看到老版本
                  if (dirty) await handleSave(true);
                  try {
                    await noteApi.openInNewWindow(noteId);
                  } catch (e) {
                    message.error(`打开新窗口失败：${e}`);
                  }
                }}
              />
            </Tooltip>
          )}
          <Tooltip
            title={
              backlinks.length > 0
                ? `${backlinks.length} 条反向链接 — 点击滚动到底部查看`
                : "反向链接（暂无）— 点击查看说明"
            }
          >
            <Badge
              count={backlinks.length}
              size="small"
              offset={[-2, 2]}
              color={backlinks.length > 0 ? undefined : "#bfbfbf"}
            >
              <Button
                icon={<Link2 size={16} />}
                onClick={() => {
                  document
                    .getElementById("backlinks-panel")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              />
            </Badge>
          </Tooltip>
          <Button
            type="primary"
            icon={<Save size={16} />}
            loading={saving}
            onClick={() => handleSave()}
            disabled={!dirty}
          >
            保存
          </Button>
          {note?.source_file_path && (
            <Tooltip
              title={
                note?.source_file_type === "pdf"
                  ? "查看原始 PDF"
                  : "用系统默认应用打开原始文件"
              }
            >
              <Button
                icon={<FileTextIcon size={16} />}
                onClick={handleOpenSourceFile}
              >
                {note?.source_file_type === "pdf"
                  ? "PDF"
                  : (note?.source_file_type ?? "源文件").toUpperCase()}
              </Button>
            </Tooltip>
          )}
          {/* T-020 导出按钮：默认导出 Markdown；右侧下拉可选 Word / HTML */}
          <Space.Compact>
            <Tooltip title="导出为 Markdown">
              <Button
                icon={<Share size={16} />}
                onClick={handleExportNote}
              />
            </Tooltip>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "md",
                    label: "导出为 Markdown",
                    onClick: () => runAfterMenuClose(() => void handleExportNote()),
                  },
                  {
                    key: "docx",
                    label: "导出为 Word (.docx)",
                    onClick: () => runAfterMenuClose(() => void handleExportWord()),
                  },
                  {
                    key: "html",
                    label: "导出为 HTML (单文件)",
                    onClick: () => runAfterMenuClose(() => void handleExportHtml()),
                  },
                  { type: "divider" },
                  {
                    key: "print",
                    label: "打印 / 打印成 PDF",
                    icon: <Printer size={14} />,
                    onClick: () => runAfterMenuClose(() => void handlePrint()),
                  },
                ],
              }}
            >
              <Button icon={<ChevronDown size={14} />} title="更多导出格式" />
            </Dropdown>
          </Space.Compact>
          <Tooltip title="问 AI">
            <Button
              icon={<MessageSquare size={16} />}
              onClick={async () => {
                // 先确保未保存内容已落库，否则 AI 拿到的还是老正文
                if (dirty) await handleSave(true);
                setAiSelection(undefined);
                setAiDrawerOpen(true);
              }}
            />
          </Tooltip>
          <Popconfirm title="确认删除此文档？" onConfirm={handleDelete}>
            <Button danger icon={<Trash2 size={16} />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {/* 编辑器 + 思维导图 横向分栏容器（mindMapOpen=true 时变两栏，否则编辑器独占） */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "row",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
      {/* 可滚动的编辑主体 */}
      <div
        className="editor-body"
        ref={editorBodyRef}
        data-outline={effectiveOutlineVisible ? "on" : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          ...(effectiveOutlineVisible && {
            // 覆盖 CSS 里固定的 200px：1fr | 6px 分隔 | 自适应宽度的大纲列
            gridTemplateColumns: `minmax(0, 1fr) 6px ${outlineWidth}px`,
          }),
        }}
      >
        <div className="editor-content-area">
          {/* 标题：用 position:relative 父级 + 绝对定位 mic / clear 模拟 suffix。
              不直接用 antd Input.suffix / allowClear——两者都会包一层
              .ant-input-affix-wrapper 把 borderless 大标题撑成白底大框。 */}
          <div style={{ position: "relative" }}>
            <Input
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="文档标题"
              variant="borderless"
              className="editor-title"
              style={{ paddingRight: 64 }}
            />
            <div
              style={{
                position: "absolute",
                right: 4,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {title && (
                // 与 antd allowClear 视觉一致：CloseCircleFilled 灰色实心圆 ×，hover 加深
                <CloseCircleFilled
                  onClick={() => handleTitleChange("")}
                  title="清空"
                  style={{
                    cursor: "pointer",
                    fontSize: 14,
                    color: "rgba(0, 0, 0, 0.25)",
                    transition: "color 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as unknown as HTMLElement).style.color =
                      "rgba(0, 0, 0, 0.45)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as unknown as HTMLElement).style.color =
                      "rgba(0, 0, 0, 0.25)";
                  }}
                />
              )}
              <MicButton
                stripTrailingPunctuation
                onTranscribed={(text) =>
                  handleTitleChange(title ? `${title} ${text}` : text)
                }
              />
            </div>
          </div>

          {/* 文件夹 + 标签元数据 */}
          <div className="editor-meta">
            <MetaBar
              noteTags={noteTags}
              allTags={allTags}
              folders={folders}
              folderId={note?.folder_id ?? null}
              editor={editorInstance}
              showWordCount={notesConfig.show_word_count}
              onTagsChange={handleTagsChange}
              onFolderChange={handleFolderChange}
              onCreateTag={handleCreateTag}
              onChangeTagColor={handleChangeTagColor}
              tagsReadOnly={tagsReadOnly}
              tagsReadOnlyHint={tagsReadOnlyHint}
            />
          </div>

          {/* 内容编辑区 */}
          <TiptapEditor
            content={content}
            onChange={handleContentChange}
            placeholder="开始写点什么..."
            noteId={noteId}
            onWikiLinkClick={handleWikiLinkClick}
            onAskAi={(selected) => {
              // 选段触发 → 选段挂到抽屉的"引用 chip"，输入框留空给用户写问题
              setAiSelection(selected);
              setAiDrawerOpen(true);
            }}
            onEditorReady={handleEditorReady}
          />

          {/* 反向链接 */}
          <BacklinksPanel
            backlinks={backlinks}
            onNavigate={async (id) => {
              await ensureSavedBeforeNavigate();
              navigate(`/notes/${id}`);
            }}
          />
        </div>

        {/* 大纲左侧拖拽分隔条：6px 宽，col-resize；与思维导图分隔条同模式：
            mousedown 进入拖拽态 → 全局 mousemove 调宽 → mouseup 解绑落库 */}
        {effectiveOutlineVisible && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整大纲宽度（双击还原默认）"
            className="editor-outline-splitter"
            onMouseDown={(e) => {
              e.preventDefault();
              outlineDragRef.current = {
                startX: e.clientX,
                startWidth: outlineWidth,
                latest: outlineWidth,
              };
              const handleMove = (ev: MouseEvent) => {
                const ref = outlineDragRef.current;
                if (!ref) return;
                // 鼠标向左 → 大纲变宽（X 减小）
                const delta = ref.startX - ev.clientX;
                const next = Math.max(160, Math.min(480, ref.startWidth + delta));
                ref.latest = next;
                setOutlineWidth(next);
              };
              const handleUp = () => {
                window.removeEventListener("mousemove", handleMove);
                window.removeEventListener("mouseup", handleUp);
                const ref = outlineDragRef.current;
                if (ref) {
                  localStorage.setItem("editor.outlineWidth", String(ref.latest));
                  outlineDragRef.current = null;
                }
              };
              window.addEventListener("mousemove", handleMove);
              window.addEventListener("mouseup", handleUp);
            }}
            onDoubleClick={() => {
              setOutlineWidth(OUTLINE_DEFAULT_WIDTH);
              localStorage.setItem(
                "editor.outlineWidth",
                String(OUTLINE_DEFAULT_WIDTH),
              );
            }}
          />
        )}

        {/* 右侧大纲面板：sticky 跟随滚动；用户偏好关闭 / 思维导图打开 时自隐 */}
        {effectiveOutlineVisible && (
          <aside className="editor-outline-aside">
            <EditorOutline
              editor={editorInstance}
              scrollRoot={editorBodyRef.current}
              onHide={toggleOutline}
            />
          </aside>
        )}
      </div>

      {/* 思维导图分栏拖拽手柄：6px 宽，col-resize；onMouseDown 进入拖拽态，
          全局 mousemove 调宽度，mouseup 解绑并落库 */}
      {mindMapOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整思维导图宽度"
          onMouseDown={(e) => {
            e.preventDefault();
            splitterDragRef.current = {
              startX: e.clientX,
              startWidth: mindMapWidth,
              latest: mindMapWidth,
            };
            const handleMove = (ev: MouseEvent) => {
              const ref = splitterDragRef.current;
              if (!ref) return;
              // 向左拖 → 导图变宽（鼠标 X 减小）；反之变窄
              const delta = ref.startX - ev.clientX;
              const next = Math.max(320, Math.min(1200, ref.startWidth + delta));
              ref.latest = next;
              setMindMapWidth(next);
            };
            const handleUp = () => {
              window.removeEventListener("mousemove", handleMove);
              window.removeEventListener("mouseup", handleUp);
              const ref = splitterDragRef.current;
              if (ref) {
                localStorage.setItem("editor.mindMapWidth", String(ref.latest));
                splitterDragRef.current = null;
              }
            };
            window.addEventListener("mousemove", handleMove);
            window.addEventListener("mouseup", handleUp);
          }}
          style={{
            width: 6,
            cursor: "col-resize",
            background: "transparent",
            flexShrink: 0,
          }}
          className="hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
        />
      )}

      {/* 思维导图分栏：仅 mindMapOpen 时挂载 */}
      {mindMapOpen && (
        <div
          style={{
            width: mindMapWidth,
            flexShrink: 0,
            minWidth: 320,
            height: "100%",
          }}
        >
          <MindMapView
            open={mindMapOpen}
            onClose={() => setMindMapOpen(false)}
            markdown={content}
            title={title}
          />
        </div>
      )}

      {/* 文档图谱分栏拖拽手柄 */}
      {graphPanelOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整右侧面板宽度"
          onMouseDown={(e) => {
            e.preventDefault();
            splitterDragRef.current = {
              startX: e.clientX,
              startWidth: mindMapWidth,
              latest: mindMapWidth,
            };
            const handleMove = (ev: MouseEvent) => {
              const ref = splitterDragRef.current;
              if (!ref) return;
              const delta = ref.startX - ev.clientX;
              const next = Math.max(320, Math.min(1200, ref.startWidth + delta));
              ref.latest = next;
              setMindMapWidth(next);
            };
            const handleUp = () => {
              window.removeEventListener("mousemove", handleMove);
              window.removeEventListener("mouseup", handleUp);
              const ref = splitterDragRef.current;
              if (ref) {
                localStorage.setItem("editor.mindMapWidth", String(ref.latest));
                splitterDragRef.current = null;
              }
            };
            window.addEventListener("mousemove", handleMove);
            window.addEventListener("mouseup", handleUp);
          }}
          style={{
            width: 6,
            cursor: "col-resize",
            background: "transparent",
            flexShrink: 0,
          }}
          className="hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
        />
      )}

      {/* 文档图谱分栏：仅 graphPanelOpen 时挂载 */}
      {graphPanelOpen && (
        <div
          style={{
            width: mindMapWidth,
            flexShrink: 0,
            minWidth: 320,
            height: "100%",
          }}
        >
          <NoteGraphView
            open={graphPanelOpen}
            noteId={noteId}
            onClose={() => setGraphPanelOpen(false)}
          />
        </div>
      )}
      </div>

      {/* PDF 原文件预览 */}
      <Modal
        open={pdfPreviewOpen}
        title={
          <div
            className="flex items-center justify-between"
            style={{ paddingRight: 32, gap: 8 }}
          >
            <span className="truncate" style={{ minWidth: 0 }}>
              {note?.title ? `${note.title} · 原始 PDF` : "原始 PDF"}
            </span>
            <Space size={4}>
              <Tooltip
                title={pdfPreviewMaximized ? "还原窗口" : "最大化"}
              >
                <Button
                  size="small"
                  type="text"
                  icon={
                    pdfPreviewMaximized ? (
                      <Minimize2 size={14} />
                    ) : (
                      <Maximize2 size={14} />
                    )
                  }
                  onClick={() => setPdfPreviewMaximized((v) => !v)}
                />
              </Tooltip>
              {/*
                兜底按钮：部分 WebView2（较老版本 / 更严格的 CSP 配置）会拦截
                iframe 加载 asset: 协议并显示"已阻止此内容"。点这个按钮可
                立即切到系统 PDF 阅读器，避免卡在空白页。
              */}
              <Button
                size="small"
                icon={<FolderOpen size={14} />}
                onClick={async () => {
                  if (!pdfPreviewAbsPath) return;
                  try {
                    await openPath(pdfPreviewAbsPath);
                    setPdfPreviewOpen(false);
                  } catch (e) {
                    message.error(`打开失败: ${e}`);
                  }
                }}
              >
                用系统应用打开
              </Button>
            </Space>
          </div>
        }
        footer={null}
        onCancel={() => {
          setPdfPreviewOpen(false);
          // 下次打开回到默认"大窗口"态，避免总是全屏打扰
          setPdfPreviewMaximized(false);
        }}
        width={pdfPreviewMaximized ? "100vw" : "85vw"}
        style={
          pdfPreviewMaximized
            ? { top: 0, paddingBottom: 0, maxWidth: "100vw", margin: 0 }
            : { top: 30 }
        }
        styles={{
          body: {
            padding: 0,
            height: pdfPreviewMaximized ? "calc(100vh - 56px)" : "78vh",
          },
        }}
        destroyOnHidden
      >
        {pdfPreviewUrl && (
          <iframe
            src={pdfPreviewUrl}
            title="PDF 预览"
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        )}
      </Modal>

      {/* 同名文档消歧 */}
      <Modal
        open={disambigOpen}
        title={`「${disambigTitle}」存在 ${disambigItems.length} 条同名文档`}
        footer={null}
        onCancel={() => setDisambigOpen(false)}
        width={520}
      >
        <Text type="secondary" style={{ fontSize: 13 }}>
          请选择要打开的那一条：
        </Text>
        <List
          size="small"
          style={{ marginTop: 12 }}
          dataSource={disambigItems}
          renderItem={(item) => (
            <List.Item
              style={{ cursor: "pointer" }}
              onClick={() => handleDisambigSelect(item.id)}
            >
              <List.Item.Meta
                title={item.title}
                description={
                  <span style={{ fontSize: 12 }}>
                    {item.folder_id ? `文件夹 #${item.folder_id}` : "未分类"}
                    {" · "}
                    更新于 {relativeTime(item.updated_at)}
                  </span>
                }
              />
            </List.Item>
          )}
        />
      </Modal>

      <NoteAiDrawer
        noteId={noteId}
        open={aiDrawerOpen}
        onClose={() => setAiDrawerOpen(false)}
        pendingSelection={aiSelection}
      />

      <VaultModal
        open={vaultModal.open}
        mode={vaultModal.mode}
        onClose={() => setVaultModal((s) => ({ ...s, open: false }))}
        onSuccess={() => {
          message.info("保险库已就绪，再次点击锁图标即可加密此文档");
        }}
      />

      {/* 文档内附件/三维模型预览：挂在编辑页根部，路由切换时自动卸载 */}
      <AttachmentPreviewModal />
    </div>
  );
}

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileNoteEditor } from "./MobileNoteEditor";

export default function NoteEditorPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileNoteEditor /> : <DesktopNoteEditorPage />;
}
