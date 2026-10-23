# Schema 迁移映射（P0）

> 基线：KB `v1.8.0` = **34**
> 当前版：**42**（新增 8 个迁移：35–42）
> 升级版：**67**（新增 33 个迁移：35–67）
> 合并策略：POM 保留 1–42，KB 的 35–67 整体重编号为 **43–75**，`SCHEMA_VERSION = 75`。

## 1. 当前版新增迁移（35–42）

| 版本 | 内容 | 对象 |
|---|---|---|
| 35 | Obsidian 风格插件管理 MVP | `plugins`、`plugin_settings`、`plugin_permissions` |
| 36 | 插件设置键名前缀隔离 | `plugin_settings` 数据修复 |
| 37 | 插件审计日志 | `plugin_audit_log` |
| 38 | 插件完整性校验 | `plugins.content_hash` |
| 39 | 任务执行会话 | `task_sessions`、`execution_phases`、`execution_logs` |
| 40 | 项目文件夹会话 | `project_sessions`、`project_session_messages`、`project_session_contexts` |
| 41 | AI 模型能力字段 | `ai_models.protocol`、`supports_tools`、`supports_vision`、`max_output_tokens` |
| 42 | Claude Code Agent Runner | `claude_agent_sessions`、`claude_agent_events` |

## 2. 升级版新增迁移（35–67）

| KB 版本 | 合并后版本 | 内容 |
|---|---|---|
| 35 | 43 | `folders.color` |
| 36 | 44 | `notes.stable_uuid` |
| 37 | 45 | `note_attachments` 表 |
| 38 | 46 | `notes.attachment_scan_at` |
| 39 | 47 | `tags.parent_id` |
| 40 | 48 | `tasks.kanban_stage` |
| 41 | 49 | `projects` 表 + `tasks.project_id` / `start_date` |
| 42 | 50 | `projects` 跨端同步字段 + `sync_remote_state_project` |
| 43 | 51 | `tasks` 跨端同步字段 + `sync_remote_state_task` |
| 44 | 52 | `task_categories.stable_uuid` |
| 45 | 53 | `tags.sort_order` |
| 46 | 54 | `ai_conversations.scope_folder_id`（AI 对话按目录隔离） |
| 47 | 55 | `push_jobs`、`push_run_logs` |
| 48 | 56 | 空迁移占位（已撤销的 Rhai 脚本插件 `scripts` 表） |
| 49 | 57 | 修复 `kb-asset://` 裸空格 |
| 50 | 58 | AI 对话角色预设 `ai_conversations.preset_id` |
| 51 | 59 | 旧模型上下文默认值 32000 → 128000 |
| 52 | 60 | `notes.note_type` |
| 53 | 61 | FTS 索引一致性修复 |
| 54 | 62 | 素材路径全量归一化 |
| 55 | 63 | 日记从日期文件夹摘出 |
| 56 | 64 | `notes.is_scratch` |
| 57 | 65 | `note_snapshots` 表 |
| 58 | 66 | `note_snapshots.target_path`（白板快照） |
| 59 | 67 | 存量 API Key 就地加密 |
| 60 | 68 | `datasets`、`dataset_fields`、`dataset_rows` |
| 61 | 69 | `ai_models.max_tokens` |
| 62 | 70 | ai-profile 模型服务迁移（需人工复核） |
| 63 | 71 | `ai_messages.turn_meta_json` |
| 64 | 72 | MCP 笔记/任务补 `stable_uuid` |
| 65 | 73 | `task_attachments` 表 |
| 66 | 74 | `task_categories.parent_id` |
| 67 | 75 | `tasks.snooze_until` |

> 注意：升级版源码中 45–48 的迁移函数在文件里的排列顺序与版本号不一致，重编号时必须按版本号顺序取用，不能按源码出现顺序。

## 3. 冲突分析

| 对象 | 当前版 | 升级版 | 处理 |
|---|---|---|---|
| `ai_models` 列 | `protocol`、`supports_tools`、`supports_vision`、`max_output_tokens` | `max_tokens`、`max_output`、`limits_source` | **列不重复，取并集** |
| 插件/会话表 | `plugins`、`session*`、`project_session*`、`claude_agent*` | 无 | 保留，不受影响 |
| 业务表 | 无新增 | `projects`、`datasets`、`note_attachments`、`note_snapshots`、`push_*`、`task_attachments` | 直接追加 |
| FTS 触发器 | v34 基线 | v53 重写触发器 | 追加后必须重跑搜索测试 |
| AI 数据 | provider_registry / ai_provider | ai-profile / model_service / API Key 加密 | **人工复核 v62、v67** |
| 任务/标签字段 | 无 | `stable_uuid`、`is_deleted`、`project_id`、`kanban_stage`、`snooze_until` 等 | 直接追加 |

## 4. 重编号规则

1. 保留 POM `migrate_v34_to_v35` … `migrate_v41_to_v42` 原样不动。
2. 新建 `migrate_v42_to_v43` … `migrate_v74_to_v75`，函数体来自 KB 对应版本。
3. 每个函数的 `set_version(conn, N)` 更新为重编号后的 N。
4. `match version` 分支同步扩展。
5. `SCHEMA_VERSION = 75`。
6. 若 POM 已存在同名列（目前仅 `ai_models` 需复核），改为幂等的“列存在则跳过”。

## 5. 迁移测试矩阵

| 场景 | 起始版本 | 期望 |
|---|---|---|
| 全新安装 | 0 | 迁移到 75，全部表存在 |
| 当前版升级 | 42 | 迁移到 75，插件/会话数据保留 |
| 升级版升级 | 67 | 迁移到 75（仅补 POM 的插件/会话表），业务数据保留 |
| 基线升级 | 34 | 迁移到 75，两侧新增均生效 |
| 完整性 | 75 | `PRAGMA integrity_check` = ok |

## 6. 待人工复核点

- KB `v61→v62`：ai-profile 模型服务迁移是否改写/删除 POM 的 `ai_models` 字段。
- KB `v58→v59`：API Key 加密是否与 POM `provider_registry` 的存储格式冲突。
- KB `v52→v53`：FTS 触发器重写后，POM 自定义搜索字段是否仍被索引。
- `tasks` / `notes` 的 `stable_uuid` 回填是否覆盖 POM 已有会话数据。
