//! 本地离线 ASR 资源管理：引擎（sherpa-onnx 预编译 CLI）与模型（SenseVoice Small INT8）。
//!
//! 设计约束：
//! - **不进入安装包**：引擎压缩包与模型权重都在首次启用时按需下载到 `<data_dir>/asr/`；
//! - **零编译期依赖**：引擎直接使用官方预编译 CLI（tar.bz2），避免 onnxruntime /
//!   libclang 之类的本地构建工具链要求；
//! - **可校验**：下载完成后按响应 ETag（HuggingFace / GitHub 为 sha256）与内容长度校验；
//! - **可观测**：下载过程中通过 `asr-local:progress` 事件回报进度。
//!
//! 目录：
//! ```text
//! <data_dir>/asr/
//! ├── engine/                        # 解压后的 CLI 包（递归查找 sherpa-onnx-offline[.exe]）
//! ├── models/sensevoice-small-int8/  # model.int8.onnx + tokens.txt
//! ├── tmp/                           # 下载临时文件（.part）
//! └── manifest.json                  # 最近一次完整下载记录
//! ```

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::error::AppError;
use crate::models::{AsrLocalProgress, AsrLocalModelStatus};
use crate::services::http_client;

pub const MODEL_ID: &str = "sensevoice-small-int8";
pub const MODEL_NAME: &str = "SenseVoice Small (INT8)";
pub const PROGRESS_EVENT: &str = "asr-local:progress";

/// 引擎版本（固定，避免上游格式漂移）。改版本时同步更新下方 `engine_asset`。
const ENGINE_VERSION: &str = "v2.0.3";
const ENGINE_APPROX_BYTES: u64 = 26 * 1024 * 1024;
const MODEL_APPROX_BYTES: u64 = 240 * 1024 * 1024;
/// 完整性下限：INT8 模型约 228MB，低于 50MB 视为损坏/占位文件
const MODEL_MIN_BYTES: u64 = 50 * 1024 * 1024;
const TOKENS_MIN_BYTES: u64 = 1_000;

const HF_REPO: &str = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
/// 主源 + 国内镜像；按顺序尝试
const HF_HOSTS: [&str; 2] = ["https://huggingface.co", "https://hf-mirror.com"];
const MODEL_FILES: [&str; 2] = ["model.int8.onnx", "tokens.txt"];

/// 防止重复下载（UI 连点 / 多窗口）
static DOWNLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ─── 路径 ────────────────────────────────────────────

pub fn root_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("asr")
}

pub fn engine_dir(data_dir: &Path) -> PathBuf {
    root_dir(data_dir).join("engine")
}

pub fn model_dir(data_dir: &Path) -> PathBuf {
    root_dir(data_dir).join("models").join(MODEL_ID)
}

fn tmp_dir(data_dir: &Path) -> PathBuf {
    root_dir(data_dir).join("tmp")
}

/// 引擎预编译包文件名（按目标平台）。
fn engine_asset() -> Option<&'static str> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some("sherpa-onnx-v2.0.3-win-x64-shared-MD-Release-no-tts.tar.bz2");
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some("sherpa-onnx-v2.0.3-osx-arm64-shared-no-tts.tar.bz2");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some("sherpa-onnx-v2.0.3-osx-x64-shared-no-tts.tar.bz2");
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Some("sherpa-onnx-v2.0.3-linux-x64-shared-no-tts.tar.bz2");
    }
    #[allow(unreachable_code)]
    None
}

// ─── 状态 ────────────────────────────────────────────

pub fn status(data_dir: &Path) -> AsrLocalModelStatus {
    let engine = find_engine_binary(&engine_dir(data_dir));
    let model = model_dir(data_dir).join("model.int8.onnx");
    let tokens = model_dir(data_dir).join("tokens.txt");

    let engine_ready = engine.is_some();
    let model_ready = file_len(&model) >= MODEL_MIN_BYTES && file_len(&tokens) >= TOKENS_MIN_BYTES;
    let ready = engine_ready && model_ready;

    let message = if ready {
        None
    } else if !engine_ready {
        Some("识别引擎未下载".to_string())
    } else {
        Some("语音模型未下载".to_string())
    };

    AsrLocalModelStatus {
        model_id: MODEL_ID.into(),
        model_name: MODEL_NAME.into(),
        ready,
        engine_ready,
        model_ready,
        bytes_on_disk: dir_size(&engine_dir(data_dir))
            + file_len(&model)
            + file_len(&tokens),
        approx_bytes: ENGINE_APPROX_BYTES + MODEL_APPROX_BYTES,
        message,
    }
}

/// 递归查找 CLI 可执行文件（包内目录层级随版本变化，不做硬编码）。
pub fn find_engine_binary(dir: &Path) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            let stem = name.strip_suffix(".exe").unwrap_or(name);
            if stem == "sherpa-onnx-offline" {
                return Some(path);
            }
        }
    }
    None
}

// ─── 下载 ────────────────────────────────────────────

pub async fn download(app: &AppHandle, data_dir: &Path) -> Result<(), AppError> {
    let _guard = DOWNLOAD_LOCK
        .try_lock()
        .map_err(|_| AppError::Custom("本地模型正在下载中".into()))?;

    let asset = engine_asset().ok_or_else(|| {
        AppError::Custom("当前平台暂不支持本地离线识别（仅 Windows x64 / macOS / Linux x64）".into())
    })?;

    fs::create_dir_all(tmp_dir(data_dir))?;
    let client = http_client::shared();

    // 1. 引擎
    let engine_path = engine_dir(data_dir);
    if find_engine_binary(&engine_path).is_none() {
        let archive = tmp_dir(data_dir).join(asset);
        let url = format!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/{ENGINE_VERSION}/{asset}"
        );
        download_file(app, client, &[url], &archive, 1_000_000, "engine", asset).await?;

        emit(app, progress("extracting", asset, 0, 0));
        extract_engine(&archive, &engine_path)?;
        let _ = fs::remove_file(&archive);

        if find_engine_binary(&engine_path).is_none() {
            return Err(AppError::Custom(
                "引擎包解压完成，但未找到 sherpa-onnx-offline 可执行文件".into(),
            ));
        }
    }

    // 2. 模型
    let models = model_dir(data_dir);
    fs::create_dir_all(&models)?;
    for file in MODEL_FILES {
        let dest = models.join(file);
        let min = if file.ends_with(".onnx") {
            MODEL_MIN_BYTES
        } else {
            TOKENS_MIN_BYTES
        };
        if file_len(&dest) >= min {
            continue;
        }
        let urls: Vec<String> = HF_HOSTS
            .iter()
            .map(|h| format!("{h}/{HF_REPO}/resolve/main/{file}"))
            .collect();
        download_file(app, client, &urls, &dest, min, "model", file).await?;
    }

    // 3. 记录清单
    let manifest = Manifest {
        model_id: MODEL_ID,
        engine_version: ENGINE_VERSION,
        downloaded_at: chrono_now(),
    };
    let _ = fs::write(
        root_dir(data_dir).join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    );

    emit(app, progress("done", "", 0, 0));
    log::info!("本地 ASR 资源下载完成: {}", root_dir(data_dir).display());
    Ok(())
}

pub fn remove(data_dir: &Path) -> Result<bool, AppError> {
    let root = root_dir(data_dir);
    if !root.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&root)?;
    Ok(true)
}

async fn download_file(
    app: &AppHandle,
    client: &reqwest::Client,
    urls: &[String],
    dest: &Path,
    min_bytes: u64,
    stage: &str,
    file: &str,
) -> Result<(), AppError> {
    let mut last_err = String::new();
    for url in urls {
        match download_one(app, client, url, dest, min_bytes, stage, file).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                log::warn!("下载失败（将尝试下一个源）{url}: {e}");
                last_err = format!("{url}: {e}");
            }
        }
    }
    Err(AppError::Custom(format!("下载失败：{last_err}")))
}

async fn download_one(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    min_bytes: u64,
    stage: &str,
    file: &str,
) -> Result<(), AppError> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("连接下载源失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Custom(format!("下载源返回 HTTP {}", resp.status())));
    }

    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string());
    let total = resp.content_length().unwrap_or(0);

    let part = part_path(dest);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut out = tokio::fs::File::create(&part)
        .await
        .map_err(|e| AppError::Custom(format!("创建临时文件失败: {e}")))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Custom(format!("下载中断: {e}")))?;
        hasher.update(&chunk);
        out.write_all(&chunk)
            .await
            .map_err(|e| AppError::Custom(format!("写入失败: {e}")))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(200) {
            emit(app, progress(stage, file, downloaded, total));
            last_emit = Instant::now();
        }
    }
    drop(out);

    if downloaded < min_bytes {
        let _ = fs::remove_file(&part);
        return Err(AppError::Custom(format!(
            "下载内容不完整（{downloaded} 字节）"
        )));
    }

    // ETag 校验：GitHub / HuggingFace 的 LFS 资源 ETag 即 sha256
    let digest = hex_lower(&hasher.finalize());
    if let Some(etag) = etag.as_deref() {
        if is_sha256_hex(etag) && !etag.eq_ignore_ascii_case(&digest) {
            let _ = fs::remove_file(&part);
            return Err(AppError::Custom("下载文件校验失败（sha256 不匹配）".into()));
        }
    }

    // Windows 上 rename 不能覆盖已存在文件
    if dest.exists() {
        let _ = fs::remove_file(dest);
    }
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| AppError::Custom(format!("保存文件失败: {e}")))?;

    emit(app, progress(stage, file, downloaded, total.max(downloaded)));
    Ok(())
}

fn extract_engine(archive: &Path, dest: &Path) -> Result<(), AppError> {
    let staging = dest.with_extension("staging");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;

    let file = fs::File::open(archive)
        .map_err(|e| AppError::Custom(format!("打开引擎包失败: {e}")))?;
    let decoder = bzip2::read::BzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(&staging)
        .map_err(|e| AppError::Custom(format!("解压引擎包失败: {e}")))?;

    if dest.exists() {
        fs::remove_dir_all(dest)?;
    }
    fs::rename(&staging, dest).map_err(|e| AppError::Custom(format!("安装引擎失败: {e}")))?;
    Ok(())
}

// ─── 工具 ────────────────────────────────────────────

fn progress(stage: &str, file: &str, downloaded: u64, total: u64) -> AsrLocalProgress {
    let percent = if total > 0 {
        (downloaded as f64 / total as f64 * 100.0).min(100.0)
    } else {
        0.0
    };
    AsrLocalProgress {
        model_id: MODEL_ID.into(),
        stage: stage.into(),
        file: file.into(),
        downloaded,
        total,
        percent,
    }
}

fn emit(app: &AppHandle, payload: AsrLocalProgress) {
    let _ = app.emit(PROGRESS_EVENT, payload);
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                total += file_len(&path);
            }
        }
    }
    total
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn chrono_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    model_id: &'static str,
    engine_version: &'static str,
    downloaded_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_asset_is_known_on_desktop() {
        // 测试机为 Windows x64 / macOS / Linux 之一
        let asset = engine_asset();
        assert!(asset.is_some(), "桌面平台应配置引擎包");
        assert!(asset.unwrap().ends_with(".tar.bz2"));
    }

    #[test]
    fn find_engine_binary_scans_nested_dirs() {
        let dir = std::env::temp_dir().join(format!(
            "kb-asr-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let nested = dir.join("bin").join("x64");
        fs::create_dir_all(&nested).unwrap();
        let exe = nested.join(if cfg!(windows) {
            "sherpa-onnx-offline.exe"
        } else {
            "sherpa-onnx-offline"
        });
        fs::write(&exe, b"stub").unwrap();

        assert_eq!(find_engine_binary(&dir), Some(exe));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn status_reports_missing_model() {
        let dir = std::env::temp_dir().join(format!(
            "kb-asr-status-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let status = status(&dir);
        assert!(!status.ready);
        assert!(!status.engine_ready);
        assert!(!status.model_ready);
        assert!(status.message.unwrap().contains("引擎"));
    }

    #[test]
    fn sha256_hex_shape() {
        assert!(is_sha256_hex(&"a".repeat(64)));
        assert!(!is_sha256_hex(&"a".repeat(63)));
        assert!(!is_sha256_hex(&"g".repeat(64)));
    }

    #[test]
    fn part_path_appends_suffix() {
        let p = part_path(Path::new("C:/x/model.int8.onnx"));
        assert!(p.to_string_lossy().ends_with("model.int8.onnx.part"));
    }
}
