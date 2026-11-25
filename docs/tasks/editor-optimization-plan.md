# 编辑器优化方案（对齐 knowledge-base v3.x）

> 创建：2026-11-23
> 参照：knowledge-base v2.1.0 → v3.5.1 编辑器相关提交与组件
> 本仓基线：`src/components/editor/`（17,471 行）、`src/pages/notes/editor.tsx`（2,484 行）、Tiptap 3.20.4
> 关联：`docs/tasks/ui-v4-redesign-plan.md`（T3-A 编辑器批次）、`docs/tasks/v3.5.0-upgrade-plan.md`

## 1. 目标与原则

**目标**：先修「会写坏数据/明显错误」的编辑问题，再按 UI v4 完成顶栏、工具栏、状态栏，最后补高频交互。

**原则**

1. 不删功能：本仓插件工具栏、对比/合并、3D、白板块、分栏、视频时间戳、AI 写作全部保留。
2. 数据优先：任何序列化改动必须可逆、可测试，不能悄悄改用户正文。
3. 显式操作：会批量改写正文的功能（统一换行）只能由用户显式触发。
4. 不阻塞输入：统计 / 状态条刷新做 300ms 合并，不在每次按键同步重算。
5. 与 UI v4 解耦：正确性修复先独立发布，布局类随 UI v4 批次走。

## 2. 差距摘要

| 优先级 | 项 | 本仓 | KB |
|--------|----|------|----|
| P0 | YAML front-matter | 无节点，外部 .md 首部可能被改坏 | `FrontMatter.ts` + `FrontMatterNodeView.tsx` + `lib/frontMatter.ts` |
| P0 | 标题内换行 | 默认输出 `\`+换行，重开错乱 | 标题内 hardBreak 输出 `<br>` |
| P0 | 切换笔记字数 | 听 `update`，setContent 不刷新 | 听 `transaction`，300ms 合并 |
| P0 | 双链候选框 | 仅判断 `endsWith("]]")` | 扫描 `[[` 到光标之间是否已有 `]]` |
| P1 | 底部状态栏 | `EditorStats` 在顶部元数据行，底部无链接状态条 | `LinkStatusBar variant="statusbar"` + 模式/时间/字数/字符/阅读时长 |
| P1 | 顶栏保存状态 | 仅 toast | 常驻「已保存 / 未保存 / 正在保存 / 保存失败」胶囊；窄窗口收「⋯」 |
| P1 | 工具栏分组 | 平铺 `ToolItem[][]` | `openPanel`：排版/对齐/插入/对比，一次只开一个 |
| P2 | 选区复制/剪切 | 无 | 原生 copy/cut，可撤销；阅读模式隐藏剪切 |
| P2 | 选区浮条宽度 | 未设 860 | `maxWidth: min(860px, 100vw-24px)` |
| P2 | 邮件/电话链接 | 单击即打开 | Ctrl/⌘+单击才打开 |
| P2 | 段间距 | 只有行距 | 段间距 0–2em，默认 1.05 |
| P2 | 表格垂直居中 | 无 | `data-editor-table-vcenter` + 设置开关 |
| P2 | 统一换行 | 无 | `lineBreakCleanup` + 工具栏入口 |
| P3 | 选中转闪卡 | 无 | `MakeCardDialog` + 选区浮条入口 |

## 3. 批次划分

| 批次 | 内容 | 发布建议 |
|------|------|---------|
| E0 | 数据正确性与明显 Bug | 独立补丁版本 |
| E1 | v4 顶栏 / 工具栏 / 状态栏 | 随 UI v4 T3-A |
| E2 | 高频交互与排版设置 | 独立小版本 |
| E3 | 选中转闪卡 | 视卡片模块排期 |
| E4 | 移动端编辑器对齐 | 单独立项 |

---

## 4. E0：数据正确性

### E0-1 YAML front-matter 属性卡片

**新增文件**

- `src/lib/frontMatter.ts`：解析 / 构造 / 校验
  - `matchFrontMatter(input)`：只匹配文档开头 `---\n…\n---`
  - `frontMatterEntries(raw)`：拆成键值行
  - `frontMatterInner(raw)`：取内部 YAML 文本
  - `buildFrontMatter(draft)`：校验每个顶层行 `key: value`、禁止出现 `---` 行；不合法返回 null
- `src/components/editor/FrontMatter.ts`：Tiptap Node + markdown-it 解析规则 + 序列化规则
  - `DocumentWithFrontMatter`：`content: "(block+ | frontMatter block+)"`，`block+` 必须在前，避免空文档被塞空属性块
  - parse 规则带 `context: "doc/"`，只整篇解析命中；粘贴/insertContent 不命中，落回代码块，不丢内容
- `src/components/editor/FrontMatterNodeView.tsx`：属性卡片
  - 平时逐行键值；可编辑时点卡片切 YAML 文本框，失焦提交，Esc 放弃
  - 非法 YAML 不提交，保留草稿并提示
  - 拖选复制松开鼠标不触发切换（`window.getSelection()?.isCollapsed`）

**注册**

- `TiptapEditor.tsx`：`StarterKit` 关闭 `document`，注册 `DocumentWithFrontMatter`、`FrontMatter`
- 序列化时原样写回 `--- … ---`，不得转义或重排键值

**兼容与测试**

- 外部 .md 打开 → 不编辑 → 保存，字节级不变（除编辑器已知格式规整）
- 非法 YAML（缺冒号、含 `---` 行、空 key）拒绝提交
- 粘贴 YAML 片段不生成属性节点
- 前端单元测试：`frontMatter.test.ts`（解析、构造、非法样例）
- 回归：`sync_v1` 的 content_hash 不应因「只打开」变化

### E0-2 标题内换行

**文件**：`TextStyleExtras.ts`

- 标题 serialize 时临时 `state.inTable = true`，让 hardBreak 输出 `<br>`，再恢复
- 测试：`# 标题一<br>标题二` 往返一致；连续保存不累积 `\`

**兼容**：同一篇笔记保存后 Markdown 文本变化 → content_hash 变化 → 下次同步会推送新版本。属预期，需在发布说明中提示。

### E0-3 字数统计刷新

**文件**：`EditorStats.tsx`

- 监听 `transaction` + `create`，停止用 `update`
- 300ms 合并；source 模式继续按 `text` 变化重算
- 测试：切换 noteId / setContent 后统计更新

### E0-4 双链候选框误弹

**文件**：`WikiLinkSuggestion.ts`（可抽 `src/lib/wikiLinkSuggest.ts`）

- 规则：从光标向前找最近的 `[[`，若两者之间存在 `]]` → 已闭合，退出
- 单测：`[[A]]` 后光标不应弹；`[[A` 应弹；`[[A|B]]` 后不应弹

---

## 5. E1：v4 顶栏 / 工具栏 / 状态栏

### E1-1 底部状态栏

**文件**

- `LinkStatusBar.tsx`：增加 `variant?: "dock" | "statusbar"`、`leading?: ReactNode`、`trailing?: ReactNode`
- `EditorStats.tsx`：增加 `variant?: "popover" | "statusbar"`；statusbar 显示纯文本，悬停仍出明细
- `pages/notes/editor.tsx`：底部挂载

**内容**

- 左：模式（富文本/阅读/源码）· 创建日期 · 相对修改时间
- 右：字数 · 字符 · 约 N 分钟；出链/反链状态
- 源码模式用 `<EditorStats text={content} variant="statusbar" />`
- 大纲列宽 + 6px 让位，与正文宽度对齐

### E1-2 顶栏保存状态 + 响应式收纳

**文件**：`pages/notes/editor.tsx`

- 常驻胶囊：`已保存 / 未保存 / 正在保存 / 保存失败 · 重试`
- 悬停：上次自动保存时间 + 自动保存开关说明
- 窄窗口把隐藏/加密/删除收进「⋯」，与现有打印/更多菜单合并
- 保留现有 toast，但不再作为唯一反馈

### E1-3 工具栏分组

**文件**：`EditorToolbar.tsx`

- 现有 `groups: ToolItem[][]` 之上加 `ToolGroup` 元数据：
  - 高频：撤销/重做、标题、加粗/斜体/下划线、列表、任务、代码、引用
  - 面板「排版」：字号、行距、段间距、清除格式、统一换行
  - 面板「对齐」：左/中/右/两端、缩进
  - 面板「插入」：链接、图片、表格、附件、视频、时间戳、Emoji
  - 面板「对比」：对比剪贴板、对比笔记、合并（保留本仓独有按钮）
- `openPanel` 同一时间只开一个；点击外部关闭；键盘 Esc 关闭
- 插件按钮（`PluginToolbarButtons`）固定放在「更多」或末尾，不随分组隐藏

**外观**随 UI v4：浮动卡片、按钮 28×30、主题变量描边。

---

## 6. E2：高频交互与排版设置

### E2-1 选区复制/剪切 + 宽度 860

- `SelectionFormatButtons.tsx`：复制、剪切按钮
- 走浏览器原生 `document.execCommand("copy"/"cut")` 或 Clipboard API，保持 ProseMirror 格式；剪切可 Ctrl+Z 撤销
- 阅读模式隐藏剪切；复制后图标短暂变对勾
- 容器 `maxWidth: min(860px, calc(100vw - 24px))`，避免最右按钮被裁

### E2-2 邮件/电话链接

- `TiptapEditor.tsx` 点击处理：`mailto:` / `tel:` 仅 Ctrl/⌘+单击 `openUrl`；`http(s)` 保持单击
- 提示文案说明「Ctrl+单击打开邮件/电话」

### E2-3 段间距

- store：`editorParagraphSpacing`，默认 1.05，clamp `[0, 2]`，持久化
- CSS 变量 `--editor-paragraph-spacing`，只作用于 `.editor-content-area` 段落
- 设置页 `EditorTypographySection`：新增「段间距」滑杆/预设
- 与现有行距互不影响；已保存用户设置不强行改

### E2-4 表格内容垂直居中

- store：`editorTableVCenter`，默认 false
- 根节点属性 `data-editor-table-vcenter="1"`
- CSS：`td, th { vertical-align: middle }`
- 设置页新增开关

### E2-5 统一换行

- 新增 `src/components/editor/lineBreakCleanup.ts`
  - `mergeParagraphs(html)`：连续单换行段落合并
  - `splitHardBreaks(html)`：段内硬换行改分段
- 工具栏「排版」面板入口，一次只改当前文档，必须用户显式点击
- 测试：`lineBreakCleanup.test.ts`；不挂在自动保存、不进入粘贴默认流程

---

## 7. E3：选中转闪卡

- 新增 `MakeCardDialog.tsx`：选中文字 → 卡片面/背面预填
- 选区浮条在卡片模块启用时显示「转为闪卡」
- 复用 `cardsApi.create`；失败不破坏选区

---

## 8. 本仓特有功能保留清单

移植/换皮时不得丢失或藏进不可达位置：

- `PluginEditorAdapter` / `PluginToolbarButtons`
- `CompareClipboardButton` / `CompareMergeDropdown` / `CompareNotesButton` / `DiffMergeModal`
- `Viewer3DNode`、`WhiteboardBlock`、`Columns`、`VideoTimestamp`
- `AiWriteMenu`、`useFormatPainter`
- `alignSnapshotPlugins`、`EditorOutline`、`MarkdownSourceEditor`

## 9. 数据与同步兼容

| 改动 | 影响 | 处理 |
|------|------|------|
| front-matter 节点 | 打开外部 .md 不再改坏首部 | 字节级往返测试 |
| 标题 `<br>` | 保存后 Markdown 变化 → content_hash 变化 | 发布说明；同步会推送新版本 |
| 统一换行 | 批量改写正文 | 仅显式操作；执行前提示 |
| 段间距/表格居中 | 纯显示，不改 Markdown | 无同步影响 |
| 状态栏/顶栏/工具栏 | 纯 UI | 无数据影响 |

## 10. 测试与验收

**自动化**

```bash
pnpm test          # vitest run
npx tsc --noEmit
pnpm build
```

- 新增单测：`frontMatter.test.ts`、`lineBreakCleanup.test.ts`、`wikiLinkSuggest.test.ts`
- 组件测试：`EditorStats` 切换内容刷新；`FrontMatterNodeView` 非法输入不提交
- 如触及 Rust 序列化（本方案默认不改），再跑 `cargo test --lib`

**手工回归**

- 外部 .md：含 front-matter / 标题内换行 / 多个硬换行 → 打开、编辑、保存、重开一致
- 同步：保存后 push，另一设备 pull 内容一致；无意外冲突
- 对比/合并：`CompareNotes` / `DiffMerge` 对含 front-matter 与 `<br>` 标题的文档仍正确
- 源码模式：切换后字数、状态栏一致
- 阅读模式/只读：无复制/剪切/编辑入口
- 9 主题（UI v4 后）：状态栏、工具栏、选区浮条可读

## 11. 实施顺序与回滚

1. **E0**：front-matter → 标题 `<br>` → 字数刷新 → 双链守卫。每项独立提交。
2. **E1**：状态栏 → 顶栏保存胶囊/收纳 → 工具栏分组（随 UI v4 T3-A）。
3. **E2**：复制/剪切 → Ctrl+单击 → 段间距 → 表格居中 → 统一换行。
4. **E3**：选中转闪卡。

**回滚点**

- 段间距、表格居中通过设置键关闭即可回退显示效果。
- front-matter 节点为纯增量；异常时可临时关闭解析规则（代码开关），但需保留写回原文。
- 标题 `<br>` 与统一换行会改变 Markdown，回滚代码不会自动还原已保存内容；发布前必须充分回归。

## 12. 风险

| 风险 | 应对 |
|------|------|
| front-matter 解析边界 | 只匹配文档开头；粘贴路径不命中；非法不提交；单测覆盖 |
| 标题 `<br>` 破坏旧文档 | 往返测试；发布说明；必要时提供「标题换行兼容」开关（默认新格式） |
| 统一换行误伤代码块/表格 | 只处理普通段落；跳过 codeBlock / table / 列表嵌套；测试先行 |
| 工具栏分组遮挡本仓独有按钮 | 「更多」固定入口 + 全部按钮可达性测试 |
| 状态栏与大纲/导图布局冲突 | 复用现有 `outlineSpace` 计算；三栏模式实测 |
| 统计刷新性能 | 300ms 合并；只在 transaction 后计算 |

## 13. 与其它计划的关系

- E1 的具体外观数值以 `docs/tasks/ui-v4-redesign-plan.md` 的 T3-A 为准，本方案只定义结构与交互。
- E0/E2 不依赖 UI v4，可先行落地。
- 编辑器改造会触碰 `pages/notes/editor.tsx`、`EditorToolbar.tsx`、`store/index.ts` 等热文件；实施前确认工作区无其它会话未提交改动，必要时使用 worktree。

---

## 14. 实施记录（2026-11-23）

**已完成**

- **E0-1** `src/lib/frontMatter.ts`（+ 单测）、`src/components/editor/FrontMatter.ts`、`FrontMatterNodeView.tsx`；
  `TiptapEditor` 关闭 StarterKit `document` 并注册 `DocumentWithFrontMatter` / `FrontMatter`；
  global.css 补属性卡片样式。doc 语法放宽为 `(block+ | frontMatter block*)`，仅含元数据的 .md 也能打开。
- **E0-2** `TextStyleExtras.ts` 标题序列化时借 `state.inTable` 让 hardBreak 输出 `<br>`。
- **E0-3** `EditorStats.tsx` 改监听 `transaction` + `create`（300ms 合并），切换 / setContent 后刷新。
- **E0-4** `src/lib/wikiLinkSuggest.ts`（+ 单测），`WikiLinkSuggestion` 改用该守卫。
- **E1-1** `LinkStatusBar` 新增 `variant="statusbar"` + `leading/trailing`；`EditorStats` 新增 `variant="statusbar"`；
  编辑页底部常驻状态栏（模式 · 创建 · 修改 | 链出/链入/断链 | 字数 · 字符 · 阅读时长）。
  顶部 MetaBar 不再重复显示字数。
- **E1-2** 顶栏常驻保存状态胶囊（保存中 / 保存失败·点击重试 / 未保存 / 已保存）。
- **E1-3** `EditorToolbar` 增加「排版」收纳面板（字号 / 行间距 / 清除格式 / 统一换行），
  一次只开一个，其余条目按高频分组，插件按钮固定在末尾。
- **E2-1** 选区浮条新增复制 / 剪切（原生 copy/cut，可撤销，阅读模式隐藏剪切），宽度上限 860。
- **E2-2** 邮件 / 电话链接改为 Ctrl/⌘+单击打开，单击仅提示；链接悬停显示提示。
- **E2-3** store `editorParagraphSpacing`（默认 1.05，clamp 0–2）+ `--editor-paragraph-spacing`；
  设置页新增段间距滑杆。
- **E2-4** store `editorTableVCenter` + `data-editor-table-vcenter`；设置页新增开关。
- **E2-5** `lineBreakCleanup.ts`（+ 单测，含 `mergeParagraphs` / `splitHardBreaks`），
  工具栏「排版」面板入口，执行前弹确认。

**未做 / 后续**

- E1-2 的窄窗口「⋯」收纳依赖 v4 顶栏响应式结构，随 UI v4 T3-A 一起做。
- E3 选中转闪卡：本仓暂无卡片模块（无 `cardsApi`），按方案挂起。

**验证**

- `pnpm test`：65 个测试文件 / 654 个用例全部通过（含新增 frontMatter、wikiLinkSuggest、lineBreakCleanup）。
- `npx tsc --noEmit`、`pnpm build` 通过。
- 手工回归建议：外部 .md（含 front-matter / 标题内 `<br>`）打开→保存→重开；9 主题下状态栏与工具栏可读性。
