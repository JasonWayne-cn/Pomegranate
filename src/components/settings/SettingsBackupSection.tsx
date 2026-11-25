import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import {
  AlertTriangle,
  Download,
  Lock,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  parseEnvelope,
  stringifyEncrypted,
  stringifyEnvelope,
  type BundleData,
  type Envelope,
} from "@/lib/configShare";
import {
  ALL_BACKUP_CATEGORIES,
  BACKUP_CATEGORY_LABELS,
  applySettingsBackup,
  backupHasSecrets,
  collectSettingsBackup,
  describeBackup,
  validateBackupData,
  type BackupApplySummary,
  type BackupCategory,
  type BackupPreviewItem,
} from "@/lib/settingsBackup";
import { systemApi } from "@/lib/api";
import { useIsMobile } from "@/hooks/useIsMobile";

const { Text } = Typography;

/** 配置备份文件大小上限（2MB，正常配置远小于此） */
const MAX_BACKUP_BYTES = 2 * 1024 * 1024;

const CATEGORY_OPTIONS = ALL_BACKUP_CATEGORIES.map((category) => ({
  label: BACKUP_CATEGORY_LABELS[category],
  value: category,
}));

function dateStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function randomPin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function summaryText(summary: BackupApplySummary): string {
  const parts: string[] = [];
  if (summary.uiPrefs > 0) parts.push(`界面偏好 ${summary.uiPrefs} 项`);
  if (summary.appConfig > 0) parts.push(`应用设置 ${summary.appConfig} 项`);
  if (summary.aiModels > 0) parts.push(`模型 ${summary.aiModels} 个`);
  if (summary.syncBackends > 0) parts.push(`同步源 ${summary.syncBackends} 个`);
  if (summary.asrConfig) parts.push("语音识别配置");
  return parts.join(" · ") || "（未发现可导入项）";
}

/**
 * 设置页「配置备份」区块。
 *
 * 导出：分类勾选 + 是否含密钥 + PIN → 原生保存对话框写入 `.kbconfig`。
 * 导入：原生打开对话框 → 加密包输 PIN → 预览分类与条数 → 勾选后写入。
 *
 * 桌面端专用：依赖原生文件对话框与 `write_text_file` / `read_text_file`。
 */
export function SettingsBackupSection() {
  const isMobile = useIsMobile();

  // ── 导出 ──
  const [exportCats, setExportCats] = useState<BackupCategory[]>(
    ALL_BACKUP_CATEGORIES,
  );
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [pin, setPin] = useState("");
  const [exporting, setExporting] = useState(false);

  // ── 导入 ──
  const [reading, setReading] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinChecking, setPinChecking] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    data: BundleData;
    items: BackupPreviewItem[];
  } | null>(null);
  const [importCats, setImportCats] = useState<BackupCategory[]>([]);
  const [applying, setApplying] = useState(false);

  // 勾选「包含密钥」且还没填 PIN 时，自动给一个 6 位随机 PIN
  useEffect(() => {
    if (includeSecrets) {
      setPin((prev) => prev.trim() || randomPin());
    }
  }, [includeSecrets]);

  async function handleExport() {
    if (exportCats.length === 0) {
      message.warning("请至少选择一个导出分类");
      return;
    }
    if (includeSecrets && !pin.trim()) {
      message.error("包含密钥时必须设置 PIN");
      return;
    }
    setExporting(true);
    try {
      const { envelope, hasSecrets } = await collectSettingsBackup(
        exportCats,
        includeSecrets,
      );
      if (hasSecrets && !pin.trim()) {
        message.error("检测到密钥，必须设置 PIN 加密后才能导出");
        return;
      }
      const text = pin.trim()
        ? await stringifyEncrypted(envelope, pin.trim())
        : stringifyEnvelope(envelope, true);

      const path = await saveDialog({
        defaultPath: `Pomegranate-settings-${dateStamp()}.kbconfig`,
        filters: [{ name: "Pomegranate 配置备份", extensions: ["kbconfig"] }],
      });
      if (!path) return;
      await systemApi.writeTextFile(path, text);
      message.success(
        `已导出配置备份${hasSecrets ? "（已加密，请牢记 PIN）" : ""}：${path}`,
        5,
      );
    } catch (e) {
      message.error(`导出失败：${e}`);
    } finally {
      setExporting(false);
    }
  }

  async function acceptParsed(env: Envelope, decrypted: boolean) {
    if (env.kind !== "bundle") {
      message.error("这不是配置备份文件（仅支持 bundle 类型）");
      return;
    }
    const data = env.data;
    const hasAny =
      !!data.uiPrefs ||
      !!data.appConfig ||
      !!data.aiModels ||
      !!data.syncBackends ||
      !!data.webdavBackends ||
      !!data.asrConfig ||
      !!data.featureToggles;
    if (!hasAny) {
      message.error("备份包为空，没有可导入的设置");
      return;
    }
    const invalid = validateBackupData(data);
    if (invalid) {
      message.error(`备份文件损坏：${invalid}`);
      return;
    }
    if (backupHasSecrets(data) && !decrypted) {
      message.error(
        "该文件包含明文密钥，已拒绝导入。请让导出方设置 PIN 后重新导出",
        6,
      );
      return;
    }
    const items = describeBackup(data);
    setPreview({ data, items });
    setImportCats(Array.from(new Set(items.map((item) => item.category))));
  }

  async function handlePickFile() {
    setParseError(null);
    const selected = await openDialog({
      multiple: false,
      filters: [
        { name: "Pomegranate 配置备份", extensions: ["kbconfig", "json"] },
      ],
    });
    if (!selected || Array.isArray(selected)) return;

    setReading(true);
    try {
      const text = await systemApi.readTextFile(selected);
      if (text.length > MAX_BACKUP_BYTES) {
        message.error("备份文件过大（上限 2MB），已拒绝读取");
        return;
      }
      const result = await parseEnvelope(text);
      if (result.ok) {
        await acceptParsed(result.envelope, false);
        return;
      }
      if ("encrypted" in result && result.encrypted) {
        setPendingText(text);
        setPinInput("");
        setParseError(null);
        setPinModalOpen(true);
        return;
      }
      message.error(`配置文件解析失败：${result.reason}`);
    } catch (e) {
      message.error(`读取备份文件失败：${e}`);
    } finally {
      setReading(false);
    }
  }

  async function handlePinSubmit() {
    if (!pendingText) return;
    if (!pinInput.trim()) {
      setParseError("请输入 PIN");
      return;
    }
    setPinChecking(true);
    setParseError(null);
    try {
      const result = await parseEnvelope(pendingText, pinInput.trim());
      if (!result.ok) {
        setParseError(
          "encrypted" in result && result.encrypted
            ? "PIN 错误或数据损坏"
            : result.reason,
        );
        return;
      }
      setPinModalOpen(false);
      setPendingText(null);
      setPinInput("");
      await acceptParsed(result.envelope, true);
    } finally {
      setPinChecking(false);
    }
  }

  async function handleApplyImport() {
    if (!preview || importCats.length === 0) return;
    setApplying(true);
    try {
      const summary = await applySettingsBackup(preview.data, importCats);
      setPreview(null);
      const content = (
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <div>已导入：{summaryText(summary)}</div>
          {summary.skipped.length > 0 && (
            <div style={{ color: "var(--ant-color-text-secondary)" }}>
              已跳过 {summary.skipped.length} 项不兼容设置：
              {summary.skipped.slice(0, 8).join("、")}
              {summary.skipped.length > 8 ? "…" : ""}
            </div>
          )}
          {summary.warnings.length > 0 && (
            <div style={{ color: "var(--ant-color-warning-text)" }}>
              {summary.warnings.join("；")}
            </div>
          )}
          {summary.errors.length > 0 && (
            <div style={{ color: "var(--ant-color-error-text)" }}>
              失败：{summary.errors.join("；")}
            </div>
          )}
          <div style={{ color: "var(--ant-color-text-secondary)" }}>
            界面偏好已立即生效；其他窗口与部分列表建议重启应用后查看。
          </div>
        </div>
      );
      if (summary.errors.length > 0) {
        Modal.warning({ title: "导入完成，但部分失败", content, width: 520 });
      } else {
        Modal.success({ title: "配置导入完成", content, width: 520 });
      }
    } catch (e) {
      message.error(`导入失败：${e}`);
    } finally {
      setApplying(false);
    }
  }

  if (isMobile) return null;

  const previewCategories = preview
    ? Array.from(new Set(preview.items.map((item) => item.category)))
    : [];

  return (
    <Card
      size="small"
      className="mt-4"
      title={
        <span className="flex items-center gap-2">
          <Download size={16} style={{ color: "var(--ant-color-primary)" }} />
          配置备份（.kbconfig）
        </span>
      }
    >
      <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
        把界面偏好、应用行为、模型服务、同步源与语音识别导出成一个文件，换机器 /
        重装后按分类恢复。不包含笔记、附件与本机路径类设置。
      </Text>

      {/* ── 导出 ── */}
      <div style={{ marginTop: 12 }}>
        <Text strong style={{ fontSize: 13 }}>
          导出
        </Text>
        <div style={{ marginTop: 8 }}>
          <Checkbox.Group
            options={CATEGORY_OPTIONS}
            value={exportCats}
            onChange={(values) =>
              setExportCats(values as BackupCategory[])
            }
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Checkbox
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
          >
            包含密钥
          </Checkbox>
          <Text type="secondary" style={{ fontSize: 12 }}>
            含 API Key / 同步密码 / Jina Key
          </Text>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input.Password
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="加密 PIN（留空 = 明文，含密钥时必填）"
            maxLength={32}
            autoComplete="off"
            style={{ maxWidth: 320 }}
          />
          {pin.trim() ? (
            <span className="flex items-center gap-1 text-[11px] text-green-600">
              <ShieldCheck size={12} /> 已加密（AES-GCM-256 + PBKDF2）
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-amber-600">
              <AlertTriangle size={12} /> 未加密
            </span>
          )}
          <Button
            type="primary"
            icon={<Download size={14} />}
            loading={exporting}
            onClick={() => void handleExport()}
          >
            导出备份
          </Button>
        </div>
      </div>

      <Divider style={{ margin: "14px 0" }} />

      {/* ── 导入 ── */}
      <div>
        <Text strong style={{ fontSize: 13 }}>
          导入
        </Text>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            icon={<Upload size={14} />}
            loading={reading}
            onClick={() => void handlePickFile()}
          >
            选择备份文件
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            加密包需输入导出方提供的 PIN；导入前会显示分类与条数预览。
          </Text>
        </div>
      </div>

      {/* ── PIN 弹窗 ── */}
      <Modal
        open={pinModalOpen}
        title={
          <span className="flex items-center gap-2">
            <Lock size={14} /> 输入备份 PIN
          </span>
        }
        onCancel={() => {
          setPinModalOpen(false);
          setPendingText(null);
          setPinInput("");
          setParseError(null);
        }}
        onOk={() => void handlePinSubmit()}
        okText="解密"
        cancelText="取消"
        confirmLoading={pinChecking}
        destroyOnClose
        width={420}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          该备份已加密，请输入导出时设置的 PIN。
        </Text>
        <Input.Password
          value={pinInput}
          onChange={(e) => setPinInput(e.target.value)}
          placeholder="PIN"
          autoComplete="off"
          autoFocus
          style={{ marginTop: 10 }}
          onPressEnter={() => void handlePinSubmit()}
        />
        {parseError && (
          <Alert
            type="error"
            showIcon
            className="!mt-3"
            message={parseError}
          />
        )}
      </Modal>

      {/* ── 导入预览 ── */}
      <Modal
        open={!!preview}
        title="确认导入配置备份"
        onCancel={() => setPreview(null)}
        onOk={() => void handleApplyImport()}
        okText="导入选中项"
        cancelText="取消"
        confirmLoading={applying}
        okButtonProps={{ disabled: importCats.length === 0 }}
        destroyOnClose
        width={620}
      >
        <Alert
          type="info"
          showIcon
          className="!mb-3"
          message="只会写入勾选的分类；未勾选的设置保持不变。"
        />
        <Table
          size="small"
          rowKey="category"
          pagination={false}
          dataSource={preview?.items ?? []}
          columns={[
            {
              title: "分类",
              dataIndex: "label",
              width: 140,
              render: (label: string, row: BackupPreviewItem) => (
                <Space size={4}>
                  <span>{label}</span>
                  {row.hasSecrets && (
                    <Tag color="red" style={{ marginInlineEnd: 0 }}>
                      含密钥
                    </Tag>
                  )}
                </Space>
              ),
            },
            {
              title: "内容",
              dataIndex: "detail",
              render: (detail: string, row: BackupPreviewItem) => (
                <div>
                  <div>{detail}</div>
                  {row.warnings.map((w) => (
                    <div
                      key={w}
                      style={{ fontSize: 11, color: "var(--ant-color-warning-text)" }}
                    >
                      {w}
                    </div>
                  ))}
                </div>
              ),
            },
            {
              title: "条数",
              dataIndex: "count",
              width: 64,
              align: "right" as const,
            },
          ]}
        />
        <div style={{ marginTop: 12 }}>
          <Text strong style={{ fontSize: 13 }}>
            导入分类
          </Text>
          <div style={{ marginTop: 8 }}>
            <Checkbox.Group
              options={previewCategories.map((category) => ({
                label: BACKUP_CATEGORY_LABELS[category],
                value: category,
              }))}
              value={importCats}
              onChange={(values) => setImportCats(values as BackupCategory[])}
            />
          </div>
        </div>
      </Modal>
    </Card>
  );
}
