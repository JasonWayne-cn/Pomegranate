import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Modal, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { pluginApi } from "@/lib/api";
import type { PluginQuarantineEntry } from "@/types";

const { Text } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

/** 卸载隔离区：列出所有被隔离的插件目录，支持恢复 */
export function PluginQuarantineModal({ open, onClose, onChanged }: Props) {
  const [entries, setEntries] = useState<PluginQuarantineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await pluginApi.listQuarantine());
    } catch (e) {
      message.error(`加载隔离记录失败：${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function handleRestore(entry: PluginQuarantineEntry) {
    setRestoring(`${entry.id}`);
    try {
      await pluginApi.restoreQuarantined(entry.pluginId);
      message.success(`已恢复 ${entry.pluginId} v${entry.version}`);
      await load();
      await onChanged();
    } catch (e) {
      message.error(String(e));
    } finally {
      setRestoring(null);
    }
  }

  const columns: ColumnsType<PluginQuarantineEntry> = [
    {
      title: "插件",
      dataIndex: "pluginId",
      render: (_, entry) => (
        <Space direction="vertical" size={0}>
          <Space>
            <Text strong>{entry.pluginId}</Text>
            <Tag>{entry.version}</Tag>
          </Space>
          <Text type="secondary" className="text-xs">
            {entry.quarantinePath}
          </Text>
        </Space>
      ),
    },
    {
      title: "隔离时间",
      dataIndex: "quarantinedAt",
      width: 170,
    },
    {
      title: "状态",
      width: 100,
      render: (_, entry) =>
        entry.restoredAt ? (
          <Tag color="default">已恢复</Tag>
        ) : (
          <Tag color="orange">未恢复</Tag>
        ),
    },
    {
      title: "操作",
      width: 90,
      render: (_, entry) =>
        entry.restoredAt ? null : (
          <Button
            size="small"
            loading={restoring === `${entry.id}`}
            onClick={() => void handleRestore(entry)}
          >
            恢复
          </Button>
        ),
    },
  ];

  return (
    <Modal
      open={open}
      width={760}
      title="卸载恢复"
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
      <Text type="secondary" className="mb-3 block">
        卸载插件的目录会先移入隔离区并保留设置备份；恢复后重新出现在扩展列表（默认停用）。
      </Text>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={entries}
        loading={loading}
        pagination={false}
        locale={{
          emptyText: (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有隔离记录" />
          ),
        }}
      />
    </Modal>
  );
}
