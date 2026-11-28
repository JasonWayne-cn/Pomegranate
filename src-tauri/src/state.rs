use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::{watch, Notify};

use crate::database::Database;
use crate::services::claude_agent::AgentProcessHandle;
use crate::services::plugin_rate_limit::PluginRateLimiter;
use crate::services::plugin_token::PluginTokenRegistry;
use crate::services::vault::VaultState;

/// In-memory MCP client：通过 tokio::io::duplex 与同进程内的 KbServer 通信。
/// 让主应用代码也能用统一的 MCP 协议消费 12 工具，而不是直接调 services::*。
/// 使用 RoleClient 角色，handler 用 () 表示不响应 server-initiated 请求。
pub type InternalMcpClient = rmcp::service::RunningService<rmcp::RoleClient, ()>;

/// 应用全局状态，通过 tauri::State 注入到 Command 中
pub struct AppState {
    /// 共享数据库句柄（后台索引队列等长生命周期任务需要持有）
    pub db: Arc<Database>,
    /// 实例数据根目录（默认实例 = app_data_dir，多开实例 = app_data_dir/instance-N）
    /// 资产/PDF/sources/db 都基于此路径
    pub data_dir: PathBuf,
    /// 实例 ID（None = 默认实例，Some(N) = 第 N 个多开实例）
    /// 由 `get_system_info` 暴露给前端，用于在 UI 上区分多开实例
    pub instance_id: Option<u32>,
    /// AI 生成取消信号 (conversation_id -> sender)
    pub ai_cancel: Mutex<std::collections::HashMap<i64, watch::Sender<bool>>>,
    /// 插件 AI 生成取消信号 (runtime token -> sender)
    pub plugin_ai_cancel: Mutex<std::collections::HashMap<String, watch::Sender<bool>>>,
    /// 自动同步调度器唤醒信号：配置变更时 notify_one 重载
    pub sync_scheduler_notify: Arc<Notify>,
    /// 待办提醒调度器唤醒信号：用户增/改/删/snooze 任务时 notify_one，
    /// 调度器立刻重新计算"下一个最早提醒时刻"并重 sleep。
    /// 这样实现的精度 ~毫秒，且空闲时零 DB 查询（只在事件驱动 + 5min 兜底唤醒时扫）。
    pub reminder_notify: Arc<Notify>,
    /// 定时推送调度器唤醒信号（KB 2.0）：用户增/改/删/启停推送时 notify_one。
    pub push_notify: Arc<Notify>,
    /// V1 多端同步互斥闸门：同一 backend 同时只允许一个同步操作在跑。
    pub sync_v1_gate: crate::services::sync_v1::lock::SyncGate,
    /// 局域网同步主机状态（服务 / mDNS 广播 / 库级租约）
    pub lan_sync: Arc<crate::services::lan_sync::LanSyncState>,
    /// 启动时 argv 里的 .md 文件路径，等前端 mount 后 take 出来
    pub pending_open_md_path: Mutex<Option<String>>,
    /// T-007 文档加密保险库：内存中的主密钥（可选），锁定时清空
    pub vault: RwLock<VaultState>,
    /// In-memory MCP client（指向同进程内的 KbServer）。
    /// `Option` 是因为初始化失败不应阻断主应用启动 —— None 时 mcp_internal_* 命令会报"未就绪"。
    pub mcp_internal: Option<Arc<InternalMcpClient>>,
    /// 内置 MCP 自己的数据库连接。它和 `db` 是两条连接，整库替换时要一起放开
    pub mcp_internal_db: Option<Arc<kb_core::KbDb>>,
    /// 外部 MCP server client 缓存（M5-2）。每个用户加的 server 对应一个子进程 + client。
    /// 进程级单例：第一次访问时 spawn，后续请求复用。
    /// 仅桌面端：移动端 fork/spawn 受限，没有外部 MCP 概念
    #[cfg(desktop)]
    pub mcp_external: Arc<crate::services::mcp_client::McpClientManager>,
    /// 内置 MCP HTTP server 状态（默认不启动）
    #[cfg(desktop)]
    pub mcp_http: Arc<crate::services::mcp_http::McpHttpState>,
    /// 实例锁文件句柄（保持存活以维持独占锁，进程退出时自动释放）
    _lock_file: Option<File>,
    /// 插件运行时令牌注册表（T1: 内存存储，进程退出自动清空）
    pub plugin_tokens: PluginTokenRegistry,
    /// 插件写操作速率限制器（防爆库：每插件 ≤ 10 次/秒）
    pub plugin_rate_limiter: PluginRateLimiter,
    /// Claude Code Agent Runner 活跃进程表（session_id → 进程句柄）
    pub claude_agent_processes: Arc<Mutex<std::collections::HashMap<String, AgentProcessHandle>>>,
    /// PPT 扩展作业取消标志（job_id → cancel flag）
    pub ppt_job_cancel: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    /// PPT 扩展作业暂停标志（job_id → pause flag）；在页块边界生效
    pub ppt_job_pause: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    /// PPT 大纲规划取消标志（planning_id → cancel flag）
    pub ppt_plan_cancel: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    /// PPT 大纲规划暂停标志（planning_id → pause flag）；在阶段/分块边界生效
    pub ppt_plan_pause: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
}

/// [`AppState::pause_mcp_http`] 的返回值；移动端没有 HTTP MCP，恒为 None
#[cfg(desktop)]
pub type PausedMcpHttp = Option<crate::services::mcp_http::StartParams>;
#[cfg(not(desktop))]
pub type PausedMcpHttp = Option<()>;

impl AppState {
    /// 整库替换前暂停 HTTP MCP 服务：它的每个会话各开一条连接，同样会让 `-wal` 删不掉。
    /// 没在跑返回 None；替换完用 [`resume_mcp_http`](Self::resume_mcp_http) 按原配置拉起
    pub async fn pause_mcp_http(&self) -> PausedMcpHttp {
        #[cfg(desktop)]
        {
            self.mcp_http.pause().await
        }
        #[cfg(not(desktop))]
        {
            None
        }
    }

    /// 按暂停前的配置拉起，并把这份配置写回（可能刚被整库替换掉的）新库。
    /// 端口 / token / 是否开放局域网是这台机器自己的设置：导入的备份可能来自别的设备、
    /// 或是开启服务之前导出的，不写回的话设置页显示「未开启」、token 对不上，
    /// 重启后服务也不会再自动拉起，外部客户端全部断连
    /// 放开本进程所有数据库连接，整库替换前调用。
    ///
    /// 只放主连接不够：内置 MCP 开着第二条连接，Windows 上 `-wal` 删不掉，
    /// 导入永远失败。HTTP MCP 的会话连接由 `pause_mcp_http` 单独处理。
    pub fn release_db_connections(&self) {
        let _ = self.db.release();
        if let Some(mcp_db) = &self.mcp_internal_db {
            if let Err(e) = mcp_db.release() {
                log::warn!("[mcp-internal] 释放数据库连接失败: {e}");
            }
        }
    }

    /// 替换完成后把内置 MCP 接回数据库。主连接由调用方先 reopen（它要跑迁移），
    /// 所以这里排在主连接之后；失败只影响 AI 工具，不影响主功能
    pub fn reopen_mcp_internal_db(&self, db_path: &std::path::Path) {
        if let Some(mcp_db) = &self.mcp_internal_db {
            if let Err(e) = mcp_db.reopen(db_path, /* writable */ true) {
                log::error!("[mcp-internal] 重开数据库连接失败，AI 工具需重启应用后恢复: {e}");
            }
        }
    }

    pub async fn resume_mcp_http(&self, paused: PausedMcpHttp) {
        #[cfg(desktop)]
        if let Some(params) = paused {
            use crate::services::mcp_http as h;
            for (key, value) in [
                (h::KEY_ENABLED, "1".to_string()),
                (h::KEY_PORT, params.port.to_string()),
                (h::KEY_TOKEN, params.token.clone()),
                (h::KEY_WRITABLE, if params.writable { "1" } else { "0" }.to_string()),
                (h::KEY_BIND_LAN, if params.bind_lan { "1" } else { "0" }.to_string()),
            ] {
                if let Err(e) = self.db.set_config(key, &value) {
                    log::warn!("[mcp-http] 写回配置 {key} 失败: {e}");
                }
            }
            self.mcp_http.resume(params).await;
        }
        #[cfg(not(desktop))]
        let _ = paused;
    }

    pub fn new(
        db: Database,
        data_dir: PathBuf,
        instance_id: Option<u32>,
        mcp_internal: Option<Arc<InternalMcpClient>>,
        mcp_internal_db: Option<Arc<kb_core::KbDb>>,
        lock_file: Option<File>,
    ) -> Self {
        Self {
            db: Arc::new(db),
            data_dir,
            instance_id,
            ai_cancel: Mutex::new(std::collections::HashMap::new()),
            plugin_ai_cancel: Mutex::new(std::collections::HashMap::new()),
            sync_scheduler_notify: Arc::new(Notify::new()),
            reminder_notify: Arc::new(Notify::new()),
            push_notify: Arc::new(Notify::new()),
            sync_v1_gate: crate::services::sync_v1::lock::SyncGate::new(),
            lan_sync: Arc::new(crate::services::lan_sync::LanSyncState::default()),
            pending_open_md_path: Mutex::new(None),
            vault: RwLock::new(VaultState::default()),
            mcp_internal,
            mcp_internal_db,
            #[cfg(desktop)]
            mcp_external: Arc::new(crate::services::mcp_client::McpClientManager::new()),
            #[cfg(desktop)]
            mcp_http: Arc::new(crate::services::mcp_http::McpHttpState::default()),
            _lock_file: lock_file,
            plugin_tokens: PluginTokenRegistry::default(),
            plugin_rate_limiter: PluginRateLimiter::new(),
            claude_agent_processes: Arc::new(Mutex::new(std::collections::HashMap::new())),
            ppt_job_cancel: Arc::new(Mutex::new(std::collections::HashMap::new())),
            ppt_job_pause: Arc::new(Mutex::new(std::collections::HashMap::new())),
            ppt_plan_cancel: Arc::new(Mutex::new(std::collections::HashMap::new())),
            ppt_plan_pause: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }
}
