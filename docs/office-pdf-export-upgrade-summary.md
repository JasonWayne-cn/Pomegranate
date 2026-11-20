# Office / PDF / 导出能力升级总结

> 日期：2026-11-20
> 范围：笔记导出（Markdown / Word / HTML）、Office 工作台 PDF 阅读、外部挂载文档在文档树的展示
> 说明：本文件只记录本次升级的实现与验证，不含并行开发中的提示词分组等功能。

---

## 1. 笔记导出：格式保真升级

### 1.1 编辑器实时 DOM 优先

- `src/pages/notes/editor.tsx`
  - Word / HTML 导出改为先调用 `editorDomToSelfContainedHtml()`，把编辑器真实 DOM（含标题自动编号、callout、分栏、mermaid、KaTeX）传给后端。
  - 生成失败或编辑器未就绪时自动回退 Markdown 重渲。
  - 导出期间显示 loading；Word 成功弹窗展示实际引擎（本机转换器 / 内置生成器）。

### 1.2 Word 原生回退路径

- `src-tauri/src/services/export_word.rs`
  - `export_single_best_effort` 在无转换器时也优先使用前端 `body_html`，不再丢弃实时 DOM。
  - 新增 `export_single_from_html`：HTML → Markdown → 现有递归解析器，保留标题编号、表格、图片（含 data: URL）。
  - 用户字体生效：从 CSS `font-family` 栈提取真实字体名，正文/标题分别写入 rFonts。
  - 引用灰色斜体、代码块浅灰底纹、表头加粗 + 底纹。
  - 公式：`ENABLE_MATH`，行内/块级 TeX 文本保留并使用 Cambria Math。
  - 货币安全：`math_is_safe()` 防止 `价格$100元，原价$200元` 被误解析成公式、吞掉 `$`。
  - 转换器路径补齐附件内嵌（`kb-asset://` 等本地附件 → data: URL）。
  - 结果新增 `engine`、`attachmentsInlined` 字段。

### 1.3 HTML 导出

- `src-tauri/src/services/export_html.rs`
  - 启用数学事件，增加 `.math-inline` / `.math-display` 样式。
  - 编辑器 DOM 含 KaTeX 节点时，Web 版式内嵌 KaTeX CSS（仅此时注入，避免每份文件多 23KB）。
  - Word 转换器（Document 版式）不注入完整 KaTeX CSS，但始终隐藏 `.katex-mathml`，防止公式内容重复。

### 1.4 新增资源

- `src-tauri/resources/katex.min.css`（KaTeX 0.16.x，MIT，约 24KB）。

---

## 2. Office 工作台：PDF 阅读

### 2.1 路径与打开失败修复

- `src-tauri/src/database/mounts.rs`
  - 新增 `native_rel_path()`：DB 相对路径统一用 `/`，拼磁盘路径前转成平台分隔符。
  - 修复 Windows `\\?\D:\...` 扩展路径混用正斜杠导致 `os error 123`、PDF 无法打开的问题。
- `src/pages/office/index.tsx`
  - `normalizeFsPath()`：历史/旧会话中的混合分隔符统一纠正。
  - 打开已有 PDF 会话时：
    - 仅在 `status === "ready"` 且页列表为空时原地重载，避免打断 loading 中的首次打开；
    - runtime 丢失时才重建会话；
    - 每次显式打开重置自动恢复标记。
  - 自动恢复 effect 不再要求 `pageCount > 0`；空白 PDF 会自动重拉页面。
  - 「重新打开 PDF」按钮优先原地重载，不销毁会话。

### 2.2 全页预览（取消 3 页上限）

- `src-tauri/src/services/office_preview.rs`
  - 新增 `pdf_page_count(path)`、`pdf_render_pages(path, start, count)`。
  - 单次最多渲染 24 页，避免 IPC/base64 载荷过大。
  - 旧 `pdf_preview` 保留兼容，上限仅影响旧接口。
- `src-tauri/src/commands/pptx_spike.rs` + `lib.rs`
  - 注册 `office_pdf_page_count`、`office_pdf_render_pages`。
- 前端：
  - 首次加载 4 页，显示已加载/总页数；
  - 「加载更多」「加载全部」；
  - 按页范围按需加载，翻页时自动补齐未渲染页。

### 2.3 阅读模式与交互（参照 WPS）

- 默认视图改为 **连续**，另提供 **单页** / **多页**。
- 单页模式：
  - 上一页 / 下一页按钮；
  - 滚轮到达底部自动加载并进入下一页，顶部向上滚返回上一页；
  - 页码与总页数显示。
- 连续模式：
  - 页面纵向排列，窄间距；
  - 接近底部自动加载下一批页面，实现无分页间断的连续阅读；
  - 底部显示加载提示。
- 多页模式：2 列网格，同样支持滚动自动加载。
- 缩放：
  - 底部状态栏新增 50%–300% 滑杆，保留 `−` / `+` / 百分比；
  - 使用滚动容器实测宽度作为 100% 基准，页面宽度改为像素值；
  - 修复 flex 子项被压缩导致放大到 100% 后不再变大的问题；
  - >100% 时页面实际变宽并出现横向滚动。

---

## 3. 文档树展示外部 PDF / Word / Excel

- `src-tauri/src/models/mod.rs`
  - `NoteQuery` 新增 `include_external_docs`。
- `src-tauri/src/database/notes.rs`
  - `list_notes` / `list_note_ids_for_reorder` 仅在未显式要求时过滤 `ext_index_only = 0`。
- `src-tauri/src/services/note.rs`
  - 透传 `include_external_docs`。
- `src/components/layout/panels/NotesPanel.tsx`
  - 文档树加载笔记时传 `include_external_docs: true`，PDF/Word/Excel 影子文档出现在树中。
- `src/pages/notes/index.tsx`
  - 文档列表同步包含外部二进制文档。
- `src/lib/office/formats.ts`
  - 新增 `officePathForSource()`：PDF/DOCX/PPTX/XLSX 统一跳转 Office 工作台（只读），并带时间戳确保重复点击可重新打开。
  - `.doc/.xls/.csv` 等 Office 工作台不支持的类型仍进入文本编辑器。

---

## 4. 数据清理（非代码）

- 删除 `research` 下与 PDF 同名的 TXT 提取文件共 33 个（移入 Windows 回收站）。
- 应用回收站中的 37 条 TXT 影子文档已永久清理：
  - 33 条本次清理产生的软删除记录；
  - 4 条 `参考文献` 下的重复 TXT 影子文档。
- 删除两个空的 `research/**/txt` 目录及其空的镜像文件夹。
- 操作前均做了 SQLite 一致性备份（`dev-app.db.bak-*`）。

---

## 5. 验证

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npx vitest run` | ✅ 62 文件 / 624 用例 |
| `npx vitest run src/lib/office` | ✅ 10 文件 / 49 用例 |
| `cargo test database::mounts::tests` | ✅ 7 passed |
| `cargo test services::export_word / export_html` | ✅ |
| PDF 扩展路径真实文件渲染测试（`KB_PDF_TEST_FILE`） | ✅ 4 页实际出图 |

---

## 6. 已知限制

- PDF 仍为只读；当前为逐页 PNG 渲染，暂不支持文本选择/搜索/编辑。
- 扫描件 PDF 依赖 OCR 开关；交叉引用损坏的 PDF 仍需先用 Chrome/Edge 另存修复。
- `.doc/.xls/.csv` 暂未进入 Office 工作台。
