# LightRAG 文档图谱开发计划（P0）

> 状态：执行中　创建：2026-11-20　范围：`D:\Qt\mayo\docs` → LightRAG 知识图谱

## 1. 背景与目标

前期选型结论：产品侧文档图谱继续自研（Rust + SQLite + G6），LightRAG 作为**离线图谱生成与抽取质量基线**。

P0 目标：

1. 用 LightRAG 对 `D:\Qt\mayo\docs` 建立可查询的实体-关系图谱；
2. 量化 LLM 抽取质量、token 成本与耗时；
3. 产出实体/关系/图数据，作为 P1 Rust 自研抽取的对照基线；
4. 全程本机、可回滚，不影响 Pomegranate 应用与现有数据。

## 2. 语料盘点（2026-11-20）

| 项 | 值 |
| --- | --- |
| 总量 | 156 MB / 215 个文件 |
| 类型 | md 104、pdf 44、txt 35、png 23、html 6、gif 2、odg 1 |
| md+txt 规模 | 约 2.64 M 字符（百万级 token） |
| 子目录 | `design/`、`mayo-doc/`、`prototypes/`、`research/`、`tasks/`、`参考文献/` |
| 大文件 | 集中在 `research/`，最大 PDF 38.4 MB |

分批策略：

- **A 批（P0 主范围）**：md + txt + html，约 145 个文件，纯文本、解析稳定。
- **B 批（P0 可选）**：44 个 PDF，使用 pypdf 解析；扫描件/图片型 PDF 跳过并记录。
- 图片与 odg 不纳入 P0。

## 3. 产物布局

```
D:\AI\LightRAG\
├── inputs\mayo-docs\        # 语料镜像（A 批，保留相对目录）
├── workspace\mayo-docs\     # KV / 向量 / 图 / 文档状态（默认文件存储）
├── exports\mayo-docs\       # graph.json、统计、评测样本
├── logs\                    # 服务与扫描日志
└── .env                     # 本机配置（不入库）
```

计划与执行日志：`docs/lightrag-mayo-docs-graph-plan.md`（本文件）。

## 4. 技术方案

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 运行方式 | `lightrag-server`（127.0.0.1:9621） | 官方推荐；提供 REST API 与 WebUI |
| 存储 | 默认文件存储（JSON + NanoVectorDB + NetworkX） | P0 验证足够，不引入 Postgres/Neo4j |
| LLM | DeepSeek（OpenAI 兼容，`deepseek-chat`） | 复用应用已配置的供应商 |
| Embedding | SiliconFlow `BAAI/bge-m3`（dim 1024） | 仅用于向量化；LLM 仍用 DeepSeek |
| 解析 | md/txt/html 原生；PDF 用 pypdf | 扫描件 PDF 需 OCR，P0 跳过 |
| 安全 | 仅绑定 127.0.0.1 | 官方默认 0.0.0.0 且无鉴权，禁止使用默认值 |
| 并发 | `MAX_ASYNC=4` 起步 | 视 DeepSeek 限流调整 |

环境变量模板（密钥不写入计划文档）：

```ini
HOST=127.0.0.1
PORT=9621
INPUT_DIR=D:/AI/LightRAG/inputs/mayo-docs
WORKING_DIR=D:/AI/LightRAG/workspace/mayo-docs

LLM_BINDING=openai
LLM_BINDING_HOST=https://api.deepseek.com/v1
LLM_BINDING_API_KEY=<local secret>
LLM_MODEL=deepseek-chat

EMBEDDING_BINDING=openai
EMBEDDING_BINDING_HOST=https://api.siliconflow.cn/v1
EMBEDDING_BINDING_API_KEY=<local secret>
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIM=1024

MAX_ASYNC=4
```

## 5. 任务分解

### P0.1 环境与配置

- [x] 安装 LightRAG（`uv sync --extra api`，Python 3.14 venv）

- [x] 选择并配置 Embedding（SiliconFlow `BAAI/bge-m3`，dim 1024）

- [x] 写入 `.env`（LLM 密钥、Embedding 密钥、输入/工作目录）

- [x] `uv run lightrag-server` 启动成功（1.5.8，`/health` 正常）

### P0.2 语料准备（A 批）

- [ ] 创建产物目录

- [ ] 复制 md/txt/html 到 `inputs/mayo-docs`

- [ ] 统计文件数与字符数，记录到本文件

### P0.3 扫描入库

```bash
curl -X POST http://127.0.0.1:9621/documents/scan
curl http://127.0.0.1:9621/documents/pipeline_status
```

- [ ] 扫描任务完成

- [ ] 统计成功/失败/跳过文档，失败原因归档

### P0.4 评测与导出

- [x] 导出全量图谱到 `exports/mayo-docs/graph.graphml`（`/graphs` 仅支持子图且有节点上限，故直接复制 GraphML）

- [x] 统计实体数、关系数、度分布 Top-N（`stats.json`，15,813 节点 / 20,815 边）

- [ ] 抽样 20 条实体 + 20 条关系人工评估准确率（样表已生成：`samples_entities.csv`、`samples_relations.csv`，待人工评分）

- [x] 执行 3 个跨文档问题（`POST /query`，mode=mix，全部成功，引用 10/6/7）

- [x] 记录成本代理指标、耗时、失败率（LLM 缓存 1,809 条 / 35.4MB；详见 `REPORT.md`）

### P0.5 复盘

- [x] 更新本文件执行日志

- [x] 输出 P1 自研抽取的 Prompt/字段/阈值建议（见 `exports/mayo-docs/REPORT.md` 第 6 节）

## 6. 验收标准

1. A 批入库成功率 ≥ 95%；
2. 图数据可导出且包含不少于 500 个实体（以实际语料为准）；
3. 抽样实体/关系准确率 ≥ 70%（P0 基线，不追求最终质量）；
4. 三个跨文档查询中至少两个给出可追溯来源的合理回答；
5. 完整记录成本与失败样本。

## 7. 风险与回滚

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| DeepSeek 限流/超时 | 扫描中断 | 降低 `MAX_ASYNC`，分批扫描，失败重试 |
| 长文档 token 成本 | 费用超预期 | 先跑 A 批子集（如 `design/` + `tasks/`），再全量 |
| 扫描件 PDF 无文本 | 抽取为空 | P0 跳过并记录，B 批评估 OCR |
| 切换 embedding 模型 | 需重建向量 | P0 固定模型，变更时重建工作目录 |
| 笔记内容出网 | 隐私 | 仅使用用户授权的供应商；B 批前复核敏感内容 |
| 服务误暴露 | 配额被占用 | 强制 `HOST=127.0.0.1`，必要时启用 `LIGHTRAG_API_KEY` |

回滚：停止服务，保留或删除 `workspace/mayo-docs` 即可；不改动源文档与 Pomegranate 数据。

## 8. 与后续阶段衔接

- **P1**：在 Rust 侧实现实体/关系抽取（`services/graph_llm.rs`），写入 SQLite（`graph_entities` / `graph_relations` / 抽取运行表），复用 `ai-profile` 与 `index_queue`。
- **P2**：混合检索问答（向量 `note_embeddings` + 图扩展），接入 `kb-core` MCP。
- **P3**：本地 embedding/rerank，降低云依赖。
- 本 P0 产出的 Prompt、评测集、成本数据直接作为 P1 的输入。

## 9. 执行日志（滚动更新）

### 2026-11-20

- 完成语料盘点（215 文件 / 156 MB）。
- 完成 LightRAG 安装（`D:\AI\LightRAG`，Python 3.14 venv，`--extra api`）。
- 确认应用数据库已有 DeepSeek 配置；`ai_embedding_config` 为空，Embedding 待选型。
- 计划文档落盘。
- A 批语料已镜像到 `D:\AI\LightRAG\inputs\mayo-docs`（145 文件 / 2.7 MB）。
- `.env` 已写入：HOST/PORT/INPUT_DIR/WORKING_DIR、DeepSeek LLM、SiliconFlow `BAAI/bge-m3`（dim 1024）。
- 待办：写入 SiliconFlow API Key（`D:\AI\LightRAG\.embedding_key`）后启动服务扫描。
- 13:41 服务启动成功（LightRAG 1.5.8，文件存储：JsonKV + NanoVectorDB + NetworkX）。
- 连通性验证通过：DeepSeek chat 返回 200；SiliconFlow `BAAI/bge-m3` 返回 200，dim=1024。
- 扫描已启动（`scan_20261120_134106_a1a82677`），首批 58 个文件；实测约 1 个文档 / 30–45 秒，预计 A 批 1.5–2 小时。
- 监控：`curl http://127.0.0.1:9621/documents/pipeline_status`，日志 `D:\AI\LightRAG\logs\server.log`。
- 14:07 首次扫描中断：SiliconFlow embedding 并发过高触发 51 次 `Worker execution timeout after 60s`，58 个文档中 12 成功 / 46 失败。
- 调低并发：`MAX_ASYNC=2`、`MAX_PARALLEL_INSERT=1`、`EMBEDDING_FUNC_MAX_ASYNC=1`、`EMBEDDING_BATCH_NUM=5`、`EMBEDDING_TIMEOUT=120`。
- 服务改用独立进程（`Start-Process`，PID 12264），避免会话切换被回收；日志改为 `logs/server2.log` / `logs/server2.err`。
- 14:44 重试 46 个失败文档（`scan_20261120_214456_7ce7f94e`），2.5 分钟内新增超时 0 次；约 75 秒/文档。
- 扫描按批入队（首批 58），本批完成后需再次 `/documents/scan` 处理剩余文件。
- 21:55 重试进度 19/46，累计 30 个已处理、0 新增超时；服务 `/health` 正常。
- 22:35 确认扫描归档机制：已解析文件移入 `inputs/mayo-docs/__parsed__`（58 个）。
- 22:38 启动独立扫描控制器 `scripts/scan_until_done.py`（后因扫描瞬时完成、等待逻辑不适用而停止）。
- 00:23 定位剩余 87 个文件未被发现的原因：LightRAG `/documents/scan` **只遍历 INPUT_DIR 顶层**（`os.scandir`，非递归）。
- 00:23 处理：将子目录文件扁平化到顶层，命名为 `父目录__文件名`（如 `design__pipe-draw-two-products.md`），避免 README 等同名冲突；随后触发扫描，87 个全部入队。
- 决策：完整构建 A 批 145 个文件，用于 P0 全量基线（覆盖/召回、失败率、跨目录一致性）。
- 01:20 进度 38/87，文档记录 145 个（95 processed、12 failed、其余处理中）；图谱 11,026 节点 / 14,606 边，0 超时。
- 01:25 失败分析：10 个 `.txt` 为 CP1252/Latin-1 编码（非 GBK），2 个仅含换页符（空文件）；已将 10 个转为 UTF-8。
- 01:22 启动 `scripts/retry_failed.py`：空闲后删除 12 条失败记录，2 个空文件移入 `__skipped__`，再扫描 10 个已修复文件。日志 `logs/retry.log`。
- 03:34 收尾完成：143 个有效文档全部 processed（成功率 100%），2 个空文件跳过。
- 10:26 全量图谱导出：15,813 节点 / 20,815 边 / 最大连通分量 13,046（82.5%）/ 孤立节点 990。
- 10:30 三个跨文档查询全部通过（10.9s / 18.5s / 13.0s，引用 10/6/7）；产物与评测报告见 `D:\AI\LightRAG\exports\mayo-docs\REPORT.md`。
- 待人工：`samples_entities.csv`、`samples_relations.csv` 各 20 条评分；实际 token 费用以 DeepSeek 控制台为准。
- 11:10 LLM 预评分完成（DeepSeek，chunk 级证据）：实体准确性 95%、实体完整性 90%、关系准确性 90%、关系必要性 95%（n=20，provisional，同源自评偏差）。
- 产物：`exports/mayo-docs/samples_entities_llm.csv`、`samples_relations_llm.csv`、`accuracy_llm.md`；文件级取证旧结果保留为 `*_filelevel.*`。
- 下一步：人工抽检至少 8 条（20%）校准，再以 `score_accuracy.py` 输出正式结论。

## 10. P1 开发记录（2026-11-21）

### 决策

- 用户决定**不进行人工抽检**，以 LLM 预评分为 P0 基线：实体准确性 95%、完整性 90%、关系准确性 90%、必要性 95%（provisional）。

### 已实现（P1.1 / P1.2）

- 数据库 v88：`llm_graph_runs`、`llm_graph_entities`、`llm_graph_relations`。
- `models/mod.rs`：节点/边/结果/状态/批量项类型。
- `database/llm_graph.rs`：事务写入、状态查询、增量判断、作用域聚合（按 `norm_name` 跨笔记合并）。
- `services/llm_graph.rs`：6000 字符分块、最多 8 块、Prompt v1、JSON 容错解析、实体/关系合并与端点过滤、增量跳过（hash + model + prompt_version）。
- `commands/llm_graph.rs`：单篇抽取、批量抽取（默认 20 篇）、图查询、状态查询、删除。
- 前端：`types/index.ts` 与 `lib/api` 新增 LLM 图谱类型/API；图谱页增加“规则关系 / LLM 图谱”切换、抽取按钮、实体配色、来源笔记跳转。

### 验证

- `cargo check` 通过。
- `cargo test --lib services::llm_graph`：3 个单测通过。
- `npx tsc --noEmit` 通过。

### P1.3 联调结果（2026-11-21）

- 以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动 `pnpm tauri dev`，通过 CDP 驱动验证。
- DEV 库 `dev-app.db` 迁移到 v88，三张表创建成功。
- 单篇抽取（note 104《装配规划：参数设置 Tab 弹窗与长文本弹窗改造》）：
  - 100 秒、2 个分块、57 实体 / 77 关系；
  - 模型 `deepseek-v4-flash`，Prompt v1。
- 增量跳过：重复抽取 3ms 返回，`chunks=0`，数量一致。
- UI：图谱页显示「规则关系 / LLM 图谱」切换、抽取按钮、实体类型图例与配色；LLM 视图 57 节点 / 77 连线正常渲染。
- 日志无 `llm-graph` 相关错误或 panic。
- 未执行 20 篇批量抽取，以控制 token 成本；单篇路径已覆盖批量循环的核心逻辑。

### P1.2.1 图谱页作用域提示（2026-11-21）

- 后端 `LlmGraphData` 增加 `note_count` 与 `note_titles`，由 DAO 从实体来源笔记聚合。
- 图谱页标题按作用域显示：
  - 文件夹范围：`文件夹「active」图谱`
  - 单篇文档：`文档「装配规划：参数设置 Tab 弹窗与长文本弹窗改造」图谱`
  - 多篇/全库：`全库图谱`
- 标题旁增加来源提示：`来源：N 篇笔记（标题1、标题2 等 N 篇）`。
- CDP 实机验证：文件夹与单篇两种作用域均正确显示，57 节点 / 77 连线不变。

### P1.2.2 提示信息迁移到顶部标题栏（2026-11-21）

- 新增全局 `headerStatus`（Zustand）：`title / detail / actionLabel / actionPath`。
- 图谱页在 LLM 模式下把以下信息写入应用标题栏空白处：
  - 作用域标题（文件夹「X」图谱 / 文档「X」图谱 / 全库图谱）
  - 节点/连线数
  - 来源：N 篇文档（标题列表，超长省略）
  - 文件夹范围的「查看全部」
- 页面工具栏精简为仅保留「返回文档」；模式切换、抽取、布局控件仍在右侧。
- 术语统一：来源提示、右键菜单、图例提示均由“笔记”改为“文档”。
- CDP + 截图验证：标题栏单行显示、无重复计数、工具栏不再拥挤。
- 修复：此前仅 LLM 模式写入标题栏，规则关系模式下被清空；现改为两种模式都显示。
- 焦点模式兜底：顶部标题栏隐藏时，在页面工具栏内显示一行精简的作用域/计数/来源提示。
- 复核：规则模式下标题栏显示 `文件夹「active」图谱 · N 个节点 / M 条连线` 与「查看全部」。

### P1.2.3 文档级图谱入口（2026-11-21）

- 编辑器工具栏新增「查看文档图谱」按钮（GitBranch 图标），跳转 `#/graph?note=<id>`。
- 后端 `get_llm_graph_data` 新增 `note_id` 过滤：单文档优先于文件夹/全库。
- 文档级页面行为：
  - 强制 LLM 模式，隐藏“规则关系 / LLM 图谱”切换；
  - 标题 `文档「标题」图谱`；
  - 抽取按钮变为「抽取本文档」；
  - 「返回文档」回到编辑器；
  - 标题栏提供「查看全库」。
- 验证：note 104 → 57 节点 / 77 关系；note 999 → 0 节点；编辑器按钮点击后正确跳转。

### P1.2.4 工具栏精简与抽取进度（2026-11-21）

- 作用域信息从应用标题栏移回页面工具栏，位于「返回文档」之后：
  - 仅显示 `文档「标题」` / `文件夹「名称」` / `全库`；
  - 节点数、来源、查看全库说明放入 Tooltip，避免挤压布局；
  - 文件夹范围点击标签可直接查看全库图谱。
- 新增抽取进度事件 `llm-graph:progress`：
  - 字段：scope、phase、note_index/note_total、chunk/chunks、elapsed_ms、entities/relations；
  - 阶段：`note-start`、`chunk-start`、`chunk-done`、`note-done`、`note-error`。
- 前端在抽取按钮旁显示进度条与文案：
  - 单篇：`第 1/1 块 · 已用 12s · 预计剩余 48s`；
  - 批量：`第 3/20 篇 · 第 1/2 块 · 已用 … · 预计剩余 …`；
  - 每秒刷新；剩余时间按 60s/块启发式估算（可后续按实测校准）。
- 验证：note 183 抽取期间进度从 `0s / 1m0s` 连续递减至完成；悬停标签显示 `38 个节点 / 37 条连线 · 来源：1 篇文档（…）`。

### P1.2.5 编辑器右侧文档图谱面板（2026-11-21）

- 新增 `NoteGraphView`：与思维导图同构的编辑器右侧 flex 分栏，不再是页面跳转。
- 打开方式：编辑器工具栏 GitBranch 按钮；再次点击或面板 X 关闭。
- 与思维导图互斥，二者共用同一分栏宽度（`editor.mindMapWidth`，可拖拽分隔条、跨笔记记忆）。
- 面板标题行仅显示「文档图谱」，不再显示文件名；右侧显示 `N 节点 / M 关系` 与抽取、刷新、关闭按钮。
- 交互：节点点击后在面板底部显示名称/类型/描述；布局稳定后自动 fitView。
- 抽取复用进度事件，面板内显示进度条、已用时间与预计剩余。
- 保留 `#/graph?note=<id>` 路由入口作为独立页面。
- 验证：面板宽度与思维导图存储宽度一致；关闭/重开后编辑器保持正常，G6 正常渲染。

### P1.2.6 右侧图谱面板增强（2026-11-21）

- 节点信息框改为不透明（`colorBgElevated` + 阴影），避免画布内容干扰阅读。
- 新增「相关文档」列表：
  - 新命令 `get_llm_entity_notes(name, limit)`，按规范化实体名跨笔记查询；
  - 点击文档条目直接跳转对应笔记，当前文档标记「当前」。
- 新增图谱布局下拉（右侧工具栏）：力导向 / 环形 / 径向 / 网格。
- 新增「在新页面打开」按钮，跳转旧入口 `#/graph?note=<id>`。
- 验证：
  - `WidgetPipePage` 跨 3 篇文档正确返回（132、104、133）；
  - 布局菜单 4 项正常，切换后画布重渲染；
  - 旧入口跳转 `#/graph?note=104` 正常。
- `cargo check` 与 `tsc --noEmit` 通过。

### P1.4 Prompt 与阈值调优（2026-11-21）

- 实体规范化增强：
  - 拆分 camelCase、下划线、连字符、`::`、路径分隔符；
  - `PipeSequenceService` / `pipe_sequence_service` / `pipe sequence service` 归并为同一实体；
  - `HTTPServer` → `http server`，`QMessageBox::warning` → `q message box warning`。
- 长文档分块策略：改为均匀取首/中/尾最多 8 块，不再只取前 8 块。
- Prompt 升级到 v2：
  - 实体名保留原语言，不翻译、不缩写、不加版本号；
  - 同义写法合并；
  - 描述禁止补充原文没有的原因/效果/数字/版本/评价；
  - 仅共现的弱关系不输出。
- 阈值保持：单块最多 40 实体 / 60 关系，单篇最多 120 / 240。
- 实机对比（note 104，内容 5945 字符）：
  - v1：57 实体 / 77 关系，约 100s；
  - v2：40 实体 / 44 关系，73.6s；
  - 数量下降主要来自弱关系过滤与更严格的描述约束。
- 增量：Prompt 版本变化会触发重抽；重抽后再次调用命中缓存（chunks=0，40/44）。
- 测试：`cargo test --lib services::llm_graph` 5 项全部通过。

### 待办

- 对 v2 结果做抽样复核（重点看是否过度过滤导致召回下降）。
- 批量抽取 5–10 篇，校准 ETA 的 60s/块启发式。