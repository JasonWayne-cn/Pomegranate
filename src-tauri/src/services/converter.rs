//! .doc → .docx 转换器
//!
//! 检测顺序（首个可用即胜出）：
//! 1. **LibreOffice** (`soffice`)：跨平台，纯命令行 headless
//! 2. **Windows COM** (`Word.Application` / WPS 兼容 ProgId)：仅 Windows。
//!    通过 `cscript` 晚绑定调用，**不经过** `Microsoft.Office.Interop.Word` PIA ——
//!    本机 `Word.Application` 被 WPS 接管时 PIA 常因类型库损坏抛
//!    `TYPE_E_CANTLOADLIBRARY`，PowerShell 的 `New-Object -ComObject` 会踩中。
//!
//! 检测结果用 `OnceLock` 缓存，避免每次都探测一遍。
//! 设环境变量 `KB_FORCE_NATIVE_WORD_EXPORT=1` 可强制跳过转换器（测试原生导出用）。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DocConverter {
    LibreOffice,
    // 仅在 Windows 上构造；非 Windows 仍在 match 中引用，所以保留变体但抑制 dead_code
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    WindowsCom,
    None,
}

/// Word COM ProgId 候选列表（按优先级，覆盖 Office + 各种 WPS 版本）
///
/// 注意：ProgId 是大小写不敏感的，但 PowerShell `New-Object -ComObject` 仍按字面值匹配。
#[cfg(target_os = "windows")]
const WORD_PROGIDS: &[&str] = &[
    "Word.Application",   // Microsoft Office Word
    "KWps.Application",   // WPS Office 文字（旧版常见）
    "Wps.Application",    // WPS Office 通用
    "Kwps.Application",   // 大小写变体
    "KingsoftOffice.Wps", // 金山办公早期
    "WPS.Application",    // 又一个变体
];

static CONVERTER: OnceLock<DocConverter> = OnceLock::new();
#[cfg(target_os = "windows")]
static AVAILABLE_PROGID: OnceLock<Option<String>> = OnceLock::new();

/// 测试/排障开关：设为 `1` / `true` 时跳过系统转换器，强制走内置 docx 生成器。
///
/// 为什么需要它：本机装了 WPS/Office 时 `detect_converter()` 会成功，原生回退路径
/// 就永远不会被执行；排查原生导出或跑回归时需要一个显式开关，而不是卸软件。
fn force_native() -> bool {
    matches!(
        std::env::var("KB_FORCE_NATIVE_WORD_EXPORT"),
        Ok(v) if v == "1" || v.eq_ignore_ascii_case("true")
    )
}

/// 检测当前系统可用的 .doc 转换器（首次调用会探测，后续走缓存）
pub fn detect_converter() -> DocConverter {
    *CONVERTER.get_or_init(|| {
        if force_native() {
            log::info!(
                "KB_FORCE_NATIVE_WORD_EXPORT 已设置，跳过系统转换器，强制使用内置 docx 生成器"
            );
            return DocConverter::None;
        }
        if has_libreoffice() {
            log::info!("检测到 LibreOffice，将用于 .doc 转换");
            return DocConverter::LibreOffice;
        }
        #[cfg(target_os = "windows")]
        if let Some(progid) = detect_word_com_progid() {
            log::info!("检测到 Windows COM ProgId: {}", progid);
            return DocConverter::WindowsCom;
        }
        log::warn!("未检测到 .doc 转换器，.doc 文件将仅作为附件保存");
        DocConverter::None
    })
}

/// 把 LibreOffice / Word 能打开的任意文档（含 `.html`）转换为 `.docx`，
/// 输出到 `dst_dir`，返回输出文件绝对路径。
///
/// 本质与 [`convert_doc_to_docx`] 相同（转换器对输入类型不挑食，靠扩展名/内容自动识别），
/// 单独命名是为了让「笔记 HTML → docx」这条导出路径在调用处语义清晰。
pub fn convert_to_docx(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    convert_doc_to_docx(src, dst_dir)
}

/// 把 `.doc` 转换为 `.docx`，输出到 `dst_dir`，返回输出文件绝对路径
pub fn convert_doc_to_docx(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    if !src.exists() {
        return Err(AppError::NotFound(format!(
            "源文件不存在: {}",
            src.display()
        )));
    }
    std::fs::create_dir_all(dst_dir)?;

    match detect_converter() {
        DocConverter::LibreOffice => convert_via_libreoffice(src, dst_dir),
        DocConverter::WindowsCom => {
            #[cfg(target_os = "windows")]
            {
                convert_via_windows_com(src, dst_dir)
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(AppError::Custom("WindowsCom 仅支持 Windows".into()))
            }
        }
        DocConverter::None => Err(AppError::Custom(
            "未检测到 .doc 转换器，请安装 Microsoft Office 或 WPS Office（含 OLE 自动化组件）"
                .into(),
        )),
    }
}

// ─── 诊断报告（前端可调用） ──────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComProgIdAttempt {
    pub progid: String,
    pub ok: bool,
    /// 失败时的具体错误（PowerShell stderr）
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConverterDiagnostic {
    /// LibreOffice 可执行文件路径（找到才有值）
    pub libre_office_path: Option<String>,
    /// 每个 Word ProgId 的实测结果（仅 Windows）
    pub com_attempts: Vec<ComProgIdAttempt>,
    /// 当前最终选用的转换器
    pub active: DocConverter,
}

/// 生成诊断报告供前端展示（每次调用都会**重新探测每个 ProgId**，不走缓存）
pub fn diagnose() -> ConverterDiagnostic {
    let lo = libreoffice_exe();
    let lo_opt = if lo.is_empty() { None } else { Some(lo) };

    #[cfg(target_os = "windows")]
    let attempts: Vec<ComProgIdAttempt> = WORD_PROGIDS
        .iter()
        .map(|p| match try_instantiate(p) {
            Ok(_) => ComProgIdAttempt {
                progid: p.to_string(),
                ok: true,
                error: None,
            },
            Err(e) => ComProgIdAttempt {
                progid: p.to_string(),
                ok: false,
                error: Some(e),
            },
        })
        .collect();
    #[cfg(not(target_os = "windows"))]
    let attempts: Vec<ComProgIdAttempt> = Vec::new();

    ConverterDiagnostic {
        libre_office_path: lo_opt,
        com_attempts: attempts,
        active: detect_converter(),
    }
}

// ─── LibreOffice ───────────────────────────────────────

fn has_libreoffice() -> bool {
    !libreoffice_exe().is_empty()
}

/// 返回可用的 LibreOffice 可执行路径，若都找不到返回空字符串
fn libreoffice_exe() -> String {
    if try_run("soffice", &["--version"]) {
        return "soffice".into();
    }
    #[cfg(target_os = "windows")]
    {
        for p in [
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ] {
            if Path::new(p).exists() {
                return p.into();
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let p = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
        if Path::new(p).exists() {
            return p.into();
        }
    }
    String::new()
}

fn convert_via_libreoffice(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    let exe = libreoffice_exe();
    if exe.is_empty() {
        return Err(AppError::Custom("LibreOffice 不可用".into()));
    }
    let mut cmd = Command::new(&exe);
    cmd.args([
        "--headless",
        "--convert-to",
        "docx",
        "--outdir",
        &dst_dir.to_string_lossy(),
        &src.to_string_lossy(),
    ]);
    add_no_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| AppError::Custom(format!("LibreOffice 启动失败: {}", e)))?;
    if !output.status.success() {
        return Err(AppError::Custom(format!(
            "LibreOffice 转换失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    expected_output(src, dst_dir)
}

// ─── Windows COM ───────────────────────────────────────

/// 探测系统上第一个可实例化的 Word ProgId，缓存结果
#[cfg(target_os = "windows")]
fn detect_word_com_progid() -> Option<String> {
    AVAILABLE_PROGID
        .get_or_init(|| {
            for progid in WORD_PROGIDS {
                if try_instantiate(progid).is_ok() {
                    return Some(progid.to_string());
                }
            }
            None
        })
        .clone()
}

/// 把一个字符串包成 VBScript 字符串字面量（内部双引号双写）。
///
/// Windows 文件名本身不允许 `"`，这里仍做转义，避免将来传入来自配置/剪贴板的
/// 路径时把脚本结构撑破。
#[cfg(target_os = "windows")]
fn vbs_literal(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// cscript 在中文 Windows 上按控制台代码页输出；先按 UTF-8 解，失败回落 GBK。
#[cfg(target_os = "windows")]
fn decode_console(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (cow, _, _) = encoding_rs::GBK.decode(bytes);
            cow.into_owned()
        }
    }
}

/// 运行一段 VBScript，成功返回 Ok；失败带回 cscript 的输出（含 HRESULT）。
///
/// **为什么要绕到 VBScript**：本机 `Word.Application` 的 CLSID 被 WPS 接管，而
/// PowerShell 的 `New-Object -ComObject` 在访问 `.Visible` / `.DisplayAlerts` 时会
/// 绑定到 `Microsoft.Office.Interop.Word` 的 PIA；该 PIA 类型库损坏时直接抛
/// `TYPE_E_CANTLOADLIBRARY`，WPS 本身其实可用。cscript 是纯晚绑定（IDispatch），
/// 完全不经过 PIA，实测能正常完成 HTML → DOCX。
#[cfg(target_os = "windows")]
fn run_vbs(script: &str) -> Result<(), String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("kb_com_vbs_{}", nanos));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let path = dir.join("run.vbs");
    std::fs::write(&path, script.as_bytes()).map_err(|e| format!("写 VBS 脚本失败: {}", e))?;

    let mut cmd = Command::new("cscript");
    cmd.args(["//nologo", "//B", &path.to_string_lossy()]);
    add_no_window(&mut cmd);
    let output = cmd.output();
    let _ = std::fs::remove_dir_all(&dir);

    let output = output.map_err(|e| {
        format!(
            "cscript 启动失败: {}（Windows 上 VBScript 可能已被移除，请安装 LibreOffice 或 Office/WPS）",
            e
        )
    })?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = decode_console(&output.stdout);
    let stderr = decode_console(&output.stderr);
    let message = if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        format!("cscript 退出码 {:?}", output.status.code())
    };
    Err(message)
}

/// 实测一个 ProgId 是否能创建 + 退出。失败时返回 cscript 输出（含 HRESULT 等）。
#[cfg(target_os = "windows")]
fn try_instantiate(progid: &str) -> Result<(), String> {
    let script = format!(
        "On Error Resume Next\r\n\
         Dim app\r\n\
         Set app = CreateObject({})\r\n\
         If Err.Number <> 0 Then\r\n\
           WScript.Echo \"ERR:\" & Err.Number & \":\" & Err.Description\r\n\
           WScript.Quit 1\r\n\
         End If\r\n\
         app.Visible = False\r\n\
         app.DisplayAlerts = 0\r\n\
         app.Quit\r\n\
         WScript.Quit 0\r\n",
        vbs_literal(progid)
    );
    run_vbs(&script)
}

#[cfg(target_os = "windows")]
fn convert_via_windows_com(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    let progid = detect_word_com_progid().ok_or_else(|| {
        AppError::Custom("Windows COM 不可用：未检测到任何 Word.Application 等 ProgId".into())
    })?;
    let out_path = expected_output(src, dst_dir)?;

    // wdFormatXMLDocument = 16 (.docx)
    let script = format!(
        "On Error Resume Next\r\n\
         Dim app, doc\r\n\
         Set app = CreateObject({progid})\r\n\
         If Err.Number <> 0 Then\r\n\
           WScript.Echo \"ERR:\" & Err.Number & \":\" & Err.Description\r\n\
           WScript.Quit 1\r\n\
         End If\r\n\
         app.Visible = False\r\n\
         app.DisplayAlerts = 0\r\n\
         Set doc = app.Documents.Open({src}, False, True)\r\n\
         If Err.Number <> 0 Then\r\n\
           WScript.Echo \"OPEN_ERR:\" & Err.Number & \":\" & Err.Description\r\n\
           app.Quit\r\n\
           WScript.Quit 1\r\n\
         End If\r\n\
         doc.SaveAs {dst}, 16\r\n\
         If Err.Number <> 0 Then\r\n\
           WScript.Echo \"SAVE_ERR:\" & Err.Number & \":\" & Err.Description\r\n\
           doc.Close False\r\n\
           app.Quit\r\n\
           WScript.Quit 1\r\n\
         End If\r\n\
         doc.Close False\r\n\
         app.Quit\r\n\
         WScript.Quit 0\r\n",
        progid = vbs_literal(&progid),
        src = vbs_literal(&src.to_string_lossy()),
        dst = vbs_literal(&out_path.to_string_lossy()),
    );

    run_vbs(&script).map_err(|e| {
        AppError::Custom(format!(
            "Windows COM 转换失败（ProgId={}）: {}",
            progid, e
        ))
    })?;

    if !out_path.exists() {
        return Err(AppError::Custom(
            "转换完成但找不到输出文件：转换器可能没有真正完成保存".into(),
        ));
    }
    Ok(out_path)
}

// ─── 工具函数 ─────────────────────────────────────────

fn expected_output(src: &Path, dst_dir: &Path) -> Result<PathBuf, AppError> {
    let stem = src
        .file_stem()
        .ok_or_else(|| AppError::Custom("源文件名无效".into()))?;
    Ok(dst_dir.join(format!("{}.docx", stem.to_string_lossy())))
}

fn try_run(program: &str, args: &[&str]) -> bool {
    let mut cmd = Command::new(program);
    cmd.args(args);
    add_no_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn add_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn add_no_window(_cmd: &mut Command) {}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn vbs_literal_escapes_quotes() {
        assert_eq!(vbs_literal(r#"a"b"#), r#""a""b""#);
    }

    /// 真实转换依赖本机 Office / WPS / LibreOffice，默认忽略。
    /// 手动验证：`cargo test services::converter::tests::converts_html -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机安装 Office / WPS / LibreOffice"]
    fn converts_html_to_docx() {
        if detect_converter() == DocConverter::None {
            eprintln!("未检测到转换器，跳过");
            return;
        }
        use std::io::Read;

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("kb_conv_test_{}", nanos));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("note.html");
        std::fs::write(
            &src,
            "<html><body><h1>标题文字</h1><h2>小标题</h2><pre>let x = 1;</pre></body></html>",
        )
        .unwrap();

        let out = convert_to_docx(&src, &dir).expect("HTML → DOCX 应成功");
        assert!(out.exists(), "输出文件应存在");

        let file = std::fs::File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut styles = String::new();
        zip.by_name("word/styles.xml")
            .unwrap()
            .read_to_string(&mut styles)
            .unwrap();
        let lower = styles.to_lowercase();
        assert!(lower.contains("heading 1"), "h1 应映射为 Heading 1 样式");
        assert!(lower.contains("heading 2"), "h2 应映射为 Heading 2 样式");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
