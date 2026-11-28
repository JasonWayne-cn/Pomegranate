import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Modal,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { pluginApi } from "@/lib/api";
import type { PluginAuditLogEntry, PluginInfo } from "@/types";

const { Paragraph, Text } = Typography;

const PERMISSION_LABELS: Record<string, string> = {
  "editor:read": "读取编辑器",
  "editor:write": "修改编辑器",
  "workspace:read": "读取工作区",
  "workspace:write": "修改工作区",
  "notes:read": "读取文档",
  "notes:write": "修改文档",
  "settings:read": "读取设置",
  "settings:write": "修改设置",
  "files:read": "读取文件",
  "files:write": "写入文件",
  "network:request": "网络请求",
  "clipboard:read": "读取剪贴板",
  "clipboard:write": "写入剪贴板",
};

function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

function PluginAuditLog({ pluginId }: { pluginId: string }) {
  const [logs, setLogs] = useState<PluginAuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLogs(await pluginApi.getAuditLog(pluginId, 20));
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [pluginId]);

  useEffect(() => {
    if (expanded && logs.length === 0) void load();
  }, [expanded, logs.length, load]);

  return (
    <div style={{ marginTop: 8 }}>
      <Button
        size="small"
        type="link"
        onClick={() => setExpanded((value) => !value)}
        loading={loading}
      >
        {expanded ? "收起" : "展开"}
      </Button>
      {expanded && (
        <div
          style={{
            maxHeight: 200,
            overflowY: "auto",
            marginTop: 4,
            fontSize: 11,
            color: "var(--ant-color-text-secondary)",
          }}
        >
          {logs.length === 0 && !loading && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              无审计记录
            </Text>
          )}
          {logs.map((entry) => (
            <div
              key={entry.id}
              style={{
                padding: "2px 0",
                borderBottom: "1px solid var(--ant-color-border-secondary)",
              }}
            >
              <span style={{ opacity: 0.6 }}>{entry.timestamp.slice(0, 19)}</span>
              {" · "}
              <span style={{ fontWeight: 500 }}>{entry.operation}</span>
              {entry.target && (
                <>
                  {" → "}
                  <code style={{ fontSize: 10 }}>{entry.target}</code>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface PluginDetailModalProps {
  plugin: PluginInfo | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

/** 插件详情：权限授权、贡献点与审计日志。 */
export function PluginDetailModal({
  plugin,
  open,
  onClose,
  onChanged,
}: PluginDetailModalProps) {
  const pendingPermissions = plugin
    ? plugin.permissions.filter(
        (permission) => !plugin.grantedPermissions.includes(permission),
      )
    : [];

  async function grantAll() {
    if (!plugin) return;
    try {
      await pluginApi.grantPermissions(plugin.id, pendingPermissions);
      message.success("已授权");
      onChanged();
    } catch (e) {
      message.error(`授权失败：${e}`);
    }
  }

  async function revokeAll() {
    if (!plugin) return;
    try {
      await pluginApi.revokePermissions(plugin.id, plugin.grantedPermissions);
      message.success("已撤销授权");
      onChanged();
    } catch (e) {
      message.error(`撤销失败：${e}`);
    }
  }

  return (
    <Modal
      open={open}
      title={plugin ? `详情：${plugin.name}` : "详情"}
      width={760}
      footer={
        plugin ? (
          <Space>
            <Button onClick={onClose}>关闭</Button>
            <Button
              icon={<ShieldOff size={14} />}
              disabled={plugin.grantedPermissions.length === 0}
              onClick={() => void revokeAll()}
            >
              撤销全部授权
            </Button>
            <Button
              type="primary"
              icon={<ShieldCheck size={14} />}
              disabled={pendingPermissions.length === 0}
              onClick={() => void grantAll()}
            >
              授权全部权限
            </Button>
          </Space>
        ) : null
      }
      onCancel={onClose}
    >
      {plugin && (
        <Space orientation="vertical" style={{ width: "100%" }} size="middle">
          {pendingPermissions.length > 0 && (
            <Alert
              type="warning"
              showIcon
              title={`还有 ${pendingPermissions.length} 项权限未授权`}
              description="未授权的功能在启用后会被拒绝调用。确认信任后，点击下方「授权全部权限」完成授权。"
            />
          )}

          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="ID">{plugin.id}</Descriptions.Item>
            <Descriptions.Item label="版本">{plugin.version}</Descriptions.Item>
            <Descriptions.Item label="作者">
              {plugin.author || "未知"}
            </Descriptions.Item>
            <Descriptions.Item label="入口文件">{plugin.main}</Descriptions.Item>
            <Descriptions.Item label="样式文件">
              {plugin.styles || "无"}
            </Descriptions.Item>
            <Descriptions.Item label="最低应用版本">
              {plugin.minAppVersion || "未声明"}
            </Descriptions.Item>
            <Descriptions.Item label="安装路径">
              <Paragraph copyable style={{ marginBottom: 0 }}>
                {plugin.path}
              </Paragraph>
            </Descriptions.Item>
          </Descriptions>

          <div>
            <Text strong>权限</Text>
            <div style={{ marginTop: 8 }}>
              {plugin.permissions.length === 0 ? (
                <Tag>无权限</Tag>
              ) : (
                <Space size={[0, 6]} wrap>
                  {plugin.permissions.map((permission) => (
                    <Tag
                      key={permission}
                      color={
                        plugin.grantedPermissions.includes(permission)
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
                <Tag>命令 {plugin.manifest.contributes.commands.length}</Tag>
                <Tag>
                  侧栏视图 {plugin.manifest.contributes.sidebarViews.length}
                </Tag>
                {plugin.manifest.contributes.settings && <Tag>设置面板</Tag>}
              </Space>
            </div>
          </div>

          <div>
            <Text strong>审计日志（最近 20 条）</Text>
            <PluginAuditLog pluginId={plugin.id} />
          </div>
        </Space>
      )}
    </Modal>
  );
}
