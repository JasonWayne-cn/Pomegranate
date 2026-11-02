import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DragEvent } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  List,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { pptTemplateApi } from "@/lib/api/pptTemplate";
import type {
  PptTemplateConflictPolicy,
  PptTemplatePreview,
  PptUserTemplate,
} from "@/types/pptTemplate";

const { Text, Paragraph } = Typography;

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function notifyTemplatesChanged() {
  window.dispatchEvent(new Event("app:ppt-templates-changed"));
}

export default function TemplateLibrary() {
  const [items, setItems] = useState<PptUserTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [previewFailed, setPreviewFailed] = useState<Record<string, true>>({});
  const [dragOver, setDragOver] = useState(false);
  const previewSeq = useRef(0);

  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [candidates, setCandidates] = useState<PptTemplatePreview[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [policies, setPolicies] = useState<
    Record<string, PptTemplateConflictPolicy>
  >({});
  const [keepImages, setKeepImages] = useState(true);

  const [renameTarget, setRenameTarget] = useState<PptUserTemplate | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameDesc, setRenameDesc] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const seq = ++previewSeq.current;
    try {
      const list = await pptTemplateApi.list();
      if (seq !== previewSeq.current) return;
      setItems(list);
      const next: Record<string, string> = {};
      const failed: Record<string, true> = {};
      await Promise.all(
        list
          .filter((item) => item.status === "ok")
          .map(async (item) => {
            try {
              next[item.id] = await pptTemplateApi.preview(item.id);
            } catch {
              failed[item.id] = true;
            }
          }),
      );
      if (seq !== previewSeq.current) return;
      setPreviews(next);
      setPreviewFailed(failed);
    } catch (e) {
      message.error(`加载模板库失败：${String(e)}`);
    } finally {
      if (seq === previewSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const handler = () => void load();
    window.addEventListener("app:ppt-templates-changed", handler);
    return () => window.removeEventListener("app:ppt-templates-changed", handler);
  }, [load]);

  const selectedCount = useMemo(
    () => Object.values(selected).filter(Boolean).length,
    [selected],
  );

  async function inspectPath(path: string) {
    setSourcePath(path);
    setInspecting(true);
    try {
      const result = await pptTemplateApi.inspect(path);
      setCandidates(result);
      const nextSelected: Record<string, boolean> = {};
      const nextPolicies: Record<string, PptTemplateConflictPolicy> = {};
      for (const item of result) {
        nextSelected[item.id] = true;
        nextPolicies[item.id] = item.conflict ? "rename" : "reject";
      }
      setSelected(nextSelected);
      setPolicies(nextPolicies);
      setInspectOpen(true);
    } catch (e) {
      message.error(`解析模板失败：${String(e)}`);
    } finally {
      setInspecting(false);
    }
  }

  async function handlePick(kind: "folder" | "zip") {
    let picked: string | string[] | null = null;
    try {
      picked = await openDialog({
        multiple: false,
        directory: kind === "folder",
        filters:
          kind === "zip"
            ? [{ name: "模板包", extensions: ["zip"] }]
            : undefined,
      });
    } catch (e) {
      message.error(String(e));
      return;
    }
    if (!picked || Array.isArray(picked)) return;
    await inspectPath(picked);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    const path = (file as File & { path?: string } | undefined)?.path;
    if (!path) {
      message.warning("无法读取拖入路径，请使用「导入文件夹 / 导入 zip」按钮");
      return;
    }
    void inspectPath(path);
  }

  async function handleVerify(item: PptUserTemplate) {
    try {
      const ok = await pptTemplateApi.verify(item.id);
      message[ok ? "success" : "error"](
        ok ? "完整性校验通过" : "模板内容已修改或损坏",
      );
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleExport(item: PptUserTemplate) {
    let target: string | null = null;
    try {
      target = await saveDialog({
        defaultPath: `${item.id}.zip`,
        filters: [{ name: "模板包", extensions: ["zip"] }],
      });
    } catch (e) {
      message.error(String(e));
      return;
    }
    if (!target) return;
    try {
      const saved = await pptTemplateApi.exportPack(item.id, target);
      message.success(`已导出到 ${saved}`);
    } catch (e) {
      message.error(`导出失败：${String(e)}`);
    }
  }

  async function handleInstall() {
    if (!sourcePath || selectedCount === 0) return;
    setInstalling(true);
    try {
      const result = await pptTemplateApi.install({
        path: sourcePath,
        selections: candidates
          .filter((item) => selected[item.id])
          .map((item) => ({
            id: item.id,
            displayName: item.displayName,
            description: item.description,
            conflict: policies[item.id] ?? "reject",
            keepImages,
          })),
      });
      if (result.installed.length) {
        message.success(`已导入 ${result.installed.length} 个模板`);
      }
      for (const failure of result.failed) {
        message.error(`${failure.id}：${failure.message}`);
      }
      for (const warning of result.warnings) {
        message.warning(warning);
      }
      if (result.installed.length) {
        setInspectOpen(false);
        notifyTemplatesChanged();
        await load();
      }
    } catch (e) {
      message.error(`安装失败：${String(e)}`);
    } finally {
      setInstalling(false);
    }
  }

  async function toggleEnabled(item: PptUserTemplate, enabled: boolean) {
    try {
      await pptTemplateApi.setEnabled(item.id, enabled);
      message.success(enabled ? "已启用" : "已禁用");
      notifyTemplatesChanged();
      await load();
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleDelete(item: PptUserTemplate) {
    Modal.confirm({
      title: `删除模板「${item.displayName}」？`,
      content:
        "模板文件会从 ppt-templates 目录删除；已经生成的 PPT 作业不受影响。",
      okText: "删除",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await pptTemplateApi.remove(item.id);
          message.success("已删除");
          notifyTemplatesChanged();
          await load();
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  }

  function openRename(item: PptUserTemplate) {
    setRenameTarget(item);
    setRenameName(item.displayName);
    setRenameDesc(item.description ?? "");
  }

  async function submitRename() {
    if (!renameTarget) return;
    try {
      await pptTemplateApi.rename(
        renameTarget.id,
        renameName.trim(),
        renameDesc.trim() || null,
      );
      message.success("已保存");
      setRenameTarget(null);
      notifyTemplatesChanged();
      await load();
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <div
      className={
        dragOver
          ? "rounded-lg ring-2 ring-blue-400 ring-offset-2"
          : undefined
      }
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Text type="secondary">
            在 PPT-Master 中生成模板后，直接导入文件夹或 zip。导入后无需重启或重装扩展包。
          </Text>
        </div>
        <Space wrap>
          <Button
            icon={<RefreshCw size={16} />}
            onClick={() => void load()}
            loading={loading}
          >
            刷新
          </Button>
          <Button
            icon={<FolderPlus size={16} />}
            loading={inspecting}
            onClick={() => void handlePick("folder")}
          >
            导入文件夹
          </Button>
          <Button
            type="primary"
            icon={<Upload size={16} />}
            loading={inspecting}
            onClick={() => void handlePick("zip")}
          >
            导入 zip
          </Button>
        </Space>
      </div>

      <Alert
        className="mb-3"
        type="info"
        showIcon
        message="模板格式"
        description="支持 PPT-Master 的 Layout/Deck 工作区：templates/design_spec.md + *.svg，可附带 images/、icons/。也可以直接选择包含 layouts/ 的模板库包。"
      />

      {items.length === 0 && !loading ? (
        <Card>
          <Empty description="尚未导入用户模板" />
        </Card>
      ) : (
        <List
          grid={{ gutter: 16, column: 3 }}
          dataSource={items}
          loading={loading}
          renderItem={(item) => (
            <List.Item>
              <Card
                size="small"
                title={
                  <div className="flex items-center gap-2">
                    <span className="truncate" title={item.displayName}>
                      {item.displayName}
                    </span>
                    {item.status !== "ok" && (
                      <Tag color="red">{item.status}</Tag>
                    )}
                    {!item.enabled && <Tag>已禁用</Tag>}
                  </div>
                }
                extra={
                  <Switch
                    size="small"
                    checked={item.enabled}
                    onChange={(checked) => void toggleEnabled(item, checked)}
                  />
                }
                cover={
                  <div className="flex h-36 items-center justify-center bg-slate-50">
                    {previews[item.id] ? (
                      <img
                        src={svgDataUrl(previews[item.id])}
                        alt={item.displayName}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <Text type="secondary">
                        {previewFailed[item.id] ? "无封面预览" : "预览加载中…"}
                      </Text>
                    )}
                  </div>
                }
                actions={[
                  <Button
                    key="rename"
                    type="link"
                    size="small"
                    onClick={() => openRename(item)}
                  >
                    重命名
                  </Button>,
                  <Button
                    key="reveal"
                    type="link"
                    size="small"
                    icon={<FolderOpen size={14} />}
                    onClick={() =>
                      void revealItemInDir(item.dirPath).catch((e) =>
                        message.error(String(e)),
                      )
                    }
                  >
                    目录
                  </Button>,
                  <Button
                    key="delete"
                    type="link"
                    size="small"
                    danger
                    icon={<Trash2 size={14} />}
                    onClick={() => handleDelete(item)}
                  >
                    删除
                  </Button>,
                  <Dropdown
                    key="more"
                    menu={{
                      items: [
                        { key: "verify", label: "校验完整性" },
                        { key: "export", label: "导出模板包" },
                      ],
                      onClick: ({ key }) => {
                        if (key === "verify") void handleVerify(item);
                        if (key === "export") void handleExport(item);
                      },
                    }}
                  >
                    <Button
                      type="link"
                      size="small"
                      icon={<MoreHorizontal size={14} />}
                    >
                      更多
                    </Button>
                  </Dropdown>,
                ]}
              >
                <Paragraph
                  className="!mb-2"
                  type="secondary"
                  ellipsis={{ rows: 2, tooltip: item.description }}
                >
                  {item.description || item.id}
                </Paragraph>
                <Space size={[4, 4]} wrap>
                  <Tag>{item.pageCount} 页</Tag>
                  <Tag>{item.canvasFormat}</Tag>
                  <Tag color={item.sourceKind === "deck" ? "gold" : "blue"}>
                    {item.sourceKind}
                  </Tag>
                  {item.supportsStructured && <Tag color="green">结构化</Tag>}
                  {item.supportsLegacy && <Tag color="cyan">{"{{}}"}</Tag>}
                </Space>
              </Card>
            </List.Item>
          )}
        />
      )}

      <Modal
        open={inspectOpen}
        title="导入模板"
        width={860}
        onCancel={() => setInspectOpen(false)}
        okText={selectedCount ? `导入 ${selectedCount} 个` : "导入"}
        okButtonProps={{ disabled: selectedCount === 0 }}
        confirmLoading={installing}
        onOk={() => void handleInstall()}
      >
        <div className="space-y-3">
          <Text type="secondary" className="block">
            来源：{sourcePath}
          </Text>
          <Checkbox
            checked={keepImages}
            onChange={(e) => setKeepImages(e.target.checked)}
          >
            保留模板自带的 images/ 图片资源（推荐）
          </Checkbox>
          <List
            dataSource={candidates}
            renderItem={(item) => (
              <List.Item>
                <div className="flex w-full gap-3">
                  <Checkbox
                    checked={!!selected[item.id]}
                    onChange={(e) =>
                      setSelected((prev) => ({
                        ...prev,
                        [item.id]: e.target.checked,
                      }))
                    }
                  />
                  <div className="flex h-24 w-40 shrink-0 items-center justify-center overflow-hidden rounded border border-slate-200 bg-slate-50">
                    {item.coverSvg ? (
                      <img
                        src={svgDataUrl(item.coverSvg)}
                        alt={item.displayName}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <Text type="secondary" className="text-xs">
                        无封面
                      </Text>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Space size={6} wrap>
                      <Text strong>{item.displayName}</Text>
                      <Tag>{item.id}</Tag>
                      <Tag>{item.pageCount} 页</Tag>
                      <Tag>{item.canvasFormat}</Tag>
                    </Space>
                    {item.description && (
                      <Paragraph
                        className="!mb-1 mt-1"
                        type="secondary"
                        ellipsis={{ rows: 2 }}
                      >
                        {item.description}
                      </Paragraph>
                    )}
                    <Space size={[4, 4]} wrap>
                      {item.pageTypes.slice(0, 5).map((type) => (
                        <Tag key={type}>{type}</Tag>
                      ))}
                      {item.pageTypes.length > 5 && (
                        <Tag>+{item.pageTypes.length - 5}</Tag>
                      )}
                    </Space>
                    {item.warnings.map((warning) => (
                      <Text
                        key={warning}
                        type="warning"
                        className="mt-1 block text-xs"
                      >
                        {warning}
                      </Text>
                    ))}
                    {item.conflict && (
                      <div className="mt-2 flex items-center gap-2">
                        <Tag color="orange">冲突</Tag>
                        <Text type="secondary" className="text-xs">
                          {item.conflict}
                        </Text>
                        <Select
                          size="small"
                          className="w-32"
                          value={policies[item.id] ?? "rename"}
                          onChange={(value) =>
                            setPolicies((prev) => ({
                              ...prev,
                              [item.id]: value,
                            }))
                          }
                          options={[
                            { value: "rename", label: "另存为新 id" },
                            { value: "overwrite", label: "覆盖" },
                            { value: "reject", label: "跳过" },
                          ]}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </List.Item>
            )}
          />
        </div>
      </Modal>

      <Modal
        open={!!renameTarget}
        title="重命名模板"
        onCancel={() => setRenameTarget(null)}
        onOk={() => void submitRename()}
        okText="保存"
      >
        <div className="space-y-3">
          <Input
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            placeholder="模板名称"
          />
          <Input.TextArea
            value={renameDesc}
            onChange={(e) => setRenameDesc(e.target.value)}
            placeholder="模板描述（可选）"
            rows={3}
          />
        </div>
      </Modal>
    </div>
  );
}
