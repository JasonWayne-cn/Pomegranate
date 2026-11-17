# 合并清单（P0 基线）

> 生成时间：2026-10-22
> 分支：`feature/merge-kb-2.0`
> 备份标签：`pre-merge-1.8.0`
> 基线快照：`/tmp/kb-v180`（Knowledge Base `v1.8.0`，554 个文件）

## 1. 基线结论

| 项目 | 当前仓库（Pomegranate） | 升级版（Knowledge Base） |
|---|---|---|
| 版本 | 1.8.0 | 2.0.0 |
| 提交数 | 49 | 857 |
| 初始快照 | KB v1.8.0 + 11 个文件 | — |
| Rust `SCHEMA_VERSION` | 42 | 67 |
| 共同基准 | **KB v1.8.0，`SCHEMA_VERSION = 34`** | — |

Pomegranate 初始提交 `2af2fff` 与 KB `v1.8.0` 的文件差异仅 11 个，确认同源。

## 2. 差异规模

| 范围 | 共同且不同 | 仅升级版有 | 仅当前版有 |
|---|---:|---:|---:|
| `src-tauri/src/` | 93 | 62 | 20 |
| `src/` | 128 | 159 | 28 |

## 3. 升级版独有 Rust 模块（按层）

### commands
`app_lock`、`dataset`、`dataview`、`excel_import`、`font`、`mobile_update`、`ocr`、`projects`、`push`、`reminder_sound`、`snapshot`、`task_attachment`、`whiteboard`、`window`

### database
`cjk`、`dataset`、`dataset_query`、`dataview`、`fusion`、`note_attachments`、`projects`、`push`、`snapshots`、`task_attachments`、`text_health`、`url_mapping`、`whiteboard`

### services
`anthropic`、`app_lock`、`citations`、`daily_import`、`dataset`、`dataset_detect`、`dataview`、`db_recovery`、`excel_import`、`excel_parser`、`export_merge`、`folder_watch`、`legacy_api_url`、`mac_ocr`、`mcp_http`、`model_service`、`note_excerpt`、`ocr`、`project`、`push/*`、`reminder_sound`、`snapshot`、`sync_v1/attachment_gc`、`sync_v1/attachment_scan`、`sync_v1/conflicts`、`sync_v1/lock`、`sync_v1/note_md`、`task_attachment`、`url_safety`、`window_size`、`win_msg_guard`

### 根模块
`close_watchdog.rs`、`crash_handler.rs`

## 4. 当前版独有 Rust 模块（必须保留）

| 层 | 文件 |
|---|---|
| commands | `ai_provider.rs`、`claude_agent.rs`、`plugin_proxy.rs`、`plugin_runtime.rs`、`plugins.rs`、`session.rs` |
| database | `claude_agent.rs`、`plugins.rs`、`session.rs` |
| models | `ai_provider.rs`、`session.rs` |
| services | `claude_agent.rs`、`plugin_rate_limit.rs`、`plugin_token.rs`、`plugins.rs`、`provider_registry.rs`、`session_manager.rs`、`session_plan.rs` |
| 根模块 | `win7_stubs.rs` |

## 5. 升级版独有前端（按目录）

| 目录 | 文件数 | 代表内容 |
|---|---:|---|
| `src/lib` | 76 | 测试工具、导出/打印、任务解析、路径处理、音频 |
| `src/components` | 66 | 白板、数据集、OCR、推送、快照、任务增强、编辑器块 |
| `src/store` | 7 | homeWidgets、attachmentPreview、importJobs |
| `src/pages` | 5 | push、whiteboard、quick-add、push-popup、mindmap-popout |
| `src/hooks` | 4 | 长按、窗口尺寸、静音自动停止等 |

## 6. 当前版独有前端（必须保留）

| 目录 | 代表文件 |
|---|---|
| `src/components/editor` | `UnifiedEditor.tsx`、`TiptapEditorAdapter.tsx`、`PluginEditorAdapter.tsx`、`PluginToolbarButtons.tsx`、`registerTiptapEditor.ts` |
| `src/components/plugin` | `SettingsFormRenderer.tsx`、`pluginIcons.ts` |
| `src/pages/plugins` | `index.tsx`、`PluginPanelViewPage.tsx` |
| `src/pages` | `task-session/index.tsx`、`project-sessions/index.tsx` |
| `src/services` | `pluginManager.ts`、`pluginApi.ts`、`editorBridge.ts` |
| `src/hooks` | `usePluginTaskViews.ts` |
| `src/store` | `homeLayout.ts` |
| `src/types` | `editor.ts` |
| 布局 | `RibbonBar.tsx`、`InstanceBadge.tsx`、`Sidebar.tsx` |

## 7. 共同文件差异 Top（必须三方合并）

### Rust
`services/ai.rs`(4059)、`database/schema.rs`(2353)、`services/sync_v1/manifest.rs`(2036)、`services/sync.rs`(1793)、`models/mod.rs`(1495)、`services/sync_v1/pull.rs`(1357)、`lib.rs`(1190)、`database/notes.rs`(1188)、`database/tasks.rs`(1044)、`services/data_dir.rs`(1042)、`services/web_clip.rs`(892)、`database/ai.rs`(876)、`database/tags.rs`(866)、`services/export_html.rs`(851)、`services/export_word.rs`(820)

### 前端
`pages/settings/index.tsx`(3786)、`components/layout/panels/NotesPanel.tsx`(1610)、`store/index.ts`(1602)、`types/index.ts`(1583)、`pages/home/index.tsx`(1543)、`pages/notes/editor.tsx`(1531)、`components/editor/EditorToolbar.tsx`(1425)、`components/editor/TiptapEditor.tsx`(1262)、`components/editor/AiWriteMenu.tsx`(1187)、`lib/api/index.ts`(1034)、`components/ui/RecommendCards.tsx`(1000)、`components/tasks/CreateTaskModal.tsx`(984)、`pages/ai/index.tsx`(933)

## 8. 功能域批次映射

| 批次 | 功能域 | 合并方式 |
|---|---|---|
| A | 白板、Excel 导入、OCR、提醒音、推送、快照、应用锁、字体、窗口、移动端更新 | 新增文件直接移植 |
| B | 数据集/数据视图、项目、任务附件、日记导入、文件夹监听、附件 GC | 新增为主 + 少量注册 |
| C | 同步、AI、笔记、任务、搜索、导入导出 | 三方合并共同文件 |
| D | 编辑器扩展 | 装入 Pomegranate 的 Adapter |
| E | 设置页、首页、布局、导航 | 保留 Pomegranate 框架，插入升级版 Section/卡片 |

## 9. P0 验收状态

| 项 | 状态 |
|---|---|
| 备份标签 `pre-merge-1.8.0` | 已创建 |
| 合并分支 `feature/merge-kb-2.0` | 已创建 |
| v1.8.0 基线快照 | 已导出到 `/tmp/kb-v180` |
| schema 基线版本 | 已确认：34 |
| 差异清单 | 已生成（本文件） |
| 三方合并脚本 | `scripts/merge-three-way.sh` |
| 编译基线 | 待验证（当前工作区无 `node_modules` / `target`） |
