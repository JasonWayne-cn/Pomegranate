import { useEffect, useMemo, useState } from "react";
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
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  FolderPlus,
  Plug,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { pluginApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { PluginInfo } from "@/types";

const { Text, Paragraph } = Typography;

const PERMISSION_LABELS: Record<string, string> = {
  "editor:read": "读取编辑器",
  "editor:write": "修改编辑器",
  "workspace:read": "读取工作区",
  "workspace:write": "修改工作区",
  "notes:read": "读取笔记",
  "notes:write": "修改笔记",
  "settings:read": "读取设置",
  "settings:write": "修改设置",
  "files:read": "读取文件",
  "files:write": "写入文件",
  "network:request": "网络请求",
  "clipboard:read": "读取剪贴板",
  "clipboard:write": "写入剪贴板",
};

function permissionLabel(permission: string) {
  return PERMISSION_LABELS[permission] ?? permission;
}

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

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [selected, setSelected] = useState<PluginInfo | null>(null);
  const bumpPluginSidebarRefresh = useAppStore((s) => s.bumpPluginSidebarRefresh);

  useEffect(() => {
    void scanPlugins();
  }, []);

  async function loadPlugins() {
    setLoading(true);
    try {
      const data = await pluginApi.list();
      setPlugins(data);
      return data;
    } catch (e) {
      message.error(`加载插件失败：${e}`);
      return [];
    } finally {
      setLoading(false);
    }
  }

  async function scanPlugins() {
    setLoading(true);
    try {
      const data = await pluginApi.scan();
      setPlugins(data);
      if (selected) {
        setSelected(data.find((p) => p.id === selected.id) ?? null);
      }
      return data;
    } catch (e) {
      message.error(`扫描插件失败：${e}`);
      return [];
    } finally {
      setLoading(false);
    }
  }

  async function handleInstall() {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择插件目录",
      });
      if (!picked || Array.isArray(picked)) return;
      setInstalling(true);
      await pluginApi.installFromDir(picked);
      message.success("插件已安装");
      await scanPlugins();
    } catch (e) {
      message.error(`安装失败：${e}`);
    } finally {
      setInstalling(false);
    }
  }

  async function handleToggle(plugin: PluginInfo, enabled: boolean) {
    try {
      if (enabled) {
        await pluginApi.enable(plugin.id);
      } else {
        await pluginApi.disable(plugin.id);
      }
      setPlugins((prev) =>
        prev.map((p) => (p.id === plugin.id ? { ...p, enabled } : p)),
      );
      if (selected?.id === plugin.id) {
        setSelected({ ...selected, enabled });
      }
      // 通知 ActivityBar 刷新插件侧栏视图
      bumpPluginSidebarRefresh();
    } catch (e) {
      message.error(`切换失败：${e}`);
    }
  }

  function confirmUninstall(plugin: PluginInfo) {
    Modal.confirm({
      title: `卸载插件「${plugin.name}」？`,
      content: "将删除插件目录与本地设置，操作不可撤销。",
      okText: "卸载",
      okType: "danger",
      cancelText: "取消",
      async onOk() {
        try {
          await pluginApi.uninstall(plugin.id);
          message.success("已卸载");
          if (selected?.id === plugin.id) setSelected(null);
          await loadPlugins();
        } catch (e) {
          message.error(`卸载失败：${e}`);
          throw e;
        }
      },
    });
  }

  async function grantAll(plugin: PluginInfo) {
    const pending = plugin.permissions.filter(
      (p) => !plugin.grantedPermissions.includes(p),
    );
    if (pending.length === 0) return;
    try {
      await pluginApi.grantPermissions(plugin.id, pending);
      message.success("已授权");
      await scanPlugins();
    } catch (e) {
      message.error(`授权失败：${e}`);
    }
  }

  async function revokeAll(plugin: PluginInfo) {
    if (plugin.grantedPermissions.length === 0) return;
    try {
      await pluginApi.revokePermissions(plugin.id, plugin.grantedPermissions);
      message.success("已撤销授权");
      await scanPlugins();
    } catch (e) {
      message.error(`撤销失败：${e}`);
    }
  }

  const columns: ColumnsType<PluginInfo> = useMemo(
    () => [
      {
        title: "插件",
        dataIndex: "name",
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Space size={6}>
              <Text strong>{record.name}</Text>
              <Tag color="geekblue">v{record.version}</Tag>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.description || record.id}
            </Text>
          </Space>
        ),
      },
      {
        title: "作者",
        dataIndex: "author",
        width: 140,
        render: (author) => author || <Text type="secondary">未知</Text>,
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 110,
        render: (status) => <Tag color={statusColor(status)}>{status}</Tag>,
      },
      {
        title: "权限",
        dataIndex: "permissions",
        render: (_, record) => {
          if (record.permissions.length === 0) {
            return <Tag>无权限</Tag>;
          }
          return (
            <Space size={[0, 4]} wrap>
              {record.permissions.map((permission) => {
                const granted = record.grantedPermissions.includes(permission);
                return (
                  <Tooltip key={permission} title={permission}>
                    <Tag color={granted ? "green" : "orange"}>
                      {permissionLabel(permission)}
                    </Tag>
                  </Tooltip>
                );
              })}
            </Space>
          );
        },
      },
      {
        title: "启用",
        dataIndex: "enabled",
        width: 90,
        render: (_, record) => (
          <Switch
            checked={record.enabled}
            disabled={record.status !== "installed"}
            onChange={(checked) => handleToggle(record, checked)}
          />
        ),
      },
      {
        title: "操作",
        width: 180,
        render: (_, record) => (
          <Space>
            <Button size="small" onClick={() => setSelected(record)}>
              详情
            </Button>
            <Button
              size="small"
              danger
              icon={<Trash2 size={14} />}
              onClick={() => confirmUninstall(record)}
            >
              卸载
            </Button>
          </Space>
        ),
      },
    ],
    [selected],
  );

  return (
    <div className="max-w-6xl mx-auto">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Plug size={18} />
            插件
          </span>
        }
        extra={
          <Space>
            <Button icon={<RefreshCw size={14} />} onClick={scanPlugins}>
              扫描
            </Button>
            <Button
              type="primary"
              icon={<FolderPlus size={14} />}
              loading={installing}
              onClick={handleInstall}
            >
              安装本地插件
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="当前是插件系统 MVP"
          description="已支持插件 manifest 扫描、安装、启用状态、权限授权与设置存储；第三方 JS 运行时会在沙箱能力完成后再开放。"
        />

        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={plugins}
          locale={{
            emptyText: (
              <Empty
                description="暂无插件"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ),
          }}
          pagination={false}
        />
      </Card>

      <Modal
        open={!!selected}
        title={selected ? `插件详情：${selected.name}` : "插件详情"}
        width={760}
        footer={
          selected ? (
            <Space>
              <Button onClick={() => setSelected(null)}>关闭</Button>
              <Button
                icon={<ShieldOff size={14} />}
                disabled={selected.grantedPermissions.length === 0}
                onClick={() => revokeAll(selected)}
              >
                撤销全部授权
              </Button>
              <Button
                type="primary"
                icon={<ShieldCheck size={14} />}
                disabled={selected.permissions.every((p) =>
                  selected.grantedPermissions.includes(p),
                )}
                onClick={() => grantAll(selected)}
              >
                授权全部权限
              </Button>
            </Space>
          ) : null
        }
        onCancel={() => setSelected(null)}
      >
        {selected && (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="ID">{selected.id}</Descriptions.Item>
              <Descriptions.Item label="版本">{selected.version}</Descriptions.Item>
              <Descriptions.Item label="作者">
                {selected.author || "未知"}
              </Descriptions.Item>
              <Descriptions.Item label="入口文件">{selected.main}</Descriptions.Item>
              <Descriptions.Item label="样式文件">
                {selected.styles || "无"}
              </Descriptions.Item>
              <Descriptions.Item label="最低应用版本">
                {selected.minAppVersion || "未声明"}
              </Descriptions.Item>
              <Descriptions.Item label="安装路径">
                <Paragraph copyable style={{ marginBottom: 0 }}>
                  {selected.path}
                </Paragraph>
              </Descriptions.Item>
            </Descriptions>

            <div>
              <Text strong>权限</Text>
              <div style={{ marginTop: 8 }}>
                {selected.permissions.length === 0 ? (
                  <Tag>无权限</Tag>
                ) : (
                  <Space size={[0, 6]} wrap>
                    {selected.permissions.map((permission) => (
                      <Tag
                        key={permission}
                        color={
                          selected.grantedPermissions.includes(permission)
                            ? "green"
                            : "orange"
                        }
                      >
                        {permissionLabel(permission)}
                      </Tag>
                    ))}
                  </Space>
                )}
              </div>
            </div>

            <div>
              <Text strong>贡献点</Text>
              <div style={{ marginTop: 8 }}>
                <Space size={[0, 6]} wrap>
                  <Tag>命令 {selected.manifest.contributes.commands.length}</Tag>
                  <Tag>侧栏视图 {selected.manifest.contributes.sidebarViews.length}</Tag>
                  {selected.manifest.contributes.settings && <Tag>设置面板</Tag>}
                </Space>
              </div>
            </div>
          </Space>
        )}
      </Modal>
    </div>
  );
}
