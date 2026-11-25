# PPT 生成后续开发计划

制定时间：2026-11-22\
基线：扩展包 1.2.6，Python 3.8 兼容，Win7 可运行\
关联：[`ppt-generation-progress.md`](ppt-generation-progress.md)

本计划覆盖四项后续工作。按「收益 / 风险」排序执行，而不是按编号顺序：

| 顺序 | 项目 | 优先级 | 风险 | 主要改动 |
| --- | --- | --- | --- | --- |
| M1 | 两阶段大纲增量缓存 | P0 | 低 | Rust 服务层 |
| M2 | 候选方向标签 | P1 | 低 | Rust 服务层 + 前端 |
| M3 | 图标库与按角色选图标 | P1 | 低 | Rust 程序化渲染器 |
| M4 | 原生图表与版式融合 | P2 | 高（需 spike） | 扩展包 Python + 可选 Rust |

约束：

- 不新增数据库 schema；缓存与标签都落在作业目录文件。
- 扩展包仍是唯一分发单元；用户模板目录只读。
- 不直接修改上游 `svg_to_pptx.py` 等脚本；确需改动时 fork 到扩展包 `scripts/` 并在构建脚本中说明。
- AI 调用与文件写入继续走 Rust 服务层，前端只消费事件与 Command。

---

## M1 两阶段大纲增量缓存（P0）

### 现状

- `build_plan_two_stage`（`src-tauri/src/services/ppt_extension.rs:2553`）把逐页扩展结果放在内存数组 `expanded`（`:2675`）。
- 任一页扩展失败时 `missing > 0` 直接返回错误（`:2754-2759`），上层回退单次规划，已扩展页全部丢弃。
- 用户取消同样整份丢弃。
- `regenerate_plan_inner`（`:1246`）每次重新规划都会重跑全部页面。

### 目标

中断、失败或重复规划时复用已成功扩展的页面，只补齐缺失页；无缓存时行为与现在一致。

### 方案

1. 新增缓存文件 `project/plan_stage2.json`：
   ```json
   {
     "signature": "sha256(...)",
     "titles": [{ "page": 1, "title": "...", "theme": "..." }],
     "slides": { "3": { "...": "完整页面 JSON" } },
     "updatedAt": "2026-11-22T10:00:00Z"
   }
   ```
2. `signature` 由 `title + audience + extra_requirements + slide_count + understanding 前 8k 字符` 计算；任一变化即整体失效。
3. 页级签名：`hash(understanding + title + theme)`。即使整体 signature 命中，页级签名不一致的页面也不复用。
4. 每完成一批（2 页）后用 `write_json_file` 原子写盘，避免进程中断丢进度。
5. 失败策略改造：
   - 缺失页先按并发 2 重试 1 轮；
   - 仍缺失且不超过总数 1/3：用标题占位页补齐，标记 `partial`，日志与前端提示；
   - 缺失超过 1/3：沿用现有回退单次规划。
6. 清理时机：
   - 修改大纲（`planDirty` 路径）时删除 `plan_stage2.json`；
   - 素材、标题、受众、页数、额外要求变化由 signature 自动失效。

### 改动点

- `src-tauri/src/services/ppt_extension.rs`
  - 新增 `PlanStageCache`（`load / save / clear / is_title_match`）；
  - 改造 `build_plan_two_stage`：启动时预填 `expanded`，批完成后落盘；
  - 改造 `expand_plan_slide`：返回页级签名，供缓存校验；
  - `plan-progress` 事件 message 增加「复用 N 页」。
- `src/pages/ppt/index.tsx:1596` 附近：大纲进度文案显示复用页数（读取 `plan-progress` 扩展字段或 `message`）。
- 文档：同步更新 `ppt-generation-progress.md` 的「两阶段页级大纲」小节。

### 验收

- 取消后再次生成，只请求未完成页，AI 调用页数明显少于总页数。
- 修改标题/受众/页数后缓存不命中，全量重新生成。
- 缓存文件损坏或字段缺失时不阻塞，按无缓存处理。
- 部分失败在阈值内时仍能产出可用大纲并明确提示。

### 测试

- Rust 单测：缓存命中/不命中、页级签名失效、损坏 JSON 容错、部分缺失复用。
- 冒烟：模拟取消后重跑，断言请求页数小于总页数。

---

## M2 候选方向标签（P1）

### 现状

- AI 候选方向硬编码为 3 条文案：`ppt_extension.rs:4180-4184`（批量草稿）与 `:5169-5172`（单页重生成）。
- `page_selection.json` 中 AI 模式只写 `"motif": "候选 1"`（`:4499`），程序化模式写真实 motif 名（`:4536`）。
- 前端候选卡片只显示 motif 与分数（`src/pages/ppt/index.tsx:2550-2558`），用户无法判断差异。

### 目标

候选展示方向标签（结构 / 视觉 / 叙事）与一行说明；程序化候选显示中文 motif 名。

### 方案

1. Rust 定义方向常量表（示意）：
   ```rust
   // (key, label, hint)
   const AI_DIRECTIONS: [(&str, &str, &str); 3] = [
       ("structure", "结构优先", "清晰标题层级、编号分组与稳定网格"),
       ("visual", "视觉优先", "大数字、色块、图表或强对比图形"),
       ("narrative", "叙事优先", "主线组织，强调因果/流程/对比"),
   ];
   ```
2. `PageCandidateScore`（`:3168`）增加 `direction: Option<String>`。
3. `update_ai_selection`（`:4491`）写入 `direction`、`label`、`note`；`note` 记录候选的生成侧重。
4. 程序化候选新增 `motif_label()` 映射（如 `top-band → 顶部色带`、`numbered → 编号列表`），并在 `update_programmatic_selection`（`:4513`）写入 `label`。
5. 兼容旧数据：读取时缺 `label` 回退 `motif`，缺 `direction` 不显示标签。
6. 前端候选卡片改为「label + 分数 Tag」，hover 显示 `issues`；方向说明用 Tooltip。

### 改动点

- `src-tauri/src/services/ppt_extension.rs`：方向表、候选结构、两处写入函数。
- `src/types/extension.ts:186`：`PptPageCandidateScore` 增加可选 `label` / `direction` / `note`。
- `src/pages/ppt/index.tsx:2522-2563`：候选卡片渲染。
- 文档：`ppt-generation-progress.md` 的候选相关小节。

### 验收

- AI 候选显示「结构优先 / 视觉优先 / 叙事优先」，不再显示「候选 1」。
- 程序化候选显示中文结构名。
- 旧作业的 `page_selection.json` 仍能正常展示候选与切换。

### 测试

- Rust 单测：新旧 `page_selection.json` 解析兼容。
- 前端：候选卡片渲染（Vitest，如有组件测试基础）。

---

## M3 图标库与按页面角色选图标（P1）

### 现状

- `icon_badge`（`src-tauri/src/services/ppt_programmatic_renderer.rs:1816-1831`）只支持 `arrow`、`check` 与默认圆点。
- 调用点固定为图表装饰（`:990`）与对勾标记（`:1545`），图标与内容语义无关。

### 目标

内容页图标随内容块语义变化，保持白描线风格与模板配色，不引入外部图标依赖。

### 方案

1. 扩展 `icon_badge` 的 kind 集合（控制在 12 个以内）：
   `arrow / check / star / alert / clock / trend / quote / target / bolt / people / lock / search`
   全部使用 24×24 设计坐标的描边路径，按 `radius` 缩放。
2. 新增 `infer_icon_kind(label, text, index) -> &'static str`：
   - 关键词表：风险/问题 → `alert`；时间/阶段 → `clock`；增长/数据 → `trend`；结论/完成 → `check`；目标/战略 → `target`；效率/速度 → `bolt`；团队/用户 → `people`；安全/合规 → `lock`；洞察/寻找 → `search`；引述 → `quote`。
   - 未命中时按 `index` 轮换，避免整页使用同一图标。
3. 页面级去重：同一 kind 在一页内最多出现 2 次，超出后轮换。
4. 颜色使用当前 `palette` 的 secondary/primary，保证与模板一致。

### 改动点

- `src-tauri/src/services/ppt_programmatic_renderer.rs`：图标路径表、`infer_icon_kind`、渲染调用点。
- 文档：程序化渲染小节补充图标规则。

### 验收

- 内容页图标随 block 文案变化，不再固定为圆点/箭头。
- 渲染 QA（文本越界、字号、禁用属性）仍全部通过。
- 4 个代表性页面目检无明显视觉噪声。

### 测试

- Rust 单测：每个 kind 输出合法 `<path>`，不含禁用属性。
- `cargo test services::ppt` 全量通过。

---

## M4 原生图表与版式融合（P2，先 spike）

### 现状

- 原生图表分支：`entry.py:2642-2653`，当 `nativeCharts && has_chart` 时调用 `export_with_python_pptx(native_charts=True)`。
- 该函数（`:2270-2376`）逐页新建空白版式：顶部色带 + 标题 + bullets + 原生图表，**不加载模板 SVG**。
- SVG 分支：模板填充时 `_replace_with_chart`（`:1550`）把图表槽位替换为矢量图表，再由 `svg_to_pptx.py` 导出。
- 上游脚本由 `find_script`（`:2054`）从扩展包 `skills/ppt-master/scripts/` 加载，构建时复制进 zip。

### 目标

原生图表页保留模板背景、装饰与标题位置，仅把图表槽位替换为可编辑的原生图表。

### 方案 A（推荐）：模板导出 + python-pptx 叠加

1. native 模式下，模板填充阶段把图表槽位替换为**带唯一标识的透明占位形状**（SVG 增加 `data-pptx-native-chart="P07"`），不生成矢量图表。
2. 先调用 `export_with_ppt_master` 生成保留模板版式的 pptx。
3. 新增 `attach_native_charts(pptx, plan, palette, slots)`：
   - 用 python-pptx 打开导出结果；
   - 按形状名或 bounds 定位占位形状；
   - 删除占位形状，在原位置 `add_chart`；
   - 复用现有配色、图例、数据标签、网格线逻辑（抽成 `style_native_chart()`）。
4. 降级：找不到槽位时保留 SVG 矢量图表，不回退纯文本。
5. 不改上游 `svg_to_pptx.py`；若必须感知自定义属性，则 fork 该脚本到扩展包 `scripts/` 并记录差异。

### 方案 B（备选，仅当 A 失败）

模板页先栅格化为背景图，再在顶层叠加原生图表。需要 SVG→PNG 运行时（resvg / cairosvg / Edge headless），增加体积与 Win7 兼容风险，不作为首选。

### Spike 清单（先做，产出结论后再排期）

- [x] 检查 `svg_to_pptx.py` 是否把 SVG `id` / `data-*` 映射为 PowerPoint shape 名称。
- [x] 导出一页含图表槽位的模板，检查 shape 名称、位置（EMU）与分组结构。
- [x] 验证删除占位形状后 `add_chart` 的位置精度与层级（是否被背景遮挡）。
- [x] 结论：A 可行，无需 fork 上游。`data-pptx-shape-name` 原样成为 shape.name，位置按 1px = 9525 EMU 精确映射。

### 改动点

- `extensions/ppt-master/entry.py`：native 分支填充、`export_pptx` 编排、`attach_native_charts`、`style_native_chart`。
- 可选：`src-tauri/src/services/ppt_extension.rs` 在 `options` 中记录图表槽位，或在导出前生成 `project/chart_slots.json`。
- 文档：`ppt-generation-progress.md`、`ppt-extension.md` 同步原生图表行为。

### 验收

- 原生图表页的背景、标题、装饰与 SVG 草稿一致。
- 导出的 pptx 同时含模板形状与 `ppt/charts/chart*.xml`。
- 图表在 PowerPoint 中可直接编辑数据。
- 槽位缺失时自动降级，效果不劣于当前独立配色页。

### 测试

- 扩展 unittest：新增「模板 + 原生图表」冒烟，断言未回退纯文本、含 chart XML。
- 真实导出后用 PowerPoint 打开目检位置与可编辑性。

---

## 里程碑与完成定义

- [x] M1 增量缓存：单测 + 取消重跑冒烟通过，文档同步。
- [x] M2 方向标签：新旧作业候选均可展示，前端文案正确。
- [x] M3 图标库：单测与 4 页目检通过。
- [x] M4 spike 结论产出；A 方案实现并通过真实导出验证（或明确转 B 的决策记录）。

## 实施记录（2026-11-22）

- M1：`ppt_extension.rs` 新增 `plan_stage2.json` 缓存（整体签名 + 页级签名、每批原子落盘、缺失页重试、≤1/3 占位补齐）；3 项单测通过。
- M2：新增 `AI_DIRECTIONS` 常量与 `direction_label/hint`；AI 候选写入 `direction/label/note`，程序化候选写入中文 `label`；前端候选卡片显示标签与说明；单测覆盖旧数据结构兼容。
- M3：`icon_badge` 扩展为 12 种描边图标，新增 `infer_icon_kind` / `pick_icon`（页内同类最多 2 次）；3 项单测通过。
- M4：`fill_structured_layout(native_placeholder)` 输出命名占位矩形；`export_with_native_overlay` 临时切换 `svg_native/` 导出模板版式，`attach_native_charts` 删除占位并叠加原生图表；失败回退独立配色页。扩展 unittest 24 passed，端到端保留 `TEMPLATE_BAND` 且生成 `ppt/charts/chart1.xml`。

## 统一验证

```bash
cd src-tauri && cargo test services::ppt
cd src-tauri && cargo clippy
npx tsc --noEmit
npx vitest run
python -m unittest discover -s extensions/ppt-master/tests
pnpm build
```

M4 额外：真实文档生成 + 原生图表导出 + PowerPoint 打开检查。

## 不在本次范围

- 用户模板的动态生成（Authored / 上游 Create Template）
- 截图生成模板
- Win7 目标机实机验证（仍列为环境验证项）
