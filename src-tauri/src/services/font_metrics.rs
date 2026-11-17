//! 系统字体度量（供 DOCX 分页估算）。
//!
//! 使用 font-enumeration 定位字体文件，ttf-parser 读取 hhea/OS2 与字形 advance，
//! 输出归一化到 em 的比例，前端据此估算行高与每行字符数。

use std::collections::HashMap;
use std::fs;

use serde::Serialize;

const LATIN_SAMPLE: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CJK_SAMPLE: &str = "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞";

#[derive(Debug, Clone, Serialize)]
pub struct FontMetrics {
    /// 请求的字体族名
    pub family: String,
    /// 实际命中的系统字体族名（未命中为 None，使用回退值）
    pub matched_family: Option<String>,
    /// ascender / em
    pub ascent: f32,
    /// -descender / em（正数）
    pub descent: f32,
    /// line-gap / em
    pub line_gap: f32,
    /// 拉丁字符平均 advance / em
    pub avg_latin: f32,
    /// CJK 字符平均 advance / em
    pub avg_cjk: f32,
    /// 空格 advance / em
    pub space: f32,
}

fn fallback(family: &str) -> FontMetrics {
    FontMetrics {
        family: family.to_string(),
        matched_family: None,
        ascent: 0.8,
        descent: 0.2,
        line_gap: 0.0,
        avg_latin: 0.5,
        avg_cjk: 1.0,
        space: 0.25,
    }
}

fn average_advance(face: &ttf_parser::Face, sample: &str, em: f32) -> Option<f32> {
    let mut total = 0.0f32;
    let mut count = 0u32;
    for ch in sample.chars() {
        if let Some(gid) = face.glyph_index(ch) {
            if let Some(adv) = face.glyph_hor_advance(gid) {
                total += adv as f32 / em;
                count += 1;
            }
        }
    }
    (count > 0).then_some(total / count as f32)
}

fn measure_file(path: &std::path::Path, family: &str, matched: &str) -> Option<FontMetrics> {
    let data = fs::read(path).ok()?;
    let face = ttf_parser::Face::parse(&data, 0).ok()?;
    let em = face.units_per_em() as f32;
    if em <= 0.0 {
        return None;
    }
    let ascent = face.ascender() as f32 / em;
    let descent = -(face.descender() as f32) / em;
    let line_gap = face.line_gap() as f32 / em;
    let avg_latin = average_advance(&face, LATIN_SAMPLE, em).unwrap_or(0.5);
    let avg_cjk = average_advance(&face, CJK_SAMPLE, em).unwrap_or(1.0);
    let space = average_advance(&face, " ", em).unwrap_or(0.25);
    Some(FontMetrics {
        family: family.to_string(),
        matched_family: Some(matched.to_string()),
        ascent,
        descent,
        line_gap,
        avg_latin,
        avg_cjk,
        space,
    })
}

/// 批量测量字体族；未命中的族返回回退值（`matched_family = None`）。
pub fn measure_families(families: &[String]) -> Vec<FontMetrics> {
    let collection = match font_enumeration::Collection::new() {
        Ok(collection) => collection,
        Err(_) => return families.iter().map(|family| fallback(family)).collect(),
    };

    // family（小写） → 最佳 face：优先 Normal 样式
    let mut best: HashMap<String, &font_enumeration::Font> = HashMap::new();
    for font in collection.all() {
        let key = font.family_name.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        let replace = match best.get(&key) {
            None => true,
            Some(existing) => {
                existing.style != font_enumeration::Style::Normal
                    && font.style == font_enumeration::Style::Normal
            }
        };
        if replace {
            best.insert(key, font);
        }
    }

    families
        .iter()
        .map(|family| {
            let key = family.trim().to_lowercase();
            let Some(font) = best.get(&key) else {
                return fallback(family);
            };
            measure_file(&font.path, family, &font.family_name).unwrap_or_else(|| fallback(family))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_has_valid_ratios() {
        let metrics = fallback("Missing Font");
        assert!(metrics.ascent > 0.0);
        assert!(metrics.descent > 0.0);
        assert!(metrics.avg_latin > 0.0);
        assert!(metrics.avg_cjk > 0.0);
    }

    #[test]
    fn measures_any_installed_font() {
        let Ok(collection) = font_enumeration::Collection::new() else {
            return;
        };
        let Some(first) = collection.all().next() else {
            return;
        };
        let metrics = measure_families(&[first.family_name.clone()]);
        assert_eq!(metrics.len(), 1);
        assert!(metrics[0].ascent > 0.0);
    }
}
