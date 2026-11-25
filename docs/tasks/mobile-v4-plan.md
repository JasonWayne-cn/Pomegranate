# 移动端 v4 方案

> 创建：2026-11-24
> 参照：knowledge-base 移动端 v0.4.0–v0.9.0 系列提交（v4 13 屏、共享组件、编辑器同套富文本、当主机等）
> 本仓：已有 14 个 `Mobile*` 页面，但 `components/mobile/` 公共件层较薄，编辑器为独立实现
> 关联：`remaining-improvements-plan.md` §2.G、`lan-sync-plan.md` L5（手机当主机）、`ui-v4-redesign-plan.md`（桌面主题变量）

## 1. 目标与边界

**目标**：把移动端页面统一到 v4 规范，与桌面共享数据层、主题变量与关键组件，降低双端维护成本。

**边界**

- 本期只做移动端 UI 与交互；不改桌面布局。
- 手机当主机依赖 `lan-sync-plan.md` L5，单独排期。
- 不追求与桌面完全同构，保留移动端底部 Tab 与单列信息流。

## 2. 现状

| 层 | 本仓 | KB |
|----|------|----|
| 移动页面 | 14 个 `Mobile*`（AI、卡片、日记、首页、笔记、搜索、我的、同步、标签、待办、回收站） | 13 屏 + 补齐页 |
| 公共组件 | `components/mobile/` 仅少量 | 20 个（MSheet/ActionSheet/SwipeRow/FolderPicker/NotePicker/TaskCreateSheet…） |
| 设计令牌 | 无独立 `mobile.css` | `mobile.css`，`--m-` 前缀 |
| 编辑器 | `MobileNoteEditor` 独立实现 | 与 PC 同一套富文本 |
| 模型服务 | `MobileAiModelModal` 已有 | 可编辑/设默认/测试/删除 |
| 闪卡 | `MobileCards` | 可新建、选中转闪卡 |
| 同步 | `MobileSync` WebDAV/S3 | + 局域网 + 扫码 + 当主机 |

## 3. 设计

### 3.1 令牌与公共件

- 新增 `src/styles/mobile.css`：`--m-page / --m-surface / --m-well / --m-line / --m-ink* / --m-radius / --m-gutter`，主题变量从 `--kb-*` 派生。
- 公共组件（按需移植）：
  - `MSheet`、`ActionSheet`、`TextPromptModal`、`SwipeRow`
  - `FolderPickerSheet`、`NotePickerSheet`、`NoteTagsSheet`、`NoteHistorySheet`、`NoteOutlineSheet`
  - `TaskCreateSheet`、`RepeatSheet`、`EditorInsertSheet`
  - `KingKongIcons`（九宫格入口图标）
- 底部 Tab 外框：首页 / 笔记 / 待办 / AI / 我的；其余页面从入口进入。

### 3.2 页面批次

| 批次 | 页面 | 要点 |
|------|------|------|
| M1 | 首页、笔记列表、编辑器 | 同步状态、文件夹层级、笔记行标签/链入数；编辑器与 PC 富文本统一 |
| M2 | 新建面板、待办、任务详情、日记 | 底部弹出面板；周条时间线；今日待办 |
| M3 | 搜索、AI 首页、AI 对话 | 笔记+待办同出；会话分组；一轮一卡 |
| M4 | 卡片、标签、回收站、同步、我的 | 闪卡新建、标签色板、回收站还原、同步扫码入口 |
| M5 | 提示词 / 隐藏 / 关于 / 图谱说明页 | 复用桌面数据，移动端只读说明 |
| M6 | 模型服务、思维导图、LAN 当主机 | 依赖各自方案 |

### 3.3 系统交互

- 状态栏/导航栏：跟随主题深浅；底部留白与三键导航兼容。
- 软键盘：底部面板与格式条让出键盘高度。
- 下拉刷新、左滑收起、长按操作统一用公共件。
- 安全区（刘海/圆角）统一 `env(safe-area-inset-*)`。

## 4. 文件清单（示意）

| 类型 | 路径 |
|------|------|
| 令牌 | `src/styles/mobile.css` |
| 公共件 | `src/components/mobile/*` |
| 页面 | `src/pages/**/Mobile*.tsx` |
| 编辑器 | `src/pages/notes/MobileNoteEditor.tsx` + 共享 Tiptap 适配 |
| 路由/入口 | `src/App.tsx` / `Router.tsx`（按现有移动端判定） |

## 5. 验收

- 真机（Android 至少一台）：13 屏逐页对照 v4；
- 深色逐页检查；系统栏不压内容；
- 编辑器：粘贴图片、表格、双链、标签、保存/同步；
- 键盘弹出不遮输入框；底部面板可下滑收起；
- 与桌面同步后数据一致；LAN/WebDAV 双通道可用；
- 构建：Android debug/release 可出包，Release 需 keystore Secrets。

## 6. 风险

| 风险 | 应对 |
|------|------|
| 编辑器双实现长期漂移 | 优先复用 PC 扩展与序列化；移动端只做外壳 |
| 系统栏/键盘碎片化 | 真机矩阵 + 安全区变量 |
| 组件移植体积 | 按页面需要引入，不做全量复制 |
| 当主机权限/服务 | 由 LAN L5 单独验证，不与 UI 批次混做 |
