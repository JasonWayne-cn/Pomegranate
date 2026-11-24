//! 本地离线识别：调用 sherpa-onnx 官方 `sherpa-onnx-offline` CLI。
//!
//! 为什么走子进程而不是 Rust 绑定：
//! - `sherpa-rs` 的构建脚本依赖本机 libclang（bindgen），对贡献者和 CI 都是额外门槛；
//! - 官方预编译 CLI 与模型一样按需下载，编译期零依赖、失败可换源；
//! - 代价是每次识别多一次进程启动（约几十毫秒），对听写场景可接受。
//!
//! 输入要求：16kHz 单声道 PCM16 WAV（前端 `blobToWav16kBase64` 已保证）。
//! 输出解析：CLI 在 stdout 打印若干日志行 + 一行 JSON 结果，这里按 JSON 提取 `text`。

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tokio::process::Command;

use crate::error::AppError;
use crate::models::TranscribeResult;

use super::local_model;

/// 单次识别超时（含模型加载）
const CLI_TIMEOUT_SECS: u64 = 180;

pub async fn transcribe(
    data_dir: &Path,
    audio_b64: &str,
    mime: &str,
    language: Option<&str>,
) -> Result<TranscribeResult, AppError> {
    let status = local_model::status(data_dir);
    if !status.ready {
        return Err(AppError::InvalidInput(
            status
                .message
                .unwrap_or_else(|| "本地语音模型未就绪".into()),
        ));
    }

    // 本地引擎需要标准 WAV；前端 WAV 转换失败回退 webm 时给出明确提示
    if !mime.starts_with("audio/wav") {
        return Err(AppError::InvalidInput(
            "本地离线识别需要 WAV 音频，请在设置中改用云端服务或重试录音".into(),
        ));
    }

    let engine = local_model::find_engine_binary(&local_model::engine_dir(data_dir))
        .ok_or_else(|| AppError::Custom("未找到本地识别引擎，请重新下载".into()))?;
    let models = local_model::model_dir(data_dir);
    let model = models.join("model.int8.onnx");
    let tokens = models.join("tokens.txt");

    let audio = STANDARD
        .decode(audio_b64)
        .map_err(|e| AppError::Custom(format!("音频解码失败: {e}")))?;

    let tmp_dir = local_model::root_dir(data_dir).join("tmp");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|e| AppError::Custom(format!("创建临时目录失败: {e}")))?;
    let tmp_path = tmp_dir.join(format!("in-{}.wav", unique_suffix()));
    tokio::fs::write(&tmp_path, &audio)
        .await
        .map_err(|e| AppError::Custom(format!("写入音频失败: {e}")))?;

    let started = Instant::now();
    let result = run_cli(&engine, &model, &tokens, &tmp_path, language).await;
    let _ = tokio::fs::remove_file(&tmp_path).await;

    let text = result?;
    Ok(TranscribeResult {
        text,
        latency_ms: started.elapsed().as_millis() as u64,
        model: local_model::MODEL_ID.into(),
    })
}

/// 构造 CLI 参数。
///
/// 注意 v2.x 把输入 wav 改成了**位置参数**（v1.x 的 `--input-wav=` 已被移除），
/// 因此 wav 必须追加在所有选项之后。
fn build_args(
    model: &Path,
    tokens: &Path,
    wav: &Path,
    language: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        format!("--tokens={}", tokens.display()),
        format!("--sense-voice-model={}", model.display()),
        "--num-threads=2".to_string(),
        // 数字/单位规范化（"二零二四" → "2024"）
        "--sense-voice-use-itn=true".to_string(),
    ];
    if let Some(lang) = language.filter(|l| !l.is_empty() && *l != "auto") {
        args.push(format!("--sense-voice-language={lang}"));
    }
    args.push(wav.display().to_string());
    args
}

async fn run_cli(
    engine: &Path,
    model: &Path,
    tokens: &Path,
    wav: &Path,
    language: Option<&str>,
) -> Result<String, AppError> {
    let mut cmd = Command::new(engine);
    cmd.args(build_args(model, tokens, wav, language))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // DLL/so 与可执行文件同目录，工作目录跟着引擎走
    if let Some(parent) = engine.parent() {
        cmd.current_dir(parent);
    }

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(Duration::from_secs(CLI_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| AppError::Custom("本地识别超时".into()))?
        .map_err(|e| AppError::Custom(format!("启动本地识别失败: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Custom(format!(
            "本地识别失败: {}",
            first_lines(&stderr, 3)
        )));
    }

    Ok(parse_cli_output(&String::from_utf8_lossy(&output.stdout)))
}

/// 从 CLI 输出中提取识别文本。
///
/// 兼容三种形态：
/// 1. 一行 JSON（v1.10+）：`{"lang":"zh","text":"你好",...}`
/// 2. 旧版 `xxx.wav result: 你好`
/// 3. 兜底：最后一行非空文本
pub fn parse_cli_output(stdout: &str) -> String {
    for line in stdout.lines() {
        let line = line.trim();
        if line.starts_with('{') {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
                    return text.trim().to_string();
                }
            }
        }
        if let Some(rest) = line.split_once("result:").map(|(_, r)| r.trim()) {
            if !rest.is_empty() && !rest.starts_with('{') {
                return rest.to_string();
            }
        }
    }

    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("--"))
        .unwrap_or("")
        .to_string()
}

fn first_lines(s: &str, n: usize) -> String {
    s.lines()
        .filter(|l| !l.trim().is_empty())
        .take(n)
        .collect::<Vec<_>>()
        .join(" | ")
}

fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_result() {
        let out = "--some log line\n{\"lang\": \"zh\", \"text\": \"你好世界\", \"tokens\": []}\n";
        assert_eq!(parse_cli_output(out), "你好世界");
    }

    #[test]
    fn parses_legacy_result_line() {
        assert_eq!(
            parse_cli_output("/tmp/a.wav result: 今天天气不错\n"),
            "今天天气不错"
        );
    }

    #[test]
    fn empty_output_returns_empty() {
        assert_eq!(parse_cli_output(""), "");
        assert_eq!(parse_cli_output("  \n\n"), "");
    }

    #[test]
    fn fallback_takes_last_text_line() {
        let out = "loading model\nall done, output saved\n识别完成\n";
        assert_eq!(parse_cli_output(out), "识别完成");
    }

    #[test]
    fn build_args_uses_positional_wav() {
        let args = build_args(
            Path::new("C:/m/model.int8.onnx"),
            Path::new("C:/m/tokens.txt"),
            Path::new("C:/tmp/in.wav"),
            Some("zh"),
        );
        // v2.x 已移除 --input-wav，wav 必须是最后一个位置参数
        assert!(!args.iter().any(|a| a.starts_with("--input-wav")));
        assert_eq!(args.last().unwrap(), "C:/tmp/in.wav");
        assert!(args.iter().any(|a| a == "--sense-voice-language=zh"));
        assert!(args.iter().any(|a| a.starts_with("--sense-voice-model=")));
    }

    #[test]
    fn build_args_skips_auto_language() {
        let args = build_args(
            Path::new("m.onnx"),
            Path::new("tokens.txt"),
            Path::new("in.wav"),
            Some("auto"),
        );
        assert!(!args.iter().any(|a| a.starts_with("--sense-voice-language")));
    }
}
