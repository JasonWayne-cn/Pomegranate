//! PDF 结构化抽取：按页内坐标提取文本段与位图图片。
//!
//! 与 `pdf.rs` 的纯文本兜底链互补：
//! - `pdf.rs` 负责「拿到文字」，兼容 CNKI / 损坏 xref / 扫描件判定；
//! - 本模块负责「拿到文字和图片的位置」，把图片按视觉顺序插回文本之间。
//!
//! 仅桌面端：依赖 PDFium。

#![cfg(desktop)]

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::Path;

use image::ImageFormat;
use pdfium_render::prelude::*;
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::services::pdf::{html_escape, normalize_text, with_pdfium};

/// 图片最小像素边长（整页扫描图不受此限制）。
const MIN_IMAGE_PIXELS: i32 = 32;
/// 图片相对页面面积低于该值时视为装饰性小图。
const MIN_BBOX_AREA_RATIO: f32 = 0.005;
/// 面积达到该比例的图片视为整页扫描图，放宽尺寸/过滤条件。
const FULL_PAGE_AREA_RATIO: f32 = 0.85;
/// 单张图片最大边长（超出等比缩小）。
const MAX_IMAGE_DIMENSION: u32 = 2000;
/// 单个 PDF 图片总字节上限。
const MAX_TOTAL_IMAGE_BYTES: usize = 100 * 1024 * 1024;
/// 极端长宽比视为分隔线/装饰条。
const MAX_ASPECT_RATIO: f32 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PdfBlockKind {
    Text,
    Image,
}

/// 页面内的一个内容块。`bbox` 是转换到「左上原点」后的视觉坐标。
#[derive(Debug, Clone)]
pub struct PdfBlock {
    pub page: u32,
    pub kind: PdfBlockKind,
    pub bbox: (f32, f32, f32, f32),
    pub text: Option<String>,
    pub image_index: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct PdfImage {
    pub page: u32,
    pub bbox: (f32, f32, f32, f32),
    pub width: u32,
    pub height: u32,
    pub png_bytes: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct PdfLayout {
    pub page_count: usize,
    pub text_chars: usize,
    pub blocks: Vec<PdfBlock>,
    pub images: Vec<PdfImage>,
    pub warnings: Vec<String>,
}

impl PdfLayout {
    /// 所有文本块按阅读顺序拼接（用于扫描件判定与纯文本回退）。
    pub fn plain_text(&self) -> String {
        self.blocks
            .iter()
            .filter_map(|block| block.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub struct PdfLayoutService;

impl PdfLayoutService {
    /// 结构化抽取 PDF。
    ///
    /// `max_images` 控制最多解码/保留多少张图片；传 0 时只抽文本。
    pub fn extract(source: &Path, max_images: usize) -> Result<PdfLayout, AppError> {
        Self::extract_desktop(source, max_images).map_err(AppError::Custom)
    }

    fn extract_desktop(source: &Path, max_images: usize) -> Result<PdfLayout, String> {
        with_pdfium(|pdfium| {
            let document = pdfium
                .load_pdf_from_file(source, None)
                .map_err(|e| format!("PDFium 打开 PDF 失败: {e}"))?;

            let page_count = document.pages().len() as usize;
            let mut blocks: Vec<PdfBlock> = Vec::new();
            let mut images: Vec<PdfImage> = Vec::new();
            let mut warnings: Vec<String> = Vec::new();
            let mut seen_hashes: HashSet<String> = HashSet::new();
            let mut total_image_bytes = 0usize;
            let max_images = max_images.min(500);
            let mut image_limit_warned = false;
            let mut total_limit_warned = false;

            for (page_index, page) in document.pages().iter().enumerate() {
                let page_number = page_index as u32 + 1;
                let page_width = page.width().value.max(1.0);
                let page_height = page.height().value.max(1.0);
                let page_area = page_width * page_height;

                // ── 文本段 ─────────────────────────────
                let text_page = page
                    .text()
                    .map_err(|e| format!("PDFium 读取第 {page_number} 页文本失败: {e}"))?;

                for segment in text_page.segments().iter() {
                    let text = normalize_text(&segment.text());
                    if text.is_empty() {
                        continue;
                    }
                    let bbox = visual_bbox(segment.bounds(), page_height);
                    if (bbox.2 - bbox.0).abs() < 0.1 || (bbox.3 - bbox.1).abs() < 0.1 {
                        continue;
                    }
                    blocks.push(PdfBlock {
                        page: page_number,
                        kind: PdfBlockKind::Text,
                        bbox,
                        text: Some(text),
                        image_index: None,
                    });
                }

                // ── 位图图片 ───────────────────────────
                if max_images == 0 || image_limit_warned || total_limit_warned {
                    continue;
                }

                for object in page.objects().iter() {
                    let Some(image_object) = object.as_image_object() else {
                        continue;
                    };

                    if images.len() >= max_images {
                        if !image_limit_warned {
                            warnings
                                .push(format!("图片数量超过上限 {max_images} 张，其余图片已跳过"));
                            image_limit_warned = true;
                        }
                        break;
                    }

                    let rect = match object.bounds() {
                        Ok(bounds) => bounds.to_rect(),
                        Err(e) => {
                            log::warn!("第 {page_number} 页图片边界读取失败，已跳过: {e}");
                            continue;
                        }
                    };
                    let bbox = visual_bbox(rect, page_height);
                    let width_px = image_object.width().unwrap_or(0);
                    let height_px = image_object.height().unwrap_or(0);
                    let bbox_area = ((bbox.2 - bbox.0) * (bbox.3 - bbox.1)).max(0.0);
                    let area_ratio = bbox_area / page_area;

                    if !should_keep_image(width_px, height_px, area_ratio) {
                        continue;
                    }

                    let raw = match image_object.get_raw_image() {
                        Ok(image) => image,
                        Err(e) => {
                            log::warn!("第 {page_number} 页图片解码失败，已跳过: {e}");
                            continue;
                        }
                    };

                    let raw = if raw.width() > MAX_IMAGE_DIMENSION
                        || raw.height() > MAX_IMAGE_DIMENSION
                    {
                        raw.thumbnail(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION)
                    } else {
                        raw
                    };

                    let mut png_bytes = Vec::new();
                    if let Err(e) = raw.write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
                    {
                        log::warn!("第 {page_number} 页图片转 PNG 失败，已跳过: {e}");
                        continue;
                    }

                    let hash = sha256_hex(&png_bytes);
                    if !seen_hashes.insert(hash) {
                        continue;
                    }

                    if total_image_bytes + png_bytes.len() > MAX_TOTAL_IMAGE_BYTES {
                        if !total_limit_warned {
                            warnings.push("图片总大小超过 100 MB，其余图片已跳过".to_string());
                            total_limit_warned = true;
                        }
                        break;
                    }
                    total_image_bytes += png_bytes.len();

                    let image_index = images.len();
                    images.push(PdfImage {
                        page: page_number,
                        bbox,
                        width: raw.width(),
                        height: raw.height(),
                        png_bytes,
                    });
                    blocks.push(PdfBlock {
                        page: page_number,
                        kind: PdfBlockKind::Image,
                        bbox,
                        text: None,
                        image_index: Some(image_index),
                    });
                }
            }

            let blocks = order_blocks_for_reading(blocks);
            let blocks = merge_text_blocks(blocks);
            let text_chars = blocks
                .iter()
                .filter_map(|block| block.text.as_ref())
                .map(|text| text.chars().count())
                .sum();

            Ok(PdfLayout {
                page_count,
                text_chars,
                blocks,
                images,
                warnings,
            })
        })
    }

    /// 把文本块与图片块按顺序渲染成文档 HTML。
    ///
    /// `image_paths` 的 key 是 `PdfImage` 在 `layout.images` 中的下标，
    /// value 是相对 `data_dir` 的 POSIX 路径（不含 `kb-asset://`）。
    pub fn render_html(layout: &PdfLayout, image_paths: &HashMap<usize, String>) -> String {
        let mut out = String::new();
        let mut last_page = 0u32;

        for block in &layout.blocks {
            if block.page != last_page {
                if last_page != 0 {
                    out.push_str(&format!("<hr data-pdf-page=\"{}\" />\n", block.page));
                }
                last_page = block.page;
            }

            match block.kind {
                PdfBlockKind::Text => {
                    if let Some(text) = block.text.as_deref() {
                        let escaped = html_escape(text).replace('\n', "<br/>");
                        out.push_str("<p>");
                        out.push_str(&escaped);
                        out.push_str("</p>\n");
                    }
                }
                PdfBlockKind::Image => {
                    if let Some(index) = block.image_index {
                        if let Some(rel) = image_paths.get(&index) {
                            out.push_str(&format!(
                                "<img src=\"kb-asset://{}\" alt=\"第 {} 页图片\" />\n",
                                rel, block.page
                            ));
                        }
                    }
                }
            }
        }

        out.trim().to_string()
    }
}

/// 把 PDFium 的「左下原点」坐标转换为「左上原点」的视觉坐标。
fn visual_bbox(rect: PdfRect, page_height: f32) -> (f32, f32, f32, f32) {
    let left = rect.left().value.min(rect.right().value);
    let right = rect.left().value.max(rect.right().value);
    let top = (page_height - rect.top().value).min(page_height - rect.bottom().value);
    let bottom = (page_height - rect.top().value).max(page_height - rect.bottom().value);
    (left, top, right, bottom)
}

/// 图片过滤：小图标、低面积装饰图、极端长宽比；整页扫描图放行。
fn should_keep_image(width_px: i32, height_px: i32, area_ratio: f32) -> bool {
    let full_page = area_ratio >= FULL_PAGE_AREA_RATIO;
    if !full_page && (width_px < MIN_IMAGE_PIXELS || height_px < MIN_IMAGE_PIXELS) {
        return false;
    }
    if !full_page && area_ratio < MIN_BBOX_AREA_RATIO {
        return false;
    }
    if !full_page {
        let max_side = width_px.max(height_px) as f32;
        let min_side = width_px.min(height_px).max(1) as f32;
        if max_side / min_side > MAX_ASPECT_RATIO {
            return false;
        }
    }
    true
}

/// 按阅读顺序排列：先按页面/行中心排序，再把同一视觉行内的文本段按 x 排序。
///
/// PDFium 的字符级文本段 y 坐标常有零点几磅的抖动，直接 `y -> x` 排序会把
/// 同一行字符打乱（例如 "行/南/指/机场运"）。这里先聚成行带，再在行内按 x 排列。
fn order_blocks_for_reading(mut blocks: Vec<PdfBlock>) -> Vec<PdfBlock> {
    blocks.sort_by(|a, b| {
        a.page
            .cmp(&b.page)
            .then_with(|| {
                block_center_y(a)
                    .partial_cmp(&block_center_y(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| {
                a.bbox
                    .0
                    .partial_cmp(&b.bbox.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut ordered = Vec::with_capacity(blocks.len());
    let mut index = 0;

    while index < blocks.len() {
        let page = blocks[index].page;
        if blocks[index].kind != PdfBlockKind::Text {
            ordered.push(blocks[index].clone());
            index += 1;
            continue;
        }

        let mut end = index + 1;
        let mut band_center = block_center_y(&blocks[index]);
        let mut band_height = block_height(&blocks[index]);

        while end < blocks.len()
            && blocks[end].page == page
            && blocks[end].kind == PdfBlockKind::Text
        {
            let center = block_center_y(&blocks[end]);
            let height = block_height(&blocks[end]);
            if (center - band_center).abs() <= 0.5 * band_height.max(height) {
                let count = (end - index) as f32;
                band_center = (band_center * count + center) / (count + 1.0);
                band_height = band_height.max(height);
                end += 1;
            } else {
                break;
            }
        }

        let mut band = blocks[index..end].to_vec();
        band.sort_by(|a, b| {
            a.bbox
                .0
                .partial_cmp(&b.bbox.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        ordered.extend(band);
        index = end;
    }

    ordered
}

fn block_height(block: &PdfBlock) -> f32 {
    (block.bbox.3 - block.bbox.1).abs().max(1.0)
}

fn block_center_y(block: &PdfBlock) -> f32 {
    (block.bbox.1 + block.bbox.3) * 0.5
}

/// 合并文本段：
/// 1. 先合并同一视觉行内水平相邻的字符/单词段；
/// 2. 再把同一栏内垂直间距很小的相邻行合并成段落。
fn merge_text_blocks(blocks: Vec<PdfBlock>) -> Vec<PdfBlock> {
    let mut merged: Vec<PdfBlock> = Vec::with_capacity(blocks.len());

    for block in blocks {
        let can_merge = matches!(merged.last(), Some(prev)
            if prev.page == block.page
                && prev.kind == PdfBlockKind::Text
                && block.kind == PdfBlockKind::Text);

        if !can_merge {
            merged.push(block);
            continue;
        }

        let prev = merged.last_mut().expect("checked above");
        let prev_height = (prev.bbox.3 - prev.bbox.1).abs().max(1.0);
        let next_height = (block.bbox.3 - block.bbox.1).abs().max(1.0);
        let line_height = prev_height.max(next_height);
        let min_height = prev_height.min(next_height);

        let vertical_overlap =
            (prev.bbox.3.min(block.bbox.3) - prev.bbox.1.max(block.bbox.1)).max(0.0);
        let horizontal_gap = block.bbox.0 - prev.bbox.2;

        // 同一行：垂直投影重叠足够，且水平间距不超过半个行高。
        let same_line = vertical_overlap / min_height >= 0.5
            && horizontal_gap <= 0.8 * line_height
            && horizontal_gap >= -line_height;

        if same_line {
            let joined = join_inline_text(
                prev.text.as_deref().unwrap_or(""),
                block.text.as_deref().unwrap_or(""),
                horizontal_gap,
                line_height,
            );
            prev.text = Some(joined);
            prev.bbox.0 = prev.bbox.0.min(block.bbox.0);
            prev.bbox.1 = prev.bbox.1.min(block.bbox.1);
            prev.bbox.2 = prev.bbox.2.max(block.bbox.2);
            prev.bbox.3 = prev.bbox.3.max(block.bbox.3);
            continue;
        }

        // 下一行：垂直间距小且水平方向有足够重叠，视为同一段落。
        let vertical_gap = block.bbox.1 - prev.bbox.3;
        let horizontal_overlap =
            (prev.bbox.2.min(block.bbox.2) - prev.bbox.0.max(block.bbox.0)).max(0.0);
        let min_width = (prev.bbox.2 - prev.bbox.0)
            .min(block.bbox.2 - block.bbox.0)
            .max(1.0);

        if vertical_gap <= 0.6 * line_height && horizontal_overlap / min_width >= 0.3 {
            let joined = join_wrapped_text(
                prev.text.as_deref().unwrap_or(""),
                block.text.as_deref().unwrap_or(""),
            );
            prev.text = Some(joined);
            prev.bbox.0 = prev.bbox.0.min(block.bbox.0);
            prev.bbox.1 = prev.bbox.1.min(block.bbox.1);
            prev.bbox.2 = prev.bbox.2.max(block.bbox.2);
            prev.bbox.3 = prev.bbox.3.max(block.bbox.3);
        } else {
            merged.push(block);
        }
    }

    merged
}

/// 拼接同一行内的相邻文本段。英文单词之间按间距补空格，中文直接相连。
fn join_inline_text(head: &str, tail: &str, horizontal_gap: f32, line_height: f32) -> String {
    if head.is_empty() {
        return tail.to_string();
    }
    if tail.is_empty() {
        return head.to_string();
    }
    if head.ends_with(char::is_whitespace) || tail.starts_with(char::is_whitespace) {
        return format!("{head}{tail}");
    }

    let head_last = head.chars().last().unwrap_or(' ');
    let tail_first = tail.chars().next().unwrap_or(' ');

    if is_cjk(head_last) || is_cjk(tail_first) {
        return format!("{head}{tail}");
    }

    // PDFium 常把 "C919" / "2025" 拆成多个段。数字之间的间距往往只是窄字形
    // 的侧边距，直接相连；数字与字母相邻且间距较小时也视作字距。
    let digit_boundary = head_last.is_ascii_digit() && tail_first.is_ascii_digit();
    let mixed_alnum_boundary = head_last.is_alphanumeric()
        && tail_first.is_alphanumeric()
        && (head_last.is_ascii_digit() || tail_first.is_ascii_digit());
    // 章节号 "1 . 1"：数字与标点交替时不要插空格。
    let numeric_punctuation = (head_last.is_ascii_digit() && tail_first.is_ascii_punctuation())
        || (head_last.is_ascii_punctuation() && tail_first.is_ascii_digit());

    if digit_boundary
        || (mixed_alnum_boundary && horizontal_gap <= 0.35 * line_height)
        || (numeric_punctuation && horizontal_gap <= 0.35 * line_height)
    {
        format!("{head}{tail}")
    } else if horizontal_gap > 0.12 * line_height {
        format!("{head} {tail}")
    } else {
        format!("{head}{tail}")
    }
}

/// 拼接被 PDF 换行拆开的文本：中日韩字符之间不加空格。
fn join_wrapped_text(head: &str, tail: &str) -> String {
    if head.is_empty() {
        return tail.to_string();
    }
    if tail.is_empty() {
        return head.to_string();
    }
    if head.ends_with(char::is_whitespace) || tail.starts_with(char::is_whitespace) {
        return format!("{head}{tail}");
    }

    let head_last = head.chars().last().unwrap_or(' ');
    let tail_first = tail.chars().next().unwrap_or(' ');

    if head.ends_with('-') || is_cjk(head_last) || is_cjk(tail_first) {
        format!("{head}{tail}")
    } else {
        format!("{head} {tail}")
    }
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3000..=0x303F
            | 0x3040..=0x30FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xAC00..=0xD7AF
            | 0xF900..=0xFAFF
            | 0xFF00..=0xFFEF
    )
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_block(page: u32, bbox: (f32, f32, f32, f32), text: &str) -> PdfBlock {
        PdfBlock {
            page,
            kind: PdfBlockKind::Text,
            bbox,
            text: Some(text.to_string()),
            image_index: None,
        }
    }

    #[test]
    fn visual_bbox_flips_y_axis() {
        let rect = PdfRect::new_from_values(20.0, 10.0, 80.0, 100.0);
        let bbox = visual_bbox(rect, 200.0);
        assert_eq!(bbox, (10.0, 120.0, 100.0, 180.0));
    }

    #[test]
    fn filters_tiny_and_decorative_images() {
        assert!(!should_keep_image(10, 10, 0.1));
        assert!(!should_keep_image(100, 100, 0.001));
        assert!(should_keep_image(100, 100, 0.05));
        // 整页扫描图即使像素尺寸偏小也放行
        assert!(should_keep_image(20, 20, 0.95));
    }

    #[test]
    fn merges_adjacent_text_blocks_on_same_page() {
        let blocks = vec![
            text_block(1, (10.0, 10.0, 200.0, 22.0), "第一行"),
            text_block(1, (10.0, 23.0, 200.0, 35.0), "第二行"),
            text_block(1, (10.0, 200.0, 200.0, 212.0), "远处段落"),
        ];
        let merged = merge_text_blocks(blocks);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].text.as_deref(), Some("第一行第二行"));
        assert_eq!(merged[1].text.as_deref(), Some("远处段落"));
    }

    #[test]
    fn merges_horizontally_adjacent_character_segments() {
        let blocks = vec![
            text_block(1, (10.0, 10.0, 20.0, 22.0), "C"),
            text_block(1, (20.0, 10.0, 30.0, 22.0), "9"),
            text_block(1, (30.0, 10.0, 40.0, 22.0), "1"),
            text_block(1, (40.0, 10.0, 50.0, 22.0), "9"),
        ];
        let merged = merge_text_blocks(blocks);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text.as_deref(), Some("C919"));
    }

    #[test]
    fn keeps_alphanumeric_kerning_together() {
        let blocks = vec![
            text_block(1, (10.0, 10.0, 30.0, 28.0), "C9"),
            text_block(1, (33.8, 10.0, 39.0, 28.0), "1"),
            text_block(1, (42.8, 10.0, 54.0, 28.0), "9"),
        ];
        let merged = merge_text_blocks(blocks);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text.as_deref(), Some("C919"));
    }

    #[test]
    fn joins_numeric_section_punctuation_without_space() {
        let blocks = vec![
            text_block(1, (10.0, 10.0, 16.0, 28.0), "1"),
            text_block(1, (19.0, 10.0, 22.0, 28.0), "."),
            text_block(1, (25.0, 10.0, 31.0, 28.0), "1"),
        ];
        let merged = merge_text_blocks(blocks);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text.as_deref(), Some("1.1"));
    }

    #[test]
    fn orders_jittered_same_line_blocks_by_x_before_merging() {
        let blocks = vec![
            text_block(1, (306.9, 350.8, 329.1, 373.4), "行"),
            text_block(1, (355.5, 350.9, 376.5, 373.2), "南"),
            text_block(1, (330.8, 351.4, 352.6, 373.2), "指"),
            text_block(1, (234.7, 351.5, 304.6, 373.2), "机场运"),
        ];
        let merged = merge_text_blocks(order_blocks_for_reading(blocks));
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text.as_deref(), Some("机场运行指南"));
    }

    #[test]
    fn joins_english_word_segments_with_space() {
        let blocks = vec![
            text_block(1, (10.0, 10.0, 50.0, 22.0), "Hello"),
            text_block(1, (53.0, 10.0, 93.0, 22.0), "world"),
        ];
        let merged = merge_text_blocks(blocks);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text.as_deref(), Some("Hello world"));
    }

    #[test]
    fn does_not_merge_across_pages() {
        let blocks = vec![
            text_block(1, (10.0, 10.0, 200.0, 22.0), "第一页"),
            text_block(2, (10.0, 10.0, 200.0, 22.0), "第二页"),
        ];
        let merged = merge_text_blocks(blocks);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn render_html_interleaves_text_and_images() {
        let layout = PdfLayout {
            page_count: 1,
            text_chars: 4,
            blocks: vec![
                text_block(1, (10.0, 10.0, 200.0, 22.0), "前文"),
                PdfBlock {
                    page: 1,
                    kind: PdfBlockKind::Image,
                    bbox: (10.0, 30.0, 200.0, 120.0),
                    text: None,
                    image_index: Some(0),
                },
                text_block(1, (10.0, 130.0, 200.0, 142.0), "后文"),
            ],
            images: vec![PdfImage {
                page: 1,
                bbox: (10.0, 30.0, 200.0, 120.0),
                width: 100,
                height: 100,
                png_bytes: Vec::new(),
            }],
            warnings: Vec::new(),
        };
        let mut paths = HashMap::new();
        paths.insert(0, "kb_assets/images/1/pdf-p0001-000.png".to_string());
        let html = PdfLayoutService::render_html(&layout, &paths);
        assert!(html.find("前文").unwrap() < html.find("<img").unwrap());
        assert!(html.find("<img").unwrap() < html.find("后文").unwrap());
        assert!(html.contains("kb-asset://kb_assets/images/1/pdf-p0001-000.png"));
    }

    #[test]
    fn render_html_escapes_text_and_adds_page_break() {
        let layout = PdfLayout {
            page_count: 2,
            text_chars: 8,
            blocks: vec![
                text_block(1, (10.0, 10.0, 200.0, 22.0), "<A&B>"),
                text_block(2, (10.0, 10.0, 200.0, 22.0), "第二页"),
            ],
            images: Vec::new(),
            warnings: Vec::new(),
        };
        let html = PdfLayoutService::render_html(&layout, &HashMap::new());
        assert!(html.contains("&lt;A&amp;B&gt;"));
        assert!(html.contains("data-pdf-page=\"2\""));
    }

    #[test]
    fn join_wrapped_text_keeps_cjk_together() {
        assert_eq!(join_wrapped_text("中文", "换行"), "中文换行");
        assert_eq!(join_wrapped_text("hello", "world"), "hello world");
    }

    /// 用最小合法 PDF 验证 PDFium 文本段抽取通路。
    /// PDFium 不可用（例如未带 dll 的 CI）时跳过，不算失败。
    #[test]
    fn extracts_text_from_real_pdf() {
        let _ = crate::services::pdf::init_pdfium();

        let dir = std::env::temp_dir().join(format!("kb_pdf_layout_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hello.pdf");
        std::fs::write(&path, build_minimal_text_pdf("Hello PDF")).unwrap();

        match PdfLayoutService::extract(&path, 10) {
            Ok(layout) => {
                assert!(layout.page_count >= 1);
                assert!(layout.plain_text().contains("Hello PDF"));
            }
            Err(e) => {
                // 测试环境没有 pdfium.dll 时允许跳过
                eprintln!("[pdf_layout test] PDFium 不可用，跳过: {e}");
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 生成一个单页、单字体、单行文本的最小 PDF。
    fn build_minimal_text_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 24 Tf 72 720 Td ({text}) Tj ET");
        build_pdf(vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
              /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
                .to_vec(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
            stream_object(stream.as_bytes()),
        ])
    }

    /// 生成一个含 64x64 位图的最小 PDF，用于验证图片抽取。
    fn build_minimal_image_pdf(text: &str) -> Vec<u8> {
        let content = format!(
            "BT /F1 24 Tf 72 720 Td ({text}) Tj ET\n\
             q 200 0 0 200 72 400 cm /Im1 Do Q"
        );
        let side = 64usize;
        let mut pixels = Vec::with_capacity(side * side * 3);
        for y in 0..side {
            for x in 0..side {
                pixels.push((x * 4) as u8);
                pixels.push((y * 4) as u8);
                pixels.push(128);
            }
        }
        let mut image_object = format!(
            "<< /Type /XObject /Subtype /Image /Width {side} /Height {side} \
                 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length {} >>\nstream\n",
            pixels.len()
        )
        .into_bytes();
        image_object.extend_from_slice(&pixels);
        image_object.extend_from_slice(b"\nendstream");

        build_pdf(vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
              /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> \
              /Contents 5 0 R >>"
                .to_vec(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
            stream_object(content.as_bytes()),
            image_object,
        ])
    }

    fn stream_object(stream: &[u8]) -> Vec<u8> {
        let mut object = format!("<< /Length {} >>\nstream\n", stream.len()).into_bytes();
        object.extend_from_slice(stream);
        object.extend_from_slice(b"\nendstream");
        object
    }

    fn build_pdf(objects: Vec<Vec<u8>>) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            pdf.extend_from_slice(object);
            pdf.extend_from_slice(b"\nendobj\n");
        }

        let xref_pos = pdf.len();
        pdf.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for offset in &offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref_pos
            )
            .as_bytes(),
        );
        pdf
    }

    #[test]
    fn extracts_image_from_real_pdf() {
        let _ = crate::services::pdf::init_pdfium();

        let dir =
            std::env::temp_dir().join(format!("kb_pdf_layout_image_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("image.pdf");
        std::fs::write(&path, build_minimal_image_pdf("Hello Image")).unwrap();

        match PdfLayoutService::extract(&path, 10) {
            Ok(layout) => {
                assert!(layout.plain_text().contains("Hello Image"));
                assert_eq!(layout.images.len(), 1, "应抽取到 1 张图片");
                assert_eq!(layout.images[0].width, 64);
                assert_eq!(layout.images[0].height, 64);
                assert!(!layout.images[0].png_bytes.is_empty());
            }
            Err(e) => {
                eprintln!("[pdf_layout test] PDFium 不可用，跳过: {e}");
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_pdf_with_image_writes_note_and_assets() {
        let _ = crate::services::pdf::init_pdfium();

        let dir = std::env::temp_dir().join(format!("kb_pdf_import_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let db = crate::database::Database::init(dir.join("test.db").to_str().unwrap())
            .expect("init test db");
        let path = dir.join("图文.pdf");
        std::fs::write(
            &path,
            build_minimal_image_pdf(
                "This is a sufficiently long PDF text used to verify image import behavior in notes.",
            ),
        )
        .unwrap();

        match crate::services::pdf::PdfService::import_one(
            &dir,
            &db,
            path.to_str().unwrap(),
            None,
            true,
            10,
        ) {
            Ok(outcome) => {
                assert_eq!(outcome.image_count, 1);
                assert_eq!(outcome.extraction, "structured");
                assert!(
                    outcome.note.content.contains("<img"),
                    "正文: {}",
                    outcome.note.content
                );
                assert!(
                    outcome.note.content.contains("kb-asset://"),
                    "正文: {}",
                    outcome.note.content
                );

                let images_dir = crate::services::image::ImageService::images_dir(&dir)
                    .join(outcome.note.id.to_string());
                assert!(
                    images_dir.exists(),
                    "图片目录应存在: {}",
                    images_dir.display()
                );
                let image_count = std::fs::read_dir(&images_dir).unwrap().count();
                assert_eq!(image_count, 1);

                let pdf_dir = crate::services::pdf::PdfService::pdfs_dir(&dir)
                    .join(outcome.note.id.to_string());
                assert!(pdf_dir.exists(), "原 PDF 目录应存在: {}", pdf_dir.display());
            }
            Err(e) => {
                eprintln!("[pdf_layout test] PDFium 不可用，跳过: {e}");
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 手工探针：用环境变量指定的真实 PDF 跑完整导入并打印指标。
    /// 用法：
    ///   KB_TEST_PDFS="a.pdf;b.pdf" cargo test manual_import_real_pdfs --lib -- --ignored --nocapture
    #[test]
    #[ignore = "manual real-file probe"]
    fn manual_import_real_pdfs() {
        use crate::database::Database;
        use crate::services::image::ImageService;
        use crate::services::pdf::PdfService;
        use std::time::Instant;

        match crate::services::pdf::init_pdfium() {
            Ok(()) => println!("init_pdfium: ok"),
            Err(e) => println!("init_pdfium: {e}"),
        }
        let raw = std::env::var("KB_TEST_PDFS").expect("set KB_TEST_PDFS (separate by ;)");

        let root = std::env::temp_dir().join(format!("kb_pdf_real_probe_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let db = Database::init(root.join("probe.db").to_str().unwrap()).expect("init probe db");

        for path_str in raw.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            let path = Path::new(path_str);
            println!("\n=== FILE: {path_str} ===");
            println!(
                "file_size={} bytes",
                std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
            );

            if let Ok(layout) = PdfLayoutService::extract(path, 0) {
                println!(
                    "layout pages={} text_chars={} blocks={}",
                    layout.page_count,
                    layout.text_chars,
                    layout.blocks.len()
                );
                for block in layout.blocks.iter().take(24) {
                    println!(
                        "  page={} bbox={:?} text={:?}",
                        block.page,
                        block.bbox,
                        block.text.as_deref().unwrap_or("")
                    );
                }
            }

            let started = Instant::now();
            match PdfService::import_one(&root, &db, path_str, None, true, 200) {
                Ok(outcome) => {
                    let html = &outcome.note.content;
                    let image_dir =
                        ImageService::images_dir(&root).join(outcome.note.id.to_string());
                    let asset_files = std::fs::read_dir(&image_dir)
                        .map(|d| d.count())
                        .unwrap_or(0);
                    let pdf_dir = PdfService::pdfs_dir(&root).join(outcome.note.id.to_string());
                    let original_pdf_files =
                        std::fs::read_dir(&pdf_dir).map(|d| d.count()).unwrap_or(0);

                    println!("note_id={} title={}", outcome.note.id, outcome.note.title);
                    println!(
                        "extraction={} image_count={} img_tags={} p_tags={} asset_files={} original_pdf_files={}",
                        outcome.extraction,
                        outcome.image_count,
                        html.matches("<img").count(),
                        html.matches("<p>").count(),
                        asset_files,
                        original_pdf_files
                    );
                    println!(
                        "content_chars={} elapsed_ms={}",
                        html.chars().count(),
                        started.elapsed().as_millis()
                    );
                    println!("warnings={:?}", outcome.warnings);
                    println!(
                        "has_img={} has_kb_asset={} source_file={:?}",
                        html.contains("<img"),
                        html.contains("kb-asset://"),
                        outcome.note.source_file_path
                    );

                    let first_img = html.find("<img").unwrap_or(0);
                    let start = html[..first_img]
                        .char_indices()
                        .rev()
                        .nth(120)
                        .map(|(i, _)| i)
                        .unwrap_or(0);
                    let end = html[first_img..]
                        .char_indices()
                        .nth(200)
                        .map(|(i, _)| first_img + i)
                        .unwrap_or(html.len());
                    println!("around_first_img={:?}", &html[start..end]);
                    println!("preview={:?}", html.chars().take(300).collect::<String>());
                }
                Err(e) => println!("ERROR: {e}"),
            }
        }

        let _ = std::fs::remove_dir_all(&root);
    }
}
