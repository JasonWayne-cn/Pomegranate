import { useEffect, useRef, useState } from "react";
import {
  AutoComplete,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
  theme as antdTheme,
} from "antd";
import {
  CheckCircleFilled,
  CheckCircleOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { Pencil, Trash2, Zap } from "lucide-react";
import { aiModelApi } from "@/lib/api";
import type { AiModel, AiModelInput } from "@/types";

/**
 * AI 模型配置。
 *
 * 从设置页内联代码抽离，供设置页与 AI 模块抽屉共用。
 * `compact` 用于 720px 抽屉：卡片更紧凑、表格允许横向滚动。
 */

const PROVIDERS = [
  { value: "ollama", label: "Ollama (本地)" },
  { value: "lmstudio", label: "LM Studio (本地 OpenAI 兼容)" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "zhipu", label: "智谱 AI (GLM)" },
  { value: "claude", label: "Claude (经 OpenRouter 等代理)" },
  { value: "minimax", label: "Minimax" },
  { value: "siliconflow", label: "SiliconFlow (硅基流动)" },
  { value: "custom", label: "自定义 (OpenAI 兼容)" },
];

const DEFAULT_URLS: Record<string, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  claude: "https://openrouter.ai/api/v1",
  minimax: "https://api.minimax.chat/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  custom: "",
};

const MODEL_ID_PLACEHOLDERS: Record<string, string> = {
  ollama: "如: qwen2.5:7b / llama3.2:3b",
  lmstudio: "看 LM Studio 模型页右上角 Model 标识",
  openai: "如: gpt-4o-mini / gpt-4o",
  deepseek: "如: deepseek-chat / deepseek-reasoner",
  zhipu: "如: glm-4-plus / glm-4-flash / glm-4-air",
  claude: "如: anthropic/claude-sonnet-4.6 (经 OpenRouter 等兼容代理)",
  minimax: "如: abab6.5s-chat / MiniMax-M1",
  siliconflow: "如: Qwen/Qwen2.5-72B-Instruct / deepseek-ai/DeepSeek-V3",
  custom: "填你目标服务的模型标识",
};

/**
 * 模型增删改后广播，让设置页与模块抽屉中的多个实例同步刷新。
 * 设置页 Tab 使用 destroyInactiveTabPane=false，实例会常驻；
 * 只靠组件内部 loadModels 会让另一个入口显示旧列表。
 */
const AI_MODELS_CHANGED_EVENT = "ai-models-changed";

const MODEL_PRESETS: Record<string, { value: string; label: string }[]> = {
  ollama: [
    { value: "qwen3:4b", label: "qwen3:4b (千问3 / 入门)" },
    { value: "qwen3:8b", label: "qwen3:8b (千问3 / 推荐)" },
    { value: "qwen3:14b", label: "qwen3:14b (千问3 / 进阶)" },
    { value: "qwen3:32b", label: "qwen3:32b (千问3 / 旗舰)" },
    { value: "qwen3:30b-a3b", label: "qwen3:30b-a3b (千问3 / MoE)" },
    { value: "qwq:32b", label: "qwq:32b (千问推理 / o1 同级)" },
    { value: "qwen2.5:7b", label: "qwen2.5:7b" },
    { value: "qwen2.5:14b", label: "qwen2.5:14b" },
    { value: "qwen2.5:32b", label: "qwen2.5:32b" },
    { value: "qwen2.5:72b", label: "qwen2.5:72b" },
    { value: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b (编程)" },
    { value: "qwen2.5-coder:14b", label: "qwen2.5-coder:14b (编程)" },
    { value: "qwen2.5-coder:32b", label: "qwen2.5-coder:32b (编程)" },
    { value: "llama3.1:8b", label: "llama3.1:8b" },
    { value: "gemma2:9b", label: "gemma2:9b" },
  ],
  openai: [
    { value: "gpt-4o", label: "gpt-4o" },
    { value: "gpt-4o-mini", label: "gpt-4o-mini" },
    { value: "gpt-4-turbo", label: "gpt-4-turbo" },
    { value: "gpt-3.5-turbo", label: "gpt-3.5-turbo" },
    { value: "o1-mini", label: "o1-mini" },
    { value: "o1-preview", label: "o1-preview" },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "deepseek-chat (V3 通用)" },
    { value: "deepseek-reasoner", label: "deepseek-reasoner (推理)" },
  ],
  zhipu: [
    { value: "glm-4-plus", label: "glm-4-plus (旗舰)" },
    { value: "glm-4-0520", label: "glm-4-0520" },
    { value: "glm-4-air", label: "glm-4-air (轻量)" },
    { value: "glm-4-airx", label: "glm-4-airx" },
    { value: "glm-4-flash", label: "glm-4-flash (免费)" },
    { value: "glm-4-long", label: "glm-4-long (长上下文)" },
  ],
  claude: [
    { value: "anthropic/claude-sonnet-4.6", label: "anthropic/claude-sonnet-4.6 (OpenRouter)" },
    { value: "anthropic/claude-opus-4.7", label: "anthropic/claude-opus-4.7 (OpenRouter)" },
    { value: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929" },
    { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001" },
  ],
  lmstudio: [],
  minimax: [
    { value: "abab6.5s-chat", label: "abab6.5s-chat (高速)" },
    { value: "abab6.5-chat", label: "abab6.5-chat" },
    { value: "MiniMax-M1", label: "MiniMax-M1" },
  ],
  siliconflow: [
    { value: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen/Qwen2.5-72B-Instruct" },
    { value: "Qwen/Qwen2.5-Coder-32B-Instruct", label: "Qwen/Qwen2.5-Coder-32B-Instruct" },
    { value: "deepseek-ai/DeepSeek-V3", label: "deepseek-ai/DeepSeek-V3" },
    { value: "deepseek-ai/DeepSeek-R1", label: "deepseek-ai/DeepSeek-R1 (推理)" },
    { value: "Pro/THUDM/glm-4-9b-chat", label: "GLM-4-9B-Chat (Pro)" },
  ],
  custom: [],
};

interface Props {
  compact?: boolean;
}

export function AiModelsSection({ compact }: Props) {
  const { token } = antdTheme.useToken();
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(false);
  // 新增/编辑表单直接内联在 Tab 内，不再弹 Modal
  const [formOpen, setFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<AiModel | null>(null);
  const [testingModelId, setTestingModelId] = useState<number | null>(null);
  const [form] = Form.useForm<AiModelInput>();
  const formRef = useRef<HTMLDivElement>(null);
  const watchedProvider = Form.useWatch("provider", form) || "ollama";

  async function loadModels() {
    setLoading(true);
    try {
      setModels(await aiModelApi.list());
    } catch (e) {
      message.error(`加载模型失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  const loadModelsRef = useRef(loadModels);
  loadModelsRef.current = loadModels;

  useEffect(() => {
    // 与设置页原行为一致：避开首帧，交给下一轮事件循环
    const timer = window.setTimeout(() => void loadModelsRef.current(), 0);
    const onChanged = () => void loadModelsRef.current();
    window.addEventListener(AI_MODELS_CHANGED_EVENT, onChanged);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(AI_MODELS_CHANGED_EVENT, onChanged);
    };
  }, []);

  function notifyModelsChanged() {
    window.dispatchEvent(new Event(AI_MODELS_CHANGED_EVENT));
  }

  function revealForm() {
    setFormOpen(true);
    // 等内联表单渲染后滚到可见位置（抽屉内部是独立滚动容器）
    requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
  }

  function closeForm() {
    setFormOpen(false);
    setEditingModel(null);
    form.resetFields();
  }

  function openAddModel() {
    setEditingModel(null);
    form.resetFields();
    form.setFieldsValue({ provider: "ollama", api_url: DEFAULT_URLS.ollama });
    revealForm();
  }

  function openEditModel(model: AiModel) {
    setEditingModel(model);
    form.setFieldsValue({
      name: model.name,
      provider: model.provider,
      api_url: model.api_url,
      api_key: model.api_key,
      model_id: model.model_id,
      max_context: model.max_context,
    });
    revealForm();
  }

  function handleProviderChange(provider: string) {
    form.setFieldValue("api_url", DEFAULT_URLS[provider] || "");
  }

  async function handleModelSave() {
    try {
      const values = await form.validateFields();
      const maxContextNum = values.max_context
        ? parseInt(String(values.max_context), 10)
        : 32000;
      const payload = {
        ...values,
        max_context: Number.isFinite(maxContextNum) ? maxContextNum : 32000,
      };
      if (editingModel) {
        await aiModelApi.update(editingModel.id, payload);
        message.success("模型已更新");
      } else {
        await aiModelApi.create(payload);
        message.success("模型已添加");
      }
      setFormOpen(false);
      setEditingModel(null);
      notifyModelsChanged();
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`保存失败: ${e}`);
    }
  }

  async function handleDeleteModel(id: number) {
    try {
      await aiModelApi.delete(id);
      message.success("模型已删除");
      notifyModelsChanged();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  async function handleSetDefault(id: number) {
    try {
      await aiModelApi.setDefault(id);
      message.success("已设为默认模型");
      notifyModelsChanged();
    } catch (e) {
      message.error(`设置失败: ${e}`);
    }
  }

  async function runModelTest(input: AiModelInput, rowId: number, label: string) {
    setTestingModelId(rowId);
    try {
      const result = await aiModelApi.test(input);
      const tail = result.sample ? ` · 样本: "${result.sample}"` : "";
      message.success(`✓ [${label}] 连接成功 · 延迟 ${result.latency_ms}ms${tail}`);
    } catch (e) {
      Modal.error({
        title: `[${label}] 测试失败`,
        width: 560,
        content: (
          <pre className="whitespace-pre-wrap text-xs leading-relaxed m-0">
            {String(e)}
          </pre>
        ),
      });
    } finally {
      setTestingModelId(null);
    }
  }

  function handleTestRow(record: AiModel) {
    void runModelTest(
      {
        name: record.name,
        provider: record.provider,
        api_url: record.api_url,
        api_key: record.api_key,
        model_id: record.model_id,
        max_context: record.max_context,
      },
      record.id,
      record.name,
    );
  }

  async function handleTestForm() {
    try {
      const values = await form.validateFields();
      const maxContextNum = values.max_context
        ? parseInt(String(values.max_context), 10)
        : 32000;
      const payload: AiModelInput = {
        ...values,
        max_context: Number.isFinite(maxContextNum) ? maxContextNum : 32000,
      };
      await runModelTest(payload, -1, payload.name || "当前表单");
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`测试失败: ${e}`);
    }
  }

  const modelColumns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (text: string, record: AiModel) => (
        <span className="flex items-center gap-1.5">
          {text}
          {record.is_default && (
            <Tag color="gold" className="ml-1">
              默认
            </Tag>
          )}
        </span>
      ),
    },
    {
      title: "提供商",
      dataIndex: "provider",
      key: "provider",
      render: (text: string) => {
        const label = PROVIDERS.find((p) => p.value === text)?.label || text;
        return <Tag>{label}</Tag>;
      },
    },
    {
      title: "模型 ID",
      dataIndex: "model_id",
      key: "model_id",
      render: (text: string) => (
        <code className="text-xs px-1.5 py-0.5 rounded bg-gray-100">{text}</code>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 200,
      render: (_: unknown, record: AiModel) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<Zap size={14} />}
            loading={testingModelId === record.id}
            disabled={testingModelId !== null && testingModelId !== record.id}
            onClick={() => handleTestRow(record)}
            title="测试连通性"
          />
          <Button
            type="text"
            size="small"
            icon={
              record.is_default ? (
                <CheckCircleFilled style={{ color: "#52c41a" }} />
              ) : (
                <CheckCircleOutlined />
              )
            }
            disabled={record.is_default}
            onClick={() => void handleSetDefault(record.id)}
            title={record.is_default ? "当前默认模型" : "设为默认"}
          />
          <Button
            type="text"
            size="small"
            icon={<Pencil size={14} />}
            onClick={() => openEditModel(record)}
          />
          <Popconfirm
            title="确认删除此模型？"
            onConfirm={() => void handleDeleteModel(record.id)}
          >
            <Button type="text" size="small" danger icon={<Trash2 size={14} />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      id="settings-ai-models"
      size={compact ? "small" : "default"}
      title="AI 模型配置"
      styles={compact ? { body: { padding: 12 } } : undefined}
      extra={
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={formOpen ? closeForm : openAddModel}
        >
          {formOpen ? "收起" : "添加模型"}
        </Button>
      }
    >
      {/* 新增 / 编辑表单直接内联在 Tab 内，不再走 Modal */}
      {formOpen && (
        <div
          ref={formRef}
          style={{
            marginBottom: 16,
            padding: 12,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 8,
            background: token.colorFillQuaternary,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
            {editingModel ? "编辑 AI 模型" : "添加 AI 模型"}
          </div>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ provider: "ollama", api_url: DEFAULT_URLS.ollama }}
          >
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入模型名称" }]}
          >
            <Input placeholder="如: GPT-4o Mini" />
          </Form.Item>
          <Form.Item
            name="provider"
            label="提供商"
            extra="除 Ollama 外都按 OpenAI 兼容协议处理。选「自定义」可填任意 baseUrl（OpenRouter / Moonshot / 字节豆包 / 自建网关 / lm studio 等任何 OpenAI 兼容服务）"
            rules={[{ required: true }]}
          >
            <Select options={PROVIDERS} onChange={handleProviderChange} />
          </Form.Item>
          <Form.Item
            name="api_url"
            label="API 地址"
            extra="支持任意 OpenAI 兼容服务的 base_url（不含 /chat/completions 后缀）"
            rules={[{ required: true, message: "请输入 API 地址" }]}
          >
            <Input
              placeholder={DEFAULT_URLS[watchedProvider] || "https://api.openai.com/v1"}
            />
          </Form.Item>
          <Form.Item name="api_key" label="API Key">
            <Input.Password placeholder="sk-... (Ollama 无需填写)" />
          </Form.Item>
          <Form.Item
            name="model_id"
            label="模型标识"
            extra="✏️ 可直接输入任意模型名（如 anthropic/claude-sonnet-4.6、moonshotai/kimi-k2 等），不必限于下拉候选"
            rules={[{ required: true, message: "请输入或选择模型标识" }]}
          >
            <AutoComplete
              options={MODEL_PRESETS[watchedProvider] || []}
              placeholder={MODEL_ID_PLACEHOLDERS[watchedProvider] || "如: gpt-4o-mini / qwen2.5:7b"}
              filterOption={(input, option) =>
                (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
              }
              allowClear
            />
          </Form.Item>
          <Form.Item
            name="max_context"
            label="最大上下文 token"
            extra="从下拉选常用量级，或手动输入任意数字。不确定就保留 32000。"
            initialValue={32000}
          >
            <AutoComplete
              placeholder="32000"
              options={[
                { value: 32000, label: "32K  （OpenAI 老款 / 默认）" },
                { value: 64000, label: "64K" },
                { value: 128000, label: "128K （DeepSeek / GPT-4o / 智谱）" },
                { value: 200000, label: "200K （Claude）" },
                { value: 1000000, label: "1M   （GLM-Long / MiniMax-M1）" },
                { value: 2000000, label: "2M" },
              ]}
              filterOption={(input, option) => {
                const q = input.trim().toLowerCase();
                if (!q) return true;
                return (
                  String(option?.value ?? "").includes(q) ||
                  String(option?.label ?? "").toLowerCase().includes(q)
                );
              }}
              style={{ width: "100%" }}
            />
          </Form.Item>
          </Form>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 4,
            }}
          >
            <Button
              icon={<Zap size={14} />}
              loading={testingModelId === -1}
              disabled={testingModelId !== null && testingModelId !== -1}
              onClick={() => void handleTestForm()}
            >
              测试连接
            </Button>
            <Space>
              <Button onClick={closeForm}>取消</Button>
              <Button type="primary" onClick={() => void handleModelSave()}>
                保存
              </Button>
            </Space>
          </div>
        </div>
      )}

      <Table
        columns={modelColumns}
        dataSource={models}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="small"
        scroll={{ x: 560 }}
      />
    </Card>
  );
}

export default AiModelsSection;
