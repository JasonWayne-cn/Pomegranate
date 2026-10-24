import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  List,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Typography,
  message,
} from "antd";
import { FolderInput } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { folderApi, importApi, pdfApi, sourceFileApi } from "@/lib/api";
import { importWordFiles } from "@/lib/wordImport";
import { useAppStore } from "@/store";
import type {
  Folder,
  ImportConflictPolicy,
  ImportProgress,
  ImportResult,
  ScannedFile,
} from "@/types";

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
 * 导入笔记：Markdown 文件夹扫描、PDF、Word。
 * 供设置页与文档模块抽屉共用。
 */
export function ImportSection({ compact }: Props) {
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [importFolderId, setImportFolderId] = useState<number | undefined>(undefined);
  const [scannedFiles, setScannedFiles] = useState<ScannedFile[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanRootPath, setScanRootPath] = useState<string | null>(null);
  const [preserveRoot, setPreserveRoot] = useState(true);
  const [conflictPolicy, setConflictPolicy] =
    useState<ImportConflictPolicy>("skip");

  useEffect(() => {
    folderApi
      .list()
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);

  const matchStats = useMemo(() => {
    let news = 0;
    let paths = 0;
    let fuzzies = 0;
    for (const f of scannedFiles) {
      if (f.match_kind === "path") paths++;
      else if (f.match_kind === "fuzzy") fuzzies++;
      else news++;
    }
    return { news, paths, fuzzies, conflicts: paths + fuzzies };
  }, [scannedFiles]);

  async function handleImportPdfs() {
    const picked = await open({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;

    const hide = message.loading(`正在导入 ${paths.length} 个 PDF...`, 0);
    try {
      const results = await pdfApi.importPdfs(paths, importFolderId ?? null);
      const ok = results.filter((r) => r.noteId !== null);
      const fail = results.filter((r) => r.noteId === null);
      hide();
      if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 PDF`);
      if (fail.length > 0) {
        Modal.warning({
          title: `${fail.length} 个 PDF 导入失败`,
          content: (
            <List
              size="small"
              dataSource={fail}
              renderItem={(r) => (
                <List.Item>
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                  </Text>
                </List.Item>
              )}
            />
          ),
        });
      }
    } catch (e) {
      hide();
      message.error(`导入失败: ${e}`);
    }
  }

  async function handleImportWord() {
    const converter = await sourceFileApi
      .getConverterStatus()
      .catch(() => "none" as const);
    const exts = converter === "none" ? ["docx"] : ["docx", "doc"];
    const picked = await open({
      multiple: true,
      filters: [{ name: "Word", extensions: exts }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;

    const hide = message.loading(`正在导入 ${paths.length} 个 Word...`, 0);
    try {
      const results = await importWordFiles(paths, importFolderId ?? null);
      const ok = results.filter((r) => r.noteId !== null);
      const fail = results.filter((r) => r.noteId === null);
      hide();
      if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 Word`);
      if (fail.length > 0) {
        Modal.warning({
          title: `${fail.length} 个 Word 导入失败`,
          content: (
            <List
              size="small"
              dataSource={fail}
              renderItem={(r) => (
                <List.Item>
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                  </Text>
                </List.Item>
              )}
            />
          ),
        });
      }
    } catch (e) {
      hide();
      message.error(`导入失败: ${e}`);
    }
  }

  async function handleScanFolder() {
    const selected = await open({ directory: true, title: "选择 Markdown 文件夹" });
    if (!selected) return;

    setScanning(true);
    setImportResult(null);
    try {
      const files = await importApi.scan(selected as string);
      if (files.length === 0) {
        message.info("该文件夹下没有 .md 文件");
        return;
      }
      setScannedFiles(files);
      setSelectedPaths(new Set(files.map((f) => f.path)));
      setScanRootPath(selected as string);
      setPreserveRoot(true);
      setScanModalOpen(true);
    } catch (e) {
      message.error(`扫描失败: ${e}`);
    } finally {
      setScanning(false);
    }
  }

  async function handleConfirmImport() {
    if (selectedPaths.size === 0) {
      message.warning("请至少选择一个文件");
      return;
    }

    setScanModalOpen(false);
    setImporting(true);
    setImportProgress(null);
    setImportResult(null);

    const unlistenProgress = await listen<ImportProgress>("import:progress", (e) => {
      setImportProgress(e.payload);
    });
    const unlistenDone = await listen<ImportResult>("import:done", (e) => {
      setImportResult(e.payload);
    });

    try {
      const result = await importApi.importSelected(
        Array.from(selectedPaths),
        importFolderId ?? null,
        scanRootPath,
        preserveRoot,
        conflictPolicy,
      );
      setImportResult(result);
      if (result.imported > 0 || result.duplicated > 0) {
        const parts: string[] = [];
        if (result.imported > 0) parts.push(`导入 ${result.imported} 篇`);
        if (result.duplicated > 0) parts.push(`副本 ${result.duplicated} 篇`);
        if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 篇`);
        message.success(parts.join("，"));
        // 导入过程会按层级新建文件夹，触发左侧笔记树与文件夹树刷新
        useAppStore.getState().bumpNotesRefresh();
        useAppStore.getState().bumpFoldersRefresh();
      }
    } catch (e) {
      message.error(`导入失败: ${e}`);
    } finally {
      setImporting(false);
      unlistenProgress();
      unlistenDone();
    }
  }

  function toggleFileSelection(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedPaths.size === scannedFiles.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(scannedFiles.map((f) => f.path)));
    }
  }

  return (
    <>
      <Card
        id="settings-import"
        size={compact ? "small" : "default"}
        styles={compact ? { body: { padding: 12 } } : undefined}
        title={
          <span className="flex items-center gap-2">
            <FolderInput size={16} />
            导入笔记
          </span>
        }
      >
        <div className="mb-3">
          <Typography.Paragraph
            type="secondary"
            style={{ marginBottom: 8, fontSize: 13 }}
          >
            支持三种导入方式：从文件夹批量扫描 .md 文件；从本地选择 PDF 或 Word 文档。
          </Typography.Paragraph>
          <Space wrap>
            <Select
              placeholder="导入到文件夹（可选）"
              allowClear
              style={{ width: 200 }}
              value={importFolderId}
              onChange={setImportFolderId}
              options={flattenFolders(folders)}
            />
            <Button
              type="primary"
              icon={<FolderInput size={14} />}
              onClick={() => void handleScanFolder()}
              loading={scanning || importing}
            >
              扫描 Markdown 文件夹
            </Button>
            <Button onClick={() => void handleImportPdfs()}>导入 PDF</Button>
            <Button onClick={() => void handleImportWord()}>导入 Word</Button>
          </Space>
        </div>

        {importing && importProgress && (
          <div className="mb-3">
            <Progress
              percent={Math.round(
                (importProgress.current / importProgress.total) * 100,
              )}
              size="small"
              format={() => `${importProgress.current}/${importProgress.total}`}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              正在导入: {importProgress.file_name}
            </Text>
          </div>
        )}

        {importResult && (
          <Alert
            type={importResult.errors.length > 0 ? "warning" : "success"}
            showIcon
            message={`导入完成: ${importResult.imported} 篇成功, ${importResult.skipped} 篇跳过`}
            description={
              importResult.errors.length > 0 ? (
                <List
                  size="small"
                  dataSource={importResult.errors.slice(0, 10)}
                  renderItem={(err) => (
                    <List.Item style={{ padding: "2px 0", fontSize: 12 }}>
                      <Text type="danger">{err}</Text>
                    </List.Item>
                  )}
                  footer={
                    importResult.errors.length > 10 ? (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        还有 {importResult.errors.length - 10} 条错误...
                      </Text>
                    ) : null
                  }
                />
              ) : undefined
            }
            closable
            onClose={() => setImportResult(null)}
          />
        )}
      </Card>

      <Modal
        title={`选择要导入的文件（共 ${scannedFiles.length} 个）`}
        open={scanModalOpen}
        onCancel={() => setScanModalOpen(false)}
        onOk={() => void handleConfirmImport()}
        okText={`导入 ${selectedPaths.size} 个文件`}
        cancelText="取消"
        width={600}
        styles={{ body: { maxHeight: 400, overflow: "auto" } }}
      >
        <div
          className="flex items-center justify-between mb-3 pb-2"
          style={{ borderBottom: "1px solid #f0f0f0" }}
        >
          <Checkbox
            checked={selectedPaths.size === scannedFiles.length && scannedFiles.length > 0}
            indeterminate={
              selectedPaths.size > 0 && selectedPaths.size < scannedFiles.length
            }
            onChange={toggleSelectAll}
          >
            全选 / 取消全选
          </Checkbox>
          <Text type="secondary" style={{ fontSize: 12 }}>
            已选 {selectedPaths.size} / {scannedFiles.length}
          </Text>
        </div>

        <div className="mb-3 pb-2" style={{ borderBottom: "1px solid #f0f0f0" }}>
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2"
            style={{ fontSize: 12 }}
          >
            <span>🆕 全新 <strong>{matchStats.news}</strong></span>
            <span title="路径已匹配到已有笔记（上次导入过）">
              🔁 已导入过 <strong>{matchStats.paths}</strong>
            </span>
            <span title="路径不同但标题+内容与已有笔记一致，可能是用户搬动过文件">
              ⚠️ 可能重复 <strong>{matchStats.fuzzies}</strong>
            </span>
          </div>
          {matchStats.conflicts > 0 && (
            <div>
              <Text style={{ fontSize: 12 }}>遇到已存在的文件：</Text>
              <Radio.Group
                value={conflictPolicy}
                onChange={(e) =>
                  setConflictPolicy(e.target.value as ImportConflictPolicy)
                }
                size="small"
                style={{ marginLeft: 8 }}
              >
                <Radio value="skip">跳过（推荐）</Radio>
                <Radio value="duplicate">创建副本</Radio>
              </Radio.Group>
            </div>
          )}
        </div>

        <div className="mb-3 pb-2" style={{ borderBottom: "1px solid #f0f0f0" }}>
          <Checkbox
            checked={preserveRoot}
            onChange={(e) => setPreserveRoot(e.target.checked)}
          >
            <span style={{ fontSize: 13 }}>保留源文件夹作为根</span>
          </Checkbox>
          <div className="mt-1" style={{ paddingLeft: 24 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              导入时按源目录层级自动创建子文件夹，同名文件夹复用已有记录。
              {preserveRoot
                ? "将在目标下创建与源目录同名的根文件夹。"
                : "子目录直接挂到目标位置。"}
            </Text>
          </div>
        </div>

        <List
          size="small"
          dataSource={scannedFiles}
          renderItem={(file) => (
            <List.Item style={{ padding: "6px 0" }}>
              <Checkbox
                checked={selectedPaths.has(file.path)}
                onChange={() => toggleFileSelection(file.path)}
                style={{ marginRight: 8 }}
              />
              <div className="flex-1 min-w-0">
                <Text ellipsis style={{ fontSize: 13 }}>
                  {file.name}.md
                </Text>
                {file.relative_dir && (
                  <div>
                    <Text
                      type="secondary"
                      ellipsis
                      style={{ fontSize: 11, display: "block" }}
                    >
                      {file.relative_dir}
                    </Text>
                  </div>
                )}
              </div>
              <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                {file.size < 1024
                  ? `${file.size} B`
                  : file.size < 1048576
                    ? `${(file.size / 1024).toFixed(1)} KB`
                    : `${(file.size / 1048576).toFixed(1)} MB`}
              </Text>
            </List.Item>
          )}
        />
      </Modal>
    </>
  );
}

export default ImportSection;
