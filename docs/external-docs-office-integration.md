# 外部文档：索引与正文分离（Office 工作台整合）

> 状态：已实施（P0）
> 更新：2026-11-17
> 关联：`docs/外部挂载文件夹.md`、`docs/office-engine-roadmap.md`、`docs/office-workbench-ui-plan.md`

---

## 1. 背景

外部挂载文件夹当前的模型是：

```
磁盘原文件（唯一数据源）
      │ 扫描时抽取
      ▼
notes 影子行（storage_kind='external'）
      ├─ notes_fts      → 搜索 / RAG / MCP
      ├─ note_tags      → 标签
      └─ note_links     → 双链
```

影子行同时承担两个角色：

1. **索引载体**：正文参与 FTS、向量检索、标签、反链；
2. **文档本体**：在文档列表中出现，点击后进入 `/notes/:id` 编辑器。

对 `.md` / `.txt` 这没有问题——影子正文就是原文件内容。但 PDF / Word / Excel 的
影子正文是抽取结果（纯文本或 GFM 表格），把它当作文档本体打开，会出现：

- 编辑器里看到的是丢失格式的抽取文本；
- 保存只写数据库，不会回写原文件；
- 文档列表混入一堆“不可编辑的假笔记”。

Office 工作台（`/office`）已经具备直接打开原文件的能力，因此可以把两个角色拆开。

---

## 2. 目标

1. **同步只建索引**：扫描仍抽取文本，用于搜索 / RAG / 标签，但不再把二进制文档的影子行当作笔记展示。
2. **打开即原文件**：文件树点击 PDF / DOCX / PPTX / XLSX，直接进入 Office 工作台打开磁盘原文件。
3. **编辑即原文件**：在可写挂载中编辑并保存，写回原文件；只读挂载禁止保存。
4. **不重建索引体系**：继续复用 `notes` / `notes_fts`，不引入第二套表。

## 3. 非目标

- 不拆分独立的 `external_index` 表（FTS 触发器、标签、链接、RAG 都会被迫重做，收益不匹配成本）。
- 不改变文本文件（`.md` / `.txt`）的行为，仍走影子笔记编辑 / 写回。
- 不实现 PDF 富文本抽取或 OCR。
- 不在本轮改变 `sync_v1`（WebDAV/S3）——外部笔记仍不参与云同步。

---

## 4. 方案

### 4.1 数据层：索引-only 标记

新增 `notes.ext_index_only INTEGER NOT NULL DEFAULT 0`：

| 值 | 含义 |
|---|---|
| 0 | 正常笔记 / 文本类外部文件 |
| 1 | 二进制外部文档，仅用于索引，不在文档列表展示 |

扫描时按文件类别写入：

- `pdf` / `docx` / `doc` / `xlsx` / `xls` / `xlsm` / `xlsb` / `ods` / `csv` / `tsv` → `1`
- `md` / `markdown` / `txt` / `text` → `0`

迁移 v86 回填已有外部笔记，按 `ext_rel_path` 的扩展名判定。

### 4.2 查询层：列表与统计排除

以下查询增加 `ext_index_only = 0`：

- `Database::list_notes`：主文档列表、文件夹筛选、未分类
- `Database::list_folders_tree` 的 `note_count`
- `get_folder_meta` 的活跃笔记计数
- `get_dashboard_stats` / `get_writing_trend`

**不排除**：

- `notes_fts` 搜索
- `list_notes_for_embedding`（RAG）
- AI 检索 / MCP
- `list_external_entries`（挂载文件树必须显示全部）

### 4.3 接口层：返回原文件绝对路径

`ExternalEntry` 增加 `abs_path`。`list_external_entries` 关联
`external_mounts.root_path`，把 POSIX 风格的 `ext_rel_path` 拼成平台绝对路径。

### 4.4 前端：文件树跳转

`/mounts` 文件树点击文件时：

```
typeCategory == 'text' 或无法被 Office 打开
    → mountApi.openFile(noteId) → /notes/:id        （保持现状）

typeCategory 为 pdf/word/sheet 且 absPath 存在且扩展名受 Office 支持
    → /office?path=<encodeURIComponent(absPath)>&readonly=<0|1>
```

受 Office 工作台支持的扩展名：`pptx` / `pptm` / `docx` / `docm` / `xlsx` / `xlsm` / `pdf`。
其余（`doc` / `xls` / `xlsb` / `ods` / `csv` / `tsv`）回退到影子笔记。

### 4.5 Office 工作台：外部打开与只读

- 页面读取 `useSearchParams()` 的 `path` / `readonly`，首次挂载自动打开。
- `OfficeSessionMeta` 增加 `readOnly`；只读会话：
  - 顶栏显示“只读挂载”标签；
  - 保存 / 另存为按钮禁用；
  - `Ctrl+S` 触发时提示“该文件位于只读挂载点”。
- 可写会话保存后直接原子写回原文件；后台扫描会在下一轮检测到 mtime 变化并刷新索引。

---

## 5. 改动清单

### 后端

| 文件 | 改动 |
|---|---|
| `src-tauri/src/database/schema.rs` | `SCHEMA_VERSION = 86`；新增 `migrate_v85_to_v86` |
| `src-tauri/src/database/mounts.rs` | `upsert_external_note` 增加 `index_only` 参数；`list_external_entries` 返回 `abs_path` |
| `src-tauri/src/models/mod.rs` | `ExternalEntry.abs_path` |
| `src-tauri/src/services/mount.rs` | 扫描与重新抽取按 `MountFileKind::is_binary()` 写标记 |
| `src-tauri/src/database/notes.rs` | `list_notes` 过滤 `ext_index_only` |
| `src-tauri/src/database/folders.rs` | 文件夹计数过滤 |
| `src-tauri/src/database/mod.rs` | 仪表盘 / 写作趋势统计过滤 |

### 前端

| 文件 | 改动 |
|---|---|
| `src/types/index.ts` | `ExternalEntry.absPath` |
| `src/components/mounts/mountTree.tsx` | 节点携带完整 `entry`，供点击判断 |
| `src/pages/mounts/index.tsx` | `openEntry(entry)` 分流到 `/office` |
| `src/pages/office/index.tsx` | 读取 query 自动打开；只读拦截保存 |
| `src/store/office.ts` | `OfficeSessionMeta.readOnly` |
| `src/components/office/OfficeTopBar.tsx` | 只读标签与按钮禁用 |

---

## 6. 风险与取舍

| 风险 | 处理 |
|---|---|
| 隐藏影子笔记后，用户无法在编辑器里查看抽取文本 | 挂载页文件树仍保留“抽取失败/暂停”状态；需要看文本时可在挂载页点开状态或后续加“查看索引文本”入口 |
| 只读挂载 + Office 保存 | 双保险：入口传 `readonly`，`saveSession` 再拦截 |
| 保存后索引短暂落后 | 后台轮询按 `scan_interval` 自动重抽；不阻塞保存 |
| 迁移回填误判 | 仅匹配 `storage_kind='external'` 且扩展名在二进制白名单内的行，文本类不受影响 |
| 搜索命中但列表看不到 | 预期行为：索引-only 文档只服务搜索 / RAG；搜索结果点击仍进 `/notes/:id` 查看抽取文本 |

---

## 7. 验证

```bash
cd src-tauri && cargo check
cd src-tauri && cargo test --lib database::mounts::tests
cd src-tauri && cargo test --lib database::schema
npx tsc --noEmit
```

手工验证：

1. 挂载含 PDF / DOCX / PPTX / XLSX 的目录并扫描；
2. 文档列表和文件夹计数不再出现这些二进制影子笔记；
3. 挂载文件树点击 PDF → 进入 `/office` 并渲染原文件；
4. 只读挂载点击 DOCX → 顶栏显示只读，保存按钮不可用；
5. 可写挂载编辑 PPTX 并保存 → 原文件 mtime 变化，下一轮扫描刷新索引；
6. 搜索仍能命中二进制文档正文。

---

## 8. 后续

- 挂载文件树增加“查看索引文本”操作，替代隐藏后的正文查看入口。
- 二进制文档的搜索结果跳转改为 Office 工作台（当前仍进影子笔记）。
- `doc` / `xls` / `xlsb` / `ods` 的 Office 打开支持（需要引擎扩展）。
- 保存后主动触发单文件索引刷新，减少轮询延迟。
