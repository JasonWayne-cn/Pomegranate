//! 外部目录挂载服务
//!
//! 设计：外部文件是唯一数据源，`notes` 表保存影子行（内容镜像），
//! 这样全文搜索（FTS5 触发器）、标签（note_tags）、双链（note_links）
//! 都能直接复用现有 note.id，无需第二套索引。
//!
//! 监听策略沿用项目既有范式：轮询 + (size, mtime) 指纹，不引入 notify crate。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager, Runtime};
use walkdir::WalkDir;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    ExternalEntry, ExternalMount, ExternalMountInput, ExternalMountUpdate, MountNoteStatus,
    MountOpenResult, MountSaveResult, MountScanProgress, MountScanResult, SyncTypeSettings,
};

use super::doc_extract::DocExtractService;
use super::excel_import::ExcelImportService;
use super::hash::{sha256_file_hex, sha256_hex};
use super::import::{extract_inline_hashtags, read_file_mtime, read_text_auto_encoding};
use super::markdown::{parse_frontmatter, set_frontmatter_tags};
use super::pdf::PdfService;

/// 同一时刻只允许一个扫描任务，避免用户手动刷新与后台轮询并发写库
static SCAN_LOCK: Mutex<()> = Mutex::new(());

/// 可索引的扩展名
const TEXT_EXTS: &[&str] = &["md", "markdown", "txt", "text"];
const PDF_EXTS: &[&str] = &["pdf"];
const WORD_EXTS: &[&str] = &["docx", "docm", "doc"];
const SLIDE_EXTS: &[&str] = &["pptx", "pptm"];
const SHEET_EXTS: &[&str] = &["xlsx", "xls", "xlsm", "xlsb", "ods", "csv", "tsv"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MountFileKind {
    Text,
    Pdf,
    Word,
    Slide,
    Sheet,
}

impl MountFileKind {
    fn is_binary(self) -> bool {
        !matches!(self, Self::Text)
    }

    fn category(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Pdf => "pdf",
            Self::Word => "word",
            Self::Slide => "slide",
            Self::Sheet => "sheet",
        }
    }
}

fn type_enabled(settings: &SyncTypeSettings, kind: MountFileKind) -> bool {
    settings.enabled_category(kind.category())
}

fn extensions_for_category(category: &str) -> &'static [&'static str] {
    match category {
        "text" => TEXT_EXTS,
        "pdf" => PDF_EXTS,
        "word" => WORD_EXTS,
        "slide" => SLIDE_EXTS,
        "sheet" => SHEET_EXTS,
        _ => &[],
    }
}

fn classify_ext(ext: &str) -> Option<MountFileKind> {
    if TEXT_EXTS.contains(&ext) {
        Some(MountFileKind::Text)
    } else if PDF_EXTS.contains(&ext) {
        Some(MountFileKind::Pdf)
    } else if WORD_EXTS.contains(&ext) {
        Some(MountFileKind::Word)
    } else if SLIDE_EXTS.contains(&ext) {
        Some(MountFileKind::Slide)
    } else if SHEET_EXTS.contains(&ext) {
        Some(MountFileKind::Sheet)
    } else {
        None
    }
}

fn source_type_for(ext: &str, kind: MountFileKind) -> String {
    match kind {
        MountFileKind::Text => {
            if ext == "txt" || ext == "text" {
                "txt".to_string()
            } else {
                "md".to_string()
            }
        }
        _ => ext.to_string(),
    }
}

/// 纯文本 → 简单 HTML（Tiptap 期望）
fn text_to_paragraph_html(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    text.split("\n\n")
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| {
            let escaped = p
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
                .replace('\'', "&#39;")
                .replace('\n', "<br/>");
            format!("<p>{}</p>", escaped)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 抽取二进制文档正文；失败时返回面向用户的错误
fn extract_binary_content(
    path: &Path,
    kind: MountFileKind,
    settings: &SyncTypeSettings,
) -> Result<String, AppError> {
    match kind {
        MountFileKind::Pdf => {
            let text = extract_pdf_index_text(path, settings.ocr)?;
            Ok(text_to_paragraph_html(&text))
        }
        MountFileKind::Word => {
            let text = DocExtractService::extract_word_text(path)?;
            if text.trim().is_empty() {
                return Err(AppError::Custom("Word 文件没有可抽取的文本".into()));
            }
            Ok(text_to_paragraph_html(&text))
        }
        MountFileKind::Slide => {
            let text = DocExtractService::extract_presentation_text(path)?;
            if text.trim().is_empty() {
                return Err(AppError::Custom("PowerPoint 文件没有可抽取的文本".into()));
            }
            Ok(text_to_paragraph_html(&text))
        }
        MountFileKind::Sheet => {
            let (markdown, _truncated) =
                ExcelImportService::extract_markdown(&path.to_string_lossy())?;
            Ok(markdown)
        }
        MountFileKind::Text => Err(AppError::Custom("不是二进制文档".into())),
    }
}

/// PDF 索引文本：优先 PDFium 的阅读顺序；扫描件在开启 OCR 时用本地引擎兜底。
fn extract_pdf_index_text(path: &Path, ocr_enabled: bool) -> Result<String, AppError> {
    #[cfg(desktop)]
    {
        if let Ok(layout) = crate::services::pdf_layout::PdfLayoutService::extract(path, 0) {
            let text = layout.plain_text();
            if text.chars().count() >= 20 {
                return Ok(text);
            }
        }
    }

    let text = PdfService::extract_text_only(path)?;
    if text.chars().count() >= 20 || !ocr_enabled {
        return Ok(text);
    }

    #[cfg(desktop)]
    {
        if crate::services::ocr::is_available() {
            match ocr_pdf_text(path) {
                Ok(ocr) if !ocr.trim().is_empty() => return Ok(ocr),
                Ok(_) => {}
                Err(e) => log::warn!("[mount] OCR 失败 {}: {}", path.display(), e),
            }
        }
    }

    Ok(text)
}

/// 扫描件 PDF → 前 N 页渲染成 PNG → 逐页 OCR。索引场景限 10 页，避免慢到拖垮扫描轮询。
#[cfg(desktop)]
fn ocr_pdf_text(path: &Path) -> Result<String, String> {
    let tmp_root = std::env::temp_dir().join(format!(
        "kb_mount_ocr_{}_{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&tmp_root).map_err(|e| format!("创建 OCR 临时目录失败: {e}"))?;
    let pngs = crate::services::pdf::render_pdf_to_pngs(path, &tmp_root, 10)?;
    let mut parts = Vec::new();
    for png in &pngs {
        if let Ok(text) = crate::services::ocr::recognize_image(png) {
            if !text.trim().is_empty() {
                parts.push(text);
            }
        }
        let _ = std::fs::remove_file(png);
    }
    let _ = std::fs::remove_dir_all(&tmp_root);
    Ok(parts.join("\n\n"))
}

fn ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Office 临时/锁文件不参与索引：
/// - `~$文档.docx`：Word / Excel / PowerPoint 打开文档时生成的锁文件
/// - `~*.tmp`：`~WRL0001.tmp` / `~WRD0000.tmp` 等复制临时文件
/// - `.~lock.文档.odt#`：LibreOffice 锁文件
fn should_skip_file(path: &Path) -> bool {
    let name = match path.file_name().and_then(|s| s.to_str()) {
        Some(name) => name.to_ascii_lowercase(),
        None => return false,
    };
    name.starts_with("~$")
        || name.starts_with(".~lock.")
        || (name.starts_with('~') && name.ends_with(".tmp"))
}

/// 相对路径版本，用于过滤库中已有的索引行
fn should_skip_rel(rel: &str) -> bool {
    should_skip_file(Path::new(rel))
}

/// 跳过点目录 / node_modules，避免把 .git / .obsidian / 依赖目录当文档
fn should_skip_dir(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return false;
    }
    match entry.file_name().to_str() {
        Some(name) => name.starts_with('.') || name == "node_modules",
        None => false,
    }
}

/// 从 Markdown 正文提取第一个 `# 标题`
fn extract_title(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") {
            let title = trimmed.trim_start_matches('#').trim().to_string();
            if !title.is_empty() {
                return Some(title);
            }
        }
        if trimmed.is_empty() || trimmed == "---" {
            continue;
        }
        if !trimmed.starts_with('#') && !trimmed.starts_with("---") {
            break;
        }
    }
    None
}

/// 相对路径统一使用 `/`
fn rel_path_of(file: &Path, root: &Path) -> String {
    file.strip_prefix(root)
        .ok()
        .map(|p| {
            p.components()
                .filter_map(|c| c.as_os_str().to_str())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

/// 相对路径的父目录（`a/b/c.md` → `a/b`）
fn parent_rel(rel: &str) -> String {
    rel.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default()
}

fn normalize_path_for_compare(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    s.trim_end_matches('/').to_lowercase()
}

fn paths_overlap(a: &Path, b: &Path) -> bool {
    let a = normalize_path_for_compare(a);
    let b = normalize_path_for_compare(b);
    a == b || a.starts_with(&format!("{}/", b)) || b.starts_with(&format!("{}/", a))
}

pub struct MountService;

impl MountService {
    /// 新增挂载点：校验目录、禁止嵌套/重复挂载
    pub fn add_mount(
        db: &Database,
        input: &ExternalMountInput,
    ) -> Result<ExternalMount, AppError> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("挂载名称不能为空".into()));
        }
        if input.root_path.trim().is_empty() {
            return Err(AppError::InvalidInput("目录路径不能为空".into()));
        }

        let raw = Path::new(input.root_path.trim());
        if !raw.is_dir() {
            return Err(AppError::InvalidInput(format!(
                "目录不存在或不是文件夹: {}",
                raw.display()
            )));
        }
        let root = std::fs::canonicalize(raw)?;

        // 拒绝驱动器根目录 / 文件系统根
        if root.parent().is_none() || root.components().count() <= 1 {
            return Err(AppError::InvalidInput(
                "不能挂载磁盘根目录，请选择具体文件夹".into(),
            ));
        }

        for existing in db.list_external_mounts()? {
            if paths_overlap(&root, Path::new(&existing.root_path)) {
                return Err(AppError::InvalidInput(format!(
                    "与已挂载目录重叠: {}（{}）",
                    existing.root_path, existing.name
                )));
            }
        }

        let mut normalized = input.clone();
        normalized.name = name.to_string();
        normalized.root_path = root.to_string_lossy().to_string();
        normalized.scan_interval = normalized.scan_interval.clamp(2, 3600);
        db.create_external_mount(&normalized)
    }

    /// 更新挂载点设置（同步间隔、只读、自动索引、名称）
    pub fn update_mount(
        db: &Database,
        id: i64,
        input: &ExternalMountUpdate,
    ) -> Result<ExternalMount, AppError> {
        let mut normalized = input.clone();
        if let Some(name) = input.name.as_deref() {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err(AppError::InvalidInput("挂载名称不能为空".into()));
            }
            normalized.name = Some(trimmed.to_string());
        }
        if let Some(sec) = input.scan_interval {
            normalized.scan_interval = Some(sec.clamp(2, 3600));
        }

        let old = db
            .get_external_mount_by_id(id)?
            .ok_or_else(|| AppError::NotFound(format!("挂载点 {} 不存在", id)))?;

        db.update_external_mount_settings(id, &normalized)?;

        // 类型开关变化：关闭时把已索引文档标记 paused；重新开启时清空状态等待重抽
        if let Some(new_types) = normalized.sync_types.as_ref() {
            for category in ["text", "pdf", "word", "slide", "sheet"] {
                let was = old.sync_types.enabled_category(category);
                let now = new_types.enabled_category(category);
                if was != now {
                    let exts = extensions_for_category(category);
                    db.set_external_notes_paused(id, exts, !now)?;
                }
            }
        }

        db.get_external_mount_by_id(id)?
            .ok_or_else(|| AppError::NotFound(format!("挂载点 {} 不存在", id)))
    }

    /// 删除挂载点。`detach=true` 时保留影子文档，转成普通本地文档。
    pub fn remove_mount(db: &Database, id: i64, detach: bool) -> Result<(), AppError> {
        if detach {
            db.detach_external_mount(id)
        } else {
            db.delete_external_mount(id)
        }
    }

    pub fn list_entries(db: &Database, mount_id: i64) -> Result<Vec<ExternalEntry>, AppError> {
        db.list_external_entries(mount_id)
    }

    /// 扫描一个挂载点，增量更新影子文档
    pub fn scan_mount<R: Runtime, E: Emitter<R>>(
        db: &Database,
        mount: &ExternalMount,
        emitter: &E,
        emit_progress: bool,
    ) -> Result<MountScanResult, AppError> {
        let _guard = SCAN_LOCK
            .lock()
            .map_err(|e| AppError::Custom(format!("扫描锁损坏: {}", e)))?;

        let mut result = MountScanResult {
            mount_id: mount.id,
            ..Default::default()
        };

        let root = PathBuf::from(&mount.root_path);
        if !root.is_dir() {
            result
                .errors
                .push(format!("目录不可访问: {}", mount.root_path));
            return Ok(result);
        }

        let files: Vec<PathBuf> = WalkDir::new(&root)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|e| !should_skip_dir(e))
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && !should_skip_file(e.path())
                    && classify_ext(&ext_lower(e.path())).is_some()
            })
            .map(|e| e.path().to_path_buf())
            .collect();

        let total = files.len();
        let mut seen_ids: Vec<i64> = Vec::with_capacity(total);

        // 本轮磁盘上仍然存在的相对路径（含被类型开关暂停的文件）。
        // 用于判断某条影子文档的旧路径是否已经消失，从而参与"移动匹配"。
        let disk_rels: HashSet<String> = files
            .iter()
            .filter_map(|f| {
                let rel = rel_path_of(f, &root);
                if rel.is_empty() {
                    None
                } else {
                    Some(rel)
                }
            })
            .collect();

        // 外部移动/归档识别：按 (mtime, size) 给"磁盘上已不存在的旧路径文档"建索引。
        // 同指纹只对应一条文档时才认定为移动，避免把同大小同时间的多份文件配错。
        // Office 临时/锁文件曾在旧版本被按扩展名误索引，这里清掉这些影子文档，
        // 否则它们会以"缺失"状态留在挂载文件树里。
        let (path_index, stale_temp_rows): (Vec<_>, Vec<_>) = db
            .list_external_path_index(mount.id)
            .unwrap_or_default()
            .into_iter()
            .partition(|row| !should_skip_rel(&row.rel_path));
        for row in stale_temp_rows {
            match db.delete_note(row.id) {
                Ok(_) => log::info!("[mount] 清理临时文件索引: {}", row.rel_path),
                Err(e) => result
                    .errors
                    .push(format!("清理临时文件索引失败 {}: {}", row.rel_path, e)),
            }
        }
        let mut movable_by_fingerprint: HashMap<(i64, i64), Vec<_>> = HashMap::new();
        for row in path_index {
            if let (Some(mtime), Some(size)) = (row.mtime, row.size) {
                if !disk_rels.contains(&row.rel_path) {
                    movable_by_fingerprint
                        .entry((mtime, size))
                        .or_default()
                        .push(row);
                }
            }
        }
        let mut relocated_ids: HashSet<i64> = HashSet::new();

        for (idx, file) in files.iter().enumerate() {
            let ext = ext_lower(file);
            let kind = match classify_ext(&ext) {
                Some(k) => k,
                None => continue,
            };
            // 类型被关闭：跳过索引；已索引的 paused 文档不会被 mark_missing 标记缺失
            if !type_enabled(&mount.sync_types, kind) {
                continue;
            }
            let rel = rel_path_of(file, &root);
            if rel.is_empty() {
                continue;
            }
            let file_name = file
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let stem = file
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "未命名".to_string());

            if emit_progress {
                let _ = emitter.emit(
                    "mount:scan-progress",
                    MountScanProgress {
                        mount_id: mount.id,
                        current: idx + 1,
                        total,
                        file_name: file_name.clone(),
                    },
                );
            }

            let meta = match std::fs::metadata(file) {
                Ok(m) => m,
                Err(e) => {
                    result.errors.push(format!("{}: 读取元数据失败 - {}", rel, e));
                    continue;
                }
            };
            let mtime = read_file_mtime(file).unwrap_or(0);
            let size = meta.len() as i64;

            let existing = match db.find_external_note(mount.id, &rel) {
                Ok(v) => v,
                Err(e) => {
                    result.errors.push(format!("{}: 去重查询失败 - {}", rel, e));
                    continue;
                }
            };

            // 外部归档/改名：新路径查不到影子文档时，用 (size, mtime) 匹配
            // 磁盘上已不存在的旧路径文档。命中即沿用原 note id，并把镜像文件夹
            // 挪到新位置；内容没变，不需要重新抽取。
            if existing.is_none() {
                if let Some(candidate) = movable_by_fingerprint
                    .get(&(mtime, size))
                    .and_then(|list| {
                        let mut iter = list
                            .iter()
                            .filter(|r| !relocated_ids.contains(&r.id))
                            .filter(|r| {
                                // 文件类型变了（如 pdf → docx）不算移动
                                r.source_type
                                    .as_deref()
                                    .and_then(|t| classify_ext(&t.to_ascii_lowercase()))
                                    .map(|k| k == kind)
                                    .unwrap_or(true)
                            });
                        let first = iter.next()?;
                        // 多份同指纹文件同时移动时无法判断对应关系 → 放弃匹配
                        if iter.next().is_some() {
                            None
                        } else {
                            Some(first.clone())
                        }
                    })
                {
                    let folder_id = db
                        .ensure_external_folder(
                            mount.id,
                            mount.root_folder_id,
                            &parent_rel(&rel),
                        )
                        .unwrap_or(mount.root_folder_id);
                    if db
                        .relocate_external_note(candidate.id, &rel, folder_id)
                        .is_ok()
                    {
                        relocated_ids.insert(candidate.id);
                        seen_ids.push(candidate.id);
                        result.updated += 1;
                        result.scanned += 1;
                        continue;
                    }
                }
            }

            // 源文件 size/mtime 未变 → 跳过抽取
            if let Some(row) = &existing {
                if row.source_hash.is_some()
                    && row.source_mtime == Some(mtime)
                    && row.source_size == Some(size)
                {
                    seen_ids.push(row.id);
                    result.unchanged += 1;
                    continue;
                }
                // 二进制文档：影子文档被用户编辑过 + 原文件变了 → 不覆盖，标记陈旧
                if kind.is_binary() && row.user_edited() {
                    let _ = db.mark_external_stale(
                        row.id,
                        Some("原文件已更新，但影子文档有本地编辑，未自动覆盖"),
                    );
                    seen_ids.push(row.id);
                    result.stale += 1;
                    result.scanned += 1;
                    continue;
                }
            }

            let folder_id = db
                .ensure_external_folder(mount.id, mount.root_folder_id, &parent_rel(&rel))
                .unwrap_or(mount.root_folder_id);
            let abs_path = file.to_string_lossy().to_string();

            // 抽取正文 + 原文件指纹
            let (content, source_hash, title, fm_tags, body) = match kind {
                MountFileKind::Text => {
                    let content = match read_text_auto_encoding(file) {
                        Ok(c) => c,
                        Err(e) => {
                            result.errors.push(format!("{}: 读取失败 - {}", rel, e));
                            if let Some(row) = &existing {
                                seen_ids.push(row.id);
                            }
                            continue;
                        }
                    };
                    let source_hash = sha256_hex(&content);
                    let (fm, body) = parse_frontmatter(&content);
                    let title = fm
                        .as_ref()
                        .and_then(|f| f.title.clone())
                        .or_else(|| extract_title(&body))
                        .unwrap_or_else(|| stem.clone());
                    let tags = fm.as_ref().map(|f| f.tags.clone());
                    (content, source_hash, title, tags, body)
                }
                _ => {
                    let source_hash = match sha256_file_hex(file) {
                        Ok(h) => h,
                        Err(e) => {
                            result
                                .errors
                                .push(format!("{}: 计算文件指纹失败 - {}", rel, e));
                            if let Some(row) = &existing {
                                seen_ids.push(row.id);
                            }
                            continue;
                        }
                    };
                    match extract_binary_content(file, kind, &mount.sync_types) {
                        Ok(content) => (content, source_hash, stem.clone(), None, String::new()),
                        Err(e) => {
                            let err_msg = e.to_string();
                            result
                                .errors
                                .push(format!("{}: 抽取失败 - {}", rel, err_msg));
                            result.stale += 1;
                            if let Some(row) = &existing {
                                // 记录本轮指纹，避免每 10 秒重复解析坏文件；
                                // 用户可在编辑器里手动「重新抽取」。
                                let _ = db.set_external_source_fingerprint(
                                    row.id,
                                    &source_hash,
                                    mtime,
                                    size,
                                );
                                let _ = db.set_external_index_status(
                                    row.id,
                                    "failed",
                                    Some(&err_msg),
                                    true,
                                );
                                seen_ids.push(row.id);
                            } else {
                                // 建一条空占位，让文件在树里可见并显示错误
                                let empty = String::new();
                                let empty_hash = sha256_hex(&empty);
                                if let Ok((id, _)) = db.upsert_external_note(
                                    mount.id,
                                    &rel,
                                    folder_id,
                                    &stem,
                                    &empty,
                                    &source_hash,
                                    &empty_hash,
                                    &empty_hash,
                                    mtime,
                                    size,
                                    Some(&abs_path),
                                    Some(&ext),
                                    Some("failed"),
                                    Some(&err_msg),
                                    true,
                                ) {
                                    seen_ids.push(id);
                                    result.added += 1;
                                }
                            }
                            continue;
                        }
                    }
                }
            };

            let content_hash = sha256_hex(&content);
            let indexed_hash = content_hash.clone();
            let src_type = if kind.is_binary() {
                // 二进制文档始终保留类型，供 PDF/Word/Excel 预览；
                // 不会被现有写回逻辑处理（写回只认 "md"）
                Some(ext.as_str())
            } else if mount.read_only {
                None
            } else if ext == "txt" || ext == "text" {
                Some("txt")
            } else {
                Some("md")
            };

            match db.upsert_external_note(
                mount.id,
                &rel,
                folder_id,
                &title,
                &content,
                &source_hash,
                &content_hash,
                &indexed_hash,
                mtime,
                size,
                Some(&abs_path),
                src_type,
                Some("ok"),
                None,
                kind.is_binary(),
            ) {
                Ok((note_id, was_new)) => {
                    seen_ids.push(note_id);
                    if was_new {
                        result.added += 1;
                    } else {
                        result.updated += 1;
                    }
                    result.scanned += 1;

                    let _ = db.set_writeback_mtime(note_id, mtime);
                    Self::refresh_tags_and_links(db, note_id, fm_tags, &body);
                }
                Err(e) => {
                    result.errors.push(format!("{}: 写入索引失败 - {}", rel, e));
                    if let Some(row) = &existing {
                        seen_ids.push(row.id);
                    }
                }
            }
        }

        match db.mark_external_missing_except(mount.id, &seen_ids) {
            Ok(n) => result.missing = n,
            Err(e) => result.errors.push(format!("标记缺失文件失败: {}", e)),
        }

        // 文件被移动/归档后，旧目录会变成空壳；清掉它们让文档目录树与磁盘一致。
        // 仍挂着缺失文档或暂停文档的文件夹不会被删除，内容可恢复。
        match db.prune_empty_external_folders(mount.id) {
            Ok(n) if n > 0 => {
                log::info!("[mount] {}: 清理空镜像文件夹 {} 个", mount.name, n);
            }
            Ok(_) => {}
            Err(e) => result.errors.push(format!("清理空镜像文件夹失败: {}", e)),
        }

        let _ = db.touch_external_mount_scan(mount.id);

        Ok(result)
    }

    /// 重建标签与双链（外部文件内容变更后调用）
    fn refresh_tags_and_links(
        db: &Database,
        note_id: i64,
        frontmatter_tags: Option<Vec<String>>,
        body: &str,
    ) {
        let mut tags = frontmatter_tags.unwrap_or_default();
        tags.extend(extract_inline_hashtags(body));
        let _ = db.sync_note_tags(note_id, &tags);
        let _ = db.rebuild_note_links_from_content(note_id, body);
    }

    /// 用当前磁盘文件重新抽取并更新影子缓存
    fn extract_and_update(
        db: &Database,
        meta: &crate::database::mounts::ExternalNoteMeta,
        path: &Path,
        mtime: i64,
        size: i64,
    ) -> Result<String, AppError> {
        let ext = meta
            .source_type
            .clone()
            .unwrap_or_else(|| ext_lower(path));
        let kind = classify_ext(&ext).ok_or_else(|| {
            AppError::Custom(format!("不支持的源文件类型: {}", ext))
        })?;

        let (content, source_hash, tags, body) = match kind {
            MountFileKind::Text => {
                let content = read_text_auto_encoding(path)?;
                let source_hash = sha256_hex(&content);
                let (fm, body) = parse_frontmatter(&content);
                (content, source_hash, fm.map(|f| f.tags), body)
            }
            _ => {
                let settings = db
                    .list_external_mounts()
                    .ok()
                    .and_then(|mounts| mounts.into_iter().find(|m| m.id == meta.mount_id))
                    .map(|m| m.sync_types)
                    .unwrap_or_default();
                let source_hash = sha256_file_hex(path)?;
                let content = extract_binary_content(path, kind, &settings)?;
                (content, source_hash, None, String::new())
            }
        };

        let content_hash = sha256_hex(&content);
        db.update_external_note_cache(
            meta.note_id,
            &content,
            &source_hash,
            &content_hash,
            &content_hash,
            mtime,
            size,
            Some("ok"),
            None,
        )?;
        Self::refresh_tags_and_links(db, meta.note_id, tags, &body);
        let _ = db.set_writeback_mtime(meta.note_id, mtime);
        Ok(content)
    }

    /// 打开外部文件：读磁盘最新内容并同步影子缓存。
    ///
    /// - 原文件未变：直接返回缓存
    /// - 原文件变了 + 影子文档未编辑：自动重新抽取
    /// - 原文件变了 + 影子文档已编辑：标记 stale，保留本地编辑
    pub fn open_note(db: &Database, note_id: i64) -> Result<MountOpenResult, AppError> {
        let meta = db
            .get_external_note_meta(note_id)?
            .ok_or_else(|| AppError::NotFound(format!("外部文档 {} 不存在", note_id)))?;
        let cached = db
            .get_note(note_id)?
            .ok_or_else(|| AppError::NotFound(format!("文档 {} 不存在", note_id)))?
            .content;
        let user_edited = match (&meta.content_hash, &meta.indexed_hash) {
            (Some(cur), Some(base)) => cur != base,
            _ => false,
        };
        let ext_for_kind = meta
            .source_type
            .clone()
            .unwrap_or_else(|| ext_lower(Path::new(&meta.abs_path)));
        let is_binary = classify_ext(&ext_for_kind)
            .map(|k| k.is_binary())
            .unwrap_or(false);

        let path = Path::new(&meta.abs_path);
        if !path.is_file() {
            return Ok(MountOpenResult {
                note_id,
                content: cached,
                rel_path: meta.rel_path,
                read_only: meta.read_only,
                missing: true,
                stale: meta.stale,
                user_edited,
                status: meta.status,
                error: meta.error,
                source_type: meta.source_type,
            });
        }

        let mtime = read_file_mtime(path).unwrap_or(0);
        let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
        let source_changed = mtime != meta.mtime || size != meta.size;

        if !source_changed {
            return Ok(MountOpenResult {
                note_id,
                content: cached,
                rel_path: meta.rel_path,
                read_only: meta.read_only,
                missing: false,
                stale: meta.stale,
                user_edited,
                status: meta.status,
                error: meta.error,
                source_type: meta.source_type,
            });
        }

        // 文本文件的用户编辑会通过既有写回机制同步到磁盘；
        // 只有二进制文档（PDF/Word/Excel）的本地编辑不会被写回，才需要冲突保护。
        if is_binary && user_edited {
            let _ = db.mark_external_stale(
                note_id,
                Some("原文件已更新，但影子文档有本地编辑，未自动覆盖"),
            );
            return Ok(MountOpenResult {
                note_id,
                content: cached,
                rel_path: meta.rel_path,
                read_only: meta.read_only,
                missing: false,
                stale: true,
                user_edited: true,
                status: Some("stale".into()),
                error: Some("原文件已更新，但影子文档有本地编辑".into()),
                source_type: meta.source_type,
            });
        }

        match Self::extract_and_update(db, &meta, path, mtime, size) {
            Ok(content) => Ok(MountOpenResult {
                note_id,
                content,
                rel_path: meta.rel_path,
                read_only: meta.read_only,
                missing: false,
                stale: false,
                user_edited: false,
                status: Some("ok".into()),
                error: None,
                source_type: meta.source_type,
            }),
            Err(e) => {
                let err = e.to_string();
                let _ = db.set_external_index_status(note_id, "failed", Some(&err), true);
                Ok(MountOpenResult {
                    note_id,
                    content: cached,
                    rel_path: meta.rel_path,
                    read_only: meta.read_only,
                    missing: false,
                    stale: true,
                    user_edited: false,
                    status: Some("failed".into()),
                    error: Some(err),
                    source_type: meta.source_type,
                })
            }
        }
    }

    /// 查询影子文档是否落后于原文件
    pub fn note_status(db: &Database, note_id: i64) -> Result<MountNoteStatus, AppError> {
        let Some(meta) = db.get_external_note_meta(note_id)? else {
            return Ok(MountNoteStatus {
                note_id,
                external: false,
                read_only: false,
                stale: false,
                user_edited: false,
                status: None,
                error: None,
                source_type: None,
                source_ext: None,
                indexed_at: None,
                source_mtime: 0,
                indexed_mtime: None,
            });
        };

        let user_edited = match (&meta.content_hash, &meta.indexed_hash) {
            (Some(cur), Some(base)) => cur != base,
            _ => false,
        };
        let path = Path::new(&meta.abs_path);
        let source_mtime = if path.is_file() {
            read_file_mtime(path).unwrap_or(0)
        } else {
            0
        };
        let source_size = if path.is_file() {
            std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)
        } else {
            0
        };
        let source_changed = meta.missing
            || source_mtime != meta.mtime
            || source_size != meta.size;

        let ext = ext_lower(Path::new(&meta.abs_path));
        Ok(MountNoteStatus {
            note_id,
            external: true,
            read_only: meta.read_only,
            stale: meta.stale || source_changed,
            user_edited,
            status: meta.status,
            error: meta.error,
            source_type: meta.source_type,
            source_ext: if ext.is_empty() { None } else { Some(ext) },
            indexed_at: meta.indexed_at,
            source_mtime,
            indexed_mtime: Some(meta.mtime),
        })
    }

    /// 强制重新抽取（会覆盖影子文档的本地编辑）
    pub fn reextract(db: &Database, note_id: i64) -> Result<MountOpenResult, AppError> {
        let meta = db
            .get_external_note_meta(note_id)?
            .ok_or_else(|| AppError::NotFound(format!("外部文档 {} 不存在", note_id)))?;
        let path = Path::new(&meta.abs_path);
        if !path.is_file() {
            return Err(AppError::NotFound(format!(
                "源文件不存在: {}",
                meta.abs_path
            )));
        }
        let mtime = read_file_mtime(path).unwrap_or(0);
        let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
        let content = Self::extract_and_update(db, &meta, path, mtime, size)?;
        Ok(MountOpenResult {
            note_id,
            content,
            rel_path: meta.rel_path,
            read_only: meta.read_only,
            missing: false,
            stale: false,
            user_edited: false,
            status: Some("ok".into()),
            error: None,
            source_type: meta.source_type,
        })
    }

    /// 保存外部文件：只允许文本类（二进制文档不写回）
    pub fn save_note(
        db: &Database,
        note_id: i64,
        content: &str,
    ) -> Result<MountSaveResult, AppError> {
        let meta = db
            .get_external_note_meta(note_id)?
            .ok_or_else(|| AppError::NotFound(format!("外部文档 {} 不存在", note_id)))?;
        let ext = meta
            .source_type
            .clone()
            .unwrap_or_else(|| ext_lower(Path::new(&meta.abs_path)));
        let is_binary = classify_ext(&ext).map(|k| k.is_binary()).unwrap_or(false);
        if is_binary {
            return Err(AppError::InvalidInput(
                "PDF / Word / Excel 影子文档不能写回原文件；编辑仅保存在数据库".into(),
            ));
        }
        if meta.read_only {
            return Err(AppError::InvalidInput("该挂载点为只读，不能保存到原文件".into()));
        }
        if meta.missing {
            return Err(AppError::NotFound("源文件已缺失，无法保存".into()));
        }

        let path = Path::new(&meta.abs_path);
        if !path.is_file() {
            return Err(AppError::NotFound(format!("源文件不存在: {}", meta.abs_path)));
        }

        // mtime 冲突检测（秒级；与现有写回语义一致）
        let disk_mtime = read_file_mtime(path).unwrap_or(0);
        if meta.mtime > 0 && disk_mtime != meta.mtime {
            return Err(AppError::InvalidInput(
                "外部文件已被其他程序修改，请重新打开确认后再保存".into(),
            ));
        }

        std::fs::write(path, content)?;
        let mtime = read_file_mtime(path).unwrap_or(0);
        let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
        let hash = sha256_hex(content);
        db.update_external_note_cache(
            note_id,
            content,
            &hash,
            &hash,
            &hash,
            mtime,
            size,
            Some("ok"),
            None,
        )?;
        let _ = db.set_writeback_mtime(note_id, mtime);

        let (fm, body) = parse_frontmatter(content);
        Self::refresh_tags_and_links(db, note_id, fm.as_ref().map(|f| f.tags.clone()), &body);

        Ok(MountSaveResult {
            note_id,
            mtime,
            size,
            hash,
        })
    }

    /// 把标签写回挂载 Markdown 源文件的 frontmatter。
    ///
    /// - 内部文档（非挂载）直接返回 `Ok`，调用方继续写 DB 即可。
    /// - 只有 `.md` / `.markdown` 支持写回；PDF / Word / Excel 的标签来自源文件解析，返回错误。
    /// - 只读挂载点 / 源文件缺失 / 外部已修改（mtime 冲突）均返回错误，避免覆盖用户文件。
    ///
    /// 写回成功后同步更新影子缓存（content / 指纹 / mtime），
    /// 这样紧接着的挂载扫描会因 size+mtime 未变而跳过，不会把刚写的标签判成外部更新。
    pub fn write_tags_to_markdown(
        db: &Database,
        note_id: i64,
        tag_names: &[String],
    ) -> Result<(), AppError> {
        let Some(meta) = db.get_external_note_meta(note_id)? else {
            return Ok(());
        };
        let ext = meta
            .source_type
            .clone()
            .map(|s| s.to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| ext_lower(Path::new(&meta.abs_path)));

        if ext != "md" && ext != "markdown" {
            return Err(AppError::InvalidInput(
                "只有挂载的 Markdown 文件支持标签写回；PDF / Word / Excel 等文档的标签来自源文件解析".into(),
            ));
        }
        if meta.read_only {
            return Err(AppError::InvalidInput(
                "该挂载点为只读，不能写回标签".into(),
            ));
        }
        if meta.missing {
            return Err(AppError::NotFound("源文件已缺失，无法写回标签".into()));
        }

        let path = Path::new(&meta.abs_path);
        if !path.is_file() {
            return Err(AppError::NotFound(format!(
                "源文件不存在: {}",
                meta.abs_path
            )));
        }

        let disk_mtime = read_file_mtime(path).unwrap_or(0);
        if meta.mtime > 0 && disk_mtime != meta.mtime {
            return Err(AppError::InvalidInput(
                "外部文件已被其他程序修改，请重新打开确认后再修改标签".into(),
            ));
        }

        let content = read_text_auto_encoding(path)?;
        let updated = set_frontmatter_tags(&content, tag_names);
        if updated == content {
            return Ok(());
        }

        std::fs::write(path, &updated)?;
        let mtime = read_file_mtime(path).unwrap_or(0);
        let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
        let hash = sha256_hex(&updated);
        db.update_external_note_cache(
            note_id,
            &updated,
            &hash,
            &hash,
            &hash,
            mtime,
            size,
            Some("ok"),
            None,
        )?;
        let _ = db.set_writeback_mtime(note_id, mtime);
        Ok(())
    }

    /// Office 工作台保存原文件后按绝对路径立即刷新索引。
    ///
    /// 背景扫描是轮询制（默认 10 分钟），保存后立刻搜索会暂时命中旧正文。
    /// 这里按「挂载根 + 相对路径」定位影子文档并强制重抽；路径不在任何挂载内时返回 `Ok(None)`。
    pub fn refresh_path(db: &Database, path: &str) -> Result<Option<i64>, AppError> {
        let target = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
        for mount in db.list_external_mounts()? {
            let root = std::fs::canonicalize(&mount.root_path)
                .unwrap_or_else(|_| PathBuf::from(&mount.root_path));
            let Ok(rel) = target.strip_prefix(&root) else {
                continue;
            };
            let rel = rel
                .components()
                .filter_map(|c| c.as_os_str().to_str())
                .collect::<Vec<_>>()
                .join("/");
            if rel.is_empty() {
                continue;
            }
            if let Some(row) = db.find_external_note(mount.id, &rel)? {
                Self::reextract(db, row.id)?;
                return Ok(Some(row.id));
            }
        }
        Ok(None)
    }

    /// 打开文档前刷新外部内容（供 NoteService::get 调用）。
    pub fn refresh_if_external(db: &Database, note_id: i64) {
        let _ = Self::open_note(db, note_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_supports_all_office_formats() {
        assert_eq!(classify_ext("docx"), Some(MountFileKind::Word));
        assert_eq!(classify_ext("docm"), Some(MountFileKind::Word));
        assert_eq!(classify_ext("pptx"), Some(MountFileKind::Slide));
        assert_eq!(classify_ext("pptm"), Some(MountFileKind::Slide));
        assert_eq!(classify_ext("xlsm"), Some(MountFileKind::Sheet));
        assert_eq!(classify_ext("pdf"), Some(MountFileKind::Pdf));
        assert_eq!(classify_ext("unknown"), None);
    }

    #[test]
    fn slide_toggle_only_affects_presentations() {
        let mut settings = SyncTypeSettings::default();
        assert!(type_enabled(&settings, MountFileKind::Slide));
        settings.slide = false;
        assert!(!type_enabled(&settings, MountFileKind::Slide));
        assert!(type_enabled(&settings, MountFileKind::Word));
    }

    #[test]
    fn office_temp_files_are_skipped() {
        for name in [
            "~$手册模板0515.docx",
            "~$预算.xlsx",
            "~$提案.pptx",
            "~WRL0001.tmp",
            ".~lock.报告.odt#",
            "子目录/~$临时.docx",
        ] {
            assert!(should_skip_rel(name), "{name} 应跳过");
        }
        for name in [
            "手册模板0515.docx",
            "预算.xlsx",
            "~报告.md",
            "普通.tmp",
            "README.txt",
        ] {
            assert!(!should_skip_rel(name), "{name} 不应跳过");
        }
    }

    #[test]
    fn binary_documents_are_index_only() {
        for ext in ["pdf", "docx", "docm", "pptx", "pptm", "xlsx", "csv"] {
            let kind = classify_ext(ext).expect(ext);
            assert!(kind.is_binary(), "{ext} 应标记为二进制文档");
        }
        assert!(!MountFileKind::Text.is_binary());
    }
}

/// 后台轮询：逐个挂载点做增量扫描
pub async fn run_mount_watch_loop(app: tauri::AppHandle) {
    log::info!("[mount-watch] 外部目录监听已启动");
    let mut last_scan = std::collections::HashMap::<i64, std::time::Instant>::new();

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        let Some(state) = app.try_state::<crate::state::AppState>() else {
            continue;
        };
        let mounts = match state.db.list_external_mounts() {
            Ok(m) => m,
            Err(e) => {
                log::warn!("[mount-watch] 读取挂载点失败: {}", e);
                continue;
            }
        };

        for mount in mounts {
            if !mount.index_enabled || !mount.available {
                continue;
            }
            let interval = std::time::Duration::from_secs(mount.scan_interval.clamp(2, 3600) as u64);
            let due = last_scan
                .get(&mount.id)
                .map(|t| t.elapsed() >= interval)
                .unwrap_or(true);
            if !due {
                continue;
            }
            last_scan.insert(mount.id, std::time::Instant::now());

            match MountService::scan_mount(&state.db, &mount, &app, false) {
                Ok(r) if r.added + r.updated + r.missing > 0 => {
                    log::info!(
                        "[mount-watch] {}: +{} ~{} -{}",
                        mount.name,
                        r.added,
                        r.updated,
                        r.missing
                    );
                    let _ = app.emit("external:changed", r.mount_id);
                    let _ = app.emit("db:external-changed", ());
                }
                Ok(_) => {}
                Err(e) => log::warn!("[mount-watch] 扫描 {} 失败: {}", mount.name, e),
            }
        }
    }
}
