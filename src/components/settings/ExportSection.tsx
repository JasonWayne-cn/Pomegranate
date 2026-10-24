import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  List,
  Modal,
  Progress,
  Select,
  Space,
  Typography,
  message,
} from "antd";
import { FolderOutput } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { exportApi, folderApi } from "@/lib/api";
import type { ExportProgress, ExportResult, Folder } from "@/types";

const { Text } = Typography;

interface Props {
  compact?: boolean;
}

function flattenFolders(
  list: Folder[],
  prefix = "",
): { value: number; label: string }[] {
  const result: { value: number; label: string }[] = [];
  for (const f of list) {
    result.push({ value: f.id, label: prefix + f.name });
    if (f.children?.length) {
      result.push(...flattenFolders(f.children, prefix + f.name + " / "));
    }
  }
  return result;
}

/**
 * 导出 Markdown：按文件夹结构导出笔记与附件。
 * 供设置页与文档模块抽屉共用。
 */
export function ExportSection({ compact }: Props) {
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportFolderId, setExportFolderId] = useState<number | undefined>(undefined);
  const [folders, setFolders] = useState<Folder[]>([]);

  useEffect(() => {
    folderApi
      .list()
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);

  async function handleExport() {
    const selected = await open({ directory: true, title: "选择导出目录" });
    if (!selected) return;

    // 导出前明确告知会包一层目录，避免用户找不到结果
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: "确认导出",
        content: (
          <div>
            <p style={{ marginBottom: 8 }}>将在以下父目录中创建一个新的导出文件夹：</p>
            <p style={{ fontFamily: "monospace", fontSize: 12, marginBottom: 8 }}>
              {selected as string}
            </p>
            <p style={{ marginBottom: 4 }}>结构如下：</p>
            <pre
              style={{
                fontSize: 12,
                background: "var(--ant-color-fill-tertiary)",
                padding: 8,
                borderRadius: 4,
                margin: 0,
              }}
            >
{`📁 Pomegranate导出_YYYYMMDD_HHmmss/
  ├─ <文件夹>/
  │   ├─ <笔记>.md
  │   └─ <笔记>.assets/   (图片+附件)
  └─ ...`}
            </pre>
          </div>
        ),
        okText: "开始导出",
        cancelText: "取消",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!confirmed) return;

    setExporting(true);
    setExportProgress(null);
    setExportResult(null);

    const unlistenProgress = await listen<ExportProgress>("export:progress", (e) => {
      setExportProgress(e.payload);
    });
    const unlistenDone = await listen<ExportResult>("export:done", (e) => {
      setExportResult(e.payload);
    });

    try {
      const result = await exportApi.exportNotes(
        selected as string,
        exportFolderId ?? null,
      );
      setExportResult(result);
      if (result.exported > 0) {
        message.success(`成功导出 ${result.exported} 篇笔记`);
        try {
          await revealItemInDir(result.root_dir);
        } catch {
          // reveal 失败不阻塞导出流程
        }
      }
    } catch (e) {
      message.error(`导出失败: ${e}`);
    } finally {
      setExporting(false);
      unlistenProgress();
      unlistenDone();
    }
  }

  return (
    <Card
      id="settings-export"
      size={compact ? "small" : "default"}
      styles={compact ? { body: { padding: 12 } } : undefined}
      title={
        <span className="flex items-center gap-2">
          <FolderOutput size={16} />
          导出 Markdown
        </span>
      }
    >
      <div className="mb-3">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
          将笔记导出为 Markdown 文件，按文件夹结构组织。便于备份或迁移到其他笔记工具。
        </Typography.Paragraph>
        <Space wrap>
          <Select
            placeholder="导出指定文件夹（可选，默认全部）"
            allowClear
            style={{ width: 240 }}
            value={exportFolderId}
            onChange={setExportFolderId}
            options={flattenFolders(folders)}
          />
          <Button
            type="primary"
            icon={<FolderOutput size={14} />}
            onClick={() => void handleExport()}
            loading={exporting}
          >
            选择导出目录
          </Button>
        </Space>
      </div>

      {exporting && exportProgress && (
        <div className="mb-3">
          <Progress
            percent={Math.round(
              (exportProgress.current / exportProgress.total) * 100,
            )}
            size="small"
            format={() => `${exportProgress.current}/${exportProgress.total}`}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            正在导出: {exportProgress.file_name}
          </Text>
        </div>
      )}

      {exportResult && (
        <Alert
          type={exportResult.errors.length > 0 ? "warning" : "success"}
          showIcon
          message={`导出完成: ${exportResult.exported} 篇笔记，附带 ${exportResult.assets_copied} 个资产文件`}
          description={
            <div className="space-y-2">
              <div
                style={{
                  fontSize: 12,
                  fontFamily: "monospace",
                  wordBreak: "break-all",
                }}
              >
                {exportResult.root_dir}
              </div>
              <Space size="small">
                <Button
                  size="small"
                  type="primary"
                  onClick={() =>
                    revealItemInDir(exportResult.root_dir).catch(() => {})
                  }
                >
                  打开所在文件夹
                </Button>
              </Space>
              {exportResult.errors.length > 0 && (
                <List
                  size="small"
                  dataSource={exportResult.errors.slice(0, 10)}
                  renderItem={(err) => (
                    <List.Item style={{ padding: "2px 0", fontSize: 12 }}>
                      <Text type="danger">{err}</Text>
                    </List.Item>
                  )}
                />
              )}
            </div>
          }
          closable
          onClose={() => setExportResult(null)}
        />
      )}
    </Card>
  );
}

export default ExportSection;
