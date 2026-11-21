//! 结构化导出：ProseMirror JSON → docx（原生路径的高保真版）。
//!
//! 背景：HTML → Markdown → docx 的往返会把 callout / 分栏 / 代码块命名 /
//! 表格列宽等结构信息拍平。这里直接消费编辑器 `editor.getJSON()`，
//! 按节点类型映射到 OOXML，专供「无系统转换器」时的原生兜底。
//!
//! 设计取舍：
//! - 用 `serde_json::Value` 存 attrs，未知节点/属性不会导致整篇导出失败；
//! - 未知块节点递归渲染 children，未知行内节点取其 text，尽量不丢内容；
//! - 复用 `export_word` 里的样式表、编号定义、图片尺寸与附件打包逻辑。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use docx_rs::*;
use serde::Deserialize;

use crate::error::AppError;
use crate::services::asset_path::resolve_content_url;
use crate::services::export_html::ExportFonts;
use crate::services::export_word::{
    build_numberings, build_styles_for_fonts, image_emu_for_attrs, pack_attachment_list,
    primary_font_family, read_image_dimensions, resolve_image, table_borders, WordExportResult,
    WordExportService, BULLET_NUM_ID, ORDERED_NUM_ID,
};

const CODE_FONT: &str = "Cascadia Code";
const MUTED: &str = "6E7781";
const BORDER: &str = "D0D7DE";
const CODE_BG: &str = "F6F8FA";
const LINK_COLOR: &str = "0563C1";
const MAX_NUMBERING_LEVEL: usize = 2;

/// ProseMirror JSON 的通用节点（attrs/text/marks 全部容错）
#[derive(Debug, Clone, Deserialize)]
pub struct PmNode {
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub attrs: serde_json::Value,
    #[serde(default)]
    pub content: Vec<PmNode>,
    #[serde(default)]
    pub marks: Vec<PmMark>,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PmMark {
    #[serde(rename = "type")]
    pub mark_type: String,
    #[serde(default)]
    pub attrs: serde_json::Value,
}

impl PmNode {
    fn attr_str(&self, key: &str) -> Option<String> {
        self.attrs
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    fn attr_i64(&self, key: &str) -> Option<i64> {
        self.attrs.get(key).and_then(|v| {
            v.as_i64().or_else(|| {
                v.as_str()
                    .and_then(|s| s.trim().parse::<i64>().ok())
            })
        })
    }

    fn attr_bool(&self, key: &str) -> Option<bool> {
        self.attrs.get(key).and_then(|v| v.as_bool())
    }

    fn text_content(&self) -> String {
        if let Some(t) = &self.text {
            return t.clone();
        }
        self.content.iter().map(|n| n.text_content()).collect()
    }
}

impl PmMark {
    fn attr_str(&self, key: &str) -> Option<String> {
        self.attrs
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }
}

/// 渲染结果：顶层与表格单元格都能容纳段落/表格
enum Block {
    P(Paragraph),
    T(Table),
}

#[derive(Clone, Copy)]
struct ListStyle {
    ordered: bool,
    level: usize,
    /// 只有列表项的第一个段落带编号；后续段落只缩进
    numbered: bool,
}

#[derive(Clone, Copy)]
struct CalloutStyle {
    accent: &'static str,
    bg: &'static str,
}

#[derive(Clone, Copy, Default)]
struct BlockStyle {
    list: Option<ListStyle>,
    quote: bool,
    callout: Option<CalloutStyle>,
}

#[derive(Default)]
struct Stats {
    images_embedded: usize,
    images_missing: usize,
}

struct Renderer<'a> {
    body_font: Option<String>,
    heading_font: Option<String>,
    assets_root: &'a Path,
    heading_numbers: &'a [String],
    heading_index: usize,
    stats: Stats,
    links: Vec<(String, PathBuf)>,
    seen_links: HashSet<PathBuf>,
}

/// 结构化导出入口。`heading_numbers` 与文档中的 heading 顺序一一对应；
/// 标签为空表示该标题没有自动编号。
pub fn export_single_from_json(
    title: &str,
    doc: &PmNode,
    heading_numbers: &[String],
    target_path: &Path,
    assets_root: &Path,
    fonts: Option<&ExportFonts>,
) -> Result<WordExportResult, AppError> {
    let body_font = primary_font_family(fonts.and_then(|f| f.body.as_deref()));
    let heading_font = primary_font_family(fonts.and_then(|f| f.heading.as_deref()))
        .or_else(|| body_font.clone());

    let mut docx = Docx::new()
        .styles(build_styles_for_fonts(
            body_font.as_deref(),
            heading_font.as_deref(),
        ))
        .numberings(build_numberings());

    // 笔记标题是编辑器外字段，JSON 里没有；正文若已手写同名 H1 则不重复插。
    if !title.trim().is_empty() && !first_heading_matches(doc, title) {
        let mut run = Run::new().add_text(title.trim()).size(48).bold();
        if let Some(font) = &heading_font {
            run = run.fonts(
                RunFonts::new()
                    .east_asia(font.clone())
                    .ascii(font.clone()),
            );
        }
        docx = docx.add_paragraph(Paragraph::new().style("Title").add_run(run));
    }

    let mut renderer = Renderer {
        body_font,
        heading_font,
        assets_root,
        heading_numbers,
        heading_index: 0,
        stats: Stats::default(),
        links: Vec::new(),
        seen_links: HashSet::new(),
    };
    let blocks = renderer.render_blocks(&doc.content, BlockStyle::default());
    for block in blocks {
        docx = match block {
            Block::P(p) => docx.add_paragraph(p),
            Block::T(t) => docx.add_table(t),
        };
    }

    let attachments =
        pack_attachment_list(std::mem::take(&mut renderer.links), target_path, &mut docx)?;

    WordExportService::write_docx(docx, target_path)?;

    Ok(WordExportResult {
        file_path: target_path.to_string_lossy().into(),
        images_embedded: renderer.stats.images_embedded,
        images_missing: renderer.stats.images_missing,
        attachments_copied: attachments,
        attachments_inlined: 0,
        engine: "structured".to_string(),
    })
}

fn first_heading_matches(doc: &PmNode, title: &str) -> bool {
    let Some(first) = doc
        .content
        .iter()
        .find(|n| n.node_type == "heading" || n.node_type == "paragraph")
    else {
        return false;
    };
    if first.node_type != "heading" {
        return false;
    }
    let normalize = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    normalize(&first.text_content()) == normalize(title.trim())
}

impl<'a> Renderer<'a> {
    fn render_blocks(&mut self, nodes: &[PmNode], style: BlockStyle) -> Vec<Block> {
        let mut out = Vec::new();
        for node in nodes {
            match node.node_type.as_str() {
                "paragraph" => out.push(Block::P(self.render_paragraph(node, style))),
                "heading" => out.push(Block::P(self.render_heading(node, style))),
                "bulletList" => out.extend(self.render_list(node, style, false)),
                "orderedList" => out.extend(self.render_list(node, style, true)),
                "taskList" => out.extend(self.render_task_list(node, style)),
                "blockquote" => {
                    let mut nested = style;
                    nested.quote = true;
                    out.extend(self.render_blocks(&node.content, nested));
                }
                "codeBlock" => out.extend(self.render_code_block(node)),
                "horizontalRule" => out.push(Block::P(paragraph_with_rule())),
                "table" => out.push(Block::T(self.render_table(node))),
                "image" | "figureImage" => out.extend(self.render_image(node)),
                "callout" => {
                    let kind = callout_style(node.attr_str("type").as_deref());
                    let mut nested = style;
                    nested.callout = Some(kind);
                    out.extend(self.render_blocks(&node.content, nested));
                }
                "columns" => out.push(self.render_columns(node)),
                "toggle" => out.extend(self.render_toggle(node)),
                "mathBlock" | "blockMath" => out.push(Block::P(self.render_math_block(node))),
                _ => {
                    if !node.content.is_empty() {
                        out.extend(self.render_blocks(&node.content, style));
                    } else if let Some(text) = node.text.as_deref() {
                        if !text.trim().is_empty() {
                            out.push(Block::P(self.render_plain_text(text, style)));
                        }
                    } else if let Some(placeholder) = placeholder_text(node) {
                        // 无文本内容的互动节点：至少留一个可读占位，避免整块消失
                        out.push(Block::P(self.render_plain_text(&placeholder, style)));
                    }
                }
            }
        }
        out
    }

    fn render_paragraph(&mut self, node: &PmNode, style: BlockStyle) -> Paragraph {
        let mut p = Paragraph::new();
        if let Some(list) = style.list {
            if list.numbered {
                let num_id = if list.ordered {
                    ORDERED_NUM_ID
                } else {
                    BULLET_NUM_ID
                };
                p = p.numbering(
                    NumberingId::new(num_id),
                    IndentLevel::new(list.level.min(MAX_NUMBERING_LEVEL)),
                );
            } else {
                p = p.indent(Some(list_indent(list.level)), None, None, None);
            }
        }
        p = apply_align_and_indent(p, node);
        p = apply_container_style(p, style);
        for run in self.render_inline(&node.content, style, None) {
            p = p.add_run(run);
        }
        p
    }

    fn render_heading(&mut self, node: &PmNode, style: BlockStyle) -> Paragraph {
        let level = node.attr_i64("level").unwrap_or(1).clamp(1, 6) as usize;
        let style_id = format!("Heading{level}");
        let mut p = Paragraph::new().style(&style_id);
        p = apply_align_and_indent(p, node);
        p = apply_container_style(p, style);

        // 标题自动编号是 ProseMirror decoration，不在 JSON 里；前端按顺序补过来。
        if let Some(label) = self.heading_numbers.get(self.heading_index) {
            let label = label.trim();
            if !label.is_empty() {
                p = p.add_run(Run::new().add_text(format!("{label} ")));
            }
        }
        self.heading_index += 1;

        for run in self.render_inline(&node.content, style, Some(level)) {
            p = p.add_run(run);
        }
        p
    }

    fn render_plain_text(&self, text: &str, style: BlockStyle) -> Paragraph {
        let mut run = Run::new().add_text(text);
        if let Some(font) = &self.body_font {
            run = run.fonts(
                RunFonts::new()
                    .east_asia(font.clone())
                    .ascii(font.clone()),
            );
        }
        if style.quote {
            run = run.color(MUTED).italic();
        }
        apply_container_style(Paragraph::new().add_run(run), style)
    }

    fn render_list(&mut self, node: &PmNode, style: BlockStyle, ordered: bool) -> Vec<Block> {
        let level = style.list.map(|l| l.level).unwrap_or(0);
        let mut out = Vec::new();
        for item in node.content.iter().filter(|n| n.node_type == "listItem") {
            let mut first = true;
            for child in &item.content {
                match child.node_type.as_str() {
                    "bulletList" => out.extend(self.render_list(
                        child,
                        BlockStyle {
                            list: Some(ListStyle {
                                ordered: false,
                                level: level + 1,
                                numbered: true,
                            }),
                            ..style
                        },
                        false,
                    )),
                    "orderedList" => out.extend(self.render_list(
                        child,
                        BlockStyle {
                            list: Some(ListStyle {
                                ordered: true,
                                level: level + 1,
                                numbered: true,
                            }),
                            ..style
                        },
                        true,
                    )),
                    "taskList" => out.extend(self.render_task_list(
                        child,
                        BlockStyle {
                            list: Some(ListStyle {
                                ordered: false,
                                level: level + 1,
                                numbered: true,
                            }),
                            ..style
                        },
                    )),
                    _ => {
                        let nested = BlockStyle {
                            list: Some(ListStyle {
                                ordered,
                                level,
                                numbered: first,
                            }),
                            ..style
                        };
                        out.extend(self.render_blocks(std::slice::from_ref(child), nested));
                        first = false;
                    }
                }
            }
        }
        out
    }

    fn render_task_list(&mut self, node: &PmNode, style: BlockStyle) -> Vec<Block> {
        let level = style.list.map(|l| l.level).unwrap_or(0);
        let mut out = Vec::new();
        for item in node
            .content
            .iter()
            .filter(|n| n.node_type == "taskItem")
        {
            let checked = item.attr_bool("checked").unwrap_or(false);
            let mut first = true;
            for child in &item.content {
                match child.node_type.as_str() {
                    "paragraph" => {
                        let mut p = Paragraph::new()
                            .indent(Some(list_indent(level)), None, None, None)
                            .align(AlignmentType::Left);
                        if first {
                            p = p.add_run(Run::new().add_text(if checked { "☑ " } else { "☐ " }));
                        }
                        let plain_style = BlockStyle {
                            list: None,
                            ..style
                        };
                        let runs = self.render_inline(&child.content, plain_style, None);
                        for run in runs {
                            p = p.add_run(if checked { run.strike() } else { run });
                        }
                        out.push(Block::P(p));
                        first = false;
                    }
                    "bulletList" => out.extend(self.render_list(
                        child,
                        BlockStyle {
                            list: Some(ListStyle {
                                ordered: false,
                                level: level + 1,
                                numbered: true,
                            }),
                            ..style
                        },
                        false,
                    )),
                    "orderedList" => out.extend(self.render_list(
                        child,
                        BlockStyle {
                            list: Some(ListStyle {
                                ordered: true,
                                level: level + 1,
                                numbered: true,
                            }),
                            ..style
                        },
                        true,
                    )),
                    "taskList" => out.extend(self.render_task_list(
                        child,
                        BlockStyle {
                            list: Some(ListStyle {
                                ordered: false,
                                level: level + 1,
                                numbered: true,
                            }),
                            ..style
                        },
                    )),
                    _ => out.extend(self.render_blocks(std::slice::from_ref(child), style)),
                }
            }
        }
        out
    }

    fn render_code_block(&mut self, node: &PmNode) -> Vec<Block> {
        let mut out = Vec::new();
        if let Some(title) = node.attr_str("title") {
            if !title.trim().is_empty() {
                out.push(Block::P(
                    Paragraph::new().add_run(
                        Run::new()
                            .add_text(title.trim())
                            .size(19)
                            .bold()
                            .color(MUTED),
                    ),
                ));
            }
        }

        let code = node
            .content
            .iter()
            .filter_map(|n| n.text.as_deref())
            .collect::<String>();
        let size = node
            .attr_i64("fontSize")
            .filter(|n| *n > 0)
            .map(|px| (px as f64 * 1.5).round() as usize)
            .unwrap_or(20);

        let lines: Vec<&str> = if code.is_empty() {
            vec![" "]
        } else {
            code.lines().collect()
        };
        for line in lines {
            let text = if line.is_empty() { " " } else { line };
            let mut p = Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text(text)
                        .fonts(
                            RunFonts::new()
                                .east_asia(CODE_FONT)
                                .ascii(CODE_FONT),
                        )
                        .size(size),
                )
                .indent(Some(360), None, None, None)
                .keep_lines(true);
            p.property = p.property.shading(Shading::new().fill(CODE_BG));
            out.push(Block::P(p));
        }
        out
    }

    fn render_image(&mut self, node: &PmNode) -> Vec<Block> {
        let src = node.attr_str("src").unwrap_or_default();
        let alt = node.attr_str("alt").unwrap_or_default();
        let mut out = Vec::new();

        match resolve_image(&src, self.assets_root) {
            // docx-rs 的 Pic::new 会真正解码图片；SVG / 损坏文件会让它 panic。
            // 只嵌入能识别尺寸的常见位图，其余降级为占位文本。
            Some(bytes) if read_image_dimensions(&bytes).is_some() => {
                let width = node.attr_i64("width").filter(|n| *n > 0).map(|n| n as u32);
                let height = node.attr_i64("height").filter(|n| *n > 0).map(|n| n as u32);
                let (w_emu, h_emu) = image_emu_for_attrs(&bytes, width, height);
                let pic = Pic::new(&bytes).size(w_emu, h_emu);
                out.push(Block::P(
                    Paragraph::new()
                        .align(AlignmentType::Center)
                        .add_run(Run::new().add_image(pic)),
                ));
                self.stats.images_embedded += 1;

                if let Some(caption) = node.attr_str("caption") {
                    if !caption.trim().is_empty() {
                        out.push(Block::P(
                            Paragraph::new()
                                .align(AlignmentType::Center)
                                .add_run(
                                    Run::new()
                                        .add_text(caption.trim())
                                        .size(19)
                                        .italic()
                                        .color(MUTED),
                                ),
                        ));
                    }
                }
            }
            Some(_) => {
                let label = if alt.trim().is_empty() {
                    format!("[不支持的图片格式: {src}]")
                } else {
                    format!("[不支持的图片格式: {}]", alt.trim())
                };
                out.push(Block::P(Paragraph::new().add_run(
                    Run::new()
                        .add_text(label)
                        .italic()
                        .color("999999"),
                )));
                self.stats.images_missing += 1;
            }
            None => {
                let label = if alt.trim().is_empty() {
                    format!("[图片缺失: {src}]")
                } else {
                    format!("[图片缺失: {}]", alt.trim())
                };
                out.push(Block::P(Paragraph::new().add_run(
                    Run::new()
                        .add_text(label)
                        .italic()
                        .color("999999"),
                )));
                self.stats.images_missing += 1;
            }
        }
        out
    }

    fn render_table(&mut self, node: &PmNode) -> Table {
        let rows = node
            .content
            .iter()
            .filter(|n| n.node_type == "tableRow")
            .map(|row| {
                let cells = row
                    .content
                    .iter()
                    .filter(|n| n.node_type == "tableCell" || n.node_type == "tableHeader")
                    .map(|cell| {
                        let is_header = cell.node_type == "tableHeader";
                        let mut tc = TableCell::new();
                        let colspan = cell.attr_i64("colspan").unwrap_or(1);
                        if colspan > 1 {
                            tc = tc.grid_span(colspan as usize);
                        }

                        let blocks = self.render_blocks(&cell.content, BlockStyle::default());
                        let mut added = false;
                        for block in blocks {
                            match block {
                                Block::P(p) => {
                                    let p = if is_header {
                                        p.align(AlignmentType::Center)
                                    } else {
                                        p
                                    };
                                    tc = tc.add_paragraph(p);
                                    added = true;
                                }
                                Block::T(t) => {
                                    tc = tc.add_table(t);
                                    added = true;
                                }
                            }
                        }
                        if !added {
                            tc = tc.add_paragraph(Paragraph::new());
                        }
                        if is_header {
                            tc = tc.shading(Shading::new().fill("F2F2F2"));
                        }
                        tc
                    })
                    .collect::<Vec<_>>();
                TableRow::new(cells)
            })
            .collect::<Vec<_>>();

        Table::new(rows).set_borders(table_borders())
    }

    /// 分栏 → 1 行 N 列的无边框表格，保留左右并排关系。
    fn render_columns(&mut self, node: &PmNode) -> Block {
        let cells = node
            .content
            .iter()
            .filter(|n| n.node_type == "column")
            .map(|col| {
                let mut tc = TableCell::new();
                let blocks = self.render_blocks(&col.content, BlockStyle::default());
                let mut added = false;
                for block in blocks {
                    match block {
                        Block::P(p) => {
                            tc = tc.add_paragraph(p);
                            added = true;
                        }
                        Block::T(t) => {
                            tc = tc.add_table(t);
                            added = true;
                        }
                    }
                }
                if !added {
                    tc = tc.add_paragraph(Paragraph::new());
                }
                tc
            })
            .collect::<Vec<_>>();

        Block::T(Table::without_borders(vec![TableRow::new(cells)]))
    }

    fn render_toggle(&mut self, node: &PmNode) -> Vec<Block> {
        let mut out = Vec::new();
        for child in &node.content {
            match child.node_type.as_str() {
                "toggleSummary" => {
                    let mut p = Paragraph::new().add_run(Run::new().add_text("▶ "));
                    for run in self.render_inline(&child.content, BlockStyle::default(), None) {
                        p = p.add_run(run.bold());
                    }
                    out.push(Block::P(p));
                }
                "toggleContent" => {
                    out.extend(self.render_blocks(&child.content, BlockStyle::default()))
                }
                _ => out.extend(self.render_blocks(std::slice::from_ref(child), BlockStyle::default())),
            }
        }
        out
    }

    fn render_math_block(&self, node: &PmNode) -> Paragraph {
        let latex = node
            .attr_str("latex")
            .or_else(|| node.attr_str("tex"))
            .unwrap_or_else(|| node.text_content());
        Paragraph::new()
            .align(AlignmentType::Center)
            .add_run(
                Run::new()
                    .add_text(latex)
                    .fonts(
                        RunFonts::new()
                            .east_asia("Cambria Math")
                            .ascii("Cambria Math"),
                    )
                    .italic(),
            )
    }

    fn render_inline(
        &mut self,
        nodes: &[PmNode],
        style: BlockStyle,
        heading: Option<usize>,
    ) -> Vec<Run> {
        let mut runs = Vec::new();
        for node in nodes {
            match node.node_type.as_str() {
                "text" => {
                    let text = node.text.clone().unwrap_or_default();
                    if text.is_empty() {
                        continue;
                    }
                    let mut run = Run::new().add_text(text.clone());
                    run = self.apply_base_font(run, heading, style);
                    for mark in &node.marks {
                        run = apply_mark(run, mark);
                        if mark.mark_type == "link" {
                            self.collect_link(&text, mark);
                        }
                    }
                    runs.push(run);
                }
                "hardBreak" => {
                    runs.push(Run::new().add_break(BreakType::TextWrapping));
                }
                "inlineMath" | "mathInline" => {
                    let latex = node
                        .attr_str("latex")
                        .or_else(|| node.attr_str("tex"))
                        .unwrap_or_else(|| node.text_content());
                    runs.push(
                        Run::new()
                            .add_text(latex)
                            .fonts(
                                RunFonts::new()
                                    .east_asia("Cambria Math")
                                    .ascii("Cambria Math"),
                            )
                            .italic(),
                    );
                }
                _ => {
                    if !node.content.is_empty() {
                        runs.extend(self.render_inline(&node.content, style, heading));
                    } else if let Some(text) = &node.text {
                        if !text.is_empty() {
                            let mut run = Run::new().add_text(text.clone());
                            run = self.apply_base_font(run, heading, style);
                            runs.push(run);
                        }
                    }
                }
            }
        }
        runs
    }

    fn apply_base_font(&self, mut run: Run, heading: Option<usize>, style: BlockStyle) -> Run {
        let font = if heading.is_some() {
            &self.heading_font
        } else {
            &self.body_font
        };
        if let Some(font) = font {
            run = run.fonts(
                RunFonts::new()
                    .east_asia(font.clone())
                    .ascii(font.clone()),
            );
        }
        if style.quote {
            run = run.color(MUTED).italic();
        }
        run
    }

    fn collect_link(&mut self, text: &str, mark: &PmMark) {
        let Some(href) = mark.attr_str("href") else {
            return;
        };
        let Some(abs) = resolve_content_url(&href, self.assets_root) else {
            return;
        };
        let Ok(canon) = abs.canonicalize() else {
            return;
        };
        if !canon.is_file() || !self.seen_links.insert(canon.clone()) {
            return;
        }
        let label = if text.trim().is_empty() {
            canon
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "附件".to_string())
        } else {
            text.trim().to_string()
        };
        self.links.push((label, canon));
    }
}

/// 无文本内容的互动节点在 Word 里没有等价物，给一个可读占位，避免整块静默消失。
fn placeholder_text(node: &PmNode) -> Option<String> {
    match node.node_type.as_str() {
        "embedVideo" => Some("[嵌入视频]".to_string()),
        "viewer3D" => Some("[3D 模型]".to_string()),
        "whiteboard" => Some("[白板]".to_string()),
        "dataview" => Some("[数据视图]".to_string()),
        "mermaidBlock" => Some("[Mermaid 流程图]".to_string()),
        _ => None,
    }
}

fn callout_style(kind: Option<&str>) -> CalloutStyle {
    match kind.unwrap_or("info") {
        "tip" => CalloutStyle {
            accent: "52C41A",
            bg: "F4FBF0",
        },
        "warning" => CalloutStyle {
            accent: "FAAD14",
            bg: "FFF9EB",
        },
        "danger" => CalloutStyle {
            accent: "FF4D4F",
            bg: "FFF2F0",
        },
        _ => CalloutStyle {
            accent: "1677FF",
            bg: "F2F7FF",
        },
    }
}

fn list_indent(level: usize) -> i32 {
    ((level as i32) + 1) * 360
}

fn apply_align_and_indent(mut p: Paragraph, node: &PmNode) -> Paragraph {
    if let Some(align) = node.attr_str("textAlign") {
        p = p.align(match align.as_str() {
            "center" => AlignmentType::Center,
            "right" => AlignmentType::Right,
            "justify" => AlignmentType::Both,
            _ => AlignmentType::Left,
        });
    }
    if let Some(indent) = node.attr_i64("indent") {
        if indent > 0 {
            p = p.indent(
                Some((indent as i32) * 360),
                None,
                None,
                None,
            );
        }
    }
    p
}

fn apply_container_style(mut p: Paragraph, style: BlockStyle) -> Paragraph {
    if style.quote {
        p = p.indent(Some(720), None, None, None);
        p.property = p
            .property
            .set_border(
                ParagraphBorder::new(ParagraphBorderPosition::Left)
                    .size(18)
                    .color(BORDER)
                    .space(8),
            )
            .shading(Shading::new().fill(CODE_BG));
    }
    if let Some(c) = style.callout {
        p.property = p
            .property
            .set_border(
                ParagraphBorder::new(ParagraphBorderPosition::Left)
                    .size(18)
                    .color(c.accent)
                    .space(8),
            )
            .shading(Shading::new().fill(c.bg));
    }
    p
}

fn paragraph_with_rule() -> Paragraph {
    let mut p = Paragraph::new();
    p.property = p.property.set_border(
        ParagraphBorder::new(ParagraphBorderPosition::Bottom)
            .size(6)
            .color(BORDER)
            .space(1),
    );
    p
}

fn apply_mark(mut run: Run, mark: &PmMark) -> Run {
    match mark.mark_type.as_str() {
        "bold" => run.bold(),
        "italic" => run.italic(),
        "strike" => run.strike(),
        "underline" => run.underline("single"),
        // 行内代码：编辑器里只加浅灰底 + 等宽字体，**继承正文颜色**；
        // 不要套 GitHub 的红色，否则整段代码文字在 Word 里变红。
        "code" => run
            .fonts(
                RunFonts::new()
                    .east_asia(CODE_FONT)
                    .ascii(CODE_FONT),
            )
            .size(20)
            .shading(Shading::new().fill(CODE_BG)),
        "link" => run.color(LINK_COLOR).underline("single"),
        "highlight" => {
            if let Some(color) = mark.attr_str("color") {
                if let Some(hex) = normalize_hex(&color) {
                    run = run.shading(Shading::new().fill(hex));
                }
            }
            run
        }
        "textStyle" => {
            if let Some(color) = mark.attr_str("color") {
                if let Some(hex) = normalize_hex(&color) {
                    run = run.color(hex);
                }
            }
            if let Some(size) = mark
                .attrs
                .get("fontSize")
                .and_then(parse_font_size_half_points)
            {
                run = run.size(size);
            }
            if let Some(family) = mark.attr_str("fontFamily") {
                if let Some(first) = family.split(',').next() {
                    let name = first.trim().trim_matches('"').trim_matches('\'');
                    if !name.is_empty() {
                        run = run.fonts(
                            RunFonts::new()
                                .east_asia(name.to_string())
                                .ascii(name.to_string()),
                        );
                    }
                }
            }
            run
        }
        _ => run,
    }
}

fn normalize_hex(color: &str) -> Option<String> {
    let raw = color.trim().trim_start_matches('#');
    let expanded = if raw.len() == 3 {
        raw.chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        raw.to_string()
    };
    if expanded.len() == 6 && expanded.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(expanded.to_ascii_uppercase())
    } else {
        None
    }
}

/// CSS 字号 → OOXML 半磅。支持 `18px` / `12pt` / 数字（按 px 处理）。
fn parse_font_size_half_points(value: &serde_json::Value) -> Option<usize> {
    if let Some(n) = value.as_f64() {
        return Some((n * 1.5).round().max(1.0) as usize);
    }
    let s = value.as_str()?.trim().to_ascii_lowercase();
    if let Some(px) = s.strip_suffix("px") {
        let n: f64 = px.trim().parse().ok()?;
        return Some((n * 1.5).round().max(1.0) as usize);
    }
    if let Some(pt) = s.strip_suffix("pt") {
        let n: f64 = pt.trim().parse().ok()?;
        return Some((n * 2.0).round().max(1.0) as usize);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_docx(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("kb_json_word_{}_{}.docx", tag, nanos))
    }

    fn zip_entry(path: &Path, name: &str) -> String {
        let file = std::fs::File::open(path).expect("docx 应存在");
        let mut zip = zip::ZipArchive::new(file).expect("docx 应是 zip");
        let mut entry = zip.by_name(name).expect("应包含目标 entry");
        let mut xml = String::new();
        entry.read_to_string(&mut xml).expect("读取 entry");
        xml
    }

    fn paragraph_containing<'a>(xml: &'a str, needle: &str) -> &'a str {
        let pos = xml.find(needle).expect("段落文字应存在");
        let start = xml[..pos].rfind("<w:p ").expect("应能定位段落");
        let end = xml[pos..].find("</w:p>").map(|e| pos + e + 6).unwrap();
        &xml[start..end]
    }

    fn sample_doc() -> PmNode {
        serde_json::from_value(json!({
            "type": "doc",
            "content": [
                {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"小标题"}]},
                {"type":"paragraph","content":[
                    {"type":"text","text":"正文"},
                    {"type":"text","text":"加粗","marks":[{"type":"bold"}]},
                    {"type":"text","text":"删除","marks":[{"type":"strike"}]}
                ]},
                {"type":"bulletList","content":[
                    {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"项目一"}]}]},
                    {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"项目二"}]}]}
                ]},
                {"type":"codeBlock","attrs":{"language":"rust","title":"示例"},"content":[
                    {"type":"text","text":"let x = 1;\nlet y = 2;"}
                ]},
                {"type":"table","content":[
                    {"type":"tableRow","content":[
                        {"type":"tableHeader","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph","content":[{"type":"text","text":"模式"}]}]},
                        {"type":"tableHeader","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph","content":[{"type":"text","text":"行为"}]}]}
                    ]},
                    {"type":"tableRow","content":[
                        {"type":"tableCell","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph","content":[{"type":"text","text":"演示"}]}]},
                        {"type":"tableCell","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph","content":[{"type":"text","text":"自动"}]}]}
                    ]}
                ]},
                {"type":"callout","attrs":{"type":"warning"},"content":[
                    {"type":"paragraph","content":[{"type":"text","text":"注意"}]}
                ]},
                {"type":"columns","content":[
                    {"type":"column","content":[{"type":"paragraph","content":[{"type":"text","text":"左栏"}]}]},
                    {"type":"column","content":[{"type":"paragraph","content":[{"type":"text","text":"右栏"}]}]}
                ]},
                {"type":"taskList","content":[
                    {"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"已完成"}]}]},
                    {"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"未完成"}]}]}
                ]}
            ]
        }))
        .expect("示例 JSON 应可解析")
    }

    #[test]
    fn structured_export_maps_core_nodes() {
        let docx = tmp_docx("core");
        let assets = std::env::temp_dir();
        let headings = vec!["1".to_string()];
        let result = export_single_from_json(
            "标题",
            &sample_doc(),
            &headings,
            &docx,
            &assets,
            None,
        )
        .expect("结构化导出应成功");
        assert_eq!(result.engine, "structured");

        let xml = zip_entry(&docx, "word/document.xml");
        let styles = zip_entry(&docx, "word/styles.xml");

        // 标题：Heading2 + 自动编号标签
        assert!(styles.contains(r#"w:styleId="Heading2""#));
        assert!(styles.contains(r#"w:outlineLvl w:val="1""#));
        let heading = paragraph_containing(&xml, "小标题");
        assert!(heading.contains(r#"w:pStyle w:val="Heading2""#));
        assert!(heading.contains("1 "), "标题应带自动编号标签：{heading}");

        // 列表：真编号，不是手写 bullet
        assert!(xml.contains("w:numId w:val=\"1\""));
        assert!(!xml.contains("• 项目"));

        // 代码块：段落级底纹 + 标题 caption
        let code = paragraph_containing(&xml, "let x = 1;");
        let ppr_end = code.find("</w:pPr>").expect("代码段应有 pPr");
        assert!(code[..ppr_end].contains("<w:shd"));
        assert!(code[..ppr_end].contains("F6F8FA"));
        assert!(xml.contains("示例"));

        // 表格：边框 + 表头居中
        assert!(xml.contains("<w:tblBorders"));
        assert!(xml.contains("D0D7DE"));
        let header = paragraph_containing(&xml, "模式");
        assert!(header.contains("w:jc w:val=\"center\""));

        // callout：warning 左边框 + 浅黄底
        let callout = paragraph_containing(&xml, "注意");
        assert!(callout.contains("FFF9EB"));
        assert!(callout.contains("<w:pBdr>"));

        // 分栏：保留同表并排（无边框表格），两栏文字都在
        assert!(xml.contains("左栏") && xml.contains("右栏"));

        // 任务列表：☑/☐ + 已完成删除线
        assert!(xml.contains("☑ ") && xml.contains("☐ "));
        let done = paragraph_containing(&xml, "已完成");
        assert!(done.contains("<w:strike"));

        let _ = std::fs::remove_file(&docx);
    }

    #[test]
    fn structured_export_keeps_unknown_node_text() {
        let doc: PmNode = serde_json::from_value(json!({
            "type": "doc",
            "content": [
                {"type": "unknownWidget", "content": [
                    {"type": "paragraph", "content": [{"type":"text","text":"兜底内容"}]}
                ]}
            ]
        }))
        .expect("JSON 应可解析");
        let docx = tmp_docx("unknown");
        export_single_from_json(
            "标题",
            &doc,
            &[],
            &docx,
            &std::env::temp_dir(),
            None,
        )
        .expect("未知节点不应让导出失败");
        let xml = zip_entry(&docx, "word/document.xml");
        assert!(xml.contains("兜底内容"));
        let _ = std::fs::remove_file(&docx);
    }

    /// 行内代码只应有浅灰底 + 等宽字体，不能把文字染成红色
    /// （编辑器里 code 是继承正文颜色的）。
    #[test]
    fn inline_code_keeps_body_color() {
        let doc: PmNode = serde_json::from_value(json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [
                    {"type":"text","text":"范围："},
                    {"type":"text","text":"D:\\Qt\\mayo\\docs","marks":[{"type":"code"}]}
                ]
            }]
        }))
        .expect("JSON 应可解析");
        let docx = tmp_docx("inline_code");
        export_single_from_json(
            "标题",
            &doc,
            &[],
            &docx,
            &std::env::temp_dir(),
            None,
        )
        .expect("行内代码导出应成功");

        let xml = zip_entry(&docx, "word/document.xml");
        let para = paragraph_containing(&xml, "mayo");
        assert!(para.contains("F6F8FA"), "行内代码应有浅灰底纹：{para}");
        assert!(
            !para.contains("C7254E") && !para.contains("c7254e"),
            "行内代码不应改变文字颜色：{para}"
        );

        let _ = std::fs::remove_file(&docx);
    }

    /// 人工检查用：生成一份结构化样本 docx 到固定路径。
    #[test]
    #[ignore = "人工检查样本"]
    fn write_sample_docx() {
        let path = std::env::temp_dir().join("kb_json_sample.docx");
        export_single_from_json(
            "结构化导出样本",
            &sample_doc(),
            &["1".to_string()],
            &path,
            &std::env::temp_dir(),
            None,
        )
        .expect("样本导出应成功");
        println!("{}", path.display());
    }
}
