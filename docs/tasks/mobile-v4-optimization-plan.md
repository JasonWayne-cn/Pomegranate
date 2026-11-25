# 移动端 v4 优化实施方案

> 创建：2026-11-25
> 上游：`docs/tasks/mobile-v4-plan.md`（目标、边界、M1–M6 批次保持不变，本文负责落地拆解）
> 核查基线：`0f7c884`（逐页读源码 + 统计，非设计稿推断）
> 关联：`docs/tasks/mobile-qa-checklist.md`、`docs/tasks/lan-sync-plan.md` L5、`docs/tasks/ui-v4-redesign-plan.md`

---

## 一、结论先行

1. **功能骨架已成型**：14 个 `Mobile*` 页面、5 Tab（可配置 4+我的）、≥600dp 自动切侧边 Rail、长按 ActionSheet、键盘 inset、安全区、手动 WebDAV 同步都已存在。本期不是"从零做移动端"，而是**统一规范 + 补齐公共件 + 消除双实现**。
2. **最影响观感与维护成本的是四件事**：
   - 移动页面大量硬编码 `slate / blue / purple / orange`，绕过了 v4 的九套 `[data-theme]` 变量，深色主题下会出现"白底卡片 + 彩色渐变"割裂；
   - `components/mobile/` 只有 3 个公共件，页面各写各的底部面板/输入弹窗；
   - 编辑器是独立的 `textarea + Markdown 语法插入`，与桌面 Tiptap 长期漂移；
   - 三个"幽灵样式"（未定义的 `kbSheetUp` / `kbFadeIn` / `scrollbar-none`）让动画与横滑滚动条实际失效。
3. **建议先做 M0 地基再翻页面**：令牌与公共件不先落，后面 14 页会返工两遍。
4. **本期最大单项是编辑器统一**（ADR-001），风险也集中在这里；建议按"复用 PC Tiptap + 移动外壳"推进，而不是继续维护两套编辑器。

---

## 二、现状核查

### 2.1 资产盘点

| 层 | 现状 | 位置 / 数量 |
|----|------|-------------|
| 移动页面 | 14 个 `Mobile*`，合计约 6.2k 行 | `src/pages/**/Mobile*.tsx` |
| 移动壳层 | 5 Tab + FAB + ≥600dp Rail + 顶部安全区 | `src/components/layout/MobileLayout.tsx` |
| 移动公共件 | 仅 `ActionSheet`、`TaskCreateSheet`、`MobileMindMap` | `src/components/mobile/`（3 个） |
| 移动令牌 | **无** `mobile.css` | `src/styles/` 仅 `global.css` / `themes.css` / `office-sheet-tabs.css` |
| 主题 | 9 套：`[data-theme]` + `--kb-*` 变量 | `src/styles/themes.css` |
| 移动判定 | OS 优先；桌面壳忽略窗口宽度；开发态按 768px | `src/hooks/useIsMobile.ts` |
| 大屏排布 | compact / medium / expanded | `src/hooks/useWindowSizeClass.ts` |
| 键盘 | `visualViewport` 计算 inset | `src/hooks/useKeyboardInset.ts`（仅 2 个页面/件使用） |
| 长按 | Pointer Events + 震动 + 抑制系统菜单 | `src/hooks/useLongPress.ts`（仅待办/回收站使用） |
| 移动配置 | `enabled_views` / `mobile_dashboard_items` / `mobile_tab_keys` | `src/store/index.ts` |
| Android 工程 | 已生成，可调试/构建 | `src-tauri/gen/android/` |
| 版本 | `tauri.conf.json` = 2.2.0 | 但 `MobileMe` 页仍硬编码 v1.7.1 |

### 2.2 缺陷清单（按优先级）

| ID | 问题 | 证据 | 影响 | 优先级 |
|----|------|------|------|--------|
| D1 | `kbSheetUp` / `kbFadeIn` 关键帧不存在 | `ActionSheet.tsx:51,56`、`TaskCreateSheet.tsx:127,132` 使用 `animate-[...]`；全仓无对应 `@keyframes` | 底部面板"瞬间出现"，无滑入/淡入 | P0 |
| D2 | `scrollbar-none` 工具类不存在 | `MobileNotes.tsx:82`、`MobileTasks.tsx:225`、`MobileAi.tsx:169`、`MobileNoteEditor.tsx:384` | chips 横滑行暴露滚动条 | P0 |
| D3 | viewport 缺 `viewport-fit=cover` | `index.html:6` | 刘海屏 `env(safe-area-inset-*)` 可能为 0，安全区形同虚设 | P0 |
| D4 | 主题被硬编码色绕过 | 14 页普遍 `bg-white` / `text-slate-*` / `bg-blue-100` / `from-purple-500` | 九套主题（尤其深色）显示不一致 | P0 |
| D5 | 原生 `window.prompt` | `MobileTags.tsx:78`、`MobileTaskDetail.tsx:222` | Android WebView 风格突兀、可被部分环境禁用；无法校验输入 | P0 |
| D6 | `MoreHorizontal` 死按钮 | `MobileNotes.tsx:73-77` | 点击无反应 | P1 |
| D7 | 版本硬编码 | `MobileMe.tsx:257` 写死 `v1.7.1` | 与 2.2.0 不一致 | P1 |
| D8 | 笔记列表无分页/文件夹 | `MobileNotes.tsx` 仅一次拉取；文件夹 chips 只有"全部" | 长库加载不全、无法按目录浏览 | P1 |
| D9 | 键盘适配只在局部 | 仅 `TaskCreateSheet` / `MobileAiChat` 用 `useKeyboardInset` | AI 首页新建、标签/子任务输入等可能被遮 | P1 |
| D10 | Tiptap 被静态打进首屏链 | `Router.tsx` 静态 import `NoteEditorPage` → `editor.tsx` 静态 import TiptapEditor；仅 `manualChunks` 分包，未延迟加载 | 移动端冷启动提前请求 `vendor-editor`，拖慢首屏 | P1 |
| D11 | Android 返回键为占位 | `MobileLayout.tsx:124-130` 空实现 | 根路由按返回是否退应用未验证 | P1（待真机确认） |
| D12 | 编辑器双实现 | `MobileNoteEditor.tsx` 为 textarea 源码模式；PC 为 Tiptap | 粘贴图片/表格/双链/标签能力不一致，长期漂移 | P1 |
| D13 | 状态栏未接入主题 | 全仓无移动状态栏 API / Android styles 联动 | 深色主题下状态栏可能仍为亮色 | P2（待真机确认） |
| D14 | 文档漂移 | `feature-toggle/index.tsx:48-49` 注释称 Tab 配置"后续"，实际已实现；`MobileMe` 版本号过期 | 误导后续开发 | P2 |

### 2.3 页面差距（对照上游 v4 批次）

| 页面 | 现状 | v4 目标 | 批次 |
|------|------|---------|------|
| 首页 `MobileHome` | 4 数据卡 + 快捷操作 + 热力图 + 最近编辑，功能较全；硬编码渐变与浅色 | 令牌化、深色可用、Dashboard 项联动 | M1 |
| 笔记列表 `MobileNotes` | 置顶/最近分组、点进编辑器；**仅"全部"chip、无分页、无标签/链入数、更多按钮空** | 文件夹层级、行元信息、长按操作、下拉刷新/无限滚动 | M1 |
| 编辑器 `MobileNoteEditor` | 标题 + textarea + 8 工具栏 + 自动保存 + 导图 | 与 PC 同一套富文本；粘贴图片/表格/双链/标签可保存 | M1 |
| 新建 `quick-create` | 空白笔记、闪念、今日笔记、网页剪藏、导入文件可用；模板/语音/拍照占位 | 模板、导入完善；语音接 ASR 单独排期 | M2 |
| 待办 `MobileTasks` | 4 个**静态** chips、分组、checkbox、长按面板、新建 Sheet | 动态计数、今日/本周/逾期准确、左滑完成/删除 | M2 |
| 任务详情 `MobileTaskDetail` | 标题/备注自动保存、子任务、截止、提醒、优先级、snooze、删除；**重复/分类只 toast；子任务用 prompt** | 重复/分类/子任务完整编辑；日期选择面板化 | M2 |
| 日记 `MobileDaily` | 月历、选中日预览、继续编辑 | 周条时间线、今日待办联动 | M2 |
| 闪念 `quick-capture` | 草稿自动保存、保存到今日笔记；工具条全占位 | 图片/标签/AI 可用；语音后置 | M2 |
| 搜索 `MobileSearch` | 300ms debounce + 高亮 + URL 同步，仅 `search_notes` | 笔记 + 待办同出（`search_tasks` 已存在） | M3 |
| AI 首页 `MobileAi` | 模型 chips、4 快捷入口、会话列表、新建 FAB、模型新增 Modal | 会话分组、模型管理（改/默认/测试/删） | M3/M6 |
| AI 对话 `MobileAiChat` | 流式、切模型、取消、复制、Drawer | 一轮一卡、引用笔记、错误态 | M3 |
| 闪卡 `MobileCards` | 复习队列、翻面、4 档评分 | 新建、选中转闪卡 | M4 |
| 标签 `MobileTags` | 标签云、9 色调板、重命名、删除；新增用 prompt | 新增面板化、关联笔记 | M4 |
| 回收站 `MobileTrash` | 横幅、即将清理、行内还原、清空、长按 | 左滑还原/删除、批量 | M4 |
| 同步 `MobileSync` | WebDAV 增删改测、推拉进度 7 阶段 | 扫码/LAN 入口预留（传输依赖 L5） | M4/M6 |
| 我的 `MobileMe` | 统计、数据与同步、隐私、功能模块；多项"桌面专属" | 版本动态化、文案统一、主题只读说明 | M4 |
| 模型服务 | 新增 Modal 可用 | 编辑/设默认/测试/删除 | M6 |
| 提示词/隐藏/关于/图谱 | 部分走桌面页或说明缺失 | 移动只读说明页 | M5 |

---

## 三、目标与验收指标

| 维度 | 指标 |
|------|------|
| 主题 | 9 套主题逐页无"白底硬编码"；深色 3 套（ember/ocean/black）逐页对照 |
| 触控 | 主操作热区 ≥ 44×44；底部面板支持下滑关闭；长按/左滑在笔记、待办、回收站可用 |
| 键盘 | 所有输入型底部面板/AI 输入条不被软键盘遮挡 |
| 安全区 | 刘海/手势条/圆角设备上 top/bottom 均生效 |
| 数据 | 笔记、任务、标签、同步结果与桌面一致；不新增后端协议 |
| 性能 | 移动首屏不请求 `vendor-editor`；500 条笔记滚动不卡顿；面板动画不掉帧 |
| 体积 | 记录 Android APK 基线，本期增量需说明来源（禁止无标注膨胀） |
| 构建 | Android debug / release 可出包（release 需 keystore Secrets，见风险） |

---

## 四、总体设计

### 4.1 分层

```
页面层    src/pages/**/Mobile*.tsx      只负责页面编排
外壳层    src/components/mobile/*         底部面板、选择器、左滑行、下拉刷新
令牌层    src/styles/mobile.css           --m-* 从 --kb-* 派生
能力层    src/hooks/*                     isMobile / sizeClass / keyboardInset / longPress / pullRefresh
数据层    src/lib/api + src/store         复用现有 Command 与全局刷新 tick
```

约束：**页面不直接写颜色常量**；一律走 `--m-*` / `--kb-*` 语义变量或公共件。

### 4.2 令牌层 `src/styles/mobile.css`

在 `src/styles/global.css` 顶部 `@import "./themes.css";` 之后追加 `@import "./mobile.css";`（保持 CSS `@import` 全部位于其它规则之前）。

```css
/* --m-* 只做移动语义别名，真源仍是 --kb-*（九套主题自动生效） */
:root {
  --m-page: var(--kb-bg-app);
  --m-surface: var(--kb-bg-card);
  --m-elevated: var(--kb-bg-elevated);
  --m-well: var(--kb-bg-hover);
  --m-line: var(--kb-border);
  --m-line-weak: var(--kb-border-card);
  --m-ink-1: var(--kb-text-primary);
  --m-ink-2: var(--kb-text-secondary);
  --m-ink-3: var(--kb-text-tertiary);
  --m-primary: var(--kb-primary);
  --m-primary-soft: var(--kb-primary-light);
  --m-on-primary: var(--kb-primary-contrast);
  --m-accent: var(--kb-accent);
  --m-radius-card: var(--kb-radius-card);
  --m-radius-sheet: 20px;
  --m-gutter: 16px;
  --m-tap: 44px;
}

@keyframes mSheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
@keyframes mFadeIn  { from { opacity: 0; } to { opacity: 1; } }

/* 横滑 chips：替代不存在的 scrollbar-none */
.m-scroll-x { overflow-x: auto; scrollbar-width: none; }
.m-scroll-x::-webkit-scrollbar { display: none; }
```

落地写法统一用任意值，例如 `bg-[var(--m-surface)]`、`text-[var(--m-ink-1)]`、`border-[var(--m-line)]`，与现有 `bg-[var(--kb-primary)]` 风格一致，不引入新的 Tailwind 配置。

### 4.3 公共件清单（按需移植，不做全量复制）

| 优先级 | 组件 | 用途 | 关键契约 |
|--------|------|------|----------|
| P0 | `MSheet` | 通用底部面板（动画、遮罩、安全区、键盘 inset、下滑关闭） | `open / title / children / footer / onClose / maxHeight` |
| P0 | `TextPromptModal` | 替换 `window.prompt`（子任务、标签名） | `open / title / placeholder / maxLength / onSubmit / onClose` |
| P0 | `SwipeRow` | 列表左滑操作（笔记/待办/回收站） | `actions[] / threshold / disabled`，滚动时自动取消 |
| P1 | `OptionSheet` | 单选选项（优先级、提醒、重复预设、分类） | `options / value / onChange` |
| P1 | `FolderPickerSheet` | 笔记移动目录 | 复用 `folderApi.list` 树 |
| P1 | `NoteTagsSheet` | 笔记标签增删 | `get_note_tags` / `addTagsBatch` / 标签解绑接口 |
| P1 | `NoteHistorySheet` | 历史版本查看/回滚 | `noteApi.*Snapshot*`（接口已存在） |
| P1 | `NoteOutlineSheet` | Tiptap 标题大纲 | 复用 `onEditorReady` + heading 遍历 |
| P1 | `PullToRefresh` | 首页/列表下拉刷新 | 触摸阈值 + 与滚动容器配合 |
| P2 | `EditorInsertSheet` | 编辑器工具栏溢出（图片/相机/表格/标签/AI） | 受能力门控 |
| P2 | `KingKongIcons` | 九宫格入口 | 首页现有网格可复用，先不新增 |

迁移策略：`ActionSheet` / `TaskCreateSheet` 保留对外 API，内部改为 `MSheet` 薄包装，避免一次性改所有调用点。

### 4.4 编辑器方案（ADR-001）

| 方案 | 复用度 | 可行性 | 开发量 | 一致性 | 风险 | 结论 |
|------|--------|--------|--------|--------|------|------|
| A. 移动壳 + 复用 `TiptapEditor` | 高（扩展/序列化/图片管线同一套） | 高（已支持 `content/onChange/noteId/toolbarSlot/readOnly`） | 中（加 `variant="mobile"`） | 高 | 中（触屏浮层、输入法） | **采纳** |
| B. 继续 textarea + 预览 | 低 | 高 | 低 | 低（继续漂移） | 长期维护翻倍 | 不采纳 |
| C. 抽 `useNoteEditor` + 双外壳重构 | 最高 | 中 | 高（2.8k 行桌面页重构） | 最高 | 高 | 暂缓，若 M1 后仍漂移再启动 |

**决策：A。** `TiptapEditor` 增加 `variant?: "desktop" | "mobile"`：

- 移动端渲染紧凑工具栏（粗体/斜体/标题/列表/待办/双链/图片/更多），隐藏底部统计与查找替换默认态；
- 保留 `TableBubbleMenu` / `AiWriteMenu`（触摸可用），悬浮类交互做 44px 热区；
- 图片粘贴继续走 `noteId` 管线，首次插入前用 `ensureNoteId`；
- 页面外壳（标题、保存状态机、Pin、导图、返回前 flush）沿用 `MobileNoteEditor` 现有逻辑，只替换正文区；
- 保留"源码模式"开关，复用 `MarkdownSourceEditor`，供高级用户排障。

### 4.5 性能策略

1. **首屏不加载编辑器**：把 `/notes/:id` 改为路由级 `lazy`（Router 已有 `LazyPage` 基建），或至少让移动分支动态 import TiptapEditor；目标是移动首屏资源列表里不出现 `vendor-editor`。
2. **列表**：笔记列表用 `IntersectionObserver` 无限滚动（`page_size=20`），超过 200 条再考虑 `@tanstack/react-virtual`；行组件 `memo`。
3. **图片**：列表预览不加载原图；详情按需。
4. **动画**：只动 `transform/opacity`；`prefers-reduced-motion` 下降级。
5. **测量**：`pnpm build` 记录 chunk 体积；真机 Chrome remote debugging 记录首屏请求与 FCP；不凭感觉下结论。

### 4.6 系统交互

- `index.html` 增加 `viewport-fit=cover`。
- 统一安全区：底部面板/全屏页 `padding-bottom: env(...)`，与键盘 inset 二选一取大值。
- 长按统一 `useLongPress` + `ActionSheet`；禁止再新增 `onContextMenu` 移动分支。
- 左滑统一 `SwipeRow`；不引入手势库。
- Android 返回键与状态栏：先真机验证默认行为，再决定是否加原生配置；**不在未验证前引入新依赖**。

---

## 五、批次与任务

> 依赖原则：M0 全部完成才开 M1；M2/M3 可并行；M4 依赖 M0；M5/M6 跟随各自方案。
> 优先级：P0 = 本期必做；P1 = 本期计划；P2 = 有余量再做。

### M0 地基（P0）

| ID | 任务 | 改动文件 | 验收 |
|----|------|----------|------|
| MV4-001 | 补齐 `mSheetUp/mFadeIn` 关键帧；新增 `.m-scroll-x` 并替换 4 处 `scrollbar-none`；`viewport-fit=cover` | `mobile.css`、`global.css`、`index.html`、4 个页面 | 面板有滑入动画；chips 无滚动条；安全区生效 |
| MV4-002 | 新建 `mobile.css` 令牌（4.2） | `src/styles/mobile.css` | 9 主题下 `--m-*` 随 `--kb-*` 变化 |
| MV4-003 | 外壳主题化：`MobileLayout`、`MobileHome`、`MobileNotes` 改用 `--m-*` | 3 个文件 | 深色三主题无白底块 |
| MV4-004 | `MSheet` 抽象并迁移 `ActionSheet`/`TaskCreateSheet` | `components/mobile/*` | 原调用点零改动、行为一致 |
| MV4-005 | `TextPromptModal` 替换两处 `window.prompt` | `MobileTaskDetail`、`MobileTags` | 可校验、键盘不遮、取消无副作用 |
| MV4-006 | 统一移动交互规范（安全区/键盘/热区/长按/左滑）写入注释与共享常量 | `mobile.css` + hooks | 新页面按规范实现 |
| MV4-007 | 增加 Android 调试/构建脚本与验证记录 | `package.json`、`src-tauri/gen/android` | `debug` 可装真机 |
| MV4-008 | 性能基线：构建 chunk 清单 + 真机首屏请求 | 文档记录 | 形成基线数据，供后续对比 |

### M1 首页 / 笔记 / 编辑器（P0）

| ID | 任务 | 要点 | 验收 |
|----|------|------|------|
| MV4-101 | 首页令牌化与深色适配 | 数据卡/渐变/热力图改用 `--m-*`；Dashboard 项隐藏后布局不塌 | 9 主题下可读 |
| MV4-102 | 笔记列表补全 | `folderApi.list` 文件夹 chips（含"未分类/全部"）；无限滚动；`More` 接入刷新/排序/新建菜单 | 长库能滚到底；按目录筛选正确 |
| MV4-103 | 笔记行交互 | 长按 ActionSheet（置顶/移动/复制链接/删除）；`SwipeRow` 左滑置顶/删除 | 与桌面行为一致，不误触进详情 |
| MV4-104 | 行元信息 | 标签、链入数、置顶/日记徽章；后端无字段则先只做已有 `is_pinned/is_daily` | 不伪造数据 |
| MV4-105 | 编辑器复用 Tiptap（ADR-001） | 移动外壳 + `variant="mobile"`；标题/自动保存/Pin/导图保留 | 加粗/列表/待办/双链/表格可编辑并回写 |
| MV4-106 | 编辑器附件能力 | 粘贴/选择图片走 `noteId`；失败有明确提示 | 手机相册图片可插入并保存 |
| MV4-107 | 编辑器辅助面板 | 历史版本、标签、大纲（按 4.3 依赖） | 回滚后正文与桌面一致 |
| MV4-108 | 编辑器性能与键盘 | 路由级 lazy；输入法弹起不遮工具栏/光标 | 首屏不请求 `vendor-editor` |

### M2 新建 / 待办 / 日记（P1）

| ID | 任务 | 要点 | 验收 |
|----|------|------|------|
| MV4-201 | QuickCreate 完善 | 模板入口（有模板 API 则接，无则维持占位并标注）；导入文件体验补齐 | 不出现"待开发"误导入口 |
| MV4-202 | 待办筛选动态化 | 今日/本周/逾期/已完成计数与分组实时一致；静态 chips 移除 | 边界日期（23:59）不漂移 |
| MV4-203 | 待办行交互 | 左滑完成/删除；长按面板保留 | 完成状态即时更新分组 |
| MV4-204 | TaskDetail 完整编辑 | 截止（面板化日期时间）、提醒、优先级、重复（`repeat_kind/interval/weekdays/until/count`）、分类（`category_id`）、子任务（`parent_task_id`） | 所有字段写后返回列表正确 |
| MV4-205 | 通用 `OptionSheet` 与重复预设 | 每日/每周/每月/自定义，映射现有字段 | 与桌面重复规则互通 |
| MV4-206 | Daily 增强 | 周条时间线 + 今日待办入口 | 日期切换与今日笔记正确 |
| MV4-207 | QuickCapture 工具条 | 图片、标签、AI 整理可用；相机/语音维持门控 | 草稿与保存链路不回退 |

### M3 搜索 / AI（P1）

| ID | 任务 | 要点 | 验收 |
|----|------|------|------|
| MV4-301 | 搜索笔记 + 待办 | 并发 `search_notes` + `search_tasks`，分组展示、关键词高亮 | 空结果/超时各自兜底 |
| MV4-302 | AI 首页会话分组 | 按时间分组；模型管理入口；模型失败态可见 | 切换默认模型后新对话生效 |
| MV4-303 | AI 对话增强 | 一轮一卡、引用笔记数、停止/重试、错误提示 | 流式中断后状态可恢复 |
| MV4-304 | 模型服务前置 | 在 `MobileAiModelModal` 旁增加列表管理：编辑/设默认/测试/删除 | 复用 `aiModelApi.update/setDefault/test/delete` |

### M4 卡片 / 标签 / 回收站 / 同步 / 我的（P1–P2）

| ID | 任务 | 要点 | 验收 |
|----|------|------|------|
| MV4-401 | 闪卡新建与转闪卡 | 新建卡片表单；笔记/选中文本转闪卡（按现有 API） | 复习队列立即出现 |
| MV4-402 | 标签页面板化 | 新增用 `TextPromptModal`；调色板/重命名/删除保持 | 与桌面标签数据一致 |
| MV4-403 | 回收站左滑 | 还原/永久删除；批量入口 | 双确认不丢 |
| MV4-404 | 同步页入口预留 | LAN/扫码占位卡片（明确"依赖 L5"），WebDAV 不变 | 不承诺未实现能力 |
| MV4-405 | 我的页收口 | 版本动态读取；"桌面专属"统一文案；主题只读说明 | 版本与 `tauri.conf` 一致 |

### M5 只读说明页（P2）

提示词库、隐藏笔记、关于、图谱说明：复用桌面数据源，移动端只读；不复制桌面复杂交互。

### M6 依赖项（P2，单独排期）

- 模型服务完整管理（若 M3 未完成）；
- 移动思维导图交互完善；
- LAN 当主机（严格依赖 `lan-sync-plan.md` L5，不并入 UI 批次）。

---

## 六、验收方案

### 6.1 真机矩阵

| 设备 | 用途 |
|------|------|
| Android 手机（刘海/挖孔，Android 10+） | 主验收：安全区、键盘、手势 |
| Android 平板或折叠屏（≥600dp） | Rail 布局、宽屏列表 |
| 桌面浏览器窄窗（<768px） | 开发期快速回归 |

至少一台**真机**，模拟器只做补充。

### 6.2 逐页验收

以 `docs/tasks/mobile-qa-checklist.md` 为基线，新增本期项：

- 9 主题 × 14 页：无白底硬编码、无低对比文字；
- 底部面板：滑入动画、下滑关闭、键盘顶起；
- 笔记列表：文件夹筛选、无限滚动、长按/左滑；
- 编辑器：图片、表格、双链、标签、保存与返回刷新；
- 任务详情：重复/分类/子任务写后一致；
- 性能：首屏请求清单、500 条滚动、面板帧率。

### 6.3 主题矩阵

深浅各取至少 2 套做全页截图对比（建议 `light-lilac / light-peach / dark-ember / dark-black`），其余 5 套抽查首页、笔记、编辑器、我的。

### 6.4 性能测量

1. `pnpm build`：记录 `index` / `vendor-editor` / 移动页 chunk 体积；
2. 真机 Chrome remote debugging：首屏资源清单，确认无 `vendor-editor`；
3. 500 条笔记列表滚动与长按响应；
4. 面板打开/关闭帧率（DevTools Performance）。

### 6.5 构建

- `pnpm tauri android dev` 真机跑通；
- `pnpm tauri android build --debug` 出包；
- release 需 keystore Secrets，缺失时记录为阻塞项，不伪造通过。

---

## 七、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Tiptap 在 Android 输入法下光标/选词异常 | 编辑器可用性 | M1 先小范围灰度（笔记 + 日记）；保留源码模式回退；真机矩阵覆盖 Gboard/搜狗 |
| 主题替换引发视觉回归 | 大面积返工 | 令牌替换按页提交，逐页截图对比；禁止同 commit 混入功能改动 |
| 公共件过度抽象 | 维护成本上升 | 只做被 ≥2 页使用的件；`ActionSheet` 保持 API 兼容 |
| 长时间不提交导致多会话冲突 | 工作区污染 | 按 M0/M1 小步提交，提交信息带 `[scope: mobile]` |
| Android 返回键/状态栏行为不确定 | 体验缺陷 | 先验证再改，不预先引入插件依赖 |
| 双端数据不一致（新编辑能力） | 用户信任 | 复用桌面序列化与字段，禁止移动端私有格式 |
| release 签名缺失 | 无法出正式包 | 提前确认 Secrets；debug 包先行验收 |

---

## 八、本期不做（明确边界）

- iOS 全套（需 Mac，`T-M005` 阻塞）；
- LAN 当主机、扫码同步传输（依赖 L5）；
- 语音录入 / 拍照 OCR / PDF 导入（依赖 ASR、相机权限、PDF 引擎）；
- Word/Excel 导入（桌面专属）；
- 移动图谱触屏重写（`T-M011`）；
- PC 桌面布局任何改动；
- 甘特图/白板/Office 的移动适配（独立模块）。

---

## 九、执行顺序

```
M0（001→008 串行，002 先于 003/004/005）
  ├─ M1（101→108；105 编辑器可先起，108 收尾）
  ├─ M2（201→207；204 依赖 205）
  ├─ M3（301→304）
  └─ M4（401→405）
        └─ M5（只读页）
              └─ M6（依赖项，单独排期）
```

**建议提交节奏**：每个 MV4 任务一次提交；M0 的 001/002 可合并为一次"移动端地基"提交；主题替换与功能改动分开。

---

## 十、实施记录（2026-11-25）

> 本节记录实际落地结果与偏差，后续会话以本节为准。

### 已完成

| 批次 | 结果 |
|------|------|
| M0 | 新增 `src/styles/mobile.css`（`--m-*` 令牌、`mSheetUp/mFadeIn`、`m-scroll-x`、安全区工具、移动工具栏样式）；`global.css` 引入；`index.html` 补 `viewport-fit=cover`；补齐 `MSheet` / `TextPromptModal` / `SwipeRow` / `FolderPickerSheet`；`ActionSheet`、`TaskCreateSheet` 收口到 `MSheet`；两处 `window.prompt` 已替换；`MobileLayout`、首页、笔记、待办、任务详情、日记、搜索、AI、AI 对话、闪卡、标签、回收站、同步、我的、新建/闪念、功能模块页均改用 `--m-*` 令牌 |
| M1 | 笔记列表接入目录 chips（全部/未分类/多级目录）、`IntersectionObserver` 无限滚动、标签/字数/时间元信息、长按 ActionSheet（打开/置顶/移动/复制链接/删除）、左滑置顶/删除、`More` 菜单；编辑器改用共享 `TiptapEditor`（`toolbarSlot` 把工具栏投到移动底栏横滑条），保留自动保存 / Pin / 导图 / 源码模式 / 键盘 inset；`/notes/:id` 路由改为 lazy，首屏不再加载 `vendor-editor` |
| M2 | 待办 chips 改为实时统计与分组；任务行支持左滑完成/删除；任务详情补齐重复（每天/每周/工作日/每月）、分类选择、子任务面板输入；日记页增加“今日待办”速览 |
| M3 | 搜索同时检索文档与待办（分组展示、关键词高亮）；AI 首页会话按今天/昨天/更早分组；模型管理支持编辑/设默认/测试/删除（`MobileAiModelModal` 新增 `editing`） |
| M4 | 闪卡支持新建（正面/背面/牌组）；标签新增改为面板输入、删除改为 AntD 确认；回收站支持左滑还原/永久删除；“我的”页版本改为 `getVersion()` 动态读取 |
| M5 | 新增 `MobilePrompts`：提示词只读浏览、搜索、复制；`/prompts` 按 `useIsMobile` 分发 |
| 验证 | `npx tsc --noEmit` 通过；`vite build` 通过；`vendor-editor` 与 `editor` 已独立分包 |

### 偏差与未完成

| 项 | 状态 | 说明 |
|----|------|------|
| 编辑器 `variant="mobile"` prop | 未采用 | 改用 `toolbarSlot` + `mobile.css` 单行横滑，避免改动 1.8k 行桌面工具栏 |
| MobileSync LAN | 未改动 | 核查发现 LAN 扫码/配对已由并行工作实现（`MobileLanHostSheet`、`QrScanner`、`lan` 后端类型），本期不重复开发 |
| 隐藏笔记 / 图谱移动页 | 未完成 | `/hidden`、`/graph` 仍渲染桌面组件；PIN 与图谱触屏交互需要单独设计，建议并入 M6 |
| QuickCreate / QuickCapture 工具条 | 部分保留占位 | 模板、语音、拍照、图片、标签、AI 整理仍为占位；语音依赖 ASR，图片/标签可下一批接 |
| 真机验收 | 未执行 | 需 Android 真机逐页过 9 主题、键盘、安全区、长按/左滑 |
| Android 出包 | 未执行 | `tauri android build` 需本机 SDK / keystore，留给 M0-007 后续 |

### 后续建议顺序

1. 真机验收 + 修复触屏问题（优先级最高，代码层面已无法替代）；
2. QuickCapture 图片/标签、笔记转闪卡；
3. `/hidden`、`/graph` 移动只读页；
4. 清理剩余页面中少量硬编码色（标签色板等语义色保留）。
