# PPT 生成进度与效率优化

本文记录 PPT 大纲/草稿生成阶段的进度反馈、自适应候选与效率优化方案，以及已实施范围和后续项。

## 开发进度总览

更新时间：2026-11-01  
当前扩展版本：1.2.5

### 已完成

- 素材分块理解：并发 3 块、快模型选择、阶段总超时、流式规划进度
- 结构化大纲：contentBlocks / evidence / relation / chartType / density
- 内容校验与局部页面修复
- 三种草稿生成方式：程序化（默认）/ 一次性 / 多次
- 程序化渲染：13 种页面结构、模板调色板、内容门禁、多样性惩罚、渲染 QA 回退
- 程序化候选：每页最多 3 个结构候选，保存为独立 SVG，可在草稿页手动切换
- 多次生成：自适应 1–3 个 AI 候选、候选并发、LLM 评审、断点续跑、单页重生成
- 导出修复：清理 AI SVG 的 `data-pptx-*` 与 `dominant-baseline`，避免回退纯文本
- 进度事件：大纲阶段 `plan-progress`、草稿阶段 `draft-page`
- 两阶段页级大纲：指定页数时先生成标题清单，再按 2 页并发逐页扩展，进度精确到页
- 页级并发 2：AI 草稿按两页一批并发生成，跨页去重改为视觉签名集合
- AI 候选缩略图：oneShot / bestOf 的候选写入 `project/candidates/`，草稿页可切换
- 原生图表增强：沿用模板调色板，补充图例、数据标签、网格线与图表字体
- 程序化图表布局：按 `chart` 数据渲染柱状/折线/饼图，新增 `chart` 页面结构与图标装饰
- 页面节奏：`density` 影响卡片字号、图表留白与布局密度
- 历史作业恢复：从 `job.json` 回显生成方式、原生图表与页数

### 验证

- `cargo test "services::ppt"`：31 passed
- `cargo check`：通过
- `npx tsc --noEmit`：通过
- `npx vitest run`：537 passed
- 扩展 unittest：21 passed
- 程序化 4 个新增布局目检通过
- 13 页导出原生 PPTX 成功，图表、流程和卡片保留
- 新增图表布局单测：柱状/折线/饼图 SVG 结构通过

### 待办

- 原生图表与版式融合（当前原生图表页使用独立配色页，不叠加模板 SVG）
- 更丰富的图标库与按页面角色自动选择图标
- 候选缩略图的差异说明（结构/视觉/叙事方向标签）

## 背景

当前生成链路：

```
素材 → 分块/并发理解 → 结构化规划 → 三种草稿生成方式 → QA/评审 → 导出
```

存在三个体验问题：

1. 大纲是一次 AI 调用，期间只有零散日志，无法判断是否卡死。
2. 草稿生成是异步 Command，前端要等全部页面完成后才进入草稿页，看起来像死循环。
3. 每页固定 3 候选且串行生成，reasoner 模型下耗时过长。

## 目标

- 大纲阶段：可见“素材理解 i/N、正在规划、正在校验、正在修复”
- 草稿阶段：点击后立即进入草稿页，逐页出现草稿图
- 减少无效候选调用，同时保持高质量页面的评分
- 中断后可以继续生成，不重复已有页

## 大纲阶段耗时优化

大纲生成链路曾存在以下耗时点，现已全部收敛：

| 问题 | 优化 |
|---|---|
| 素材分块理解串行，每块独立超时 150s，阶段总时长无上限 | 限流并发 3 块，单块 120s，阶段总上限 300s；超时保留已完成部分 |
| 理解/合并也使用推理模型 | 在同一 API 地址（同厂商）内自动选择非推理快模型；没有同源快模型时沿用用户模型，避免跨厂商 Key 失效导致 401 |
| 规划 Prompt 同时塞入 6 万字符理解结果 + 6 万字符原始素材 | 只发送素材理解（上限 3 万字符）；理解结果过短时才补 1.5 万字符素材节选 |
| 规划 180s 硬超时 | 提升到 420s；规划失败仅重试 1 次 |
| 校验失败后整份大纲重新生成 | 按校验问题提取页码，只修复问题页面并按 `page` 合并回原大纲 |
| 规划期间无页级进度 | 流式解析已出现的 `"page"` 字段，实时推进 `plan-progress.current` |

实现位置：

- `build_understanding_with_ai`：并发理解、阶段总超时、快模型选择
- `fast_model_id` / `pick_fast_model_id` / `looks_reasoning_model`：按阶段选择模型，且只在同 `api_url` 内切换
- `build_plan_with_ai`：精简规划 Prompt、流式页级进度
- `repair_plan_with_ai` + `ppt_plan::merge_repaired_slides`：局部页面修复
- `AiService::complete_once_with_progress`：流式 token 回调

## 日志与异常恢复

- 大纲阶段日志同时写入 `<作业>/logs/plan.log`：开始/结束时间、素材块并发进度、每次规划尝试的输入字符数、校验/修复结果、总耗时。
- `regenerate_plan` 开始时写入 `started_at` 并置 `status=running`；成功或失败都会复位，失败记录 `error_message`，不再停留在 running。
- `ppt_extension_list_jobs` 加载列表时回收僵尸作业：`running` 超过 30 分钟且产物 15 分钟无更新 → 标记 `failed`（`error_code=stale_running`）。
- `regenerate_plan` 遇到僵尸 running 会先回收再继续，不再直接返回"作业正在运行"。

## 三种生成方式

草稿页顶部提供生成方式选择，默认“程序化生成”；选项顺序为 程序化、一次性、多次。

| 方式 | 值 | 实现 | AI 调用 | 适用场景 |
|---|---|---|---|---|
| 程序化生成 | `programmatic` | Rust 程序化排版，每页 3 个 motif 候选选 1 | 不调用 AI 生成 SVG | 默认，最快、稳定，版式由程序控制 |
| 一次性生成 | `oneShot` | 每页 1 次 AI 连续生成，失败修复 1 次，不做候选 | 每页 1 次 | 接近上游 PPT-Master skill，速度与质量平衡 |
| 多次生成 | `bestOf` | 每页自适应 1–3 个 AI 候选，评分 + LLM 评审，失败修复 | 每页 1–3 次 | 质量优先，耗时最长 |

实现位置：

- `DraftGenerationMode`：模式解析与 `as_str`
- `PptExtensionService::render_ai_draft`：`oneShot` / `bestOf` 分流
- `PptExtensionService::render_programmatic_draft`：程序化渲染入口
- `services/ppt_programmatic_renderer.rs`：13 种页面结构（封面、编辑式分栏、卡片、时间线、流程、对比、因果、层级、矩阵、引述、证据主导、总结、列表），每种最多 3 个 motif 候选
- `ppt_extension_render_ai_draft(mode)`：Command 参数
- `job.json` 的 `options.generationMode` 记录最近一次选择

程序化渲染的 motif 选择依据：

- 从模板/spec_lock 提取主色、强调色、危险色、背景与文字色
- 内容门禁：矩阵需要至少 4 个内容块、时间线节点至少 3 个、大数字至少 2 个等
- 与上一页 motif 重复时重罚；复用次数越多分越低
- 内容量过少时优先简单布局
- 同一 layout 生成最多 3 个候选，选最高分

### 渲染 QA 与候选选择

- 候选生成后检查：文本横向/纵向越界、字号 10–72、可见文本过少、禁用 SVG 属性
- 有问题候选按问题数降分；全部候选都有问题时回退到 Content 布局，再不行使用 fallback
- 3 个候选 SVG 保存到 `project/candidates/Pxx_1.svg` … `Pxx_3.svg`
- `page_selection.json` 记录每个候选的 `motif / score / issues / file` 和当前 `selected`
- 草稿页显示 3 个结构候选缩略图，点击即可切换
- 新增接口：
  - `ppt_extension_page_candidates(jobId, page)`
  - `ppt_extension_select_page_candidate(jobId, page, index)`

模式不改变大纲、导出与质量门禁流程；只改变草稿页面的生成方式。

## 事件协议

### `ppt-extension://plan-progress`

大纲阶段的结构化进度。

```json
{
  "jobId": "e5a3d940-...",
  "stage": "understanding | planning | validating | repairing",
  "current": 3,
  "total": 5,
  "message": "AI 正在理解素材 3/5（8000 字）"
}
```

- `understanding`：按素材分块推进，`current/total` 为块序号
- `planning`：一次性规划；流式输出时按已生成页数推进 `current`，`total` 为目标页数（未设置时 `total` 为 0，`current` 为已生成页数）
- `validating`：大纲内容校验
- `repairing`：内容修复尝试

前端在设置/大纲阶段显示 `Progress` 和 `message`，即使没有精确页级进度也能明确当前阶段。

### `ppt-extension://draft-page`

草稿阶段每完成一页发送一次。

```json
{
  "jobId": "e5a3d940-...",
  "page": 7,
  "total": 13,
  "status": "selected | reused | fallback | failed",
  "score": 88,
  "candidateCount": 2,
  "issues": []
}
```

- `selected`：AI 页已写入 `project/svg_output/P07.svg`
- `reused`：断点续跑复用了已有达标页
- `fallback`：该页交给模板兜底
- `failed`：候选和兜底都不可用

事件只传元数据，不传整页 SVG。前端收到 `selected/reused` 后调用 `ppt_extension_read_draft_page` 读取对应文件，增量加入列表和预览。

## 自适应候选

默认上限 3 个候选，但不再固定生成：

| 第 1 个候选 | 后续动作 |
|---|---|
| score ≥ 85 且无 hard fail | 直接采用，停止 |
| 55 ≤ score < 85 | 生成第 2 个，取最高 |
| score < 55 或 hard fail | 生成第 2、3 个，再进入修复重试 |

- 第 2 个生成后最高分 ≥ 75 即停止，不生成第 3 个
- 实际生成数量写入 `page_selection.json` 的 `candidates` 和 `draft-page.candidateCount`
- 高分页通常只需 1 次调用，预计总调用量下降 40–60%

## 候选并发与页级并发

- 第 1 个候选单独生成，用于自适应判断
- 需要第 2/3 个时，并发请求剩余候选（最大并发 2）
- 页与页按两页一批并发生成（最大并发 2）
- 跨页去重改为“视觉签名集合”：每页生成前快照已选页签名，生成后追加，避免并发页互相覆盖
- 同一批内两页可能使用相同签名快照，但不同批之间仍能正确去重

## 两阶段页级大纲

用户指定页数（≥3）时启用：

1. 第一阶段只生成页标题清单（page / title / pageTheme），进度条显示“正在规划 N 页标题”
2. 第二阶段按 2 页并发扩展完整结构化内容
3. 每完成一页发送 `plan-progress`，message 为“AI 正在扩展第 K/N 页”
4. 任一阶段失败会回退到原有单次规划，不阻塞作业创建

实现位置：`build_plan_two_stage` / `expand_plan_slide`。未指定页数时仍使用单次规划。

## AI 候选缩略图

- `oneShot` 与 `bestOf` 的全部候选 SVG 写入 `project/candidates/Pxx_1..N.svg`
- `page_selection.json` 记录每个候选的文件、分数、问题与选中索引
- 草稿页“页面候选”区域可预览并切换 AI 候选，复用 `ppt_extension_page_candidates` 与 `ppt_extension_select_page_candidate`
- 修复重试产生的额外候选会保留选中项并裁剪到最多 3 个

## 智能评审

LLM 评审只在以下条件触发：

- 至少 2 个候选
- top1 与 top2 分差 ≤ 5
- top1 分数 < 85

分差明显或质量很高时直接选最高分，减少一次调用。

## 断点续跑

`ppt_extension_render_ai_draft` 启动时：

1. 读取 `project/page_selection.json`
2. 对每页检查 `project/svg_output/Pxx.svg` 是否存在且 score ≥ 80
3. 满足条件则跳过，发送 `status=reused`
4. 只生成缺失页或低分页

注意：修改大纲会清空旧草稿，此时仍会全量重跑。断点续跑主要覆盖中断、失败后再次点击生成的场景。

## 单页模型覆盖

`ppt_extension_regenerate_ai_page` 支持可选 `modelId`：

- 默认沿用作业模型
- 可用快模型（如 `qwen-plus`）批量出稿
- 对低分页用 `deepseek-reasoner` 单页精修

前端当前单页按钮不传模型，后续可增加“精修模型”选择。

## 阈值与配置

| 配置 | 默认值 | 说明 |
|---|---|---|
| 候选上限 | 3 | Command 参数 `candidateCount`，范围 1–3 |
| 直接采用分数 | 85 | 第 1 个候选达到即停止 |
| 停止追加分数 | 75 | 第 2 个最高分达到即停止 |
| 采用门槛 | 55 | 低于该分数不写入草稿 |
| 评审分差 | 5 | top1/top2 差值 |
| 评审最高分 | 85 | top1 低于该值才评审 |
| 断点续跑分数 | 80 | 已有页达到该分数则复用 |

## 验收标准

- 大纲阶段在理解、规划、校验、修复各阶段都有事件
- 点击“生成草稿”后立即进入草稿页，不再等待全部完成
- 每完成一页，1 秒内出现在草稿列表
- 进度条显示“已完成 X/N · 当前 Pxx · 候选 k/m”
- 13 页作业的总 AI 调用量相比固定 3 候选下降 40% 以上
- 中断后再次生成只补缺失/低分页
- 失败页标记为模板兜底，不阻塞其他页
- 程序化页面提供 3 个结构候选，草稿页可点击切换
- 候选出现文本越界、字号异常或禁用属性时降分或回退
- 程序化页面使用模板/spec_lock 的主色、强调色与背景色
- 指定页数时，大纲进度可显示“AI 正在扩展第 K/N 页”
- AI 草稿两页并发，且并发页之间不会产生相同视觉签名
- oneShot / bestOf 草稿页可查看并切换多版本候选
- 程序化图表页使用柱状/折线/饼图结构，图表数据来自结构化大纲
- 打开历史作业时恢复生成方式、原生图表开关与页数

## 后续项

- **原生图表与版式融合**：当前原生图表页使用独立配色页，不叠加模板 SVG；后续可先栅格化模板页再叠加图表
- **图标库**：当前使用基础几何图标，后续可接入可配置图标集
- **候选方向标签**：为 AI 候选记录结构/视觉/叙事方向，便于用户理解差异
- **两阶段大纲的增量缓存**：中断后复用已扩展页面，避免整份重跑
