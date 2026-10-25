import { useEffect, useState } from "react";
import { Button, Card, Form, Input, Progress, Space, Switch, Tag, message } from "antd";
import { listen } from "@tauri-apps/api/event";
import { embeddingApi } from "@/lib/api";
import type { EmbeddingConfig } from "@/types";

/**
 * Embedding 模型配置（向量检索）。
 *
 * 流程：填表单 → 测试连接（拿维度）→ 保存 → 重建索引。
 * 维度未知时禁用「保存」，强制先测试；API Key 留空表示保持原值（不回显）。
 */
export function EmbeddingSection() {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [dim, setDim] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(
    null,
  );

  useEffect(() => {
    embeddingApi
      .get()
      .then((cfg: EmbeddingConfig | null) => {
        if (cfg) {
          form.setFieldsValue({
            api_url: cfg.api_url,
            model_id: cfg.model_id,
            is_enabled: cfg.is_enabled,
          });
          setDim(cfg.dim > 0 ? cfg.dim : null);
        }
      })
      .catch(() => {});
  }, [form]);

  async function handleTest() {
    const values = await form.validateFields();
    setTesting(true);
    try {
      const d = await embeddingApi.test({
        api_url: values.api_url,
        model_id: values.model_id,
        is_enabled: values.is_enabled ?? false,
        api_key: values.api_key ?? null,
      });
      setDim(d);
      message.success(`连接成功，向量维度 ${d}`);
    } catch (e) {
      message.error(String(e));
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await embeddingApi.save(
        {
          api_url: values.api_url,
          model_id: values.model_id,
          is_enabled: values.is_enabled ?? false,
          // 空 → undefined，后端保持原值（避免误清 Key）
          api_key: values.api_key ? values.api_key : undefined,
        },
        dim ?? 0,
      );
      message.success("已保存");
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleReindex() {
    setReindexing(true);
    setProgress(null);
    const unlisten = await listen<{ done: number; total: number; failed: number }>(
      "ai:reindex_progress",
      (e) => setProgress(e.payload),
    );
    try {
      const r = await embeddingApi.reindex();
      message.success(`重建完成：${r.done}/${r.total}（失败 ${r.failed}）`);
    } catch (e) {
      message.error(String(e));
    } finally {
      setReindexing(false);
      unlisten();
    }
  }

  return (
    <Card title="Embedding 模型（向量检索）" size="small">
      <Form form={form} layout="vertical">
        <Form.Item
          name="api_url"
          label="API 地址"
          rules={[{ required: true, message: "请输入 API 地址" }]}
        >
          <Input placeholder="https://api.openai.com/v1" />
        </Form.Item>
        <Form.Item
          name="model_id"
          label="模型"
          rules={[{ required: true, message: "请输入模型名" }]}
        >
          <Input placeholder="text-embedding-3-small" />
        </Form.Item>
        <Form.Item name="api_key" label="API Key">
          <Input.Password placeholder="留空保持原值" />
        </Form.Item>
        <Form.Item name="is_enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>

      <Space wrap>
        <Button onClick={handleTest} loading={testing}>
          测试连接
        </Button>
        <Button type="primary" onClick={handleSave} loading={saving} disabled={dim === null}>
          保存
        </Button>
        <Button onClick={handleReindex} loading={reindexing} disabled={dim === null}>
          重建索引
        </Button>
        {dim !== null && <Tag color="blue">维度 {dim}</Tag>}
      </Space>

      {progress && progress.total > 0 && (
        <Progress
          style={{ marginTop: 12 }}
          percent={Math.round((progress.done / progress.total) * 100)}
          status={progress.failed > 0 ? "exception" : "active"}
          format={() => `${progress.done}/${progress.total}（失败 ${progress.failed}）`}
        />
      )}
    </Card>
  );
}
