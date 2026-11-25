# 局域网同步开发计划（差异核对版）

> 核对：2026-11-25，工作区基于 `main@1ce1082` + 未提交改动
> 依据：`docs/tasks/lan-sync-plan.md`
> 参考实现：`D:\AI\W-Pomegranate-knowledge-base`（KB 仓库，`SCHEMA_VERSION = 73`，LAN 代码已完整存在）
> 结论：方案可行，KB 的 Rust/前端实现可直接移植；但原 plan 在 **schema 编号、封装标记语义、调度器基线、移动端基线、工作区占用** 五处与现状不符，需按本文修正后执行。

---

## 1. 核对结论摘要

| # | 原 plan 说法 | 实际现状 | 影响 |
|---|-------------|---------|------|
| 1 | 基线 schema 90，L0 走 `migrate_v90_to_v91` | `SCHEMA_VERSION = 94`（`database/schema.rs:6`），v91–v94 已被文件夹同步 / 闪卡提示词模板 / AI 会话置顶 / ASR 词表占用（`schema.rs:130-133`） | **L0 必须改为 v94→v95** |
| 2 | 本仓 `sync_v1` 只有 local/webdav/s3 | 正确。另有 v91/v92 的文件夹、闪卡、提示词、模板同步；LAN 传输走通用 manifest + notes + attachments，**无需新增接口** | 无迁移冲突，仅测试面变大 |
| 3 | `crypto.rs` 已具备字段加密 | 正确：`encrypt_field` / `decrypt_field` / `is_encrypted_field`（`crypto.rs:99/114/91`），另有 `decrypt_field_or_none`（`:127`） | 直接复用，无需新增算法 |
| 4 | `sync_v1_scheduler` 加租约即可 | 本仓调度器缺 KB 的失败退避、`last_error` 记录、批量删除保护、`take_discovered_hosts` 回写；本仓独有 `index_queue::enqueue_all` | **必须做外科手术式改造，禁止整文件覆盖** |
| 5 | 手机 UI 506 行，支持 WebDAV/S3 | 实际 506 行，**仅 WebDAV**（`MobileSync.tsx:32` 注释即写明），连 S3 都没有；无扫码组件、无 `mobileSyncBackends` / `syncGuards` / `primitives` 公共件；`AndroidManifest.xml` 无 `CAMERA` 权限 | L3 工作量大于原 plan 预估，且与 `docs/tasks/mobile-v4-plan.md` 重叠 |
| 6 | （未提） | `state.rs`、`services/mod.rs`、`commands/mod.rs` 有其它会话未提交改动（+75 行，AI/MCP 方向） | 开工前必须 worktree 或先合并，不能直接改 |

---

## 2. 逐项差异核对

### 2.1 前置 L0：同步凭据加密

| 项 | plan | 实际 | 动作 |
|----|------|------|------|
| schema 迁移 | 90→91 | 94→95；v91 已是文件夹同步 | 新函数 `migrate_v94_to_v95` + 分发臂 |
| `sync_backends` 列 | 缺 `last_error/last_error_at` | 确认缺（`schema.rs:1032-1044`） | v95 补两列 |
| DAO 封装函数 | 需新增 `secret_fields/seal/open/keep_unsent` | `database/sync_v1.rs` 完全未实现；`create`(:98)/`update`(:119)/`list`(:34)/`get`(:66) 均直读写 `config_json` | 从 KB `database/sync_v1.rs:40-180` 移植 |
| `set_sync_backend_config_json` | 需要 | 不存在 | L0 实现（L2/L4 写回 mDNS 地址用） |
| `set_sync_backend_error` | plan 未列 | 不存在；但 LAN 主机状态 `host_last_error` 依赖它 | **纳入 L0**（KB `:341`） |
| 模型 | 无 | `SyncBackend` 无 `last_error*`（`models/mod.rs:1657`） | 加两个 `Option<String>` + `#[serde(default)]` |
| `parse_auth` | 检测 `_secretUnreadable` | 无检测（`backend.rs:156`） | 加提前返回明确错误 |
| 桌面编辑表单 | 加密后行为不变 | `SyncV1Section` 编辑时用解密后的 `password` 回填（`:145-150`） | 行为不变；新增「凭据需重填」Tag |
| 移动端编辑 | 不回传未修改凭据 | 已满足：密码为空时不写该字段（`MobileSync.tsx:129`） | 依赖 `keep_unsent_secrets`，无需改 |
| 配置导出 | 剥离 `_secretUnreadable` | `exportSyncBackend` 直接 `JSON.parse(configJson)`（`configShare.ts:176`） | 导出前 `delete cfg._secretUnreadable`（`exportWebDavBackend` 同理） |
| 主机自身密钥 | plan 的「本仓增强」 | KB 把 `lan_sync.token` / `lan_sync.key_der` **明文**存 `app_config` | L2 用 `crypto::encrypt_field` 包裹，解不开则重新生成并提示重配对 |

**必须修复的 KB 缺陷（本仓增强）**：KB 的 `seal_config_json` 无条件删除 `_secretUnreadable`，而 `keep_unsent_secrets` 会原样保留解不开的旧密文 → 用户点一次保存，警告消失但密码仍不可用，下次同步报错更难定位。
> 修正规则：**仅当所有凭据字段都非空且可解密（或刚被明文加密）时才删除标记**；否则保留标记，让 UI 持续提示重填。

### 2.2 局域网能力缺口（后端）

| 模块 | 本仓 | KB | 移植方式 |
|------|------|----|---------|
| 协议 | 无 | `sync_v1/lan_protocol.rs` 146 行 | 整文件复制 |
| 客户端 | 无 | `sync_v1/backend_lan.rs` 422 行 | 整文件复制 |
| 服务端 | 无 | `services/lan_server.rs` 707 行（含 `VaultLease`） | 整文件复制 |
| 主机编排 | 无 | `services/lan_sync.rs` 482 行 | 整文件复制 + 密钥加密改造 |
| mDNS | 无 | `services/lan_discovery.rs` 204 行 | 复制（L4 启用；Android 分支需 `android_jni` 支持） |
| 命令 | 无 | `commands/lan_sync.rs` 65 行 / 5 个命令 | 整文件复制 |
| 模型 | `SyncBackendKind` 3 变体（`models/mod.rs:1645`） | +`Lan`，`BackendAuth::Lan` | 逐处补分支 |
| trait | 75–151 行 | 完全相同，另有 `take_discovered_hosts()` 默认方法 | 只加默认方法 + Lan 分支 |
| 状态 | `AppState` 无 lan（`state.rs:20`） | `lan_sync: Arc<LanSyncState>` | 加字段（注意该文件被占用） |

`SyncBackendKind` 需要同步的分支点（已核对）：
- `database/sync_v1.rs:13-27` `parse_kind` / `kind_to_str`
- `services/sync_v1/backend.rs:176` `parse_auth`、`:197` `create_backend`
- `src/types/index.ts:2383`
- `src/components/settings/SyncV1Section.tsx:100/106/772`（`Record` 穷举会编译报错，天然兜底）

### 2.3 调度器差异（重点）

| 能力 | 本仓 | KB |
|------|------|----|
| 进程内互斥 | `SyncGate`（`lock.rs`） | 相同 |
| 失败退避 | 无 | 指数退避（`sync_v1_scheduler.rs:35-86`） |
| `last_error` 落库 | 无 | `record_outcome` (:257+) |
| 批量删除保护 | 无（`SyncPullResult` 无 `deletions_held`） | 有 |
| 局域网主机租约 | 无 | pull/push 前 `acquire_host_lease`（KB :322/:363） |
| mDNS 新地址回写 | 无 | `remember_discovered_hosts` + `set_sync_backend_config_json` |
| 拉取后重建向量索引 | 有（`index_queue::enqueue_all`） | 未见 |

实施策略：只在 `run_pull_blocking` / `run_push_blocking` 内、拿到 backend 配置后插入 `acquire_host_lease`，并在结果返回前调用 `remember_discovered_hosts`；**不得整体覆盖文件**。失败退避与批量删除保护属于 V3.5.0 可靠性范围，**不随 LAN 顺带做**。

### 2.4 依赖核对

| crate | plan | 实际 | 动作 |
|-------|------|------|------|
| `axum 0.8` | 已有 | `Cargo.toml:140`，features 仅 `http1, tokio` | 补 `query` |
| `rustls 0.23` | 锁文件中（间接） | 锁文件 0.23.37（reqwest 带入） | 加**直接依赖** `ring,std,tls12,logging` |
| `tokio-rustls 0.26` | 锁文件中（间接） | 0.26.4 | 加直接依赖 |
| `hyper-util` | 需确认 | 0.1.20 在锁文件（间接） | 加直接依赖：`server,http1,tokio,service` |
| `rcgen 0.13` | 需新增 | 无 | 新增 `ring,pem,crypto` |
| `if-addrs 0.15` | 需新增 | 无 | 新增 |
| `mdns-sd 0.21` | 需新增 | 无 | 新增（L4） |
| `tokio` | 未提 | `Cargo.toml:58` 缺 `net` | 补 `net`（服务端 `TcpListener`） |
| `rand/base64/sha2/hostname` | 未提 | 已有（`rand 0.8`） | 无需新增 |

### 2.5 前端差异

| 项 | 本仓 | KB | 动作 |
|----|------|----|------|
| 桌面同步源列表 | `SyncV1Section.tsx` 988 行，3 类 | 1024 行，含 LAN 展示 | 移植 LAN 展示逻辑，不整体覆盖 |
| 桌面设置标签 | `SyncTabs.tsx` 2 页（V1/快照） | 3 页（+局域网） | 新增标签 + `LanSyncSection` |
| 扫码渲染 | `qrcode` 依赖已存在（`package.json`） | 相同 | 直接使用 |
| 移动扫码 | `html5-qrcode` 已存在，但无通用组件 | `QrScanner.tsx` 64 行 | L3 复制 |
| 移动同步页 | 506 行，仅 WebDAV | 834 行，WebDAV+S3+LAN+扫码+当主机 | **按功能切片移植**，见 §4 L3 |
| 移动当主机 | 无 | `MobileLanHostSheet.tsx` 189 行 | L5 |
| 缺失公共件 | 无 `MobileSyncBackends` / `syncGuards` / `Mobile` primitives | 有 | L3 需从 KB 一并评估，或改写为直接调用 |
| Android 权限 | 无 `CAMERA`（`AndroidManifest.xml`） | 有 | L3 增加 |
| `relativeTime` | 已有（`src/lib/utils.ts:96`） | 相同 | 直接使用 |

### 2.6 工作区与并行冲突

- `state.rs` / `services/mod.rs` / `commands/mod.rs` 被其它会话占用（未提交），LAN 的 L2 必需修改这三处。
- 存在未跟踪的 `docs/tasks/mobile-v4-plan.md`，与 L3/L5 重叠（移动端公共件、当主机）。
- 建议：**用 `EnterWorktree` / `claude --worktree feature/lan-sync` 隔离开发**；若必须在本工作区做，先与占用会话合并，或至少只做 L0（不碰上述三文件）。

---

## 3. 设计修正

### 3.1 L0 迁移（v94→v95）

1. `list_columns("sync_backends")` 补 `last_error`、`last_error_at`。
2. 仅遍历 `kind IN ('webdav','s3')`，逐行 `seal_config_json`；值变化才 `UPDATE`；失败 `warn` 保留明文。
3. `set_version(conn, 95)`；同步更新 `SCHEMA_VERSION` 与分发臂。
4. 幂等：已在 v95 的库不再执行；重复调用 seal 不二次加密。

### 3.2 `seal/open/keep_unsent` 语义修正

- `seal_config_json(kind, json)`：加密非空凭据字段；**只有**在“所有凭据字段均为可解密值或本次新加密值”时才移除 `_secretUnreadable`。
- `open_config_json(kind, json, id)`：沿用 KB；解不开置空 + 标记 + `warn`。
- `keep_unsent_secrets`：沿用 KB；只在 kind 未变时补齐缺失字段。
- `update_sync_backend`：读取旧 `(kind, config_json)`；kind 相同才 merge；再 seal。
- `parse_auth`：命中标记直接返回可操作错误，避免空密码 401。

### 3.3 调度器最小侵入

在 `run_pull_blocking` / `run_push_blocking` 取得 `SyncBackend` 后：
```rust
let _lan_lease = crate::services::lan_sync::acquire_host_lease(&state.lan_sync, &state.db, backend_id)?;
```
同步结束（含失败）后调用 `remember_discovered_hosts(&state.db, &cfg, backend_impl.as_ref())`。
排除：失败退避、`last_error` 写入（若 L0 已加 `set_sync_backend_error`，可在同一处顺手写入，但 UI 展示另行排期）、批量删除保护。

### 3.4 主机身份加密（本仓增强）

- `lan_sync.token`：`crypto::encrypt_field` 存；读取时 `decrypt_field`；解不开 → 重新生成令牌（旧配对失效）+ 界面提示。
- `lan_sync.key_der`：同上；解不开 → 重新生成证书（旧配对失效）。
- 证书公钥 / 指纹不加密；配对二维码始终输出明文令牌。
- 客户端令牌由 L0 的 `secret_fields("lan") = ["token"]` 负责。

### 3.5 Win7 兼容

- `win7-compat` 是空 feature（`Cargo.toml:31`），当前仅用于跳过通知注册。
- 新增依赖全部纯 Rust（ring / rcgen / mdns-sd），**预期可编**，但必须在 Win7 构建流水线实测。
- 若 `mdns-sd` 或 `ring` 在 Win7 不可用：用 `#[cfg(not(feature = "win7-compat"))]` 关闭 mDNS 与服务，保留 UI 隐藏；不影响其它同步源。**不作为静默降级**，需在界面上说明。

### 3.6 平台范围

- L1–L4：服务端仅桌面（`cfg(desktop)`）；客户端桌面 + 移动端共用。
- L5：手机当主机，Android 专用；`lan_discovery` 的组播锁依赖 `services/android_jni`，本仓目前只有 `commands/mobile_update.rs` 内的内联 JNI 模块（安装 APK 用），需先抽公共模块。

---

## 4. 分阶段开发计划

### L0 同步凭据加密（可独立先行合并）

**后端**
- [ ] `database/sync_v1.rs`：新增 `secret_fields / SECRET_UNREADABLE_KEY / seal_config_json / open_config_json / keep_unsent_secrets`；改 `list/get` 行映射；`create` 先 seal；`update` merge+seal；新增 `set_sync_backend_config_json`、`set_sync_backend_error`。
- [ ] `models/mod.rs`：`SyncBackend` 加 `last_error / last_error_at`。
- [ ] `services/sync_v1/backend.rs::parse_auth`：识别 `_secretUnreadable`。
- [ ] `database/schema.rs`：`SCHEMA_VERSION=95`、分发臂 `94 => migrate_v94_to_v95`、迁移函数。
- [ ] 单测：迁移幂等、坏 JSON 不阻断、编辑不带密码保留、空串清空、解密失败标记、`set_config_json` 仍加密。

**前端**
- [ ] `src/types/index.ts`：`SyncBackend` 加 `lastError? / lastErrorAt?`。
- [ ] `SyncV1Section.tsx`：列表项含 `_secretUnreadable` → 显示「凭据需重填」Tag；编辑框密码置空。
- [ ] `configShare.ts`：两个导出函数剥离 `_secretUnreadable`。

**验收**：`cargo test --lib`（sync_v1 相关）、`npx tsc --noEmit`、`pnpm vitest run`、`pnpm build`。
**回滚**：迁移失败行保持明文；不阻断启动。

---

### L1 协议 + 客户端 + 服务端 + 租约

- [ ] `Cargo.toml`：按 §2.4 补依赖；`tokio` 加 `net`；`axum` 加 `query`。
- [ ] 复制 `sync_v1/lan_protocol.rs`、`sync_v1/backend_lan.rs`、`services/lan_server.rs`。
- [ ] `models/mod.rs`：`SyncBackendKind::Lan`、`BackendAuth::Lan`。
- [ ] `backend.rs`：`parse_auth` Lan 分支、`create_backend` 工厂、trait 默认 `take_discovered_hosts`。
- [ ] `sync_v1/mod.rs`：注册新模块。
- [ ] 单测：协议（路径/hash/令牌/指纹）、服务端（读写往返、租约超时/互斥、错误令牌、冒充指纹、越界路径、超大请求）。
- [ ] 手工：两台电脑直连（A 起服务，B 用临时命令/测试客户端推拉）。

**验收**：无租约写入被拒；错误令牌/错误指纹被拒；路径越界被拒；读写往返一致。
**门禁**：`cargo test --lib`、`cargo check --target aarch64-linux-android`（客户端可编）。

---

### L2 主机编排 + 中转源 + 自动启动 + 桌面 UI

- [ ] 复制 `services/lan_sync.rs`；改造 `ensure_identity/ensure_token` 使用字段加密；`host_backend_id/ensure_host_backend` 保持 KB 行为。
- [ ] `state.rs`：`lan_sync: Arc<LanSyncState>`（**注意文件被占用**）。
- [ ] `services/mod.rs` / `commands/mod.rs`：注册模块；`commands/lan_sync.rs` 5 个命令。
- [ ] `lib.rs`：`generate_handler!` 注册；启动按 `lan_sync.enabled` 自动拉起（与 KB `lib.rs:1199` 对齐）。
- [ ] 调度器：pull/push 前租约 + `remember_discovered_hosts`（§3.3）。
- [ ] 前端：`types`（`lan`、`LanSyncStatus`）、`lib/api`（`lanSyncApi`）、`SyncTabs` 新增标签、`LanSyncSection.tsx`（开关/端口/二维码/地址/指纹/重新配对/排障）。
- [ ] 手工：开启服务 → 出现「局域网同步（本机中转）」源（Local，5 分钟自动同步）→ 二维码可扫 → 手机改完后电脑立即合并。

**验收**：租约只对中转源生效；关服务不影响其它同步源；端口占用时保留用户设置并提示。

---

### L3 手机端 LAN + 扫码 + 手动同步

**范围裁剪（先做核心）**
- [ ] `MobileSync.tsx`：后端列表识别 `lan`（显示设备名/地址/指纹状态）；新增「扫码添加」入口；手动 推送/拉取/测试/删除。
- [ ] `components/mobile/QrScanner.tsx`：从 KB 复制（动态加载 `html5-qrcode`）。
- [ ] 解析配对码：`{t:"kb-lan", v:1, name, hosts, port, fp, token}` → `createSyncBackend`（`configJson` 明文，DAO 自动加密 token）。
- [ ] `AndroidManifest.xml`：补 `CAMERA`。
- [ ] 错误文案：`_secretUnreadable`、租约占用、证书指纹不匹配、连接超时。

**暂不随 L3 做**
- S3 表单补齐、`mobileSyncBackends` / `syncGuards` / `primitives` 公共件重构 —— 归入 `mobile-v4-plan.md`，避免双线冲突。
- 批量删除保护（后端无 `deletions_held`）。

**验收**：真机 推 5 篇 + 删除 + 拉 50 篇 + 附件；两边收敛；无冲突。

---

### L4 mDNS 广播与找回

- [ ] 新增 `mdns-sd` 依赖；复制 `services/lan_discovery.rs`。
- [ ] `LanSyncState::start/stop` 挂接 advertiser（KB `lan_sync.rs:174-214`）。
- [ ] `backend_lan` 已含 `discover` 逻辑：确认 `take_discovered_hosts` 与调度器写回（L2 已接）。
- [ ] UI：状态文案（防火墙/AP 隔离/睡眠/换 Wi-Fi）+ 「上次手机同步时间 / 合并失败原因」。
- [ ] 验收：换 IP 后手机在约定超时内找回；关闭 mDNS 时退回手动改地址。

---

### L5（可选）手机当主机（Android）

- [ ] 抽出 `services/android_jni.rs`（从 `commands/mobile_update.rs` 内联模块迁移），提供 `vm_and_context` / `load_app_class`。
- [ ] 复制 `lan_discovery` Android 组播锁分支、`MobileLanHostSheet.tsx`。
- [ ] `lan_sync` 在移动端启用（端口/证书/令牌）；离开页面即停服务。
- [ ] R8 keep 规则、Manifest 权限、构建体积检查。
- [ ] 验收：另一台手机扫码直连；退出页面服务停止。

---

## 5. 测试矩阵（在原 plan 基础上补充）

- **L0**：迁移幂等；坏 JSON；换 hostname 模拟解密失败；编辑不带密码保留；空串清空；导出无标记；`set_config_json` 二次写仍加密。
- **L1**：协议边界；租约 TTL/互斥；错误令牌、冒充证书；路径/hash 注入；超大请求。
- **L2**：中转源自动创建/重建；租约只对中转源；端口冲突；自动启动；关服务不影响其它源。
- **L3**：真机推/拉/删/附件/冲突；弱网中断后租约 120s 失效。
- **L4**：换 IP 找回；防火墙拒绝；AP 隔离；睡眠唤醒。
- **回归**：WebDAV/S3 不受影响；`cargo check` 桌面 + Android；Win7 构建；`pnpm build` 体积变化。

---

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| 工作区被其它会话占用（`state.rs` 等） | worktree 隔离；或先只合 L0 |
| 移动端 v4 计划重叠 | L3 只做 LAN 核心，公共件归 v4 计划；两文档互相引用 |
| KB `seal` 标记缺陷 | 按 §3.2 修正并加测试 |
| 调度器整体覆盖导致丢功能 | 只加两处调用；diff review 逐行 |
| Win7 构建失败 | 实测；必要时 `cfg(feature="win7-compat")` 关闭服务与 mDNS |
| Android 无 CAMERA 权限 | L3 必改 Manifest，并在真机验证扫码 |
| mDNS 返回 IPv6 链路本地 | 客户端只取 IPv4（KB `order_hosts` 已处理），保留手动地址 |
| 端口被占 | 启动失败保留端口设置；提示改端口 |
| 令牌泄露 | 「重新生成配对码」+ 界面警示二维码敏感性 |
| 换机器凭据不可解 | `_secretUnreadable` + 重填入口（L0） |

---

## 7. 开工前置检查

- [ ] `git status -s` 确认占用文件；决定 worktree。
- [ ] 与 `mobile-v4-plan.md` 作者对齐 L3 边界。
- [ ] 先做 L0 并过门禁（可独立 PR）。
- [ ] 确认 `D:\AI\W-Pomegranate-knowledge-base` 参考版本（SCHEMA 73）后，再复制文件；复制后逐文件 diff，避免带入 KB 与本仓无关的可靠性改动。
- [ ] 门禁：`cargo test --lib`、`cargo clippy`、`npx tsc --noEmit`、`pnpm vitest run`、`pnpm build`。
