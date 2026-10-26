//! AI 调用轻量指标（进程内，不外传）。
//!
//! 只统计流式对话的请求数、错误数、耗时与最近一次错误，供设置页展示。
//! 不持久化：重启归零，避免引入额外表与 IO。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;

/// 指标快照（返回给前端）
#[derive(Debug, Clone, Serialize)]
pub struct AiMetricsSnapshot {
    pub requests: u64,
    pub errors: u64,
    pub avg_latency_ms: u64,
    pub last_latency_ms: u64,
    pub last_error: Option<String>,
}

static REQUESTS: AtomicU64 = AtomicU64::new(0);
static ERRORS: AtomicU64 = AtomicU64::new(0);
static TOTAL_LATENCY_MS: AtomicU64 = AtomicU64::new(0);
static LAST_LATENCY_MS: AtomicU64 = AtomicU64::new(0);
static LAST_ERROR: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// 记录一次成功请求
pub fn record_success(latency_ms: u64) {
    REQUESTS.fetch_add(1, Ordering::Relaxed);
    LAST_LATENCY_MS.store(latency_ms, Ordering::Relaxed);
    TOTAL_LATENCY_MS.fetch_add(latency_ms, Ordering::Relaxed);
}

/// 记录一次失败请求
pub fn record_error(latency_ms: u64, error: &str) {
    REQUESTS.fetch_add(1, Ordering::Relaxed);
    ERRORS.fetch_add(1, Ordering::Relaxed);
    LAST_LATENCY_MS.store(latency_ms, Ordering::Relaxed);
    TOTAL_LATENCY_MS.fetch_add(latency_ms, Ordering::Relaxed);
    if let Ok(mut guard) = LAST_ERROR.lock() {
        *guard = Some(error.chars().take(500).collect());
    }
}

/// 获取当前指标快照
pub fn snapshot() -> AiMetricsSnapshot {
    let requests = REQUESTS.load(Ordering::Relaxed);
    let total = TOTAL_LATENCY_MS.load(Ordering::Relaxed);
    AiMetricsSnapshot {
        requests,
        errors: ERRORS.load(Ordering::Relaxed),
        avg_latency_ms: if requests == 0 { 0 } else { total / requests },
        last_latency_ms: LAST_LATENCY_MS.load(Ordering::Relaxed),
        last_error: LAST_ERROR.lock().ok().and_then(|g| g.clone()),
    }
}
