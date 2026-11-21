import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Tree, Tooltip, theme as antdTheme, message } from "antd";
import type { DataNode } from "antd/es/tree";
import {
  ChevronsDownUp,
  Eye,
  EyeOff,
  Files,
  Folder as FolderIcon,
  FolderX,
  Layers,
} from "lucide-react";
import { folderApi, hiddenApi } from "@/lib/api";
import { useModuleConfig } from "@/hooks/useModuleConfig";
import { DocSectionTabs } from "./DocSectionTabs";
import { PanelSectionHeader } from "./PanelSectionHeader";
import type { Folder, HiddenFolderCount, Note } from "@/types";

/**
 * HiddenPanel —— "隐藏文档"视图的侧边栏。
 *
 * 展示**完整文件夹树**（保留父子层级），而不是只列出"含隐藏文档的目录"的扁平清单：
 * 隐藏文档本质是普通文档的 is_hidden 标记，用户需要在熟悉的目录结构里定位它们。
 * 含隐藏文档的目录旁加一个眼睛小图标做提示；不阻止选择没有隐藏文档的目录
 * （主区会显示空列表），这样结构始终完整、不会因为某个目录被清空而"跳变"。
 *
 * 选中态走 URL：`/hidden`（全部）/ `/hidden?folder=uncategorized` / `/hidden?folder=N`。
 */

export function HiddenPanel() {
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const selectedKey = searchParams.get("folder") ?? "all";

  // 与文档面板共用同一开关：是否显示文件夹下文档总数
  const { values: notesConfig } = useModuleConfig("notes", {
    show_folder_note_count: true,
  });
  const showNoteCount = notesConfig.show_folder_note_count !== false;

  // 完整文件夹树（folderApi.list 返回已组好 children 的树）
  const [folders, setFolders] = useState<Folder[]>([]);
  // 每个文件夹下的隐藏文档数量（folderId 为 null = 未分类）
  const [hiddenCounts, setHiddenCounts] = useState<HiddenFolderCount[]>([]);
  // 展开节点：默认展开整棵树，保留用户手动折叠的状态
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  // 是否在树上显示隐藏文档本身（与文档面板共用同一偏好）
  const [showFilesInTree, setShowFilesInTree] = useState<boolean>(() => {
    try {
      return localStorage.getItem("notes.showFilesInTree") !== "0";
    } catch {
      return true;
    }
  });
  function toggleShowFilesInTree() {
    setShowFilesInTree((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("notes.showFilesInTree", next ? "1" : "0");
      } catch {
        /* 忽略持久化失败 */
      }
      return next;
    });
  }
  // 隐藏文档本体（仅在「显示文件」开启时用于渲染叶子节点）
  const [hiddenNotes, setHiddenNotes] = useState<Note[]>([]);

  async function loadHiddenCounts() {
    try {
      setHiddenCounts(await hiddenApi.listFolderCounts());
    } catch (e) {
      message.error(`加载隐藏文档统计失败: ${e}`);
    }
  }

  useEffect(() => {
    folderApi
      .list()
      .then((list: Folder[]) => setFolders(list))
      .catch((e) => console.warn("[hidden-panel] 加载文件夹失败:", e));
    void loadHiddenCounts();
  }, []);

  // URL 切换 / 取消隐藏后重拉统计，数量与眼睛标记保持准确
  useEffect(() => {
    void loadHiddenCounts();
  }, [searchParams.toString()]);

  // 「显示文件」开启时拉取全部隐藏文档本体，按目录分桶挂到树上
  // （后端 list 的 page_size 上限是 100，这里分页拉全）
  useEffect(() => {
    if (!showFilesInTree) return;
    let cancelled = false;
    void (async () => {
      const all: Note[] = [];
      try {
        for (let page = 1; page <= 100; page += 1) {
          const r = await hiddenApi.list({ page, pageSize: 100 });
          if (cancelled) return;
          all.push(...r.items);
          if (all.length >= r.total || r.items.length === 0) break;
        }
        if (!cancelled) setHiddenNotes(all);
      } catch (e) {
        console.warn("[hidden-panel] 加载隐藏文档失败:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showFilesInTree]);

  /** folderId → 隐藏文档（null = 未分类） */
  const notesByFolder = useMemo(() => {
    const map = new Map<number | null, Note[]>();
    for (const note of hiddenNotes) {
      const key = note.folder_id ?? null;
      const list = map.get(key);
      if (list) list.push(note);
      else map.set(key, [note]);
    }
    return map;
  }, [hiddenNotes]);

  /** 收集所有文件夹 key，用于默认展开完整结构 */
  const allFolderKeys = useMemo(() => {
    const keys: React.Key[] = [];
    const walk = (list: Folder[]) => {
      for (const f of list) {
        keys.push(String(f.id));
        if (f.children?.length) walk(f.children);
      }
    };
    walk(folders);
    return keys;
  }, [folders]);

  // 树结构第一次拿到（或结构变化）时整体展开
  useEffect(() => {
    setExpandedKeys(allFolderKeys);
  }, [allFolderKeys]);

  /** folderId → 该目录下的隐藏文档数 */
  const hiddenCountMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const item of hiddenCounts) {
      if (item.folderId != null) map.set(item.folderId, item.count);
    }
    return map;
  }, [hiddenCounts]);
  /** 未分类隐藏文档数；无未分类隐藏文档时为 0 */
  const uncategorizedCount =
    hiddenCounts.find((item) => item.folderId == null)?.count ?? 0;
  const hasUncategorized = uncategorizedCount > 0;

  const treeData = useMemo<DataNode[]>(() => {
    /** 某目录下的隐藏文档叶子（「显示文件」关闭时不渲染） */
    const noteLeaves = (folderId: number | null): DataNode[] =>
      !showFilesInTree
        ? []
        : (notesByFolder.get(folderId) ?? []).map((n) => ({
            key: `note:${n.id}`,
            title: (
              <span className="truncate">{n.title || "未命名"}</span>
            ),
            isLeaf: true,
          }));

    const build = (list: Folder[]): DataNode[] =>
      list.map((f) => {
        const children: DataNode[] = [
          ...(f.children?.length ? build(f.children) : []),
          ...noteLeaves(f.id),
        ];
        return {
          key: String(f.id),
          title: (
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className="truncate">
                {/* 隐藏文档页只统计"该目录下的隐藏文档数"，不是全部文档数 */}
                {showNoteCount
                  ? `${f.name}[${hiddenCountMap.get(f.id) ?? 0}]`
                  : f.name}
              </span>
              {(hiddenCountMap.get(f.id) ?? 0) > 0 && (
                <EyeOff
                  size={11}
                  style={{ color: token.colorTextTertiary, flexShrink: 0 }}
                  aria-label="含隐藏文档"
                />
              )}
            </span>
          ),
          icon: (
            <FolderIcon
              size={14}
              style={{ color: token.colorTextSecondary, flexShrink: 0 }}
            />
          ),
          children: children.length ? children : undefined,
        };
      });

    const nodes: DataNode[] = [
      {
        key: "all",
        title: "全部隐藏文档",
        icon: <Layers size={14} style={{ color: token.colorPrimary }} />,
      },
    ];
    if (hasUncategorized) {
      const uncatLeaves = noteLeaves(null);
      nodes.push({
        key: "uncategorized",
        title: showNoteCount ? `未分类[${uncategorizedCount}]` : "未分类",
        icon: <FolderX size={14} style={{ color: token.colorTextSecondary }} />,
        children: uncatLeaves.length ? uncatLeaves : undefined,
      });
    }
    nodes.push(...build(folders));
    return nodes;
  }, [
    folders,
    hiddenCountMap,
    hasUncategorized,
    uncategorizedCount,
    token,
    showNoteCount,
    showFilesInTree,
    notesByFolder,
  ]);

  function handleSelect(key: string) {
    if (key === "all") navigate("/hidden");
    else navigate(`/hidden?folder=${encodeURIComponent(key)}`);
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
      // 本面板纯目录导航 + 无 input → 顶层兜底吞 WebView 默认菜单
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 与文档面板共用同一条「文件夹 | 标签」顶栏 */}
      <DocSectionTabs scope="hidden" />

      {/* 视图标题（与文档面板共用同一高度，避免切换时跳动） */}
      <PanelSectionHeader>
        <div className="flex min-w-0 items-center gap-2" style={{ flex: 1 }}>
        <EyeOff size={15} style={{ color: token.colorPrimary, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          隐藏文档
        </span>
        <span
          style={{
            fontSize: 11,
            color: token.colorTextTertiary,
            marginLeft: 2,
          }}
        >
          · {hiddenCountMap.size + (hasUncategorized ? 1 : 0)}
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Button
            type="text"
            size="small"
            icon={<ChevronsDownUp size={14} />}
            onClick={() => {
              // 折叠 / 展开全部文件夹（本地状态，默认全展开）
              const allExpanded =
                allFolderKeys.length > 0 &&
                allFolderKeys.every((k) => expandedKeys.includes(k));
              setExpandedKeys(allExpanded ? [] : [...allFolderKeys]);
            }}
            style={{ width: 24, height: 24, padding: 0 }}
            title="折叠/展开全部"
          />
          <Tooltip
            title={showFilesInTree ? "隐藏文件（仅显示文件夹）" : "显示文件"}
            mouseEnterDelay={0.3}
          >
            <Button
              type="text"
              size="small"
              aria-label={showFilesInTree ? "隐藏文件" : "显示文件"}
              icon={
                <Files
                  size={14}
                  style={{
                    color: showFilesInTree
                      ? token.colorPrimary
                      : token.colorTextTertiary,
                  }}
                />
              }
              onClick={toggleShowFilesInTree}
              style={{ width: 24, height: 24, padding: 0 }}
            />
          </Tooltip>
          <Tooltip title="返回文档" mouseEnterDelay={0.3}>
            <Button
              type="text"
              size="small"
              aria-label="返回文档"
              icon={<Eye size={14} />}
              onClick={() => navigate("/notes")}
              style={{ width: 24, height: 24, padding: 0 }}
            />
          </Tooltip>
        </div>
        </div>
      </PanelSectionHeader>

      {/* 完整文件夹树 */}
      <div className="flex-1 overflow-auto" style={{ minHeight: 0, padding: "6px 4px 8px" }}>
        <Tree
          blockNode
          showIcon
          treeData={treeData}
          expandedKeys={expandedKeys}
          onExpand={(keys) => setExpandedKeys(keys)}
          selectedKeys={[selectedKey]}
          onSelect={(keys) => {
            const key = keys[0];
            // 点击已选中节点时 antd 会返回空数组：保持当前选择，不跳转
            if (key == null) return;
            const k = String(key);
            // 文档叶子：直接打开对应文档（白板会由编辑器重定向到画布页）
            if (k.startsWith("note:")) {
              navigate(`/notes/${k.slice("note:".length)}`);
              return;
            }
            handleSelect(k);
          }}
        />
      </div>
    </div>
  );
}
