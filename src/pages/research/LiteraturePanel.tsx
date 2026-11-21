import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { TableRowSelection } from "antd/es/table/interface";
import { BookOpen, FileSearch, Pencil, Plus, Trash2 } from "lucide-react";
import { researchApi } from "@/lib/api/research";
import type {
  ResearchLiterature,
  ResearchLiteratureInput,
  ResearchProject,
} from "@/types/research";

const { Text } = Typography;

const STATUS_OPTIONS = [
  { value: "to_read", label: "待读" },
  { value: "reading", label: "在读" },
  { value: "read", label: "已读" },
];

const STATUS_META: Record<string, { label: string; color: string }> = {
  to_read: { label: "待读", color: "default" },
  reading: { label: "在读", color: "processing" },
  read: { label: "已读", color: "success" },
};

interface LiteraturePanelProps {
  project: ResearchProject;
  literature: ResearchLiterature[];
  loading: boolean;
  selectedIds: number[];
  onSelectedChange: (ids: number[]) => void;
  onRefresh: () => void;
  onGenerateReview: () => void;
}

export function LiteraturePanel({
  project,
  literature,
  loading,
  selectedIds,
  onSelectedChange,
  onRefresh,
  onGenerateReview,
}: LiteraturePanelProps) {
  const [form] = Form.useForm<ResearchLiteratureInput>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ResearchLiterature | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyword, setKeyword] = useState("");

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return literature;
    return literature.filter((item) => {
      const haystack = [
        item.title,
        item.authors,
        item.venue,
        item.abstractText,
        item.tags,
        item.notes,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [literature, keyword]);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ status: "to_read" });
    setModalOpen(true);
  }

  function openEdit(record: ResearchLiterature) {
    setEditing(record);
    form.resetFields();
    form.setFieldsValue({
      title: record.title,
      authors: record.authors,
      year: record.year ?? undefined,
      venue: record.venue,
      abstractText: record.abstractText,
      url: record.url,
      filePath: record.filePath,
      notes: record.notes,
      tags: record.tags,
      status: record.status,
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    let values: ResearchLiteratureInput;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await researchApi.updateLiterature(editing.id, values);
        message.success("文献已更新");
      } else {
        await researchApi.createLiterature(project.id, values);
        message.success("文献已添加");
      }
      setModalOpen(false);
      onRefresh();
    } catch (err) {
      message.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: ResearchLiterature) {
    try {
      await researchApi.deleteLiterature(record.id);
      onSelectedChange(selectedIds.filter((id) => id !== record.id));
      message.success("文献已删除");
      onRefresh();
    } catch (err) {
      message.error(String(err));
    }
  }

  const columns: ColumnsType<ResearchLiterature> = [
    {
      title: "文献",
      dataIndex: "title",
      key: "title",
      width: 360,
      render: (_value, record) => (
        <div className="min-w-0">
          <div className="font-medium">{record.title}</div>
          <Text type="secondary" className="text-xs">
            {[record.authors, record.venue, record.year]
              .filter((item) => item !== "" && item != null)
              .join(" · ") || "未填写出处"}
          </Text>
          {record.abstractText ? (
            <div className="mt-1 line-clamp-2 text-xs text-slate-500">
              {record.abstractText}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: "标签",
      dataIndex: "tags",
      key: "tags",
      width: 180,
      render: (value: string) =>
        value ? (
          <Space size={4} wrap>
            {value
              .split(/[,，\s]+/)
              .filter(Boolean)
              .slice(0, 4)
              .map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (value: string) => {
        const meta = STATUS_META[value] ?? { label: value, color: "default" };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: "操作",
      key: "actions",
      width: 120,
      render: (_value, record) => (
        <Space size={4}>
          <Button
            type="text"
            size="small"
            icon={<Pencil size={14} />}
            onClick={() => openEdit(record)}
          />
          <Popconfirm
            title="删除这篇文献？"
            description="删除后不可恢复。"
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

  const rowSelection: TableRowSelection<ResearchLiterature> = {
    selectedRowKeys: selectedIds,
    onChange: (keys) => onSelectedChange(keys.map((key) => Number(key))),
    preserveSelectedRowKeys: false,
  };

  return (
    <Card
      title={
        <Space>
          <BookOpen size={16} />
          <span>文献库（{literature.length}）</span>
        </Space>
      }
      extra={
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索标题 / 作者 / 摘要"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="w-56"
          />
          <Button icon={<Plus size={14} />} onClick={openCreate}>
            新增文献
          </Button>
          <Button
            type="primary"
            ghost
            icon={<FileSearch size={14} />}
            disabled={selectedIds.length === 0}
            onClick={onGenerateReview}
          >
            用选中文献生成综述（{selectedIds.length}）
          </Button>
        </Space>
      }
    >
      <Table<ResearchLiterature>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={filtered}
        rowSelection={rowSelection}
        pagination={{ pageSize: 10, showSizeChanger: false }}
        locale={{ emptyText: "还没有文献，先添加几篇论文或报告" }}
      />

      <Modal
        title={editing ? "编辑文献" : "新增文献"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={saving}
        okText="保存"
        width={720}
        destroyOnClose
      >
        <Form form={form} layout="vertical" className="mt-4">
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: "请填写文献标题" }]}
          >
            <Input placeholder="论文 / 专著 / 报告标题" />
          </Form.Item>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Form.Item name="authors" label="作者">
              <Input placeholder="张三, 李四" />
            </Form.Item>
            <Form.Item name="year" label="年份">
              <InputNumber min={1800} max={2200} className="w-full" placeholder="2025" />
            </Form.Item>
            <Form.Item name="status" label="阅读状态">
              <Select options={STATUS_OPTIONS} />
            </Form.Item>
          </div>
          <Form.Item name="venue" label="期刊 / 会议 / 出版方">
            <Input placeholder="例如：机械工程学报 / ICML 2025" />
          </Form.Item>
          <Form.Item name="abstractText" label="摘要">
            <Input.TextArea rows={4} placeholder="粘贴摘要，综述生成时会作为主要依据" />
          </Form.Item>
          <Form.Item name="notes" label="阅读文档">
            <Input.TextArea rows={3} placeholder="核心观点、方法、可借鉴之处、局限" />
          </Form.Item>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Form.Item name="tags" label="标签">
              <Input placeholder="逗号分隔，如：工艺优化, 薄壁件" />
            </Form.Item>
            <Form.Item name="url" label="链接">
              <Input placeholder="DOI / 网页地址" />
            </Form.Item>
          </div>
          <Form.Item name="filePath" label="本地文件路径（可选）">
            <Input placeholder="PDF 的本地路径，仅作记录" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
