//! 文档向量增量索引队列。
//!
//! 文档创建/更新/删除/恢复/隐藏时投递 id，后台 worker 做防抖（默认 800ms）
//! 后按当前 embedding 配置重建这些文档的向量。设计目标：
//!
//! - 不阻塞 IPC：写操作只做一次 mpsc `send`，embedding 网络请求在后台串行执行
//! - 合并高频保存：编辑器逐字保存会在防抖窗口内合并为一次索引
//! - 失败保留旧向量：先完成全部 chunk 的 embedding，再删除旧向量并写入新向量
//!
//! 队列未初始化（如测试环境 / 未配置 embedding）时 `enqueue_*` 静默忽略。

use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::database::Database;
use crate::models::EmbeddingConfig;

/// 单块字符上限：阿里云 text-embedding 单次输入 8192 token，保守取 6000 字符留余量
const CHUNK_CHARS: usize = 6000;
/// 防抖窗口：编辑器高频保存合并到一次索引
const DEBOUNCE: Duration = Duration::from_millis(800);

enum IndexJob {
    Note(i64),
    All,
}

static DB: OnceLock<Arc<Database>> = OnceLock::new();
static TX: OnceLock<mpsc::UnboundedSender<IndexJob>> = OnceLock::new();

/// 初始化后台索引队列（进程生命周期内只执行一次）。
///
/// 在 `lib.rs` setup 中调用；未配置 embedding 时 worker 会跳过任务，
/// 后续用户启用 embedding 并保存配置后由 `enqueue_all` 补齐。
pub fn init(db: Arc<Database>) {
    if DB.set(db.clone()).is_err() {
        return;
    }
    let (tx, rx) = mpsc::unbounded_channel();
    if TX.set(tx).is_err() {
        return;
    }
    tauri::async_runtime::spawn(run_worker(db, rx));
    log::info!("[index-queue] 文档向量增量索引队列已启动");
}

/// 投递单篇文档（创建/更新/删除/恢复/隐藏/加密状态变化）。
///
/// 任务执行时会重新查询文档状态：已删除或隐藏的文档会删除旧向量。
pub fn enqueue_note(note_id: i64) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(IndexJob::Note(note_id));
    }
}

/// 投递全量重建任务（embedding 配置变更、导入完成等）。
pub fn enqueue_all() {
    if let Some(tx) = TX.get() {
        let _ = tx.send(IndexJob::All);
    }
}

async fn run_worker(db: Arc<Database>, mut rx: mpsc::UnboundedReceiver<IndexJob>) {
    let mut pending: HashSet<i64> = HashSet::new();
    let mut all = false;

    loop {
        // 等待第一个任务；通道关闭说明进程退出
        let Some(first) = rx.recv().await else {
            return;
        };
        absorb(first, &mut pending, &mut all);

        // 防抖：每收到新任务就重置计时
        let mut deadline = tokio::time::Instant::now() + DEBOUNCE;
        loop {
            tokio::select! {
                maybe = rx.recv() => {
                    match maybe {
                        Some(job) => {
                            absorb(job, &mut pending, &mut all);
                            deadline = tokio::time::Instant::now() + DEBOUNCE;
                        }
                        None => return,
                    }
                }
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }

        process_batch(db.as_ref(), &pending, all).await;
        pending.clear();
        all = false;
    }
}

fn absorb(job: IndexJob, pending: &mut HashSet<i64>, all: &mut bool) {
    match job {
        IndexJob::Note(id) => {
            pending.insert(id);
        }
        IndexJob::All => *all = true,
    }
}

async fn process_batch(db: &Database, pending: &HashSet<i64>, all: bool) {
    let cfg = match db.get_embedding_config() {
        Ok(Some(cfg)) if cfg.is_enabled && cfg.dim > 0 => cfg,
        Ok(_) => {
            log::debug!("[index-queue] embedding 未启用，跳过 {} 个任务", pending.len());
            return;
        }
        Err(e) => {
            log::warn!("[index-queue] 读取 embedding 配置失败: {}", e);
            return;
        }
    };

    let ids: Vec<i64> = if all {
        match db.list_note_ids_for_embedding() {
            Ok(ids) => ids,
            Err(e) => {
                log::warn!("[index-queue] 列出待索引文档失败: {}", e);
                return;
            }
        }
    } else {
        pending.iter().copied().collect()
    };

    log::debug!("[index-queue] 开始索引 {} 篇文档 (all={})", ids.len(), all);
    let mut ok = 0usize;
    let mut failed = 0usize;

    for id in ids {
        match db.get_note_content_for_embedding(id) {
            Ok(Some(content)) => match index_note(db, &cfg, id, &content).await {
                Ok(()) => ok += 1,
                Err(e) => {
                    failed += 1;
                    log::warn!("[index-queue] 文档 {} 索引失败: {}", id, e);
                }
            },
            Ok(None) => {
                // 已删除 / 隐藏 / 空正文：清理旧向量
                if let Err(e) = db.delete_note_embeddings(id) {
                    log::warn!("[index-queue] 清理文档 {} 向量失败: {}", id, e);
                }
            }
            Err(e) => {
                failed += 1;
                log::warn!("[index-queue] 读取文档 {} 失败: {}", id, e);
            }
        }
    }

    if ok + failed > 0 {
        log::info!("[index-queue] 索引完成 ok={} failed={}", ok, failed);
    }
}

/// 重建单篇文档的全部 chunk。
///
/// 先完成所有 chunk 的 embedding，再删除旧向量并写入新向量 —— 中途失败时
/// 旧向量仍然可用，避免文档暂时从 RAG 中消失。
async fn index_note(
    db: &Database,
    cfg: &EmbeddingConfig,
    note_id: i64,
    content: &str,
) -> Result<(), crate::error::AppError> {
    let chunks = crate::services::embedding::chunk_text(content, CHUNK_CHARS);
    let mut vectors: Vec<(i64, String, Vec<f32>)> = Vec::with_capacity(chunks.len());

    for (idx, chunk) in chunks.iter().enumerate() {
        let vector = crate::services::embedding::embed(cfg, chunk).await?;
        vectors.push((idx as i64, (*chunk).to_string(), vector));
    }

    db.delete_note_embeddings(note_id)?;
    for (idx, chunk, vector) in &vectors {
        db.upsert_note_embedding(
            note_id,
            *idx,
            chunk,
            vector,
            &cfg.model_id,
            cfg.dim,
        )?;
    }
    Ok(())
}
