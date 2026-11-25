import { useEffect, useState } from "react";
import { Modal, Form, Input, Select, InputNumber, message } from "antd";
import { aiModelApi } from "@/lib/api";
import type { AiModel, AiModelInput } from "@/types";
import {
  findPreset,
  groupProviderOptions,
  modelOptions,
  modelPlaceholder,
  presetContextWindow,
  useAiProviderPresets,
} from "@/lib/aiProviderPresets";

/**
 * 移动端「新增 AI 模型」对话框（MobileAi 列表 chip 区 / MobileAiChat 顶栏 Drawer 共用）。
 *
 * - 服务商清单来自 ai-profile crate（与桌面、Sigil 同一份，含 Anthropic 协议）
 * - 切换服务商 → 自动回填 名称 / API 地址 / 模型 ID（该服务商的默认模型）
 * - 模型 ID：有预设的走 Select（带搜索）；无预设的（本机服务 / 自定义）走 Input
 * - 上下文窗口：可留空，对话时回落到预置值
 * - 保存成功后调 onSaved(model)，调用方可借此自动切换当前对话用这个新模型
 */
export function MobileAiModelModal({
  open,
  onClose,
  onSaved,
  okText = "保存",
  defaultProvider = "deepseek",
  editing = null,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (model: AiModel) => void;
  okText?: string;
  defaultProvider?: string;
  /** 传入则进入编辑模式（不回显 API Key；留空表示保持原 Key） */
  editing?: AiModel | null;
}) {
  const [form] = Form.useForm<AiModelInput>();
  const presets = useAiProviderPresets();
  const [provider, setProvider] = useState(defaultProvider);
  const preset = findPreset(presets, provider);
  const watchedModelId = Form.useWatch("model_id", form) as string | undefined;

  /** 按服务商回填 名称 / 地址 / 默认模型 */
  function fillFrom(p: string) {
    const pre = findPreset(presets, p);
    form.setFieldsValue({
      name: pre?.label ?? p,
      api_url: pre?.baseUrl ?? "",
      model_id: pre?.model || pre?.models[0]?.value || "",
    });
  }

  // 每次打开重置：编辑回填已保存字段（Key 留空=保持），新建回到默认服务商
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setProvider(editing.provider);
      form.setFieldsValue({
        name: editing.name,
        provider: editing.provider,
        api_url: editing.api_url,
        api_key: "",
        model_id: editing.model_id,
        max_context: editing.max_context || undefined,
      });
      return;
    }
    setProvider(defaultProvider);
    form.setFieldsValue({ provider: defaultProvider });
    if (presets.length > 0) fillFrom(defaultProvider);
    // fillFrom 只读 presets / form，随它们变化即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProvider, presets, editing]);

  function onProviderChange(p: string) {
    setProvider(p);
    fillFrom(p);
  }

  async function submit() {
    try {
      const values = await form.validateFields();
      const ctx = values.max_context && values.max_context > 0 ? values.max_context : null;
      // 编辑时 Key 留空 = 保持原值（后端三态：省略字段）
      const input: AiModelInput = {
        ...values,
        max_context: ctx ?? undefined,
        limits_source: ctx !== null ? "user" : null,
      };
      if (editing && !values.api_key) delete input.api_key;

      const saved = editing
        ? await aiModelApi.update(editing.id, input)
        : await aiModelApi.create(input);
      message.success(editing ? `已更新 ${saved.name}` : `已添加 ${saved.name}`);
      onSaved(saved);
      onClose();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error(`${editing ? "更新" : "添加"}失败: ${e}`);
    }
  }

  const presetOptions = modelOptions(preset);
  const presetWindow = presetContextWindow(preset, watchedModelId);

  return (
    <Modal
      title={editing ? "编辑模型服务" : "新建模型服务"}
      open={open}
      onOk={submit}
      onCancel={onClose}
      okText={okText}
      cancelText="取消"
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ provider: defaultProvider, api_key: "" }}
      >
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: "请输入名称" }]}
        >
          <Input placeholder="模型展示名" />
        </Form.Item>
        <Form.Item
          name="provider"
          label="服务商"
          rules={[{ required: true }]}
        >
          {/* 移动端列表长、屏幕窄：开搜索并显示副文本，否则 20+ 条要滑很久 */}
          <Select
            showSearch
            onChange={onProviderChange}
            optionRender={(opt) => {
              const hint = (opt.data as { hint?: string | null }).hint;
              return (
                <div className="flex flex-col leading-tight py-0.5">
                  <span>{opt.data.label as string}</span>
                  {hint && <span className="text-xs whitespace-normal text-slate-400">{hint}</span>}
                </div>
              );
            }}
            filterOption={(input, option) => {
              const q = input.trim().toLowerCase();
              if (!q) return true;
              return ((option as { searchText?: string } | undefined)?.searchText ?? "").includes(q);
            }}
            optionLabelProp="title"
            options={groupProviderOptions(presets)}
          />
        </Form.Item>
        <Form.Item
          name="api_url"
          label="API 地址"
          extra="含 /v1 等版本段，不含 /chat/completions；原样使用，不会替你补"
          rules={[{ required: true, message: "请输入 API 地址" }]}
        >
          <Input placeholder={preset?.baseUrl || "https://你的服务地址/v1"} />
        </Form.Item>
        <Form.Item name="api_key" label="API Key">
          <Input.Password placeholder={preset?.isLocal ? "本机服务通常不需要" : "sk-..."} />
        </Form.Item>
        <Form.Item
          name="model_id"
          label="模型 ID"
          rules={[{ required: true, message: "请选择或输入模型 ID" }]}
        >
          {presetOptions.length > 0 ? (
            <Select
              showSearch
              options={presetOptions}
              placeholder={modelPlaceholder(preset)}
              optionFilterProp="label"
            />
          ) : (
            <Input placeholder={modelPlaceholder(preset)} />
          )}
        </Form.Item>
        <Form.Item
          name="max_context"
          label="上下文窗口 token（可选）"
          tooltip="影响发消息时拼接文档的预算。留空 = 用预置值；没有预置值时按保守预算处理"
        >
          <InputNumber
            min={1024}
            max={10000000}
            step={1024}
            className="w-full"
            placeholder={presetWindow ? presetWindow.toLocaleString("en-US") : "未知"}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
