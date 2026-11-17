/**
 * Office 文档引擎 Spike（P0）：验证多格式打开与预览。
 *
 * - PPTX：WebView 内 GenOffice pptx-engine → RenderTree → SVG
 * - DOCX：WebView 内 GenOffice docx-engine → HTML 预览
 * - XLSX：Rust calamine → 表头 + 前 N 行
 * - PDF：Rust pdfium → 前 N 页 PNG
 *
 * 这是开发验证页，不进入正式导航。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  List,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { FileUp, Redo2, Save, Undo2 } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  pptxSpikeApi,
  type PdfPagePreview,
  type XlsxSheetPreview,
} from "@/lib/api/pptxSpike";
import {
  PptxWorkerClient,
  type DocxTextBlock,
  type OfficeOpenedData,
} from "@/lib/office/pptxWorkerClient";
import { EditorCanvas } from "@/lib/office/editor/EditorCanvas";
import { usePptxEditor } from "@/lib/office/editor/usePptxEditor";
import { editLogApi, type EditOp } from "@/lib/api/editLog";
import { fontMetricsApi, type FontMetrics } from "@/lib/api/fontMetrics";

const { Title, Paragraph, Text } = Typography;

type Format = "pptx" | "docx" | "xlsx" | "pdf";

const DEFAULT_FONT_FAMILIES = [
  "Calibri",
  "Arial",
  "Times New Roman",
  "Cambria",
  "Segoe UI",
  "Aptos",
  "Microsoft YaHei",
  "SimSun",
  "SimHei",
  "KaiTi",
];

const FORMAT_LABEL: Record<Format, string> = {
  pptx: "PowerPoint",
  docx: "Word",
  xlsx: "Excel",
  pdf: "PDF",
};

function readHeapMB(): number | null {
  const memory = (
    performance as Performance & { memory?: { usedJSHeapSize: number } }
  ).memory;
  return memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatOf(name: string): Format | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pptx" || ext === "pptm") return "pptx";
  if (ext === "docx" || ext === "docm") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "pdf") return "pdf";
  return null;
}

export default function OfficeSpikePage() {
  const [path, setPath] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [format, setFormat] = useState<Format | null>(null);
  const [opened, setOpened] = useState<OfficeOpenedData | null>(null);
  const [xlsx, setXlsx] = useState<XlsxSheetPreview[] | null>(null);
  const [pdf, setPdf] = useState<PdfPagePreview[] | null>(null);
  const [sourceSize, setSourceSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [heapMB, setHeapMB] = useState<number | null>(null);
  const [fontMetricMatched, setFontMetricMatched] = useState<number | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const [docxTextItems, setDocxTextItems] = useState<DocxTextBlock[]>([]);
  const [selectedDocxBlock, setSelectedDocxBlock] = useState<number | null>(null);
  const [docxDraft, setDocxDraft] = useState("");
  const [xlsxSheet, setXlsxSheet] = useState<string | null>(null);
  const [xlsxCell, setXlsxCell] = useState("");
  const [xlsxValue, setXlsxValue] = useState("");
  const [applyingXlsx, setApplyingXlsx] = useState(false);
  const [applyingEdit, setApplyingEdit] = useState(false);
  const [editHistory, setEditHistory] = useState<EditOp[]>([]);
  const workerRef = useRef<PptxWorkerClient | null>(null);
  const originalBytesRef = useRef<ArrayBuffer | null>(null);
  const fontMetricsRef = useRef<Record<string, FontMetrics> | null>(null);

  const onThumbnail = useCallback((slide: number, svg: string) => {
    setOpened((prev) =>
      prev && prev.kind === "pptx"
        ? {
            ...prev,
            slides: prev.slides.map((entry) =>
              entry.index === slide ? { ...entry, svg } : entry,
            ),
          }
        : prev,
    );
    setActiveSlide(slide);
  }, []);

  const onEditorError = useCallback((cause: unknown) => {
    message.error(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const editor = usePptxEditor({
    clientRef: workerRef,
    onThumbnail,
    onError: onEditorError,
  });

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  function reset() {
    setOpened(null);
    setXlsx(null);
    setPdf(null);
    setError(null);
    setElapsedMs(null);
    setActiveSlide(0);
    editor.reset();
    setDocxTextItems([]);
    setSelectedDocxBlock(null);
    setDocxDraft("");
    setXlsxSheet(null);
    setXlsxCell("");
    setXlsxValue("");
    setEditHistory([]);
    originalBytesRef.current = null;
  }

  async function loadHistory(target: string) {
    try {
      setEditHistory(await editLogApi.list(target, 50));
    } catch {
      setEditHistory([]);
    }
  }

  async function handleOpen() {
    const selected = await openDialog({
      multiple: false,
      filters: [
        {
          name: "Office / PDF",
          extensions: ["pptx", "pptm", "docx", "docm", "xlsx", "xlsm", "pdf"],
        },
      ],
    });
    if (typeof selected !== "string") return;

    const kind = formatOf(selected);
    if (!kind) {
      message.error("不支持的文件类型");
      return;
    }

    setLoading(true);
    reset();
    setFormat(kind);
    try {
      const name = await pptxSpikeApi.displayName(selected);
      const size = await pptxSpikeApi.fileSize(selected);
      setPath(selected);
      setSourceName(name);
      setSourceSize(size);

      if (kind === "pptx" || kind === "docx") {
        workerRef.current?.terminate();
        workerRef.current = new PptxWorkerClient();
        const started = performance.now();
        const bytes = await pptxSpikeApi.read(selected);
        originalBytesRef.current = bytes.slice(0);
        let fontMetrics: Record<string, FontMetrics> | undefined;
        if (kind === "docx") {
          if (!fontMetricsRef.current) {
            try {
              const measured = await fontMetricsApi.measure(DEFAULT_FONT_FAMILIES);
              fontMetricsRef.current = Object.fromEntries(
                measured.map((metrics) => [metrics.family.toLowerCase(), metrics]),
              );
              setFontMetricMatched(measured.filter((metrics) => metrics.matched_family).length);
            } catch {
              fontMetricsRef.current = {};
            }
          }
          fontMetrics = fontMetricsRef.current ?? undefined;
        }
        const result = await workerRef.current.open(
          kind,
          bytes,
          kind === "pptx" ? 960 : 820,
          { fontMetrics },
        );
        setOpened(result);
        setElapsedMs(performance.now() - started);
        void loadHistory(selected);
        if (kind === "pptx") {
          setActiveSlide(0);
          void editor.openSlide(0);
        } else if (result.kind === "docx") {
          setDocxTextItems(result.textBlocks);
        }
        message.success("解析完成");
      } else if (kind === "xlsx") {
        const started = performance.now();
        const sheets = await pptxSpikeApi.xlsxPreview(selected);
        setXlsx(sheets);
        setXlsxSheet(sheets[0]?.name ?? null);
        setElapsedMs(performance.now() - started);
        void loadHistory(selected);
        message.success(`已读取 ${sheets.length} 个工作表`);
      } else {
        const started = performance.now();
        const pages = await pptxSpikeApi.pdfPreview(selected, 3);
        setPdf(pages);
        setElapsedMs(performance.now() - started);
        message.success(`已渲染 ${pages.length} 页`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHeapMB(readHeapMB());
      setLoading(false);
    }
  }

  async function handleSaveAs() {
    if (!opened || !format || (format !== "pptx" && format !== "docx")) return;
    const ext = format === "pptx" ? "pptx" : "docx";
    const target = await saveDialog({
      defaultPath: `${sourceName.replace(/\.[^.]+$/, "")}-saved.${ext}`,
      filters: [{ name: FORMAT_LABEL[format], extensions: [ext] }],
    });
    if (!target) return;
    setSaving(true);
    try {
      let bytes: Uint8Array;
      if (format === "pptx") {
        if (!workerRef.current) throw new Error("Worker 未就绪");
        bytes = await workerRef.current.save();
      } else if (opened.kind === "docx") {
        bytes = opened.saved;
      } else {
        return;
      }
      await pptxSpikeApi.write(target, bytes);
      message.success("已保存");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function recordPptxEdit(summary: Record<string, unknown>) {
    if (!path) return;
    try {
      await editLogApi.record({
        domain: "pptx",
        target: path,
        source: "user",
        opJson: JSON.stringify(summary),
      });
      void loadHistory(path);
    } catch {
      /* 审计失败不影响编辑 */
    }
  }

  async function handleRevertPptx() {
    if (!originalBytesRef.current || !workerRef.current) return;
    setLoading(true);
    try {
      const result = await workerRef.current.open(
        "pptx",
        originalBytesRef.current.slice(0),
        960,
      );
      setOpened(result);
      editor.reset();
      setActiveSlide(0);
      void editor.openSlide(0);
      message.success("已恢复到打开时的版本");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleApplyDocxText() {
    if (!opened || opened.kind !== "docx" || selectedDocxBlock == null) return;
    const item = docxTextItems.find((entry) => entry.blockIndex === selectedDocxBlock);
    if (!item) return;
    setApplyingEdit(true);
    try {
      const result = await workerRef.current!.updateDocxText(selectedDocxBlock, docxDraft);
      if (path) {
        await editLogApi.record({
          domain: "docx",
          target: path,
          source: "user",
          opJson: JSON.stringify({
            kind: "setText",
            blockIndex: selectedDocxBlock,
            before: item.text,
            after: docxDraft,
          }),
        });
      }
      setOpened(result);
      setDocxTextItems(result.textBlocks);
      setSelectedDocxBlock(null);
      setDocxDraft("");
      if (path) void loadHistory(path);
      message.success("已应用 DOCX 修改");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyingEdit(false);
    }
  }

  function xlsxCellBeforeValue(sheetName: string, cell: string): string {
    const sheet = xlsx?.find((entry) => entry.name === sheetName);
    const match = /^([A-Za-z]+)(\d+)$/.exec(cell.trim());
    if (!sheet || !match) return "";
    let col = 0;
    for (const ch of match[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    col -= 1;
    const row = Number(match[2]);
    if (row === 1) return sheet.headers[col] ?? "";
    return sheet.rows[row - 2]?.[col] ?? "";
  }

  async function handleApplyXlsxCell() {
    if (!path || !xlsxSheet || !xlsxCell.trim()) return;
    setApplyingXlsx(true);
    try {
      const before = xlsxCellBeforeValue(xlsxSheet, xlsxCell);
      const next = await pptxSpikeApi.xlsxSetCell(path, xlsxSheet, xlsxCell.trim(), xlsxValue);
      setXlsx(next);
      await editLogApi.record({
        domain: "xlsx",
        target: path,
        source: "user",
        opJson: JSON.stringify({
          kind: "setCell",
          sheet: xlsxSheet,
          cell: xlsxCell.trim().toUpperCase(),
          before,
          after: xlsxValue,
        }),
      });
      void loadHistory(path);
      setXlsxCell("");
      setXlsxValue("");
      message.success("单元格已更新");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyingXlsx(false);
    }
  }

  async function handleClearHistory() {
    if (!path) return;
    try {
      await editLogApi.clear(path);
      setEditHistory([]);
      message.success("已清空编辑历史");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  }

  const sheetItems = (xlsx ?? []).map((sheet, index) => ({
    key: String(index),
    label: `${sheet.name} (${sheet.total_rows})`,
    children: (
      <div>
        {sheet.truncated_rows > 0 && (
          <Alert
            type="info"
            showIcon
            className="mb-3"
            message={`预览已截断：仅显示前 ${sheet.rows.length} 行（共 ${sheet.total_rows} 行）`}
          />
        )}
        <Table
          size="small"
          bordered
          pagination={false}
          scroll={{ x: "max-content", y: 420 }}
          dataSource={sheet.rows.map((row, rowIndex) => ({
            key: rowIndex,
            cells: row,
          }))}
          columns={[
            { title: "#", dataIndex: "key", width: 52, render: (v: number) => v + 1 },
            ...sheet.headers.map((header, colIndex) => ({
              title: header || `列 ${colIndex + 1}`,
              width: 160,
              render: (_: unknown, row: { cells: string[] }) => row.cells[colIndex] ?? "",
            })),
          ]}
        />
      </div>
    ),
  }));

  return (
    <div className="max-w-6xl mx-auto p-6">
      <Title level={3}>Office 文档引擎 Spike</Title>
      <Paragraph type="secondary">
        PPTX 使用画布编辑器（选中 / 拖动 / 缩放 / 双击编辑文本 / 撤销重做），DOCX、XLSX、PDF
        保持预览与最小编辑。所有解析均在本机完成。
      </Paragraph>

      <Alert
        type="warning"
        showIcon
        className="mb-4"
        message="P0 验证页"
        description="DOCX 预览为内容级（段落/标题/列表/图片/表格），不含分页与复杂浮动排版；请勿在正式业务流程中依赖。"
      />

      <Space wrap className="mb-4">
        <Button type="primary" icon={<FileUp size={16} />} loading={loading} onClick={handleOpen}>
          打开文档
        </Button>
        <Button
          icon={<Save size={16} />}
          disabled={!opened || (format !== "pptx" && format !== "docx")}
          loading={saving}
          onClick={handleSaveAs}
        >
          另存为
        </Button>
        {opened?.kind === "pptx" && (
          <>
            <Button
              icon={<Undo2 size={16} />}
              disabled={!editor.canUndo || editor.busy}
              onClick={() => void editor.undo()}
            >
              撤销
            </Button>
            <Button
              icon={<Redo2 size={16} />}
              disabled={!editor.canRedo || editor.busy}
              onClick={() => void editor.redo()}
            >
              重做
            </Button>
            <Button disabled={editor.busy} onClick={() => void handleRevertPptx()}>
              恢复打开时版本
            </Button>
          </>
        )}
        {format && <Tag color="blue">{FORMAT_LABEL[format]}</Tag>}
        {path && <Text type="secondary">{sourceName}</Text>}
        {sourceSize > 0 && <Tag>原始 {formatBytes(sourceSize)}</Tag>}
        {elapsedMs != null && <Tag>解析 {Math.round(elapsedMs)} ms</Tag>}
        {heapMB != null && <Tag>JS 堆 {heapMB} MB</Tag>}
        {format === "docx" && fontMetricMatched != null && (
          <Tag color={fontMetricMatched > 0 ? "blue" : "default"}>
            字体度量 {fontMetricMatched}/{DEFAULT_FONT_FAMILIES.length}
          </Tag>
        )}
        {opened?.kind === "docx" && (
          <Tag color="green">保存后 {formatBytes(opened.saved.byteLength)}</Tag>
        )}
        {opened?.kind === "pptx" && (
          <Tag>SHA-256 {opened.info.hash.slice(0, 12)}…</Tag>
        )}
        {opened?.kind === "docx" && (
          <Tag>
            {opened.info.pageCount} 页 · {opened.info.blockCount} 块 ·{" "}
            {opened.info.headingCount} 标题 · {opened.info.tableCount} 表格 ·{" "}
            {opened.info.imageCount} 图片
          </Tag>
        )}
        {xlsx && <Tag>{xlsx.length} 个工作表</Tag>}
        {pdf && <Tag>{pdf.length} 页</Tag>}
      </Space>

      {sourceSize > 80 * 1024 * 1024 && (
        <Alert
          type="warning"
          showIcon
          className="mb-4"
          message="文件较大"
          description="超过 80 MB 的文档在 WebView 内解析可能占用较多内存。建议先关闭其他标签页，并在 Win7 低配机器上谨慎使用。"
        />
      )}

      {error && (
        <Alert type="error" showIcon className="mb-4" message="解析失败" description={error} />
      )}

      {loading && (
        <div className="flex items-center justify-center py-24">
          <Spin tip="正在解析文档…" />
        </div>
      )}

      {!loading && !opened && !xlsx && !pdf && (
        <Empty description="选择一个 Office 文档或 PDF 开始验证" />
      )}

      {opened?.kind === "pptx" && (
        <Card size="small" className="mb-4" styles={{ body: { padding: 12 } }}>
          <div className="flex gap-4">
            <div className="w-40 shrink-0 max-h-[70vh] overflow-y-auto space-y-2 pr-1">
              {opened.slides.map((slide) => (
                <button
                  key={slide.index}
                  type="button"
                  onClick={() => void editor.openSlide(slide.index)}
                  className={`block w-full rounded border-2 p-0 text-left ${
                    activeSlide === slide.index
                      ? "border-blue-500"
                      : "border-transparent hover:border-gray-300"
                  }`}
                >
                  <div
                    className="bg-white"
                    style={{ aspectRatio: `${slide.widthPx} / ${slide.heightPx}` }}
                    dangerouslySetInnerHTML={{ __html: slide.svg }}
                  />
                  <div className="px-1 py-0.5 text-xs text-gray-500">
                    第 {slide.index + 1} 页
                  </div>
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1">
              {editor.scene ? (
                <EditorCanvas
                  scene={editor.scene.scene}
                  svg={editor.scene.svg}
                  selectedId={editor.selectedId}
                  busy={editor.busy}
                  onSelect={editor.select}
                  onCommitTransform={(node, box) => {
                    void editor.commitTransform(node, box);
                    void recordPptxEdit({
                      kind: "setTransform",
                      elementId: node.id,
                      box,
                    });
                  }}
                  onCommitText={(node, text) => {
                    void editor.commitText(node, text);
                    void recordPptxEdit({
                      kind: "setText",
                      elementId: node.id,
                      before: node.text,
                      after: text,
                    });
                  }}
                />
              ) : (
                <div className="flex h-64 items-center justify-center">
                  <Spin tip="正在准备画布…" />
                </div>
              )}
              <div className="mt-2 text-xs text-gray-500">
                单击选中 · 拖动移动 · 拖动控制点缩放 · 双击文本编辑（Ctrl+Enter
                提交，Esc 取消） · 撤销/重做在顶部工具栏
                {editor.busy ? " · 正在应用…" : ""}
              </div>
            </div>
          </div>
        </Card>
      )}

      {editHistory.length > 0 && (
        <Card
          size="small"
          title={`编辑历史（${editHistory.length}）`}
          className="mb-4"
          extra={
            <Button size="small" onClick={() => void handleClearHistory()}>
              清空
            </Button>
          }
        >
          <List
            size="small"
            dataSource={editHistory}
            renderItem={(op) => {
              let summary = op.op_json;
              try {
                const parsed = JSON.parse(op.op_json) as {
                  kind?: string;
                  before?: string;
                  after?: string;
                };
                summary =
                  parsed.kind === "setText"
                    ? `修改文本：${parsed.before ?? ""} → ${parsed.after ?? ""}`
                    : parsed.kind ?? op.op_json;
              } catch {
                /* 保留原始 JSON */
              }
              return (
                <List.Item>
                  <Space direction="vertical" size={0} className="w-full">
                    <Text ellipsis>{summary}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {op.created_at} · {op.source}
                    </Text>
                  </Space>
                </List.Item>
              );
            }}
          />
        </Card>
      )}

      {opened?.kind === "docx" && docxTextItems.length > 0 && (
        <Card size="small" title="文本编辑（DOCX）" className="mb-4">
          <Space direction="vertical" className="w-full" size="middle">
            <Select
              className="w-full"
              placeholder="选择一个段落 / 标题 / 列表"
              value={selectedDocxBlock}
              onChange={(value) => {
                setSelectedDocxBlock(value);
                const item = docxTextItems.find((entry) => entry.blockIndex === value);
                setDocxDraft(item?.text ?? "");
              }}
              options={docxTextItems.map((item) => ({
                value: item.blockIndex,
                label: item.preview,
              }))}
              showSearch
              optionFilterProp="label"
            />
            <Input.TextArea
              value={docxDraft}
              onChange={(event) => setDocxDraft(event.target.value)}
              autoSize={{ minRows: 2, maxRows: 6 }}
              disabled={selectedDocxBlock == null || applyingEdit}
              placeholder="修改文本后点击应用"
            />
            <Button
              type="primary"
              disabled={selectedDocxBlock == null || applyingEdit}
              loading={applyingEdit}
              onClick={() => void handleApplyDocxText()}
            >
              应用修改
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              保留原段落的样式、编号与标题级别，仅替换文字；保存后可在 Word 中继续编辑。
            </Text>
          </Space>
        </Card>
      )}

      {opened?.kind === "docx" && (
        <>
          <Alert
            type="info"
            showIcon
            className="mb-3"
            message="分页为近似结果"
            description="优先遵循显式分页符；其余按内容高度估算分页，与 Word 的精确排版可能有差异。"
          />
          {opened.info.truncated && (
            <Alert
              type="info"
              showIcon
              className="mb-3"
              message="文档较大，预览仅显示前 2000 个内容块"
            />
          )}
          <div className="rounded-lg bg-gray-100 p-4 max-h-[70vh] overflow-auto">
            <div dangerouslySetInnerHTML={{ __html: opened.html }} />
          </div>
        </>
      )}

      {xlsx && (
        <Card size="small" styles={{ body: { padding: 12 } }}>
          <Space wrap className="mb-3">
            <Select
              style={{ width: 180 }}
              placeholder="工作表"
              value={xlsxSheet}
              onChange={setXlsxSheet}
              options={xlsx.map((sheet) => ({ value: sheet.name, label: sheet.name }))}
            />
            <Input
              style={{ width: 100 }}
              placeholder="单元格 A1"
              value={xlsxCell}
              onChange={(event) => setXlsxCell(event.target.value)}
            />
            <Input
              style={{ width: 240 }}
              placeholder="新值"
              value={xlsxValue}
              onChange={(event) => setXlsxValue(event.target.value)}
            />
            <Button
              type="primary"
              loading={applyingXlsx}
              disabled={!xlsxSheet || !xlsxCell.trim()}
              onClick={() => void handleApplyXlsxCell()}
            >
              更新单元格
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              保存回原 xlsx（umya-spreadsheet）
            </Text>
          </Space>
          <Tabs items={sheetItems} />
        </Card>
      )}

      {pdf && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {pdf.map((page) => (
            <Card key={page.page} size="small" title={`第 ${page.page} 页`}>
              <img
                src={`data:image/png;base64,${page.png_base64}`}
                alt={`第 ${page.page} 页`}
                className="w-full rounded border"
              />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
