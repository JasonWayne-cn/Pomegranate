import { useState } from "react";
import {
  Button,
  Card,
  Drawer,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  Copy,
  Download,
  Eye,
  FileText,
  Pencil,
  Trash2,
} from "lucide-react";
import { MarkdownContent } from "@/components/ai/MarkdownContent";
import { researchApi } from "@/lib/api/research";
import type { ResearchOutput, ResearchProject } from "@/types/research";

const { Text } = Typography;

const KIND_META: Record<string, { label: string; color: string }> = {
  frontier: { label: "前沿追踪", color: "blue" },
  review: { label: "文献综述", color: "purple" },
  outline: { label: "论文框架", color: "gold" },
  polish: { label: "语言润色", color: "green" },
  format: { label: "规范检查", color: "orange" },
  analyze: { label: "数据分析", color: "cyan" },
  note: { label: "文档", color: "default" },
};

interface OutputsPanelProps {
  project: ResearchProject;
  outputs: ResearchOutput[];
  loading: boolean;
  onRefresh: () => void;
}

export function OutputsPanel({
  project,
  outputs,
  loading,
  onRefresh,
}: OutputsPanelProps) {
  const [viewing, setViewing] = useState<ResearchOutput | null>(null);
  const [editing, setEditing] = useState<ResearchOutput | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [exportingId, setExportingId] = useState<number | null>(null);

  async function handleCopy(item: ResearchOutput) {
    try {
      await navigator.clipboard.writeText(item.content);
      message.success("已复制到剪贴板");
    } catch {
      message.error("复制失败，请打开详情手动复制");
    }
  }

  async function handleExport(item: ResearchOutput) {
    setExportingId(item.id);
    try {
      const note = await researchApi.exportOutputToNote(item.id);
      message.success(`已导出为文档：${note.title}`);
    } catch (err) {
      message.error(String(err));
    } finally {
      setExportingId(null);
    }
  }

  async function handleDelete(item: ResearchOutput) {
    try {
      await researchApi.deleteOutput(item.id);
      if (viewing?.id === item.id) setViewing(null);
      message.success("产出已删除");
      onRefresh();
    } catch (err) {
      message.error(String(err));
    }
  }

  function openEdit(item: ResearchOutput) {
    setEditing(item);
    setEditTitle(item.title);
    setEditContent(item.content);
  }

  async function handleSaveEdit() {
    if (!editing) return;
    if (!editTitle.trim()) {
      message.warning("标题不能为空");
      return;
    }
    setSaving(true);
    try {
      const updated = await researchApi.updateOutput(
        editing.id,
        editTitle.trim(),
        editContent,
      );
      message.success("产出已更新");
      setEditing(null);
      if (viewing?.id === updated.id) setViewing(updated);
      onRefresh();
    } catch (err) {
      message.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  const columns: ColumnsType<ResearchOutput> = [
    {
      title: "类型",
      dataIndex: "kind",
      key: "kind",
      width: 110,
      render: (value: string) => {
        const meta = KIND_META[value] ?? { label: value, color: "default" };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: "标题",
      dataIndex: "title",
      key: "title",
      render: (value: string, record) => (
        <div>
          <div className="font-medium">{value}</div>
          <Text type="secondary" className="text-xs">
            {record.content.slice(0, 90)}
            {record.content.length > 90 ? "…" : ""}
          </Text>
        </div>
      ),
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 170,
    },
    {
      title: "操作",
      key: "actions",
      width: 220,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button
            type="text"
            size="small"
            icon={<Eye size={14} />}
            onClick={() => setViewing(record)}
          >
            查看
          </Button>
          <Button
            type="text"
            size="small"
            icon={<Pencil size={14} />}
            onClick={() => openEdit(record)}
          />
          <Button
            type="text"
            size="small"
            icon={<Download size={14} />}
            loading={exportingId === record.id}
            onClick={() => void handleExport(record)}
          >
            导出文档
          </Button>
          <Popconfirm
            title="删除这份产出？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleDelete(record)}
          >
            <Button type="text" size="small" danger icon={<Trash2 size={14} />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <FileText size={16} />
          <span>产出（{outputs.length}）</span>
        </Space>
      }
      extra={
        <Space>
          <Tag>{project.title}</Tag>
          <Button size="small" onClick={onRefresh}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table<ResearchOutput>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={outputs}
        pagination={{ pageSize: 10, showSizeChanger: false }}
        locale={{ emptyText: "还没有产出。去「前沿追踪」「学术写作」或「数据分析」生成一份初稿。" }}
      />

      <Drawer
        title={viewing?.title ?? "产出详情"}
        open={!!viewing}
        onClose={() => setViewing(null)}
        width={760}
        extra={
          viewing ? (
            <Space>
              <Tag color={KIND_META[viewing.kind]?.color ?? "default"}>
                {KIND_META[viewing.kind]?.label ?? viewing.kind}
              </Tag>
              <Button
                size="small"
                icon={<Copy size={13} />}
                onClick={() => void handleCopy(viewing)}
              >
                复制
              </Button>
              <Button
                size="small"
                icon={<Download size={13} />}
                loading={exportingId === viewing.id}
                onClick={() => void handleExport(viewing)}
              >
                导出文档
              </Button>
              <Button size="small" icon={<Pencil size={13} />} onClick={() => openEdit(viewing)}>
                编辑
              </Button>
            </Space>
          ) : null
        }
      >
        {viewing ? (
          <div className="ai-markdown">
            <Text type="secondary" className="mb-3 block text-xs">
              创建于 {viewing.createdAt}
              {viewing.sourceRef ? ` · 来源 ${viewing.sourceRef}` : ""}
            </Text>
            <MarkdownContent>{viewing.content}</MarkdownContent>
          </div>
        ) : null}
      </Drawer>

      <Modal
        title="编辑产出"
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={() => void handleSaveEdit()}
        confirmLoading={saving}
        okText="保存"
        width={760}
      >
        <Text className="mb-1 block">标题</Text>
        <Input
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          className="mb-4"
        />
        <Text className="mb-1 block">内容（Markdown）</Text>
        <Input.TextArea
          rows={16}
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
        />
      </Modal>
    </Card>
  );
}
