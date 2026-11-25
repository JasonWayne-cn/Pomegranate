/**
 * GenOffice DOCX 引擎适配层（P0 Spike）。
 *
 * 解析 `.docx` 为 Block 树，渲染成简化的 HTML 预览；无编辑保存走
 * saveDocx 的"全部 original"路径，用于验证字节保真。
 *
 * 预览是"内容级"的：段落/标题/列表/图片/表格，不含分页、页眉页脚、
 * 浮动对象等复杂排版。
 */
import {
  parseDocx,
  saveDocx,
  computeListMarkerInfos,
  type Block,
  type NumberingDef,
  type NumberingLevel,
  type Run,
  type SaveBlock,
} from "@genoffice/docx-engine";

export interface DocxInfo {
  blockCount: number;
  headingCount: number;
  tableCount: number;
  imageCount: number;
  /** 按显式分页符拆出的页数（不做内容级自动分页） */
  pageCount: number;
  /** 预览是否因过大被截断 */
  truncated: boolean;
}

export interface DocxTextBlock {
  /** 在 parsed.blocks 中的稳定索引 */
  blockIndex: number;
  type: string;
  text: string;
  preview: string;
}

type ParsedDocx = Awaited<ReturnType<typeof parseDocx>>;

export interface DocxOpened {
  info: DocxInfo;
  html: string;
  saved: Uint8Array;
  parsed: ParsedDocx;
  textBlocks: DocxTextBlock[];
}

const MAX_PREVIEW_BLOCKS = 2000;
const MAX_PARAS_PER_CELL = 6;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** twips → CSS px（96dpi）。 */
function twipsToPx(twips: number | undefined): number | undefined {
  if (twips == null || !Number.isFinite(twips)) return undefined;
  return Math.round(twips / 15);
}

function runHtml(run: Run): string {
  if (!run.text) return "";
  const styles: string[] = [];
  if (run.bold) styles.push("font-weight:700");
  if (run.italic) styles.push("font-style:italic");
  const decoration: string[] = [];
  if (run.underline) decoration.push("underline");
  if (run.strike) decoration.push("line-through");
  if (decoration.length) styles.push(`text-decoration:${decoration.join(" ")}`);
  if (run.color && run.color !== "auto") styles.push(`color:#${run.color}`);
  if (run.sizeHalfPoints) styles.push(`font-size:${run.sizeHalfPoints / 2}pt`);
  if (run.font) styles.push(`font-family:${run.font.replace(/["']/g, "")}`);
  const text = escapeHtml(run.text).replace(/\n/g, "<br/>");
  return styles.length ? `<span style="${styles.join(";")}">${text}</span>` : text;
}

function runsHtml(runs: Run[] | undefined): string {
  return (runs ?? []).map(runHtml).join("");
}

function paragraphStyle(block: Block): string {
  const format = block.format;
  const styles: string[] = ["margin:0 0 8px 0"];
  if (format?.align === "center") styles.push("text-align:center");
  else if (format?.align === "right") styles.push("text-align:right");
  else if (format?.align === "justify") styles.push("text-align:justify");
  const indentLeft = twipsToPx(format?.indentLeft);
  const indentRight = twipsToPx(format?.indentRight);
  const indentFirst = twipsToPx(format?.indentFirstLine);
  if (indentLeft) styles.push(`margin-left:${indentLeft}px`);
  if (indentRight) styles.push(`margin-right:${indentRight}px`);
  if (indentFirst) styles.push(`text-indent:${indentFirst}px`);
  return styles.join(";");
}

function blockAttr(index: number | undefined): string {
  return index == null ? "" : ` data-block-index="${index}"`;
}

interface ListRenderInfo {
  marker: string;
  level?: NumberingLevel;
}

interface RenderContext {
  list: Map<Block, ListRenderInfo>;
}

/**
 * 按 numbering.xml 计算每个列表项的显示编号（支持 decimal / chineseCounting /
 * lowerRoman / bullet 等真实格式），而不是一律用「1.」。
 *
 * 编号定义缺失时退回简单的按 numId+ilvl 自增，保证仍有可读的序号。
 */
function buildListMarkers(
  blocks: Block[],
  numbering: Map<string, NumberingDef> | undefined,
): Map<Block, ListRenderInfo> {
  const listBlocks = blocks.filter((block) => block.type === "listItem");
  const defs = numbering ?? new Map<string, NumberingDef>();
  const infos = computeListMarkerInfos(
    listBlocks.map((block) => ({
      numId: block.list?.numId ?? null,
      ilvl: block.list?.ilvl ?? 0,
    })),
    defs,
  );
  const fallbackCounters = new Map<string, number>();
  const map = new Map<Block, ListRenderInfo>();

  listBlocks.forEach((block, index) => {
    const info = infos[index];
    let marker = info?.text;
    if (marker == null) {
      const ordered = block.list?.kind === "ordered";
      if (ordered) {
        const key = `${block.list?.numId ?? ""}:${block.list?.ilvl ?? 0}`;
        const next = (fallbackCounters.get(key) ?? 0) + 1;
        fallbackCounters.set(key, next);
        marker = `${next}.`;
      } else {
        marker = "•";
      }
    }
    const level = block.list
      ? defs.get(block.list.numId)?.levels[block.list.ilvl]
      : undefined;
    map.set(block, { marker, level });
  });

  return map;
}

function renderBlock(block: Block, blockIndex: number | undefined, ctx: RenderContext): string {
  // 书签是零宽标记，不是内容：不渲染占位框。
  if (block.type === "passthrough" && /bookmark/i.test(block.label ?? "")) return "";
  if (block.type === "heading") {
    const level = Math.min(6, Math.max(1, block.level ?? 1));
    // 保留段落对齐 / 缩进（如居中的文档标题），否则标题会被一律左对齐。
    return `<h${level}${blockAttr(blockIndex)} style="${paragraphStyle(block)};margin-top:18px;font-size:${Math.max(16, 28 - level * 2)}px;color:#111827">${runsHtml(block.runs)}</h${level}>`;
  }
  if (block.type === "listItem") {
    const list = block.list;
    const info = ctx.list.get(block);
    const marker = info?.marker ?? (list?.kind === "ordered" ? "1." : "•");
    const level = info?.level;
    const directIndent = twipsToPx(block.format?.indentLeft);
    const levelIndent = twipsToPx(level?.indentLeft);
    const hanging = twipsToPx(level?.hanging) ?? 0;
    // 直接段落缩进已由 paragraphStyle 写成 margin-left，不要再叠加 padding。
    const indent =
      directIndent != null
        ? 0
        : Math.max(0, (levelIndent ?? 20 + (list?.ilvl ?? 0) * 20) - hanging);
    // w:suff=nothing 表示编号后不补空白（中文「一、」常见），否则留出间隔。
    const gap = level?.suff === "nothing" ? 0 : 6;
    const markerWidth = hanging > 0 ? `min-width:${hanging}px;` : "";
    const markerAlign = level?.lvlJc ?? "left";
    return `<div${blockAttr(blockIndex)} style="${paragraphStyle(block)};display:flex;padding-left:${indent}px"><span style="flex:none;${markerWidth}text-align:${markerAlign};padding-right:${gap}px;white-space:pre">${escapeHtml(marker)}</span><span style="flex:1">${runsHtml(block.runs)}</span></div>`;
  }
  if (block.type === "table") {
    const table = block.table;
    if (!table) return renderPlaceholder(block);
    const width = table.colWidthsPct?.map((pct) => `${pct}%`).join(",");
    const rows = table.rows
      .map(
        (row) =>
          `<tr>${row
            .map((cell) => {
              const text = (cell.richParas?.map((p) => runsHtml(p.runs)) ?? cell.paras
                .slice(0, MAX_PARAS_PER_CELL)
                .map(escapeHtml))
                .join("<br/>");
              const span = cell.colSpan && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : "";
              return `<td${span} style="border:1px solid #d1d5db;padding:4px 6px;vertical-align:top">${text}</td>`;
            })
            .join("")}</tr>`,
      )
      .join("");
    return `<table style="border-collapse:collapse;width:100%;margin:10px 0;table-layout:fixed;font-size:13px">${
      width ? `<colgroup>${table.colWidthsPct!.map((pct) => `<col style="width:${pct}%"/>`).join("")}</colgroup>` : ""
    }${rows}</table>`;
  }
  if (block.type === "image") {
    if (!block.imageDataUrl) return renderPlaceholder(block);
    const w = block.imageWidthPx ?? 480;
    const h = block.imageHeightPx ?? 320;
    return `<img src="${block.imageDataUrl}" width="${w}" height="${h}" style="max-width:100%;height:auto;display:block;margin:10px 0" alt="${escapeHtml(block.label ?? "image")}"/>`;
  }
  if (block.type === "passthrough") {
    return renderPlaceholder(block);
  }
  return `<p${blockAttr(blockIndex)} style="${paragraphStyle(block)}">${runsHtml(block.runs)}</p>`;
}

function renderPlaceholder(block: Block): string {
  const label = escapeHtml(block.label ?? block.type);
  const preview = block.previewText ? escapeHtml(block.previewText) : "";
  return `<div style="margin:8px 0;padding:8px 10px;border:1px dashed #d1d5db;border-radius:6px;color:#6b7280;font-size:12px">${label}${preview ? ` · ${preview}` : ""}</div>`;
}

export interface DocxFontMetrics {
  family: string;
  matched_family: string | null;
  ascent: number;
  descent: number;
  line_gap: number;
  avg_latin: number;
  avg_cjk: number;
  space: number;
}

export interface DocxRenderOptions {
  headerText?: string | null;
  footerText?: string | null;
  showPageNumbers?: boolean;
  /** 字体族（小写）→ 系统度量；缺失时退回近似值 */
  fontMetrics?: Record<string, DocxFontMetrics>;
  /** word/numbering.xml 解析结果：用于还原真实列表编号（一、/1.等） */
  numbering?: Map<string, NumberingDef>;
}

const PAGE_WIDTH_PX = 820;
const PAGE_MIN_HEIGHT_PX = 1123;
const PAGE_PADDING_X = 56;
const PAGE_PADDING_Y = 64;

function renderPage(
  blocks: Block[],
  options: DocxRenderOptions,
  pageIndex: number,
  pageCount: number,
  indexOf: (block: Block) => number | undefined,
  ctx: RenderContext,
): string {
  const header = options.headerText
    ? `<div style="position:absolute;left:${PAGE_PADDING_X}px;right:${PAGE_PADDING_X}px;top:28px;font-size:11px;color:#9ca3af;border-bottom:1px solid #e5e7eb;padding-bottom:6px">${escapeHtml(options.headerText)}</div>`
    : "";
  const footerParts: string[] = [];
  if (options.footerText) footerParts.push(escapeHtml(options.footerText));
  if (options.showPageNumbers) footerParts.push(`${pageIndex + 1} / ${pageCount}`);
  const footer = footerParts.length
    ? `<div style="position:absolute;left:${PAGE_PADDING_X}px;right:${PAGE_PADDING_X}px;bottom:24px;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:6px;display:flex;justify-content:space-between"><span>${footerParts[0]}</span><span>${footerParts[1] ?? ""}</span></div>`
    : "";
  const body = blocks
    .map((block) => renderBlock(block, indexOf(block), ctx))
    .join("");
  // text-autospace 近似 Word 的「中英文/数字自动间距」（autoSpaceDE/DN）；
  // 不支持的 WebView 会忽略该声明，不影响其它排版。
  return `<div style="position:relative;width:${PAGE_WIDTH_PX}px;min-height:${PAGE_MIN_HEIGHT_PX}px;margin:0 auto 24px;padding:${PAGE_PADDING_Y}px ${PAGE_PADDING_X}px;background:#fff;color:#1f2937;font-family:system-ui,'Segoe UI','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;text-autospace:normal;box-shadow:0 1px 4px rgba(0,0,0,.1);box-sizing:border-box">${header}${body || '<p style="color:#9ca3af">（空文档）</p>'}${footer}</div>`;
}

const PAGE_CONTENT_HEIGHT = PAGE_MIN_HEIGHT_PX - PAGE_PADDING_Y * 2 - 48;

const DEFAULT_FONT_METRICS: DocxFontMetrics = {
  family: "default",
  matched_family: null,
  ascent: 0.8,
  descent: 0.2,
  line_gap: 0,
  avg_latin: 0.5,
  avg_cjk: 1,
  space: 0.25,
};

function metricsFor(
  family: string | undefined,
  map: Record<string, DocxFontMetrics> | undefined,
): DocxFontMetrics {
  if (!map) return DEFAULT_FONT_METRICS;
  const key = (family ?? "").trim().toLowerCase();
  return map[key] ?? map["calibri"] ?? DEFAULT_FONT_METRICS;
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

/** 估算单个块的高度（px），优先使用系统字体度量。 */
function estimateBlockHeight(
  block: Block,
  metrics: Record<string, DocxFontMetrics> | undefined,
): number {
  if (block.type === "image") {
    return Math.min(480, (block.imageHeightPx ?? 320) + 20);
  }
  if (block.type === "table") {
    return Math.min(600, (block.table?.rows.length ?? 2) * 32 + 24);
  }
  if (block.type === "heading") {
    return 40;
  }

  const availableWidth =
    PAGE_WIDTH_PX -
    PAGE_PADDING_X * 2 -
    (twipsToPx(block.format?.indentLeft) ?? 0) -
    (twipsToPx(block.format?.indentRight) ?? 0);

  let totalWidth = 0;
  let maxLineHeight = 0;
  let hasText = false;
  for (const run of block.runs ?? []) {
    const fontPt = Math.max(6, (run.sizeHalfPoints ?? 28) / 2);
    const fontPx = (fontPt * 96) / 72;
    const fm = metricsFor(run.font ?? run.eastAsiaFont ?? run.fontAscii, metrics);
    const lineHeight = fontPx * (fm.ascent + fm.descent + fm.line_gap);
    if (lineHeight > maxLineHeight) maxLineHeight = lineHeight;
    for (const ch of run.text) {
      hasText = true;
      if (ch === " ") totalWidth += fm.space * fontPx;
      else if (isCjk(ch.codePointAt(0) ?? 0)) totalWidth += fm.avg_cjk * fontPx;
      else totalWidth += fm.avg_latin * fontPx;
    }
  }
  if (!hasText) return 8;
  const lines = Math.max(1, Math.ceil(totalWidth / Math.max(1, availableWidth)));
  return lines * (maxLineHeight || 18) + 8;
}

export function renderDocxHtml(
  blocks: Block[],
  options: DocxRenderOptions = {},
): { html: string; truncated: boolean; pageCount: number } {
  // 编辑提交用的是 parsed.blocks 的索引（含隐藏块），必须按原数组定位。
  const indexMap = new Map(blocks.map((block, index) => [block, index] as const));
  const indexOf = (block: Block) => indexMap.get(block);
  const visible = blocks.filter((block) => !block.hidden);
  const truncated = visible.length > MAX_PREVIEW_BLOCKS;
  const limited = visible.slice(0, MAX_PREVIEW_BLOCKS);

  // 显式分页符优先；无分页符时按估算高度自动分页（近似，非 Word 精确排版）。
  const pages: Block[][] = [[]];
  let usedHeight = 0;
  for (const block of limited) {
    const height = estimateBlockHeight(block, options.fontMetrics);
    const current = pages[pages.length - 1]!;
    const forceBreak = block.format?.pageBreakBefore && current.length > 0;
    if (forceBreak || (current.length > 0 && usedHeight + height > PAGE_CONTENT_HEIGHT)) {
      pages.push([]);
      usedHeight = 0;
    }
    pages[pages.length - 1]!.push(block);
    usedHeight += height;
  }

  // 列表编号按整篇文档顺序计算（跨页续号 / 重新开始都依赖前序项）。
  const ctx: RenderContext = { list: buildListMarkers(limited, options.numbering) };
  const html = pages
    .map((page, index) =>
      renderPage(
        page,
        { showPageNumbers: true, ...options },
        index,
        pages.length,
        indexOf,
        ctx,
      ),
    )
    .join("");
  return { html, truncated, pageCount: pages.length };
}

export function listDocxTextBlocks(parsed: ParsedDocx): DocxTextBlock[] {
  const out: DocxTextBlock[] = [];
  parsed.blocks.forEach((block, blockIndex) => {
    if (block.hidden) return;
    if (block.type !== "paragraph" && block.type !== "heading" && block.type !== "listItem") {
      return;
    }
    const text = (block.runs ?? []).map((run) => run.text).join("");
    if (!text.trim()) return;
    out.push({
      blockIndex,
      type: block.type,
      text,
      preview: `${block.type === "heading" ? "标题" : block.type === "listItem" ? "列表" : "段落"} · ${text.replace(/\s+/g, " ").slice(0, 40)}`,
    });
  });
  return out;
}

/** 按"保留原段落属性 + 首 run 格式"的方式生成新段落，只替换文字。 */
export async function saveDocxWithEdits(
  parsed: ParsedDocx,
  edits: Record<number, string>,
): Promise<Uint8Array> {
  const visible = parsed.blocks.filter((block) => !block.hidden);
  if (visible.some((block) => block.docxIndex == null)) {
    throw new Error("文档包含无法定位的块，当前仅支持文本编辑");
  }
  const saveBlocks: SaveBlock[] = visible.map((block) => {
    const editedText = edits[parsed.blocks.indexOf(block)];
    if (editedText == null) {
      return { kind: "original", docxIndex: block.docxIndex! };
    }
    const firstRun: Run = block.runs?.[0] ?? { text: "" };
    const generated = {
      type: block.type,
      level: block.level,
      styleId: block.styleId,
      list: block.list,
      format: block.format,
      rawPPr: block.rawPPr,
      runs: [{ ...firstRun, text: editedText }],
    };
    return {
      kind: "generated",
      block: generated as never,
      docxIndex: block.docxIndex ?? undefined,
    };
  });
  return saveDocx(parsed, saveBlocks);
}

export async function openDocxSession(
  bytes: Uint8Array,
  options: { fontMetrics?: Record<string, DocxFontMetrics> } = {},
): Promise<DocxOpened> {
  const parsed = await parseDocx(bytes);
  const visible = parsed.blocks.filter((block) => !block.hidden);
  const { html, truncated, pageCount } = renderDocxHtml(parsed.blocks, {
    headerText: parsed.headerText,
    footerText: parsed.footerText,
    showPageNumbers: true,
    fontMetrics: options.fontMetrics,
    numbering: parsed.numbering,
  });

  let saved = bytes;
  if (visible.every((block) => block.docxIndex != null)) {
    saved = await saveDocx(
      parsed,
      visible.map((block) => ({ kind: "original" as const, docxIndex: block.docxIndex! })),
    );
  }

  return {
    info: {
      blockCount: visible.length,
      headingCount: visible.filter((block) => block.type === "heading").length,
      tableCount: visible.filter((block) => block.type === "table").length,
      imageCount: visible.filter((block) => block.type === "image").length,
      pageCount,
      truncated,
    },
    html,
    saved,
    parsed,
    textBlocks: listDocxTextBlocks(parsed),
  };
}
