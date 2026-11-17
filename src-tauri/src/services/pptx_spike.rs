//! PPTX Spike 文件层：受控读取与原子保存。
//!
//! 只接受绝对路径 + `.pptx` / `.pptm` 扩展名；读入上限 256 MB。
//! 保存时先写同目录临时文件再 rename，避免半截文件覆盖原稿。

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;

/// 单个 PPTX 读取上限；防止前端误传超大文件把 WebView 内存打爆。
pub const MAX_PPTX_BYTES: u64 = 256 * 1024 * 1024;

fn validate(path: &str) -> Result<PathBuf, AppError> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(AppError::InvalidInput("PPTX 路径必须是绝对路径".into()));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(
        ext.as_str(),
        "pptx" | "pptm" | "docx" | "docm" | "xlsx" | "xlsm" | "pdf"
    ) {
        return Err(AppError::InvalidInput(format!(
            "仅支持 .pptx/.pptm/.docx/.docm/.xlsx/.xlsm/.pdf，当前扩展名: {ext}"
        )));
    }
    Ok(p)
}

pub fn file_size(path: &str) -> Result<u64, AppError> {
    let p = validate(path)?;
    Ok(fs::metadata(&p)?.len())
}

pub fn read(path: &str) -> Result<Vec<u8>, AppError> {
    let p = validate(path)?;
    let meta = fs::metadata(&p)?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput("目标不是文件".into()));
    }
    if meta.len() > MAX_PPTX_BYTES {
        return Err(AppError::InvalidInput(format!(
            "文件过大（{} MB），上限 {} MB",
            meta.len() / 1024 / 1024,
            MAX_PPTX_BYTES / 1024 / 1024
        )));
    }
    Ok(fs::read(&p)?)
}

pub fn write_atomic(path: &str, bytes: &[u8]) -> Result<(), AppError> {
    let p = validate(path)?;
    let parent = p
        .parent()
        .ok_or_else(|| AppError::InvalidInput("无法确定目标目录".into()))?;
    if !parent.is_dir() {
        return Err(AppError::InvalidInput("目标目录不存在".into()));
    }
    if bytes.len() as u64 > MAX_PPTX_BYTES {
        return Err(AppError::InvalidInput("写入内容超过大小上限".into()));
    }

    let file_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::InvalidInput("目标文件名无效".into()))?;
    let tmp: PathBuf = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    if let Err(err) = fs::write(&tmp, bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }
    if let Err(err) = fs::rename(&tmp, &p) {
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

/// 供前端展示：仅返回文件名，不暴露完整路径。
pub fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("presentation.pptx")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_absolute_pptx() {
        let path = if cfg!(windows) {
            r"C:\temp\deck.pptx"
        } else {
            "/tmp/deck.pptx"
        };
        assert!(validate(path).is_ok());
    }

    #[test]
    fn validate_rejects_relative_path() {
        assert!(validate("deck.pptx").is_err());
    }

    #[test]
    fn validate_rejects_non_pptx_extension() {
        let path = if cfg!(windows) {
            r"C:\temp\deck.docx"
        } else {
            "/tmp/deck.docx"
        };
        assert!(validate(path).is_err());
    }
}
