//! 安全的 zip 解压。
//!
//! 拒绝路径穿越、绝对路径、盘符与符号链接，并限制文件数/解压体积。
//! 扩展包安装与用户模板导入共用。

use std::fs;
use std::io;
use std::path::{Component, Path};

use crate::error::AppError;

pub fn extract_zip_safely(
    zip_path: &Path,
    dest: &Path,
    max_files: usize,
    max_bytes: u64,
) -> Result<(), AppError> {
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut total: u64 = 0;
    let mut count = 0usize;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let enclosed = entry
            .enclosed_name()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| AppError::InvalidInput(format!("zip 条目路径非法: {}", entry.name())))?;

        if enclosed.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(AppError::InvalidInput(format!(
                "zip 条目包含非法路径: {}",
                enclosed.display()
            )));
        }

        if let Some(mode) = entry.unix_mode() {
            // 0o120000 = symlink
            if mode & 0o170000 == 0o120000 {
                return Err(AppError::InvalidInput(format!(
                    "不允许符号链接: {}",
                    enclosed.display()
                )));
            }
        }

        count += 1;
        if count > max_files {
            return Err(AppError::InvalidInput(format!(
                "zip 条目过多（> {}）",
                max_files
            )));
        }
        total = total.saturating_add(entry.size());
        if total > max_bytes {
            return Err(AppError::InvalidInput("zip 解压体积过大".into()));
        }

        let out_path = dest.join(&enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&out_path)?;
        io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}
