/**
 * 外部目录（文档来源）文件列表的两种展示数据。
 *
 * - buildTree：原始树形，按 relPath 目录层级分组，可逐级折叠
 * - buildFlatList：扁平列表，不显示文件夹节点和折叠箭头
 *
 * 供 /mounts 完整管理页与设置抽屉里的内嵌文件浏览共用。
 */
import { Tag } from "antd";
import type { DataNode } from "antd/es/tree";
import { FolderOpen } from "lucide-react";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import type { ExternalEntry, ExternalSyncState } from "@/types";

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

export function SyncStateTag({ state }: { state: ExternalSyncState }) {
  const config: Record<ExternalSyncState, { color: string; label: string }> = {
    synced: { color: "success", label: "已同步" },
    stale: { color: "warning", label: "待同步" },
    failed: { color: "error", label: "失败" },
    missing: { color: "default", label: "缺失" },
    paused: { color: "default", label: "已暂停" },
  };
  const cfg = config[state] ?? { color: "default", label: state };
  return (
    <Tag color={cfg.color} style={{ marginInlineEnd: 0 }}>
      {cfg.label}
    </Tag>
  );
}

interface TreeNode {
  key: string;
  name: string;
  children: Map<string, TreeNode>;
  entry?: ExternalEntry;
}

/** 原始树形列表：按 relPath 的目录层级分组，可逐级折叠 */
export function buildTree(entries: ExternalEntry[]): DataNode[] {
  const root = new Map<string, TreeNode>();
  const ensure = (
    map: Map<string, TreeNode>,
    key: string,
    name: string,
  ): TreeNode => {
    let node = map.get(key);
    if (!node) {
      node = { key, name, children: new Map() };
      map.set(key, node);
    }
    return node;
  };

  for (const entry of entries) {
    const parts = entry.relPath.split("/").filter(Boolean);
    let cursor = root;
    let prefix = "";
    parts.forEach((part, idx) => {
      prefix = prefix ? `${prefix}/${part}` : part;
      const node = ensure(cursor, prefix, part);
      if (idx === parts.length - 1) node.entry = entry;
      cursor = node.children;
    });
  }

  const convert = (map: Map<string, TreeNode>): DataNode[] =>
    Array.from(map.values())
      .sort((a, b) => {
        // 文件夹在前，文件在后
        const aDir = a.children.size > 0;
        const bDir = b.children.size > 0;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      })
      .map((node) => {
        const entry = node.entry;
        return {
          key: node.key,
          title: entry ? (
            <span className="flex w-full min-w-0 items-center gap-2">
              <FileTypeIcon
                type={entry.sourceType || entry.relPath.split(".").pop() || null}
                size={14}
              />
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate">{entry.title || node.name}</span>
                {entry.userEdited && (
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                    本地已编辑
                  </Tag>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs opacity-80">
                <span>{formatSize(entry.size)}</span>
                <SyncStateTag state={entry.syncState} />
              </span>
            </span>
          ) : (
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <FolderOpen size={14} />
              <span className="truncate">{node.name}</span>
            </span>
          ),
          isLeaf: !node.children.size,
          children: node.children.size ? convert(node.children) : undefined,
          // 自定义字段挂到 node 上，供 onSelect 判断打开方式
          ...(entry ? { noteId: entry.noteId, entry } : {}),
        };
      });
  return convert(root);
}

/**
 * 扁平文件列表：不显示文件夹节点和折叠箭头。
 * 用相对目录作为副标题，避免不同目录下的同名文件无法区分。
 */
export function buildFlatList(entries: ExternalEntry[]): DataNode[] {
  return entries
    .slice()
    .sort((a, b) => a.relPath.localeCompare(b.relPath, "zh-CN"))
    .map((entry) => {
      const parts = entry.relPath.split("/").filter(Boolean);
      const fileName = parts[parts.length - 1] ?? entry.relPath;
      const dir = parts.slice(0, -1).join("/");
      return {
        key: entry.relPath,
        title: (
          <span className="flex w-full min-w-0 items-center gap-2">
            <FileTypeIcon
              type={entry.sourceType || entry.relPath.split(".").pop() || null}
              size={14}
            />
            <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate">{entry.title || fileName}</span>
              {entry.userEdited && (
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  本地已编辑
                </Tag>
              )}
            </span>
            {dir && (
              <span
                className="max-w-[35%] truncate text-xs opacity-50"
                title={dir}
              >
                {dir}
              </span>
            )}
            <span className="flex shrink-0 items-center gap-2 text-xs opacity-80">
              <span>{formatSize(entry.size)}</span>
              <SyncStateTag state={entry.syncState} />
            </span>
          </span>
        ),
        isLeaf: true,
        // 自定义字段挂到 node 上，供 onSelect 判断打开方式
        noteId: entry.noteId,
        entry,
      } as DataNode & { noteId: number; entry: ExternalEntry };
    });
}
