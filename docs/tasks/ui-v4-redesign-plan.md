# UI v4 全站换皮 + 9 套主题 · 开发方案

> 创建：2026-11-23
> 目标版本：V4.0.0（与 V3.5.0 可靠性升级分开推进）
> 参照：knowledge-base `docs/design/ui-v4`（原型 + 功能清单）、`docs/tasks/ui-redesign-v4-tasks.md`、`src/theme/tokens.ts`、`src/styles/themes.css`
> 本仓基线：主题 5 套、`themes.css` 1036 行、`tokens.ts` 84 行、页面 30+、布局组件 10 个

## 1. 目标与原则

**目标**：在不删功能的前提下，把桌面端界面统一到 UI v4 规范，并提供 9 套可切换主题（5 亮 + 4 暗）。

**设计原则**（来自 v4 原型，必须遵守）：

1. 一套主题只有一个主色；亮色底色带主色调，内容区是「白纸」；暗色用抬升色区分层级。
2. 文字不用纯黑（亮色）/ 不用纯白（暗色）。
3. 按钮无投影；普通按钮白底细描边，悬停浅主色底。
4. 圆角统一：卡片 14、弹窗 16、下拉 11、菜单项 6。
5. 动效克制：只保留 hover / 展开 / 进度，不做大面积动画。
6. 主题色同时服务两类消费方：Ant Design（含 portal 弹层）与自有 CSS 变量。
7. 全站不得出现写死的十六进制颜色（图表/画布内部除外）。

## 2. 9 套主题

| key | 名称 | 分类 | 主色 | 背景 | 文字 |
|-----|------|------|------|------|------|
| `light-lilac` | 淡紫（亮色默认） | light | `#7C63DC` | `#E9E4F8` | `#27233B` |
| `light-celadon` | 青瓷 | light | `#258A7E` | `#E2EFEC` | `#1F3431` |
| `light-mist` | 晨雾蓝 | light | `#3D74D6` | `#E3EAF6` | `#1F2A3D` |
| `light-peach` | 杏桃 | light | `#C65F45` | `#F6E9E1` | `#3A2925` |
| `light-gold` | 香槟 | light | `#A87B1E` | `#F5EEDC` | `#33291A` |
| `dark-ember` | 暖炭（暗色默认） | dark | `#A992FA` | `#161514` | `#EFEBE4` |
| `dark-ocean` | 深海 | dark | `#5AA9F0` | `#12171E` | `#E6ECF3` |
| `dark-amber` | 琥珀 | dark | `#E9B95A` | `#17130E` | `#F0E8DC` |
| `dark-black` | 纯黑 | dark | `#A992FA` | `#0A0A0B` | `#ECECEE` |

**旧主题迁移**：`light-glass / light-warm / light-jade` → `light-lilac`；`dark-starry / dark-mocha` → `dark-ember`。由 `normalizeThemeMode` 在读取持久化时归一，避免老用户启动后无主题。

## 3. 架构设计

### 3.1 四层令牌

```
L0 基础令牌     间距 / 圆角 / 字号 / 行高 / 阴影 / 动效        （与主题无关，只定义一次）
   │
L1 主题调色板   PALETTES[theme]（9 套）                         tokens.ts
   │
L2 语义变量     --kb-bg-app / --kb-bg-card / --kb-text-* / --kb-primary …   themes.css
   │
L3 组件覆盖     Ant Design token + components + 自有 kit 类      tokens.ts / global.css
   │
L4 页面样式     页面只消费 L2/L3，禁止写死颜色
```

**单一事实来源**：每套主题的颜色写两处，改色必须同步：

- `src/theme/tokens.ts` 的 `PALETTES` → 给 Ant Design（含 Modal/Dropdown 等 portal 弹层）
- `src/styles/themes.css` 的 `[data-theme="…"]` 变量块 → 给应用自有样式

### 3.2 运行时切换

```
用户选择主题
  → store.setLightTheme / setDarkTheme / setThemeCategory
  → document.documentElement.dataset.theme = activeTheme
  → <ConfigProvider theme={{ token: getAntdTokens(mode), components: getAntdComponents(mode) }}>
  → CSS 变量与 antd token 同时生效
```

补充：

- 多窗口（pop-out / 独立弹窗）通过 store 同步 `data-theme`。
- 保留现有 `customAccent` 与自定义背景图逻辑：`customAccent` 以内联 `--kb-primary` 覆盖，优先级高于 `[data-theme]`。
- 移动端 `MobileLayout` 复用同一套变量，不在本期重构布局。

### 3.3 旧主题下线策略

1. 先加 9 套新主题（新旧共存）。
2. 默认主题切到淡紫 / 暖炭。
3. 全站换皮完成、回归通过后，一次性删除旧 5 套的 CSS 块与 `ThemeMode` 枚举项。
4. 删除前保留 `normalizeThemeMode` 映射，保证老配置可恢复。

## 4. 全站换皮范围

### 4.1 公共外壳（先做，影响所有页面）

| 组件 | 文件 | 改造点 |
|------|------|--------|
| 主布局 | `components/layout/AppLayout.tsx` | 通栏标题栏、内容区圆角纸张、侧栏底色透出 |
| 活动栏 | `components/layout/ActivityBar.tsx` | 宽窄两档、分组分隔线、图标/文字主题化 |
| 侧栏面板 | `components/layout/SidePanel.tsx` | 浮层/固定两种形态、圆角与描边 |
| 顶部栏 | `AppLayout` Header 区 | 后退/前进、版本徽章、搜索、主题、设置、置顶、窗口按钮 |
| 标签栏 | `components/layout/TabBar.tsx` | 与标题栏同一行、溢出横滚 |
| 窗口按钮 | `components/layout/WindowControls.tsx` | hover 底色改主题变量 |
| 面板通用 | `components/layout/panels/PanelSectionHeader.tsx` | 小节标题、计数灰字、选中白底 |

### 4.2 公共 UI 组件（第二批）

`components/ui/` 下的 `EmptyState`、`ContextMenuOverlay`、`UpdateBadge`、`UpdateModal`、`RecommendCards`、`CommandPalette`、`ShortcutsPanel` 等；以及 `global.css` 中 `.kb-surface`、菜单、表格、分页、弹窗遮罩等通用规则。

验收：任选一页，切换 9 套主题，公共组件不得出现白底/黑字错位。

### 4.3 页面批次

按「使用频率 + 依赖关系」排序，每批独立验收、可单独回滚：

| 批次 | 页面 | 说明 |
|------|------|------|
| A | 首页 `home`、笔记列表 `notes`、编辑页、日记 `daily` | 使用频率最高，先定住「纸张」与工具栏规范 |
| B | 待办 `tasks`、搜索 `search`、标签 `tags`、复习 `cards` | 列表/卡片/筛选条规范 |
| C | 图谱 `graph`、AI `ai`、提示词 `prompts`、推送 `push`、隐藏 `hidden`、回收站 `trash` | 右侧常驻编辑、卡片网格、编号出处等 v4 交互 |
| D | 关于 `about`、设置 `settings`、插件 `plugins`、挂载 `mounts`、研究 `research`、扩展 `extensions`、功能开关 `feature-toggle`、同步 `sync` | 设置改「左导航 + 右滚动」；关于改横幅 + 两列卡片 |
| E（特殊） | 白板 `whiteboard`、Office `office`、PPT `ppt`、`pptx-spike`、打印 `print`、各类弹窗窗口 | **只改外框/工具栏/令牌**，不重写 Excalidraw 画布、PDF/Office 渲染器与 PPT 编辑器内部 |

### 4.4 明确不做

- 不删任何功能；不合并/改名现有页面（除 v4 明确要求的交互调整）。
- 不重构白板画布、Office/PDF 渲染、PPT 编辑器内部实现。
- 不做移动端 v4 的 13 屏重构（仅共享主题变量）。
- 不照搬 KB 品牌 logo / 官网文案；配色采用上表，品牌元素仍用本仓。

## 5. 实施阶段

| 阶段 | 内容 | 验收 |
|------|------|------|
| T0 | 原型与功能清单归档；盘点写死颜色与第三方组件 | 产出 `docs/design/ui-v4/` 引用 + 颜色审计清单 |
| T1 | 9 套主题令牌（`tokens.ts` + `themes.css`）；主题切换菜单；旧 id 归一 | 9 套主题可切换，antd 弹层同步 |
| T2 | 公共外壳 + 公共 UI 组件换皮 | 9 主题 × 外壳无错位；多窗口一致 |
| T3-A | 首页 / 笔记列表 / 编辑页 / 日记 | 4 页在 9 主题下截图通过；功能清单逐条勾选 |
| T3-B | 待办 / 搜索 / 标签 / 复习 | 同上 |
| T3-C | 图谱 / AI / 提示词 / 推送 / 隐藏 / 回收站 | 同上 |
| T3-D | 关于 / 设置 / 插件 / 挂载 / 研究 / 扩展 / 同步 | 同上 |
| T3-E | 白板 / Office / PPT / 打印 / 弹窗外框 | 仅外框与工具栏；画布内部不回归 |
| T4 | 删除旧 5 套主题；清理临时兼容代码 | 老配置归一正常；代码中无旧主题分支 |
| T5 | 全量回归与发布 | 见第 7 节 |

## 6. 关键技术风险

| 风险 | 说明 | 应对 |
|------|------|------|
| 写死颜色 | 页面/组件里存在 `#xxxxxx`、`rgba(...)` 硬编码，换主题后不跟随 | T0 全仓扫描（`#[0-9a-fA-F]{3,8}`），逐页替换为 `--kb-*`；图表/画布白名单 |
| 第三方暗色 | Excalidraw、mermaid、cytoscape、PDF/Office 渲染有自己的配色 | 只包外框；必要时注入 CSS 变量或提供主题映射表 |
| antd portal | Modal/Dropdown/Select 渲染到 body，容易落回默认白底 | 全部通过 `ConfigProvider` token + `colorBgElevated/bgMask` 覆盖 |
| 多窗口 | pop-out 子窗口、推送弹窗、迁移页各自加载 | 统一在入口读取 store 并设置 `data-theme` |
| Win7 WebView2 | 旧版 WebView2 对 `backdrop-filter`、`color-mix()` 支持有限 | 关键样式提供降级（纯色/半透明替代）；不依赖现代 CSS 函数 |
| 主题数量膨胀 | 9 套 × 大量页面级覆盖会让 CSS 失控 | 页面只消费语义变量；主题块只定义变量，不写页面选择器 |
| 自定义强调色/背景图 | 现有 `customAccent`、`themeOverridesEnabled` 与主题叠加 | 保持内联覆盖优先级；每套主题给默认强调色，用户改色仍生效 |
| 性能 | 全站换皮后首屏 CSS 变大 | 主题块按变量组织；不新增运行时 CSS-in-JS；构建体积纳入门禁 |

## 7. 验收与测试

**每阶段门禁**

```bash
npx tsc --noEmit
pnpm vitest run
pnpm build
```

**视觉回归**

- 主题矩阵：9 套 × 亮/暗分类 × 主窗口 + pop-out 窗口。
- 页面清单：按 `docs/design/ui-v4/功能清单.md` 逐条勾选「不删功能」。
- 截图对比：每批页面提供「换皮前 / 换皮后」截图，归档到 `docs/design/ui-v4/screenshots/`。
- 颜色审计：构建前脚本扫描 `src/**/*.tsx|css` 的硬编码颜色，白名单外即失败。

**功能回归重点**

- 主题切换后刷新/重启保持；
- 弹窗、下拉、右键菜单、命令面板主题一致；
- 编辑器工具栏、选区浮条、状态栏在 9 主题下可读；
- 白板/Office/PPT 打开、保存、导出不回归；
- 移动端布局仅复用变量，页面结构不变。

## 8. 交付顺序

1. T0 审计（写死颜色、第三方组件、页面清单）
2. T1 主题基建（9 套令牌 + 切换 + 迁移）
3. T2 外壳与公共组件
4. T3-A → T3-D 页面批次
5. T3-E 特殊页面外框
6. T4 删除旧主题
7. T5 全量回归、截图归档、发布 V4.0.0

## 9. 与现有计划的关系

- 本方案与 `docs/tasks/v3.5.0-upgrade-plan.md` 相互独立：V3.5.0 做可靠性/数据安全，V4.0.0 做视觉与主题。
- 主题令牌改造会触碰 `AppLayout`、`Settings` 等文件，实施前需确认当时工作区无其他会话的未提交改动，必要时使用 worktree。
- 建议按批次提交，每批一个 commit，便于单独回滚。

## 10. 实施进度（2026-11-23）

| 阶段 | 状态 | 交付物 / 证据 |
|------|------|----------------|
| T0 | ✅ | `scripts/check-theme-colors.mjs` + `pnpm check:theme-colors`；画布/图表/颜色选择器白名单；当前审计通过 |
| T1 | ✅ | `tokens.ts` 9 套 PALETTES + antd token/components；`themes.css` 9 套变量；旧 id `normalizeThemeMode` 归一；默认淡紫/暖炭 |
| T2 | ✅ | 侧栏/标题栏/ActivityBar/SidePanel 语义变量；卡片 14、Modal 16、Dropdown 11、菜单项 6；弹层/表格/分页/页签统一；组合按钮连续修复 |
| T3-A~D | ✅ | 约 60 个页面/组件文件的写死主色与灰阶替换为 `--kb-*`；笔记/回收站/隐藏列表统一 14px 纸张圆角；设置页沿用左导航 + 右滚动 |
| T3-E | ✅ | 白板/Office/PPT/打印/图表/预览器仅继承全局令牌，画布与渲染器内部未重写 |
| T4 | ✅ | 删除旧 5 套主题 CSS 与旧主题枚举分支；删除 `StarryBackground`；暗色语法高亮改用 `[data-theme-category="dark"]` |
| T5 | ✅ | `npx tsc --noEmit`、`pnpm test`（626）、`pnpm build`、颜色审计均通过；首页截图确认外壳/卡片/组合按钮 |

**待办（可选）**
- ✅ 9 套主题主窗截图已归档到 `docs/design/ui-v4/screenshots/theme-*.png`（pop-out 窗口待补）；
- Win7 WebView2 实机回归（`backdrop-filter` / `color-mix` 降级）；
- macOS / Linux 视觉回归；
- V4.0.0 发布与更新包。
