# PPT 扩展

基于 Pomegranate 主程序的文档生成 PPT 能力。通过本地安装的功能扩展包（Engine Pack）承载 PPT 引擎，未安装时不增加主程序负担。

> 详细设计见 [ppt-extension.md](./ppt-extension.md)。本文覆盖功能现状、使用流程、技术实现与后续工作。

## 1. 功能概览

- 从笔记搜索结果中选择多个文档，或添加本地 PDF / Word / Markdown / TXT / Excel 文件
- 使用 AI 生成页面大纲，支持自动决定页数
- 按所选版式模板生成封面、章节、内容、卡片、结尾等页面
- 将数据要点绘制为可编辑 SVG 图表并嵌入内容页
- 生成可编辑 PPTX，支持导出目录、打开工程、取消生成
- 生成过程流式输出阶段、进度与日志

当前扩展包版本：**1.2.1**。

## 2. 架构

```
主程序（始终存在）
├── React
│   ├── /extensions       扩展包安装、启停、校验
│   └── /ppt              素材/风格确认/大纲/草稿修改/结果
└── Rust
    ├── ExtensionService      zip 预检 / 安装 / 卸载 / 哈希校验
    ├── ExtensionRunner       受控子进程 + JSONL 流式事件
    ├── PptExtensionService   多素材收集 / AI 规划 / 作业状态
    └── SQLite               extensions / extension_versions / ppt_jobs

扩展包（本地 zip，按需安装）
└── ppt-master/
    ├── extension.json
    ├── entry.py              Python Executor
    ├── ppt-master/           上游脚本（可选）
    ├── templates/layouts/    版式模板
    └── templates/charts/     图表模板
```

## 3. 已实现能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 本地 zip 安装/启停/卸载 | 已完成 | 预检清单、权限、兼容性、完整性哈希 |
| 扩展 API/协议版本 | 已完成 | `apiVersion` / `protocolVersion`，当前均为 1 |
| 离线签名 | 已完成 | 可选 Ed25519 签名，验签失败拒绝安装 |
| 版本回滚 | 已完成 | 扩展管理页可切换到已安装的旧版本 |
| 多文档素材 | 已完成 | 搜索分页，每页 5 篇，选择后加入素材源 |
| 本地文件素材 | 已完成 | PDF / Word / Markdown / TXT / Excel |
| AI 大纲 | 已完成 | 复用主程序 AI 模型；2 次尝试后按标题降级 |
| 素材元信息建议 | 已完成 | 添加素材后 AI 建议 PPT 标题与汇报对象，手动修改后不覆盖 |
| 交互式大纲 | 已完成 | 先生成大纲，用户预览/编辑后再渲染 |
| 大纲重新生成 | 已完成 | 大纲页设置目标页数，复用素材与设置重新调用 AI |
| 阶段回退/前进复用 | 已完成 | 内容未变时直接返回已有大纲/草稿/导出结果，不重复生成 |
| 规划取消与超时 | 已完成 | 规划阶段可取消，默认 180 秒超时 |
| 页数 | 已完成 | 当前由 AI 根据素材自动决定，设置页不提供手动输入 |
| 版式页型选择 | 已完成 | cover / chapter / toc / content / content_cards / ending |
| `{{}}` 占位符填充 | 已完成 | 标题、章节、页码、目录、结尾等 |
| 结构化 layout | 已完成 | 解析 `data-pptx-placeholder`，并返回支持度 |
| 长文本自适应 | 已完成 | 超宽自动缩小字号，仍超宽自动换行 |
| 图表数据提取 | 已完成 | AI `chart` 字段或“标签：数值”要点 |
| SVG 图表嵌入 | 已完成 | 柱状/条形/折线/面积/饼图/环形图，矢量片段 |
| 原生 PowerPoint 图表 | 已完成（可选） | 开关开启后用 python-pptx 生成可编辑图表 |
| 质量门禁 | 已完成 | 字号角色、文本溢出、结构校验 |
| 原生 pptx 导出 | 已完成 | `svg_to_pptx.py`，失败回退 python-pptx |
| 流式进度 | 已完成 | Rust 阶段日志 + 引擎 JSONL 解析 |
| 取消生成 | 已完成 | Windows 进程树终止 |
| 作业历史 | 已完成 | 列表、重试、删除、清理、诊断包 |
| 运行器加固 | 已完成 | 环境变量白名单、路径校验、日志落盘 |
| 多阶段生成流程 | 已完成 | 风格确认 → 大纲确认 → 草稿修改 → 最终导出；见 4.2 |
| Win7 内嵌 Python | 部分完成 | Python 3.8 语法兼容；仍需实机验证 |

## 4. 使用流程

### 4.1 当前已实现流程（五阶段）

1. 侧边栏进入「扩展包」，安装 `ppt-master-extension-1.2.1-win7-x64.zip`
2. 启用扩展，侧边栏出现「PPT 生成」
3. **素材与设置**：搜索并添加文档，或点击「添加本地文件」；AI 会根据素材建议标题与汇报对象
4. 按需调整标题、汇报对象、导出目录、语言与额外要求，点击「下一步：选择风格」
5. **风格确认**：版式卡片展示封面预览、中文名与说明；选择版式、图表模板与原生图表开关，点击「生成大纲」
6. **大纲确认**：调整页序、标题、核心信息与要点；可设置目标页数并点击「重新生成大纲」，或直接点击「确认大纲，生成草稿」
7. **草稿修改**：左侧切换页面，右侧预览 SVG 并编辑当前页内容；支持增删页与页序调整，点击「重新生成草稿」刷新
8. **最终导出**：确认草稿后点击「导出 PPTX」，完成后打开 PPT、工程目录，或在「历史作业」中继续/重试/导出诊断包

> 阶段可自由回退。未修改内容时，前进按钮会直接回到下一阶段，不会重新调用 AI 或重新渲染；修改大纲后需重新生成草稿，修改版式后进入草稿阶段会自动重新渲染一次。

### 字段说明

| 字段 | 必填 | 用途 |
|---|---|---|
| PPT 标题 | 是 | AI 主题、任务名、导出文件名、设计说明标题 |
| 汇报对象 | 否 | 影响 AI 内容深度、语气、案例与页面组织 |
| 版式模板 | 否 | 选择页面骨架并填充占位符 |
| 图表模板 | 否 | 读取类型与配色，绘制并嵌入图表 |
| 页数 | — | 当前设置页暂不提供手动页数，由 AI 根据素材自动决定；后端仍保留 1–40 页能力 |

### 4.2 五阶段流程（已实现）

流程拆成五个可回退阶段，详细设计见 [ppt-extension.md](./ppt-extension.md) 的 4.2 节：

```
素材与设置 → 风格确认 → 大纲确认 → 草稿修改 → 最终导出
```

| 步骤 | 交互 | 状态 |
|---|---|---|
| 素材与设置 | 选择文档/本地文件，AI 建议标题与汇报对象 | 已完成 |
| 风格确认 | 版式卡片展示封面预览、中文名称与说明，确认版式/图表/原生图表 | 已完成 |
| 大纲确认 | 调整页序、标题、核心信息、要点 | 已完成 |
| 草稿修改 | 预览 `svg_output` 页面，修改当前页内容并重新生成草稿 | 已完成 |
| 最终导出 | 确认草稿后执行质量门禁并导出 PPTX | 已完成 |

关键设计：

- 作业增加 `stage` 字段：`outline_ready / rendering_draft / draft_ready / exporting / done`（风格确认在创建作业前完成，作业初始为 `outline_ready`）
- 引擎增加 `options.stage`：
  - `render`：只生成 `project/svg_output/*.svg`，不导出
  - `export`：跳过渲染，直接对现有草稿执行质量检查与导出
  - `full`：保持当前一次性行为，兼容旧流程
- 新增命令：`ppt_extension_render_draft` / `rerender_draft` / `export_draft` / `list_draft_pages` / `read_draft_page`
- 大纲或版式变化会清空旧 `svg_output`；重新渲染前引擎也会清理旧 SVG
- 第一版草稿修改只做内容级编辑（标题、核心信息、要点、页序），不做 SVG 元素自由拖拽
- 风格确认使用版式首张封面 SVG 作为预览，不新增图片渲染依赖

## 5. 技术实现

### 5.1 扩展包

- 安装目录：`<app_data>/extensions/ppt-master/versions/<version>/`
- 清单：`extension.json`
- 入口：`entry.py`
- 运行协议：stdout JSONL，协议版本 1
- 运行器：固定入口、工作目录锁定在作业目录、环境变量白名单、可配置超时、进程树取消
- 日志：stdout/stderr 同时写入 `<job>/logs/engine.log`
- 路径安全：入口与内嵌 Python 均需 canonicalize 到扩展目录内
- 完整性：`checksums.json` 逐文件哈希；可选 Ed25519 签名，公钥通过 `PPT_EXTENSION_PUBLIC_KEY` 配置

### 5.2 多素材收集

- 笔记：搜索结果按 `page` / `page_size` 查询
- 本地文件：
  - 前端添加时只记录路径与标题，不立即解析正文
  - 创建作业时由 Rust 后端统一提取一次，避免前端解析 + 全文 IPC 回传
  - Markdown / TXT：自动编码识别
  - PDF：`PdfService`
  - Word：`DocExtractService`
  - Excel：`ExcelImportService`
- 单文件上限 40,000 字符，总素材上限 200,000 字符
- 生成 `input/source.md` 与 `input/source_manifest.json`

### 5.3 AI 大纲

- 添加素材后，先调用 `ppt_extension_suggest_meta` 根据素材标题/摘要建议 PPT 标题与汇报对象
- 标题/汇报对象被用户手动修改后不再自动覆盖
- 主程序 `AiService::complete_once`
- 提示词包含标题、汇报对象、额外要求与素材
- 默认最多尝试 2 次；超时、非法 JSON 或空大纲都会触发重试/降级
- 规划阶段支持取消（`ppt_extension_cancel_planning`）
- 生成后进入交互式大纲确认，`plan.json` 与 `job.json` 同步更新
- 大纲页可设置目标页数并「重新生成大纲」；复用 `input/source.md` 与标题/听众/额外要求，只重跑 AI 规划
- 页数与 AI 模型会写入 `job.json` 的 `options.slideCount` / `options.modelId`，便于后续重生成
- 可输出 `chart` 字段：

```json
{
  "type": "line|column|bar|pie|donut|area|gantt",
  "categories": ["..."],
  "series": [{ "name": "...", "values": [1, 2, 3] }]
}
```

- AI 失败时按文档标题生成后备大纲

### 5.4 版式渲染

- 当前内置 7 个中文场景模板：KPI 报告、浅色学术讲解、航空维修蓝、MBB 高密度咨询报告、高端战略深色、东方古典研究、科技工具对比
- 选择框显示中文模板名，并在选项下方显示模板说明
- 读取 `templates/layouts/<id>/templates/*.svg`
- 按页型选择：封面、章节、目录、内容、卡片、结尾
- 支持两类版式：
  - `{{PLACEHOLDER}}`：沿用原有正则填充
  - `data-pptx-placeholder`：解析 SVG 结构，按 title / content / chart / page_num / toc_item_N 等键填充
- `{{CONTENT_AREA}}` 与结构化 `content` 占位符都会替换为多行要点块
- `content_cards` 的“模块标题”替换为实际要点
- 版式资源复制到 `project/templates/layout_<id>/`
- `extension_ppt_catalog` 返回 `layoutSupport`，数据在构建期写入 `layouts_index.json`，运行时只读索引
- 首屏 `ppt_extension_status` 不再对扩展目录做哈希；完整性校验保留在扩展管理页的「校验」按钮
- 两类占位符都不存在的版式回退内置渲染器

### 5.5 图表渲染

- 图表模板选择框显示中文名称与用途说明（`src/lib/pptCharts.ts`），覆盖 33 种模板
- 读取图表模板 metadata 中的类型与 `style.colors`
- 支持柱状、条形、折线、面积、饼图、环形图、雷达、散点、甘特（SVG 路径）
- 其他类型回退柱状图
- 默认绘制为可编辑 SVG 片段，嵌入内容区域
- 开启「原生 PowerPoint 图表」后，图表页使用 python-pptx `add_chart` 生成原生图表对象
- 原生图表失败时自动回退 SVG/纯文本
- 图例显示分类、数值与百分比

### 5.6 质量门禁与导出

- `spec_lock.md` 声明字号角色：`caption 14`、`label 15`、`body_small 20`、`body 24`、`page_title 32`、`section_title 37`、`title 44`
- 文本超出画布时自动缩小/换行
- 导出前会把版式的 `images/`、`assets/` 等资源复制到工程根目录，确保 SVG 中的 `../images/...` 能被 `svg_to_pptx.py` 解析
- 质量检查通过后调用 `svg_to_pptx.py` 原生导出
- 质量检查或原生导出失败时回退 python-pptx
- 回退产物为纯文本，不含版式/配色，仅作为兜底；若模板含外部图片，请优先检查 `project/images/` 是否存在

### 5.7 流式进度与交互

- Rust 阶段日志：素材收集、AI 规划、作业创建、引擎启动
- 引擎 JSONL 解析为可读进度/日志，并持久化到 `logs/engine.log`
- 事件：`ppt-extension://log` / `job` / `done` / `error`
- 支持取消大纲规划、草稿渲染与导出
- 支持大纲预览/编辑后再生成草稿
- 草稿阶段完成推送 `stage=draft_ready`，导出完成推送 `stage=done`
- 历史作业可按 `stage` 继续到风格/大纲/草稿/导出步骤
- 暂不支持暂停/继续与单页增量重渲染

## 6. 目录与产物

```
<app_data>/
├── extensions/ppt-master/versions/<version>/
└── ppt-workspace/<jobId>/
    ├── job.json
    ├── plan.json
    ├── input/source.md
    ├── input/source_manifest.json
    ├── project/
    │   ├── design_spec.md
    │   ├── spec_lock.md
    │   ├── slide_plan.json
    │   ├── templates/layout_<id>/
    │   ├── svg_output/
    │   └── exports/
    ├── output/*.pptx
    └── logs/
        └── engine.log
```

中间文件默认保留，导出目录只复制 pptx。

## 7. 构建与安装

使用 `D:\AI\ALL-PPT\ppt-master-main` 构建 Lite 包（不含 Python）：

```bash
node scripts/build-ppt-extension.mjs \
  --ppt-master-root "D:/AI/ALL-PPT/ppt-master-main"
```

输出：

```
dist/extensions/ppt-master-extension-1.2.1-win7-x64.zip
```

Lite 包前置条件：

- 系统 `python` 3.8+（推荐 3.10+）
- 安装 `python-pptx`

完整包（含内嵌 Python）：

```bash
node scripts/build-ppt-extension.mjs \
  --ppt-master-root "D:/AI/ALL-PPT/ppt-master-main" \
  --python-runtime "<python-embed 目录>"
```

可选签名：

```bash
node scripts/build-ppt-extension.mjs \
  --ppt-master-root "D:/AI/ALL-PPT/ppt-master-main" \
  --signing-key "D:/keys/extension-private.pem"
```

构建日志会输出 base64 公钥；主程序通过环境变量
`PPT_EXTENSION_PUBLIC_KEY` 配置后才会接受带签名的包。

## 8. 验证结果

- `cargo check` 通过
- `cargo test services::ppt_plan`：4 项通过
- `cargo test services::extension`：6 项通过（含 Ed25519 验签、结构化 layout 探测）
- `cargo test services::ppt_extension`：4 项通过（含 AI 元信息清洗与降级）
- `python -m unittest discover -s extensions/ppt-master/tests`：8 项通过
- `npx tsc --noEmit` 通过
- `npx vitest run`：45 文件 / 532 测试通过
- 真实 13 页作业原生导出成功
- 当前 7 个内置 layout（kpi_report_core / insight_explainer / aviation_training_blue / mbb_dense_report / premium_strategy_dark / oriental_classic_research / tech_compare_dark）全部通过质量门禁与原生导出
- 结构化槽位按 `data-pptx-bounds` 排版，修复小槽位文本溢出与图表负高度
- 非 16:9 画布自动写入正确的 `spec_lock` viewBox/format
- `ppt_extension_suggest_meta`：4 项 Rust 单元测试通过
- 首屏性能优化：本地文件延迟提取、状态不哈希全目录、版式支持度构建期索引
- PPTX 内含 `solidFill` / `gradFill` / `pattFill` 与页面背景
- 卡片页已填充实际要点
- 封面长标题/副标题自动换行

## 9. 后续工作

### 已完成（截至 1.2.1）

- 结构化 layout 支持：解析 `data-pptx-placeholder`
- 原生 PowerPoint 图表对象（可选开关）
- 交互式生成：生成大纲 → 用户预览/编辑 → 渲染
- 素材元信息建议：自动填充标题与汇报对象
- 作业历史、重试、删除、清理与诊断包
- 扩展包签名（Ed25519）与版本回滚
- 运行器环境变量白名单、路径校验、日志落盘、pptx 结构校验
- 7 个中文场景模板修复与质量门禁通过
- 首屏性能优化与构建期版式索引
- Python 3.8 语法兼容审计
- 多阶段生成：风格确认、草稿 SVG 预览/内容编辑、确认后导出
- 作业 `stage` 持久化与历史作业按阶段续作
- 草稿页受控读取与版式封面预览

### 待继续

- Win7 内嵌 Python 实机验证与兼容构建
- 模板注册与版本管理：brand / deck / 多模板融合
- 原生图表与版式融合（当前原生图表模式下图表页不沿用版式）
- 暂停/继续、草稿阶段单页重渲染
- 自动化测试：Rust 作业集成测试、Python 渲染黄金样例、前端交互测试

## 10. 已知限制

- 结构化 layout 依赖 `data-pptx-placeholder` 命名约定；未标注的复杂模板仍会回退
- 原生图表模式下图表页不沿用版式模板；默认仍使用 SVG 图表片段
- AI 大纲质量依赖所选模型
- Lite 包依赖系统 Python 与 `python-pptx`
- 签名是可选能力；未签名的本地 zip 仍依赖哈希与来源信任
- 草稿修改只支持内容级编辑（标题/核心信息/要点/页序），不支持 SVG 元素拖拽
- 重新生成草稿会渲染全部页面，尚不支持单页增量重渲染
- 版式封面预览使用首张封面 SVG；模板外部字体/图片在 WebView 预览中可能缺失
- Win7 需要可运行于该平台的 Python 构建，仍需实机验证

## 11. 版本记录

| 版本 | 内容 |
|---|---|
| 1.0.0 | 扩展包框架、PPT 页、确定性 SVG 渲染、python-pptx/svg_to_pptx 导出 |
| 1.0.1 | aviation_training_blue 版式索引注入、本地文件素材、分页搜索 |
| 1.0.2 | layout 页型选择与占位填充、图表片段嵌入 |
| 1.0.3 | 修复质量门禁回退导致的样式丢失；字号角色、长文本自适应、卡片要点填充 |
| 1.1.0 | 交互式大纲、作业历史/重试/诊断、结构化 layout、原生图表、签名与回滚、运行器加固 |
| 1.1.1 | 修复 8 个内置模板的质量门禁失败与纯文本回退；结构化槽位按 bounds 排版；非 16:9 画布与字号角色自动对齐 |
| 1.1.2 | 同步上游 7 个中文场景模板；版式选择框显示中文名与说明；扩展通用占位符解析 |
| 1.1.3 | 首屏性能优化：本地文件延迟提取、状态不再哈希全目录、版式支持度改为构建期索引 |
| 1.2.0 | 五阶段生成流程：风格封面预览、草稿渲染与页面预览/编辑、确认后导出；作业 stage 持久化；阶段前进复用；大纲页数设置与重新生成；图表模板中文名与说明 |
| 1.2.1 | 修复模板外部图片未复制导致 `svg_to_pptx` 失败并回退纯文本；导出阶段自动补齐版式 images/assets |

## 12. 关键文件

| 路径 | 作用 |
|---|---|
| `src-tauri/src/services/extension.rs` | 扩展包安装/校验/启停 |
| `src-tauri/src/services/extension_runner.rs` | 子进程、环境白名单、JSONL 事件与日志 |
| `src-tauri/src/services/ppt_extension.rs` | 素材收集/AI 规划/作业/重试/诊断 |
| `src-tauri/src/services/ppt_plan.rs` | 大纲规范化、校验与原子读写 |
| `src-tauri/src/commands/extension.rs` | 扩展包 Command |
| `src-tauri/src/commands/ppt_extension.rs` | PPT 作业 Command |
| `src/pages/extensions/index.tsx` | 扩展管理页 |
| `src/pages/ppt/index.tsx` | PPT 生成页、大纲编辑、历史作业 |
| `src/lib/api/extension.ts` | 前端 API 封装 |
| `src/lib/pptPlan.ts` | 前端大纲编辑纯函数 |
| `src/lib/pptLayouts.ts` | 版式中文名称与说明映射 |
| `src/types/extension.ts` | 前端类型 |
| `extensions/ppt-master/entry.py` | Python Executor（结构化 layout / 原生图表） |
| `extensions/ppt-master/extension.json` | 扩展清单（1.2.1） |
| `extensions/ppt-master/tests/test_entry.py` | Python 纯函数测试 |
| `scripts/build-ppt-extension.mjs` | 扩展包构建与可选签名 |
| `docs/ppt-extension.md` | 详细设计文档 |
