创建：2026-11-24\
参照：knowledge-base `63e2294`（自研可编辑一期）、`a039cb0`（拖动/右键/布局）、`a36d478`（导出 PNG）、`41b0364`（触屏模式）、`27114b6`（手机编辑）\
本仓：`src/components/notes/MindMapView.tsx` 仅 247 行只读视图，无 `components/mindmap/`\
关联：`remaining-improvements-plan.md` §2.F、`ui-v4-redesign-plan.md` T3-E

## 1\. 目标

把只读导图升级为可编辑导图：

拖动节点、右键菜单（新增子节点/同级/删除/折叠）。

- 布局切换（逻辑图/树形/向右）。
- 阅读模式与编辑模式切换。
- 导出整图 PNG / SVG。
- 触屏模式（移动端）。

**数据格式不变**：仍然存 Markdown 大纲，导图是视图；编辑后写回 Markdown，参与同步与搜索。

## 2\. 现状与差距

<table class="tiptap-table" style="min-width: 444px;"><colgroup><col style="width: 114px;"><col style="width: 305px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1" colwidth="114"><p style="line-height: 1;">项</p></th><th colspan="1" rowspan="1" colwidth="305"><p style="line-height: 1;">本仓</p></th><th colspan="1" rowspan="1"><p style="line-height: 1;">KB</p></th></tr><tr><td colspan="1" rowspan="1" colwidth="114"><p style="line-height: 1;">导图组件</p></td><td colspan="1" rowspan="1" colwidth="305"><p style="line-height: 1;"><code>MindMapView.tsx</code> 只读（markmap 风格）</p></td><td colspan="1" rowspan="1"><p style="line-height: 1;"><code>components/mindmap/MindMapEditor.tsx</code> 1339 行</p></td></tr><tr><td colspan="1" rowspan="1" colwidth="114"><p style="line-height: 1;">树解析/布局</p></td><td colspan="1" rowspan="1" colwidth="305"><p style="line-height: 1;">无独立模块</p></td><td colspan="1" rowspan="1"><p style="line-height: 1;"><code>tree.ts</code> 425 行、<code>layout.ts</code> 208 行（含测试）</p></td></tr><tr><td colspan="1" rowspan="1" colwidth="114"><p style="line-height: 1;">编辑能力</p></td><td colspan="1" rowspan="1" colwidth="305"><p style="line-height: 1;">无</p></td><td colspan="1" rowspan="1"><p style="line-height: 1;">拖动、右键、布局、折叠</p></td></tr><tr><td colspan="1" rowspan="1" colwidth="114"><p style="line-height: 1;">导出</p></td><td colspan="1" rowspan="1" colwidth="305"><p style="line-height: 1;">SVG（现有）</p></td><td colspan="1" rowspan="1"><p style="line-height: 1;">PNG + SVG</p></td></tr><tr><td colspan="1" rowspan="1" colwidth="114"><p style="line-height: 1;">触屏</p></td><td colspan="1" rowspan="1" colwidth="305"><p style="line-height: 1;">无</p></td><td colspan="1" rowspan="1"><p style="line-height: 1;">是</p></td></tr><tr><td colspan="1" rowspan="1" colwidth="114"><p style="line-height: 1;">移动端</p></td><td colspan="1" rowspan="1" colwidth="305"><p style="line-height: 1;">无</p></td><td colspan="1" rowspan="1"><p style="line-height: 1;"><code>MobileMindMap.tsx</code></p></td></tr></tbody></table>

## 3\. 设计

### 3.1 数据与解析

- Markdown 大纲 ↔ 树：`tree.ts`
  - `parseMindMap(markdown) -> MindTree`
  - `serializeMindMap(tree) -> markdown`
  - 保持缩进/列表符号稳定，避免每次保存漂移。
- 布局：`layout.ts`
  - 输入树 + 布局模式 → 节点坐标、连线路径。
  - 纯函数，单测覆盖层级、宽度、折叠。

### 3.2 编辑器

`MindMapEditor.tsx`

- React + SVG/Canvas 渲染；节点可选中、拖动、快捷键。
- 右键菜单：新增子节点、新增同级、重命名、删除、折叠/展开、复制。
- 布局切换：逻辑图 / 树形 / 向右；持久化到 `localStorage`（`kb.mindmap.layoutMode`）。
- 编辑提交：debounce 写回编辑器正文 → 走现有保存/同步。
- 全屏模式：切换后重新适配窗口。
- 导出：PNG（canvas）与 SVG（现有）。

### 3.3 接入

- `MindMapView.tsx`：阅读模式保持现有渲染；纯大纲笔记可切「编辑模式」。
- 笔记类型：普通 Markdown 大纲；不新增 note_type，避免 schema 变更。
- `NewNoteButton`：新增「新建思维导图」（预填根节点模板）。
- 移动端：`MobileMindMap` + 触屏模式，复用同一树/布局模块。

## 4\. 文件清单

| 文件 | 改动 |
| --- | --- |
| `src/components/mindmap/tree.ts` + test | 新增 |
| `src/components/mindmap/layout.ts` + test | 新增 |
| `src/components/mindmap/MindMapEditor.tsx` | 新增 |
| `src/components/mindmap/inline.tsx` | 新增（内联编辑） |
| `src/components/notes/MindMapView.tsx` | 接入编辑模式、PNG 导出 |
| `src/components/NewNoteButton.tsx` | 新建导图入口 |
| `src/pages/notes/MobileNoteEditor.tsx` + `MobileMindMap.tsx` | 移动端 |
| 样式 | 导图节点/连线/选中态，走主题变量 |

## 5\. 阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M1 | tree/layout + 单测 | 解析/序列化往返稳定；布局正确 |
| M2 | 只读渲染替换 + 编辑开关 | 打开导图、切换编辑不丢内容 |
| M3 | 拖动/右键/布局切换 | 操作后 Markdown 正确；撤销可用 |
| M4 | PNG 导出 + 全屏适配 | 导出完整、清晰 |
| M5 | 触屏 + 移动端 | 真机拖动/缩放流畅 |
| M6 | 回归 | 同步、搜索、反链、外部 .md 不受影响 |

## 6\. 风险

| 风险 | 应对 |
| --- | --- |
| 序列化漂移导致每次保存都 dirty | 往返测试；稳定缩进/符号 |
| 大图性能 | 视口裁剪、仅在交互时重算布局 |
| 与编辑器保存竞争 | 统一走编辑器 content 更新路径，不直接写库 |
| 导出字体/中文 | PNG 使用系统字体，必要时嵌入 |

## 7\. 实施记录（2026-11-24）

已按参考实现（本地 KB 仓库 `src/components/mindmap/`）移植并适配：

- `src/components/mindmap/`：`tree.ts`、`layout.ts`、`inline.tsx`、`MindMapEditor.tsx` 及两份单测（37 例通过）。
- `src/components/notes/MindMapView.tsx`：编辑开关、布局切换（左右 / 向右）、全屏、PNG/SVG 导出、分支配色；保留本仓的链接点击拦截（防 WebView 整页导航）。
- `src/pages/notes/editor.tsx`：传入 `noteId` / `onMarkdownChange` / `onTitleChange` / `editBlockedReason`，处理 `location.state.openMindMap`。
- `src/lib/noteCreator.tsx` + `src/components/NewNoteButton.tsx`：新增「新建思维导图」入口。
- `src/components/mobile/MobileMindMap.tsx` + `MobileNoteEditor.tsx`：手机端全屏导图、触屏编辑与底部操作栏。
- `ContextMenuOverlay` 增加可选 `zIndex`，供全屏导图内的右键菜单使用。

差异：实际布局模式为「左右分布 / 全部向右」两种（与参考实现一致），未单独提供「逻辑图 / 树形」第三种模式。