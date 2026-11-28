//! 插件目录完整性校验。
//!
//! 目录哈希算法（`pom-dir-sha256-v1`）：
//! - 递归遍历目录内所有普通文件，相对路径统一为 `/` 分隔并按字典序排序；
//! - 对每个文件依次写入：相对路径、`\0`、文件长度（u64 LE）、`\0`、文件内容、`\0`；
//! - 结果取 SHA-256 十六进制。
//!
//! 与「只校验入口文件」相比，任何静态资源、样式或子文件的增删改都会被检出。
//! 遇到符号链接直接拒绝（安装阶段同样拒绝，避免把外部文件算进来）。

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::AppError;

/// 计算目录哈希。目录不存在或包含符号链接时返回错误。
pub fn compute_dir_hash(root: &Path) -> Result<String, AppError> {
    if !root.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "插件目录不存在: {}",
            root.display()
        )));
    }

    let mut files: Vec<(String, PathBuf, u64)> = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (relative, path, size) in files {
        let bytes = fs::read(&path)?;
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);
        hasher.update(size.to_le_bytes());
        hasher.update([0u8]);
        hasher.update(&bytes);
        hasher.update([0u8]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 校验目录哈希；`expected` 为空表示历史上未记录哈希，跳过校验。
pub fn verify_dir(root: &Path, expected: &str) -> Result<(), AppError> {
    if expected.is_empty() {
        return Ok(());
    }
    let actual = compute_dir_hash(root)?;
    if actual != expected {
        return Err(AppError::InvalidInput(format!(
            "插件完整性校验失败：期望 {}，实际 {}",
            &expected[..expected.len().min(12)],
            &actual[..actual.len().min(12)],
        )));
    }
    Ok(())
}

/// 插件根目录下的管理目录：存放历史版本归档，不参与内容哈希。
const RESERVED_MANAGEMENT_DIR: &str = "versions";

fn collect_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, PathBuf, u64)>,
) -> Result<(), AppError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        // 仅跳过根级 versions/（插件自身的回滚归档），插件包内同名子目录不受影响
        if dir == root
            && ty.is_dir()
            && entry.file_name().to_string_lossy() == RESERVED_MANAGEMENT_DIR
        {
            continue;
        }
        if ty.is_symlink() {
            return Err(AppError::InvalidInput(format!(
                "插件目录不允许包含符号链接: {}",
                entry.path().display()
            )));
        }
        let path = entry.path();
        if ty.is_dir() {
            collect_files(root, &path, out)?;
        } else if ty.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| AppError::Custom("无法计算插件相对路径".into()))?
                .to_string_lossy()
                .replace('\\', "/");
            let size = entry.metadata()?.len();
            out.push((relative, path, size));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pom-integrity-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(root: &Path, name: &str, content: &[u8]) {
        let path = root.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = fs::File::create(path).unwrap();
        file.write_all(content).unwrap();
    }

    #[test]
    fn hash_is_deterministic_and_order_independent() {
        let dir = temp_dir("stable");
        write_file(&dir, "b.js", b"console.log('b')");
        write_file(&dir, "a.js", b"console.log('a')");
        let first = compute_dir_hash(&dir).unwrap();
        let second = compute_dir_hash(&dir).unwrap();
        assert_eq!(first, second);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hash_changes_when_any_file_changes() {
        let dir = temp_dir("change");
        write_file(&dir, "plugin.json", b"{}");
        write_file(&dir, "assets/icon.svg", b"<svg/>");
        let before = compute_dir_hash(&dir).unwrap();

        write_file(&dir, "assets/icon.svg", b"<svg fill='red'/>");
        let after = compute_dir_hash(&dir).unwrap();
        assert_ne!(before, after, "非入口文件被修改也必须检出");

        write_file(&dir, "assets/extra.txt", b"extra");
        let with_extra = compute_dir_hash(&dir).unwrap();
        assert_ne!(after, with_extra, "新增文件也必须检出");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hash_ignores_root_versions_archive() {
        let dir = temp_dir("versions");
        write_file(&dir, "main.js", b"module.exports = {}");
        let before = compute_dir_hash(&dir).unwrap();

        write_file(&dir, "versions/1.0.0/main.js", b"old");
        let after = compute_dir_hash(&dir).unwrap();
        assert_eq!(before, after, "回滚归档目录不应影响内容哈希");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_accepts_matching_and_skips_empty() {
        let dir = temp_dir("verify");
        write_file(&dir, "main.js", b"module.exports = {}");
        let hash = compute_dir_hash(&dir).unwrap();

        assert!(verify_dir(&dir, &hash).is_ok());
        assert!(verify_dir(&dir, "").is_ok());
        assert!(verify_dir(&dir, "deadbeef").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
