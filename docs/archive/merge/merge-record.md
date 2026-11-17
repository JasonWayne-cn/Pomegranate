# Pomegranate × Knowledge Base 2.0 融合记录

> 分支：`feature/merge-kb-2.0`
> 完成时间：2026-10-23
> 目标版本：**2.1.0**
> 基线：Knowledge Base `v1.8.0`（`SCHEMA_VERSION = 34`）

## 1. 背景与策略

Pomegranate 与 Knowledge Base 同源：Pomegranate 初始提交 = KB `v1.8.0` + 11 个插件雏形文件，但两侧没有共享 git 历史。

因此没有使用 `git merge`，而是采用：

1. 以 **Pomegranate 为基线**；
2. 以 KB `v1.8.0` 作为三方合并的 base；
3. 按功能域从 KB 2.0 移植；
4. 每个阶段独立提交，必须通过编译与测试门禁。

关键决策：

| 决策 | 结果 |
|---|---|
| 保留的 Pomegranate 能力 | 插件系统、Claude Agent/任务会话、AI Provider、Win7 独立构建、多实例锁 |
| 单实例插件 | 不注册 `tauri-plugin-single-instance`，保留 POM 自研多实例锁 |
| Tiptap | 锁定 3.20.4 以兼容 Win7 |
| 数据库 | POM 1–42 + KB v35–v67 重编号为 v43–v75，最终 `SCHEMA_VERSION = 75` |
| 品牌 | 保留 `Pomegranate` / `edu.bit.inb` |

## 2. 阶段与提交

| 提交 | 阶段 | 内容 |
|---|---|---|
| `6f25bc5` | P0 | 基线冻结、差异清单、schema 映射、三方合并脚本 |
| `560b2a1` | P1–P3A-1 | 依赖、window-state、capabilities、Vitest、schema 75、字体/OCR/提醒音/应用锁/Excel/窗口 |
| `60cc621` | P3A-2 | 白板、快照、定时推送；`notes` 增加 `note_type` / `is_scratch` |
| `ddc0bad` | P3B-1 | 数据集与数据视图 |
| `407a075` | P3B-2 | 项目、任务附件、日记导入、文件夹监听 |
| `fe08894` | P3B-3 | sync_v1 附件 CAS、冲突、同步锁、note_md |
| `3e6a309` | P3C | AI/同步/搜索/导入导出共同文件与共享 crate |
| `5c3fdaf` | P4 | 前端基础 + 177 个升级版独有文件 |
| `16d41b2` | P5–P6 | 路由、应用锁/更新 Provider、编辑器扩展、设置扩展、甘特图/项目管理 |
| `31a396b` | P7–P8 | 页面收尾、Excalidraw 字体自托管、版本 2.1.0 |

## 3. 主要融合内容

### 后端

- **白板**：`whiteboard` 命令/服务/DAO，白板块与白板快照。
- **快照**：笔记快照、白板快照、快照用量统计与清理。
- **定时推送**：推送任务、运行日志、调度器、居中弹窗。
- **数据集/数据视图**：Excel/CSV 导入、列画像、查询计划、Dataview 行。
- **项目与任务附件**：项目 CRUD、任务附件 DAO/上传/排序。
- **日记导入**：日期识别、历史日记合并、文件夹监听自动导入。
- **同步 V1**：附件 CAS、冲突文件、同步锁、笔记 Markdown、附件 GC/扫描。
- **OCR / ASR / 提醒音 / 应用锁 / 字体枚举 / Excel 导入**。
- **共享 crate**：`kb-core` 升级到 KB 2.0；新增 `axum` 与 MCP streamable HTTP。

### 前端

- 新增页面：白板、定时推送、推送弹窗、快速记一笔、思维导图弹窗。
- 新增组件：白板画布、数据集面板、任务附件、甘特图、项目管理、OCR/快照/提醒音/应用锁设置、冲突解决、MCP HTTP。
- 编辑器扩展：白板块、数据集块、分栏、搜索替换、Slash 命令。
- 路由与导航：接入推送、白板、快速记一笔、思维导图；保留插件与任务会话入口。
- 应用级能力：`AppLockGate`、`UpdaterProvider`、全局错误兜底、界面缩放。

## 4. 验证结果

| 检查 | 结果 |
|---|---|
| `cargo check --all-targets` | 通过 |
| `cargo test --lib` | **797 passed, 0 failed** |
| `pnpm exec tsc --noEmit` | 通过 |
| `pnpm test`（Vitest） | **525 passed, 0 failed** |
| `pnpm build:vite` | 构建成功 |

专项测试：

- `dataset_query_tests`：20 项通过
- `daily_import`：28 项通过
- `sync_v1`：149 项通过

## 5. 数据库迁移

- 基线：KB v1.8.0 = **34**
- POM 自有迁移：35–42（插件、会话、AI 能力字段）
- KB 迁移 35–67 重编号为 **43–75**
- 最终版本：**75**

详细映射见 [`schema-mapping.md`](./schema-mapping.md)。

## 6. 已知待人工验证项

1. **首页**：保留 POM 的拖拽排序，未完全融合升级版 HideableCard 的隐藏逻辑。
2. **编辑器工具栏**：白板/数据集/分栏/搜索替换扩展已注册，工具栏按钮可能尚未全部暴露。
3. **Win7 构建**：新增 Excalidraw、axum、rmcp streamable HTTP 后尚未重新执行 Win7 打包验证。

## 7. 相关文件

- [`inventory.md`](./inventory.md)：P0 差异清单
- [`schema-mapping.md`](./schema-mapping.md)：数据库迁移映射
- `scripts/merge-three-way.sh`：三方合并工具
- `scripts/prepare-merge-base.sh`：KB v1.8.0 基线导出
