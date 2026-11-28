import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Modal,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import { ArchiveRestore, History } from "lucide-react";
import { pluginApi } from "@/lib/api";
import type {
  PluginActivationState,
  PluginInfo,
  PluginQuarantineEntry,
  PluginVersionEntry,
} from "@/types";

const { Text, Paragraph } = Typography;

interface Props {
  plugin: PluginInfo | null;
  open: boolean;
  onClose: () => void;
  /** 数据变更后通知外层刷新列表 */
  onChanged: () => Promise<void> | void;
}

function shortHash(hash: string) {
  if (!hash) return "—";
  return `${hash.slice(0, 12)}…`;
}

/** 插件生命周期管理：完整性信息 + 运行代际 + 版本回滚 + 隔离恢复 */
export function PluginLifecycleModal({ plugin, open, onClose, onChanged }: Props) {
  const [loading, setLoading] = useState(false);
  const [activation, setActivation] = useState<PluginActivationState | null>(null);
  const [versions, setVersions] = useState<PluginVersionEntry[]>([]);
  const [quarantines, setQuarantines] = useState<PluginQuarantineEntry[]>([]);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!plugin) return;
    setLoading(true);
    try {
      const [stateResult, versionResult, quarantineResult] =
        await Promise.allSettled([
          pluginApi.getActivationState(plugin.id),
          pluginApi.listVersions(plugin.id),
          pluginApi.listQuarantine(),
        ]);
      setActivation(stateResult.status === "fulfilled" ? stateResult.value : null);
      setVersions(versionResult.status === "fulfilled" ? versionResult.value : []);
      setQuarantines(
        quarantineResult.status === "fulfilled"
          ? quarantineResult.value.filter((entry) => entry.pluginId === plugin.id)
          : [],
      );
    } finally {
      setLoading(false);
    }
  }, [plugin]);

  useEffect(() => {
    if (open && plugin) void load();
  }, [open, plugin, load]);

  async function handleRollback(target: string) {
    if (!plugin) return;
    setBusyVersion(target);
    try {
      await pluginApi.rollback(plugin.id, target);
      message.success(`已回滚到 v${target}`);
      await load();
      await onChanged();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusyVersion(null);
    }
  }

  if (!plugin) return null;

  const unrestored = quarantines.filter((entry) => !entry.restoredAt);

  return (
    <Modal
      open={open}
      width={680}
      title={`插件管理：${plugin.name}`}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      }
    >
      <Spin spinning={loading}>
        <Descriptions column={1} size="small" bordered className="mb-4">
          <Descriptions.Item label="状态">
            <Space>
              <Tag color={plugin.enabled ? "green" : "default"}>
                {plugin.enabled ? "已启用" : "已停用"}
              </Tag>
              <Tag>{plugin.version}</Tag>
              <Tag color="blue">{plugin.installSource}</Tag>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="运行代际">
            <Space>
              <Text>{activation?.generation ?? 0}</Text>
              <Text type="secondary">
                活跃会话 {activation?.activeSessions ?? 0}
              </Text>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="整目录哈希">
            <Paragraph copyable={{ text: plugin.packageHash }} className="!mb-0">
              <Text code>{shortHash(plugin.packageHash)}</Text>
            </Paragraph>
          </Descriptions.Item>
          <Descriptions.Item label="批准哈希">
            <Paragraph copyable={{ text: plugin.approvedHash }} className="!mb-0">
              <Text code>{shortHash(plugin.approvedHash)}</Text>
            </Paragraph>
          </Descriptions.Item>
          <Descriptions.Item label="最近启用">
            {activation?.activatedAt ?? "—"}
          </Descriptions.Item>
          <Descriptions.Item label="最近停用">
            {activation?.deactivatedAt ?? "—"}
          </Descriptions.Item>
        </Descriptions>

        <Alert
          className="mb-4"
          type="info"
          showIcon
          message="完整性校验"
          description="启用与申领令牌时会校验整目录哈希；任何未入口文件被修改都会拒绝启用。"
        />

        <div className="mb-2 flex items-center justify-between">
          <Space>
            <History size={16} />
            <Text strong>版本与回滚</Text>
          </Space>
          {plugin.enabled && <Text type="secondary">回滚前请先停用插件</Text>}
        </div>
        {versions.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无版本记录" />
        ) : (
          <div className="mb-4 space-y-2">
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
                  {version.archived && <Text type="secondary">已归档</Text>}
                </Space>
                {!version.isCurrent && (
                  <Button
                    size="small"
                    disabled={plugin.enabled || busyVersion !== null}
                    loading={busyVersion === version.version}
                    onClick={() => void handleRollback(version.version)}
                  >
                    回滚到此版本
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mb-2 flex items-center justify-between">
          <Space>
            <ArchiveRestore size={16} />
            <Text strong>卸载隔离记录</Text>
          </Space>
        </div>
        {unrestored.length === 0 ? (
          <Text type="secondary">暂无未恢复的隔离记录</Text>
        ) : (
          <div className="space-y-2">
            {unrestored.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded border border-slate-200 px-3 py-2"
              >
                <Space direction="vertical" size={0}>
                  <Space>
                    <Tag>{entry.version}</Tag>
                    <Text type="secondary">{entry.quarantinedAt}</Text>
                  </Space>
                  <Text type="secondary" className="text-xs">
                    {entry.quarantinePath}
                  </Text>
                </Space>
                <Text type="secondary" className="text-xs">
                  插件已安装，恢复请使用「卸载恢复」入口
                </Text>
              </div>
            ))}
          </div>
        )}
      </Spin>
    </Modal>
  );
}
