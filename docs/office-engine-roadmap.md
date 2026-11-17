# Office 文档引擎：方案、进度与未来计划

> 状态：P0/P1 已实施；P2 轻量交互层 MVP 已落地（选中/拖动/缩放/内联文本/撤销，见 §14）
> 更新：2026-11-17
> 上游：GenOffice commit `19a389b3`（vendored，Apache-2.0）

---

## 1. 目标与边界

### 目标

在 W-Pomegranate 内提供 **本地 Office 文档工作台**：

- 打开并预览 `.pptx` / `.docx` / `.xlsx` / `.pdf`
- 对常用内容做**最小编辑**并保存回真实格式
- 与现有 AI、笔记、编辑历史、主题体系整合
- 保持 Win7 兼容（WebView2 109）

### 非目标

- 不做完整 Office 替代品（宏、动画时间轴、复杂 SmartArt、邮件合并）
- 不强制格式转换：打开什么保存什么
- 不在 Win7 上引入 Node/Electron 运行时

---

## 2. 技术路线决策（ADR 摘要）

| 方案 | 说明 | 编辑深度 | UI 整合 | Win7 | 结论 |
|---|---|---|---|---|---|
| **A. WebView 内嵌 TS 引擎** | pptx/docx 引擎在 Web Worker；Rust 负责文件、PDF、XLSX | 低–中（自建编辑 UI） | **最高** | ✅ | **当前采用** |
| B1. Node 引擎 sidecar | 只跑引擎/CLI，UI 仍用本项目 React | 高 | 中 | ❌ | Win10+ 可选"完整编辑包" |
| B2. genoffice 整应用 | Electron UI 作为伴生/嵌入 | 高 | 低 | ❌ | 不推荐 |
| D. 外挂官方应用 | "用 genoffice 打开" | 高 | 最低 | ❌ | 仅作逃生入口 |
| F. Electron 22 sidecar | 为 Win7 降级 Node 16 跑引擎 | 中高 | 低 | ⚠️ | 不推荐 |

### 决策

1. **短期保持 A**：瓶颈是编辑器 UI（选中/拖动/撤销），不是引擎。
2. **中期若"完整保真编辑"成为战略**：在 Win10+ 增加 B1 作为可选组件包。
3. **D 只作为外部打开入口**，不作为产品内编辑方案。
4. **F 放弃**：包体、兼容、上游错位三重风险。

---

## 3. 架构

```
React 页面 /pptx-spike（后续正式化为 Office 工作台）
  ├── Web Worker：pptx-engine / docx-engine / RenderTree
  │     ├── polyfill: Buffer / node:crypto / node:zlib
  │     └── 解析、渲染、文本编辑、保存
  └── Rust Commands
        ├── 文件字节读写（原始 ArrayBuffer + 原子保存）
        ├── PDF：pdfium → 前 N 页 PNG
        ├── XLSX：calamine 预览 + umya-spreadsheet 单元格编辑
        ├── 字体度量：font-enumeration + ttf-parser
        └── edit_ops：操作日志（SQLite）
```

### 关键分层

| 层 | 位置 | 职责 |
|---|---|---|
| UI | `src/pages/pptx-spike/` | 打开、预览、编辑表单、历史 |
| 引擎适配 | `src/lib/office/` | 打开/渲染/编辑/保存 |
| Worker | `src/workers/pptx.worker.ts` | 解析与保存移出 UI 线程 |
| 文件/预览 | `src-tauri/src/services/pptx_spike.rs`、`office_preview.rs` | 字节读写、PDF/XLSX |
| 字体度量 | `src-tauri/src/services/font_metrics.rs` | 行高与字宽比例 |
| 操作日志 | `database/edit_ops.rs` + `services/edit_log.rs` | 审计与历史 |

---

## 4. 已实现功能

### 4.1 格式矩阵

| 格式 | 预览 | 编辑 | 保存 |
|---|---|---|---|
| PPTX | 文本/图片/表格/图表/分组 | 文本框文字 | 原生 PPTX |
| DOCX | 分页/页眉页脚/页码/表格/图片 | 段落/标题/列表文字 | 原 DOCX |
| XLSX | 工作表 + 前 40 行 | 单元格值 | 原 XLSX |
| PDF | 前 3 页 PNG | 只读 | — |

### 4.2 基础设施

- Schema **v85**：`edit_ops` 表（domain / target / source / op_json / created_at）
- 编辑历史 UI：查看、清空
- 性能指标：解析耗时、JS 堆占用、80MB 警告、256MB 上限
- 字体度量：常用 10 个字体族，未命中回退
- vendor 同步：`pnpm vendor:genoffice --check|--source`

### 4.3 界面入口

- 开发模式：PPT 生成页右上角 **打开 Office 文档（实验）**
- 路由：`#/pptx-spike`
- 正式化时移除"实验"标记并接入 ActivityBar

---

## 5. 代码索引

| 文件 | 作用 |
|---|---|
| `src/vendor/genoffice/` | vendored 引擎（pptx/docx/zip-gate/render） |
| `src/lib/office/pptxEngine.ts` | PPTX 打开/渲染/文本编辑/保存 |
| `src/lib/office/docxEngine.ts` | DOCX 解析/HTML/分页/文本编辑 |
| `src/lib/office/renderSlideSvg.ts` | RenderTree → SVG（含表格/图表） |
| `src/lib/office/pptxWorkerClient.ts` | Worker RPC 客户端（requestId/并发/超时） |
| `src/workers/pptx.worker.ts` | PPTX/DOCX Worker（常驻模型 + 单页增量渲染） |
| `src/lib/office/editor/protocol.ts` | Worker RPC 协议与场景类型 |
| `src/lib/office/editor/geometry.ts` | 命中测试与几何计算（含旋转） |
| `src/lib/office/editor/EditorCanvas.tsx` | 画布交互层（选中/拖动/缩放/内联文本） |
| `src/lib/office/editor/usePptxEditor.ts` | 编辑会话 Hook（场景/撤销/提交） |
| `src/vendor/genoffice/pptx-ops/` | vendored 操作层（op 校验 + 事务） |
| `src/lib/api/pptxSpike.ts` | Rust 文档读写/预览 API |
| `src/lib/api/editLog.ts` | 编辑日志 API |
| `src/lib/api/fontMetrics.ts` | 字体度量 API |
| `src-tauri/src/services/pptx_spike.rs` | 路径校验/原子保存 |
| `src-tauri/src/services/office_preview.rs` | PDF/XLSX 预览与单元格编辑 |
| `src-tauri/src/services/font_metrics.rs` | 字体度量 |
| `src-tauri/src/database/edit_ops.rs` | 操作日志 DAO |
| `scripts/sync-genoffice-vendor.mjs` | 上游同步脚本 |

---

## 6. 验证状态

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npx vitest run` | ✅ 51 文件 / 555 用例 |
| `cargo check` | ✅ |
| `cargo check --features win7-compat` | ✅ |
| `cargo test database::edit_ops` | ✅ |
| `cargo test services::font_metrics` | ✅ |
| `npx vite build` | ✅ |

---

## 7. 任务进度

| # | 任务 | 状态 |
|---|---|---|
| 5 | PPTX 表格/图表渲染 | ✅ |
| 6 | DOCX 页眉页脚/分页 | ✅ |
| 7 | vendor 同步流程 | ✅ |
| 8 | 性能保护与耗时 | ✅ |
| 9 | PPTX 最小编辑 | ✅ |
| 10 | 多格式预览 | ✅ |
| 11 | 编辑日志 | ✅ |
| 12 | DOCX 自动分页 | ✅ |
| 14 | DOCX/XLSX 编辑 | ✅ |
| 15 | DOCX 字体度量 | ✅ |
| 16 | 编辑器底座：Worker RPC / 单页增量渲染 / 延迟保存 / 撤销栈 | ✅ |
| 17 | 画布交互层：选中 / 拖动 / 缩放 / 双击内联文本 | ✅ |
| 13 | Win7 实机与大文件实测 | ⏳ 环境依赖 |

---

## 8. 已知限制

1. **编辑器 UI 为轻量交互层**：支持单选、拖动、缩放、双击内联文本；暂无多选、吸附、属性面板、组内子元素编辑、旋转节点缩放。
2. **DOCX**：不支持表格、图片、页眉页脚内容编辑；分页为估算。
3. **XLSX**：仅单元格值；公式编辑、行列操作未开放。
4. **PPTX**：内联文本按段落替换，保留原段落属性与主 run 格式；暂不支持富文本分片编辑。
5. **PDF**：只读，仅前 3 页。
6. **大文件**：WebView 内 100MB+ 仍需实测；当前仅提示与上限。

> 上述限制的成因、优先级与可选技术路线见 §12–§14。

---

## 9. 未来计划

### P1：正式化工作台（优先）

- 从 `/pptx-spike` 升级为正式 Office 入口
- 多标签、最近文件、拖拽打开
- 统一编辑历史与撤销栈
- 加入 `edit_ops` 回放（撤销单条操作）

### P2：编辑器交互层（MVP 已完成）

- ✅ RenderTree 命中测试 + 选中框
- ✅ 双击内联编辑
- ✅ 拖动/缩放 → 引擎 transform patch
- ⏳ 属性面板（字体/颜色/对齐）
- ⏳ AI 修改以 diff + 回滚呈现

### P3：可选"完整编辑包"（Win10+）

- B1 Node sidecar，仅跑引擎/CLI
- 复用本项目 React UI，不引入 Electron 界面
- Win7 保持当前 A 方案

### P4：质量与性能

- Win7 lite 包 + 50–100MB 文件实测
- 内存上限与流式读取策略
- 上游 vendor 季度同步与回归

---

## 10. 原则与风险

| 原则 | 说明 |
|---|---|
| 本地优先 | 文件不离开本机；仅 AI 调用联网 |
| 显式保存 | 不静默覆盖；保存前可另存 |
| 可回滚 | 所有编辑进入 `edit_ops`，支持撤销全部 |
| 不半吊子保真 | 不支持的能力明确提示，不静默丢弃 |
| Win7 不妥协 | 不引入 Node/Electron 运行时到主包 |

| 风险 | 缓解 |
|---|---|
| 大文件内存 | 80MB 警告、256MB 上限、Worker 隔离 |
| 引擎升级破坏 | vendor 锁定 commit + 回归测试 |
| 字体缺失 | 度量回退 + 命中数提示 |
| 编辑冲突 | 打开时哈希、保存前可对比 |
| 多会话开发 | 遵循 CLAUDE.md 多会话避让协议 |

---

## 11. 上游升级流程

```bash
# 检查
node scripts/sync-genoffice-vendor.mjs --source D:/AI/ALL-PPT/genoffice --check

# 同步（自动重新应用本地 @ts-nocheck 补丁）
pnpm vendor:genoffice -- --source D:/AI/ALL-PPT/genoffice

# 回归
npx tsc --noEmit
npx vitest run src/lib/office
npx vite build
```

升级前检查上游 `pptx-engine` / `docx-engine` 的公共导出变化；本项目只依赖
`openPptx/savePptx`、`parseDocx/saveDocx`、`buildRenderSlide` 等入口。

---

## 12. 增强编辑器的阻碍分析（2026-11-17 复核）

> **结论：瓶颈不在引擎，而在适配层与交互层。**
> "能编辑什么"引擎已经解决；"怎么编辑、怎么交互"尚未落地。

### 12.1 已具备的基础（避免重复造轮子）

| 基础 | 位置 | 说明 |
|---|---|---|
| 编辑就绪的渲染树 | `src/vendor/genoffice/pptx-render/render-tree.ts` | 节点自带 `id / sourceId / durableId / box / decoration`，注释明确用于"edit layer locate write-backs" |
| 引擎写回 API | `src/vendor/genoffice/pptx-engine/` | `setElementFont` / `setElementParagraphFormat` / `setElementFill` / `setElementStroke` / `setTableColWidth` / `setTableRowHeight` / `insertBlankSlide` / `deleteSlide` / 分组子元素编辑等 |
| 上游操作层 | 上游 `packages/pptx-ops/`（约 5.3k 行） | Apache-2.0、**零 Electron 依赖**、仅依赖已 vendor 的 pptx-engine/docx-engine；提供 `setTransform` / 富文本 / 表格 / 插入 / 排列 / 动画等 op 注册表，plan-time 校验、事务回滚、before/after 记录 |

即：当前 vendored 范围只取了"引擎"，没有取"操作层"。

### 12.2 主要阻碍（按影响排序）

| # | 阻碍 | 代码证据 | 后果 |
|---|---|---|---|
| 1 | **交互层空白**：只能列表选文本块，无画布选中/拖动/缩放/内联编辑 | `src/lib/office/pptxEngine.ts` 仅暴露 list/update；`src/lib/office/renderSlideSvg.ts` 输出纯 SVG 字符串，丢弃节点 `sourceId/box` | 无法命中测试，P2 无从开始 |
| 2 | **Worker 协议不是可交互协议**：单监听、裸 `postMessage`、无 requestId/并发/取消 | `src/lib/office/pptxWorkerClient.ts` | 拖动需 60Hz 往返，现有通道一次只能有一个在途请求 |
| 3 | **渲染/保存粒度过粗**：打开渲染全部页；每次编辑全量 `savePptx`；DOCX 每次"保存→整篇重解析→重排" | `src/workers/pptx.worker.ts`（open / update-text / docx-update-text） | 50+ 页或大文件下每次编辑数百 ms 至数秒 |
| 4 | **撤销语义缺失**：`edit_ops` 只有审计日志，无 before/after，无法回滚 | `src-tauri/src/database/edit_ops.rs`、`src-tauri/src/services/edit_log.rs` | 单步撤销、AI diff 回滚均无法落地 |
| 5 | **文本编辑模型过浅**：PPTX 整段替换只保留首个 run 格式；DOCX 为块级替换 | `src/lib/office/pptxEngine.ts` `updatePptxText`、`src/lib/office/docxEngine.ts` `saveDocxWithEdits` | 富文本分片、段落格式、表格/图片/页眉编辑缺失 |
| 6 | **格式深度不均**：XLSX 只读前 40 行单元格值（无公式/格式）；PDF 前 3 页、无文本层；DOCX 分页为估算 | §4.1 格式矩阵 | XLSX/PDF 的能力与用户预期差距最大 |
| 7 | **Win7 内存账**：WebView2 109、ES2020、256MB 上限 | `vite.config.ts` build target、`src-tauri/src/services/pptx_spike.rs` | 若照搬"50 步全量快照撤销"，`structuredClone` 会成倍放大内存 |

---

## 13. 技术选型对比

| 方案 | 能力上限 | 工作量 | 主要风险 | 结论 |
|---|---|---|---|---|
| **A1. 自建轻量交互层（SVG/DOM overlay）+ vendor `pptx-ops`** | 中高：选中/拖动/缩放/内联文本/属性面板/撤销 | 中（约 2–4k 行） | 需自写命中测试与手柄 | **推荐主线** |
| A2. 移植上游 Konva 编辑器（`SlideCanvas` / `NodeBody` / `konva-adapter` / `TextEditOverlay`） | 高，接近上游保真 | 大（约 25k 行；`App.tsx` 4860 行，且耦合 `slidesApi` IPC、Electron 主进程历史/字体/导出） | 长期双轨维护、上游同步成本高 | 不整包移植；按模块提取（`snap.ts`、`drag-axis-lock.ts`、`table-hit.ts`、`adjust-handles.ts` 较干净） |
| B1. Node sidecar（仅 Win10+） | 高，可直接复用上游引擎/CLI | 中大 | 双轨维护、包体；Win7 不覆盖 | 保留为"完整编辑包"，未到触发条件 |
| D. 外挂 genoffice 打开 | 高 | 极小 | 体验割裂 | 仅作逃生入口 |
| XLSX：vendor 上游 `xlsx-gateway`（jszip+numfmt，无 Univer，Apache-2.0） | 中：OOXML 补丁、CSV、图表/透视 | 中 | 公式求值能力需实测 | 优先于 calamine 只读路径 |
| XLSX：Univer / Luckysheet 类表格内核 | 高（类 Excel 交互） | 大 | 包体、许可证、Win7 性能 | 仅当"真表格编辑"成为战略再做 |
| DOCX：继续块级 + 提取 `docx-engine/text-patch` | 中 | 中 | 版式保真有限 | 中长期路线 |
| DOCX：ONLYOFFICE / Collabora | 极高 | 不可行 | 重运行时，违反"Win7 不妥协/本地优先/包体" | 不采纳 |

> 许可：上述上游包均为 Apache-2.0，vendoring 时需保留 `NOTICE`。

---

## 14. 决策记录（提议中，ADR 摘要）

### 状态

已采纳（A1 主体已实施，2026-11-17）；XLSX 深度边界仍待定。

### ADR-001：增强编辑器走 A1（自建交互层 + 操作层下沉）

- **背景**：引擎与操作层已具备，缺交互层与数据通道；Win7 与包体约束排除 B1/D 作为主路径。
- **决策**：
  1. `pptx-ops` 纳入 vendor 同步范围（`scripts/sync-genoffice-vendor.mjs`），作为编辑事务与撤销语义的唯一实现。
  2. Worker 协议升级为 RPC（`requestId + pending Map + cancel`）；模型常驻 Worker；编辑后只重渲染当前页；`savePptx` 仅在显式保存时执行。
  3. `RenderSlide`（含 `sourceId/box`）送主线程做命中测试；SVG 渲染器补 `data-source-id`；拖动仅做本地 transform 预览，松手提交 `setTransform` op；双击进入 `contenteditable` overlay 提交文本/字体 op。
  4. 撤销 = op 记录 + 受限快照（或反向 op 回放）；`edit_ops` 继续承担审计，两者不混用。
- **影响**：
  - 前端：新增交互层模块（`src/lib/office/editor/`），页面从"列表编辑"升级为画布编辑。
  - Worker：协议与生命周期改造，需补并发/取消测试。
  - Rust：仅增加保存节流与（可选）审计落库，不引入新依赖。
  - 同步脚本：vendor 范围从"纯引擎"扩展到"引擎 + 操作层"。

### 实施记录（2026-11-17）

| 项 | 落地位置 |
|---|---|
| 操作层 vendoring | `src/vendor/genoffice/pptx-ops/`；同步脚本已扩展到 `packages/pptx-ops/src`，整目录 `@ts-nocheck` |
| RPC v2 | `src/lib/office/editor/protocol.ts`、`src/workers/pptx.worker.ts`、`src/lib/office/pptxWorkerClient.ts`（requestId + pending + 超时） |
| 增量渲染 | Worker 常驻模型；`get-scene` / `apply-op` 只重渲染当前页；`save` 时才序列化整个包 |
| 撤销/重做 | Worker 内单页快照栈（上限 30），`edit_ops` 继续做审计 |
| 命中与选中 | `src/lib/office/editor/geometry.ts`（含旋转命中）、`EditorCanvas.tsx`（选中框 + 八向手柄） |
| 拖动/缩放 | 本地轮廓预览 + 隐藏原节点，松手提交 `setTransform` |
| 内联文本 | 双击进入 textarea，提交 `setText`（按段落保留原格式） |
| 测试 | `geometry.test.ts`；`npx tsc --noEmit` / `npx vitest run` / `npx vite build` 均通过 |

尚未覆盖：多选、吸附、属性面板、组内子元素编辑、旋转节点缩放、AI diff 回滚。

### 待确认的决策点

| # | 决策 | 选项 |
|---|---|---|
| 1 | 交互层实现 | ✅ 已选自建 SVG/DOM |
| 2 | XLSX 野心边界 | 只读增强 / 接受 `xlsx-gateway` 或 Univer 类内核做真编辑（待定） |
| 3 | 撤销实现 | ✅ 当前为单页快照栈；大文件压测后再评估反向 op journal |
| 4 | vendor 边界 | ✅ `pptx-ops` 已纳入同步脚本 |

### 与既有 P1–P4 的衔接

- **P1** 增加"底座"工作：vendor ops 层、Worker RPC 化、增量渲染、撤销语义。
- **P2** 即本文 §14 的交互层，按"选中 → 拖动/缩放 → 内联文本 → 属性面板"递进。
- **P3 / P4** 不变；XLSX/DOCX 深度编辑按上表选型后再排期。

---

## 相关文档

- [Office 工作台界面设计与开发计划](./office-workbench-ui-plan.md)
- [PPT 扩展包](./ppt-extension.md)
- [PPT 生成进度](./ppt-generation-progress.md)
- [Win7 兼容架构](./win7-architecture.md)
- [编辑器插件开发](./编辑器插件开发.md)
