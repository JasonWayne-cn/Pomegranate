/**
 * 外部目录的文件浏览卡片。
 *
 * 挂载点管理页（/mounts）和设置抽屉「外部目录」下方共用：
 * 加载某个挂载点的文件索引，支持树形 / 扁平切换、同步状态筛选、手动刷新。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Segmented,
  Space,
  Switch,
  Tree,
  message,
} from "antd";
import { RefreshCw } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { mountApi } from "@/lib/api";
import { formatOf } from "@/lib/office/formats";
import type { ExternalEntry, ExternalSyncState } from "@/types";
import { buildFlatList, buildTree } from "./mountTree";

interface Props {
  mountId: number;
  mountName?: string;
  height?: number;
  /** 只读挂载：Office 工作台打开后禁止保存 */
  readOnly?: boolean;
}

export function MountFileBrowser({
  mountId,
  mountName,
  height = 360,
  readOnly = false,
}: Props) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<ExternalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [entryFilter, setEntryFilter] = useState<"all" | ExternalSyncState>(
    "all",
  );
  const [flatView, setFlatView] = useState(false);

  /** `silent=true` 用于后台 external:changed 刷新，不清空当前树 */
  const loadEntries = useCallback(
    async (silent = false) => {
      if (!silent) {
        setEntries([]);
        setLoading(true);
      }
      try {
        setEntries(await mountApi.entries(mountId));
      } catch (e) {
        message.error(`读取文件列表失败: ${e}`);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [mountId],
  );

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  // 切换挂载点时重置状态筛选
  useEffect(() => {
    setEntryFilter("all");
  }, [mountId]);

  // 后台扫描/同步更新文件索引后静默重拉
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    listen<number>("external:changed", (e) => {
      if (e.payload !== mountId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadEntries(true), 500);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      if (timer) clearTimeout(timer);
    };
  }, [mountId, loadEntries]);

  const filteredEntries = useMemo(() => {
    if (entryFilter === "all") return entries;
    return entries.filter((e) => e.syncState === entryFilter);
  }, [entries, entryFilter]);

  const treeData = useMemo(
    () =>
      flatView
        ? buildFlatList(filteredEntries)
        : buildTree(filteredEntries),
    [filteredEntries, flatView],
  );

  /**
   * 二进制文档直接进 Office 工作台打开原文件；文本 / 旧格式仍打开影子笔记。
   */
  function openEntry(entry: ExternalEntry) {
    if (entry.typeCategory && entry.typeCategory !== "text" && entry.absPath) {
      const format = formatOf(entry.absPath);
      if (format) {
        // 用 URLSearchParams 统一编码，兼容含 `\\?\` 前缀的 Windows 路径
        const params = new URLSearchParams({
          path: entry.absPath,
          readonly: readOnly ? "1" : "0",
          t: String(Date.now()),
        });
        navigate(`/office?${params.toString()}`);
        return;
      }
    }
    void openShadowNote(entry.noteId);
  }

  async function openShadowNote(noteId: number) {
    try {
      const r = await mountApi.openFile(noteId);
      if (r.readOnly) {
        message.info("该挂载点为只读：编辑内容不会写回原文件");
      }
      if (r.stale) {
        message.warning("原文件已更新，影子笔记有本地编辑，已保留当前内容");
      }
      navigate(`/notes/${noteId}`);
    } catch (e) {
      message.error(`打开文件失败: ${e}`);
    }
  }

  return (
    <Card
      size="small"
      title={mountName ? `文件列表 · ${mountName}` : "文件列表"}
      extra={
        <Space wrap>
          <Space size={4}>
            <span className="text-xs opacity-60">扁平显示</span>
            <Switch size="small" checked={flatView} onChange={setFlatView} />
          </Space>
          <Segmented
            size="small"
            value={entryFilter}
            onChange={(v) => setEntryFilter(v as "all" | ExternalSyncState)}
            options={[
              { label: "全部", value: "all" },
              { label: "已同步", value: "synced" },
              { label: "待同步", value: "stale" },
              { label: "失败", value: "failed" },
              { label: "缺失", value: "missing" },
              { label: "暂停", value: "paused" },
            ]}
          />
          <Button
            size="small"
            icon={<RefreshCw size={13} />}
            loading={loading}
            onClick={() => void loadEntries()}
          >
            刷新
          </Button>
        </Space>
      }
    >
      <div style={{ height, overflow: "hidden" }}>
        {loading && entries.length === 0 ? (
          <div className="py-8 text-center text-sm opacity-60">加载中…</div>
        ) : treeData.length === 0 ? (
          <Empty
            description={
              entries.length === 0
                ? "目录中没有可索引的文件"
                : "没有符合筛选条件的文件"
            }
          />
        ) : (
          <Tree
            // 切换展示风格时强制重建，defaultExpandAll 才会重新生效
            key={`${mountId}-${entryFilter}-${flatView ? "flat" : "tree"}`}
            blockNode
            height={height}
            defaultExpandAll={!flatView}
            treeData={treeData}
            onSelect={(_, info) => {
              const node = info.node as unknown as {
                noteId?: number;
                entry?: ExternalEntry;
              };
              if (node.entry) void openEntry(node.entry);
              else if (node.noteId) void openShadowNote(node.noteId);
            }}
          />
        )}
      </div>
    </Card>
  );
}
