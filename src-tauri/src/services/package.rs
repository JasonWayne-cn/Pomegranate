//! 安装包类型识别。
//!
//! 只读取 zip 中央目录中的文件名，不解压，用于前端“统一安装包”入口
//! 自动判断应走插件安装还是扩展安装。

use std::fs;
use std::path::PathBuf;

use crate::error::AppError;
use crate::models::PackageKind;

const PLUGIN_MANIFEST: &str = "plugin.json";
const EXTENSION_MANIFEST: &str = "extension.json";

pub fn detect_kind(zip_path: &str) -> Result<PackageKind, AppError> {
    let path = PathBuf::from(zip_path);
    if !path.is_file() {
        return Err(AppError::InvalidInput("安装包必须是 zip 文件".into()));
    }
    let is_zip = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);
    if !is_zip {
        return Err(AppError::InvalidInput("安装包必须是 .zip 文件".into()));
    }

    let file = fs::File::open(&path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::InvalidInput(format!("无法读取 zip 压缩包: {e}")))?;

    let mut has_plugin = false;
    let mut has_extension = false;
    for i in 0..archive.len() {
        let entry = archive.by_index(i)?;
        let name = entry.name().replace('\\', "/");
        if name.starts_with("__MACOSX/") {
            continue;
        }
        // 与安装器保持一致：清单允许位于 zip 根目录或唯一一层文件夹内。
        let parts: Vec<&str> = name
            .trim_start_matches("./")
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        let file_name = match parts.as_slice() {
            [file] => *file,
            [_dir, file] => *file,
            _ => continue,
        };
        if file_name == PLUGIN_MANIFEST {
            has_plugin = true;
        } else if file_name == EXTENSION_MANIFEST {
            has_extension = true;
        }
    }

    match (has_plugin, has_extension) {
        (true, true) => Err(AppError::InvalidInput(
            "压缩包同时包含 plugin.json 与 extension.json，无法自动识别类型".into(),
        )),
        (true, false) => Ok(PackageKind::Plugin),
        (false, true) => Ok(PackageKind::Extension),
        (false, false) => Err(AppError::InvalidInput(
            "压缩包根目录缺少 plugin.json 或 extension.json".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;
    use uuid::Uuid;

    fn write_zip(dir: &Path, files: &[(&str, &str)]) -> PathBuf {
        let zip_path = dir.join("pack.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in files {
            zip.start_file(*name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        zip_path
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pom-package-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_plugin_at_root() {
        let dir = temp_dir("plugin");
        let zip = write_zip(&dir, &[("plugin.json", "{}"), ("main.js", "")]);
        assert_eq!(
            detect_kind(zip.to_str().unwrap()).unwrap(),
            PackageKind::Plugin
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_extension_in_nested_folder() {
        let dir = temp_dir("extension");
        let zip = write_zip(
            &dir,
            &[("ppt-master/extension.json", "{}"), ("ppt-master/entry.py", "")],
        );
        assert_eq!(
            detect_kind(zip.to_str().unwrap()).unwrap(),
            PackageKind::Extension
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_ambiguous_package() {
        let dir = temp_dir("ambiguous");
        let zip = write_zip(
            &dir,
            &[("plugin.json", "{}"), ("extension.json", "{}")],
        );
        assert!(detect_kind(zip.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_missing_manifest() {
        let dir = temp_dir("missing");
        let zip = write_zip(&dir, &[("readme.txt", "hello")]);
        assert!(detect_kind(zip.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
