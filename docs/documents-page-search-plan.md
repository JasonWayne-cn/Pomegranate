# 文档页搜索增强设计方案（标题 / 正文 / 递归）

> 状态：已实现（Phase 1 标题/正文/递归 + Phase 2 中文加权匹配，详见文末「实现状态」）
> 目标页面：「文档」列表页 `src/pages/notes/index.tsx`
> 关联：外部挂载索引见 `docs/external-docs-office-integration.md`

## 1. 背景与现状

用户期望：在「文档」页选中某个文件夹时，只在该文件夹范围内检索；**默认按标题检索**，并可**选择是否检索正文**、**是否递归子文件夹**。

现状（已核对代码）：

| 项 | 现状 | 位置 |
|---|---|---|
| 搜索框文案 | `搜索文档标题...` | `src/pages/notes/index.tsx:1363` |
| 前端调用 | `noteApi.list({ keyword, folder_id, include_descendants, include_external_docs: true, ... })` | `src/pages/notes/index.tsx:689-716` |
| 命令 | `list_notes(state, query: NoteQuery)` | `src-tauri/src/commands/notes.rs:137` |
| 服务 | `NoteService::list` | `src-tauri/src/services/note.rs:206` |
| DAO | `Database::list_notes` | `src-tauri/src/database/notes.rs:563` |
| 关键字条件 | **仅** `title LIKE '%kw%'` | `src-tauri/src/database/notes.rs:633-637` |
| 目录范围 | 选中目录时前端传 `include_descendants=false`（只列直属） | `src/pages/notes/index.tsx:710-711` |
| 外部文档 | `include_external_docs=true`，`ext_index_only=1` 行参与展示 | `src-tauri/src/database/notes.rs:606-608` |

关键事实：

- **文档页搜索是"标题过滤"，不是全文检索**。所以搜正文词（如 `基于3DCS`）在文档页返回空，而全局搜索页 `/search`（FTS + 中文 n-gram）能命中。
- 外部挂载的 PDF/Word/Excel 影子行（`ext_index_only=1`）已把抽取文本写入 `notes.content`，并由 `notes_fts` 触发器自动建全文索引；因此**正文检索有数据基础**，只差文档页查询接上。
- 目标样例（dev 库）：`09-3dcs-vr-perceived-quality-2025.pdf` 影子行 `id=204`，`content` 含连续串「基于3DCS」，FTS `基于3DCS*` 可命中。

结论：问题不在索引，而在文档页 `list_notes` 的 keyword 只匹配标题。

## 2. 目标与非目标

目标：

1. 搜索范围 = 当前选中目录；默认标题检索。
2. 可选「正文检索」（标题 + 正文）。
3. 可选「含子文件夹」（递归）。
4. 保留现有分页、排序、外部文档展示、拖拽排序等能力。

非目标：

- 不改变全局搜索页 `/search` 的行为。
- 不在本次引入新分词器/新索引结构。

## 3. 范围语义矩阵

| 当前目录 | 含子文件夹 | 关键字为空 | 检索范围 |
|---|---|---|---|
| 选中某目录 | 否（默认） | 否 | 该目录**直属**文档 |
| 选中某目录 | 是 | 否 | 该目录及其**全部子孙**目录 |
| 全部 | 忽略 | 否 | 全库可见文档 |
| 未分类 | 忽略 | 否 | `folder_id IS NULL` 的文档 |

- 开关**仅在关键字非空时生效**；关键字为空时按普通列表逻辑展示。
- 「含子文件夹」仅在选中目录时可用；未选目录时隐藏或禁用。

## 4. 交互设计

在搜索框下方新增一行紧凑筛选（与搜索栏同宽、`flex-shrink-0`）：

- `正文检索`：Checkbox/Switch，默认关。
- `含子文件夹`：Checkbox/Switch，仅在选中目录时显示；默认关（与现状"只显示直属"一致）。

行为：

- Placeholder 随状态变化：关=`搜索文档标题...`；开=`搜索标题或正文...`。
- 触发方式保持现有「点击搜索/回车」触发（非逐字），避免正文全表扫描的高频开销。
- 空结果引导：标题模式下 0 结果时，提示「仅搜索标题，试试开启“正文检索”」，可一键开启并重搜。
- 偏好持久化：`localStorage`（`notes.searchContent` / `notes.searchRecursive`）或现有设置 store；页面初始化读取。
  - 注意：`含子文件夹` 的持久值只在选中目录时应用。
- （可选，后续）正文命中但标题不含关键字时，在标题旁显示「正文命中」标签；需要后端返回命中标记，一期先不做。

## 5. 参数与接口设计

### 5.1 Rust

`src-tauri/src/models/mod.rs` 的 `NoteQuery` 增加：

```rust
/// true 时 keyword 同时匹配正文；false/None 只匹配标题（默认）。
#[serde(default)]
pub search_content: Option<bool>,
```

复用已有的 `include_descendants: Option<bool>` 作为「含子文件夹」开关。

### 5.2 TypeScript

`src/types/index.ts` 的 `NoteQuery` 增加：

```ts
/** true 时 keyword 同时匹配正文；默认只匹配标题 */
search_content?: boolean;
```

`noteApi.list` 无需改封装，直接透传 query 对象（`src/lib/api/index.ts:390`）。

### 5.3 调用链

```
notes/index.tsx loadNotes()
  → noteApi.list({ keyword, folder_id, include_descendants, search_content, include_external_docs: true })
    → commands::notes::list_notes(query)
      → NoteService::list
        → Database::list_notes
```

## 6. 后端实现

### 6.1 Phase 1（最小可用，建议先落）

把 `Database::list_notes`（`database/notes.rs:633-637`）与 `list_note_ids_for_reorder`（`database/notes.rs:1121-1125`）的 keyword 条件按开关切换：

```rust
if let Some(kw) = keyword {
    if !kw.is_empty() {
        let like = format!("%{}%", kw);
        if search_content {
            let i = param_values.len() + 1;
            conditions.push(format!(
                "(title LIKE ?{i} OR COALESCE(search_text, content) LIKE ?{i})"
            ));
            param_values.push(Box::new(like));
        } else {
            let i = param_values.len() + 1;
            conditions.push(format!("title LIKE ?{i}"));
            param_values.push(Box::new(like));
        }
    }
}
```

`NoteService::list` / `list_ids_for_reorder` 透传 `query.search_content.unwrap_or(false)`。

要点：

- **count 查询与 data 查询共用同一 `conditions`**，`total` 与分页天然一致。
- 外部文档天然覆盖：`include_external_docs=true` 时 `ext_index_only` 行参与，正文即抽取文本。
- 优点：改动小、可立即解决「基于3DCS」这类连续串；缺点：正文 `LIKE '%..%'` 是全表扫描、量大时慢；中文非连续词（无空格分词）仍可能 miss。
- **必须同步改 `list_note_ids_for_reorder`**，否则拖拽排序取到的 id 集合与列表不一致。

### 6.2 Phase 2（性能与中文召回）

正文匹配改走 FTS，标题仍用 `LIKE`：

```sql
AND (
  title LIKE ?a
  OR id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?b)
)
```

- 复用 `database/search.rs` 的 `sanitize_fts_query` 与 `database/cjk.rs` 的 n-gram 展开，抽公共 helper（如 `build_body_match`），避免与全局搜索两套逻辑漂移。
- FTS 命中为空时回落 `LIKE`（与 `search_notes_filtered` 一致的兜底策略）。
- 可选：正文检索时按 `bm25` 相关度排序（置顶 `is_pinned` 仍优先）。
- 注意 unicode61 对连续汉字的限制：`基于3DCS*` 可用；非连续中文靠 `cjk::expand_query` 的加权 n-gram 兜底。

### 6.3 改动文件清单

Phase 1：

- `src-tauri/src/models/mod.rs` — `NoteQuery.search_content`
- `src-tauri/src/services/note.rs` — `list` / `list_ids_for_reorder` 透传
- `src-tauri/src/database/notes.rs` — `list_notes` + `list_note_ids_for_reorder` 条件
- `src/types/index.ts` — `NoteQuery.search_content`
- `src/pages/notes/index.tsx` — 搜索栏开关、状态、参数、持久化、空结果引导

Phase 2：

- `src-tauri/src/database/search.rs` — 抽 `build_body_match` 公共 helper
- `src-tauri/src/database/cjk.rs` — 复用 n-gram 展开
- `src-tauri/src/database/notes.rs` — 正文匹配改为 FTS（含 LIKE 兜底）

## 7. 性能与索引

- `notes_fts` 由触发器维护 `COALESCE(search_text, content)`（`schema.rs:238` 起），已就绪；外部文档抽取文本即被索引。
- Phase 1 的正文 `LIKE` 仅在用户开启「正文检索」并触发搜索时执行，风险可控；大规模库建议直接上 Phase 2。
- 文档页 `page_size` 默认 20、上限 100；count/data 共用条件，不会退化。

## 8. 边界与兼容

- 其他 `noteApi.list` 调用点（`CompareNotesButton`、`NoteComparePicker`、`NotesPanel`、`CreateTaskModal`、`ppt/index`、`home` 等）不传 `search_content` → 默认 `false`，行为不变。
- 全局搜索 `/search`、MCP、AI RAG 走各自查询路径，不受影响。
- 「未分类」（`folder_id IS NULL`）下「含子文件夹」无意义。
- 正文检索命中外部文档时，点击仍走 `ext_index_only + abs_path` → Office 打开原文件（注意 `notes/index.tsx` 的行点击逻辑需沿用全局搜索的 `openResult` 语义）。

## 9. 测试计划

Rust 单测（`database/notes.rs` 内）：

1. `search_content=false` 命中标题、不命中正文。
2. `search_content=true` 命中正文（构造内容含关键字、标题不含）。
3. 选中目录 + `include_descendants=false` 只返回直属；`true` 返回子孙。
4. `total` 与 `items` 条件一致（分页正确）。
5. 外部影子行（`ext_index_only=1`，`include_external_docs=true`）正文可命中。
6. `list_note_ids_for_reorder` 与 `list_notes` 返回集合一致。

手工验证（dev 实例）：

- 选中 `research/glass-deviation-twin`：标题搜 `09` → 命中该 PDF；开「正文检索」搜 `基于3DCS` → 命中 `09-3dcs-vr-perceived-quality-2025`。
- 在 `research` 目录：开「含子文件夹」后同样的正文检索可覆盖子目录文件。

回归：其他列表调用点、拖拽排序、全局搜索。

## 10. 落地建议

1. 先落 **Phase 1**（默认标题 + 可选正文 + 可选递归），解决"文档页搜正文为空"的核心诉求。
2. 视数据规模与中文召回反馈，再落 **Phase 2**（FTS + cjk n-gram），与全局搜索统一检索质量。

## 11. 实现状态（已完成）

已按以上方案实现，关键落地与偏差说明：

- **共享匹配器**：新增 `database/cjk.rs::build_match_sql(groups, start_index, title_expr, body_expr)`，产出「组间 AND、组内加权累加 >= 及格线」的 SQL；全局搜索 `search_like` 与文档列表 `list_notes` / `list_note_ids_for_reorder` 共用，消除两套逻辑漂移。
- **参数**：`NoteQuery.search_content: Option<bool>`（Rust/TS）。
- **列表条件**：
  - `search_content=false` → 仅 `title LIKE ?`（默认，行为不变）。
  - `search_content=true` → 复用 `cjk::expand_query` 的加权 n-gram 匹配 `title` 与 `COALESCE(search_text, content)`；纯符号查询返回空集（`1 = 0`）。
- **递归**：前端「含子文件夹」控制 `include_descendants`，默认关（只列直属）。
- **前端**：`src/pages/notes/index.tsx` 增加「正文检索 / 含子文件夹」开关，localStorage 持久化，切换后自动重搜；placeholder 随开关变化。
- **实现取舍（与 Phase 2 原描述的差异）**：正文匹配最终复用「全局搜索的中文加权 n-gram」而非在列表内直接 `notes_fts MATCH`。原因：unicode61 对连续汉字只有前缀匹配、`MATCH` 对异常输入可能报错；加权 n-gram 正是全局搜索为保证中文召回所依赖的那条路径，直接复用可保证文档页与全局搜索召回一致。缺点是正文匹配为 LIKE 扫描，仅在用户显式开启「正文检索」并触发搜索时执行，风险可控。后续如需极致性能，可在该条件前叠加 FTS 候选集做短路优化。

验证：

- `cargo check` 通过；`cargo test --lib database::` 151 项通过（含 search/cjk/title_only 回归）。
- 新增 `list_notes_content_search_matches_body_only`、`list_notes_content_search_punctuation_returns_empty` 通过。
- dev 库等价 SQL 验证：`基于3DCS` + 正文检索命中目标 `09-3dcs-vr-perceived-quality-2025`（id=204，`ext_index_only=1`，folder 21）。
- `tsc --noEmit` 通过。
