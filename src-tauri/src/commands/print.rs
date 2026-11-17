//! R-005b 专用打印窗口命令。
//!
//! 为什么单独开窗口：WebView2 里 `window.print()` 会阻塞调用它的渲染进程。
//! 在主窗口的隐藏 iframe 上打印后，用户关闭打印对话框仍可能卡住主 WebView
//! 数十秒，表现为「打印 / 导出一次之后再点任何菜单都没反应」。把打印放进
//! 独立窗口后，阻塞只影响该窗口，主窗保持可交互。

use crate::state::AppState;
use std::path::PathBuf;

const PRINT_TEMP_DIR: &str = "print-temp";
/// 打印临时文件保留上限：超过一天的残留（窗口异常退出未清理）下次打开时删除。
const PRINT_TEMP_MAX_AGE_SECS: u64 = 24 * 60 * 60;

fn print_temp_dir(state: &AppState) -> PathBuf {
    state.data_dir.join(PRINT_TEMP_DIR)
}

/// 校验窗口 label 并返回对应临时 HTML 路径，避免通过 label 读取任意文件。
fn print_file_for_label(state: &AppState, label: &str) -> Result<PathBuf, String> {
    let valid = label.starts_with("print-")
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err("非法打印窗口标识".into());
    }
    Ok(print_temp_dir(state).join(format!("{label}.html")))
}

/// 打开专用打印窗口：把自包含 HTML 落盘，再创建独立 WebView 打开打印页。
#[tauri::command(async)]
pub fn open_print_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    html: String,
    title: String,
) -> Result<(), String> {
    let dir = print_temp_dir(&state);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建打印临时目录失败: {e}"))?;
    cleanup_stale_files(&dir);

    let ts = chrono::Utc::now().timestamp_millis();
    let label = format!("print-{ts}");
    let file = dir.join(format!("{label}.html"));
    std::fs::write(&file, html).map_err(|e| format!("写入打印临时文件失败: {e}"))?;

    let title = title.trim();
    let window_label = label.clone();
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html#/print".into()),
    )
    .title(if title.is_empty() { "打印" } else { title })
    .inner_size(1000.0, 760.0)
    .center()
    .build()
    .map_err(|e| {
        let _ = std::fs::remove_file(&file);
        format!("创建打印窗口失败（{window_label}）: {e}")
    })?;
    let _ = win.set_focus();
    Ok(())
}

/// 打印页读取自己对应的 HTML 内容。
///
/// 不走 asset:// 文件 URL：iframe 跨源时无法调用 `contentWindow.print()`；
/// 返回字符串后前端用同源 `srcdoc` 渲染，打印调用不受跨源限制。
#[tauri::command(async)]
pub fn print_page_html(
    state: tauri::State<'_, AppState>,
    label: String,
) -> Result<String, String> {
    let path = print_file_for_label(&state, &label)?;
    std::fs::read_to_string(&path).map_err(|e| {
        format!("读取打印内容失败（可能已过期，请重新发起打印）: {e}")
    })
}

/// 打印完成后清理临时文件。
#[tauri::command]
pub fn print_page_done(
    state: tauri::State<'_, AppState>,
    label: String,
) -> Result<(), String> {
    let path = print_file_for_label(&state, &label)?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

/// 清理超过保留期的打印临时文件（窗口被强杀时不会执行前端清理）。
fn cleanup_stale_files(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age.as_secs() > PRINT_TEMP_MAX_AGE_SECS {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
