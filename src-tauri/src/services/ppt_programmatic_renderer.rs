//! 程序化 SVG 渲染器（类似外部 stable 模式）。
//!
//! 不调用 AI 生成 SVG：根据结构化大纲直接排版，每种 layout 生成 3 个 motif
//! 候选，按内容量、与上一页重复度选择 1 个。输出为整页绝对坐标 SVG，
//! 不包含 data-pptx-* 等模板结构元数据。

#![allow(non_snake_case, unused_variables)]

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::Value;

use crate::models::extension::{PptPlan, PptSlide};

const DEFAULT_PRIMARY: &str = "#0B4F8A";
const DEFAULT_BLUE: &str = "#0071BC";
const DEFAULT_ACCENT: &str = "#FFC000";
const DEFAULT_DANGER: &str = "#C1232D";
const DEFAULT_BG: &str = "#F5F7FA";
const DEFAULT_TEXT: &str = "#1F2937";
const DEFAULT_MUTED: &str = "#5B6770";
const DEFAULT_BORDER: &str = "#D9E2EC";
const DEFAULT_WHITE: &str = "#FFFFFF";

#[derive(Debug, Clone)]
pub struct ProgrammaticPalette {
    pub primary: String,
    pub secondary: String,
    pub accent: String,
    pub danger: String,
    pub bg: String,
    pub text: String,
    pub muted: String,
    pub border: String,
    pub white: String,
}

impl Default for ProgrammaticPalette {
    fn default() -> Self {
        Self {
            primary: DEFAULT_PRIMARY.to_string(),
            secondary: DEFAULT_BLUE.to_string(),
            accent: DEFAULT_ACCENT.to_string(),
            danger: DEFAULT_DANGER.to_string(),
            bg: DEFAULT_BG.to_string(),
            text: DEFAULT_TEXT.to_string(),
            muted: DEFAULT_MUTED.to_string(),
            border: DEFAULT_BORDER.to_string(),
            white: DEFAULT_WHITE.to_string(),
        }
    }
}

fn parse_hex(color: &str) -> Option<(u8, u8, u8)> {
    let value = color.trim().trim_start_matches('#');
    if value.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&value[0..2], 16).ok()?;
    let g = u8::from_str_radix(&value[2..4], 16).ok()?;
    let b = u8::from_str_radix(&value[4..6], 16).ok()?;
    Some((r, g, b))
}

impl ProgrammaticPalette {
    /// 从模板颜色集合中推断主色、强调色、背景与文字色。
    pub fn from_colors(colors: &std::collections::HashSet<String>) -> Self {
        let mut palette = Self::default();
        let mut blue: Option<String> = None;
        let mut accent: Option<String> = None;
        let mut danger: Option<String> = None;
        let mut light: Option<String> = None;
        let mut dark: Option<String> = None;
        for color in colors {
            let Some((r, g, b)) = parse_hex(color) else {
                continue;
            };
            if r == 255 && g == 255 && b == 255 {
                continue;
            }
            if b > 120 && b > r && b > g && blue.is_none() {
                blue = Some(color.clone());
            } else if r > 170 && g > 100 && b < 110 && accent.is_none() {
                accent = Some(color.clone());
            } else if r > 120 && g < 100 && b < 100 && danger.is_none() {
                danger = Some(color.clone());
            } else if r > 215
                && g > 215
                && b > 210
                && light.is_none()
                && (r.max(g).max(b) - r.min(g).min(b)) <= 28
            {
                light = Some(color.clone());
            } else if r < 120 && g < 120 && b < 120 && dark.is_none() {
                dark = Some(color.clone());
            }
        }
        if let Some(color) = blue {
            palette.primary = color.clone();
            palette.secondary = color;
        }
        if let Some(color) = accent {
            palette.accent = color;
        }
        if let Some(color) = danger {
            palette.danger = color;
        }
        if let Some(color) = light {
            palette.bg = color.clone();
            palette.border = color;
        }
        if let Some(color) = dark {
            palette.text = color;
        }
        palette
    }
}

thread_local! {
    static CURRENT_PALETTE: RefCell<ProgrammaticPalette> =
        RefCell::new(ProgrammaticPalette::default());
}

fn set_palette(palette: &ProgrammaticPalette) {
    CURRENT_PALETTE.with(|current| {
        *current.borrow_mut() = palette.clone();
    });
}

fn current_palette() -> ProgrammaticPalette {
    CURRENT_PALETTE.with(|current| current.borrow().clone())
}

#[derive(Debug, Clone)]
pub struct ProgrammaticCandidate {
    pub motif: &'static str,
    pub score: i32,
    pub svg: String,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ProgrammaticPage {
    pub layout: &'static str,
    pub motif: &'static str,
    pub score: i32,
    pub candidates: usize,
    pub svg: String,
    pub candidate_scores: Vec<(String, i32)>,
    pub issues: Vec<String>,
    pub candidate_details: Vec<ProgrammaticCandidate>,
    pub used_fallback: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layout {
    Cover,
    EditorialSplit,
    Cards,
    Timeline,
    Process,
    Compare,
    CauseEffect,
    Hierarchy,
    Matrix,
    Quote,
    EvidenceLed,
    Summary,
    Chart,
    Content,
}

impl Layout {
    fn as_str(self) -> &'static str {
        match self {
            Layout::Cover => "cover",
            Layout::EditorialSplit => "editorial-split",
            Layout::Cards => "cards",
            Layout::Timeline => "timeline",
            Layout::Process => "process",
            Layout::Compare => "compare",
            Layout::CauseEffect => "cause-effect",
            Layout::Hierarchy => "hierarchy",
            Layout::Matrix => "matrix",
            Layout::Quote => "quote",
            Layout::EvidenceLed => "evidence-led",
            Layout::Summary => "summary",
            Layout::Chart => "chart",
            Layout::Content => "content",
        }
    }
}

#[derive(Debug, Clone)]
struct ChartData {
    kind: String,
    categories: Vec<String>,
    series: Vec<(String, Vec<f32>)>,
}

fn chart_data(slide: &PptSlide) -> Option<ChartData> {
    let chart = slide.chart.as_ref()?;
    let kind = chart
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("column")
        .to_ascii_lowercase();
    let categories = chart
        .get("categories")
        .and_then(Value::as_array)?
        .iter()
        .map(|item| item.as_str().unwrap_or("").to_string())
        .filter(|item| !item.trim().is_empty())
        .collect::<Vec<_>>();
    let series = chart
        .get("series")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
            let values = item
                .get("values")
                .and_then(Value::as_array)?
                .iter()
                .map(|value| value.as_f64().unwrap_or(0.0) as f32)
                .collect::<Vec<_>>();
            (!values.is_empty()).then(|| (name.to_string(), values))
        })
        .collect::<Vec<_>>();
    if categories.is_empty() || series.is_empty() {
        return None;
    }
    Some(ChartData {
        kind,
        categories,
        series,
    })
}

fn rhythm_factor(slide: &PptSlide) -> f32 {
    match slide.density.to_ascii_lowercase().as_str() {
        "dense" => 0.92,
        "breathing" => 1.1,
        "anchor" => 1.05,
        _ => 1.0,
    }
}

fn choose_layout(slide: &PptSlide, index: usize, total: usize) -> Layout {
    if index == 0 {
        return Layout::Cover;
    }
    // 有图表数据时优先图表布局，避免末页被 Summary 覆盖。
    if chart_data(slide).is_some() {
        return Layout::Chart;
    }
    if index + 1 == total {
        return Layout::Summary;
    }
    let chart = slide.chart_type.to_ascii_lowercase();
    let relation = slide.relation.to_ascii_lowercase();
    let title = slide.title.as_str();
    if matches!(chart.as_str(), "timeline") || matches!(relation.as_str(), "timeline") {
        return Layout::Timeline;
    }
    if matches!(chart.as_str(), "process") || matches!(relation.as_str(), "process") {
        return Layout::Process;
    }
    if matches!(chart.as_str(), "compare") || matches!(relation.as_str(), "compare") {
        return Layout::Compare;
    }
    if matches!(relation.as_str(), "cause") || matches!(chart.as_str(), "cause") {
        return Layout::CauseEffect;
    }
    if matches!(chart.as_str(), "hierarchy" | "pyramid")
        || title.contains("层级")
        || title.contains("金字塔")
    {
        return Layout::Hierarchy;
    }
    if matches!(chart.as_str(), "quote")
        || title.contains("引述")
        || title.contains("观点")
    {
        return Layout::Quote;
    }
    if matches!(chart.as_str(), "highlight") {
        return Layout::EvidenceLed;
    }
    if matches!(chart.as_str(), "matrix") {
        return Layout::Matrix;
    }
    if matches!(chart.as_str(), "summary") {
        return Layout::Summary;
    }
    if matches!(chart.as_str(), "editorial")
        || (matches!(relation.as_str(), "category") && slide.content_blocks.len() >= 4)
    {
        return Layout::EditorialSplit;
    }
    if matches!(chart.as_str(), "cards") {
        return Layout::Cards;
    }
    if slide.content_blocks.len() >= 3 {
        Layout::Cards
    } else {
        Layout::Content
    }
}

fn motifs_for(layout: Layout) -> [&'static str; 3] {
    match layout {
        Layout::Cover => ["split-band", "center-hero", "left-title"],
        Layout::EditorialSplit => ["left-feature", "right-list", "two-panel"],
        Layout::Cards => ["top-band", "numbered", "split-panel"],
        Layout::Timeline => ["nodes", "steps", "big-number"],
        Layout::Process => ["arrows", "numbered", "timeline"],
        Layout::Compare => ["two-column", "split-panel", "evidence-strip"],
        Layout::CauseEffect => ["cause-chain", "three-column", "arrows"],
        Layout::Hierarchy => ["pyramid", "steps", "layers"],
        Layout::Matrix => ["matrix", "grid", "compare"],
        Layout::Quote => ["center-quote", "left-quote", "banner-quote"],
        Layout::EvidenceLed => ["big-evidence", "strip", "two-column"],
        Layout::Summary => ["numbered-list", "takeaway", "checklist"],
        Layout::Chart => ["chart-column", "chart-line", "chart-pie"],
        Layout::Content => ["bullets", "editorial", "split"],
    }
}

fn motif_allowed(slide: &PptSlide, motif: &str) -> bool {
    let blocks = slide.content_blocks.len().max(slide.bullets.len());
    let evidence = slide.evidence.len();
    match motif {
        "chart-column" | "chart-line" | "chart-pie" => chart_data(slide).is_some(),
        "big-number" => blocks >= 2,
        "nodes" => blocks >= 3,
        "matrix" | "grid" => blocks >= 4,
        "takeaway" => evidence > 0 || blocks >= 1,
        "big-evidence" => evidence > 0 || blocks >= 2,
        "three-column" | "cause-chain" | "pyramid" | "layers" => blocks >= 2,
        "split-panel" | "editorial" | "two-column" | "evidence-strip" | "right-list" => {
            blocks >= 2
        }
        _ => true,
    }
}

pub fn render_programmatic_page(
    plan: &PptPlan,
    slide: &PptSlide,
    index: usize,
    previous_motif: Option<&str>,
) -> ProgrammaticPage {
    render_programmatic_page_with_palette(
        plan,
        slide,
        index,
        previous_motif,
        &HashMap::new(),
        &ProgrammaticPalette::default(),
    )
}

pub fn render_programmatic_page_with_palette(
    plan: &PptPlan,
    slide: &PptSlide,
    index: usize,
    previous_motif: Option<&str>,
    motif_counts: &HashMap<String, usize>,
    palette: &ProgrammaticPalette,
) -> ProgrammaticPage {
    set_palette(palette);
    let layout = choose_layout(slide, index, plan.slides.len());
    let mut candidates =
        build_candidates(plan, slide, index, layout, previous_motif, motif_counts);
    let mut used_fallback = false;
    if !candidates.is_empty()
        && candidates.iter().all(|candidate| !candidate.issues.is_empty())
        && layout != Layout::Content
    {
        used_fallback = true;
        candidates.extend(build_candidates(
            plan,
            slide,
            index,
            Layout::Content,
            previous_motif,
            motif_counts,
        ));
    }
    candidates.sort_by(|left, right| right.score.cmp(&left.score));
    let candidate_scores = candidates
        .iter()
        .map(|candidate| (candidate.motif.to_string(), candidate.score))
        .collect::<Vec<_>>();
    let best = candidates
        .first()
        .cloned()
        .unwrap_or_else(|| ProgrammaticCandidate {
            motif: "fallback",
            score: 0,
            svg: render_fallback(slide),
            issues: vec!["无可用候选".to_string()],
        });
    ProgrammaticPage {
        layout: layout.as_str(),
        motif: best.motif,
        score: best.score,
        candidates: candidate_scores.len(),
        svg: best.svg,
        candidate_scores,
        issues: best.issues.clone(),
        candidate_details: candidates,
        used_fallback: used_fallback || best.motif == "fallback",
    }
}

fn build_candidates(
    plan: &PptPlan,
    slide: &PptSlide,
    index: usize,
    layout: Layout,
    previous_motif: Option<&str>,
    motif_counts: &HashMap<String, usize>,
) -> Vec<ProgrammaticCandidate> {
    let all_motifs = motifs_for(layout);
    let eligible: Vec<&str> = all_motifs
        .iter()
        .copied()
        .filter(|motif| motif_allowed(slide, motif))
        .collect();
    let chosen_motifs: Vec<&str> = if eligible.is_empty() {
        vec![*all_motifs.first().unwrap_or(&"top-band")]
    } else {
        eligible
    };
    chosen_motifs
        .iter()
        .enumerate()
        .map(|(order, motif)| {
            let svg = render_layout(plan, slide, index, layout, motif);
            let issues = qa_svg(&svg, slide);
            let mut score =
                score_candidate(slide, motif, previous_motif, &svg, order, motif_counts);
            score -= issues.len() as i32 * 15;
            ProgrammaticCandidate {
                motif,
                score,
                svg,
                issues,
            }
        })
        .collect()
}

fn qa_svg(svg: &str, slide: &PptSlide) -> Vec<String> {
    let mut issues = Vec::new();
    if !svg.contains("<svg") || !svg.contains("</svg>") {
        issues.push("SVG 不完整".to_string());
        return issues;
    }
    if !svg.contains("viewBox=\"0 0 1280 720\"") {
        issues.push("画布不是 1280×720".to_string());
    }
    if slide.page > 1 && svg.matches("<text").count() < 2 {
        issues.push("可见文本过少".to_string());
    }
    if let Ok(re) = regex::Regex::new(r#"font-size="([0-9.]+)""#) {
        for capture in re.captures_iter(svg) {
            if let Some(value) = capture.get(1) {
                if let Ok(size) = value.as_str().parse::<f32>() {
                    if !(10.0..=72.0).contains(&size) {
                        issues.push(format!("字号越界：{size}"));
                        break;
                    }
                }
            }
        }
    }
    if let Ok(tag_re) = regex::Regex::new(r"<text\b[^>]*>") {
        let x_re = regex::Regex::new(r#"x="(-?[0-9.]+)""#).ok();
        let y_re = regex::Regex::new(r#"y="(-?[0-9.]+)""#).ok();
        for tag in tag_re.find_iter(svg) {
            let raw = tag.as_str();
            if let Some(re) = x_re.as_ref() {
                if let Some(value) = re
                    .captures(raw)
                    .and_then(|capture| capture.get(1))
                    .and_then(|value| value.as_str().parse::<f32>().ok())
                {
                    if value < -5.0 || value > 1280.0 {
                        issues.push("文本横向越界".to_string());
                        break;
                    }
                }
            }
            if let Some(re) = y_re.as_ref() {
                if let Some(value) = re
                    .captures(raw)
                    .and_then(|capture| capture.get(1))
                    .and_then(|value| value.as_str().parse::<f32>().ok())
                {
                    if value < -5.0 || value > 720.0 {
                        issues.push("文本纵向越界".to_string());
                        break;
                    }
                }
            }
        }
    }
    if svg.contains("data-pptx-")
        || svg.contains("dominant-baseline")
        || svg.contains("alignment-baseline")
        || svg.contains("<use")
    {
        issues.push("包含不兼容 SVG 属性".to_string());
    }
    issues
}

fn score_candidate(
    slide: &PptSlide,
    motif: &str,
    previous: Option<&str>,
    svg: &str,
    order: usize,
    motif_counts: &HashMap<String, usize>,
) -> i32 {
    let mut score = 80 - order as i32;
    if svg.len() > 2_000 {
        score += 8;
    }
    let reuse = motif_counts.get(motif).copied().unwrap_or(0);
    score -= (reuse.min(8) as i32) * 12;
    if previous == Some(motif) {
        score -= 120;
    }
    if reuse >= 2 {
        score -= 60;
    }
    let blocks = slide.content_blocks.len();
    if blocks >= 5 && matches!(motif, "top-band" | "numbered" | "arrows" | "nodes") {
        score += 5;
    }
    if blocks <= 2 && matches!(motif, "split-panel" | "editorial") {
        score += 3;
    }
    if slide.chart_type == "highlight" && motif == "takeaway" {
        score += 6;
    }
    score
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn wrap_text(text: &str, max_width: f32, size: f32, max_lines: usize) -> Vec<String> {
    let cleaned = text.replace(['\r', '\n', '\t'], " ");
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut width = 0.0f32;
    for ch in cleaned.chars() {
        let char_width = if ch.is_ascii() { size * 0.55 } else { size };
        if width + char_width > max_width && !current.is_empty() {
            lines.push(current.trim().to_string());
            current.clear();
            width = 0.0;
        }
        current.push(ch);
        width += char_width;
    }
    if !current.trim().is_empty() {
        lines.push(current.trim().to_string());
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    if lines.len() > max_lines {
        lines.truncate(max_lines);
        if let Some(last) = lines.last_mut() {
            last.push('…');
        }
    }
    lines
}

fn text_block(
    x: f32,
    y: f32,
    width: f32,
    size: f32,
    line_height: f32,
    fill: &str,
    weight: &str,
    text: &str,
    max_lines: usize,
) -> String {
    let lines = wrap_text(text, width, size, max_lines);
    let mut out = String::new();
    for (index, line) in lines.iter().enumerate() {
        let line_y = y + index as f32 * line_height;
        out.push_str(&format!(
            "<text x=\"{x}\" y=\"{line_y}\" font-size=\"{size}\" fill=\"{fill}\" font-weight=\"{weight}\">{}</text>",
            escape_xml(line)
        ));
    }
    out
}

fn rect(x: f32, y: f32, w: f32, h: f32, fill: &str, radius: f32) -> String {
    format!(
        "<rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" rx=\"{radius}\" fill=\"{fill}\"/>"
    )
}

fn line(x1: f32, y1: f32, x2: f32, y2: f32, stroke: &str, width: f32) -> String {
    format!(
        "<line x1=\"{x1}\" y1=\"{y1}\" x2=\"{x2}\" y2=\"{y2}\" stroke=\"{stroke}\" stroke-width=\"{width}\"/>"
    )
}

fn circle(cx: f32, cy: f32, r: f32, fill: &str) -> String {
    format!("<circle cx=\"{cx}\" cy=\"{cy}\" r=\"{r}\" fill=\"{fill}\"/>")
}

fn wrap_svg(body: &str) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1280\" height=\"720\" viewBox=\"0 0 1280 720\" font-family=\"Microsoft YaHei, PingFang SC, Arial, sans-serif\">{body}</svg>"
    )
}

fn blocks(slide: &PptSlide) -> Vec<(String, String, String)> {
    let mut list: Vec<(String, String, String)> = slide
        .content_blocks
        .iter()
        .filter(|block| {
            !block.label.trim().is_empty()
                || !block.text.trim().is_empty()
                || !block.detail.trim().is_empty()
        })
        .map(|block| (block.label.clone(), block.text.clone(), block.detail.clone()))
        .collect();
    if list.is_empty() {
        for (index, bullet) in slide.bullets.iter().enumerate() {
            let value = bullet.trim();
            if value.is_empty() {
                continue;
            }
            if let Some((label, detail)) = value
                .split_once('：')
                .or_else(|| value.split_once(':'))
            {
                list.push((
                    label.trim().to_string(),
                    detail.trim().to_string(),
                    String::new(),
                ));
            } else {
                list.push((format!("要点 {}", index + 1), value.to_string(), String::new()));
            }
        }
    }
    if list.is_empty() {
        list.push((
            slide.title.clone(),
            if slide.core_message.is_empty() {
                slide.page_theme.clone()
            } else {
                slide.core_message.clone()
            },
            String::new(),
        ));
    }
    list
}

fn header(title: &str, page: u32, _total: usize) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let mut body = String::new();
    body.push_str(&rect(0.0, 0.0, 1280.0, 720.0, BG, 0.0));
    body.push_str(&rect(0.0, 0.0, 1280.0, 8.0, BLUE, 0.0));
    body.push_str(&rect(48.0, 42.0, 8.0, 46.0, BLUE, 2.0));
    body.push_str(&text_block(
        72.0,
        80.0,
        880.0,
        30.0,
        38.0,
        PRIMARY,
        "bold",
        title,
        1,
    ));
    body.push_str(&line(72.0, 112.0, 1180.0, 112.0, BORDER, 2.0));
    body.push_str(&format!(
        "<text x=\"1200\" y=\"78\" font-size=\"14\" fill=\"{MUTED}\" text-anchor=\"end\">P{page:02}</text>"
    ));
    body
}

fn footer(note: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let note = if note.trim().is_empty() {
        "Pomegranate"
    } else {
        note
    };
    format!(
        "<text x=\"72\" y=\"690\" font-size=\"11\" fill=\"{MUTED}\">{}</text>",
        escape_xml(note)
    )
}

fn render_layout(
    plan: &PptPlan,
    slide: &PptSlide,
    index: usize,
    layout: Layout,
    motif: &str,
) -> String {
    match layout {
        Layout::Cover => render_cover(plan, slide, motif),
        Layout::EditorialSplit => render_editorial_split(slide, motif),
        Layout::Cards => render_cards(slide, motif),
        Layout::Timeline => render_timeline(slide, motif),
        Layout::Process => render_process(slide, motif),
        Layout::Compare => render_compare(slide, motif),
        Layout::CauseEffect => render_cause_effect(slide, motif),
        Layout::Hierarchy => render_hierarchy(slide, motif),
        Layout::Matrix => render_matrix(slide, motif),
        Layout::Quote => render_quote(slide, motif),
        Layout::EvidenceLed => render_evidence_led(slide, motif),
        Layout::Summary => render_summary(slide, motif),
        Layout::Chart => render_chart(slide, motif),
        Layout::Content => render_content(slide, motif),
    }
}

fn render_cover(plan: &PptPlan, slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let title = if slide.title.trim().is_empty() {
        plan.title.clone()
    } else {
        slide.title.clone()
    };
    let subtitle = if slide.core_message.trim().is_empty() {
        slide.main_claim.clone()
    } else {
        slide.core_message.clone()
    };
    let mut body = String::new();
    match motif {
        "center-hero" => {
            body.push_str(&rect(0.0, 0.0, 1280.0, 720.0, PRIMARY, 0.0));
            body.push_str(&rect(560.0, 250.0, 160.0, 6.0, ACCENT, 3.0));
            body.push_str(&text_block(
                140.0,
                360.0,
                1000.0,
                54.0,
                64.0,
                WHITE,
                "bold",
                &title,
                3,
            ));
            body.push_str(&text_block(
                140.0,
                500.0,
                1000.0,
                22.0,
                30.0,
                ACCENT,
                "normal",
                &subtitle,
                2,
            ));
        }
        "left-title" => {
            body.push_str(&rect(0.0, 0.0, 1280.0, 720.0, WHITE, 0.0));
            body.push_str(&rect(0.0, 0.0, 420.0, 720.0, PRIMARY, 0.0));
            body.push_str(&rect(440.0, 180.0, 12.0, 160.0, ACCENT, 4.0));
            body.push_str(&text_block(
                480.0,
                280.0,
                720.0,
                46.0,
                58.0,
                TEXT,
                "bold",
                &title,
                3,
            ));
            body.push_str(&text_block(
                480.0,
                460.0,
                720.0,
                22.0,
                30.0,
                MUTED,
                "normal",
                &subtitle,
                2,
            ));
        }
        _ => {
            body.push_str(&rect(0.0, 0.0, 1280.0, 720.0, PRIMARY, 0.0));
            body.push_str(&rect(72.0, 150.0, 760.0, 420.0, "#0E5F9E", 8.0));
            body.push_str(&rect(860.0, 150.0, 348.0, 420.0, ACCENT, 8.0));
            body.push_str(&text_block(
                110.0,
                280.0,
                680.0,
                50.0,
                60.0,
                WHITE,
                "bold",
                &title,
                3,
            ));
            body.push_str(&text_block(
                110.0,
                470.0,
                680.0,
                20.0,
                28.0,
                "#DCEEFD",
                "normal",
                &subtitle,
                2,
            ));
            body.push_str(&text_block(
                892.0,
                250.0,
                280.0,
                18.0,
                26.0,
                PRIMARY,
                "bold",
                "PROJECT DECK",
                2,
            ));
            body.push_str(&rect(892.0, 300.0, 110.0, 4.0, PRIMARY, 2.0));
            body.push_str(&text_block(
                892.0,
                340.0,
                280.0,
                14.0,
                20.0,
                PRIMARY,
                "normal",
                &plan.title,
                3,
            ));
        }
    }
    body.push_str(&format!(
        "<text x=\"72\" y=\"660\" font-size=\"12\" fill=\"#DCEEFD\">PROJECT DECK</text>"
    ));
    wrap_svg(&body)
}

fn render_cards(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, slide_page_total(slide));
    let rhythm = rhythm_factor(slide);
    let count = items.len().min(6).max(1);
    let cols = if count >= 5 { 3 } else { 2 };
    let rows = (count + cols - 1) / cols;
    let gap = 24.0;
    let start_x = 80.0;
    let start_y = 156.0;
    let card_w = (1120.0 - gap * (cols as f32 - 1.0)) / cols as f32;
    let card_h = if rows >= 2 {
        206.0 * rhythm.clamp(0.96, 1.06)
    } else {
        360.0
    };
    for (index, (label, text, detail)) in items.iter().take(count).enumerate() {
        let row = index / cols;
        let col = index % cols;
        let x = start_x + col as f32 * (card_w + gap);
        let y = start_y + row as f32 * (card_h + 20.0);
        body.push_str(&rect(x, y, card_w, card_h, WHITE, 8.0));
        match motif {
            "numbered" => {
                body.push_str(&circle(x + 34.0, y + 40.0, 18.0, BLUE));
                body.push_str(&format!(
                    "<text x=\"{}\" y=\"{}\" font-size=\"13\" fill=\"{}\" text-anchor=\"middle\">{:02}</text>",
                    x + 34.0,
                    y + 45.0,
                    WHITE,
                    index + 1
                ));
            }
            "split-panel" => {
                body.push_str(&rect(x, y, 6.0, card_h, if index % 2 == 0 { BLUE } else { ACCENT }, 3.0));
            }
            _ => {
                body.push_str(&rect(x, y, card_w, 6.0, if index % 2 == 0 { BLUE } else { ACCENT }, 3.0));
            }
        }
        let label_text = if label.trim().is_empty() {
            format!("要点 {}", index + 1)
        } else {
            label.clone()
        };
        body.push_str(&text_block(
            x + 26.0,
            y + 56.0,
            card_w - 52.0,
            20.0 * rhythm.clamp(0.96, 1.1),
            26.0,
            TEXT,
            "bold",
            &label_text,
            2,
        ));
        body.push_str(&text_block(
            x + 26.0,
            y + 112.0,
            card_w - 52.0,
            14.0 * rhythm.clamp(0.96, 1.08),
            22.0,
            MUTED,
            "normal",
            text,
            4,
        ));
        if !detail.trim().is_empty() {
            body.push_str(&text_block(
                x + 26.0,
                y + card_h - 48.0,
                card_w - 52.0,
                12.0 * rhythm.clamp(0.96, 1.08),
                18.0,
                MUTED,
                "normal",
                detail,
                2,
            ));
        }
        // 图标化：非编号 motif 在右下角增加状态图标，增强页面识别度。
        if motif != "numbered" {
            let kind = if index % 2 == 0 { "check" } else { "arrow" };
            body.push_str(&icon_badge(
                x + card_w - 32.0,
                y + card_h - 32.0,
                14.0,
                if index % 2 == 0 { BLUE } else { ACCENT },
                kind,
            ));
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_timeline(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, slide_page_total(slide));
    let count = items.len().min(5).max(1);
    let start_x = 130.0;
    let step = 1020.0 / (count.max(2) as f32 - 1.0).max(1.0);
    match motif {
        "big-number" => {
            for (index, (label, text, _)) in items.iter().take(count).enumerate() {
                let x = 100.0 + index as f32 * 250.0;
                body.push_str(&text_block(
                    x,
                    260.0,
                    220.0,
                    64.0,
                    70.0,
                    BLUE,
                    "bold",
                    &format!("{:02}", index + 1),
                    1,
                ));
                body.push_str(&text_block(
                    x,
                    330.0,
                    220.0,
                    18.0,
                    24.0,
                    TEXT,
                    "bold",
                    label,
                    2,
                ));
                body.push_str(&text_block(
                    x,
                    400.0,
                    220.0,
                    14.0,
                    22.0,
                    MUTED,
                    "normal",
                    text,
                    4,
                ));
                if index + 1 < count {
                    body.push_str(&line(x + 230.0, 300.0, x + 250.0, 300.0, BORDER, 2.0));
                }
            }
        }
        "steps" => {
            let box_w = 190.0;
            for (index, (label, text, _)) in items.iter().take(count).enumerate() {
                let x = start_x + index as f32 * (box_w + 28.0);
                body.push_str(&rect(x, 250.0, box_w, 220.0, WHITE, 8.0));
                body.push_str(&rect(x, 250.0, box_w, 6.0, BLUE, 3.0));
                body.push_str(&text_block(
                    x + 18.0,
                    290.0,
                    box_w - 36.0,
                    18.0,
                    24.0,
                    TEXT,
                    "bold",
                    label,
                    2,
                ));
                body.push_str(&text_block(
                    x + 18.0,
                    350.0,
                    box_w - 36.0,
                    13.0,
                    20.0,
                    MUTED,
                    "normal",
                    text,
                    4,
                ));
            }
        }
        _ => {
            body.push_str(&line(start_x, 320.0, start_x + step * (count as f32 - 1.0).max(0.0), 320.0, BORDER, 4.0));
            for (index, (label, text, _)) in items.iter().take(count).enumerate() {
                let x = start_x + index as f32 * step;
                body.push_str(&circle(x, 320.0, 16.0, if index % 2 == 0 { BLUE } else { ACCENT }));
                body.push_str(&format!(
                    "<circle cx=\"{x}\" cy=\"320\" r=\"25\" fill=\"none\" stroke=\"{}\" stroke-width=\"2\"/>",
                    if index % 2 == 0 { BLUE } else { ACCENT }
                ));
                body.push_str(&text_block(
                    x - 80.0,
                    270.0,
                    160.0,
                    16.0,
                    22.0,
                    TEXT,
                    "bold",
                    label,
                    2,
                ));
                body.push_str(&text_block(
                    x - 90.0,
                    360.0,
                    180.0,
                    13.0,
                    20.0,
                    MUTED,
                    "normal",
                    text,
                    4,
                ));
            }
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_process(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, slide_page_total(slide));
    let count = items.len().min(5).max(1);
    let box_w = (1120.0 - 32.0 * (count as f32 - 1.0)) / count as f32;
    for (index, (label, text, _)) in items.iter().take(count).enumerate() {
        let x = 80.0 + index as f32 * (box_w + 32.0);
        body.push_str(&rect(x, 230.0, box_w, 240.0, WHITE, 8.0));
        if motif == "numbered" || motif == "arrows" {
            body.push_str(&circle(x + box_w / 2.0, 285.0, 22.0, BLUE));
            body.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"18\" fill=\"{}\" text-anchor=\"middle\">{}</text>",
                x + box_w / 2.0,
                292.0,
                WHITE,
                index + 1
            ));
        } else {
            body.push_str(&rect(x, 230.0, box_w, 6.0, BLUE, 3.0));
        }
        body.push_str(&text_block(
            x + 20.0,
            340.0,
            box_w - 40.0,
            17.0,
            23.0,
            TEXT,
            "bold",
            label,
            2,
        ));
        body.push_str(&text_block(
            x + 20.0,
            392.0,
            box_w - 40.0,
            13.0,
            20.0,
            MUTED,
            "normal",
            text,
            4,
        ));
        if index + 1 < count && motif == "arrows" {
            body.push_str(&format!(
                "<polygon points=\"{},310 {},300 {},320\" fill=\"{}\"/>",
                x + box_w + 6.0,
                x + box_w + 22.0,
                x + box_w + 6.0,
                BLUE
            ));
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_compare(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, slide_page_total(slide));
    let half = (items.len() + 1) / 2;
    let left = &items[..half.min(items.len())];
    let right = &items[half.min(items.len())..];
    if motif == "evidence-strip" {
        for (index, (label, text, _)) in items.iter().take(5).enumerate() {
            let y = 160.0 + index as f32 * 96.0;
            body.push_str(&rect(80.0, y, 1120.0, 80.0, WHITE, 6.0));
            body.push_str(&text_block(100.0, y + 32.0, 260.0, 17.0, 22.0, TEXT, "bold", label, 3));
            body.push_str(&text_block(380.0, y + 32.0, 790.0, 14.0, 20.0, MUTED, "normal", text, 2));
        }
    } else {
        let panel_w = if motif == "split-panel" { 540.0 } else { 520.0 };
        body.push_str(&rect(80.0, 156.0, panel_w, 470.0, WHITE, 8.0));
        body.push_str(&rect(660.0, 156.0, panel_w, 470.0, WHITE, 8.0));
        body.push_str(&line(640.0, 180.0, 640.0, 600.0, BORDER, 2.0));
        for (index, (label, text, _)) in left.iter().take(4).enumerate() {
            let y = 200.0 + index as f32 * 100.0;
            body.push_str(&text_block(108.0, y, panel_w - 56.0, 17.0, 23.0, PRIMARY, "bold", label, 2));
            body.push_str(&text_block(108.0, y + 34.0, panel_w - 56.0, 13.0, 19.0, MUTED, "normal", text, 3));
        }
        for (index, (label, text, _)) in right.iter().take(4).enumerate() {
            let y = 200.0 + index as f32 * 100.0;
            body.push_str(&text_block(688.0, y, panel_w - 56.0, 17.0, 23.0, DANGER, "bold", label, 2));
            body.push_str(&text_block(688.0, y + 34.0, panel_w - 56.0, 13.0, 19.0, MUTED, "normal", text, 3));
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_editorial_split(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, 0);
    match motif {
        "two-panel" => {
            let half = (items.len() + 1) / 2;
            body.push_str(&rect(80.0, 150.0, 540.0, 470.0, WHITE, 8.0));
            body.push_str(&rect(660.0, 150.0, 540.0, 470.0, WHITE, 8.0));
            for (index, (label, text, _)) in items.iter().take(half).enumerate() {
                let y = 185.0 + index as f32 * 92.0;
                body.push_str(&text_block(108.0, y, 484.0, 18.0, 24.0, PRIMARY, "bold", label, 2));
                body.push_str(&text_block(108.0, y + 32.0, 484.0, 13.0, 19.0, MUTED, "normal", text, 3));
            }
            for (index, (label, text, _)) in items.iter().skip(half).take(half).enumerate() {
                let y = 185.0 + index as f32 * 92.0;
                body.push_str(&text_block(688.0, y, 484.0, 18.0, 24.0, PRIMARY, "bold", label, 2));
                body.push_str(&text_block(688.0, y + 32.0, 484.0, 13.0, 19.0, MUTED, "normal", text, 3));
            }
        }
        "right-list" => {
            body.push_str(&rect(80.0, 150.0, 320.0, 470.0, PRIMARY, 8.0));
            body.push_str(&text_block(108.0, 210.0, 264.0, 28.0, 36.0, WHITE, "bold", &slide.title, 4));
            body.push_str(&text_block(108.0, 350.0, 264.0, 14.0, 21.0, "#DCEEFD", "normal", &slide.core_message, 4));
            for (index, (label, text, _)) in items.iter().take(5).enumerate() {
                let col = index % 2;
                let row = index / 2;
                let x = 440.0 + col as f32 * 380.0;
                let y = 170.0 + row as f32 * 120.0;
                body.push_str(&text_block(x, y, 340.0, 17.0, 23.0, TEXT, "bold", label, 1));
                body.push_str(&text_block(x, y + 30.0, 340.0, 13.0, 19.0, MUTED, "normal", text, 3));
            }
        }
        _ => {
            body.push_str(&rect(80.0, 150.0, 380.0, 470.0, PRIMARY, 8.0));
            body.push_str(&rect(108.0, 210.0, 90.0, 5.0, ACCENT, 2.0));
            body.push_str(&text_block(108.0, 250.0, 324.0, 30.0, 38.0, WHITE, "bold", &slide.title, 4));
            body.push_str(&text_block(108.0, 380.0, 324.0, 14.0, 21.0, "#DCEEFD", "normal", &slide.core_message, 4));
            for (index, (label, text, _)) in items.iter().take(5).enumerate() {
                let y = 165.0 + index as f32 * 88.0;
                body.push_str(&circle(510.0, y + 8.0, 4.0, BLUE));
                body.push_str(&text_block(528.0, y, 640.0, 17.0, 23.0, TEXT, "bold", label, 1));
                body.push_str(&text_block(528.0, y + 28.0, 640.0, 13.0, 19.0, MUTED, "normal", text, 2));
                body.push_str(&line(528.0, y + 68.0, 1160.0, y + 68.0, BORDER, 1.0));
            }
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_quote(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let ACCENT = __palette.accent.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let quote = if !slide.core_message.trim().is_empty() {
        slide.core_message.clone()
    } else {
        items.first().map(|(_, text, _)| text.clone()).unwrap_or_default()
    };
    let mut body = header(&slide.title, slide.page, 0);
    match motif {
        "banner-quote" => {
            body.push_str(&rect(80.0, 150.0, 1120.0, 180.0, PRIMARY, 8.0));
            body.push_str(&text_block(120.0, 210.0, 1040.0, 30.0, 40.0, WHITE, "bold", &quote, 3));
            body.push_str(&text_block(120.0, 300.0, 1040.0, 14.0, 20.0, "#DCEEFD", "normal", &slide.title, 1));
            for (index, (label, text, _)) in items.iter().take(3).enumerate() {
                let y = 380.0 + index as f32 * 80.0;
                body.push_str(&text_block(120.0, y, 1040.0, 16.0, 22.0, TEXT, "bold", label, 1));
                body.push_str(&text_block(120.0, y + 28.0, 1040.0, 13.0, 19.0, MUTED, "normal", text, 2));
            }
        }
        "left-quote" => {
            body.push_str(&rect(80.0, 190.0, 8.0, 220.0, ACCENT, 4.0));
            body.push_str(&text_block(116.0, 220.0, 1000.0, 34.0, 44.0, TEXT, "bold", &quote, 4));
            body.push_str(&text_block(116.0, 430.0, 1000.0, 15.0, 22.0, MUTED, "normal", &slide.title, 1));
            for (index, (label, text, _)) in items.iter().take(2).enumerate() {
                let y = 500.0 + index as f32 * 62.0;
                body.push_str(&text_block(116.0, y, 1000.0, 14.0, 20.0, TEXT, "bold", label, 1));
                body.push_str(&text_block(300.0, y, 816.0, 13.0, 19.0, MUTED, "normal", text, 2));
            }
        }
        _ => {
            body.push_str(&text_block(140.0, 230.0, 1000.0, 38.0, 50.0, PRIMARY, "bold", &quote, 4));
            body.push_str(&line(140.0, 430.0, 1140.0, 430.0, ACCENT, 4.0));
            body.push_str(&text_block(140.0, 470.0, 1000.0, 16.0, 23.0, MUTED, "normal", &slide.title, 1));
            for (index, (label, text, _)) in items.iter().take(2).enumerate() {
                let y = 520.0 + index as f32 * 58.0;
                body.push_str(&text_block(140.0, y, 1000.0, 13.0, 19.0, TEXT, "normal", &format!("{label}：{text}"), 1));
            }
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_evidence_led(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let first = items.first();
    let mut body = header(&slide.title, slide.page, 0);
    match motif {
        "strip" => {
            for (index, (label, text, _)) in items.iter().take(5).enumerate() {
                let y = 160.0 + index as f32 * 96.0;
                body.push_str(&rect(80.0, y, 1120.0, 80.0, WHITE, 6.0));
                body.push_str(&text_block(104.0, y + 30.0, 280.0, 17.0, 22.0, PRIMARY, "bold", label, 2));
                body.push_str(&text_block(410.0, y + 30.0, 760.0, 14.0, 20.0, MUTED, "normal", text, 2));
            }
        }
        "two-column" => {
            body.push_str(&rect(80.0, 156.0, 520.0, 470.0, PRIMARY, 8.0));
            if let Some((label, text, _)) = first {
                body.push_str(&text_block(110.0, 240.0, 460.0, 40.0, 50.0, WHITE, "bold", label, 3));
                body.push_str(&text_block(110.0, 360.0, 460.0, 15.0, 22.0, "#DCEEFD", "normal", text, 4));
            }
            for (index, (label, text, _)) in items.iter().skip(1).take(4).enumerate() {
                let y = 180.0 + index as f32 * 100.0;
                body.push_str(&text_block(640.0, y, 560.0, 17.0, 23.0, TEXT, "bold", label, 1));
                body.push_str(&text_block(640.0, y + 30.0, 560.0, 13.0, 19.0, MUTED, "normal", text, 3));
            }
        }
        _ => {
            if let Some((label, text, _)) = first {
                body.push_str(&text_block(90.0, 220.0, 1100.0, 46.0, 58.0, PRIMARY, "bold", label, 2));
                body.push_str(&text_block(90.0, 320.0, 1100.0, 16.0, 24.0, MUTED, "normal", text, 3));
            }
            body.push_str(&line(90.0, 410.0, 1190.0, 410.0, ACCENT, 4.0));
            for (index, (label, text, _)) in items.iter().skip(1).take(4).enumerate() {
                let y = 450.0 + index as f32 * 52.0;
                body.push_str(&text_block(90.0, y, 300.0, 14.0, 20.0, TEXT, "bold", label, 1));
                body.push_str(&text_block(410.0, y, 780.0, 13.0, 19.0, MUTED, "normal", text, 1));
            }
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_cause_effect(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, 0);
    let headings = ["原因", "机制", "结果"];
    let chunk = (items.len() + 2) / 3;
    for (column, heading) in headings.iter().enumerate() {
        let x = 80.0 + column as f32 * 380.0;
        body.push_str(&rect(x, 156.0, 340.0, 470.0, WHITE, 8.0));
        body.push_str(&rect(x, 156.0, 340.0, 6.0, if column == 2 { ACCENT } else { BLUE }, 3.0));
        body.push_str(&text_block(x + 24.0, 200.0, 292.0, 20.0, 26.0, PRIMARY, "bold", heading, 1));
        let start = column * chunk;
        for (index, (label, text, _)) in items.iter().skip(start).take(chunk.min(3)).enumerate() {
            let y = 250.0 + index as f32 * 100.0;
            body.push_str(&text_block(x + 24.0, y, 292.0, 16.0, 22.0, TEXT, "bold", label, 2));
            body.push_str(&text_block(x + 24.0, y + 28.0, 292.0, 12.0, 18.0, MUTED, "normal", text, 3));
        }
        if column < 2 && motif != "three-column" {
            body.push_str(&format!(
                "<polygon points=\"{},360 {},350 {},370\" fill=\"{}\"/>",
                x + 344.0,
                x + 366.0,
                x + 344.0,
                ACCENT
            ));
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_hierarchy(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, 0);
    if motif == "layers" {
        for (index, (label, text, _)) in items.iter().take(4).enumerate() {
            let y = 160.0 + index as f32 * 108.0;
            body.push_str(&rect(80.0, y, 1120.0, 92.0, WHITE, 6.0));
            body.push_str(&rect(80.0, y, 12.0, 92.0, if index % 2 == 0 { BLUE } else { ACCENT }, 3.0));
            body.push_str(&text_block(116.0, y + 28.0, 320.0, 17.0, 22.0, PRIMARY, "bold", label, 1));
            body.push_str(&text_block(460.0, y + 28.0, 700.0, 13.0, 19.0, MUTED, "normal", text, 2));
        }
    } else {
        let top = items.first();
        let middle = items.get(1);
        let third = items.get(2);
        if let Some((label, text, _)) = top {
            body.push_str(&rect(400.0, 150.0, 480.0, 120.0, PRIMARY, 8.0));
            body.push_str(&text_block(424.0, 185.0, 432.0, 20.0, 26.0, WHITE, "bold", label, 2));
            body.push_str(&text_block(424.0, 225.0, 432.0, 13.0, 19.0, "#DCEEFD", "normal", text, 2));
        }
        for (index, item) in [middle, third].iter().enumerate() {
            if let Some((label, text, _)) = item {
                let x = 200.0 + index as f32 * 520.0;
                body.push_str(&rect(x, 300.0, 360.0, 110.0, WHITE, 8.0));
                body.push_str(&text_block(x + 20.0, 330.0, 320.0, 17.0, 23.0, TEXT, "bold", label, 2));
                body.push_str(&text_block(x + 20.0, 368.0, 320.0, 12.0, 18.0, MUTED, "normal", text, 2));
            }
        }
        for (index, (label, text, _)) in items.iter().skip(3).take(3).enumerate() {
            let x = 80.0 + index as f32 * 380.0;
            body.push_str(&rect(x, 450.0, 340.0, 150.0, WHITE, 8.0));
            body.push_str(&rect(x, 450.0, 340.0, 6.0, ACCENT, 3.0));
            body.push_str(&text_block(x + 20.0, 486.0, 300.0, 15.0, 21.0, TEXT, "bold", label, 2));
            body.push_str(&text_block(x + 20.0, 522.0, 300.0, 12.0, 18.0, MUTED, "normal", text, 3));
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_matrix(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, slide_page_total(slide));
    let cells = items.iter().take(4).collect::<Vec<_>>();
    if motif == "compare" {
        for (index, (label, text, _)) in items.iter().take(5).enumerate() {
            let y = 160.0 + index as f32 * 92.0;
            body.push_str(&rect(80.0, y, 1120.0, 76.0, WHITE, 6.0));
            body.push_str(&text_block(104.0, y + 30.0, 300.0, 16.0, 22.0, TEXT, "bold", label, 1));
            body.push_str(&text_block(430.0, y + 30.0, 740.0, 13.0, 20.0, MUTED, "normal", text, 2));
        }
    } else {
        let positions = [(80.0, 160.0), (640.0, 160.0), (80.0, 380.0), (640.0, 380.0)];
        for (index, (x, y)) in positions.iter().enumerate() {
            body.push_str(&rect(*x, *y, 520.0, 200.0, WHITE, 8.0));
            body.push_str(&rect(*x, *y, 520.0, 6.0, if index % 2 == 0 { BLUE } else { ACCENT }, 3.0));
            if let Some((label, text, _)) = cells.get(index) {
                body.push_str(&text_block(*x + 24.0, *y + 52.0, 472.0, 18.0, 24.0, TEXT, "bold", label, 2));
                body.push_str(&text_block(*x + 24.0, *y + 108.0, 472.0, 13.0, 20.0, MUTED, "normal", text, 4));
            }
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_summary(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, slide_page_total(slide));
    let count = items.len().min(6).max(1);
    if motif == "takeaway" {
        let first = items.first();
        if let Some((label, text, _)) = first {
            body.push_str(&rect(80.0, 150.0, 1120.0, 150.0, PRIMARY, 8.0));
            body.push_str(&text_block(110.0, 210.0, 1060.0, 26.0, 34.0, WHITE, "bold", label, 2));
            body.push_str(&text_block(110.0, 255.0, 1060.0, 15.0, 22.0, "#DCEEFD", "normal", text, 2));
        }
        for (index, (label, text, _)) in items.iter().skip(1).take(4).enumerate() {
            let y = 330.0 + index as f32 * 70.0;
            body.push_str(&text_block(100.0, y, 1080.0, 15.0, 21.0, TEXT, "bold", label, 1));
            body.push_str(&text_block(300.0, y, 880.0, 13.0, 20.0, MUTED, "normal", text, 2));
        }
    } else {
        for (index, (label, text, _)) in items.iter().take(count).enumerate() {
            let y = 160.0 + index as f32 * 76.0;
            if motif == "checklist" {
                body.push_str(&icon_badge(104.0, y + 8.0, 14.0, BLUE, "check"));
            } else {
                body.push_str(&circle(104.0, y + 8.0, 14.0, ACCENT));
            }
            body.push_str(&text_block(132.0, y + 14.0, 1020.0, 16.0, 22.0, TEXT, "bold", label, 1));
            body.push_str(&text_block(132.0, y + 40.0, 1020.0, 13.0, 19.0, MUTED, "normal", text, 2));
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn series_palette() -> Vec<String> {
    let palette = current_palette();
    vec![
        palette.secondary,
        palette.accent,
        palette.danger,
        palette.primary,
    ]
}

fn render_chart(slide: &PptSlide, motif: &str) -> String {
    let palette = current_palette();
    let TEXT = palette.text.as_str();
    let MUTED = palette.muted.as_str();
    let BORDER = palette.border.as_str();
    let BG = palette.bg.as_str();
    let Some(chart) = chart_data(slide) else {
        return render_content(slide, "bullets");
    };
    let mut body = header(&slide.title, slide.page, slide_page_total(slide));
    let rhythm = rhythm_factor(slide);
    let area_x: f32 = 104.0;
    let area_y: f32 = if rhythm > 1.03 { 188.0 } else { 176.0 };
    let area_w: f32 = 1072.0;
    let area_h: f32 = 720.0 - area_y - 132.0;
    let colors = series_palette();
    let mode = motif.trim_start_matches("chart-");
    let label_size = 11.0 * rhythm.clamp(0.95, 1.12);
    if mode == "pie" {
        let categories = &chart.categories;
        let values = &chart.series[0].1;
        let total: f32 = values.iter().map(|value| value.max(0.0)).sum::<f32>().max(1.0);
        let cx = 430.0;
        let cy = area_y + area_h / 2.0;
        let radius = (area_h / 2.0 - 24.0).min(210.0);
        let mut angle = -std::f32::consts::FRAC_PI_2;
        for (index, category) in categories.iter().take(8).enumerate() {
            let value = values.get(index).copied().unwrap_or(0.0).max(0.0);
            let sweep = value / total * std::f32::consts::TAU;
            let end = angle + sweep;
            body.push_str(&wedge(cx, cy, radius, angle, end, &colors[index % colors.len()]));
            angle = end;
        }
        if chart.kind.contains("donut") {
            body.push_str(&circle(cx, cy, radius * 0.52, BG));
            body.push_str(&text_block(
                cx - 90.0,
                cy - 4.0,
                180.0,
                18.0,
                24.0,
                TEXT,
                "bold",
                &format!("{:.0}%", 100.0),
                1,
            ));
        }
        let legend_x = 760.0;
        let mut legend_y = area_y + 24.0;
        for (index, category) in categories.iter().take(8).enumerate() {
            let value = values.get(index).copied().unwrap_or(0.0).max(0.0);
            let percent = value / total * 100.0;
            body.push_str(&rect(legend_x, legend_y - 11.0, 12.0, 12.0, &colors[index % colors.len()], 2.0));
            body.push_str(&text_block(
                legend_x + 22.0,
                legend_y,
                300.0,
                label_size,
                18.0,
                TEXT,
                "normal",
                &format!("{category}  {value:.0}（{percent:.0}%）"),
                1,
            ));
            legend_y += 30.0;
        }
    } else if mode == "line" {
        let count = chart.categories.len().min(10);
        let plot_w = area_w;
        let plot_h = area_h;
        for tick in 0..=4 {
            let y = area_y + plot_h - plot_h * tick as f32 / 4.0;
            body.push_str(&line(area_x, y, area_x + plot_w, y, BORDER, 1.0));
        }
        let max = chart
            .series
            .iter()
            .flat_map(|(_, values)| values.iter().copied())
            .fold(0.0f32, f32::max)
            .max(1.0);
        for (series_index, (_, values)) in chart.series.iter().enumerate().take(4) {
            let color = &colors[series_index % colors.len()];
            let points = (0..count)
                .map(|index| {
                    let x = area_x
                        + if count > 1 {
                            index as f32 * plot_w / (count as f32 - 1.0)
                        } else {
                            plot_w / 2.0
                        };
                    let value = values.get(index).copied().unwrap_or(0.0).max(0.0);
                    let y = area_y + plot_h - (value / max) * plot_h;
                    (x, y)
                })
                .collect::<Vec<_>>();
            let polyline = points
                .iter()
                .map(|(x, y)| format!("{x:.1},{y:.1}"))
                .collect::<Vec<_>>()
                .join(" ");
            body.push_str(&format!(
                "<polyline points=\"{polyline}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"3\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/>"
            ));
            for (index, (x, y)) in points.iter().enumerate() {
                body.push_str(&circle(*x, *y, 4.5, color));
                if series_index == 0 {
                    let value = values.get(index).copied().unwrap_or(0.0);
                    body.push_str(&text_block(
                        x - 24.0,
                        y - 14.0,
                        48.0,
                        10.0,
                        12.0,
                        MUTED,
                        "normal",
                        &format!("{value:.0}"),
                        1,
                    ));
                }
            }
        }
        render_chart_axis_labels(&mut body, &chart, area_x, area_y, area_w, area_h, label_size, MUTED);
    } else {
        let count = chart.categories.len().min(8);
        let max = chart
            .series
            .iter()
            .flat_map(|(_, values)| values.iter().copied())
            .fold(0.0f32, f32::max)
            .max(1.0);
        for tick in 0..=4 {
            let y = area_y + area_h - area_h * tick as f32 / 4.0;
            body.push_str(&line(area_x, y, area_x + area_w, y, BORDER, 1.0));
        }
        let group_w = area_w / count as f32;
        let slot_w = group_w * 0.66;
        let series_count = chart.series.len().min(4).max(1);
        let bar_w = (slot_w / series_count as f32 - 4.0).max(6.0);
        for index in 0..count {
            let group_x = area_x + index as f32 * group_w;
            for (series_index, (_, values)) in chart.series.iter().enumerate().take(series_count) {
                let value = values.get(index).copied().unwrap_or(0.0).max(0.0);
                let height = (value / max) * area_h;
                let x = group_x
                    + (group_w - slot_w) / 2.0
                    + series_index as f32 * (bar_w + 4.0);
                let y = area_y + area_h - height;
                body.push_str(&rect(
                    x,
                    y,
                    bar_w,
                    height.max(1.0),
                    &colors[series_index % colors.len()],
                    2.0,
                ));
                if height > 24.0 {
                    body.push_str(&text_block(
                        x - 6.0,
                        y - 6.0,
                        bar_w + 12.0,
                        10.0,
                        12.0,
                        MUTED,
                        "normal",
                        &format!("{value:.0}"),
                        1,
                    ));
                }
            }
            if let Some(category) = chart.categories.get(index) {
                body.push_str(&text_block(
                    group_x + 2.0,
                    area_y + area_h + 24.0,
                    group_w - 4.0,
                    label_size,
                    label_size + 4.0,
                    MUTED,
                    "normal",
                    category,
                    2,
                ));
            }
        }
    }
    // 图例与数据来源
    let mut legend_x = area_x;
    for (index, (name, _)) in chart.series.iter().enumerate().take(4) {
        body.push_str(&rect(legend_x, area_y - 26.0, 12.0, 12.0, &colors[index % colors.len()], 2.0));
        body.push_str(&text_block(
            legend_x + 18.0,
            area_y - 16.0,
            220.0,
            11.0,
            14.0,
            TEXT,
            "normal",
            name,
            1,
        ));
        legend_x += 240.0;
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_chart_axis_labels(
    body: &mut String,
    chart: &ChartData,
    area_x: f32,
    area_y: f32,
    area_w: f32,
    area_h: f32,
    label_size: f32,
    muted: &str,
) {
    let count = chart.categories.len().min(10);
    let step = if count > 1 {
        area_w / (count as f32 - 1.0)
    } else {
        area_w
    };
    for index in 0..count {
        if let Some(category) = chart.categories.get(index) {
            body.push_str(&text_block(
                area_x + index as f32 * step - 44.0,
                area_y + area_h + 24.0,
                88.0,
                label_size,
                label_size + 4.0,
                muted,
                "normal",
                category,
                2,
            ));
        }
    }
}

fn wedge(cx: f32, cy: f32, r: f32, start: f32, end: f32, fill: &str) -> String {
    let x1 = cx + r * start.cos();
    let y1 = cy + r * start.sin();
    let x2 = cx + r * end.cos();
    let y2 = cy + r * end.sin();
    let large = if end - start > std::f32::consts::PI { 1 } else { 0 };
    format!(
        "<path d=\"M {cx} {cy} L {x1:.2} {y1:.2} A {r} {r} 0 {large} 1 {x2:.2} {y2:.2} Z\" fill=\"{fill}\"/>"
    )
}

fn icon_badge(x: f32, y: f32, radius: f32, fill: &str, kind: &str) -> String {
    let mut out = circle(x, y, radius, fill);
    let glyph = match kind {
        "arrow" => format!(
            "<path d=\"M {:.1} {:.1} L {:.1} {:.1} M {:.1} {:.1} L {:.1} {:.1} M {:.1} {:.1} L {:.1} {:.1}\" fill=\"none\" stroke=\"#FFFFFF\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
            x - 6.0, y, x + 6.0, y, x + 6.0, y, x + 1.0, y - 5.0, x + 6.0, y, x + 1.0, y + 5.0
        ),
        "check" => format!(
            "<path d=\"M {:.1} {:.1} L {:.1} {:.1} L {:.1} {:.1}\" fill=\"none\" stroke=\"#FFFFFF\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
            x - 6.0, y, x - 1.5, y + 5.0, x + 7.0, y - 6.0
        ),
        _ => circle(x, y, radius * 0.32, "#FFFFFF"),
    };
    out.push_str(&glyph);
    out
}

fn render_content(slide: &PptSlide, motif: &str) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let items = blocks(slide);
    let mut body = header(&slide.title, slide.page, slide_page_total(slide));
    let count = items.len().min(6).max(1);
    if motif == "editorial" {
        let half = (count + 1) / 2;
        for (index, (label, text, _)) in items.iter().take(half).enumerate() {
            let y = 170.0 + index as f32 * 82.0;
            body.push_str(&text_block(90.0, y, 520.0, 17.0, 23.0, PRIMARY, "bold", label, 2));
            body.push_str(&text_block(90.0, y + 30.0, 520.0, 13.0, 19.0, MUTED, "normal", text, 3));
        }
        for (index, (label, text, _)) in items.iter().skip(half).take(count - half).enumerate() {
            let y = 170.0 + index as f32 * 82.0;
            body.push_str(&text_block(660.0, y, 520.0, 17.0, 23.0, PRIMARY, "bold", label, 2));
            body.push_str(&text_block(660.0, y + 30.0, 520.0, 13.0, 19.0, MUTED, "normal", text, 3));
        }
    } else if motif == "split" {
        body.push_str(&rect(80.0, 150.0, 360.0, 470.0, PRIMARY, 8.0));
        body.push_str(&text_block(108.0, 200.0, 300.0, 24.0, 32.0, WHITE, "bold", &slide.title, 4));
        for (index, (label, text, _)) in items.iter().take(count).enumerate() {
            let y = 160.0 + index as f32 * 76.0;
            body.push_str(&text_block(480.0, y + 14.0, 700.0, 16.0, 22.0, TEXT, "bold", label, 1));
            body.push_str(&text_block(480.0, y + 40.0, 700.0, 13.0, 19.0, MUTED, "normal", text, 2));
        }
    } else {
        for (index, (label, text, _)) in items.iter().take(count).enumerate() {
            let y = 160.0 + index as f32 * 76.0;
            body.push_str(&circle(100.0, y + 8.0, 5.0, BLUE));
            body.push_str(&text_block(120.0, y + 14.0, 1040.0, 16.0, 22.0, TEXT, "bold", label, 1));
            body.push_str(&text_block(120.0, y + 40.0, 1040.0, 13.0, 19.0, MUTED, "normal", text, 2));
        }
    }
    body.push_str(&footer(&slide.source_hint()));
    wrap_svg(&body)
}

fn render_fallback(slide: &PptSlide) -> String {
    let __palette = current_palette();
    let PRIMARY = __palette.primary.as_str();
    let BLUE = __palette.secondary.as_str();
    let ACCENT = __palette.accent.as_str();
    let DANGER = __palette.danger.as_str();
    let BG = __palette.bg.as_str();
    let TEXT = __palette.text.as_str();
    let MUTED = __palette.muted.as_str();
    let BORDER = __palette.border.as_str();
    let WHITE = __palette.white.as_str();
    let body = format!(
        "{}{}{}",
        header(&slide.title, slide.page, 0),
        text_block(
            100.0,
            220.0,
            1080.0,
            20.0,
            30.0,
            TEXT,
            "normal",
            &slide.core_message,
            4,
        ),
        footer("")
    );
    wrap_svg(&body)
}

fn slide_page_total(_slide: &PptSlide) -> usize {
    // 页码总数由外部 header 使用；这里保留占位，实际总数在 render 调用前无法获得。
    // 为避免误导，使用当前页号作为下限，调用方在 header 中显示 Pxx / total。
    0
}

trait SlideSourceHint {
    fn source_hint(&self) -> String;
}

impl SlideSourceHint for PptSlide {
    fn source_hint(&self) -> String {
        if self.evidence.is_empty() {
            "Pomegranate".to_string()
        } else {
            self.evidence
                .iter()
                .take(2)
                .cloned()
                .collect::<Vec<_>>()
                .join(" · ")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::extension::PptContentBlock;

    fn sample_plan() -> PptPlan {
        PptPlan {
            title: "测试演示".into(),
            slides: vec![
                PptSlide {
                    page: 1,
                    title: "测试演示".into(),
                    core_message: "一句话说明".into(),
                    ..Default::default()
                },
                PptSlide {
                    page: 2,
                    title: "内容页".into(),
                    core_message: "核心信息".into(),
                    content_blocks: vec![
                        PptContentBlock {
                            label: "基线".into(),
                            text: "现有研究已经覆盖几何顺序".into(),
                            detail: "可作为对照".into(),
                        },
                        PptContentBlock {
                            label: "手部".into(),
                            text: "手部可达性需要单独验证".into(),
                            detail: String::new(),
                        },
                        PptContentBlock {
                            label: "检查".into(),
                            text: "分级检查降低查询成本".into(),
                            detail: String::new(),
                        },
                    ],
                    ..Default::default()
                },
                PptSlide {
                    page: 3,
                    title: "总结".into(),
                    core_message: "结论".into(),
                    ..Default::default()
                },
            ],
        }
    }

    #[test]
    fn renders_cover_and_cards_with_three_candidates() {
        let plan = sample_plan();
        let cover = render_programmatic_page(&plan, &plan.slides[0], 0, None);
        assert_eq!(cover.candidates, 3);
        assert!(cover.svg.contains("viewBox=\"0 0 1280 720\""));
        assert!(cover.svg.contains("测试演示"));
        assert!(!cover.svg.contains("data-pptx-"));
        assert!(!cover.svg.contains("dominant-baseline"));

        let cards = render_programmatic_page(&plan, &plan.slides[1], 1, Some("split-band"));
        assert_eq!(cards.candidates, 3);
        assert!(cards.svg.len() > 1_200);
        assert!(cards.svg.contains("基线"));

        // 便于本地目检：写入系统临时目录，不影响项目。
        let _ = std::fs::write(
            std::env::temp_dir().join("ppt_programmatic_cover.svg"),
            &cover.svg,
        );
        let _ = std::fs::write(
            std::env::temp_dir().join("ppt_programmatic_cards.svg"),
            &cards.svg,
        );
    }

    #[test]
    fn programmatic_output_avoids_unsupported_attributes() {
        let plan = sample_plan();
        for (index, slide) in plan.slides.iter().enumerate() {
            let rendered = render_programmatic_page(&plan, slide, index, None);
            assert!(!rendered.svg.contains("data-pptx-"));
            assert!(!rendered.svg.contains("dominant-baseline"));
            assert!(!rendered.svg.contains("alignment-baseline"));
            assert!(!rendered.svg.contains("<use"));
        }
    }

    #[test]
    fn palette_from_template_colors() {
        let colors: std::collections::HashSet<String> = [
            "#0071BC", "#FFC000", "#C1232D", "#F2F2F2", "#1F2937",
        ]
        .iter()
        .map(|value| value.to_string())
        .collect();
        let palette = ProgrammaticPalette::from_colors(&colors);
        assert_eq!(palette.primary, "#0071BC");
        assert_eq!(palette.accent, "#FFC000");
        assert_eq!(palette.danger, "#C1232D");
        assert_eq!(palette.bg, "#F2F2F2");
        assert_eq!(palette.text, "#1F2937");
    }

    #[test]
    fn motif_gate_and_reuse_penalty() {
        let slide = PptSlide {
            page: 2,
            title: "测试".into(),
            core_message: "核心".into(),
            content_blocks: vec![PptContentBlock {
                label: "A".into(),
                text: "说明".into(),
                detail: String::new(),
            }],
            ..Default::default()
        };
        assert!(!motif_allowed(&slide, "matrix"));
        assert!(motif_allowed(&slide, "top-band"));
        let mut counts = HashMap::new();
        counts.insert("top-band".to_string(), 3usize);
        let score =
            score_candidate(&slide, "top-band", Some("top-band"), "<svg></svg>", 0, &counts);
        assert!(score < 80);
    }

    #[test]
    fn new_layouts_are_reachable() {
        let blocks = vec![
            PptContentBlock {
                label: "A".into(),
                text: "说明一".into(),
                detail: String::new(),
            },
            PptContentBlock {
                label: "B".into(),
                text: "说明二".into(),
                detail: String::new(),
            },
            PptContentBlock {
                label: "C".into(),
                text: "说明三".into(),
                detail: String::new(),
            },
        ];
        let make_slide = |page: u32, title: &str, relation: &str, chart: &str| PptSlide {
            page,
            title: title.to_string(),
            core_message: "核心说明".into(),
            relation: relation.to_string(),
            chart_type: chart.to_string(),
            content_blocks: blocks.clone(),
            ..Default::default()
        };
        let plan = PptPlan {
            title: "布局测试".into(),
            slides: vec![
                make_slide(1, "封面", "", ""),
                make_slide(2, "因果", "cause", ""),
                make_slide(3, "层级", "", "hierarchy"),
                make_slide(4, "关键证据", "", "highlight"),
                make_slide(5, "核心观点", "", ""),
                make_slide(6, "总结", "", ""),
            ],
        };
        let cases = [
            (1usize, "cause-effect"),
            (2, "hierarchy"),
            (3, "evidence-led"),
            (4, "quote"),
        ];
        for (index, expected) in cases {
            let rendered = render_programmatic_page_with_palette(
                &plan,
                &plan.slides[index],
                index,
                None,
                &HashMap::new(),
                &ProgrammaticPalette::default(),
            );
            assert_eq!(rendered.layout, expected);
            assert!(rendered.svg.len() > 1_000);
            let _ = std::fs::write(
                std::env::temp_dir().join(format!("ppt_prog_{expected}.svg")),
                &rendered.svg,
            );
        }
    }

    #[test]
    fn chart_layout_renders_column_line_and_pie() {
        let chart = serde_json::json!({
            "type": "column",
            "categories": ["一季度", "二季度", "三季度"],
            "series": [
                {"name": "产量", "values": [12, 19, 27]},
                {"name": "销量", "values": [9, 16, 22]}
            ]
        });
        let make_slide = |page: u32, title: &str| PptSlide {
            page,
            title: title.to_string(),
            core_message: "数据说明".into(),
            content_blocks: vec![PptContentBlock {
                label: "指标".into(),
                text: "数据来自素材".into(),
                detail: String::new(),
            }],
            chart: Some(chart.clone()),
            ..Default::default()
        };
        let plan = PptPlan {
            title: "图表测试".into(),
            slides: vec![
                make_slide(1, "封面"),
                make_slide(2, "趋势"),
                make_slide(3, "收尾"),
            ],
        };
        let rendered = render_programmatic_page(&plan, &plan.slides[1], 1, None);
        assert_eq!(rendered.layout, "chart");
        assert!(rendered.svg.contains("产量"));
        assert!(rendered.svg.contains("<rect"));
        assert!(rendered.candidates >= 1);
        let line = render_chart(&plan.slides[1], "chart-line");
        assert!(line.contains("<polyline"));
        let pie = render_chart(&plan.slides[1], "chart-pie");
        assert!(pie.contains("<path"));
        assert!(!pie.contains("NaN"));

        // 末页有图表数据时仍应使用图表布局，而不是 Summary。
        let last_plan = PptPlan {
            title: "末页图表".into(),
            slides: vec![make_slide(1, "封面"), make_slide(2, "数据结论")],
        };
        let last = render_programmatic_page(&last_plan, &last_plan.slides[1], 1, None);
        assert_eq!(last.layout, "chart");
    }

    #[test]
    fn qa_flags_overflow_and_small_fonts() {
        let slide = PptSlide {
            page: 2,
            title: "测试".into(),
            ..Default::default()
        };
        let bad = "<svg viewBox=\"0 0 1280 720\"><text x=\"1400\" y=\"900\" font-size=\"8\">x</text></svg>";
        let issues = qa_svg(bad, &slide);
        assert!(issues.iter().any(|issue| issue.contains("越界")));
        assert!(issues.iter().any(|issue| issue.contains("字号")));
    }

    #[test]
    fn candidates_include_qa_details() {
        let plan = sample_plan();
        let rendered = render_programmatic_page_with_palette(
            &plan,
            &plan.slides[1],
            1,
            None,
            &HashMap::new(),
            &ProgrammaticPalette::default(),
        );
        assert!(rendered.candidate_details.len() >= 2);
        assert!(rendered
            .candidate_details
            .iter()
            .all(|candidate| candidate.svg.contains("<svg")));
    }
}
