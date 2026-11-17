import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Space,
  Switch,
  Tag,
  Tooltip,
  message,
} from "antd";
import { FolderOpen, HardDrive, Plus, RefreshCw, Settings2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mountApi } from "@/lib/api";
import type {
  ExternalMount,
  ExternalMountInput,
  ExternalMountUpdate,
  MountScanProgress,
} from "@/types";
import { SyncTypeFields } from "./SyncTypeFields";
import { MountFileBrowser } from "@/components/mounts/MountFileBrowser";

interface Props {
  compact?: boolean;
}

/** Windows canonicalize 会带 \\?\ 前缀，展示时去掉 */
function displayPath(path: string): string {
  return path.replace(/^\\\\\?\\/, "");
}

function syncSummary(m: ExternalMount): string {
  const labels: string[] = [];
  if (m.syncTypes.text) labels.push("文本");
  if (m.syncTypes.pdf) labels.push("PDF");
  if (m.syncTypes.word) labels.push("Word");
  if (m.syncTypes.sheet) labels.push("表格");
  return labels.length === 0 ? "全部暂停" : labels.join(" / ");
}

/**
 * 外部目录设置。
 *
 * 在文档配置抽屉中管理挂载点：添加、扫描、编辑同步设置、移除。
 * 文件浏览仍由 /mounts 页面负责，避免抽屉承载过重。
 */
export function MountSettingsSection({ compact }: Props) {
  const [mounts, setMounts] = useState<ExternalMount[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanningId, setScanningId] = useState<number | null>(null);
  const [progress, setProgress] = useState<MountScanProgress | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm] = Form.useForm<ExternalMountInput>();
  const [editOpen, setEditOpen] = useState(false);
  const [editingMount, setEditingMount] = useState<ExternalMount | null>(null);
  const [editForm] = Form.useForm<ExternalMountUpdate>();
  // 当前在下方内嵌浏览的挂载点；null = 收起文件列表
  const [browseMountId, setBrowseMountId] = useState<number | null>(null);

  const loadMounts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setMounts(await mountApi.list());
    } catch (e) {
      message.error(`读取挂载点失败: ${e}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMounts();
  }, [loadMounts]);

  // 挂载点被移除后收起文件列表
  useEffect(() => {
    if (
      browseMountId != null &&
      mounts.length > 0 &&
      !mounts.some((m) => m.id === browseMountId)
    ) {
      setBrowseMountId(null);
    }
  }, [mounts, browseMountId]);

  useEffect(() => {
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenChanged: UnlistenFn | undefined;
    let changedTimer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      unlistenProgress = await listen<MountScanProgress>(
        "mount:scan-progress",
        (e) => setProgress(e.payload),
      );
      unlistenChanged = await listen<number>("external:changed", () => {
        if (changedTimer) clearTimeout(changedTimer);
        changedTimer = setTimeout(() => void loadMounts(true), 400);
      });
    })();

    return () => {
      unlistenProgress?.();
      unlistenChanged?.();
      if (changedTimer) clearTimeout(changedTimer);
    };
  }, [loadMounts]);

  async function pickFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    const name = selected.split(/[\\/]/).filter(Boolean).pop() || "外部目录";
    addForm.setFieldsValue({
      name,
      rootPath: selected,
      readOnly: false,
      indexEnabled: true,
      dailyMode: false,
      scanInterval: 10,
    });
    setAddOpen(true);
  }

  async function submitAdd() {
    try {
      const values = await addForm.validateFields();
      const mount = await mountApi.add(values);
      message.success(`已挂载「${mount.name}」，开始建立索引…`);
      setAddOpen(false);
      addForm.resetFields();
      await loadMounts();
      void runScan(mount.id);
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`挂载失败: ${e}`);
    }
  }

  function openEdit(mount: ExternalMount) {
    setEditingMount(mount);
    editForm.setFieldsValue({
      name: mount.name,
      readOnly: mount.readOnly,
      indexEnabled: mount.indexEnabled,
      dailyMode: mount.dailyMode,
      scanInterval: mount.scanInterval,
      syncTypes: mount.syncTypes,
    });
    setEditOpen(true);
  }

  async function submitEdit() {
    if (!editingMount) return;
    try {
      const values = await editForm.validateFields();
      await mountApi.update(editingMount.id, values);
      message.success("同步设置已更新");
      setEditOpen(false);
      setEditingMount(null);
      await loadMounts(true);
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
      await loadMounts(true);
    } catch (e) {
      message.error(`扫描失败: ${e}`);
    } finally {
      setScanningId(null);
      setProgress(null);
    }
  }

  function removeMount(mount: ExternalMount) {
    Modal.confirm({
      title: "移除挂载点？",
      content:
        "只删除索引和影子笔记，磁盘上的原始文件不受影响。如需保留影子笔记，请到完整管理页选择「转为本地笔记」。",
      okText: "移除索引",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        try {
          await mountApi.remove(mount.id, false);
          message.success("已移除挂载点");
          await loadMounts(true);
        } catch (e) {
          message.error(`操作失败: ${e}`);
        }
      },
    });
  }

  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <>
      <Card
        size={compact ? "small" : "default"}
        styles={compact ? { body: { padding: 12 } } : undefined}
        title={
          <span className="flex items-center gap-2">
            <HardDrive size={16} />
            外部目录
          </span>
        }
        extra={
          <Space>
            <Button
              size="small"
              type={browseMountId != null ? "primary" : "default"}
              icon={<FolderOpen size={13} />}
              onClick={() => {
                if (mounts.length === 0) {
                  message.info("还没有挂载外部目录");
                  return;
                }
                setBrowseMountId((cur) =>
                  cur == null ? mounts[0].id : null,
                );
              }}
            >
              {browseMountId != null ? "收起文件" : "浏览文件"}
            </Button>
            <Button
              size="small"
              icon={<RefreshCw size={13} />}
              loading={loading}
              onClick={() => void loadMounts()}
            >
              刷新
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<Plus size={13} />}
              onClick={() => void pickFolder()}
            >
              添加
            </Button>
          </Space>
        }
      >
        {progress && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
              正在扫描：{progress.fileName}（{progress.current}/{progress.total}）
            </div>
            <Progress percent={progressPercent} size="small" />
          </div>
        )}

        {mounts.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有挂载外部目录"
          />
        ) : (
          mounts.map((mount) => (
            <Card
              key={mount.id}
              size="small"
              style={{ marginBottom: 12 }}
              styles={{ body: { padding: 12 } }}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <Space wrap>
                    <HardDrive size={14} />
                    <span style={{ fontWeight: 500 }}>{mount.name}</span>
                    {mount.readOnly && <Tag>只读</Tag>}
                    {!mount.available && <Tag color="red">不可用</Tag>}
                    <Tag color="processing">同步：{syncSummary(mount)}</Tag>
                  </Space>
                  <Tooltip title={displayPath(mount.rootPath)}>
                    <div
                      style={{
                        marginTop: 4,
                        fontFamily: "monospace",
                        fontSize: 12,
                        opacity: 0.65,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayPath(mount.rootPath)}
                    </div>
                  </Tooltip>
                  <Space size="middle" wrap style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                    <span>{mount.noteCount} 个文件</span>
                    {mount.missingCount > 0 && (
                      <Tag color="warning">缺 {mount.missingCount}</Tag>
                    )}
                    <span>同步间隔 {mount.scanInterval} 秒</span>
                    <span>上次扫描 {mount.lastScanAt || "从未"}</span>
                  </Space>
                </div>
                <Space wrap>
                  <Button
                    size="small"
                    icon={<FolderOpen size={13} />}
                    type={browseMountId === mount.id ? "primary" : "default"}
                    onClick={() => setBrowseMountId(mount.id)}
                  >
                    浏览
                  </Button>
                  <Button
                    size="small"
                    icon={<RefreshCw size={13} />}
                    loading={scanningId === mount.id}
                    onClick={() => void runScan(mount.id)}
                  >
                    扫描
                  </Button>
                  <Button
                    size="small"
                    icon={<Settings2 size={13} />}
                    onClick={() => openEdit(mount)}
                  >
                    设置
                  </Button>
                  <Button size="small" danger onClick={() => removeMount(mount)}>
                    移除
                  </Button>
                </Space>
              </div>
            </Card>
          ))
        )}

      </Card>

      {/* 文件列表内嵌在外部目录列表下方，不再跳转独立页面 */}
      {browseMountId != null && (
        <div style={{ marginTop: 12 }}>
          <MountFileBrowser
            mountId={browseMountId}
            mountName={mounts.find((m) => m.id === browseMountId)?.name}
            readOnly={mounts.find((m) => m.id === browseMountId)?.readOnly}
            height={320}
          />
        </div>
      )}

      <Modal
        title="添加外部目录"
        open={addOpen}
        onOk={() => void submitAdd()}
        onCancel={() => setAddOpen(false)}
        okText="挂载并扫描"
        cancelText="取消"
        destroyOnHidden
        forceRender
        styles={{ body: { maxHeight: "60vh", overflowY: "auto" } }}
      >
        <Form
          form={addForm}
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
            <Input readOnly placeholder="请先点击「添加」选择目录" />
          </Form.Item>
          <Form.Item
            name="scanInterval"
            label="同步间隔（秒）"
            tooltip="后台每隔多久检查一次原文件变化；默认 10 秒。"
            rules={[{ required: true, message: "请输入同步间隔" }]}
          >
            <InputNumber min={2} max={3600} style={{ width: "100%" }} />
          </Form.Item>
          <div className="mb-4">
            <div className="mb-2 text-sm">同步文件类型</div>
            <SyncTypeFields />
            <div className="mt-2 text-xs opacity-60">
              关闭的类型不会扫描新文件。
            </div>
          </div>
          <Space size="large" wrap>
            <Form.Item name="readOnly" label="只读" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="indexEnabled" label="自动索引" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="dailyMode" label="识别日记" valuePropName="checked">
              <Switch disabled />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="同步设置"
        width={620}
        open={editOpen}
        onOk={() => void submitEdit()}
        onCancel={() => {
          setEditOpen(false);
          setEditingMount(null);
        }}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        forceRender
        styles={{ body: { maxHeight: "60vh", overflowY: "auto" } }}
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
            tooltip="后台每隔多久检查一次原文件变化。"
            rules={[{ required: true, message: "请输入同步间隔" }]}
          >
            <InputNumber min={2} max={3600} style={{ width: "100%" }} />
          </Form.Item>
          <div className="mb-4">
            <div className="mb-2 text-sm">同步文件类型</div>
            <SyncTypeFields />
            <div className="mt-2 text-xs opacity-60">
              关闭类型后已索引的文档会保留，但停止同步。
            </div>
          </div>
          <Space size="large" wrap>
            <Form.Item name="readOnly" label="只读" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="indexEnabled" label="自动索引" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="dailyMode" label="识别日记" valuePropName="checked">
              <Switch disabled />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
}

export default MountSettingsSection;
