import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Modal,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, PackagePlus, RefreshCw, Trash2 } from "lucide-react";
import { extensionApi } from "@/lib/api/extension";
import type { ExtensionInfo, ExtensionInspection } from "@/types/extension";

const { Text, Paragraph } = Typography;

function notifyExtensionsChanged() {
  window.dispatchEvent(new Event("app:extensions-changed"));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ExtensionsPage() {
  const [items, setItems] = useState<ExtensionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await extensionApi.list());
    } catch (e) {
      message.error(`加载扩展包失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleInstall() {
    let selected: string | string[] | null = null;
    try {
      selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "PPT 扩展包", extensions: ["zip"] }],
      });
    } catch (e) {
      message.error(String(e));
      return;
    }
    if (!selected || Array.isArray(selected)) return;

    setInstalling(true);
    try {
      const inspection: ExtensionInspection = await extensionApi.inspectZip(selected);
      Modal.confirm({
        title: `安装 ${inspection.manifest.name} v${inspection.manifest.version}`,
        width: 560,
        content: (
          <div className="space-y-3">
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="扩展 ID">
                {inspection.manifest.id}
              </Descriptions.Item>
              <Descriptions.Item label="类型">
                {inspection.manifest.kind}
              </Descriptions.Item>
              <Descriptions.Item label="文件数">
                {inspection.fileCount}
              </Descriptions.Item>
              <Descriptions.Item label="解压体积">
                {formatBytes(inspection.uncompressedBytes)}
              </Descriptions.Item>
              <Descriptions.Item label="兼容性">
                {inspection.compatible ? (
                  <Tag color="green">兼容</Tag>
                ) : (
                  <Tag color="red">{inspection.reason ?? "不兼容"}</Tag>
                )}
              </Descriptions.Item>
            </Descriptions>
            <Alert
              type="info"
              showIcon
              message="权限声明"
              description={
                inspection.manifest.permissions.length
                  ? inspection.manifest.permissions.join("、")
                  : "无额外权限"
              }
            />
          </div>
        ),
        okText: "确认安装",
        okButtonProps: { disabled: !inspection.compatible },
        onOk: async () => {
          try {
            await extensionApi.installZip(selected as string);
            message.success("扩展包已安装");
            await load();
            notifyExtensionsChanged();
          } catch (e) {
            message.error(`安装失败：${String(e)}`);
          }
        },
      });
    } catch (e) {
      message.error(`预检失败：${String(e)}`);
    } finally {
      setInstalling(false);
    }
  }

  async function toggleEnabled(item: ExtensionInfo, enabled: boolean) {
    try {
      if (enabled) await extensionApi.enable(item.id);
      else await extensionApi.disable(item.id);
      message.success(enabled ? "已启用" : "已禁用");
      await load();
      notifyExtensionsChanged();
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleUninstall(item: ExtensionInfo) {
    Modal.confirm({
      title: `卸载 ${item.name}？`,
      content: "扩展包文件会被删除，已生成的 PPT 工程目录不会自动删除。",
      okText: "卸载",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await extensionApi.uninstall(item.id);
          message.success("已卸载");
          await load();
          notifyExtensionsChanged();
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  }

  async function handleVerify(item: ExtensionInfo) {
    try {
      const ok = await extensionApi.verify(item.id);
      message[ok ? "success" : "error"](ok ? "完整性校验通过" : "完整性校验失败");
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleVersions(item: ExtensionInfo) {
    try {
      const versions = await extensionApi.listVersions(item.id);
      Modal.info({
        title: `${item.name} 版本`,
        width: 560,
        content: (
          <div className="space-y-2">
            {versions.length === 0 && <Text type="secondary">暂无版本记录</Text>}
            {versions.map((version) => (
              <div
                key={version.version}
                className="flex items-center justify-between gap-3 rounded border border-slate-200 px-3 py-2"
              >
                <Space>
                  <Tag color={version.isCurrent ? "green" : "default"}>
                    {version.version}
                  </Tag>
                  {version.isCurrent && <Text type="secondary">当前版本</Text>}
                  <Text type="secondary" className="text-xs">
                    {version.installedAt}
                  </Text>
                </Space>
                {!version.isCurrent && (
                  <Button
                    size="small"
                    onClick={async () => {
                      try {
                        await extensionApi.rollback(item.id, version.version);
                        message.success(`已切换到 v${version.version}`);
                        Modal.destroyAll();
                        await load();
                        notifyExtensionsChanged();
                      } catch (e) {
                        message.error(String(e));
                      }
                    }}
                  >
                    切换到此版本
                  </Button>
                )}
              </div>
            ))}
          </div>
        ),
      });
    } catch (e) {
      message.error(String(e));
    }
  }

  const columns: ColumnsType<ExtensionInfo> = [
    {
      title: "扩展包",
      dataIndex: "name",
      render: (_, item) => (
        <div>
          <Space size={6}>
            <Text strong>{item.name}</Text>
            <Tag>{item.version}</Tag>
            {item.supportsPpt && <Tag color="blue">PPT</Tag>}
          </Space>
          <Paragraph className="!mb-0" type="secondary" ellipsis>
            {item.id} · {item.kind}
          </Paragraph>
        </div>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (_, item) => (
        <Tag color={item.status === "installed" ? "green" : "default"}>
          {item.status}
        </Tag>
      ),
    },
    {
      title: "启用",
      width: 90,
      render: (_, item) => (
        <Switch
          checked={item.enabled}
          onChange={(checked) => void toggleEnabled(item, checked)}
        />
      ),
    },
    {
      title: "操作",
      width: 260,
      render: (_, item) => (
        <Space wrap>
          <Button size="small" onClick={() => void handleVerify(item)}>
            校验
          </Button>
          <Button size="small" onClick={() => void handleVersions(item)}>
            版本
          </Button>
          <Button
            size="small"
            icon={<FolderOpen size={14} />}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(item.path)
                .then(() => message.success("路径已复制"))
                .catch(() => message.info(item.path));
            }}
          >
            复制路径
          </Button>
          <Button
            size="small"
            danger
            icon={<Trash2 size={14} />}
            onClick={() => handleUninstall(item)}
          >
            卸载
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <Typography.Title level={3} className="!mb-1">
            功能扩展包
          </Typography.Title>
          <Text type="secondary">
            扩展包按需安装，未安装时主程序不加载任何引擎；目前支持本地 zip 导入。
          </Text>
        </div>
        <Space>
          <Button icon={<RefreshCw size={16} />} onClick={() => void load()}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PackagePlus size={16} />}
            loading={installing}
            onClick={() => void handleInstall()}
          >
            安装扩展包
          </Button>
        </Space>
      </div>

      <Alert
        className="mb-4"
        type="warning"
        showIcon
        message="安全提示"
        description="扩展包会运行本地 Python 引擎。请只安装可信来源的 zip；安装前会展示权限声明与兼容性。"
      />

      <Card>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                description="尚未安装扩展包"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ),
          }}
        />
      </Card>
    </div>
  );
}
