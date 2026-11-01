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
use crate::models::extension::{PptPlan, PptSlide};

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
                core_message: String::new(),
                bullets: Vec::new(),
                chart: None,
                images: Vec::new(),
            });
        }
    }

    if slides.is_empty() {
        slides.push(PptSlide {
            page: 1,
            title: title.clone(),
            core_message: String::new(),
            bullets: Vec::new(),
            chart: None,
            images: Vec::new(),
        });
    }

    for (index, slide) in slides.iter_mut().enumerate() {
        slide.page = index as u32 + 1;
    }

    PptPlan { title, slides }
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

    let core_message = object
        .get("coreMessage")
        .or_else(|| object.get("core_message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| truncate_chars(value, MAX_CORE_CHARS))
        .unwrap_or_default();

    let bullets = object
        .get("bullets")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| truncate_chars(value, MAX_BULLET_CHARS))
                .take(MAX_BULLETS)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let chart = object.get("chart").and_then(normalize_chart);
    let images = object
        .get("images")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .take(4)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(PptSlide {
        page: page as u32,
        title,
        core_message,
        bullets,
        chart,
        images,
    })
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
