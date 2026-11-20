# Office 工作台：界面设计与开发计划

> 状态：设计稿（待评审）
> 更新：2026-11-17
> 关联：[Office 引擎路线](./office-engine-roadmap.md)、[PPT 扩展包](./ppt-extension.md)

---

## 1. 目标与边界

### 目标

- 在现有应用壳内提供统一 **Office 工作台**：`.pptx` / `.docx` / `.xlsx` / `.pdf` 打开、预览、高频编辑、保存。
- 阅读/保真**全量**：不支持的内容原样保留字节，不丢数据。
- 编辑能力**子集**：文字、字体、颜色、对齐、位置尺寸、单元格值、幻灯片增删；长尾能力明确提示并给出"外部打开"入口。

### 非目标

- 不做完整 Office ribbon，不复刻宏、动画时间轴、数据透视、邮件合并。
- 不在主包引入 Node/Electron 运行时；Win7（WebView2 109）保持可用。

---

## 2. 信息架构

### 2.1 入口

| 入口 | 位置 | 说明 |
|---|---|---|
| 开发入口（Phase 0） | `ActivityBar` 中的 Office 按钮，仅 `import.meta.env.DEV` 可见 → `#/office` | ✅ 已实现；正式入口待定 |
| 打开方式 | 工作台内"打开"按钮 + 最近文件 | ✅ 已实现；拖拽/系统"打开方式"后续 |
| 调试入口 | `#/pptx-spike` | 保留 |

### 2.2 路由

```
/office                 OfficeWorkspace（当前激活文档由 store 决定）
```

- 文档会话不占用笔记 `TabBar`；工作台内部使用独立 `OfficeTabStrip`。
- 后续若需要"一个文档一个窗口"，再拆 `WebviewWindow`。

---

## 3. 布局设计

### 3.1 总体布局

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ OfficeTopBar   ←返回 │ 文件.pptx · PPTX · 已保存 │ 撤销 重做 │ 保存 另存 │ 外部打开 │ AI │
├──────────────────────────────────────────────────────────────────────────────┤
│ OfficeTabStrip [季度汇报.pptx ×] [合同.docx ×] [+]                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ CommandBar     [插入▾][文本][形状][表格][排列▾][字号][加粗][对齐]…              │
├───────────────┬──────────────────────────────────────────────┬───────────────┤
│ 左面板 (240px) │ 主编辑区                                      │ 属性面板(280px)│
│               │                                              │               │
│ 幻灯片缩略图   │   画布 / 文档页 / 表格网格                     │ 位置·尺寸      │
│ 或 页面导航    │                                              │ 文本·填充      │
│ 或 工作表导航  │                                              │ 段落·单元格    │
├───────────────┴──────────────────────────────────────────────┴───────────────┤
│ OfficeStatusBar  第 3/12 页 · 缩放 80% · 已选中: 文本框 · 内存 120MB · 已保存   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 三格式变体

| 区域 | PPT | DOCX | XLSX |
|---|---|---|---|
| 左面板 | 幻灯片缩略图（可折叠） | 标题导航树 / 页面列表 | 无（或工作表导航） |
| 主区 | 单页画布（SVG + DOM 叠加层） | 连续分页文档（HTML 页流） | 虚拟网格（Canvas/DOM 混合） |
| 命令栏 | 插入/形状/表格/排列/文本样式 | 段落样式/字体/列表/对齐 | 名称框+公式栏+格式/插入/数据 |
| 右面板 | 位置尺寸/填充描边/文本 | 段落/字体/页面设置 | 单元格格式/数字格式 |
| 状态栏 | 页码 · 缩放 · 选中元素 | 页码 · 字数 · 缩放 | 单元格/区域 · 求和/平均 · 缩放 |

### 3.3 面板与缩放规则

- 左/右面板可折叠，宽度记入 `officeStore`（`localStorage`/SQLite 均可）。
- 画布缩放：`50% / 75% / 100% / 适应宽度 / 适应页面`；`Ctrl+滚轮` 连续缩放；`Ctrl+0` 适应页面。
- 主区背景使用画布底色，文档页/幻灯片带轻微阴影，避免与面板混淆。

---

## 4. 组件清单

| 组件 | 建议路径 | 职责 |
|---|---|---|
| `OfficeWorkspace` | `src/pages/office/index.tsx` | 组合布局、会话切换、错误边界 |
| `OfficeTopBar` | `src/components/office/OfficeTopBar.tsx` | 文件名/格式/保存状态、撤销重做、保存/另存、外部打开 |
| `OfficeTabStrip` | `src/components/office/OfficeTabStrip.tsx` | 多文档标签、脏标记、关闭拦截 |
| `OfficeCommandBar` | `src/components/office/OfficeCommandBar.tsx` | 按格式渲染命令组；命令注册表驱动 |
| `OfficeLeftPanel` | `src/components/office/OfficeLeftPanel.tsx` | 缩略图/导航树，虚拟滚动 |
| `SlideCanvasStage` | `src/components/office/SlideCanvasStage.tsx` | 复用 `EditorCanvas`，叠加标尺/参考线（后置） |
| `DocPageView` | `src/components/office/DocPageView.tsx` | DOCX 分页 HTML 渲染与编辑容器 |
| `SheetGridView` | `src/components/office/SheetGridView.tsx` | 虚拟网格、选区、行列头、sheet 标签 |
| `OfficePropertyPanel` | `src/components/office/OfficePropertyPanel.tsx` | 按格式/选中类型渲染字段 |
| `OfficeStatusBar` | `src/components/office/OfficeStatusBar.tsx` | 页码/缩放/选中/内存/保存状态 |
| `OfficeEmptyState` | `src/components/office/OfficeEmptyState.tsx` | 最近文件、拖拽提示、支持格式 |
| `SaveGuardDialog` | `src/components/office/SaveGuardDialog.tsx` | 关闭/切换前保存确认 |
| `OfficeErrorPanel` | `src/components/office/OfficeErrorPanel.tsx` | 解析/保存失败 + 外部打开逃生 |

复用现有：`ActivityBar`、`SidePanel`、`ConfigProvider` 主题、Ant Design `Button/Tooltip/Dropdown/Segmented`、lucide 图标。

---

## 5. 交互规范

### 5.1 通用

| 操作 | 行为 |
|---|---|
| 单击 | 选中对象/单元格/段落 |
| Shift+单击 | 加选（PPT 首期仅单选） |
| 双击 | 进入内联编辑（PPT 文本 / DOCX 段落 / XLSX 单元格） |
| 右键 | 上下文菜单（格式相关命令） |
| 空格 + 拖动 / 中键拖动 | 平移画布 |
| Ctrl + 滚轮 | 缩放 |
| Ctrl+S / Ctrl+Shift+S | 保存 / 另存为 |
| Ctrl+Z / Ctrl+Y（Ctrl+Shift+Z） | 撤销 / 重做 |
| Delete / Backspace | 删除选中（确认后） |
| Esc | 退出编辑 / 取消选择 |
| Ctrl+0 / Ctrl+1 | 适应页面 / 100% |

### 5.2 保存状态机

```
clean ──编辑──► dirty ──保存──► saving ──成功──► clean
  ▲               │                 └──失败──► error(可重试)
  └──加载完成──────┘
```

- 顶部显示"已保存 / 未保存 / 保存中 / 保存失败"。
- 关闭标签、切换文档、退出应用时若 `dirty`，弹 `SaveGuardDialog`。
- 首期**显式保存**，不做自动保存；后续可加"闲置 N 秒自动保存草稿"开关。

### 5.3 PPT

- 选中框 + 八向手柄；拖动实时轮廓预览，松手提交 `setTransform`（已实现）。
- Shift 等比缩放、Alt 中心缩放（后置）；吸附/对齐线（后置）。
- 双击文本进入 textarea；`Ctrl+Enter` 提交，`Esc` 取消。
- 缩略图右键：新建/复制/删除/上移/下移（走 op 层，可撤销）。
- 右侧属性面板：位置/尺寸/旋转、填充/描边、字号/字体/颜色/加粗斜体下划线/对齐。
- 旋转节点首期只支持拖动，不提供缩放柄。

| 快捷键 | 行为 |
|---|---|
| `Ctrl+M` | 在当前页后新建空白页 |
| `Ctrl+Shift+D` | 复制当前页 |
| `Alt+↑ / Alt+↓` | 上移 / 下移当前页 |
| `Tab / Shift+Tab` | 已有选中时在元素间循环 |
| `方向键 / Shift+方向键` | 微移选中元素 1px / 10px |

### 5.4 DOCX

- 连续分页视图；双击段落/标题/列表进入内联 textarea（`cancelledRef` 防误提交）。
- 提交：失焦或 `Ctrl+Enter`；取消：`Esc`。
- 编辑范围：段落/标题/列表文字；表格与图片只读。
- 左侧标题导航点击滚动定位；`Ctrl+Z / Ctrl+Y` 撤销重做（字节快照）。
- 提交粒度：失焦或 `Ctrl+Enter` 提交一次 `setText`，避免每次按键产生 op。

### 5.5 XLSX

- 当前实现：工作表选择 + 单元格地址 + 值 →「写入单元格」，即时写回原文件。
- 预览窗口为前 40 行；全局预览截断时给出提示。
- 只读挂载禁用写入；公式只显示缓存值，不参与计算。
- 后续：区域选择、行列头操作、完整网格虚拟化、公式求值。

### 5.6 PDF

- 按需分页渲染（滚到哪渲染到哪），缩放/翻页；只读。

### 5.7 导出

- PPTX：命令栏「导出 PNG（2x 白底）/ 导出 SVG」，导出当前页。
- 后续：PDF 导出、批量导出、导出字体嵌入检查。

---

## 6. 属性面板字段

| 格式 | 字段 |
|---|---|
| PPT | X/Y/W/H（px + EMU 只读提示）、旋转、填充色、描边色/宽度、透明度、字体/字号/颜色/加粗/斜体/下划线、对齐、段间距 |
| DOCX | 字体/字号/颜色/加粗/斜体/下划线/删除线、对齐、行距、段前段后、首行缩进、列表级别 |
| XLSX | 数字格式、字体、字号、颜色、加粗/斜体、水平/垂直对齐、边框、填充、合并（后置） |

面板字段未实现时置灰并给出 tooltip 说明原因，不静默隐藏。

---

## 7. 视觉规范

- 颜色、圆角、字体沿用 `src/styles/themes.css` 与 Ant Design token，不新增独立色板。
- 画布底色使用主题 `colorBgLayout`；页面/幻灯片使用 `colorBgContainer` + 1px 边框 + 轻阴影。
- 选中色 `#1677ff`；辅助线 `#ff4d4f`（后置）；吸附高亮使用 1px 虚线。
- 控件高度：命令栏 32px、属性面板行 28px；间距使用 4/8 的倍数。
- 深色模式跟随全局主题；画布内容保持白底（文档自身颜色），仅外框随主题。

---

## 8. 状态与数据流

```
React UI ──RPC(postMessage)──► Office Worker
   ▲                                │
   │ onScene / onHistory            ├─ 文档模型（常驻）
   │                                ├─ 渲染（单页/单视口增量）
   │                                ├─ op 执行（pptx-ops）
   │                                └─ 撤销/重做（快照栈）
   │
   └── Rust（Tauri Command）：文件读写、原子保存、字体度量、PDF 渲染/导出
```

- `officeStore`（Zustand）：`sessions`、`activeId`、`recentFiles`、`panelLayout`、`zoom`。
- 每个会话一个 `useOfficeSession`：加载状态、场景、选区、脏标记、撤销状态。
- 模型只存在于 Worker；UI 只持有渲染产物与节点元数据。
- Worker 崩溃：提示并允许"从磁盘重新加载"；脏数据不自动覆盖。

---

## 9. 异常与边界状态

| 场景 | 处理 |
|---|---|
| 解析失败/损坏 | `OfficeErrorPanel` + 原始错误 + 外部打开 |
| 加密文档 | 明确提示不支持，外部打开 |
| 超大文件（>80MB） | 打开前警告，限制预览页数/行数 |
| 内存超限 | 停止渲染并提示，保留已加载页 |
| 外部修改（哈希变化） | 保存前提示"文件已被外部修改"，可选覆盖/另存 |
| 保存失败 | 保留 dirty 状态，可重试/另存 |
| 不支持的能力 | 按钮置灰 + tooltip，不静默忽略 |

---

## 10. 键盘与可访问性

- 所有命令可通过键盘触发；焦点环可见；图标按钮带 `aria-label`。
- 属性面板字段使用 Ant Design `InputNumber/Select/ColorPicker`，支持 Tab 导航。
- 文案首期中文硬编码，统一收敛到 `src/lib/office/i18n.ts` 常量，便于后续接 i18n。

---

## 11. 开发计划

> 按依赖顺序推进；每阶段结束必须通过 `tsc` / `vitest` / `vite build`。

### Phase 0：工作台骨架（优先）

> 状态：✅ 已实现（2026-11-17）

| 项 | 内容 |
|---|---|
| 范围 | `/office` 路由、`OfficeWorkspace` 布局、`OfficeTopBar`、`OfficeTabStrip`、打开/另存/关闭拦截、最近文件 |
| 复用 | 现有 `pptx-spike` 会话与 Worker RPC |
| 验收 | 打开页 → 编辑 → 保存 → 关闭拦截 → 最近文件可再次打开 |
| 风险 | 与笔记 `TabBar` 的交互边界 |

### Phase 1：PPT 编辑正式化

> 状态：✅ 已实现（2026-11-17）

| 项 | 内容 |
|---|---|
| 范围 | 缩略图增删/复制/排序、缩放/平移、键盘快捷键、PPT 命令栏、状态栏 |
| 依赖 | `pptx-ops` 的 slide/arrange 操作 |
| 验收 | 无鼠标可完成"选中→移动→撤销→保存" |
| 风险 | 大页数缩略图渲染耗时 |

### Phase 2：属性面板

> 状态：✅ 已实现（2026-11-18）

| 项 | 内容 |
|---|---|
| 范围 | 位置/尺寸/旋转、填充/描边、文本字体与对齐；批量选择后置 |
| 依赖 | `setTransform` / `setFont` / `setFill` / `setStroke` |
| 验收 | 面板修改即时反映到画布，可撤销 |
| 风险 | 主题色/继承色的显示与回写 |

### Phase 3：DOCX 编辑

> 状态：✅ 已实现段落级编辑（表格/图片仍只读，2026-11-18）

| 项 | 内容 |
|---|---|
| 范围 | 分页预览完善、段落/标题/列表编辑、标题导航、页面缩放 |
| 依赖 | `docx-engine` parse/save、字体度量 |
| 验收 | 编辑段落/标题后保存，在 Word 中打开无修复提示 |
| 风险 | 分页与 Word 存在估算差异；DOM↔run 映射复杂度 |

### Phase 4：XLSX 编辑

> 状态：✅ 已实现单元格值编辑（前 40 行预览窗口）；公式求值与完整网格仍待后续

| 项 | 内容 |
|---|---|
| 范围 | vendor `xlsx-gateway`、虚拟网格、单元格值/样式编辑、工作表切换 |
| 依赖 | `xlsx-gateway`、Rust 侧保存 |
| 验收 | 万行表滚动流畅；编辑单元格保存后 Excel 可打开 |
| 风险 | 公式求值范围与性能 |

### Phase 5：导出与 AI

> 状态：部分完成（当前页 PNG/SVG 导出 ✅；PDF 导出与 AI diff 待后续）

| 项 | 内容 |
|---|---|
| 范围 | 导出 PDF/PNG/SVG、AI 修改以 diff + 回滚呈现、编辑历史面板 |
| 依赖 | 现有渲染树、`edit_ops`、AI Command |
| 验收 | 导出与画布一致；AI 修改可逐条接受/拒绝 |
| 风险 | 导出字体嵌入与跨平台一致性 |

### Phase 6：硬化

> 状态：部分完成（大文件提示、撤销上限 ✅；Win7 实机与大文件压测待环境）

| 项 | 内容 |
|---|---|
| 范围 | 大文件压测、内存上限与流式读取、Win7 实机、上游季度同步回归 |
| 验收 | Win7 lite 包可打开 50–100MB 文档；崩溃可恢复 |

---

## 12. 任务拆解（可执行清单）

### 12.1 前端

- [ ] `src/pages/office/index.tsx`：工作台壳与路由
- [ ] `src/store/office.ts`：会话、最近文件、面板布局
- [ ] `src/components/office/OfficeTopBar.tsx`
- [ ] `src/components/office/OfficeTabStrip.tsx`
- [ ] `src/components/office/OfficeCommandBar.tsx`（命令注册表）
- [ ] `src/components/office/OfficeLeftPanel.tsx`（缩略图/导航）
- [ ] `src/components/office/OfficePropertyPanel.tsx`
- [ ] `src/components/office/OfficeStatusBar.tsx`
- [ ] `src/components/office/SaveGuardDialog.tsx`
- [ ] `src/components/office/OfficeErrorPanel.tsx`
- [ ] `src/lib/office/commands.ts`：命令定义（id/标题/快捷键/可用性/执行）
- [ ] `src/lib/office/i18n.ts`：文案常量
- [ ] 复用 `EditorCanvas`、`usePptxEditor`，按需抽出 `useOfficeSession`

### 12.2 Worker / 模型

- [ ] 扩展 RPC：`insert-slide` / `duplicate-slide` / `delete-slide` / `move-slide`
- [ ] DOCX 会话：`docx-get-page` / `docx-apply-edit`
- [ ] XLSX 会话：`sheet-open` / `sheet-get-range` / `sheet-set-cell`
- [ ] 统一 `canUndo/canRedo` 与 `dirty` 回报

### 12.3 Rust

- [ ] 按格式的原子保存（已存在，补齐 xlsx/docx 路径校验）
- [ ] 导出 PDF/PNG 的 Command（复用 pdfium）
- [ ] 最近文件落库（SQLite）与清理策略

### 12.4 路由与权限

- [ ] `Router.tsx` 增加 `/office`
- [ ] `ActivityBar` 增加 Office 项
- [ ] `SidePanel` 增加 `office` 视图
- [ ] `capabilities`：仅使用已声明的 dialog/fs/opener，不新增高危权限

---

## 13. 测试与验收

| 层级 | 内容 |
|---|---|
| 单元 | 几何/命中/op 构建/命令可用性；Vitest |
| 组件 | 工具栏渲染、属性面板提交、保存状态机；Vitest + Testing Library |
| 集成 | 打开→编辑→撤销→重做→保存→重开；真实样例文件 |
| 保真 | 打开后不做修改保存，要求字节级一致（除元数据） |
| 兼容 | Word/PowerPoint/Excel 打开保存结果无修复提示 |
| 平台 | Windows 10/11 + Win7 lite 冒烟 |

---

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Worker 内存膨胀 | 单页/单视口渲染、快照条数上限、80MB 警告 |
| 上游升级破坏 | vendor commit 锁定 + 回归脚本 |
| 字体度量偏差 | Rust `ttf-parser` 实测 + 未命中回退 |
| contenteditable 映射 | 只作为输入层，所有变更走 op；先做段落级 |
| 公式范围失控 | 明确"只显示缓存值"边界，求值单独立项 |
| UI 与笔记壳冲突 | 独立 `OfficeTabStrip`，不动现有笔记 `TabBar` |

---

## 15. 已确认决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | Office 入口 | ✅ 先仅开发模式（ActivityBar 的 DEV 按钮）；正式化时再并入 `ActiveView` |
| 2 | 文档标签 | ✅ 工作台内 `OfficeTabStrip`，不动笔记 `TabBar` |
| 3 | 独立窗口 | ⏳ Phase 0 不拆窗口，后续按需 |
| 4 | XLSX 公式 | ✅ 首期只显示缓存值（当前 XLSX 为只读预览） |
| 5 | 自动保存 | ✅ 仅显式保存（`Ctrl+S`/按钮），关闭前拦截 |

---

## 16. Phase 0 实施记录（2026-11-17）

| 模块 | 文件 | 说明 |
|---|---|---|
| 路由 | `src/Router.tsx` | 新增 `#/office`（懒加载） |
| 入口 | `src/components/layout/ActivityBar.tsx` | DEV 模式显示 Office 按钮 |
| 状态 | `src/store/office.ts` | 会话元数据、最近文件（localStorage，去重/置顶/12 条上限） |
| 格式 | `src/lib/office/formats.ts` | 格式识别、对话框过滤器、路径工具 |
| 页面 | `src/pages/office/index.tsx` | 多会话运行时、打开/保存/另存/关闭拦截、快捷键 |
| 组件 | `src/components/office/*` | TopBar / TabStrip / EmptyState / StatusBar / SaveGuardDialog |
| 编辑器接入 | `src/lib/office/editor/usePptxEditor.ts` | 新增 `onApplied`，用于 dirty 标记 |

**行为**

- PPTX：画布编辑（选中/拖动/缩放/双击文本/撤销重做）+ 缩略图 + 缩放。
- DOCX / XLSX / PDF：只读预览；文件操作与标签管理可用。
- 保存：`Ctrl+S` 覆盖原文件，`Ctrl+Shift+S` 另存为；`Ctrl+W` 关闭标签（脏文档三选一确认）。
- 最近文件：打开成功后写入，可在空状态中再次打开或移除。

**验证**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npx vitest run` | ✅ 57 文件 / 601 用例 |
| `npx vite build` | ✅ |
| 真机打开/编辑/保存 | ⏳ 待人工验证 |

**已知限制（Phase 0）**

1. 应用退出/路由离开未做未保存拦截，仅拦截标签关闭。
2. DOCX/XLSX/PDF 只读；XLSX 无单元格编辑入口。
3. 无属性面板、无多选/框选（Phase 1–2）。
4. 多标签各自常驻一个 Worker，内存随打开数量增长；后续按需做空闲回收。

### Phase 1 实施记录（2026-11-17）

| 模块 | 文件 | 说明 |
|---|---|---|
| 协议 | `src/lib/office/editor/protocol.ts` | 新增 `slide-op` 与 `PptxSlideAction`；场景结果可携带全部缩略图 |
| Worker | `src/workers/pptx.worker.ts` | `addBlankSlide` / `duplicateSlide` / `deleteSlide` / `moveSlide`；结构操作使用整簿快照撤销（含 archive 条目） |
| 客户端 | `src/lib/office/pptxWorkerClient.ts` | `slideOp()` |
| Hook | `src/lib/office/editor/usePptxEditor.ts` | `insertSlide` / `duplicateSlide` / `deleteSlide` / `moveSlide`，新增 `onDeck` |
| 命令栏 | `src/components/office/OfficePptxCommandBar.tsx` | 新建/复制/删除/上移/下移 + 快捷键提示 |
| 交互 | `src/pages/office/index.tsx` | 结构操作接入、缩略图刷新、Tab 循环、方向键微移、结构快捷键 |
| 纯函数 | `src/lib/office/editor/slideActions.ts` | 移动/删除后的下标计算（含单测） |

**验收路径（无鼠标）**：Tab 选中元素 → 方向键移动 → `Ctrl+Z` 撤销 → `Ctrl+S` 保存；`Ctrl+M` 新建页后用 `Alt+↑` 排序。

**注意**：结构操作为保证 `presentation.xml` 与媒体条目一致，撤销快照包含整个 `archive.entries`（浅拷贝），因此单次结构操作的内存开销高于元素编辑；后续可按"反向 op"优化。

### Phase 2 实施记录（2026-11-18）

| 模块 | 文件 | 说明 |
|---|---|---|
| 样式提取 | `src/lib/office/editor/nodeStyle.ts` | 从 RenderTree 读取填充/描边/字体/对齐；`pxToPt` 处理 viewport scale |
| 协议 | `src/lib/office/editor/protocol.ts` | 新增 `fill` / `stroke` / `font` / `align` 编辑动作 |
| Worker | `src/workers/pptx.worker.ts` | 映射到 `setFill` / `setStroke` / `setFont` / `setParagraphFormat` |
| Hook | `src/lib/office/editor/usePptxEditor.ts` | `commitStyle` / `commitRotation` |
| 面板 | `src/components/office/OfficePropertyPanel.tsx` | 位置尺寸、旋转、填充、描边、字号/字体/颜色/B-I-U/对齐 |
| 页面 | `src/pages/office/index.tsx` | 右侧属性面板、选中节点样式同步、只读会话禁用编辑 |

**提交策略**：数字输入在失焦/回车时提交；颜色使用 `onChangeComplete`；B/I/U 与对齐即时提交。每次提交生成一条可撤销 op。

**已知限制**

1. 样式面板一次只作用于单个元素（多选待做）。
2. 渐变/图片/图案填充仅显示类型，替换为纯色会覆盖原效果（面板已有提示）。
3. 字体列表为常用字体；写入的是字体名称，渲染依赖本机字体度量。
4. 图片暂不支持裁剪/替换，仅描边与位置尺寸。

### Phase 3 实施记录（2026-11-18）

| 模块 | 文件 | 说明 |
|---|---|---|
| 块索引 | `src/lib/office/docxEngine.ts` | 段落/标题/列表输出 `data-block-index`，使用 `parsed.blocks` 原下标（含隐藏块） |
| 内联编辑 | `src/components/office/DocxPageView.tsx` | 双击块 → 固定定位 textarea；Ctrl+Enter 提交 / Esc 取消 / 失焦提交 |
| Worker | `src/workers/pptx.worker.ts` | DOCX 撤销/重做（字节快照，上限 30）；结果携带 `canUndo/canRedo` |
| 客户端 | `src/lib/office/pptxWorkerClient.ts` | `undoDocx` / `redoDocx` |
| 页面 | `src/pages/office/index.tsx` | 标题导航、段落提交、DOCX 撤销/重做与快捷键 |

**范围**：段落/标题/列表文字可编辑并写回；表格、图片、页眉页脚内容仍只读；分页仍为估算。

### Phase 4 实施记录（2026-11-18）

| 模块 | 文件 | 说明 |
|---|---|---|
| 编辑栏 | `src/pages/office/index.tsx` | 工作表选择、单元格地址、值、写入按钮 |
| 写回 | `pptxSpikeApi.xlsxSetCell`（Rust umya-spreadsheet） | 修改即时写回原文件；写后刷新预览 |
| 预览范围 | `src-tauri/src/services/excel_parser.rs` | 新增 `ReadMode::Preview`：每表最多 500 行，不拼 markdown；`office_preview` 使用该模式 |
| 表头 | `src/lib/office/sheets.ts` | Excel 列字母 A/B/C、表头行作为第 1 行、行号连续 |
| 撤销/重做 | `src/pages/office/index.tsx` | 写前/写后读取 xlsx 字节，字节快照栈（上限 20）；顶栏与 `Ctrl+Z/Y` 可用 |
| 布局 | 页面 | 工作表标签移到底部；紧凑单元格样式（12px、1px 内边距） |
| 保护 | 页面 | 只读挂载禁用写入 |

**未完成**：完整网格虚拟化、公式求值、行列操作、样式编辑、`xlsx-gateway` 接入。

### Phase 5 实施记录（2026-11-18）

| 模块 | 说明 |
|---|---|
| 导出 | PPTX 当前页导出 SVG / PNG（2x，白底） |
| 入口 | PPT 命令栏「导出 PNG / 导出 SVG」 |

**未完成**：PDF 导出、批量导出、AI 修改 diff 与逐条回滚。

### Phase 6 实施记录（2026-11-18）

- 打开大文件（>80MB）时给出内存警告。
- PPTX 撤销上限 30；DOCX 撤销上限 30（字节快照）；XLSX 字节快照撤销上限 20。
- 结构操作整簿快照的内存开销已在 Phase 1 注明。
- **外部修改检测**：打开/保存时记录文件 SHA-256；保存（PPT/DOCX）与 XLSX 写入前重新哈希，发现外部修改时弹出“覆盖/取消”确认。
- **会话恢复**：标签与当前文档路径写入 `office.session.v1`；空状态提供“恢复上次会话”，按序重新打开（不保留未保存修改）；关闭全部标签时清除快照。

**未完成**：Win7 实机、50–100MB 文档压测、Worker 空闲回收、应用退出时的未保存拦截。

---

## 相关文档

- [Office 引擎路线](./office-engine-roadmap.md)
- [PPT 扩展包](./ppt-extension.md)
- [Win7 兼容架构](./win7-architecture.md)
