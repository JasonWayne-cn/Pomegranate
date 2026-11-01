//! PPT 大纲（plan.json）的规范化、校验与读写。
//!
//! 设计原则：
//! - AI 输出、用户编辑、扩展引擎三处都使用同一套规范化规则；
//! - 规范化只做“安全收敛”，不因单页字段异常导致整份大纲失败；
//! - 写盘使用临时文件 + 重命名，避免半截 JSON。

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::error::AppError;
use crate::models::extension::{PptContentBlock, PptPlan, PptSlide};

pub const MAX_SLIDES: usize = 40;
pub const MAX_BULLETS: usize = 8;
pub const MAX_CATEGORIES: usize = 12;
pub const MAX_SERIES: usize = 6;

const MAX_TITLE_CHARS: usize = 200;
const MAX_CORE_CHARS: usize = 600;
const MAX_BULLET_CHARS: usize = 240;
const CHART_TYPES: &[&str] = &[
    "column", "bar", "line", "area", "pie", "donut", "doughnut", "scatter", "radar", "gantt",
];

/// 把任意 JSON 收敛为合法大纲。页数、页型、图表字段都会被清洗。
pub fn normalize_plan(
    value: Value,
    fallback_title: &str,
    source: &str,
    target_slides: Option<usize>,
) -> PptPlan {
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_TITLE_CHARS))
        .or_else(|| {
            let fallback = fallback_title.trim();
            (!fallback.is_empty()).then(|| truncate_chars(fallback, MAX_TITLE_CHARS))
        })
        .unwrap_or_else(|| "AI PPT".to_string());

    let mut slides = Vec::new();
    if let Some(items) = value.get("slides").and_then(Value::as_array) {
        for item in items.iter().take(MAX_SLIDES) {
            if let Some(slide) = normalize_slide(item, slides.len() + 1) {
                slides.push(slide);
            }
        }
    }

    if slides.is_empty() {
        let limit = target_slides
            .map(|count| count.clamp(1, MAX_SLIDES))
            .unwrap_or(MAX_SLIDES);
        let headings = headings_from_source(source, limit);
        let headings = if headings.is_empty() {
            vec![title.clone()]
        } else {
            headings
        };
        for (index, heading) in headings.into_iter().enumerate() {
            slides.push(PptSlide {
                page: index as u32 + 1,
                title: truncate_chars(&heading, MAX_TITLE_CHARS),
                ..Default::default()
            });
        }
    }

    if slides.is_empty() {
        slides.push(PptSlide {
            page: 1,
            title: title.clone(),
            ..Default::default()
        });
    }

    for (index, slide) in slides.iter_mut().enumerate() {
        slide.page = index as u32 + 1;
        // 旧大纲或用户手工编辑可能只有 bullets：派生内容块，保证后续规划/渲染字段完整。
        if slide.content_blocks.is_empty() && !slide.bullets.is_empty() {
            slide.content_blocks = slide
                .bullets
                .iter()
                .map(|bullet| {
                    let (label, detail) = split_label_detail(bullet);
                    PptContentBlock {
                        label,
                        text: bullet.clone(),
                        detail,
                    }
                })
                .collect();
        }
        if slide.page_theme.is_empty() {
            slide.page_theme = slide.title.clone();
        }
        if slide.main_claim.is_empty() {
            slide.main_claim = slide.core_message.clone();
        }
        if slide.content_scope.is_empty() {
            slide.content_scope = slide
                .content_blocks
                .iter()
                .map(|block| block.text.as_str())
                .filter(|text| !text.is_empty())
                .take(2)
                .collect::<Vec<_>>()
                .join(" | ");
            if slide.content_scope.is_empty() {
                slide.content_scope = slide.core_message.clone();
            }
        }
    }

    PptPlan { title, slides }
}

fn text_field(
    object: &serde_json::Map<String, Value>,
    camel: &str,
    snake: &str,
    limit: usize,
) -> String {
    object
        .get(camel)
        .or_else(|| object.get(snake))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, limit))
        .unwrap_or_default()
}

fn string_list(
    object: &serde_json::Map<String, Value>,
    camel: &str,
    snake: &str,
    item_limit: usize,
    max_items: usize,
) -> Vec<String> {
    object
        .get(camel)
        .or_else(|| object.get(snake))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| truncate_chars(value, item_limit))
                .take(max_items)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn normalize_choice(value: &str, allowed: &[&str], fallback: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if allowed.contains(&normalized.as_str()) {
        normalized
    } else {
        fallback.to_string()
    }
}

fn split_label_detail(text: &str) -> (String, String) {
    let value = text.trim();
    if let Some((label, detail)) = value.split_once('：').or_else(|| value.split_once(':')) {
        let label = label.trim();
        let detail = detail.trim();
        if !label.is_empty() && !detail.is_empty() {
            return (truncate_chars(label, 40), truncate_chars(detail, 240));
        }
    }
    (truncate_chars(value, 40), String::new())
}

fn normalize_slide(value: &Value, page: usize) -> Option<PptSlide> {
    let object = value.as_object()?;
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_TITLE_CHARS))
        .unwrap_or_else(|| format!("第 {} 页", page));

    let core_message = text_field(object, "coreMessage", "core_message", MAX_CORE_CHARS);
    let bullets = string_list(object, "bullets", "bullets", MAX_BULLET_CHARS, MAX_BULLETS);

    let chart = object.get("chart").and_then(normalize_chart);
    let images = string_list(object, "images", "images", 512, 4);

    let content_blocks = object
        .get("contentBlocks")
        .or_else(|| object.get("content_blocks"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(6)
                .filter_map(|item| {
                    let block = item.as_object()?;
                    let label = text_field(block, "label", "label", 40);
                    let text = text_field(block, "text", "text", MAX_BULLET_CHARS);
                    let detail = text_field(block, "detail", "detail", 320);
                    if label.is_empty() && text.is_empty() && detail.is_empty() {
                        None
                    } else {
                        Some(PptContentBlock {
                            label,
                            text,
                            detail,
                        })
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let evidence = string_list(object, "evidence", "evidence", 240, 8);

    Some(PptSlide {
        page: page as u32,
        title,
        core_message,
        bullets,
        chart,
        images,
        page_theme: text_field(object, "pageTheme", "page_theme", 120),
        main_claim: text_field(object, "mainClaim", "main_claim", MAX_CORE_CHARS),
        content_scope: text_field(object, "contentScope", "content_scope", MAX_CORE_CHARS),
        content_blocks,
        evidence,
        relation: normalize_choice(
            &text_field(object, "relation", "relation", 32),
            &["timeline", "category", "compare", "cause", "process", "none"],
            "none",
        ),
        chart_type: normalize_choice(
            &text_field(object, "chartType", "chart_type", 32),
            &[
                "cards",
                "timeline",
                "process",
                "matrix",
                "compare",
                "highlight",
                "summary",
            ],
            "",
        ),
        density: normalize_choice(
            &text_field(object, "density", "density", 24),
            &["anchor", "dense", "breathing", "balanced"],
            "balanced",
        ),
        visual_intent: text_field(object, "visualIntent", "visual_intent", 400),
        speaker_note: text_field(object, "speakerNote", "speaker_note", 800),
    })
}

/// 把局部修复结果按 `page` 合并回原大纲；返回成功覆盖的页数。
///
/// 修复返回的 JSON 只包含有问题的页面，因此不能走 `normalize_plan`（它会重新编号），
/// 而是逐页规范化后按页码替换。
pub fn merge_repaired_slides(plan: &mut PptPlan, value: &Value) -> usize {
    let Some(items) = value.get("slides").and_then(Value::as_array) else {
        return 0;
    };
    let mut merged = 0usize;
    for item in items {
        let Some(page) = item.get("page").and_then(Value::as_u64) else {
            continue;
        };
        let page = page as u32;
        let Some(normalized) = normalize_slide(item, page as usize) else {
            continue;
        };
        if let Some(target) = plan.slides.iter_mut().find(|slide| slide.page == page) {
            *target = normalized;
            target.page = page;
            merged += 1;
        }
    }
    merged
}

/// 图表数据清洗：类型白名单、分类上限、系列补齐/截断、非数字归零。
pub fn normalize_chart(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let categories = object
        .get("categories")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(MAX_CATEGORIES)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if categories.is_empty() {
        return None;
    }

    let mut series = Vec::new();
    for item in object
        .get("series")
        .and_then(Value::as_array)?
        .iter()
        .take(MAX_SERIES)
    {
        let Some(item) = item.as_object() else {
            continue;
        };
        let mut values = item
            .get("values")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .take(categories.len())
                    .map(parse_number)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if values.is_empty() {
            continue;
        }
        values.resize(categories.len(), 0.0);
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Series");
        series.push(json!({ "name": name, "values": values }));
    }
    if series.is_empty() {
        return None;
    }

    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("column")
        .trim()
        .to_ascii_lowercase();
    let kind = if CHART_TYPES.contains(&kind.as_str()) {
        kind
    } else {
        "column".to_string()
    };

    Some(json!({
        "type": kind,
        "categories": categories,
        "series": series,
    }))
}

fn parse_number(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        .filter(|number| number.is_finite())
        .unwrap_or(0.0)
}

fn headings_from_source(source: &str, limit: usize) -> Vec<String> {
    let mut headings = Vec::new();
    for line in source.lines() {
        let line = line.trim();
        if !line.starts_with('#') {
            continue;
        }
        let title = line.trim_start_matches('#').trim();
        if title.is_empty() || title.chars().count() > 80 {
            continue;
        }
        headings.push(title.to_string());
        if headings.len() >= limit {
            break;
        }
    }
    headings
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut out: String = value.chars().take(limit).collect();
    out.push('…');
    out
}

/// 读取作业目录下的 plan.json；文件缺失时返回空大纲。
pub fn read_plan(job_dir: &Path, fallback_title: &str) -> Result<PptPlan, AppError> {
    let path = job_dir.join("plan.json");
    if !path.is_file() {
        return Ok(normalize_plan(json!({}), fallback_title, "", None));
    }
    let text = fs::read_to_string(&path)?;
    let value: Value = serde_json::from_str(&text)?;
    Ok(normalize_plan(value, fallback_title, "", None))
}

/// 原子写入 plan.json：先写临时文件，再替换正式文件。
pub fn write_plan(job_dir: &Path, plan: &PptPlan) -> Result<(), AppError> {
    let path = job_dir.join("plan.json");
    let temp = job_dir.join(format!("plan.json.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, serde_json::to_vec_pretty(plan)?)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    fs::rename(&temp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_missing_plan_from_headings() {
        let plan = normalize_plan(
            json!({}),
            "测试标题",
            "# 第一章\n正文\n## 第二章\n### 第三章",
            Some(2),
        );
        assert_eq!(plan.title, "测试标题");
        assert_eq!(plan.slides.len(), 2);
        assert_eq!(plan.slides[0].title, "第一章");
        assert_eq!(plan.slides[1].page, 2);
    }

    #[test]
    fn sanitizes_chart_data() {
        let chart = normalize_chart(&json!({
            "type": "unsupported",
            "categories": ["A", "B", "C"],
            "series": [
                {"name": "S1", "values": [1, "2"]},
                {"name": "S2", "values": [3, 4, 5, 6]}
            ]
        }))
        .unwrap();
        assert_eq!(chart["type"], "column");
        assert_eq!(chart["series"].as_array().unwrap().len(), 2);
        assert_eq!(chart["series"][0]["values"].as_array().unwrap().len(), 3);
        assert_eq!(chart["series"][1]["values"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn drops_chart_without_categories() {
        assert!(normalize_chart(&json!({
            "categories": [],
            "series": [{"name": "S", "values": [1]}]
        }))
        .is_none());
    }

    #[test]
    fn merges_repaired_slides_by_page() {
        let mut plan = normalize_plan(
            json!({
                "title": "T",
                "slides": [
                    {"page": 1, "title": "封面"},
                    {"page": 2, "title": "旧标题", "coreMessage": "旧"},
                    {"page": 3, "title": "第三页"}
                ]
            }),
            "T",
            "",
            None,
        );
        let merged = merge_repaired_slides(
            &mut plan,
            &json!({
                "slides": [{
                    "page": 2,
                    "title": "新标题",
                    "coreMessage": "新",
                    "contentBlocks": [
                        {"label": "A", "text": "要点一", "detail": ""},
                        {"label": "B", "text": "要点二", "detail": ""}
                    ]
                }]
            }),
        );
        assert_eq!(merged, 1);
        assert_eq!(plan.slides.len(), 3);
        assert_eq!(plan.slides[1].title, "新标题");
        assert_eq!(plan.slides[1].content_blocks.len(), 2);
        assert_eq!(plan.slides[2].title, "第三页");
    }

    #[test]
    fn clamps_slides_and_bullets() {
        let slides: Vec<Value> = (0..60)
            .map(|index| {
                json!({
                    "title": format!("页 {index}"),
                    "bullets": (0..20).map(|b| format!("要点 {b}")).collect::<Vec<_>>()
                })
            })
            .collect();
        let plan = normalize_plan(json!({"slides": slides}), "标题", "", None);
        assert_eq!(plan.slides.len(), MAX_SLIDES);
        assert!(plan.slides[0].bullets.len() <= MAX_BULLETS);
    }
}
