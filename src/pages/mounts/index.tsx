import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Segmented,
  Space,
  Switch,
  Tag,
  Tooltip,
  Tree,
  message,
  theme as antdTheme,
} from "antd";
import type { DataNode } from "antd/es/tree";
import {
  FolderInput,
  FolderOpen,
  HardDrive,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mountApi } from "@/lib/api";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { SyncTypeFields } from "@/components/settings/SyncTypeFields";
import type {
  ExternalEntry,
  ExternalMount,
  ExternalMountInput,
  ExternalMountUpdate,
  ExternalSyncState,
  MountScanProgress,
} from "@/types";

interface TreeNode {
  key: string;
  name: string;
  children: Map<string, TreeNode>;
  entry?: ExternalEntry;
}

/** Windows canonicalize 会带 \\?\ 前缀，展示时去掉 */
function displayPath(path: string): string {
  return path.replace(/^\\\\\?\\/, "");
}

function formatSize(bytes: number): string {
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

function SyncStateTag({ state }: { state: ExternalSyncState }) {
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

/** 把扁平 relPath 列表构建成树 */
function buildTree(entries: ExternalEntry[]): DataNode[] {
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
                type={
                  entry.sourceType ||
                  entry.relPath.split(".").pop() ||
                  null
                }
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
          // 自定义字段挂到 node 上，供 onSelect 取 noteId
          ...(entry ? { noteId: entry.noteId } : {}),
        };
      });
  return convert(root);
}

export default function MountsPage() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const [mounts, setMounts] = useState<ExternalMount[]>([]);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<ExternalEntry[]>([]);
  const [activeMountId, setActiveMountId] = useState<number | null>(null);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [scanningId, setScanningId] = useState<number | null>(null);
  const [progress, setProgress] = useState<MountScanProgress | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm<ExternalMountInput>();
  const [editOpen, setEditOpen] = useState(false);
  const [editingMount, setEditingMount] = useState<ExternalMount | null>(null);
  const [editEntries, setEditEntries] = useState<ExternalEntry[]>([]);
  const [editForm] = Form.useForm<ExternalMountUpdate>();
  const [entryFilter, setEntryFilter] = useState<"all" | ExternalSyncState>("all");
  const activeMountIdRef = useRef<number | null>(null);

  useEffect(() => {
    activeMountIdRef.current = activeMountId;
  }, [activeMountId]);

  /**
   * `silent=true` 用于后台 external:changed 刷新：
   * 不切 loading 骨架、不清空当前树，避免页面明显跳动。
   */
  const loadMounts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const list = await mountApi.list();
      setMounts(list);
      setActiveMountId((cur) =>
        cur && list.some((m) => m.id === cur) ? cur : list[0]?.id ?? null,
      );
    } catch (e) {
      message.error(`读取挂载点失败: ${e}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadEntries = useCallback(
    async (mountId: number | null, silent = false) => {
      if (mountId == null) {
        if (!silent) setEntries([]);
        return;
      }
      if (!silent) {
        // 切换挂载点时先清空旧树，避免短暂显示上一个挂载点的文件
        setEntries([]);
        setEntriesLoading(true);
      }
      try {
        setEntries(await mountApi.entries(mountId));
      } catch (e) {
        message.error(`读取文件列表失败: ${e}`);
      } finally {
        if (!silent) setEntriesLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    loadMounts();
  }, [loadMounts]);

  useEffect(() => {
    loadEntries(activeMountId);
  }, [activeMountId, loadEntries]);

  useEffect(() => {
    setEntryFilter("all");
  }, [activeMountId]);

  useEffect(() => {
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenChanged: UnlistenFn | undefined;
    let changedTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      unlistenProgress = await listen<MountScanProgress>(
        "mount:scan-progress",
        (e) => setProgress(e.payload),
      );
      unlistenChanged = await listen<number>("external:changed", (e) => {
        // 合并短时间内的多次变更，且只静默刷新，避免整页闪烁。
        if (changedTimer) clearTimeout(changedTimer);
        changedTimer = setTimeout(() => {
          void loadMounts(true);
          if (e.payload === activeMountIdRef.current) {
            void loadEntries(e.payload, true);
          }
        }, 500);
      });
    })();
    return () => {
      unlistenProgress?.();
      unlistenChanged?.();
      if (changedTimer) clearTimeout(changedTimer);
    };
  }, [loadMounts, loadEntries]);

  async function pickFolder() {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      const name = selected.split(/[\\/]/).filter(Boolean).pop() || "外部目录";
      form.setFieldsValue({
        name,
        rootPath: selected,
        readOnly: false,
        indexEnabled: true,
        dailyMode: false,
        scanInterval: 10,
      });
      setAddOpen(true);
    } catch (e) {
      message.error(`选择目录失败: ${e}`);
    }
  }

  async function submitAdd() {
    try {
      const values = await form.validateFields();
      const mount = await mountApi.add(values);
      message.success(`已挂载「${mount.name}」，开始建立索引…`);
      setAddOpen(false);
      form.resetFields();
      await loadMounts();
      setActiveMountId(mount.id);
      await runScan(mount.id);
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`挂载失败: ${e}`);
    }
  }

  async function openEdit(m: ExternalMount) {
    setEditingMount(m);
    editForm.setFieldsValue({
      name: m.name,
      readOnly: m.readOnly,
      indexEnabled: m.indexEnabled,
      dailyMode: m.dailyMode,
      scanInterval: m.scanInterval,
      syncTypes: m.syncTypes,
    });
    setEditOpen(true);

    // 类型开关旁显示已索引数量；非当前浏览的挂载点单独拉一次
    if (m.id === activeMountId) {
      setEditEntries(entries);
    } else {
      setEditEntries([]);
      try {
        setEditEntries(await mountApi.entries(m.id));
      } catch {
        // 数量展示失败不影响设置
      }
    }
  }

  async function submitEdit() {
    if (!editingMount) return;
    const mount = editingMount;
    try {
      const values = await editForm.validateFields();
      await mountApi.update(mount.id, values);
      message.success("同步设置已更新");
      setEditOpen(false);
      setEditingMount(null);
      await loadMounts(true);

      // 新开启的类型需要立即扫描一次，否则要等下一轮轮询
      const after = values.syncTypes;
      const enabledAdded =
        after &&
        (Object.keys(after) as Array<keyof typeof after>).some(
          (key) => after[key] && !mount.syncTypes[key],
        );
      if (enabledAdded) void runScan(mount.id);
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`保存失败: ${e}`);
    }
  }

  async function runScan(mountId: number) {
    setScanningId(mountId);
    setProgress(null);
    try {
      const r = await mountApi.scan(mountId);
      if (r.errors.length) {
        message.warning(
          `扫描完成：新增 ${r.added}，更新 ${r.updated}，待同步 ${r.stale}，缺失 ${r.missing}；${r.errors.length} 个错误`,
        );
      } else {
        message.success(
          `扫描完成：新增 ${r.added}，更新 ${r.updated}，未变 ${r.unchanged}，待同步 ${r.stale}，缺失 ${r.missing}`,
        );
      }
      await loadMounts();
      if (activeMountId === mountId) await loadEntries(mountId);
    } catch (e) {
      message.error(`扫描失败: ${e}`);
    } finally {
      setScanningId(null);
      setProgress(null);
    }
  }

  async function removeMount(mount: ExternalMount, detach: boolean) {
    Modal.confirm({
      title: detach ? "转为本地笔记？" : "移除挂载点？",
      content: detach
        ? "影子笔记会转换成本地笔记保留在数据库中，原磁盘文件不会被删除。"
        : "只删除索引和影子笔记，磁盘上的原始文件不受影响。",
      okText: detach ? "转为本地" : "移除索引",
      okButtonProps: { danger: !detach },
      cancelText: "取消",
      async onOk() {
        try {
          await mountApi.remove(mount.id, detach);
          message.success(detach ? "已转为本地笔记" : "已移除挂载点");
          await loadMounts();
        } catch (e) {
          message.error(`操作失败: ${e}`);
        }
      },
    });
  }

  async function openEntry(noteId: number) {
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

  const filteredEntries = useMemo(() => {
    if (entryFilter === "all") return entries;
    return entries.filter((e) => e.syncState === entryFilter);
  }, [entries, entryFilter]);

  const treeData = useMemo(() => buildTree(filteredEntries), [filteredEntries]);

  const editTypeCounts = useMemo(() => {
    const counts: Record<string, number> = { text: 0, pdf: 0, word: 0, sheet: 0 };
    for (const entry of editEntries) {
      if (entry.typeCategory) counts[entry.typeCategory] += 1;
    }
    return counts;
  }, [editEntries]);

  const activeMount = mounts.find((m) => m.id === activeMountId) || null;
  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  function syncSummary(m: ExternalMount): string {
    const labels: string[] = [];
    if (m.syncTypes.text) labels.push("文本");
    if (m.syncTypes.pdf) labels.push("PDF");
    if (m.syncTypes.word) labels.push("Word");
    if (m.syncTypes.sheet) labels.push("表格");
    return labels.length === 0 ? "全部暂停" : labels.join(" / ");
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="m-0 text-xl font-semibold">文档来源设置</h1>
            <div className="mt-1 text-xs opacity-60">
              外部目录是文档的来源设置：直接挂载磁盘文件夹，文件不复制；内容会进入全文搜索、标签与双链索引。
            </div>
          </div>
          <Space>
            <Button onClick={() => navigate("/notes")}>返回文档</Button>
            <Button icon={<RefreshCw size={14} />} onClick={() => loadMounts()}>
              刷新
            </Button>
            <Button type="primary" icon={<Plus size={14} />} onClick={pickFolder}>
              添加外部目录
            </Button>
          </Space>
        </div>

        {progress && (
          <Card size="small">
            <div className="mb-1 text-xs opacity-70">
              正在扫描：{progress.fileName}（{progress.current}/{progress.total}）
            </div>
            <Progress percent={progressPercent} size="small" />
          </Card>
        )}

        {mounts.length === 0 ? (
          loading ? (
            <Card size="small" loading />
          ) : (
            <Card size="small">
              <Empty description="还没有挂载外部目录" />
            </Card>
          )
        ) : (
          <div className="space-y-3">
            {mounts.map((m) => (
              <Card
                key={m.id}
                size="small"
                onClick={() => setActiveMountId(m.id)}
                style={{
                  cursor: "pointer",
                  borderColor:
                    activeMountId === m.id ? token.colorPrimary : undefined,
                }}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Space wrap>
                      <HardDrive size={15} />
                      <span className="font-medium">{m.name}</span>
                      {m.readOnly && <Tag>只读</Tag>}
                      {!m.available && <Tag color="red">不可用</Tag>}
                      <Tag color="processing">同步：{syncSummary(m)}</Tag>
                    </Space>
                    <Tooltip title={displayPath(m.rootPath)}>
                      <div
                        className="mt-1 truncate text-xs opacity-60"
                        style={{ fontFamily: "monospace" }}
                      >
                        {displayPath(m.rootPath)}
                      </div>
                    </Tooltip>
                    <Space size="middle" wrap className="mt-2 text-xs opacity-80">
                      <span>{m.noteCount} 个文件</span>
                      {m.missingCount > 0 && (
                        <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                          缺 {m.missingCount}
                        </Tag>
                      )}
                      <span>同步间隔 {m.scanInterval} 秒</span>
                      <span>上次扫描 {m.lastScanAt || "从未"}</span>
                    </Space>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <Space wrap>
                      <Button
                        size="small"
                        icon={<RefreshCw size={13} />}
                        loading={scanningId === m.id}
                        onClick={() => runScan(m.id)}
                      >
                        扫描
                      </Button>
                      <Button size="small" onClick={() => setActiveMountId(m.id)}>
                        浏览
                      </Button>
                      <Button
                        size="small"
                        icon={<Settings2 size={13} />}
                        onClick={() => void openEdit(m)}
                      >
                        设置
                      </Button>
                      <Dropdown
                        menu={{
                          items: [
                            {
                              key: "detach",
                              icon: <FolderInput size={13} />,
                              label: "转为本地笔记",
                              onClick: () => removeMount(m, true),
                            },
                            {
                              key: "remove",
                              icon: <Trash2 size={13} />,
                              label: "移除索引",
                              danger: true,
                              onClick: () => removeMount(m, false),
                            },
                          ],
                        }}
                      >
                        <Button size="small" danger>
                          移除
                        </Button>
                      </Dropdown>
                    </Space>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {!activeMount && loading && (
          <Card size="small" loading title="文件列表" />
        )}

        {activeMount && (
          <Card
            size="small"
            title={
              <Space>
                <FolderOpen size={15} />
                {activeMount.name}
                <span className="text-xs opacity-60">
                  {entries.length} 个文件
                </span>
                {entries.some((e) => e.stale) && (
                  <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                    {entries.filter((e) => e.stale).length} 个待同步
                  </Tag>
                )}
              </Space>
            }
            extra={
              <Space wrap>
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
                  loading={scanningId === activeMount.id}
                  onClick={() => runScan(activeMount.id)}
                >
                  重新扫描
                </Button>
              </Space>
            }
          >
            {entries.some((e) => e.stale) && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`${entries.filter((e) => e.stale).length} 个影子笔记落后于原文件`}
                description="这些文件的原文件已更新，但影子笔记有本地编辑。打开笔记后可选择「重新抽取」覆盖本地编辑，或保留当前内容。"
              />
            )}
            <div style={{ height: 420, overflow: "hidden" }}>
              {entriesLoading && entries.length === 0 ? (
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
                  key={`${activeMount.id}-${entryFilter}`}
                  blockNode
                  height={420}
                  defaultExpandAll
                  treeData={treeData}
                  onSelect={(_, info) => {
                    const noteId = (info.node as unknown as { noteId?: number })
                      .noteId;
                    if (noteId) void openEntry(noteId);
                  }}
                />
              )}
            </div>
          </Card>
        )}
      </div>

      <Modal
        title="添加外部目录"
        open={addOpen}
        onOk={submitAdd}
        onCancel={() => setAddOpen(false)}
        okText="挂载并扫描"
        cancelText="取消"
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            readOnly: false,
            indexEnabled: true,
            dailyMode: false,
            scanInterval: 10,
            syncTypes: { text: true, pdf: true, word: true, sheet: true },
          }}
        >
          <Form.Item
            name="name"
            label="显示名称"
            rules={[{ required: true, message: "请输入挂载名称" }]}
          >
            <Input placeholder="例如：Obsidian 仓库" />
          </Form.Item>
          <Form.Item
            name="rootPath"
            label="目录"
            rules={[{ required: true, message: "请选择目录" }]}
          >
            <Input readOnly />
          </Form.Item>
          <Form.Item
            name="scanInterval"
            label="同步间隔（秒）"
            tooltip="后台每隔多久检查一次原文件变化；默认 10 秒。后台调度器每 5 秒巡检一次，到期的挂载点才会扫描。"
            rules={[{ required: true, message: "请输入同步间隔" }]}
          >
            <InputNumber min={2} max={3600} style={{ width: "100%" }} />
          </Form.Item>
          <div className="mb-4">
            <div className="mb-2 text-sm">同步文件类型</div>
            <SyncTypeFields />
            <div className="mt-2 text-xs opacity-60">
              关闭的类型不会扫描新文件；已索引文档可在创建后的「设置」中查看。
            </div>
          </div>
          <Space size="large">
            <Form.Item
              name="readOnly"
              label="只读"
              valuePropName="checked"
              tooltip="只读挂载仍会建立索引，但不会把编辑写回原文件"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="indexEnabled"
              label="自动索引"
              valuePropName="checked"
              tooltip="后台定时扫描外部变化"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="dailyMode"
              label="识别日记"
              valuePropName="checked"
              tooltip="按日期文件夹/文件名识别为日记（预留）"
            >
              <Switch disabled />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="同步设置"
        width={720}
        open={editOpen}
        styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
        onOk={submitEdit}
        onCancel={() => {
          setEditOpen(false);
          setEditingMount(null);
        }}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="name"
            label="显示名称"
            rules={[{ required: true, message: "请输入挂载名称" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="scanInterval"
            label="同步间隔（秒）"
            tooltip="后台每隔多久检查一次原文件变化；后台调度器每 5 秒巡检一次，到期的挂载点才会扫描。"
            rules={[{ required: true, message: "请输入同步间隔" }]}
          >
            <InputNumber min={2} max={3600} style={{ width: "100%" }} />
          </Form.Item>
          <div className="mb-4">
            <div className="mb-2 text-sm">同步文件类型</div>
            <SyncTypeFields counts={editTypeCounts} />
            <div className="mt-2 text-xs opacity-60">
              关闭类型后已索引的文档会保留，但停止同步；重新开启后会在下一次扫描时恢复。
            </div>
          </div>
          <Space size="large">
            <Form.Item
              name="readOnly"
              label="只读"
              valuePropName="checked"
              tooltip="只读挂载仍会建立索引，但不会把编辑写回原文件"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="indexEnabled"
              label="自动索引"
              valuePropName="checked"
              tooltip="关闭后暂停后台轮询；仍可手动扫描"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="dailyMode"
              label="识别日记"
              valuePropName="checked"
              tooltip="按日期文件夹/文件名识别为日记（预留）"
            >
              <Switch disabled />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
