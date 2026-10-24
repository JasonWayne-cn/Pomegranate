import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Input,
  Space,
  Typography,
  message,
} from "antd";
import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { configApi } from "@/lib/api";

const { Text } = Typography;

/** 日记 Markdown 输出目录的 app_config 键 */
const DAILY_NOTE_MD_STORAGE_PATH_KEY = "daily_note.md_storage_path";

/** 保存后广播，使设置页与 module 抽屉中的多个实例保持一致 */
const DAILY_STORAGE_CHANGED_EVENT = "daily-storage-path-changed";

interface Props {
  compact?: boolean;
}

/**
 * 日记 Markdown 存储路径。
 *
 * 仅保存一个输出目录配置，不改变当前笔记正文写入数据库的实现。
 * 供设置页与日记模块抽屉共用。
 */
export function DailyStorageSection({ compact }: Props) {
  const [savedPath, setSavedPath] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;

    const reload = () => {
      configApi
        .get(DAILY_NOTE_MD_STORAGE_PATH_KEY)
        .then((value) => {
          if (!alive) return;
          setSavedPath(value);
          setDraft(value);
        })
        .catch(() => {
          // 未配置是正常状态
        });
    };

    reload();
    window.addEventListener(DAILY_STORAGE_CHANGED_EVENT, reload);
    return () => {
      alive = false;
      window.removeEventListener(DAILY_STORAGE_CHANGED_EVENT, reload);
    };
  }, []);

  async function save(path: string) {
    const value = path.trim();
    setSaving(true);
    try {
      await configApi.set(DAILY_NOTE_MD_STORAGE_PATH_KEY, value);
      setSavedPath(value);
      setDraft(value);
      window.dispatchEvent(new Event(DAILY_STORAGE_CHANGED_EVENT));
      message.success(value ? "日记文件存储路径已保存" : "日记文件存储路径已清空");
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function pickDirectory() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择日记 Markdown 文件保存目录",
      defaultPath: draft || savedPath || undefined,
    });
    if (typeof selected !== "string") return;
    await save(selected);
  }

  return (
    <Card
      id="settings-daily-md-path"
      size={compact ? "small" : "default"}
      styles={compact ? { body: { padding: 12 } } : undefined}
      title={
        <span className="flex items-center gap-2">
          <FolderOpen size={16} />
          日记文件存储路径
        </span>
      }
    >
      <Alert
        type="info"
        showIcon
        className="mb-3"
        message="当前笔记仍按现有数据库方式保存"
        description="这里仅保存一个用于日记 Markdown 文件输出的目录配置，不会改变当前笔记正文写入数据库的实现。"
      />
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
        后续生成或同步日记 .md 文件时，可读取此路径作为保存目录。
      </Typography.Paragraph>
      <Space.Compact style={{ width: "100%" }}>
        <Input
          allowClear
          value={draft}
          placeholder="请选择或输入日记 Markdown 文件保存目录"
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button icon={<FolderOpen size={14} />} onClick={() => void pickDirectory()}>
          选择目录
        </Button>
        <Button
          type="primary"
          loading={saving}
          disabled={draft.trim() === savedPath}
          onClick={() => void save(draft)}
        >
          保存
        </Button>
      </Space.Compact>
      {savedPath && (
        <div className="mt-2">
          <Text type="secondary" style={{ fontSize: 12 }}>
            当前已保存：
          </Text>
          <Text code copyable style={{ fontSize: 12, wordBreak: "break-all" }}>
            {savedPath}
          </Text>
        </div>
      )}
    </Card>
  );
}

export default DailyStorageSection;
