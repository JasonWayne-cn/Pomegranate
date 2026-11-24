/**
 * 语音识别（ASR）设置区。
 *
 * 当前仅接入阿里云百炼 DashScope；通过 AsrProviderKind 抽象，未来增加新厂商
 * 只需扩 Provider 下拉与后端 enum 即可，UI 不变。
 *
 * - API Key 明文存到 app_config 表（与 ai_models.api_key 风格一致）
 * - 默认模型 qwen3-asr-flash：同步多模态 API，支持 base64 直传，无需轮询
 * - 「测试连接」仅校验鉴权，不消耗识别用量
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  List,
  Progress,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
  theme as antdTheme,
} from "antd";
import { Mic, ExternalLink, Share2, Download, Plus, Trash2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { asrApi } from "@/lib/api";
import { ShareConfigModal } from "@/components/config-share/ShareConfigModal";
import { ImportConfigModal } from "@/components/config-share/ImportConfigModal";
import { exportAsrConfig, type Envelope } from "@/lib/configShare";
import type {
  AsrConfig,
  AsrLocalModelStatus,
  AsrLocalProgress,
  AsrVocabularyTerm,
} from "@/types";

const { Text, Paragraph } = Typography;

const PROVIDER_OPTIONS = [
  { value: "dashscope", label: "阿里云百炼 DashScope（云端）" },
  { value: "local", label: "本地离线 · SenseVoice Small (INT8)" },
];

const MODEL_OPTIONS = [
  {
    value: "qwen3-asr-flash",
    label: "qwen3-asr-flash（推荐 · 同步多模态 API · 支持 base64 直传）",
  },
];

const REGION_OPTIONS = [
  { value: "beijing", label: "中国（北京）" },
  { value: "singapore", label: "国际（新加坡）" },
];

const APPLY_KEY_URL = "https://bailian.console.aliyun.com/";

const DEFAULT_CONFIG: AsrConfig = {
  provider: "dashscope",
  apiKey: "",
  model: "qwen3-asr-flash",
  region: "beijing",
  enabled: false,
  correctionEnabled: false,
};

export function AsrSection() {
  const { token } = antdTheme.useToken();
  const [cfg, setCfg] = useState<AsrConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [shareEnv, setShareEnv] = useState<Envelope | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  async function reloadConfig() {
    setLoading(true);
    try {
      const remote = await asrApi.getConfig();
      setCfg(remote);
    } catch (e) {
      message.error(`读取语音识别配置失败：${e}`);
    } finally {
      setLoading(false);
    }
  }

  function handleShare() {
    if (cfg.provider !== "local" && !cfg.apiKey.trim()) {
      message.warning("当前还没填 API Key，没什么可分享的");
      return;
    }
    setShareEnv(exportAsrConfig(cfg));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = await asrApi.getConfig();
        if (!cancelled) setCfg(remote);
      } catch (e) {
        message.error(`读取语音识别配置失败：${e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof AsrConfig>(key: K, value: AsrConfig[K]) {
    setCfg((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (cfg.enabled && cfg.provider !== "local" && !cfg.apiKey.trim()) {
      message.warning("启用语音识别前必须填写 API Key");
      return;
    }
    setSaving(true);
    try {
      await asrApi.saveConfig(cfg);
      message.success("已保存");
    } catch (e) {
      message.error(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (cfg.provider !== "local" && !cfg.apiKey.trim()) {
      message.warning("请先填写 API Key");
      return;
    }
    setTesting(true);
    try {
      const result = await asrApi.testConnection(cfg);
      if (result.ok) {
        message.success(
          cfg.provider === "local"
            ? "本地模型已就绪"
            : `连接正常（${result.latencyMs} ms）`,
        );
      } else {
        message.error(`连接失败：${result.message ?? "未知原因"}`);
      }
    } catch (e) {
      message.error(`测试失败：${e}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card
      id="settings-asr"
      size="small"
      className="mb-4"
      title={
        <span className="flex items-center gap-2">
          <Mic size={16} style={{ color: token.colorPrimary }} />
          语音识别
        </span>
      }
      extra={
        <Space size={4}>
          <Button
            size="small"
            icon={<Share2 size={14} />}
            onClick={handleShare}
            title="分享到其他设备（含加密）"
          >
            分享
          </Button>
          <Button
            size="small"
            icon={<Download size={14} />}
            onClick={() => setImportOpen(true)}
            title="从 JSON / 二维码导入"
          >
            导入
          </Button>
        </Space>
      }
    >
      <Form layout="vertical" disabled={loading} size="small">
        <Form.Item label="启用">
          <Switch
            checked={cfg.enabled}
            onChange={(v) => update("enabled", v)}
          />
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            未启用时录音组件按钮会置灰
          </Text>
        </Form.Item>

        <Form.Item label="服务商">
          <Select
            value={cfg.provider}
            options={PROVIDER_OPTIONS}
            onChange={(v) => update("provider", v)}
            style={{ maxWidth: 320 }}
          />
        </Form.Item>

        {cfg.provider === "local" ? (
          <Form.Item label="本地模型">
            <LocalModelPanel />
          </Form.Item>
        ) : (
          <>
        <Form.Item
          label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              API Key
              <Typography.Link
                onClick={() => openUrl(APPLY_KEY_URL)}
                style={{
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 2,
                }}
              >
                去申请 <ExternalLink size={12} />
              </Typography.Link>
            </span>
          }
        >
          <Input.Password
            value={cfg.apiKey}
            onChange={(e) => update("apiKey", e.target.value)}
            placeholder="sk-xxxxxxxxxxxxxxxx"
            autoComplete="off"
            style={{ maxWidth: 480 }}
          />
        </Form.Item>

        <Form.Item label="模型">
          <Select
            value={cfg.model}
            options={MODEL_OPTIONS}
            onChange={(v) => update("model", v)}
            style={{ maxWidth: 480 }}
          />
        </Form.Item>

        <Form.Item label="区域">
          <Select
            value={cfg.region}
            options={REGION_OPTIONS}
            onChange={(v) => update("region", v)}
            style={{ maxWidth: 320 }}
          />
        </Form.Item>
          </>
        )}

        <Alert
          type="info"
          showIcon
          className="mb-3"
          message={
            cfg.provider === "local"
              ? "在本机完成识别，音频不上传"
              : "通过云端 API 把语音转成文字"
          }
          description={
            cfg.provider === "local" ? (
              <Paragraph style={{ marginBottom: 0, fontSize: 12 }} type="secondary">
                首次使用需下载识别引擎与 SenseVoice Small (INT8) 模型（约 260MB），
                保存在本地数据目录，不随安装包分发；下载完成后识别完全离线。
              </Paragraph>
            ) : (
              <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                <Paragraph style={{ marginBottom: 4, fontSize: 12 }}>
                  <Text strong style={{ fontSize: 12 }}>使用步骤：</Text>
                  ① 去
                  <Typography.Link
                    onClick={() => openUrl(APPLY_KEY_URL)}
                    style={{ fontSize: 12, margin: "0 2px" }}
                  >
                    阿里云百炼控制台
                  </Typography.Link>
                  申请 API Key → ② 粘到上方并保存 → ③ 启用开关后即可在录音组件中使用。
                </Paragraph>
                <Paragraph style={{ marginBottom: 0, fontSize: 12 }} type="secondary">
                  仅本地保存 Key，应用本身不打包语音模型，识别由阿里云在云端完成（按用量计费，注册即送免费额度）。
                </Paragraph>
              </div>
            )
          }
        />

        <Form.Item label="识别后自动纠正术语">
          <Switch
            checked={cfg.correctionEnabled}
            onChange={(v) => update("correctionEnabled", v)}
          />
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            使用默认 AI 模型，仅发送识别文本（不含音频），且只采纳下方词表内的术语替换
          </Text>
        </Form.Item>

        <Form.Item label="术语词表">
          <VocabularyManager />
        </Form.Item>

        <Form.Item style={{ marginBottom: 0 }}>
          <Space>
            <Button type="primary" onClick={handleSave} loading={saving}>
              保存
            </Button>
            <Button onClick={handleTest} loading={testing}>
              测试连接
            </Button>
          </Space>
        </Form.Item>
      </Form>

      <ShareConfigModal
        open={shareEnv !== null}
        onClose={() => setShareEnv(null)}
        envelope={shareEnv}
      />
      <ImportConfigModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void reloadConfig()}
      />
    </Card>
  );
}

/**
 * 术语词表管理：列表 + 新增（术语 + 逗号分隔别名）+ 删除。
 *
 * 词表只影响"识别后纠错"：只有命中词表的替换才会被采纳，
 * 因此这里录入的术语越贴近用户实际领域，纠错越稳。
 */
function VocabularyManager() {
  const [terms, setTerms] = useState<AsrVocabularyTerm[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [term, setTerm] = useState("");
  const [aliases, setAliases] = useState("");

  async function reload() {
    setLoading(true);
    try {
      setTerms(await asrApi.listVocabulary());
    } catch (e) {
      message.error(`读取词表失败：${e}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleAdd() {
    const t = term.trim();
    if (!t) {
      message.warning("请输入术语");
      return;
    }
    const list = aliases
      .split(/[,，、;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      await asrApi.addVocabulary({ term: t, aliases: list });
      setTerm("");
      setAliases("");
      await reload();
    } catch (e) {
      message.error(`添加失败：${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id: number) {
    try {
      await asrApi.removeVocabulary(id);
      await reload();
    } catch (e) {
      message.error(`删除失败：${e}`);
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <Space.Compact style={{ width: "100%", marginBottom: 8 }}>
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onPressEnter={() => void handleAdd()}
          placeholder="标准写法，如 Tauri"
          style={{ width: "40%" }}
        />
        <Input
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          onPressEnter={() => void handleAdd()}
          placeholder="常被听错：涛瑞, 陶瑞"
        />
        <Button
          type="primary"
          loading={saving}
          icon={<Plus size={14} />}
          onClick={() => void handleAdd()}
        >
          添加
        </Button>
      </Space.Compact>

      <List
        size="small"
        loading={loading}
        dataSource={terms}
        locale={{ emptyText: "暂无词条；添加后可在识别结果中自动纠正" }}
        renderItem={(item) => (
          <List.Item
            actions={[
              <Button
                key="del"
                type="text"
                size="small"
                danger
                icon={<Trash2 size={14} />}
                onClick={() => void handleRemove(item.id)}
                aria-label={`删除 ${item.term}`}
              />,
            ]}
          >
            <Space size={4} wrap>
              <Text strong>{item.term}</Text>
              {item.aliases.map((a) => (
                <Tag key={a} style={{ marginInlineEnd: 0 }}>
                  {a}
                </Tag>
              ))}
            </Space>
          </List.Item>
        )}
      />
    </div>
  );
}

/**
 * 本地离线资源面板：引擎（sherpa-onnx CLI）+ 模型（SenseVoice Small INT8）。
 *
 * 两者都在首次使用时按需下载到数据目录，不随安装包分发。
 * 下载进度通过 `asr-local:progress` 事件推送。
 */
function LocalModelPanel() {
  const [status, setStatus] = useState<AsrLocalModelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AsrLocalProgress | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await asrApi.localModelStatus());
    } catch (e) {
      message.error(`读取本地模型状态失败：${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<AsrLocalProgress>("asr-local:progress", (event) => {
      if (event.payload.stage === "done") {
        setProgress(null);
      } else {
        setProgress(event.payload);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function handleDownload() {
    setBusy(true);
    try {
      await asrApi.localModelDownload();
      message.success("本地引擎与模型已就绪");
      await reload();
    } catch (e) {
      message.error(`下载失败：${e}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function handleRemove() {
    setBusy(true);
    try {
      await asrApi.localModelRemove();
      message.success("已删除本地引擎与模型");
      await reload();
    } catch (e) {
      message.error(`删除失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <Text type="secondary" style={{ fontSize: 12 }}>正在检查本地资源…</Text>;
  }

  const ready = status?.ready ?? false;
  const percent = progress?.percent ?? 0;
  const stageLabel = progress
    ? progress.stage === "extracting"
      ? "正在解压识别引擎…"
      : `正在下载 ${progress.file || ""}`
    : "";

  return (
    <div style={{ maxWidth: 560 }}>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Space wrap>
          <Tag color={ready ? "green" : "default"}>{ready ? "已就绪" : "未下载"}</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            引擎 + 模型约 {formatBytes(status?.approxBytes ?? 0)}
            {status && status.bytesOnDisk > 0
              ? ` · 已占用 ${formatBytes(status.bytesOnDisk)}`
              : ""}
          </Text>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          使用 SenseVoice Small (INT8)。引擎与模型单独下载、保存在数据目录，不随安装包分发；
          识别在本机完成，音频不上传。
        </Text>
        {!ready && status?.message && (
          <Text type="warning" style={{ fontSize: 12 }}>{status.message}</Text>
        )}
        {(busy || progress) && (
          <div>
            <Progress percent={Math.round(percent)} size="small" status="active" />
            {stageLabel && (
              <Text type="secondary" style={{ fontSize: 12 }}>{stageLabel}</Text>
            )}
          </div>
        )}
        <Space>
          <Button
            type="primary"
            loading={busy}
            icon={<Download size={14} />}
            onClick={() => void handleDownload()}
          >
            {ready ? "重新下载" : "下载引擎与模型"}
          </Button>
          <Button
            danger
            disabled={busy || !ready}
            onClick={() => void handleRemove()}
          >
            删除
          </Button>
        </Space>
      </Space>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
