# 页面行为增强方案

> 创建：2026-11-24
> 参照：knowledge-base `66ebcae`（行距/每页 30）、`99849e4`（搜索三列）、`8aa8aac`（父标签）、`8029a99`（卡片键盘评分）、`476d8c3`（图谱节点卡片）、`f646795`/`e9ddd4c`（日记今日待办）、`d3761ea`（提醒结束循环确认）、`003e638`（拖入文件夹导入/导出全部）、`27a133e`（文件夹计数含子文件夹）、`122c831`/`2549582`（外部 md 打开/标题跟随）
> 关联：`remaining-improvements-plan.md` §2.E、`ui-v4-redesign-plan.md`（视觉换皮）

## 1. 说明

这些是**行为/交互增强**，不属于纯换皮。UI v4 换皮时一并落地可以减少重复改页面，但必须单独验收。

## 2. 清单与设计

### 2.1 笔记列表：行距三档 + 每页 30

- store：`notesRowSpacing: "compact" | "standard" | "comfortable"`，默认 `standard`；`notesPageSize` 默认 30（上限 100）。
- 面板/列表行使用同一 CSS 变量控制行高与上下留白。
- 设置页「界面」新增行距选择；分页默认值仅对未保存过偏好的用户生效。
- 文件：`src/store/index.ts`、`NotesPanel.tsx`、`pages/notes/index.tsx`、设置页。

### 2.2 搜索页空关键词三列

- 无关键词、无筛选时显示：
  - 标签（最近/全部）
  - 文件夹（树或平铺）
  - 文件（最近修改）
- 点击任一列项直接进入对应范围；选中项写入现有筛选条件。
- 文件：`src/pages/search/index.tsx`、搜索侧栏组件。

### 2.3 父标签

- `tags` 表已有 `parent_id` 能力（本仓 `database/tags.rs` 存在 `set_tag_parent` 但未暴露 UI）。
- 标签页：新建/编辑支持选择父标签；列表按层级展示；标签选择器显示路径。
- 约束：禁止环、同级重名、父标签删除时子标签上移。
- 文件：`database/tags.rs`、`components/settings/Tag*` 或标签页、`types`。

### 2.4 卡片复习：单页 + 数字键评分 + 右侧快速新建

- 去掉多 Tab，改单页布局；键盘 1–4 对应「重来/困难/良好/简单」。
- 右侧常驻快速新建卡片（正面/背面/所属笔记）。
- 文件：`src/pages/cards/index.tsx`、卡片 API、store。

### 2.5 图谱：节点卡片 + 定位

- 单击节点弹出卡片：标题、摘要、标签、所在文件夹、打开/定位按钮。
- 定位：居中并高亮，保持缩放合理范围。
- 文件：`src/pages/graph/index.tsx`、图谱组件。

### 2.6 日记：今日待办

- 日记右侧栏新增「今日待办」：显示当天到期/当天完成，可直接勾选与添加。
- 复用任务服务；失败不阻断日记编辑。
- 文件：`src/pages/daily/index.tsx`、`components/layout/panels/DailyPanel.tsx` 或右侧栏组件。

### 2.7 提醒「结束循环」二次确认

- 提醒弹窗中的「结束循环」移到左下角，点击后二次确认，避免误触终止重复任务。
- 文件：提醒弹窗组件（`components/` 下提醒相关）。

### 2.8 拖入文件夹按层级导入 + 导出全部笔记

- 拖入文件夹：扫描目录结构，按相对路径创建文件夹树并导入文件。
- 设置/笔记页新增「导出全部笔记」入口（目录或 ZIP）。
- 文件：`components/layout/panels/NotesPanel.tsx`、导入服务、导出命令。

### 2.9 文件夹计数含子文件夹

- 文件夹行尾显示「含子文件夹」的笔记数；「未分类」也显示数量。
- 复用现有统计查询，避免 N+1。
- 文件：`database/folders.rs`、侧栏。

### 2.10 外部 .md 打开与标题跟随

- 双击打开提速：先展示 shell，再异步加载；避免白屏等待。
- 修改一级标题后外部文件标题同步更新（写回时保留其余内容）。
- 文件：`services/source_file.rs`、`services/source_writeback.rs`、打开流程。

## 3. 分批与验收

| 批次 | 内容 | 验收 |
|------|------|------|
| B1 | 行距/每页 30、搜索三列、文件夹计数 | 设置重启保持；分页数据正确 |
| B2 | 父标签、卡片键盘评分、图谱节点卡片 | 标签层级正确；键盘不误触；图谱定位准确 |
| B3 | 日记今日待办、提醒二次确认 | 待办与任务页一致；误触不再终止循环 |
| B4 | 拖入文件夹、导出全部、外部 md | 目录层级正确；导出完整；标题跟随 |

**通用门禁**：`cargo test --lib`（涉及 DAO 时）、`pnpm test`、`tsc`、`build`。

## 4. 风险

| 风险 | 应对 |
|------|------|
| 父标签引入环 | 服务层校验 + 单测 |
| 键盘评分与输入框冲突 | 仅在复习焦点区监听；输入框内禁用 |
| 拖入大目录阻塞 UI | 扫描异步 + 进度事件；分批入库 |
| 外部 md 写回覆盖 | 只改标题行；保留 front-matter 与正文 |

## 5. 改动架构图（实施后）

> 2026-11-24：B1–B4 全部落地。图中 `★` 为本次新增/修改点。

### 5.1 总体分层架构

```mermaid
flowchart TD
  subgraph FE["前端 React (src/)"]
    STORE["store/index.ts<br/>★ notesRowSpacing / notesPageSize"]
    CSS["styles/global.css<br/>★ --notes-row-py 行距变量"]
    SET["pages/settings<br/>★ 笔记列表设置卡片"]

    SEARCH["pages/search<br/>★ 空关键词三列<br/>标签 / 文件夹 / 最近修改"]
    NOTES["pages/notes<br/>★ 每页30 · 导出全部 ZIP · 标签路径"]
    PANEL["NotesPanel.tsx<br/>★ 行尾计数 · 拖入文件夹导入<br/>★ 未分类总数"]
    SIDE["Sidebar.tsx<br/>★ 未分类计数"]

    TAGS["pages/tags + TagsPanel<br/>★ 父标签编辑 · 拖拽改父级（接通）"]
    CARDS["pages/cards<br/>★ 单页布局 · 1–4 键评分<br/>★ 右侧快速新建"]
    GRAPH["pages/graph<br/>★ 节点卡片 · 定位高亮"]
    DAILY["pages/daily<br/>★ 今日待办右栏"]
    REMIND["TaskReminderListener<br/>+ emergency-reminder<br/>★ 结束循环二次确认"]
    OPENING["pages/notes/opening<br/>★ shell-first 打开页"]
    ROUTER["Router.tsx<br/>★ /notes/opening 路由"]

    API["lib/api/index.ts<br/>★ set_tag_parent / reorder_tags<br/>★ export_notes_zip"]
  end

  subgraph IPC["Tauri IPC"]
    INV["invoke() / listen()"]
  end

  subgraph BE["后端 Rust (src-tauri/src/)"]
    C_TAGS["commands/tags.rs<br/>★ create_tag(parent_id)<br/>★ set_tag_parent / reorder_tags"]
    C_EXPORT["commands/export.rs<br/>★ export_notes_zip"]
    S_TAG["services/tag.rs<br/>★ set_parent / reorder"]
    S_WB["services/source_writeback.rs<br/>★ H1 标题跟随写回"]
    DB_F["database/folders.rs<br/>★ 子孙计数自底向上汇总"]
    DB_TAG["database/tags.rs<br/>（已有 set_tag_parent / 环校验）"]
    EXP_SVC["services/export.rs<br/>复用：按层级导出到临时目录"]
    REG["lib.rs<br/>★ 注册新命令"]
  end

  subgraph DATA["存储"]
    SQLITE[("SQLite<br/>notes / folders / tags / note_tags / tasks")]
    FILES[("外部 .md 文件<br/>front-matter + H1 + 正文")]
    ZIP[("导出 ZIP")]
  end

  STORE --> CSS
  SET --> STORE
  SEARCH --> API
  NOTES --> API
  PANEL --> API
  SIDE --> API
  TAGS --> API
  CARDS --> API
  GRAPH --> API
  DAILY --> API
  REMIND --> API
  OPENING --> API
  ROUTER --> OPENING

  API --> INV
  INV --> C_TAGS
  INV --> C_EXPORT
  INV --> REG

  C_TAGS --> S_TAG --> DB_TAG
  S_TAG --> SQLITE
  DB_F --> SQLITE
  C_EXPORT --> EXP_SVC
  EXP_SVC --> SQLITE
  EXP_SVC --> FILES
  EXP_SVC --> ZIP
  S_WB --> FILES
  SQLITE --> DB_F
```

### 5.2 外部 .md 打开与写回时序（B4）

```mermaid
sequenceDiagram
  autonumber
  participant U as 用户
  participant UI as OpenFileButton / AppLayout
  participant R as Router
  participant OP as OpeningNotePage
  participant CMD as open_markdown_file
  participant ED as NoteEditor
  participant WB as write_back_source_md
  participant FS as 外部 .md

  U->>UI: 双击 / 打开 md
  UI->>R: navigate(/notes/opening?path=…)
  R->>OP: 立即渲染 shell（Skeleton）
  OP->>CMD: 异步导入（去重 / 资源扫描）
  CMD-->>OP: noteId（+ wasSynced）
  OP->>R: replace → /notes/:id
  R->>ED: 渲染编辑器
  U->>ED: 修改一级标题并保存
  ED->>WB: writeBack(noteId)
  WB->>FS: 只替换首个 "# 标题" 行<br/>保留 front-matter 与正文
  WB-->>ED: 写回结果
```

### 5.3 关键数据流

```mermaid
flowchart LR
  A["父标签操作<br/>（新建 / 拖拽）"] --> B["tagApi<br/>create(parentId)<br/>setParent / reorder"]
  B --> C["commands/tags.rs"]
  C --> D["TagService 校验<br/>自引用 / 环 / 父级存在"]
  D --> E["database/tags.rs<br/>递归 CTE 环检查 + 末尾排序"]

  F["文件夹树读取"] --> G["list_folders_tree<br/>SQL 只算直属"]
  G --> H["build_folder_tree<br/>子节点计数上卷"]
  H --> I["Folder.note_count = 含子孙"]

  J["导出全部"] --> K["export_notes_zip"]
  K --> L["export_notes → 临时目录"]
  L --> M["walkdir + zip 打包"]
  M --> N["清理临时目录"]
```
