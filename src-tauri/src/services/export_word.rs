//! T-020 文档导出为 Word（.docx）
//!
//! 设计：
//! - 用 `pulldown-cmark` 解析 markdown（项目已装），事件驱动地映射到 docx 元素
//! - 用 `docx-rs` 生成 .docx 文件
//! - 图片：识别 markdown 中的 ![](url)，对 asset:// / 本地相对路径 / 绝对路径都尝试解析为字节嵌入；
//!   失败的图片保留 alt 文本（不报错）
//!
//! 不在 v1：
//! - LaTeX 公式 `$$...$$` → 当作 plain text 段落
//! - 任务列表 `- [ ]` → 当成普通列表
//! - 嵌套表格 → 拍平为段落
//! - 复杂 inline 样式组合（粗体+斜体+链接交错）→ 简化处理

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use docx_rs::*;
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::error::AppError;
use crate::services::asset_path::resolve_content_url;
use crate::services::converter::{self, DocConverter};
use crate::services::export_html::{ExportFonts, HtmlExportService, TemplateLayout};
use crate::services::markdown::html_to_markdown;

/// GFM 扩展开关（表格 / 删除线 / 任务列表）。
///
/// 文档内容是 tiptap-markdown 产出的「Markdown 夹 HTML」混合体——管道表格、删除线、
/// 任务列表都可能出现，必须开启这些扩展，否则会被当成普通段落文本。
fn gfm_options(enable_math: bool) -> Options {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    if enable_math {
        opts.insert(Options::ENABLE_MATH);
    }
    opts
}

/// 原生回退路径里「HTML 块 → Markdown」递归展开的最大深度，防呆护栏：
/// 万一 html2md 产出仍含 raw HTML、再被 pulldown 当 HTML 块吐回来，
/// 到达深度上限后直接按纯文本落盘，杜绝无限递归。
const MAX_HTML_FLUSH_DEPTH: u32 = 4;

/// 原生 docx 的列表编号 ID（对应 `build_numberings` 里的 Numbering 实例）
pub(crate) const BULLET_NUM_ID: usize = 1;
pub(crate) const ORDERED_NUM_ID: usize = 2;

/// 原生 docx 的样式表。
///
/// docx-rs 默认只生成一个空的 Normal 样式；`Paragraph::style("Heading2")` 在
/// styles.xml 里找不到定义时，Word 会静默回退成正文 —— 标题没有字号/加粗/
/// 大纲级别，导航窗格与目录也看不到。这里显式补齐：
/// - Normal 默认 11pt（与编辑器 15px ≈ 11.25pt 对齐）
/// - Heading1–6：字号、加粗、outlineLvl（Word 导航/目录依赖它）
/// - Title：文档大标题
/// 字号单位是半磅（`sz`），21pt = 42。
fn build_styles(state: &RenderState) -> Styles {
    build_styles_for_fonts(state.body_font.as_deref(), state.heading_font.as_deref())
}

/// 与 [`build_styles`] 相同，但字体从参数传入 —— 结构化 JSON 渲染器没有
/// [`RenderState`]，直接复用它。
pub(crate) fn build_styles_for_fonts(
    body_font: Option<&str>,
    heading_font: Option<&str>,
) -> Styles {
    let mut styles = Styles::new().default_size(22); // 11pt
    if let Some(font) = body_font {
        styles = styles.default_fonts(
            RunFonts::new()
                .east_asia(font.to_string())
                .ascii(font.to_string()),
        );
    }

    // 与编辑器 15px 基准对应的标题字号：h1 21pt / h2 17pt / h3 14pt /
    // h4 12.5pt / h5 11pt / h6 10.5pt
    let heading_sizes = [42usize, 34, 28, 25, 22, 21];
    for (index, size) in heading_sizes.iter().enumerate() {
        let mut style = Style::new(format!("Heading{}", index + 1), StyleType::Paragraph)
            .name(format!("heading {}", index + 1))
            .based_on("Normal")
            .next("Normal")
            .q_format(true)
            .size(*size)
            .bold()
            .outline_lvl(index);
        if let Some(font) = heading_font {
            style = style.fonts(
                RunFonts::new()
                    .east_asia(font.to_string())
                    .ascii(font.to_string()),
            );
        }
        styles = styles.add_style(style);
    }

    let mut title = Style::new("Title", StyleType::Paragraph)
        .name("Title")
        .based_on("Normal")
        .next("Normal")
        .q_format(true)
        .size(48)
        .bold();
    if let Some(font) = heading_font {
        title = title.fonts(
            RunFonts::new()
                .east_asia(font.to_string())
                .ascii(font.to_string()),
        );
    }
    styles.add_style(title)
}

/// 原生 docx 的列表编号定义：bullet（numId=1）/ decimal（numId=2），各 3 级。
pub(crate) fn build_numberings() -> Numberings {
    let mut bullet = AbstractNumbering::new(0);
    let mut ordered = AbstractNumbering::new(1);
    let bullet_marks = ["•", "◦", "▪"];

    for level in 0..3usize {
        let indent = ((level as i32) + 1) * 360;
        bullet = bullet.add_level(
            Level::new(
                level,
                Start::new(1),
                NumberFormat::new("bullet"),
                LevelText::new(bullet_marks[level]),
                LevelJc::new("left"),
            )
            .indent(
                Some(indent),
                Some(SpecialIndentType::Hanging(360)),
                None,
                None,
            ),
        );
        ordered = ordered.add_level(
            Level::new(
                level,
                Start::new(1),
                NumberFormat::new("decimal"),
                LevelText::new(format!("%{}.", level + 1)),
                LevelJc::new("left"),
            )
            .indent(
                Some(indent),
                Some(SpecialIndentType::Hanging(360)),
                None,
                None,
            ),
        );
    }

    Numberings::new()
        .add_abstract_numbering(bullet)
        .add_numbering(Numbering::new(BULLET_NUM_ID, 0))
        .add_abstract_numbering(ordered)
        .add_numbering(Numbering::new(ORDERED_NUM_ID, 1))
}

/// 原生 docx 的表格边框：浅灰细线，与导出模板一致。
pub(crate) fn table_borders() -> TableBorders {
    TableBorders::new()
        .set(TableBorder::new(TableBorderPosition::Top).size(4).color("D0D7DE"))
        .set(TableBorder::new(TableBorderPosition::Left).size(4).color("D0D7DE"))
        .set(TableBorder::new(TableBorderPosition::Bottom).size(4).color("D0D7DE"))
        .set(TableBorder::new(TableBorderPosition::Right).size(4).color("D0D7DE"))
        .set(TableBorder::new(TableBorderPosition::InsideH).size(4).color("D0D7DE"))
        .set(TableBorder::new(TableBorderPosition::InsideV).size(4).color("D0D7DE"))
}

/// 创建一个带样式表与列表编号的 docx（原生两路共用）。
fn new_docx(state: &RenderState) -> Docx {
    Docx::new()
        .styles(build_styles(state))
        .numberings(build_numberings())
}

/// 导出结果
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordExportResult {
    pub file_path: String,
    pub images_embedded: usize,
    pub images_missing: usize,
    /// 拷贝到 `<docx 同名>.attachments/` 目录里的非图片附件数（docx 装不下任意文件，只能旁挂）
    pub attachments_copied: usize,
    /// 转换器路径中直接内嵌进 docx 的非图片附件数（data: 链接）
    pub attachments_inlined: usize,
    /// 实际使用的生成引擎：`structured`（编辑器 JSON 结构化渲染）/
    /// `converter`（本机 Office/WPS/LibreOffice）/ `native`（HTML/Markdown 兜底）
    pub engine: String,
}

pub struct WordExportService;

impl WordExportService {
    /// 导出单条文档为 .docx —— 尽力而为（hybrid）策略：
    ///
    /// 1. **优先走系统转换器**（LibreOffice / Word / WPS）：先用 `export_html` 把文档渲染成
    ///    自包含 HTML（表格/分栏/Callout/图片/样式全保真），再交给转换器转成 docx。保真度最高。
    /// 2. **无转换器或转换失败时回退到原生 docx 生成**（`export_single`）：纯 Rust、零外部依赖、
    ///    离线可用，但复杂结构（嵌套分栏/自定义样式）会被简化。
    ///
    /// 这样：装了 Office/WPS/LibreOffice 的机器拿到高保真结果，裸机也至少能把
    /// 文字 + 表格 + 图片 + 列表导出来，不再「只剩标题」。
    /// `body_html`：前端传来的**编辑器实时 DOM**（已内嵌资源）。转换器路径与
    /// 原生 HTML 回退都用它；传 None 走 markdown 重渲（批量导出等场景）。
    ///
    /// `body_json`：`editor.getJSON()` 的文档模型。**有它时优先走结构化渲染**
    /// （`export_word_json`），保留 callout / 分栏 / 代码块命名 / 表格列宽等语义；
    /// 结构化失败才回退转换器 / HTML。
    ///
    /// `heading_numbers`：与 JSON 里 heading 顺序一一对应的自动编号标签。
    ///
    /// `fonts`：用户在设置里选的正文 / 标题字体；结构化与转换器路径都会跟随。
    pub fn export_single_best_effort(
        title: &str,
        content: &str,
        target_path: &Path,
        assets_root: &Path,
        body_html: Option<&str>,
        body_json: Option<&serde_json::Value>,
        heading_numbers: Option<&[String]>,
        fonts: Option<&ExportFonts>,
    ) -> Result<WordExportResult, AppError> {
        // 1) 编辑器文档模型优先：结构化渲染保留 callout / 分栏 / 代码块命名 /
        //    表格列宽等语义，且不依赖本机是否安装 Office。
        if let Some(json) = body_json {
            match serde_json::from_value::<crate::services::export_word_json::PmNode>(
                json.clone(),
            ) {
                Ok(doc) => {
                    let numbers: &[String] = heading_numbers.unwrap_or(&[]);
                    match crate::services::export_word_json::export_single_from_json(
                        title,
                        &doc,
                        numbers,
                        target_path,
                        assets_root,
                        fonts,
                    ) {
                        Ok(result) => return Ok(result),
                        Err(e) => log::warn!(
                            "Word 导出：结构化 JSON 渲染失败，回退系统转换器 / HTML：{}",
                            e
                        ),
                    }
                }
                Err(e) => log::warn!(
                    "Word 导出：body_json 解析失败，回退系统转换器 / HTML：{}",
                    e
                ),
            }
        }

        // 2) 本机 Office / WPS / LibreOffice：HTML 模板转换（无 JSON 的场景）
        if converter::detect_converter() != DocConverter::None {
            match Self::export_via_converter(
                title,
                content,
                target_path,
                assets_root,
                body_html,
                fonts,
            ) {
                Ok(result) => return Ok(result),
                Err(e) => {
                    log::warn!("Word 导出：转换器路径失败，回退原生 docx 生成：{}", e);
                }
            }
        }
        // 裸机 / 转换器失败：有编辑器实时 DOM 就用它，否则退回 markdown 重渲。
        // 前者能保住只活在渲染层的内容（标题自动编号、mermaid 等）。
        match body_html {
            Some(html) if !html.trim().is_empty() => {
                Self::export_single_from_html_impl(html, target_path, assets_root, fonts)
            }
            _ => Self::export_single_impl(title, content, target_path, assets_root, fonts),
        }
    }

    /// 转换器路径：文档 → 自包含 HTML → 系统转换器 → docx → 拷到用户目标路径。
    fn export_via_converter(
        title: &str,
        content: &str,
        target_path: &Path,
        assets_root: &Path,
        body_html: Option<&str>,
        fonts: Option<&ExportFonts>,
    ) -> Result<WordExportResult, AppError> {
        // 有前端 DOM 就套模板直接用（保住标题编号等只存在于渲染层的东西），
        // 否则退回 markdown 重渲
        // TemplateLayout::Document：外层留白交给 @page 页边距，不让转换器把 body 的
        // margin/padding 翻译成正文外多余的段落间距（用户反馈的「首行上方 / 末行下方
        // 有一段消不掉的空白」）
        let (html, images_inlined, images_missing) = match body_html {
            Some(body) => HtmlExportService::render_html_from_body(
                title,
                body,
                assets_root,
                fonts,
                TemplateLayout::Document,
            ),
            None => HtmlExportService::render_html(
                title,
                content,
                assets_root,
                fonts,
                TemplateLayout::Document,
            )?,
        };
        // 附件链接也内嵌成 data: URL：否则 docx 里会留下 kb-asset:// 链接，换机器即失效。
        // inline_assets 会再跑一遍图片内嵌，对已是 data: 的资源是幂等的。
        let (html, _, attachments_inlined) = HtmlExportService::inline_assets(&html, assets_root);

        // 列表项内的 <p> 拍平：Word / WPS 会把 <li> 与其中的 <p> 当成两个段落，
        // 生成「空编号段 + 普通段」导致编号翻倍。前端 DOM 路径已拍平，这里兜底
        // markdown 重渲路径（松散列表会被 pulldown-cmark 输出成 <li><p>）。
        let html = flatten_list_item_paragraphs(&html);

        // 临时工作目录用纯 ASCII 路径与文件名，规避部分转换器对非 ASCII 路径的兼容问题
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmp_dir = std::env::temp_dir().join(format!("kb_word_export_{}", nanos));
        std::fs::create_dir_all(&tmp_dir)?;
        let tmp_html = tmp_dir.join("note.html");
        std::fs::write(&tmp_html, html.as_bytes())?;

        // HTML → docx（产物固定为 <tmp_dir>/note.docx）
        let convert_result = converter::convert_to_docx(&tmp_html, &tmp_dir);
        let produced = match convert_result {
            Ok(p) => p,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(e);
            }
        };

        // 拷到用户在 save dialog 选定的最终路径
        let copy_result = std::fs::copy(&produced, target_path);
        let _ = std::fs::remove_dir_all(&tmp_dir);
        copy_result.map_err(|e| AppError::Custom(format!("写 docx 失败: {}", e)))?;

        Ok(WordExportResult {
            file_path: target_path.to_string_lossy().into(),
            images_embedded: images_inlined,
            images_missing,
            // 转换器路径下图片与附件都已内嵌进 HTML/docx，无旁挂附件
            attachments_copied: 0,
            attachments_inlined,
            engine: "converter".to_string(),
        })
    }

    /// 原生 docx 生成（回退路径）：用 `pulldown-cmark` 解析「Markdown 夹 HTML」内容，
    /// 事件驱动地映射到 docx 元素。
    ///
    /// `assets_root` 是 kb_assets 目录的绝对路径（用于解析相对图片路径）；
    /// 不存在时所有非绝对路径图片都会算"缺失"。
    pub fn export_single(
        title: &str,
        markdown: &str,
        target_path: &Path,
        assets_root: &Path,
    ) -> Result<WordExportResult, AppError> {
        Self::export_single_impl(title, markdown, target_path, assets_root, None)
    }

    fn export_single_impl(
        title: &str,
        markdown: &str,
        target_path: &Path,
        assets_root: &Path,
        fonts: Option<&ExportFonts>,
    ) -> Result<WordExportResult, AppError> {
        let mut state = RenderState::new(assets_root.to_path_buf()).with_fonts(fonts);
        let mut docx = new_docx(&state);

        // 标题（Title 样式：24pt 加粗）
        if !title.is_empty() {
            let mut title_run = Run::new().add_text(title).size(48).bold();
            if let Some(family) = state.heading_font.clone() {
                title_run = title_run.fonts(
                    RunFonts::new().east_asia(family.clone()).ascii(family),
                );
            }
            docx = docx.add_paragraph(
                Paragraph::new().style("Title").add_run(title_run),
            );
        }


        // 走统一的事件驱动器：它会在遇到非 HTML 事件前先 flush 累积的 HTML 块
        drive_parser(markdown, &mut state, &mut docx)?;

        // flush 收尾：剩余 HTML 块 + 最后一个段落
        flush_html_buffer(&mut state, &mut docx)?;
        state.flush_paragraph(&mut docx);

        // ── 附件打包 ──
        // docx 容器塞不进任意文件，所以走"旁挂"：把文档里指向本地文件的链接对应的文件
        // 拷到 `<目标 docx 同名>.attachments/` 目录，并在文档末尾追加一个「📎 附件」清单
        // （写明每个附件在旁挂目录里的相对路径）。
        let attachments_copied = pack_attachments(markdown, target_path, assets_root, &mut docx)?;

        Self::write_docx(docx, target_path)?;

        Ok(WordExportResult {
            file_path: target_path.to_string_lossy().into(),
            images_embedded: state.images_embedded,
            images_missing: state.images_missing,
            attachments_copied,
            attachments_inlined: 0,
            engine: "native".to_string(),
        })
    }

    /// 原生回退路径的「编辑器实时 DOM」变体。
    ///
    /// 与 [`Self::export_single`] 的区别：内容来自前端渲染好的 HTML，而不是
    /// markdown 源码。这样标题自动编号、callout/分栏等只活在渲染层的内容不会丢。
    /// `body_html` 已包含文档标题（`editorDomToSelfContainedHtml` 负责插入），
    /// 这里不再追加 H1。
    pub fn export_single_from_html(
        body_html: &str,
        target_path: &Path,
        assets_root: &Path,
    ) -> Result<WordExportResult, AppError> {
        Self::export_single_from_html_impl(body_html, target_path, assets_root, None)
    }

    fn export_single_from_html_impl(
        body_html: &str,
        target_path: &Path,
        assets_root: &Path,
        fonts: Option<&ExportFonts>,
    ) -> Result<WordExportResult, AppError> {
        let mut state = RenderState::new(assets_root.to_path_buf()).with_fonts(fonts);
        let mut docx = new_docx(&state);
        state.html_buffer = body_html.to_string();
        flush_html_buffer(&mut state, &mut docx)?;
        state.flush_paragraph(&mut docx);

        // 附件旁挂：先还原成 markdown 再走统一的链接收集。
        let markdown = crate::services::markdown::html_to_markdown(body_html);
        let attachments_copied =
            pack_attachments(&markdown, target_path, assets_root, &mut docx)?;

        Self::write_docx(docx, target_path)?;

        Ok(WordExportResult {
            file_path: target_path.to_string_lossy().into(),
            images_embedded: state.images_embedded,
            images_missing: state.images_missing,
            attachments_copied,
            attachments_inlined: 0,
            engine: "native".to_string(),
        })
    }

    /// 把内存中的 docx 写盘（转换器/原生两路共用）。
    pub(crate) fn write_docx(docx: Docx, target_path: &Path) -> Result<(), AppError> {
        let file = std::fs::File::create(target_path)?;
        docx.build()
            .pack(file)
            .map_err(|e| AppError::Custom(format!("写 docx 失败: {}", e)))
    }
}

/// 渲染期累计状态：当前段落构造中的 runs + 样式开关 + 图片统计
struct RenderState {
    /// 当前段落正在累积的 runs
    pending_runs: Vec<Run>,
    /// inline 样式栈
    bold: u32,
    italic: u32,
    strikethrough: u32,
    code: u32,
    /// 链接 url（出现 Tag::Link 时压入；EndTag 时弹出）
    link_url: Option<String>,
    /// 标题级别（None = 普通段落）
    current_heading: Option<HeadingLevel>,
    /// 在代码块内
    in_code_block: bool,
    code_block_lang: String,
    code_block_content: String,
    /// 在引用内（Blockquote）
    in_blockquote: bool,
    /// 列表层级（嵌套深度）+ 当前是有序列表？
    list_stack: Vec<bool>,
    /// 表格状态
    in_table: bool,
    table_rows: Vec<TableRow>,
    current_row_cells: Vec<TableCell>,
    current_cell_text: String,

    /// 累积当前连续的 raw HTML 块（pulldown-cmark 可能把一段 HTML 拆成多个 Event::Html）。
    /// 遇到下一个非 HTML 事件时统一冲刷：html2md 转成 Markdown 后递归喂回解析器。
    html_buffer: String,
    /// HTML 块递归展开深度（防呆，配合 `MAX_HTML_FLUSH_DEPTH`）
    html_flush_depth: u32,

    /// 图片解析根
    assets_root: PathBuf,
    images_embedded: usize,
    images_missing: usize,

    /// 用户设置的正文字体（已从 CSS 栈里取出真实字体名）
    body_font: Option<String>,
    /// 用户设置的标题字体；未设置时跟随正文
    heading_font: Option<String>,
    /// 当前是否在表头行（加粗 + 浅灰底纹）
    in_table_head: bool,
}

impl RenderState {
    fn new(assets_root: PathBuf) -> Self {
        Self {
            pending_runs: Vec::new(),
            bold: 0,
            italic: 0,
            strikethrough: 0,
            code: 0,
            link_url: None,
            current_heading: None,
            in_code_block: false,
            code_block_lang: String::new(),
            code_block_content: String::new(),
            in_blockquote: false,
            list_stack: Vec::new(),
            in_table: false,
            table_rows: Vec::new(),
            current_row_cells: Vec::new(),
            current_cell_text: String::new(),
            html_buffer: String::new(),
            html_flush_depth: 0,
            assets_root,
            images_embedded: 0,
            images_missing: 0,
            body_font: None,
            heading_font: None,
            in_table_head: false,
        }
    }

    /// 应用用户设置的正文字体 / 标题字体（转换器路径走 CSS，不经过这里）。
    fn with_fonts(mut self, fonts: Option<&ExportFonts>) -> Self {
        self.body_font = primary_font_family(fonts.and_then(|f| f.body.as_deref()));
        self.heading_font = primary_font_family(fonts.and_then(|f| f.heading.as_deref()))
            .or_else(|| self.body_font.clone());
        self
    }

    /// 把"当前累积的 runs"打包成段落 push 到 docx
    fn flush_paragraph(&mut self, docx: &mut Docx) {
        if self.pending_runs.is_empty() {
            return;
        }
        let mut p = Paragraph::new();
        if let Some(level) = self.current_heading {
            let style = match level {
                HeadingLevel::H1 => "Heading1",
                HeadingLevel::H2 => "Heading2",
                HeadingLevel::H3 => "Heading3",
                HeadingLevel::H4 => "Heading4",
                HeadingLevel::H5 => "Heading5",
                HeadingLevel::H6 => "Heading6",
            };
            p = p.style(style);
        }
        if self.in_blockquote {
            // 引用：左缩进 + 左侧竖线 + 浅灰底（与导出模板一致）
            p = p.indent(Some(720), None, None, None);
            p.property = p
                .property
                .set_border(
                    ParagraphBorder::new(ParagraphBorderPosition::Left)
                        .size(18)
                        .color("D0D7DE")
                        .space(8),
                )
                .shading(Shading::new().fill("F6F8FA"));
        }
        // 列表：用 numbering.xml 的真编号（Word 自动处理序号与悬挂缩进）
        if let Some(&ordered) = self.list_stack.last() {
            let level = self.list_stack.len().saturating_sub(1);
            let num_id = if ordered { ORDERED_NUM_ID } else { BULLET_NUM_ID };
            p = p.numbering(NumberingId::new(num_id), IndentLevel::new(level));
        }
        for r in self.pending_runs.drain(..) {
            p = p.add_run(r);
        }
        let _ = std::mem::replace(&mut self.pending_runs, Vec::new());
        *docx = std::mem::take(docx).add_paragraph(p);
    }

    fn make_run(&self, text: &str) -> Run {
        let mut r = Run::new().add_text(text);
        // 用户字体：标题用标题字体，正文用正文字体；行内代码稍后覆盖为等宽。
        let font = if self.current_heading.is_some() {
            &self.heading_font
        } else {
            &self.body_font
        };
        if let Some(family) = font {
            r = r.fonts(RunFonts::new().east_asia(family.clone()).ascii(family.clone()));
        }
        if self.bold > 0 {
            r = r.bold();
        }
        if self.italic > 0 {
            r = r.italic();
        }
        if self.strikethrough > 0 {
            r = r.strike();
        }
        if self.in_blockquote {
            r = r.color("6b7280").italic();
        }
        if self.code > 0 {
            // 行内代码继承正文颜色，只加等宽字体 + 浅灰底纹（与编辑器一致）
            r = r
                .fonts(
                    RunFonts::new()
                        .east_asia("Cascadia Code")
                        .ascii("Cascadia Code"),
                )
                .size(20)
                .shading(Shading::new().fill("F6F8FA"));
        }
        if self.link_url.is_some() {
            r = r.color("0563c1").underline("single");
        }
        r
    }

    /// 公式 run：docx 暂不生成 OMML，保留 TeX 文本并用 Cambria Math 显示。
    fn make_math_run(&self, text: &str) -> Run {
        Run::new()
            .add_text(text)
            .fonts(RunFonts::new().east_asia("Cambria Math").ascii("Cambria Math"))
            .italic()
    }
}

/// 从 CSS `font-family` 栈里挑一个能写进 docx 的真实字体名。
///
/// 跳过 CSS 关键字与平台别名（`system-ui` / `-apple-system` / `BlinkMacSystemFont` 等），
/// 它们不是可写入 OOXML 的字体名。
pub(crate) fn primary_font_family(stack: Option<&str>) -> Option<String> {
    let stack = stack?.trim();
    for raw in stack.split(',') {
        let name = raw.trim().trim_matches('"').trim_matches('\'').trim();
        if name.is_empty() {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "system-ui"
                | "-apple-system"
                | "blinkmacsystemfont"
                | "sans-serif"
                | "serif"
                | "monospace"
                | "cursive"
                | "fantasy"
                | "ui-sans-serif"
                | "ui-serif"
                | "ui-monospace"
        ) {
            continue;
        }
        return Some(name.to_string());
    }
    None
}

/// 统一事件驱动器：解析 `markdown`（开 GFM 扩展），逐事件喂给 `handle_event`。
///
/// 关键点：在处理任何**非 HTML 事件**之前，先 flush 已累积的 HTML 块——保证
/// 「HTML 块里的内容」与「前后 Markdown 内容」在 docx 里的先后顺序正确。
fn drive_parser(markdown: &str, state: &mut RenderState, docx: &mut Docx) -> Result<(), AppError> {
    let enable_math = crate::services::markdown::math_is_safe(markdown);
    let parser = Parser::new_ext(markdown, gfm_options(enable_math));
    for event in parser {
        if !matches!(event, Event::Html(_)) {
            flush_html_buffer(state, docx)?;
        }
        handle_event(event, state, docx)?;
    }
    Ok(())
}

/// 冲刷累积的 raw HTML 块：html2md 转成 Markdown 后递归喂回 `drive_parser`，
/// 从而把表格 `<table>`、图片 `<figure><img>`、分栏 `<div data-type=columns>` 等
/// tiptap-markdown 退化成 HTML 的结构，重新还原成 docx 元素。
fn flush_html_buffer(state: &mut RenderState, docx: &mut Docx) -> Result<(), AppError> {
    if state.html_buffer.is_empty() {
        return Ok(());
    }
    let html = std::mem::take(&mut state.html_buffer);

    // 防呆：递归过深直接按纯文本落盘，杜绝 html2md ↔ pulldown 之间反复横跳
    if state.html_flush_depth >= MAX_HTML_FLUSH_DEPTH {
        let text = strip_html_tags(&html);
        if !text.trim().is_empty() {
            *docx = std::mem::take(docx)
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text(text)));
        }
        return Ok(());
    }

    let md = html_to_markdown(&html);
    if md.trim().is_empty() {
        // 纯标签（如孤立的 <span> / <br>）转换后为空，跳过即可（被包裹文本已另行渲染）
        return Ok(());
    }

    state.html_flush_depth += 1;
    drive_parser(&md, state, docx)?;
    flush_html_buffer(state, docx)?; // 排空本层递归过程中再次累积的 HTML
    state.flush_paragraph(docx);
    state.html_flush_depth -= 1;
    Ok(())
}

/// 把列表项开头的直接 `<p>…</p>` 拍平成 `<li>…`。
///
/// 与前端 `flattenListItemParagraphs` 同因：Word / WPS 的 HTML 导入器会把
/// `<li>` 翻译成一个**空的编号段落**，再把里面的 `<p>` 翻译成普通段落 ——
/// 4 项列表会显示成 1~8，文本还掉到编号下一行。
///
/// 前端实时 DOM 路径已经拍平；这里兜底 markdown 重渲路径：松散列表会被
/// pulldown-cmark 输出成 `<li>\n<p>…</p>\n</li>`。只处理**紧跟在 `<li>` 后**的
/// 第一个 `<p>`，嵌套列表与其他块结构保持原样；对已拍平的 HTML 是幂等的。
fn flatten_list_item_paragraphs(html: &str) -> String {
    let Ok(re) = regex::Regex::new(r"(?s)<li>\s*<p>(.*?)</p>") else {
        return html.to_string();
    };
    re.replace_all(html, "<li>${1}").into_owned()
}

/// 极简去标签：把 `<...>` 全部抹掉，仅保留可见文本。
/// 仅用于递归护栏触发时的兜底，正常路径不会走到。
fn strip_html_tags(html: &str) -> String {
    match regex::Regex::new(r"<[^>]+>") {
        Ok(re) => re.replace_all(html, "").trim().to_string(),
        Err(_) => html.to_string(),
    }
}

fn handle_event(event: Event, state: &mut RenderState, docx: &mut Docx) -> Result<(), AppError> {
    match event {
        // ── 段落 ──
        Event::Start(Tag::Paragraph) => {}
        Event::End(TagEnd::Paragraph) => {
            state.flush_paragraph(docx);
        }

        // ── 标题 ──
        Event::Start(Tag::Heading { level, .. }) => {
            state.current_heading = Some(level);
        }
        Event::End(TagEnd::Heading(_)) => {
            state.flush_paragraph(docx);
            state.current_heading = None;
        }

        // ── 文本 ──
        Event::Text(t) => {
            if state.in_code_block {
                state.code_block_content.push_str(&t);
            } else if state.in_table {
                state.current_cell_text.push_str(&t);
            } else {
                let run = state.make_run(&t);
                state.pending_runs.push(run);
            }
        }
        Event::Code(t) => {
            // 行内代码
            state.code += 1;
            let run = state.make_run(&t);
            state.pending_runs.push(run);
            state.code -= 1;
        }

        // ── 公式 ──
        // docx 暂不生成 OMML；保留 TeX 文本（Cambria Math 显示），避免公式被当普通正文丢弃。
        Event::InlineMath(t) => {
            let run = state.make_math_run(&t);
            state.pending_runs.push(run);
        }
        Event::DisplayMath(t) => {
            state.flush_paragraph(docx);
            let p = Paragraph::new()
                .align(AlignmentType::Center)
                .add_run(state.make_math_run(&t));
            *docx = std::mem::take(docx).add_paragraph(p);
        }

        // ── inline 样式 ──
        Event::Start(Tag::Strong) => state.bold += 1,
        Event::End(TagEnd::Strong) => {
            state.bold = state.bold.saturating_sub(1);
        }
        Event::Start(Tag::Emphasis) => state.italic += 1,
        Event::End(TagEnd::Emphasis) => {
            state.italic = state.italic.saturating_sub(1);
        }
        Event::Start(Tag::Strikethrough) => state.strikethrough += 1,
        Event::End(TagEnd::Strikethrough) => {
            state.strikethrough = state.strikethrough.saturating_sub(1);
        }
        Event::Start(Tag::Link { dest_url, .. }) => {
            state.link_url = Some(dest_url.into_string());
        }
        Event::End(TagEnd::Link) => {
            state.link_url = None;
        }

        // ── 代码块 ──
        Event::Start(Tag::CodeBlock(kind)) => {
            state.in_code_block = true;
            state.code_block_lang = match kind {
                CodeBlockKind::Fenced(lang) => lang.into_string(),
                CodeBlockKind::Indented => String::new(),
            };
            state.code_block_content.clear();
        }
        Event::End(TagEnd::CodeBlock) => {
            state.flush_paragraph(docx); // 先冲掉之前的内容
                                         // 每行一个段落；底纹放在**段落**上（整行浅灰），
                                         // Run 级 shading 只会在文字背后上色，看起来是断开的色块。
            let content = std::mem::take(&mut state.code_block_content);
            for line in content.lines() {
                let text = if line.is_empty() { " " } else { line };
                let mut p = Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text(text)
                            .fonts(
                                RunFonts::new()
                                    .east_asia("Cascadia Code")
                                    .ascii("Cascadia Code"),
                            )
                            .size(20),
                    )
                    .indent(Some(360), None, None, None)
                    .keep_lines(true);
                p.property = p.property.shading(Shading::new().fill("F6F8FA"));
                *docx = std::mem::take(docx).add_paragraph(p);
            }
            state.in_code_block = false;
        }

        // ── 引用 ──
        Event::Start(Tag::BlockQuote(_)) => {
            state.in_blockquote = true;
        }
        Event::End(TagEnd::BlockQuote(_)) => {
            state.in_blockquote = false;
        }

        // ── 列表 ──
        Event::Start(Tag::List(_start)) => {
            state.list_stack.push(_start.is_some());
        }
        Event::End(TagEnd::List(_)) => {
            state.list_stack.pop();
        }
        Event::Start(Tag::Item) => {}
        Event::End(TagEnd::Item) => {
            state.flush_paragraph(docx);
        }

        // ── 图片 ──
        Event::Start(Tag::Image {
            dest_url, title: _, ..
        }) => {
            // 先冲段落（避免图片插入与文本交错）
            state.flush_paragraph(docx);
            let url = dest_url.into_string();
            match resolve_image(&url, &state.assets_root) {
                Some(bytes) => {
                    // 读图片真实像素 → 按 A4 可用宽度等比缩放，保留原宽高比。
                    // 旧实现硬编码 4_000_000 × 3_000_000 EMU（4:3），导致竖图 / 16:9 横图被拉伸变形。
                    let (w_emu, h_emu) = compute_image_emu(&bytes);
                    let pic = Pic::new(&bytes).size(w_emu, h_emu);
                    let p = Paragraph::new().add_run(Run::new().add_image(pic));
                    *docx = std::mem::take(docx).add_paragraph(p);
                    state.images_embedded += 1;
                }
                None => {
                    // 缺失：插入占位文本
                    let p = Paragraph::new().add_run(
                        Run::new()
                            .add_text(format!("[图片缺失: {}]", url))
                            .italic()
                            .color("999999"),
                    );
                    *docx = std::mem::take(docx).add_paragraph(p);
                    state.images_missing += 1;
                }
            }
        }
        Event::End(TagEnd::Image) => {}

        // ── 表格（v1 简化：单元格只取纯文本） ──
        Event::Start(Tag::Table(_)) => {
            state.flush_paragraph(docx);
            state.in_table = true;
            state.in_table_head = false;
            state.table_rows = Vec::new();
        }
        Event::End(TagEnd::Table) => {
            if !state.table_rows.is_empty() {
                let rows = std::mem::take(&mut state.table_rows);
                let table = Table::new(rows).set_borders(table_borders());
                *docx = std::mem::take(docx).add_table(table);
                // 表格后插一个空段，避免下一个块紧贴表格底
                *docx = std::mem::take(docx).add_paragraph(Paragraph::new());
            }
            state.in_table = false;
            state.in_table_head = false;
        }
        Event::Start(Tag::TableHead) => {
            state.in_table_head = true;
            state.current_row_cells = Vec::new();
        }
        Event::End(TagEnd::TableHead) => {
            let cells = std::mem::take(&mut state.current_row_cells);
            if !cells.is_empty() {
                state.table_rows.push(TableRow::new(cells));
            }
            state.in_table_head = false;
        }
        Event::Start(Tag::TableRow) => {
            state.current_row_cells = Vec::new();
        }
        Event::End(TagEnd::TableRow) => {
            let cells = std::mem::take(&mut state.current_row_cells);
            if !cells.is_empty() {
                state.table_rows.push(TableRow::new(cells));
            }
        }
        Event::Start(Tag::TableCell) => {
            state.current_cell_text.clear();
        }
        Event::End(TagEnd::TableCell) => {
            let text = std::mem::take(&mut state.current_cell_text);
            let mut run = Run::new().add_text(text);
            if let Some(family) = &state.body_font {
                run = run.fonts(
                    RunFonts::new()
                        .east_asia(family.clone())
                        .ascii(family.clone()),
                );
            }
            if state.in_table_head {
                run = run.bold();
            }
            let mut para = Paragraph::new().add_run(run);
            if state.in_table_head {
                // 与编辑器 / 服务端模板保持一致：表头默认居中
                para = para.align(AlignmentType::Center);
            }
            let mut cell = TableCell::new().add_paragraph(para);
            if state.in_table_head {
                cell = cell.shading(Shading::new().fill("F2F2F2"));
            }
            state.current_row_cells.push(cell);
        }

        // ── 软换行 / 硬换行 ──
        Event::SoftBreak => {
            state.pending_runs.push(Run::new().add_text(" "));
        }
        Event::HardBreak => {
            state
                .pending_runs
                .push(Run::new().add_break(BreakType::TextWrapping));
        }

        // ── 水平线 ──
        Event::Rule => {
            state.flush_paragraph(docx);
            *docx = std::mem::take(docx)
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text("─".repeat(40))));
        }

        // ── raw HTML ──
        Event::Html(t) => {
            // 块级 HTML：先冲掉当前段落，再累积到 html_buffer，
            // 由 drive_parser/flush_html_buffer 统一交给 html2md 还原（表格/图片/分栏等）
            state.flush_paragraph(docx);
            state.html_buffer.push_str(&t);
        }
        Event::InlineHtml(_) => {
            // 内联 HTML 标签（如 <span> / </span>）：忽略标签本身，
            // 被它包裹的文本会以独立的 Event::Text 正常渲染，不丢内容
        }
        Event::FootnoteReference(_)
        | Event::Start(Tag::FootnoteDefinition(_))
        | Event::End(TagEnd::FootnoteDefinition) => {
            // v1 不支持脚注
        }
        Event::TaskListMarker(checked) => {
            // 任务列表 [x] / [ ] → 简单插入文本
            let mark = if checked { "☑ " } else { "☐ " };
            state.pending_runs.push(Run::new().add_text(mark));
        }
        // 其它块级标签默认不需要处理
        _ => {}
    }
    Ok(())
}

/// 解析图片 url 为字节
///
/// 支持：
/// - `data:image/...;base64,...` 内嵌
/// - `kb-asset://...` / `asset://localhost/...` / `file://...` / 绝对 / 相对路径
///   （统一交给 `asset_path::resolve_content_url`）
/// - 跳过 `http(s)://` 外链（避免迁移 docx 时拉外网）
pub(crate) fn resolve_image(url: &str, data_dir: &Path) -> Option<Vec<u8>> {
    // data: URL
    if let Some(stripped) = url.strip_prefix("data:") {
        if let Some(idx) = stripped.find(";base64,") {
            let b64 = &stripped[idx + 8..];
            return base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).ok();
        }
    }
    let abs = resolve_content_url(url, data_dir)?;
    std::fs::read(&abs).ok()
}

/// 96 DPI 下 1 像素对应的 EMU（English Metric Unit）值。
/// docx 里所有尺寸都用 EMU；1 inch = 914400 EMU，标准屏 96 DPI → 914400 / 96 = 9525。
const EMU_PER_PIXEL: u64 = 9525;

/// A4 纵向页面可用宽度上限（约 14.83 cm，预留左右各 2.5 cm 边距 + 一点余量）。
/// 超过这个宽度的图片按比例缩小到此宽度。
const MAX_WIDTH_EMU: u64 = 5_400_000;

/// 单张图片高度上限（约 23.7 cm），避免一张超高竖图独占整页打断阅读。
const MAX_HEIGHT_EMU: u64 = 8_640_000;

/// 默认尺寸：图片头解析失败时兜底用的"约 11×8.3 cm 4:3"——和旧硬编码一致，
/// 保证未知格式（SVG / TIFF / 损坏文件等）至少能塞进 docx 不崩。
const DEFAULT_W_EMU: u32 = 4_000_000;
const DEFAULT_H_EMU: u32 = 3_000_000;

/// 计算图片在 docx 中应使用的 (width, height) EMU 值。
///
/// 流程：读图片像素尺寸 → 按 96 DPI 转 EMU → 超过 MAX_WIDTH / MAX_HEIGHT 则等比缩。
/// 头解析失败时返回默认 4:3 矩形（兼容旧行为，避免崩）。
pub(crate) fn compute_image_emu(bytes: &[u8]) -> (u32, u32) {
    let Some((w_px, h_px)) = read_image_dimensions(bytes) else {
        return (DEFAULT_W_EMU, DEFAULT_H_EMU);
    };
    if w_px == 0 || h_px == 0 {
        return (DEFAULT_W_EMU, DEFAULT_H_EMU);
    }
    let mut w_emu = (w_px as u64) * EMU_PER_PIXEL;
    let mut h_emu = (h_px as u64) * EMU_PER_PIXEL;
    // 先按宽限制
    if w_emu > MAX_WIDTH_EMU {
        h_emu = h_emu * MAX_WIDTH_EMU / w_emu;
        w_emu = MAX_WIDTH_EMU;
    }
    // 再按高限制（窄长图）
    if h_emu > MAX_HEIGHT_EMU {
        w_emu = w_emu * MAX_HEIGHT_EMU / h_emu;
        h_emu = MAX_HEIGHT_EMU;
    }
    (w_emu as u32, h_emu as u32)
}

/// 按编辑器里拖拽后的 `width` / `height`（px）换算 EMU，仍受 A4 可用宽高上限约束。
/// 只给一个维度时按原图比例补另一个维度。
pub(crate) fn image_emu_for_attrs(
    bytes: &[u8],
    width_px: Option<u32>,
    height_px: Option<u32>,
) -> (u32, u32) {
    let orig = read_image_dimensions(bytes).filter(|(w, h)| *w > 0 && *h > 0);
    let (base_w, base_h) = match (width_px, height_px) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w as u64, h as u64),
        (Some(w), _) if w > 0 => match orig {
            Some((ow, oh)) => (w as u64, (w as u64) * oh as u64 / ow as u64),
            None => (w as u64, (w as u64) * 3 / 4),
        },
        (_, Some(h)) if h > 0 => match orig {
            Some((ow, oh)) => ((h as u64) * ow as u64 / oh as u64, h as u64),
            None => ((h as u64) * 4 / 3, h as u64),
        },
        _ => return compute_image_emu(bytes),
    };
    let mut w_emu = base_w * EMU_PER_PIXEL;
    let mut h_emu = base_h * EMU_PER_PIXEL;
    if w_emu > MAX_WIDTH_EMU {
        h_emu = h_emu * MAX_WIDTH_EMU / w_emu;
        w_emu = MAX_WIDTH_EMU;
    }
    if h_emu > MAX_HEIGHT_EMU {
        w_emu = w_emu * MAX_HEIGHT_EMU / h_emu;
        h_emu = MAX_HEIGHT_EMU;
    }
    (w_emu as u32, h_emu as u32)
}

/// 极简图片头解析：返回 (width_px, height_px)。
///
/// 仅识别 PNG / JPEG / GIF / BMP / WebP（覆盖编辑器里常见的所有格式）。
/// 不调用 image 解码 crate —— 只读 header 几十字节、零依赖、几乎零开销。
/// 不识别时返回 None，调用方走默认尺寸兜底。
pub(crate) fn read_image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 12 {
        return None;
    }

    // PNG: 8 字节签名 + 长度(4) + "IHDR"(4) + width(4 BE) + height(4 BE)
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        if bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
            let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
            let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
            return Some((w, h));
        }
        return None;
    }

    // GIF87a / GIF89a: 6 字节签名 + width(2 LE) + height(2 LE)
    if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) && bytes.len() >= 10 {
        let w = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32;
        let h = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32;
        return Some((w, h));
    }

    // BMP: "BM" 后 BITMAPINFOHEADER 在偏移 14 开始；width@18(4 LE) height@22(4 LE，可负=正向存储)
    if bytes.starts_with(b"BM") && bytes.len() >= 26 {
        let w = u32::from_le_bytes(bytes[18..22].try_into().ok()?);
        let h_signed = i32::from_le_bytes(bytes[22..26].try_into().ok()?);
        let h = h_signed.unsigned_abs();
        return Some((w, h));
    }

    // WebP: "RIFF????WEBP" + 子 chunk
    if bytes.starts_with(b"RIFF") && bytes.len() >= 30 && &bytes[8..12] == b"WEBP" {
        let chunk = &bytes[12..16];
        if chunk == b"VP8 " {
            // 有损 VP8：bytes[26..28] = width 14bit LE，bytes[28..30] = height 14bit LE
            let w = (u16::from_le_bytes(bytes[26..28].try_into().ok()?) & 0x3FFF) as u32;
            let h = (u16::from_le_bytes(bytes[28..30].try_into().ok()?) & 0x3FFF) as u32;
            return Some((w, h));
        }
        if chunk == b"VP8L" {
            // 无损 VP8L：signature 0x2F 后 4 字节里塞了两个 14-bit (w-1) (h-1)
            if bytes.len() >= 25 && bytes[20] == 0x2F {
                let b0 = bytes[21] as u32;
                let b1 = bytes[22] as u32;
                let b2 = bytes[23] as u32;
                let b3 = bytes[24] as u32;
                let w = (b0 | ((b1 & 0x3F) << 8)) + 1;
                let h = ((b1 >> 6) | (b2 << 2) | ((b3 & 0xF) << 10)) + 1;
                return Some((w, h));
            }
            return None;
        }
        if chunk == b"VP8X" {
            // 扩展 VP8X：bytes[24..27] = width-1 (3B LE), bytes[27..30] = height-1
            let w = ((bytes[24] as u32)
                | ((bytes[25] as u32) << 8)
                | ((bytes[26] as u32) << 16))
                + 1;
            let h = ((bytes[27] as u32)
                | ((bytes[28] as u32) << 8)
                | ((bytes[29] as u32) << 16))
                + 1;
            return Some((w, h));
        }
        return None;
    }

    // JPEG: SOI(0xFFD8) → 扫描各 segment 找 SOFn（含尺寸）
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2usize;
        while i + 1 < bytes.len() {
            // segment 必须以 0xFF 开头
            if bytes[i] != 0xFF {
                return None;
            }
            // 跳过填充 0xFF（标准允许多个 0xFF 串联）
            while i < bytes.len() && bytes[i] == 0xFF {
                i += 1;
            }
            if i >= bytes.len() {
                return None;
            }
            let marker = bytes[i];
            i += 1;
            // 无负载的 marker：RSTn(D0-D7) / SOI(D8) / EOI(D9) / TEM(01)
            if matches!(marker, 0xD0..=0xD9 | 0x01) {
                continue;
            }
            // SOFn (Start Of Frame，含尺寸)：0xC0-0xC3 / 0xC5-0xC7 / 0xC9-0xCB / 0xCD-0xCF
            // 排除 0xC4(DHT) / 0xC8(JPG) / 0xCC(DAC)
            if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
                // segment 内偏移：长度(2 BE) + 精度(1) + 高(2 BE) + 宽(2 BE)
                if i + 7 > bytes.len() {
                    return None;
                }
                let h = u16::from_be_bytes(bytes[i + 3..i + 5].try_into().ok()?) as u32;
                let w = u16::from_be_bytes(bytes[i + 5..i + 7].try_into().ok()?) as u32;
                return Some((w, h));
            }
            // 其他 segment：读长度（含自身 2 字节），跳过
            if i + 2 > bytes.len() {
                return None;
            }
            let seg_len = u16::from_be_bytes(bytes[i..i + 2].try_into().ok()?) as usize;
            if seg_len < 2 {
                return None;
            }
            i += seg_len;
        }
        return None;
    }

    None
}

/// 把 markdown 里指向本地文件的链接 `[label](url)` 对应的文件拷到 `<target>.attachments/`，
/// 并在 `docx` 末尾追加「📎 附件」清单段落。返回实际拷贝的附件数。
///
/// - 只处理能被 `resolve_content_url` 解析、且 `canonicalize()` 后真实存在的链接（图片走 `![]()`
///   不在此列）；外链 / mailto / 锚点都跳过。
/// - 同一物理文件多次出现只拷一份；同名不同源的自动加 `_1` / `_2` 后缀。
fn pack_attachments(
    markdown: &str,
    target_path: &Path,
    data_dir: &Path,
    docx: &mut Docx,
) -> Result<usize, AppError> {
    let links = collect_markdown_attachment_links(markdown, data_dir);
    pack_attachment_list(links, target_path, docx)
}

/// 用 pulldown-cmark 事件流收集 markdown 里的本地附件链接（图片不在此列）。
fn collect_markdown_attachment_links(
    markdown: &str,
    data_dir: &Path,
) -> Vec<(String, PathBuf)> {
    let mut links: Vec<(String, PathBuf)> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let parser = Parser::new(markdown);
    let mut cur: Option<(String, String)> = None; // (url, 累积文字)
    for ev in parser {
        match ev {
            Event::Start(Tag::Link { dest_url, .. }) => {
                cur = Some((dest_url.into_string(), String::new()));
            }
            Event::Text(t) => {
                if let Some((_, ref mut txt)) = cur {
                    txt.push_str(&t);
                }
            }
            Event::End(TagEnd::Link) => {
                if let Some((url, txt)) = cur.take() {
                    if let Some(abs) = resolve_content_url(&url, data_dir) {
                        if let Ok(canon) = abs.canonicalize() {
                            if canon.is_file() && seen.insert(canon.clone()) {
                                let label = if txt.trim().is_empty() {
                                    canon
                                        .file_name()
                                        .map(|n| n.to_string_lossy().into_owned())
                                        .unwrap_or_else(|| "附件".to_string())
                                } else {
                                    txt.trim().to_string()
                                };
                                links.push((label, canon));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    links
}

/// 把 `(label, 绝对路径)` 列表拷到 `<target>.attachments/`，并在文档末尾追加清单。
///
/// markdown 路径与结构化 JSON 路径共用（后者从 link mark 里收集同样的列表）。
pub(crate) fn pack_attachment_list(
    links: Vec<(String, PathBuf)>,
    target_path: &Path,
    docx: &mut Docx,
) -> Result<usize, AppError> {
    if links.is_empty() {
        return Ok(0);
    }

    // 拷贝到 <target 同级>/<stem>.attachments/
    let parent = target_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = target_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note");
    let att_dir_name = format!("{}.attachments", stem);
    let att_dir = parent.join(&att_dir_name);

    let mut taken: HashSet<String> = HashSet::new();
    let mut listed: Vec<(String, String)> = Vec::new(); // (label, 相对路径展示)
    for (label, abs) in links {
        let orig = abs
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "attachment".to_string());
        let unique = unique_attachment_name(&orig, &mut taken);
        if std::fs::create_dir_all(&att_dir).is_err() {
            continue;
        }
        if std::fs::copy(&abs, att_dir.join(&unique)).is_err() {
            continue;
        }
        listed.push((label, format!("{}/{}", att_dir_name, unique)));
    }
    if listed.is_empty() {
        return Ok(0);
    }

    // 3. 文档末尾追加「📎 附件」清单
    *docx = std::mem::take(docx)
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text("─".repeat(40))));
    *docx = std::mem::take(docx).add_paragraph(
        Paragraph::new()
            .style("Heading2")
            .add_run(Run::new().add_text("📎 附件").bold().size(28)),
    );
    for (label, rel) in &listed {
        *docx = std::mem::take(docx).add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(format!("• {}  →  {}", label, rel))),
        );
    }
    Ok(listed.len())
}

/// 附件文件名去重：首个直接用，再次出现加 `_1` / `_2` 后缀（保留扩展名）
fn unique_attachment_name(name: &str, taken: &mut HashSet<String>) -> String {
    if taken.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(p) => (&name[..p], &name[p..]),
        None => (name, ""),
    };
    for n in 1..10_000 {
        let candidate = format!("{}_{}{}", stem, n, ext);
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼一个最小 PNG header（8 字节签名 + IHDR）
    fn make_png(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&[0, 0, 0, 13]);
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v
    }

    /// 拼一个最小 JPEG：SOI + SOF0 segment（含尺寸）+ EOI
    fn make_jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        // SOF0: 0xFF 0xC0 长度(2 BE) 精度(1) 高(2 BE) 宽(2 BE) 通道(1) 通道描述符
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&w.to_be_bytes());
        v.push(0x03);
        v.extend_from_slice(&[0; 12]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    fn make_gif(w: u16, h: u16) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&h.to_le_bytes());
        v.extend_from_slice(&[0; 4]);
        v
    }

    fn make_bmp(w: u32, h: i32) -> Vec<u8> {
        let mut v = b"BM".to_vec();
        v.extend_from_slice(&[0; 16]);
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&h.to_le_bytes());
        v
    }

    #[test]
    fn read_dimensions_png() {
        assert_eq!(read_image_dimensions(&make_png(1920, 1080)), Some((1920, 1080)));
        assert_eq!(read_image_dimensions(&make_png(800, 600)), Some((800, 600)));
    }

    #[test]
    fn read_dimensions_jpeg() {
        assert_eq!(read_image_dimensions(&make_jpeg(1920, 1080)), Some((1920, 1080)));
        // 正方形（用户场景）：原图正方形不应该被压扁
        assert_eq!(read_image_dimensions(&make_jpeg(500, 500)), Some((500, 500)));
    }

    #[test]
    fn read_dimensions_jpeg_skips_unrelated_segments() {
        // SOI + APP0(JFIF) + SOF0 + EOI —— SOF0 不是紧跟 SOI，验证段跳过逻辑
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        v.extend_from_slice(&[0; 14]);
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&1024u16.to_be_bytes());
        v.extend_from_slice(&768u16.to_be_bytes());
        v.push(0x03);
        v.extend_from_slice(&[0; 12]);
        assert_eq!(read_image_dimensions(&v), Some((768, 1024)));
    }

    #[test]
    fn read_dimensions_gif() {
        assert_eq!(read_image_dimensions(&make_gif(640, 480)), Some((640, 480)));
    }

    #[test]
    fn read_dimensions_bmp_positive_height() {
        assert_eq!(read_image_dimensions(&make_bmp(800, 600)), Some((800, 600)));
    }

    #[test]
    fn read_dimensions_bmp_negative_height() {
        // BMP height 可负（表示行存储顺序），尺寸应取绝对值
        assert_eq!(read_image_dimensions(&make_bmp(800, -600)), Some((800, 600)));
    }

    #[test]
    fn read_dimensions_unknown_returns_none() {
        assert!(read_image_dimensions(b"not an image").is_none());
        assert!(read_image_dimensions(&[]).is_none());
        assert!(read_image_dimensions(&[0u8; 12]).is_none());
    }

    #[test]
    fn compute_emu_preserves_aspect_ratio_for_landscape() {
        // 1920×1080 横图：超宽，按宽缩到 MAX_WIDTH，高按比例
        let bytes = make_png(1920, 1080);
        let (w, h) = compute_image_emu(&bytes);
        assert_eq!(w as u64, MAX_WIDTH_EMU);
        let expected_h = (MAX_WIDTH_EMU * 1080 / 1920) as u32;
        assert_eq!(h, expected_h);
        let ratio_in = 1920.0_f64 / 1080.0;
        let ratio_out = w as f64 / h as f64;
        assert!((ratio_in - ratio_out).abs() < 0.01);
    }

    #[test]
    fn compute_emu_preserves_aspect_ratio_for_portrait() {
        // 1080×1920 竖图：旧实现会塞成 4:3 严重变形（这是用户报的 bug）
        let bytes = make_png(1080, 1920);
        let (w, h) = compute_image_emu(&bytes);
        // 1080×9525=10_287_000 EMU 超宽，先缩宽：w=5_400_000, h=5_400_000*1920/1080=9_600_000
        // 9_600_000 > MAX_HEIGHT_EMU(8_640_000)，再缩高：h=8_640_000, w=按比例
        assert_eq!(h as u64, MAX_HEIGHT_EMU);
        let ratio_in = 1080.0_f64 / 1920.0;
        let ratio_out = w as f64 / h as f64;
        assert!((ratio_in - ratio_out).abs() < 0.01);
    }

    #[test]
    fn compute_emu_preserves_aspect_ratio_for_square() {
        // 用户最敏感场景：500×500 正方形 → 必须保持正方形
        let bytes = make_png(500, 500);
        let (w, h) = compute_image_emu(&bytes);
        // 500×9525 = 4_762_500 < MAX_WIDTH_EMU(5_400_000)，不缩放
        assert_eq!(w, 500 * EMU_PER_PIXEL as u32);
        assert_eq!(h, 500 * EMU_PER_PIXEL as u32);
        assert_eq!(w, h);
    }

    #[test]
    fn compute_emu_small_image_no_upscale() {
        // 100×80 小图：不应被强制放大到固定尺寸（旧 bug 的对偶面）
        let bytes = make_png(100, 80);
        let (w, h) = compute_image_emu(&bytes);
        assert_eq!(w, 100 * EMU_PER_PIXEL as u32);
        assert_eq!(h, 80 * EMU_PER_PIXEL as u32);
    }

    #[test]
    fn compute_emu_unknown_format_falls_back_to_default() {
        // 未知格式 / 损坏头：兜底 4:3，至少能塞进去不崩
        let (w, h) = compute_image_emu(b"not an image");
        assert_eq!(w, DEFAULT_W_EMU);
        assert_eq!(h, DEFAULT_H_EMU);
    }

    #[test]
    fn compute_emu_zero_dimension_falls_back_to_default() {
        // 头里写着 0×0（异常但不该 div by zero）
        let bytes = make_png(0, 0);
        let (w, h) = compute_image_emu(&bytes);
        assert_eq!(w, DEFAULT_W_EMU);
        assert_eq!(h, DEFAULT_H_EMU);
    }

    /// 在临时目录里造一个唯一 .docx 路径
    fn tmp_docx(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kb_export_word_test_{}_{}.docx", tag, nanos))
    }

    /// 回归：WPS 会把 `<li><p>` 拆成「空编号段 + 普通段」，4 项列表变 1~8。
    /// 拍平后每个列表项只应保留一个段。
    #[test]
    fn flatten_li_paragraphs_fixes_double_numbering() {
        let html = "<ol>\n<li>\n<p>第一项</p>\n</li>\n<li><p>第二项</p></li>\n</ol>";
        let out = flatten_list_item_paragraphs(html);
        assert!(out.contains("<li>第一项"), "第一项应被拍平: {out}");
        assert!(out.contains("<li>第二项"), "第二项应被拍平: {out}");
        assert!(!out.contains("<li>\n<p>"), "不应残留 <li> 换行后的 <p>: {out}");
        assert!(!out.contains("<li><p>"), "不应残留紧邻的 <p>: {out}");
    }

    #[test]
    fn flatten_li_paragraphs_is_idempotent_and_keeps_nested_lists() {
        let flat = "<li>text</li>";
        assert_eq!(flatten_list_item_paragraphs(flat), flat);

        let nested = "<li>\n<p>父项</p>\n<ul>\n<li><p>子项</p></li>\n</ul>\n</li>";
        let out = flatten_list_item_paragraphs(nested);
        assert!(out.contains("<li>父项"));
        assert!(out.contains("<li>子项"));
        assert!(out.contains("<ul>"), "嵌套列表应保留");
    }

    /// 真实转换器链路（需要本机 Office / WPS / LibreOffice，默认忽略）：
    /// `<li><p>` 必须被拍平，否则 2 项列表会生成 4 个编号段（编号跳到 1~4）。
    /// 手动验证：`cargo test services::export_word::tests::converter_export_flattens_list -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机安装 Office / WPS / LibreOffice"]
    fn converter_export_flattens_list_items() {
        if converter::detect_converter() == DocConverter::None {
            eprintln!("未检测到转换器，跳过");
            return;
        }
        let assets = std::env::temp_dir();
        let body = "<ol><li><p>第一项</p></li><li><p>第二项</p></li></ol>";
        let target = tmp_docx("list_items");
        let result = WordExportService::export_single_best_effort(
            "标题",
            "",
            &target,
            &assets,
            Some(body),
            None,
            None,
            None,
        )
        .expect("列表导出应成功");
        assert_eq!(result.engine, "converter");

        let xml = docx_document_xml(&target);
        assert_eq!(
            xml.matches("<w:numPr>").count(),
            2,
            "每个列表项只应有一个编号段（实际可能被拆成空编号段 + 普通段）"
        );
        assert!(xml.contains("第一项") && xml.contains("第二项"));

        let _ = std::fs::remove_file(&target);
    }

    /// 在 styles.xml 里按样式名取 `w:sz`（半磅值）。
    fn style_size_half_points(styles: &str, name: &str) -> Option<u32> {
        let style_re = regex::Regex::new(r"(?s)<w:style [^>]*>.*?</w:style>").ok()?;
        let sz_re = regex::Regex::new(r#"<w:sz w:val="(\d+)""#).ok()?;
        for m in style_re.find_iter(styles) {
            let block = m.as_str();
            if block.contains(&format!(r#"w:name w:val="{}""#, name)) {
                return sz_re
                    .captures(block)?
                    .get(1)?
                    .as_str()
                    .parse::<u32>()
                    .ok();
            }
        }
        None
    }

    /// 真实转换器链路（需要本机 Office / WPS / LibreOffice，默认忽略）：
    /// 文档版式必须使用 pt 字号（正文 11pt / 代码 10pt），表头必须居中。
    /// 手动验证：`cargo test services::export_word::tests::converter_export_typography -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机安装 Office / WPS / LibreOffice"]
    fn converter_export_typography_and_header_alignment() {
        if converter::detect_converter() == DocConverter::None {
            eprintln!("未检测到转换器，跳过");
            return;
        }
        let assets = std::env::temp_dir();
        let body = r#"<div class="tiptap">
<p>正文段落，应导出为 11pt。</p>
<pre><code>let x = 1;</code></pre>
<table><tr><th>模式</th><th>行为</th></tr><tr><td>演示模式</td><td>自动切段</td></tr></table>
</div>"#;
        let target = tmp_docx("typography");
        WordExportService::export_single_best_effort(
            "标题",
            "",
            &target,
            &assets,
            Some(body),
            None,
            None,
            None,
        )
        .expect("导出应成功");

        let styles = docx_styles_xml(&target);
        assert_eq!(
            style_size_half_points(&styles, "Normal (Web)"),
            Some(22),
            "正文应为 11pt（w:sz=22），而不是 px 误映射出的 6pt"
        );
        assert_eq!(
            style_size_half_points(&styles, "HTML Preformatted"),
            Some(20),
            "代码块应为 10pt（w:sz=20），不能比正文还大"
        );

        let xml = docx_document_xml(&target);
        let pos = xml.find("模式").expect("表头文字应存在");
        let start = xml[..pos].rfind("<w:p ").expect("应能定位表头段落");
        let end = xml[pos..].find("</w:p>").map(|e| pos + e + 6).unwrap();
        assert!(
            xml[start..end].contains(r#"<w:jc w:val="center"/>"#),
            "表头应居中：{}",
            &xml[start..end]
        );

        let _ = std::fs::remove_file(&target);
    }

    /// 真实转换器链路（默认忽略）：前端归一化后的任务列表是
    /// `<div class="kb-task-list"><p class="kb-task-item">☑ <s>…</s></p>`。
    /// 这里锁住「不生成 bullet/编号」与「已完成项保留删除线」两个契约。
    #[test]
    #[ignore = "需要本机安装 Office / WPS / LibreOffice"]
    fn converter_export_normalized_task_list() {
        if converter::detect_converter() == DocConverter::None {
            eprintln!("未检测到转换器，跳过");
            return;
        }
        let assets = std::env::temp_dir();
        let body = r#"<div class="kb-task-list">
<p class="kb-task-item"><span class="kb-task-mark">☑ </span><s>已完成任务</s></p>
<p class="kb-task-item"><span class="kb-task-mark">☐ </span>未完成任务</p>
</div>"#;
        let target = tmp_docx("task_list");
        WordExportService::export_single_best_effort(
            "标题",
            "",
            &target,
            &assets,
            Some(body),
            None,
            None,
            None,
        )
        .expect("任务列表导出应成功");

        let xml = docx_document_xml(&target);
        assert!(
            !xml.contains("<w:numPr>"),
            "归一化后的任务项不应生成 bullet/编号"
        );
        assert!(
            xml.contains("<w:strike/>"),
            "已勾选任务应保留删除线（<s> → w:strike）"
        );
        let pos = xml.find("已完成任务").expect("任务文字应存在");
        let start = xml[..pos].rfind("<w:p ").expect("应能定位段落");
        let end = xml[pos..].find("</w:p>").map(|e| pos + e + 6).unwrap();
        assert!(
            xml[start..end].contains("☑"),
            "标记与文字应在同一段，而不是拆成多行"
        );

        let _ = std::fs::remove_file(&target);
    }

    /// 回归：tiptap 表格带列宽会序列化成 `<table>` HTML 块。
    /// 旧实现把所有 Event::Html 丢弃 → 表格内容全丢（用户报的「只剩标题」）。
    /// 现在原生路径应把 HTML 表格经 html2md 还原，文档体积明显大于纯标题。
    #[test]
    fn native_export_recovers_html_table() {
        let assets = std::env::temp_dir(); // 无图片，随便给个存在的目录
        let html_table = "<table><tr><th>项</th><th>值</th></tr>\
                          <tr><td>服务器</td><td>1.2.3.4</td></tr>\
                          <tr><td>协议</td><td>VLESS</td></tr></table>";

        let with_table = tmp_docx("with_table");
        WordExportService::export_single("标题", html_table, &with_table, &assets)
            .expect("含表格导出应成功");

        let title_only = tmp_docx("title_only");
        WordExportService::export_single("标题", "", &title_only, &assets)
            .expect("纯标题导出应成功");

        let table_len = std::fs::metadata(&with_table).unwrap().len();
        let title_len = std::fs::metadata(&title_only).unwrap().len();
        // 表格内容进入了 docx → 体积应显著大于纯标题文档
        assert!(
            table_len > title_len,
            "HTML 表格内容被丢弃了：with_table={} bytes, title_only={} bytes",
            table_len,
            title_len
        );

        let _ = std::fs::remove_file(&with_table);
        let _ = std::fs::remove_file(&title_only);
    }

    /// 回归：带尺寸/图注的图片会序列化成 `<figure><img src="data:...">`。
    /// 原生路径应把它经 html2md 还原成 `![](data:...)` 并把 base64 图片内嵌进 docx。
    #[test]
    fn native_export_embeds_html_figure_image() {
        // 真实可解码的 1×1 PNG（docx-rs 的 Pic::new 会真正解码图片，假 header 会 panic）
        let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
        let content = format!(
            "<figure><img src=\"data:image/png;base64,{}\" alt=\"图\"></figure>",
            b64
        );

        let assets = std::env::temp_dir();
        let target = tmp_docx("figure_img");
        let result = WordExportService::export_single("标题", &content, &target, &assets)
            .expect("含图片导出应成功");

        assert_eq!(
            result.images_embedded, 1,
            "data: URL 图片应被内嵌（embedded），实际 embedded={} missing={}",
            result.images_embedded, result.images_missing
        );
        let _ = std::fs::remove_file(&target);
    }

    /// 原生路径必须给 Heading2 真实样式定义（字号 + outlineLvl），否则 Word
    /// 找不到样式会回退正文，导航/目录里什么都没有。
    #[test]
    fn native_export_defines_heading_styles_with_outline() {
        let assets = std::env::temp_dir();
        let target = tmp_docx("heading_styles");
        WordExportService::export_single("标题", "## 小标题\n\n正文", &target, &assets)
            .expect("标题导出应成功");

        let styles = docx_styles_xml(&target);
        assert!(
            styles.contains(r#"w:styleId="Heading2""#),
            "styles.xml 应定义 Heading2"
        );
        assert!(
            styles.contains(r#"w:outlineLvl w:val="1""#),
            "Heading2 应带大纲级别，供导航/目录使用"
        );
        assert_eq!(
            style_size_half_points(&styles, "heading 2"),
            Some(34),
            "Heading2 应为 17pt（w:sz=34）"
        );

        let xml = docx_document_xml(&target);
        assert!(
            xml.contains(r#"w:pStyle w:val="Heading2""#),
            "正文标题段应引用 Heading2"
        );

        let _ = std::fs::remove_file(&target);
    }

    /// 原生列表必须用 numbering.xml 的真编号（Word 可自动续号/降级缩进），
    /// 而不是手写「• / 1.」前缀。
    #[test]
    fn native_export_lists_use_word_numbering() {
        let assets = std::env::temp_dir();
        let md = "- 苹果\n- 香蕉\n\n1. 第一\n2. 第二\n";
        let target = tmp_docx("numbering");
        WordExportService::export_single("标题", md, &target, &assets).expect("列表导出应成功");

        let xml = docx_document_xml(&target);
        assert_eq!(
            xml.matches("<w:numPr>").count(),
            4,
            "4 个列表项应各带一个 numPr"
        );
        assert!(xml.contains(r#"<w:numId w:val="1" />"#), "无序列表应使用 numId=1");
        assert!(xml.contains(r#"<w:numId w:val="2" />"#), "有序列表应使用 numId=2");
        assert!(!xml.contains("• "), "不应再手写 bullet 前缀");

        let numbering = docx_numbering_xml(&target);
        assert!(
            numbering.contains(r#"w:numFmt w:val="bullet""#),
            "numbering.xml 应包含 bullet 定义"
        );
        assert!(
            numbering.contains(r#"w:numFmt w:val="decimal""#),
            "numbering.xml 应包含 decimal 定义"
        );

        let _ = std::fs::remove_file(&target);
    }

    /// 代码块底纹必须落在段落属性 `pPr` 上，Word 才会整行铺灰；
    /// 写在 run 上只会在文字背后上色。
    #[test]
    fn native_export_code_block_uses_paragraph_shading() {
        let assets = std::env::temp_dir();
        let target = tmp_docx("code_shading");
        WordExportService::export_single("标题", "```rust\nlet x = 1;\n```\n", &target, &assets)
            .expect("代码块导出应成功");

        let xml = docx_document_xml(&target);
        let pos = xml.find("let x = 1;").expect("代码文字应存在");
        let start = xml[..pos].rfind("<w:p ").expect("应能定位代码段落");
        let end = xml[pos..].find("</w:p>").map(|e| pos + e + 6).unwrap();
        let para = &xml[start..end];
        let ppr_end = para.find("</w:pPr>").expect("段落应有 pPr");
        let ppr = &para[..ppr_end];
        assert!(ppr.contains("<w:shd"), "底纹应在段落属性上：{ppr}");
        assert!(ppr.contains("F6F8FA"), "代码块底纹应为 F6F8FA");
        assert!(para.contains(r#"<w:sz w:val="20""#), "代码字号应为 10pt");

        let _ = std::fs::remove_file(&target);
    }

    /// 「裸机」场景（既无 LibreOffice 也无 Word/WPS COM）：`export_single_best_effort`
    /// 会回退到本函数，且**只拿 markdown 重渲**——文档正文里的图片是 `kb-asset://<rel>`，
    /// 必须能顺着 assets_root 解析到真实文件并嵌进 docx。
    ///
    /// 这条路是纯 Rust、零外部依赖，是裸机唯一能出 Word 的通道，图片不能丢。
    #[test]
    fn native_export_embeds_kb_asset_image() {
        // 真实可解码的 1×1 PNG（Pic::new 会真正解码，假 header 会 panic）
        let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
        let png = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            b64,
        )
        .expect("测试用 base64 应可解码");

        // 造一个临时 data_dir，按真实布局放一张资产图
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("kb_word_bare_metal_{}", nanos));
        let img_dir = data_dir.join("kb_assets").join("images").join("1");
        std::fs::create_dir_all(&img_dir).unwrap();
        std::fs::write(img_dir.join("x.png"), &png).unwrap();

        // 文档正文里图片的真实形态
        let markdown = "正文一段\n\n![配图](kb-asset://kb_assets/images/1/x.png)\n";

        let target = tmp_docx("kb_asset_img");
        let result = WordExportService::export_single("标题", markdown, &target, &data_dir)
            .expect("裸机路径导出应成功");

        assert_eq!(
            result.images_embedded, 1,
            "kb-asset:// 图片应被嵌入，实际 embedded={} missing={}",
            result.images_embedded, result.images_missing
        );
        assert_eq!(result.images_missing, 0);

        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 读取 docx 里的 `word/document.xml`（断言正文内容用）
    fn docx_document_xml(path: &Path) -> String {
        use std::io::Read;
        let file = std::fs::File::open(path).expect("docx 应存在");
        let mut zip = zip::ZipArchive::new(file).expect("docx 应是 zip");
        let mut doc = zip.by_name("word/document.xml").expect("应包含 document.xml");
        let mut xml = String::new();
        doc.read_to_string(&mut xml).expect("读取 document.xml");
        xml
    }

    /// 读取 docx 里的 `word/styles.xml`（断言字号用）
    fn docx_styles_xml(path: &Path) -> String {
        use std::io::Read;
        let file = std::fs::File::open(path).expect("docx 应存在");
        let mut zip = zip::ZipArchive::new(file).expect("docx 应是 zip");
        let mut styles = zip.by_name("word/styles.xml").expect("应包含 styles.xml");
        let mut xml = String::new();
        styles.read_to_string(&mut xml).expect("读取 styles.xml");
        xml
    }

    /// 读取 docx 里的 `word/numbering.xml`（断言列表编号定义用）
    fn docx_numbering_xml(path: &Path) -> String {
        use std::io::Read;
        let file = std::fs::File::open(path).expect("docx 应存在");
        let mut zip = zip::ZipArchive::new(file).expect("docx 应是 zip");
        let mut numbering = zip
            .by_name("word/numbering.xml")
            .expect("应包含 numbering.xml");
        let mut xml = String::new();
        numbering
            .read_to_string(&mut xml)
            .expect("读取 numbering.xml");
        xml
    }

    /// 实时 DOM 形态的 HTML 走原生回退：标题自动编号与表格都不应丢失，
    /// 且结果标记为 native 引擎。
    #[test]
    fn native_export_from_body_html_preserves_rendered_content() {
        let assets = std::env::temp_dir();
        let body = r#"<div class="tiptap"><h1><span class="kb-hnum">1</span>研发与制造脱节</h1><p>正文 <strong>加粗重点</strong></p><table><tr><td>服务器</td><td>1.2.3.4</td></tr></table></div>"#;

        let target = tmp_docx("body_html");
        let result = WordExportService::export_single_from_html(body, &target, &assets)
            .expect("body HTML 导出应成功");

        assert_eq!(result.engine, "native");
        let xml = docx_document_xml(&target);
        assert!(xml.contains("研发与制造脱节"), "标题文字丢失: {xml}");
        assert!(xml.contains("加粗重点"), "正文文字丢失");
        assert!(xml.contains("服务器"), "表格内容丢失");

        let _ = std::fs::remove_file(&target);
    }

    /// 实时 DOM 里的图片已是 data: URL（前端已固化），原生回退必须直接内嵌。
    #[test]
    fn native_export_from_body_html_embeds_data_url_image() {
        let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
        let body = format!(
            r#"<div class="tiptap"><h1>图</h1><figure><img src="data:image/png;base64,{}" alt="图"></figure></div>"#,
            b64
        );

        let assets = std::env::temp_dir();
        let target = tmp_docx("body_html_img");
        let result = WordExportService::export_single_from_html(&body, &target, &assets)
            .expect("含 data URL 图片的 body HTML 导出应成功");

        assert_eq!(
            result.images_embedded, 1,
            "data: 图片应内嵌，实际 embedded={} missing={}",
            result.images_embedded, result.images_missing
        );
        assert_eq!(result.images_missing, 0);

        let _ = std::fs::remove_file(&target);
    }

    /// CSS font-family 栈里应挑出真实字体名，跳过平台别名与关键字。
    #[test]
    fn primary_font_family_skips_platform_aliases() {
        assert_eq!(
            primary_font_family(Some(
                r#"-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif"#
            )),
            Some("Segoe UI".to_string())
        );
        assert_eq!(
            primary_font_family(Some("'Noto Serif SC', serif")),
            Some("Noto Serif SC".to_string())
        );
        assert_eq!(primary_font_family(Some("system-ui, sans-serif")), None);
        assert_eq!(primary_font_family(None), None);
    }

    /// 原生路径也要跟随用户字体：正文 / 标题分别写进 rFonts。
    #[test]
    fn native_export_applies_user_fonts() {
        let assets = std::env::temp_dir();
        let fonts = ExportFonts {
            body: Some(r#""Microsoft YaHei", sans-serif"#.to_string()),
            heading: Some("'SimHei', sans-serif".to_string()),
        };
        let target = tmp_docx("fonts");
        WordExportService::export_single_impl(
            "文档标题",
            "## 小标题\n\n正文内容",
            &target,
            &assets,
            Some(&fonts),
        )
        .expect("字体导出应成功");

        let xml = docx_document_xml(&target);
        assert!(xml.contains("Microsoft YaHei"), "正文字体应写入 rFonts");
        assert!(xml.contains("SimHei"), "标题字体应写入 rFonts");

        let _ = std::fs::remove_file(&target);
    }

    /// 引用 / 代码块 / 表头的基础样式应真实写进 docx。
    #[test]
    fn native_export_styles_quote_code_and_table_header() {
        let assets = std::env::temp_dir();
        let md = "> 引用文字\n\n```rust\nlet x = 1;\n```\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n";
        let target = tmp_docx("styles");
        WordExportService::export_single("标题", md, &target, &assets).expect("样式导出应成功");

        let raw = docx_document_xml(&target);
        assert!(
            raw.contains("<w:tblBorders"),
            "表格应有完整边框"
        );
        assert!(raw.contains("D0D7DE"), "表格边框应为浅灰 D0D7DE");

        let xml = raw.to_lowercase();
        assert!(xml.contains("6b7280"), "引用应为灰色");
        assert!(xml.contains("f6f8fa"), "代码块应有浅灰底纹");
        assert!(xml.contains("f2f2f2"), "表头应有底纹");
        assert!(
            xml.contains(r#"w:jc w:val="center""#),
            "表头应与编辑器一致居中"
        );

        let _ = std::fs::remove_file(&target);
    }

    /// 公式不再被当普通正文：行内/块级 TeX 文本保留并标记 Cambria Math。
    #[test]
    fn native_export_keeps_math_text() {
        let assets = std::env::temp_dir();
        let md = "行内 $x^2$ 公式\n\n$$\n\\int_0^1 x dx\n$$\n";
        let target = tmp_docx("math");
        WordExportService::export_single("标题", md, &target, &assets).expect("公式导出应成功");

        let xml = docx_document_xml(&target);
        assert!(xml.contains("x^2"), "行内公式文本应保留");
        assert!(xml.contains("Cambria Math"), "公式应使用 Cambria Math");
        assert!(xml.contains("int_0^1"), "块级公式文本应保留");

        let _ = std::fs::remove_file(&target);
    }

    /// 货币写法不能被当成公式吞掉 $ 符号。
    #[test]
    fn native_export_keeps_currency_dollars() {
        let assets = std::env::temp_dir();
        let target = tmp_docx("currency");
        WordExportService::export_single(
            "价格",
            "价格$100元，原价$200元",
            &target,
            &assets,
        )
        .expect("货币文本导出应成功");

        let xml = docx_document_xml(&target);
        assert!(xml.contains("$100元"), "货币文本里的 $ 不应被当成公式吞掉");
        assert!(!xml.contains("Cambria Math"), "货币文本不应启用公式样式");

        let _ = std::fs::remove_file(&target);
    }

    /// 裸机路径下图片文件真的没了 → 计 missing 并留占位文本，导出本身**不能**失败
    /// （宁可少一张图，也不能让用户导不出来）。
    #[test]
    fn native_export_survives_missing_image() {
        let data_dir = std::env::temp_dir().join("kb_word_bare_metal_missing");
        std::fs::create_dir_all(&data_dir).unwrap();
        let markdown = "![丢了](kb-asset://kb_assets/images/9/nope.png)";

        let target = tmp_docx("kb_asset_missing");
        let result = WordExportService::export_single("标题", markdown, &target, &data_dir)
            .expect("图片缺失不应让导出失败");

        assert_eq!(result.images_embedded, 0);
        assert_eq!(result.images_missing, 1, "缺图应被如实统计出来");
        assert!(target.exists(), "docx 仍应产出");

        let _ = std::fs::remove_file(&target);
    }
}
