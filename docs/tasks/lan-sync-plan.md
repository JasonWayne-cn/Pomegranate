# 局域网同步实施方案（含同步凭据加密前置）

> 创建：2026-11-23
> 参照：knowledge-base v3.4–v3.5.1 `docs/tasks/lan-sync-tasks.md` 及各实现文件
> 本仓基线：Pomegranate 2.2.0，`sync_v1` 已有 local / webdav / s3，schema 90
> 关联文档：`docs/tasks/v3.5.0-upgrade-plan.md`（把 LAN 列为独立立项）、`docs/tasks/ui-v4-redesign-plan.md`
> 结论：LAN 与 V3.5.0 可靠性升级分开推进；**先补同步凭据加密，再做 LAN**。

## 1. 目标

让手机与电脑在同一 Wi-Fi 下直接同步，不经云端：

- 电脑常驻当主机，手机扫码配对后一键推送/拉取。
- 同步算法、冲突处理、附件去重复用现有 `sync_v1`。
- 全链路加密：HTTPS（自签 + 证书指纹固定）+ Bearer 令牌 + 库级租约。
- 可选：手机临时当主机（Android）。

## 2. 现状对比（本仓 vs KB）

| 维度 | 本仓 | KB v3.5.1 | 结论 |
|------|------|-----------|------|
| 同步源类型 | local / webdav / s3 | + lan | 缺 |
| 传输 | 文件 / HTTP / S3 | 局域网 HTTPS | 缺 |
| 服务端 | 无 | `lan_server.rs` 707 行 | 缺 |
| 客户端 | 无 | `backend_lan.rs` 422 行 | 缺 |
| 协议 | 无 | `lan_protocol.rs` 146 行 | 缺 |
| 发现 | 无 | `lan_discovery.rs` 204 行（mDNS） | 缺 |
| 主机编排 | 无 | `lan_sync.rs` 482 行 | 缺 |
| 命令 | 无 | `commands/lan_sync.rs` 5 个命令 | 缺 |
| 并发 | 进程内 `SyncGate` | 跨设备租约 120s | 缺跨设备层 |
| 桌面 UI | 3 类同步源 | 局域网标签 + 二维码 | 缺 |
| 手机 UI | 506 行，仅 WebDAV/S3 | 834 行 + 扫码 + 当主机 | 缺 |
| 凭据加密 | `sync_backends.config_json` **明文** | `enc:v1:` 字段加密 | 缺（前置） |

## 3. 前置 L0：同步凭据加密

### 3.1 KB 的实现拆解

KB 在 schema v68 做了「同步后端凭据加密」，核心是**在 DAO 边界加解密**，上层无感：

| 组件 | 位置 | 作用 |
|------|------|------|
| `crypto::encrypt_field / decrypt_field / is_encrypted_field` | `crypto.rs` | `enc:v1:` 前缀的 AES-256-GCM 字段加密，密钥由 hostname 派生 |
| `secret_fields(kind)` | `database/sync_v1.rs` | webdav → `password`；s3 → `secretKey`；lan → `token` |
| `seal_config_json(kind, json)` | 同上 | 写入前加密凭据；幂等；顺手删 `_secretUnreadable` |
| `open_config_json(kind, json, id)` | 同上 | 读出时解密；历史明文原样返回；解不开置空并打 `_secretUnreadable` |
| `keep_unsent_secrets(kind, new, old)` | 同上 | 编辑时新 JSON 缺凭据字段 → 沿用旧密文；传了（含空串）以传入为准 |
| `SECRET_UNREADABLE_KEY` | 同上 | `_secretUnreadable: true`，`parse_auth` 据此给出「重新填写」提示 |
| `migrate_v67_to_v68` | `database/schema.rs` | 加 `last_error / last_error_at` 列；遍历 webdav/s3 行密封；失败保持明文并 warn |
| `set_sync_backend_config_json` | 同上 | 程序自动改地址（如 mDNS 找回）时也走 seal |

关键取舍：

- **威胁模型**：防 `app.db` 被拷走后凭据明文泄漏；不防同机恶意程序。
- **换机器/改主机名**：密文解不开 → 置空 + 标记，让用户重填，而不是整个列表失败。
- **导出/分享**：DAO 读出即明文，因此现有配置分享流程无需改；分享弹窗继续负责明文警告。

### 3.2 本仓差异

- `crypto.rs` **已经具备** `encrypt_field / decrypt_field / is_encrypted_field`（`enc:v1:`），无需新写算法。
- `database/sync_v1.rs` 目前直接读写 `config_json`，无 `seal/open/keep_unsent`。
- `sync_backends` 表没有 `last_error / last_error_at`（LAN 状态与错误展示需要）。
- 桌面编辑表单会把 DAO 返回的明文密码回填；加密后行为不变（DAO 解密后再给前端）。
- `configShare.exportSyncBackend` 直接读 `configJson`，加密后仍拿到明文（DAO 已解密），无需改协议；只需剥离 `_secretUnreadable`。

### 3.3 本仓设计

**迁移**：schema 90 → 91（`migrate_v90_to_v91`）

1. `list_columns` 检查并补 `last_error`、`last_error_at`。
2. 查询 `kind IN ('webdav','s3')` 的 `id/kind/config_json`。
3. 对每行 `seal_config_json`；与原文不同才 `UPDATE`；失败只 warn，保持明文。
4. `set_version(91)`。

**DAO 改动**（`database/sync_v1.rs`）

- 增加 `secret_fields`、`seal_config_json`、`open_config_json`、`keep_unsent_secrets`、`SECRET_UNREADABLE_KEY`。
- `create_sync_backend`：先 seal 再插入。
- `update_sync_backend`：先读取旧 `(kind, config_json)`；kind 不变时 `keep_unsent_secrets`，再 seal。
- `list_sync_backends` / `get_sync_backend`：行映射时 `open_config_json`。
- 新增 `set_sync_backend_config_json(id, kind, json)`：seal 后只更新 config_json（LAN mDNS 找回用）。

**解析层**（`services/sync_v1/backend.rs::parse_auth`）

- 检测 `_secretUnreadable`，返回明确错误：
  「保存的同步密码无法解密（更换电脑或修改主机名后会出现），请在同步设置里编辑该后端、重新填写密码后保存」。

**前端**

- `SyncV1Section`：列表项若 configJson 含 `_secretUnreadable`，显示警告 Tag「凭据需重填」；编辑弹窗密码留空；保存即重新加密。
- `configShare`：`exportSyncBackend` 先删除 `_secretUnreadable` 再序列化。
- `MobileSync`：编辑时不回传未修改的凭据（依赖 `keep_unsent_secrets`）。

**测试**

- 迁移：webdav/s3 明文 → `enc:v1:`；重复执行幂等；坏 JSON 不阻断。
- create/update：新增即密文；编辑不带密码保留旧密文；传空串则清空。
- open：正常解密；换 hostname 模拟失败 → 字段空 + 标记；parse_auth 提示。
- 导出：`exportSyncBackend` 输出明文且无 `_secretUnreadable`。

**验收门禁**：`cargo test --lib`（相关模块）、`tsc`、`vitest`、`build`。

## 4. 局域网同步方案

### 4.1 架构

```
手机 / 另一台电脑
┌──────────────────────────────┐
│ LanBackend（实现 SyncBackendImpl）│
│ - 证书指纹固定校验               │
│ - 多地址试连 / mDNS 找回         │
│ - 租约自动申请与归还             │
└──────────────┬───────────────┘
               │ HTTPS + Bearer + X-KB-Lease
┌──────────────▼───────────────┐
│ lan_server（axum + tokio-rustls）│
│ - 8 个同步接口 + 租约接口        │
│ - 路径 / hash 二次校验           │
└──────────────┬───────────────┘
               │ LocalPathBackend
        <数据目录>/lan-vault
               ▲
               │ 电脑自己的 sync_v1 调度器（本机中转源）
```

### 4.2 模块与文件清单

| 层 | 文件 | 内容 |
|----|------|------|
| 协议 | `src-tauri/src/services/sync_v1/lan_protocol.rs` | `API_PREFIX=/kb-lan/v1`、`LEASE_HEADER`、`LEASE_TTL_SECS=120`、`MAX_BODY_BYTES=512MB`、`validate_rel_path`、`validate_hash`、`cert_fingerprint`、`random_token`、`token_eq` |
| 客户端 | `sync_v1/backend_lan.rs` | `LanBackend::with_hosts(hosts, port, token, fp)`、固定指纹 verifier、`probe` 多地址、`ensure_lease`、实现 trait 全部方法、Drop 归还租约 |
| 服务端 | `services/lan_server.rs` | `StartParams`、`LanIdentity`（cert/key DER）、`VaultLease`、`RunningLanServer::shutdown`、8 个路由 |
| 主机编排 | `services/lan_sync.rs` | 配置键、证书/令牌生成、`vault_root`、`LanSyncState`、`start/stop/status`、`ensure_host_backend`（本机中转源）、`pairing_payload`、`reset_token`、`lan_ipv4_hosts`、`acquire_host_lease`、`merge_trigger` |
| 发现 | `services/lan_discovery.rs` | `_kb-lan._tcp` 广播/发现，TXT 带指纹；失败只 warn |
| 命令 | `commands/lan_sync.rs` | `lan_sync_status / enable / disable / pairing_payload / reset_pairing` |
| 状态 | `state.rs` | `AppState.lan_sync: Arc<LanSyncState>` |
| 注册 | `lib.rs` | 5 个命令；启动按 `lan_sync.enabled` 自动拉起 |
| 调度 | `sync_v1_scheduler.rs` | 中转源 push/pull 前 `acquire_host_lease` |
| 类型 | `models/mod.rs` | `SyncBackendKind::Lan`、`BackendAuth::Lan` |
| 前端 | `types/index.ts`、`lib/api/index.ts` | `"lan"`、`LanSyncStatus`、`lanSyncApi` |
| 桌面 UI | `components/settings/LanSyncSection.tsx` | 开关、端口、二维码、地址、指纹、重新配对、故障指引 |
| 手机 UI | `pages/sync/MobileSync.tsx`、`components/mobile/QrScanner.tsx`、`MobileLanHostSheet.tsx` | LAN 类型、扫码、mDNS 找回、当主机 |

### 4.3 服务端接口

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/kb-lan/v1/ping` | 存活检查 |
| GET | `/kb-lan/v1/info` | 设备名 + 协议版本 |
| POST | `/kb-lan/v1/lease` | 申请租约（返回 lease_id + ttl） |
| DELETE | `/kb-lan/v1/lease/{id}` | 归还 |
| GET/PUT | `/manifest` | 读/写 manifest（PUT 需租约） |
| GET/PUT/DELETE | `/note?path=` | 文档读写删（写需租约） |
| GET/HEAD/PUT | `/attachment/{hash}` | 附件 CAS |
| GET | `/attachments` | 附件 hash 列表 |
| GET | `/root-files` | 根目录文件列表 |

**服务端二次校验**：网络传入路径必须过 `validate_rel_path`（拒绝绝对路径、`..`、反斜杠、冒号、NUL、空段、>512）；附件 hash 必须 64 位小写 hex。

### 4.4 安全设计

1. **传输**：自签证书（rcgen）+ rustls；客户端配对时拿到指纹，之后只认该指纹。
2. **认证**：Bearer 令牌，常量时间比较；二维码泄露 → 「重新生成配对码」使旧令牌失效。
3. **租约**：写操作必须持有 `x-kb-lease`；120 秒不续自动失效；电脑端同步中转源前也拿同一把。
4. **路径安全**：服务端校验，不信任客户端。
5. **密钥落盘（本仓增强）**：
   - LAN 客户端令牌走 L0 的 `secret_fields("lan") = ["token"]` 加密。
   - 主机自身 `lan_sync.token` 与 `lan_sync.key_der`（私钥）建议用 `crypto::encrypt_field` 加密存 `app_config`，启动时解密；配对二维码仍输出明文令牌。
   - 证书公钥无需加密。

### 4.5 数据流与自动合并

1. 电脑开启 LAN：生成/加载证书与令牌；确保「局域网同步（本机中转）」同步源存在（本地目录 `<数据目录>/lan-vault`，自动同步 5 分钟）。
2. 手机扫码：`{t:"kb-lan", v:1, name, hosts, port, fp, token}` → 建 `lan` 同步源。
3. 手机同步：`LanBackend` 试连 hosts → 拿 manifest → 推/拉 → 归还租约。
4. 手机写过并归还租约 → 服务端回调 `merge_trigger` → 电脑立即后台同步中转源（不等 5 分钟）。
5. 电脑端中转源同步前先拿主机租约，避免与手机写入交错。

### 4.6 依赖

| crate | 用途 | 本仓现状 |
|-------|------|---------|
| `rustls 0.23`（ring, std, tls12, logging） | TLS | 已在锁文件中（间接） |
| `tokio-rustls 0.26`（ring, tls12, logging） | TLS 接入 axum | 已在锁文件中（间接） |
| `rcgen 0.13`（ring, pem, crypto） | 自签证书 | 需新增 |
| `mdns-sd 0.21` | mDNS 广播/发现 | 需新增 |
| `if-addrs 0.15` | 枚举私网 IPv4 | 需新增 |
| `hyper-util`（server/http1/tokio/service） | axum 接到 TLS 连接 | 需确认/补 feature |
| `axum 0.8` | 服务端 | 已有 |
| `jni` / `ndk-context` | 手机当主机（可选） | 需新增（L5） |

### 4.7 分阶段实施

| 阶段 | 内容 | 验收 |
|------|------|------|
| **L0** | 凭据加密（第 3 节） | 迁移/幂等/保留/失败提示测试通过 |
| **L1** | 协议 + 客户端 + 服务端 + 租约 + 单测；两台电脑直连 | 读写往返；无租约写被拒；错误令牌/冒充证书被拒；路径越界被拒 |
| **L2** | 主机编排 + 本机中转源 + 调度器租约 + 自动启动 + 桌面 UI 二维码 | 电脑开服务；二维码可扫；中转源出现且自动同步；租约只对中转源生效 |
| **L3** | 手机端 `lan` 类型 + 扫码 + 手动同步 | 真机推/拉/删除/附件/冲突通过 |
| **L4** | mDNS 广播与手机找回 + 状态文案 + 故障指引 | 换 IP 后手机 5 秒内找回；防火墙/睡眠/换 Wi-Fi 提示可操作 |
| **L5（可选）** | 手机当主机（Android） | 另一台手机扫码直连；退出页面即停服务 |

### 4.8 测试矩阵

- 协议单测：路径、hash、令牌、指纹格式。
- 服务端单测：读写往返、租约超时、租约互斥、错误令牌、冒充证书、路径越界、超大请求。
- 端到端：手机推 5 篇 + 删除 + 拉 50 篇 + 附件；无冲突；两边收敛。
- 网络：换 IP mDNS 找回、防火墙拒绝、AP 隔离、电脑睡眠唤醒。
- 竞态：手机同步与电脑中转源同步同时触发；手机中断后租约 120s 失效。
- 回归：LAN 不影响 WebDAV/S3；Win7 构建；Android 构建体积。

## 5. 风险与对策

| 风险 | 对策 |
|------|------|
| 防火墙拦截（首次监听 0.0.0.0） | 界面明确提示「允许专用网络」；提供排障步骤 |
| 路由器 AP 隔离 / 公司网络 | 提示换 Wi-Fi 或开热点；不把它当 Bug |
| mDNS 先返回 IPv6 链路本地 | 等待 IPv4 再写回配置（KB 踩坑）；保留手动改地址 |
| 换机器后凭据解不开 | L0 已有 `_secretUnreadable` + 重填入口 |
| 租约死锁 | 120s TTL + 每次请求续期 + Drop 归还 |
| 令牌泄露 | 重新生成配对码；界面警示二维码敏感性 |
| Win7 | 需实际构建验证 rcgen/mdns/ring；必要时为 `win7-compat` 降级 mDNS |
| Android 主机 | JNI ClassLoader、Manifest 权限、R8 keep；单列为 L5 |
| 端口冲突 | 启动失败保留用户端口设置；提示改端口 |

## 6. 回滚与兼容

- L0 迁移失败的行保持明文，不阻断启动。
- LAN 开关关闭即停服务；中转源保留，用户可手动删。
- 删除 LAN 不影响其它同步源；`SyncBackendKind` 新增变体对旧数据向后兼容。
- 协议带 `/v1` 前缀，后续不兼容可并行 `/v2`。

## 7. 与现有计划的关系

- L0 是 V3.5.0 P3 缺失项（凭据保留/加密），可先并入可靠性版本。
- LAN 本身单独立项，不与 UI v4 混做。
- 实施前确认工作区无其它会话未提交改动；必要时用 worktree。
