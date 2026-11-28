import { useCallback, useEffect, useMemo, useState } from "react";
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
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArchiveRestore,
  FolderOpen,
  PackagePlus,
  RefreshCw,
  RotateCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { pluginApi } from "@/lib/api";
import { extensionApi } from "@/lib/api/extension";
import { PackageInstallButton } from "@/components/package/PackageInstallButton";
import { PluginDetailModal } from "@/components/plugins/PluginDetailModal";
import { PluginErrorLog } from "@/components/plugins/PluginErrorLog";
import { PluginLifecycleModal } from "@/components/plugins/PluginLifecycleModal";
import { PluginQuarantineModal } from "@/components/plugins/PluginQuarantineModal";
import { pluginManager } from "@/services/pluginManager";
import type { PluginInfo } from "@/types";
import type { ExtensionInfo } from "@/types/extension";
import TemplateLibrary from "./TemplateLibrary";

const { Paragraph, Text, Title } = Typography;

function notifyExtensionsChanged() {
  window.dispatchEvent(new Event("app:extensions-changed"));
}

/** 统一列表项：对用户不区分插件与扩展包 */
type UnifiedItem =
  | {
      key: string;
      kind: "plugin";
      id: string;
      name: string;
      version: string;
      status: string;
      enabled: boolean;
      detail: string;
      plugin: PluginInfo;
    }
  | {
      key: string;
      kind: "extension";
      id: string;
      name: string;
      version: string;
      status: string;
      enabled: boolean;
      detail: string;
      supportsPpt: boolean;
      extension: ExtensionInfo;
    };

function statusColor(status: string) {
  switch (status) {
    case "installed":
      return "blue";
    case "invalid":
      return "red";
    case "error":
      return "volcano";
    default:
      return "default";
  }
}

export default function ExtensionsPage() {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPlugin, setSelectedPlugin] = useState<PluginInfo | null>(null);
  const [selectedExtension, setSelectedExtension] =
    useState<ExtensionInfo | null>(null);
  const [lifecyclePlugin, setLifecyclePlugin] = useState<PluginInfo | null>(null);
  const [quarantineOpen, setQuarantineOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [extResult, pluginResult] = await Promise.allSettled([
        extensionApi.list(),
        pluginApi.scan(),
      ]);
      if (extResult.status === "fulfilled") {
        setExtensions(extResult.value);
      } else {
        message.error(`加载扩展失败：${String(extResult.reason)}`);
      }
      if (pluginResult.status === "fulfilled") {
        setPlugins(pluginResult.value);
      } else {
        message.error(`加载扩展失败：${String(pluginResult.reason)}`);
      }
      return {
        extensions:
          extResult.status === "fulfilled" ? extResult.value : [],
        plugins: pluginResult.status === "fulfilled" ? pluginResult.value : [],
      };
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 安装入口可能在另一处触发，安装后统一刷新
  useEffect(() => {
    const refresh = () => {
      void load();
    };
    window.addEventListener("app:extensions-changed", refresh);
    window.addEventListener("app:plugins-changed", refresh);
    return () => {
      window.removeEventListener("app:extensions-changed", refresh);
      window.removeEventListener("app:plugins-changed", refresh);
    };
  }, [load]);

  const items: UnifiedItem[] = useMemo(
    () => [
      ...extensions.map((extension) => ({
        key: `extension:${extension.id}`,
        kind: "extension" as const,
        id: extension.id,
        name: extension.name,
        version: extension.version,
        status: extension.status,
        enabled: extension.enabled,
        detail: extension.id,
        supportsPpt: extension.supportsPpt,
        extension,
      })),
      ...plugins.map((plugin) => ({
        key: `plugin:${plugin.id}`,
        kind: "plugin" as const,
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        status: plugin.status,
        enabled: plugin.enabled,
        detail: plugin.description || plugin.id,
        plugin,
      })),
    ],
    [extensions, plugins],
  );

  async function toggleEnabled(item: UnifiedItem, enabled: boolean) {
    try {
      if (item.kind === "plugin") {
        if (enabled) {
          await pluginApi.enable(item.id);
          try {
            await pluginManager.activatePlugin({ ...item.plugin, enabled: true });
          } catch (e) {
            message.warning(`已启用，但运行时启动失败：${e}`);
          }
        } else {
          try {
            await pluginManager.deactivatePlugin(item.id);
          } catch (e) {
            console.warn(`停用运行时失败：${e}`);
          }
          await pluginApi.disable(item.id);
        }
      } else if (enabled) {
        await extensionApi.enable(item.id);
      } else {
        await extensionApi.disable(item.id);
      }
      message.success(enabled ? "已启用" : "已禁用");
      await load();
      notifyExtensionsChanged();
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleUninstall(item: UnifiedItem) {
    Modal.confirm({
      title: `卸载 ${item.name}？`,
      content:
        item.kind === "plugin"
          ? "插件目录会移入隔离区并保留设置备份，可在「卸载恢复」中还原；数据库记录将被删除。"
          : "扩展文件会被删除，已生成的 PPT 工程目录不会自动删除。",
      okText: "卸载",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          if (item.kind === "plugin") {
            try {
              await pluginManager.deactivatePlugin(item.id);
            } catch (e) {
              console.warn(`停用运行时失败：${e}`);
            }
            await pluginApi.uninstall(item.id);
            if (selectedPlugin?.id === item.id) setSelectedPlugin(null);
          } else {
            await extensionApi.uninstall(item.id);
            if (selectedExtension?.id === item.id) setSelectedExtension(null);
          }
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
            {versions.length === 0 && (
              <Text type="secondary">暂无版本记录</Text>
            )}
            {versions.map((version) => (
              <div
                key={version.version}
                className="flex items-center justify-between gap-3 rounded border border-slate-200 px-3 py-2"
              >
                <Space>
                  <Tag color={version.isCurrent ? "green" : "default"}>
                    {version.version}
                  </Tag>
                  {version.isCurrent && (
                    <Text type="secondary">当前版本</Text>
                  )}
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

  function copyPath(path: string) {
    void navigator.clipboard
      ?.writeText(path)
      .then(() => message.success("路径已复制"))
      .catch(() => message.info(path));
  }

  const columns: ColumnsType<UnifiedItem> = [
    {
      title: "扩展",
      dataIndex: "name",
      render: (_, item) => (
        <div>
          <Space size={6}>
            <Text strong>{item.name}</Text>
            <Tag>{item.version}</Tag>
            {item.kind === "extension" && item.supportsPpt && (
              <Tag color="blue">PPT</Tag>
            )}
          </Space>
          <Paragraph className="!mb-0" type="secondary" ellipsis>
            {item.detail}
          </Paragraph>
        </div>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (_, item) => (
        <Tag color={statusColor(item.status)}>{item.status}</Tag>
      ),
    },
    {
      title: "启用",
      width: 90,
      render: (_, item) => (
        <Switch
          checked={item.enabled}
          disabled={item.kind === "plugin" && item.status !== "installed"}
          onChange={(checked) => void toggleEnabled(item, checked)}
        />
      ),
    },
    {
      title: "操作",
      width: 240,
      render: (_, item) => (
        <Space wrap>
          <Button
            size="small"
            onClick={() => {
              if (item.kind === "plugin") setSelectedPlugin(item.plugin);
              else setSelectedExtension(item.extension);
            }}
          >
            详情
          </Button>
          {item.kind === "plugin" && (
            <Button
              size="small"
              icon={<Settings2 size={14} />}
              onClick={() => setLifecyclePlugin(item.plugin)}
            >
              管理
            </Button>
          )}
          {item.kind === "plugin" &&
            item.enabled &&
            pluginManager.isActive(item.id) && (
              <Button
                size="small"
                icon={<RotateCw size={14} />}
                onClick={async () => {
                  try {
                    await pluginManager.reloadPlugin(item.id);
                    message.success("已重新加载");
                  } catch (e) {
                    message.error(`重载失败：${e}`);
                  }
                }}
              />
            )}
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
      <div className="mb-4">
        <Title level={3} className="!mb-1">
          扩展
        </Title>
        <Text type="secondary">
          扩展按需安装，安装包会自动识别类型；用户模板可随时导入。
        </Text>
      </div>

      <Tabs
        items={[
          {
            key: "engine",
            label: "扩展",
            children: (
              <div>
                <div className="mb-4 flex items-start justify-between gap-4">
                  <Text type="secondary">
                    未安装时主程序不加载任何扩展；目前支持本地 zip 导入。
                  </Text>
                  <Space>
                    <Button
                      icon={<RefreshCw size={16} />}
                      onClick={() => void load()}
                    >
                      刷新
                    </Button>
                    <Button
                      icon={<ArchiveRestore size={16} />}
                      onClick={() => setQuarantineOpen(true)}
                    >
                      卸载恢复
                    </Button>
                    <PackageInstallButton
                      label="安装"
                      icon={<PackagePlus size={16} />}
                      onInstalled={async () => {
                        await load();
                        notifyExtensionsChanged();
                      }}
                    />
                  </Space>
                </div>

                <Alert
                  className="mb-4"
                  type="warning"
                  showIcon
                  message="安全提示"
                  description="部分扩展会运行本地引擎或向界面注入功能。请只安装可信来源的 zip；安装前会展示权限声明与兼容性。"
                />

                <Card>
                  <Table
                    rowKey="key"
                    columns={columns}
                    dataSource={items}
                    loading={loading}
                    pagination={false}
                    locale={{
                      emptyText: (
                        <Empty
                          description="尚未安装扩展"
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                        />
                      ),
                    }}
                  />
                </Card>

                <PluginErrorLog />
              </div>
            ),
          },
          {
            key: "templates",
            label: "模板库",
            children: <TemplateLibrary />,
          },
        ]}
      />

      <PluginDetailModal
        plugin={selectedPlugin}
        open={!!selectedPlugin}
        onClose={() => setSelectedPlugin(null)}
        onChanged={async () => {
          const data = await load();
          setSelectedPlugin((previous) =>
            previous
              ? (data.plugins.find((item) => item.id === previous.id) ??
                previous)
              : null,
          );
        }}
      />

      <Modal
        open={!!selectedExtension}
        title={selectedExtension ? `详情：${selectedExtension.name}` : "详情"}
        width={640}
        footer={
          selectedExtension ? (
            <Space wrap>
              <Button onClick={() => setSelectedExtension(null)}>关闭</Button>
              <Button
                icon={<FolderOpen size={14} />}
                onClick={() => copyPath(selectedExtension.path)}
              >
                复制路径
              </Button>
              <Button
                onClick={() => void handleVersions(selectedExtension)}
              >
                版本
              </Button>
              <Button
                type="primary"
                onClick={() => void handleVerify(selectedExtension)}
              >
                校验
              </Button>
            </Space>
          ) : null
        }
        onCancel={() => setSelectedExtension(null)}
      >
        {selectedExtension && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="ID">
              {selectedExtension.id}
            </Descriptions.Item>
            <Descriptions.Item label="版本">
              {selectedExtension.version}
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={statusColor(selectedExtension.status)}>
                {selectedExtension.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="安装路径">
              <Paragraph copyable style={{ marginBottom: 0 }}>
                {selectedExtension.path}
              </Paragraph>
            </Descriptions.Item>
            <Descriptions.Item label="支持 PPT">
              {selectedExtension.supportsPpt ? "是" : "否"}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>

      <PluginLifecycleModal
        plugin={lifecyclePlugin}
        open={!!lifecyclePlugin}
        onClose={() => setLifecyclePlugin(null)}
        onChanged={async () => {
          const data = await load();
          setLifecyclePlugin((previous) =>
            previous
              ? (data.plugins.find((item) => item.id === previous.id) ?? null)
              : null,
          );
          notifyExtensionsChanged();
        }}
      />

      <PluginQuarantineModal
        open={quarantineOpen}
        onClose={() => setQuarantineOpen(false)}
        onChanged={async () => {
          await load();
        }}
      />
    </div>
  );
}
