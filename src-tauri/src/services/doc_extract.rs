//! Word / PowerPoint 文本抽取（供外部目录挂载的后台索引使用）
//!
//! - `.docx` / `.docm` 本质是 zip，正文在 `word/document.xml`。这里只抽文本，
//!   不在 Rust 侧重建富文本；富文本预览仍交给前端引擎 / 系统应用。
//!   表格按「单元格 Tab 分隔、行换行」输出，尽量保留列语义供搜索 / RAG 使用。
//! - `.doc` 先复用现有 converter 转成 `.docx`，再走同一套抽取。
//! - `.pptx` / `.pptm` 同样是 zip：按 `presentation.xml` 的幻灯片顺序抽
//!   `a:t` 文本，并附带备注页、图表/图示数据里的文字。

use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::AppError;

pub struct DocExtractService;

impl DocExtractService {
    /// 抽取 Word 文件正文（纯文本，段落之间用换行分隔）
    pub fn extract_word_text(path: &Path) -> Result<String, AppError> {
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();

        match ext.as_str() {
            "docx" | "docm" => Self::extract_docx_text(path),
            "doc" => {
                let temp_dir =
                    std::env::temp_dir().join(format!("kb_mount_doc_{}", std::process::id()));
                std::fs::create_dir_all(&temp_dir)?;
                let docx = crate::services::converter::convert_doc_to_docx(path, &temp_dir)?;
                let text = Self::extract_docx_text(&docx);
                let _ = std::fs::remove_file(&docx);
                let _ = std::fs::remove_dir(&temp_dir);
                text
            }
            _ => Err(AppError::InvalidInput(format!(
                "不是 Word 文件: {}",
                path.display()
            ))),
        }
    }

    /// 抽取 PowerPoint 文件正文（幻灯片按放映顺序，备注与图表文字追加在末尾）
    pub fn extract_presentation_text(path: &Path) -> Result<String, AppError> {
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();

        match ext.as_str() {
            "pptx" | "pptm" => Self::extract_pptx_text(path),
            _ => Err(AppError::InvalidInput(format!(
                "不是 PowerPoint 文件: {}",
                path.display()
            ))),
        }
    }

    fn extract_docx_text(path: &Path) -> Result<String, AppError> {
        let mut zip = open_zip(path)?;
        let mut out = String::new();

        // 正文（表格感知）。页眉/页脚/脚注/尾注是独立 part，正文里没有。
        let body = read_zip_part(&mut zip, "word/document.xml")?.ok_or_else(|| {
            AppError::Custom("Word 文件缺少 document.xml".into())
        })?;
        out.push_str(&extract_docx_part(&body));

        let mut aux_parts: Vec<String> = zip
            .file_names()
            .filter(|name| {
                name.ends_with(".xml")
                    && (name.starts_with("word/header")
                        || name.starts_with("word/footer")
                        || *name == "word/footnotes.xml"
                        || *name == "word/endnotes.xml")
            })
            .map(|name| name.to_string())
            .collect();
        aux_parts.sort();
        for part in aux_parts {
            if let Some(xml) = read_zip_part(&mut zip, &part)? {
                let text = extract_docx_part(&xml);
                if !text.trim().is_empty() {
                    out.push('\n');
                    out.push_str(&text);
                }
            }
        }

        Ok(clean_text(&out))
    }

    fn extract_pptx_text(path: &Path) -> Result<String, AppError> {
        let mut zip = open_zip(path)?;
        let mut sections: Vec<String> = Vec::new();

        for (index, part) in pptx_slide_parts(&mut zip).iter().enumerate() {
            if let Some(xml) = read_zip_part(&mut zip, part)? {
                let text = extract_pptx_part(&xml);
                if !text.trim().is_empty() {
                    sections.push(format!("幻灯片 {}\n{}", index + 1, text.trim_end()));
                }
            }
        }

        // 演讲者备注：按文件名数字排序，内容追加在正文之后。
        let mut notes: Vec<String> = zip
            .file_names()
            .filter(|name| name.starts_with("ppt/notesSlides/") && name.ends_with(".xml"))
            .map(|name| name.to_string())
            .collect();
        notes.sort_by_key(|name| trailing_number(name));
        for part in notes {
            if let Some(xml) = read_zip_part(&mut zip, &part)? {
                let text = extract_pptx_part(&xml);
                if !text.trim().is_empty() {
                    sections.push(format!("备注\n{}", text.trim_end()));
                }
            }
        }

        // 图表 / SmartArt 数据里也有 a:t 文本，一并纳入索引。
        let mut media_texts: Vec<String> = zip
            .file_names()
            .filter(|name| {
                name.ends_with(".xml")
                    && (name.starts_with("ppt/charts/chart")
                        || name.starts_with("ppt/diagrams/data"))
            })
            .map(|name| name.to_string())
            .collect();
        media_texts.sort();
        for part in media_texts {
            if let Some(xml) = read_zip_part(&mut zip, &part)? {
                let text = extract_pptx_part(&xml);
                if !text.trim().is_empty() {
                    sections.push(text.trim_end().to_string());
                }
            }
        }

        Ok(clean_text(&sections.join("\n\n")))
    }
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<std::fs::File>, AppError> {
    let file = std::fs::File::open(path)?;
    Ok(zip::ZipArchive::new(file)?)
}

fn read_zip_part(
    zip: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
) -> Result<Option<String>, AppError> {
    let mut entry = match zip.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => {
            return Err(AppError::Custom(format!(
                "读取 {name} 失败: {e}"
            )))
        }
    };
    let mut xml = String::new();
    entry.read_to_string(&mut xml)?;
    Ok(Some(xml))
}

/// `word/document.xml` / 页眉页脚等 part 的文本抽取。
///
/// 表格：单元格内段落用空格连接，单元格之间 Tab，行末换行。
fn extract_docx_part(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut out = String::new();
    let mut in_text = false;
    let mut in_field = false;
    let mut cell_depth = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"t" => in_text = true,
                b"fld" => in_field = true,
                b"tc" => cell_depth += 1,
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_text = false,
                b"fld" => in_field = false,
                b"p" => {
                    if cell_depth > 0 {
                        out.push(' ');
                    } else {
                        out.push('\n');
                    }
                }
                b"tc" => {
                    cell_depth = cell_depth.saturating_sub(1);
                    trim_trailing(&mut out, |ch| ch == '\n' || ch == ' ');
                    out.push('\t');
                }
                b"tr" => {
                    trim_trailing(&mut out, |ch| ch == '\t' || ch == '\n' || ch == ' ');
                    out.push('\n');
                }
                _ => {}
            },
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"br" => out.push('\n'),
                b"tab" => out.push('\t'),
                _ => {}
            },
            Ok(Event::Text(e)) => {
                if in_text && !in_field {
                    match e.unescape() {
                        Ok(text) => out.push_str(text.as_ref()),
                        Err(err) => log::warn!("[docx] 文本解码失败: {err}"),
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                return format!("解析 docx 失败: {e}");
            }
        }
    }
    out
}

/// `ppt/slides/*.xml`、备注页、图表 part 的文本抽取。
fn extract_pptx_part(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut out = String::new();
    let mut in_text = false;
    let mut in_field = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"t" => in_text = true,
                b"fld" => in_field = true,
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_text = false,
                b"fld" => in_field = false,
                b"p" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == b"br" {
                    out.push('\n');
                }
            }
            Ok(Event::Text(e)) => {
                if in_text && !in_field {
                    match e.unescape() {
                        Ok(text) => out.push_str(text.as_ref()),
                        Err(err) => log::warn!("[pptx] 文本解码失败: {err}"),
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                return format!("解析 pptx 失败: {e}");
            }
        }
    }
    out
}

/// 按 `presentation.xml` 的 `sldIdLst` 顺序解析幻灯片 part；失败时按文件名数字兜底。
fn pptx_slide_parts(zip: &mut zip::ZipArchive<std::fs::File>) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    if let (Some(presentation), Some(rels)) = (
        read_zip_part(zip, "ppt/presentation.xml").ok().flatten(),
        read_zip_part(zip, "ppt/_rels/presentation.xml.rels")
            .ok()
            .flatten(),
    ) {
        let order = parse_slide_relation_ids(&presentation);
        let targets = parse_presentation_rels(&rels);
        for rid in order {
            if let Some(target) = targets.get(&rid) {
                let part = normalize_ppt_target(target);
                if zip.index_for_name(&part).is_some() && !parts.contains(&part) {
                    parts.push(part);
                }
            }
        }
    }

    if parts.is_empty() {
        let mut fallback: Vec<String> = zip
            .file_names()
            .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
            .map(|name| name.to_string())
            .collect();
        fallback.sort_by_key(|name| trailing_number(name));
        parts = fallback;
    }
    parts
}

fn parse_slide_relation_ids(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    let mut ids = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e))
                if e.local_name().as_ref() == b"sldId" =>
            {
                for attr in e.attributes().flatten() {
                    // r:id 的 key 是 `r:id`；无命名空间的 id 是数字，跳过
                    if attr.key.as_ref().ends_with(b":id") {
                        ids.push(String::from_utf8_lossy(&attr.value).to_string());
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    ids
}

/// `_rels/presentation.xml.rels`：rId → Target（相对 `ppt/`）
fn parse_presentation_rels(xml: &str) -> std::collections::HashMap<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut map = std::collections::HashMap::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e))
                if e.local_name().as_ref() == b"Relationship" =>
            {
                let mut id = None;
                let mut target = None;
                for attr in e.attributes().flatten() {
                    let value = String::from_utf8_lossy(&attr.value).to_string();
                    match attr.key.as_ref() {
                        b"Id" => id = Some(value),
                        b"Target" => target = Some(value),
                        _ => {}
                    }
                }
                if let (Some(id), Some(target)) = (id, target) {
                    map.insert(id, target);
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    map
}

fn normalize_ppt_target(target: &str) -> String {
    let target = target.trim_start_matches('/');
    if target.starts_with("ppt/") {
        target.to_string()
    } else {
        format!("ppt/{target}")
    }
}

fn trailing_number(name: &str) -> u32 {
    name.rsplit(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn trim_trailing(out: &mut String, pred: impl Fn(char) -> bool) {
    while out.chars().last().is_some_and(&pred) {
        out.pop();
    }
}

fn clean_text(raw: &str) -> String {
    let mut cleaned = String::with_capacity(raw.len());
    let mut run = 0usize;
    for ch in raw.chars() {
        if ch == '\n' {
            run += 1;
            if run <= 2 {
                cleaned.push(ch);
            }
        } else {
            run = 0;
            cleaned.push(ch);
        }
    }
    cleaned.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_zip(name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kb_docx_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opt = zip::write::SimpleFileOptions::default();
        for (part, content) in files {
            zip.start_file(*part, opt).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn extract_docx_returns_error_for_missing_file() {
        let r = DocExtractService::extract_word_text(Path::new("Z:/not-exists.docx"));
        assert!(r.is_err());
    }

    #[test]
    fn extract_docx_reads_paragraphs() {
        let path = temp_zip(
            "sample.docx",
            &[(
                "word/document.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?>
                <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                  <w:body>
                    <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
                    <w:p><w:r><w:t>World</w:t></w:r></w:p>
                  </w:body>
                </w:document>"#,
            )],
        );
        let text = DocExtractService::extract_word_text(&path).unwrap();
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
        assert!(text.contains('\n'));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn extract_docm_uses_same_docx_parser() {
        let path = temp_zip(
            "macro.docm",
            &[(
                "word/document.xml",
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Macro 文档</w:t></w:r></w:p></w:body></w:document>"#,
            )],
        );
        let text = DocExtractService::extract_word_text(&path).unwrap();
        assert!(text.contains("Macro 文档"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn extract_docx_separates_table_cells() {
        let path = temp_zip(
            "table.docx",
            &[(
                "word/document.xml",
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
                <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
                <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
                </w:tbl></w:body></w:document>"#,
            )],
        );
        let text = DocExtractService::extract_word_text(&path).unwrap();
        assert!(text.contains("A1\tB1"), "got = {text:?}");
        assert!(text.contains("A2\tB2"), "got = {text:?}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn extract_docx_includes_header_and_footnote() {
        let path = temp_zip(
            "aux.docx",
            &[
                (
                    "word/document.xml",
                    r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>"#,
                ),
                (
                    "word/header1.xml",
                    r#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉文字</w:t></w:r></w:p></w:hdr>"#,
                ),
                (
                    "word/footnotes.xml",
                    r#"<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote><w:p><w:r><w:t>脚注文字</w:t></w:r></w:p></w:footnote></w:footnotes>"#,
                ),
            ],
        );
        let text = DocExtractService::extract_word_text(&path).unwrap();
        assert!(text.contains("正文"));
        assert!(text.contains("页眉文字"));
        assert!(text.contains("脚注文字"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn extract_pptx_follows_presentation_order_and_notes() {
        let path = temp_zip(
            "sample.pptx",
            &[
                (
                    "ppt/presentation.xml",
                    r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>"#,
                ),
                (
                    "ppt/_rels/presentation.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>"#,
                ),
                (
                    "ppt/slides/slide1.xml",
                    r#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>幻灯片正文</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#,
                ),
                (
                    "ppt/notesSlides/notesSlide1.xml",
                    r#"<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>演讲者备注</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>"#,
                ),
            ],
        );
        let text = DocExtractService::extract_presentation_text(&path).unwrap();
        assert!(text.contains("幻灯片正文"), "got = {text:?}");
        assert!(text.contains("演讲者备注"), "got = {text:?}");
        assert!(text.starts_with("幻灯片 1"), "got = {text:?}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn extract_presentation_rejects_docx() {
        let r = DocExtractService::extract_presentation_text(Path::new("Z:/a.docx"));
        assert!(r.is_err());
    }
}
