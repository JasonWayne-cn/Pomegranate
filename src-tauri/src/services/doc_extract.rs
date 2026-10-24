//! Word 文本抽取（供外部目录挂载的后台索引使用）
//!
//! `.docx` 本质是 zip，正文在 `word/document.xml`。这里只抽 `<w:t>` 文本，
//! 不在 Rust 侧重建富文本；富文本预览仍交给前端 mammoth / 系统应用。
//! `.doc` 先复用现有 converter 转成 `.docx`，再走同一套抽取。

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
            "docx" => Self::extract_docx_text(path),
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

    fn extract_docx_text(path: &Path) -> Result<String, AppError> {
        let file = std::fs::File::open(path)?;
        let mut zip = zip::ZipArchive::new(file)?;
        let mut doc = zip
            .by_name("word/document.xml")
            .map_err(|e| AppError::Custom(format!("Word 文件缺少 document.xml: {}", e)))?;
        let mut xml = String::new();
        doc.read_to_string(&mut xml)?;

        let mut reader = Reader::from_str(&xml);
        reader.config_mut().trim_text(false);

        let mut out = String::new();
        let mut in_text = false;

        loop {
            match reader.read_event() {
                Ok(Event::Start(e)) => {
                    if e.local_name().as_ref() == b"t" {
                        in_text = true;
                    }
                }
                Ok(Event::End(e)) => match e.local_name().as_ref() {
                    b"t" => in_text = false,
                    b"p" => out.push('\n'),
                    _ => {}
                },
                Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                    b"br" => out.push('\n'),
                    b"tab" => out.push('\t'),
                    _ => {}
                },
                Ok(Event::Text(e)) => {
                    if in_text {
                        let text = e
                            .unescape()
                            .map_err(|err| AppError::Custom(format!("docx 文本解码失败: {}", err)))?;
                        out.push_str(text.as_ref());
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => {
                    return Err(AppError::Custom(format!("解析 docx 失败: {}", e)));
                }
                _ => {}
            }
        }

        // 连续空行压到最多 2 个
        let mut cleaned = String::with_capacity(out.len());
        let mut run = 0usize;
        for ch in out.chars() {
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
        Ok(cleaned.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extract_docx_returns_error_for_missing_file() {
        let r = DocExtractService::extract_word_text(Path::new("Z:/not-exists.docx"));
        assert!(r.is_err());
    }

    #[test]
    fn extract_docx_reads_paragraphs() {
        let dir = std::env::temp_dir().join(format!("kb_docx_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.docx");

        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opt = zip::write::SimpleFileOptions::default();
        zip.start_file("word/document.xml", opt).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body>
                <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
                <w:p><w:r><w:t>World</w:t></w:r></w:p>
              </w:body>
            </w:document>"#,
        )
        .unwrap();
        zip.finish().unwrap();

        let text = DocExtractService::extract_word_text(&path).unwrap();
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
        assert!(text.contains('\n'));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
