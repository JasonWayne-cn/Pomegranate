# PPT 快速预览 / 正式草稿 方案与实施记录

## 背景

`/ppt` 是同一个 React 页面（`PptPage`），五个步骤共享同一套状态
（`job / plan / step / viewStep / draftSvgs / logs`），步骤 1 与步骤 3
共用 `renderDraftWorkspace()`。快速预览与正式草稿原先都写
`project/svg_output/`，正式生成会覆盖快速预览。

## 已确认目标

1. **已渲染页也显示大纲**（A1）
   - 已渲染页：页面 SVG + 下方可折叠大纲（标题 / 核心信息 / 要点 / 图表）。
   - 未渲染页：显示大纲卡片。
   - 左侧列表：标题 + 核心信息 + 状态图标（未开始 / 渲染中 / 已完成）。
2. **快速预览与正式草稿分目录隔离**（B1）
   - 快速预览：`project/svg_preview/`
   - 正式草稿：`project/svg_output/`（导出只读这里）
   - 渲染 / 列表 / 读取 / 清理 / 事件都带 `kind: preview | formal`。
3. **大纲生成反馈增强**（本次新增）
   - 大纲日志独立：`ppt-extension://plan-log`（`channel: "plan"`），不再与草稿引擎日志混在一起。
   - 大纲快照：标题清单完成及每扩展一批页面后发 `ppt-extension://plan-snapshot`，
     前端立即把页面加入左侧列表。
   - 大纲生成支持暂停 / 继续：在素材理解分块、标题清单、逐页扩展批次边界生效；
     进行中的单次 AI 请求结束后才暂停。

## 实施阶段

### Phase 1 后端
- `AppState.ppt_plan_pause`：`planning_id → pause flag`。
- 命令：`ppt_extension_pause_planning` / `reset` / `planning_paused`。
- `create_job` / `regenerate_plan` 接收暂停标志，在阶段与分块边界等待。
- `PlanLog` 日志走 `plan-log` 通道。
- 两阶段规划在标题清单完成、每批页面扩展完成后发 `plan-snapshot`。

### Phase 2 前端
- `planLogs` 独立状态与面板（快速预览页）。
- `planningSlides` 接收快照，规划中左侧列表实时增长。
- `planningPaused` + 暂停/继续按钮。
- 规划期间步骤 1 显示“大纲生成中”面板；完成后清理快照并切到正式 `plan`。

### Phase 3 验证
- 初始生成 / 重新生成大纲：列表随快照增长。
- 暂停/继续：在批次边界停顿，恢复后继续。
- 已完成快速预览不被正式生成覆盖（B1 完成时）。

## 状态

- [x] 方案落盘
- [x] 后端实现
- [x] 前端实现
- [x] 编译与验证（cargo check / tsc 通过）

> 说明：逐页即时列表依赖两阶段规划（指定页数 ≥ 3 时启用）；
> 未指定页数走单次规划，页面会在最终大纲返回时一次性出现。

## 补充：历史作业素材恢复

- 问题：打开历史作业后「素材来源」为空，原先选中的文档丢失。
- 方案：新增 `ppt_extension_job_sources` 读取 `input/source_manifest.json`；
  前端打开历史作业时清空临时选择并展示恢复的只读素材列表（标题 / 类型 / 字数）。
- 补充素材原文：新作业在 `job.json options.manualText` 留一份；旧作业无此字段则留空。

## 补充：补充素材 vs 生成要求

两者**不等价**，保留两个入口并明确命名：

| 字段 | 去向 | 作用 |
|------|------|------|
| 补充素材（manualText） | 追加进 `source.md` | 作为正文素材，参与素材理解与大纲规划 |
| 生成要求（extraRequirements） | 只进入规划提示词 | 约束结构 / 风格 / 侧重，不提供事实内容 |

UI 文案已改为「补充素材（作为正文素材参与大纲）」与「生成要求（结构 / 风格）」。
