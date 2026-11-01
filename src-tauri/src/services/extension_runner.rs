//! 扩展包进程运行器。
//!
//! 约束：
//! - 只运行扩展清单声明的固定入口；
//! - 工作目录锁定在 job 目录；
//! - stdout/stderr 逐行转发为 Tauri 事件；
//! - 支持超时与取消（Windows 下杀进程树）。

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::models::extension::ExtensionInfo;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogPayload {
    job_id: String,
    stream: String,
    line: String,
}

#[derive(Debug, Default)]
pub struct RunOutcome {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub log_tail: String,
}

pub fn run(
    app: AppHandle,
    job_id: &str,
    extension: &ExtensionInfo,
    job_dir: &Path,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
) -> Result<RunOutcome, AppError> {
    let ext_root = std::fs::canonicalize(&extension.path)?;
    let entry = ext_root.join(&extension.manifest.runtime.entry);
    let entry = std::fs::canonicalize(&entry).map_err(|_| {
        AppError::NotFound(format!("扩展入口不存在: {}", entry.display()))
    })?;
    if !entry.starts_with(&ext_root) {
        return Err(AppError::InvalidInput("扩展入口路径越界".into()));
    }

    let job_file = job_dir.join("job.json");
    if !job_file.is_file() {
        return Err(AppError::NotFound(format!(
            "job.json 不存在: {}",
            job_file.display()
        )));
    }

    let (program, args) = command_for(extension, &ext_root, &entry, &job_file)?;

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(job_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 不继承宿主进程环境，避免 AI 密钥等敏感变量泄露给扩展。
    cmd.env_clear();
    for key in allowed_env_keys() {
        if let Ok(value) = std::env::var(key) {
            cmd.env(key, value);
        }
    }
    cmd.env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONPATH", &ext_root)
        .env("PPT_EXTENSION_ROOT", &ext_root)
        .env("PPT_JOB_DIR", job_dir);

    let logs_dir = job_dir.join("logs");
    std::fs::create_dir_all(&logs_dir)?;
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("engine.log"))?;
    let log_sink = Arc::new(Mutex::new(log_file));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        AppError::Custom(format!(
            "无法启动扩展进程: {} ({})",
            program.display(),
            e
        ))
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let tail = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    let out_handle = stdout.map(|stream| {
        spawn_reader(
            app.clone(),
            job_id.to_string(),
            "stdout",
            stream,
            tail.clone(),
            log_sink.clone(),
        )
    });
    let err_handle = stderr.map(|stream| {
        spawn_reader(
            app.clone(),
            job_id.to_string(),
            "stderr",
            stream,
            tail.clone(),
            log_sink.clone(),
        )
    });

    let started = Instant::now();
    let mut outcome = RunOutcome::default();
    loop {
        if cancel.load(Ordering::SeqCst) {
            outcome.cancelled = true;
            kill_tree(&mut child);
            break;
        }
        if started.elapsed() > timeout {
            outcome.timed_out = true;
            kill_tree(&mut child);
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                outcome.exit_code = status.code();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(AppError::Custom(format!("等待扩展进程失败: {e}"))),
        }
    }

    if let Some(handle) = out_handle {
        let _ = handle.join();
    }
    if let Some(handle) = err_handle {
        let _ = handle.join();
    }

    // 确保子进程已退出
    let _ = child.wait();

    if let Ok(lines) = tail.lock() {
        outcome.log_tail = lines.join("\n");
    }
    Ok(outcome)
}

fn command_for(
    extension: &ExtensionInfo,
    ext_root: &Path,
    entry: &Path,
    job_file: &Path,
) -> Result<(PathBuf, Vec<String>), AppError> {
    let runtime = &extension.manifest.runtime;
    if runtime.runtime_type == "executable" {
        return Ok((
            entry.to_path_buf(),
            vec!["--job".to_string(), job_file.to_string_lossy().to_string()],
        ));
    }

    let python = match runtime
        .python
        .as_ref()
        .and_then(|p| p.path.as_deref())
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        Some(relative) => {
            let candidate = ext_root.join(relative);
            let canonical = std::fs::canonicalize(&candidate).map_err(|_| {
                AppError::NotFound(format!("内嵌 Python 不存在: {}", candidate.display()))
            })?;
            if !canonical.starts_with(ext_root) {
                return Err(AppError::InvalidInput("内嵌 Python 路径越界".into()));
            }
            canonical
        }
        None => PathBuf::from(if cfg!(target_os = "windows") {
            "python"
        } else {
            "python3"
        }),
    };

    Ok((
        python,
        vec![
            entry.to_string_lossy().to_string(),
            "--job".to_string(),
            job_file.to_string_lossy().to_string(),
        ],
    ))
}

/// 传给扩展进程的最小环境变量集合；其余变量一律不继承。
fn allowed_env_keys() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &[
            "PATH",
            "SYSTEMROOT",
            "SYSTEMDRIVE",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "COMMONPROGRAMFILES",
            "PUBLIC",
            "COMSPEC",
            "PATHEXT",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
            "COMPUTERNAME",
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        &[
            "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "USER", "LOGNAME",
        ]
    }
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    job_id: String,
    stream: &'static str,
    input: R,
    tail: Arc<std::sync::Mutex<Vec<String>>>,
    log_sink: Arc<Mutex<std::fs::File>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let reader = BufReader::new(input);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Ok(mut buf) = tail.lock() {
                buf.push(line.clone());
                if buf.len() > 200 {
                    let drain = buf.len() - 200;
                    buf.drain(0..drain);
                }
            }
            if let Ok(mut file) = log_sink.lock() {
                let _ = writeln!(file, "[{stream}] {line}");
                let _ = file.flush();
            }
            let payload = LogPayload {
                job_id: job_id.clone(),
                stream: stream.to_string(),
                line,
            };
            let _ = app.emit("ppt-extension://log", payload);
        }
    })
}

fn kill_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let pid = child.id().to_string();
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid, "/T", "/F"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
    }
}
