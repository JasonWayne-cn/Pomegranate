# 助研工作台（Research Assistant）设计与实现

> **已归档：内置助研方案。**
> 当前实现已切换为插件方案，见 [`助研插件.md`](../助研插件.md)。
> 本文保留用于说明早期内置页面与 `research_*` 数据表的设计，旧入口已从导航下线。

> 参考：`D:\AI\xunfei-manufacturing-tech\docs\题目分析.md` 中“3 助研场景”的三大能力：
> 3.1 领域前沿追踪、3.2 学术写作辅助、3.3 科研数据分析。
> 该仓库只有场景描述，没有可直接复用的代码实现，因此本次按 Pomegranate 现有架构重新设计并落地 MVP。

## 1. 目标与边界

### 1.1 目标

围绕高校科研的日常流程，提供一个本地优先的助研工作台：

1. **课题**作为容器，聚合文献、AI 产出与后续写作材料。
2. **文献库**记录论文元数据、摘要与阅读笔记，支持勾选后生成综述。
3. **前沿追踪**基于研究主题生成热点、趋势、机会与检索式。
4. **学术写作**提供论文框架、文献综述、语言润色、规范检查。
5. **数据分析**基于用户粘贴的数据/材料给出分析思路、观察与局限。
6. **产出**可编辑、复制，并可一键导出为普通笔记，进入文档模块继续写。

### 1.2 明确不做（MVP）

- 不做联网检索、文献下载、PDF 全文解析、引文网络抓取。
- 不做自动生成真实参考文献；所有引用必须由用户核验。
- 不做实验数据文件自动读取与统计检验执行；只做文本层面的分析建议。
- 不做多人协作、云端同步专属逻辑（沿用应用现有同步能力）。

### 1.3 关键安全/可信约束

- AI 提示词强制要求：不得虚构论文、作者、期刊、年份、DOI、基金号或数据；无法确认的信息标注“待检索验证”。
- 页面固定展示“AI 不联网检索，文献与数据需人工核验”的提示。
- 文献综述只允许引用用户已录入的文献条目；未提供文献时明确要求“待补充真实文献后生成”。
- 数据分析禁止输出超出材料的因果结论。

## 2. 架构

沿用现有双进程 + 三层架构，不引入新插件或新外部依赖：

```
React /research
├── 课题选择 / 新建 / 编辑 / 删除
├── 文献库（Table + 勾选）
├── 前沿追踪 / 学术写作 / 数据分析（AiWorkbench）
└── 产出（查看 / 编辑 / 导出笔记）
        │  invoke()
        ▼
Rust Commands（commands/research.rs）
        │
        ▼
ResearchService（services/research.rs）
├── CRUD 校验
├── 科研提示词编排
├── 180s 超时
└── 产出导出笔记
        │                    │
        ▼                    ▼
Database（database/research.rs）   AiService::complete_once()
        │                    │
        ▼                    ▼
SQLite v82                现有默认 AI 模型 / Provider
```

### 2.1 为什么复用 `complete_once`

- 现有 AI 对话链路包含会话、流式事件、Agent 工具循环，助研场景更接近“一次性长文生成”。
- `AiService::complete_once` 已经统一处理 Provider 协议、默认模型与错误中文化。
- 助研结果由用户显式“保存为产出”，不需要每条草稿都写入 AI 会话历史。

### 2.2 为什么产出与笔记分离

- 产出是科研过程稿，可能反复生成、对比、丢弃；直接写入笔记会污染文档库。
- 用户确认后才“导出为笔记”，复用现有 `NoteService`，从而自动获得索引、同步、历史版本等能力。

## 3. 数据模型（SQLite v82）

### 3.1 `research_projects`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| title | TEXT | 课题名称，必填 |
| field | TEXT | 学科 / 研究方向 |
| description | TEXT | 背景、目标、导师要求，作为 AI 上下文 |
| keywords | TEXT | 逗号分隔关键词 |
| status | TEXT | active / paused / archived |
| created_at / updated_at | TEXT | 本地时间 |

### 3.2 `research_literature`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| project_id | INTEGER FK | 级联删除 |
| title | TEXT | 必填 |
| authors | TEXT | 作者 |
| year | INTEGER | 年份，可空 |
| venue | TEXT | 期刊 / 会议 / 出版方 |
| abstract_text | TEXT | 摘要 |
| url | TEXT | DOI / 链接 |
| file_path | TEXT | 本地文件路径（仅记录） |
| notes | TEXT | 阅读笔记 / 摘录 |
| tags | TEXT | 逗号分隔标签 |
| status | TEXT | to_read / reading / read |
| created_at / updated_at | TEXT | 本地时间 |

索引：`(project_id, updated_at DESC)`。

### 3.3 `research_outputs`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| project_id | INTEGER FK | 级联删除 |
| kind | TEXT | frontier / review / outline / polish / format / analyze / note |
| title | TEXT | 产出标题 |
| content | TEXT | Markdown 正文 |
| source_ref | TEXT | 来源（模型名、文献 id 列表等） |
| created_at / updated_at | TEXT | 本地时间 |

索引：`(project_id, updated_at DESC)`。

## 4. IPC API

| Command | 入参 | 返回 |
|---|---|---|
| `research_list_projects` | — | `ResearchProject[]` |
| `research_create_project` | `input` | `ResearchProject` |
| `research_update_project` | `id`, `input` | `ResearchProject` |
| `research_delete_project` | `id` | `bool` |
| `research_list_literature` | `projectId` | `ResearchLiterature[]` |
| `research_create_literature` | `projectId`, `input` | `ResearchLiterature` |
| `research_update_literature` | `id`, `input` | `ResearchLiterature` |
| `research_delete_literature` | `id` | `bool` |
| `research_list_outputs` | `projectId` | `ResearchOutput[]` |
| `research_create_output` | `projectId`, `input` | `ResearchOutput` |
| `research_update_output` | `id`, `title`, `content` | `ResearchOutput` |
| `research_delete_output` | `id` | `bool` |
| `research_export_output_to_note` | `outputId`, `folderId?` | `Note` |
| `research_ai_generate` | `request` | `{ content, modelName }` |

### 4.1 `ResearchAiRequest`

```ts
{
  mode: "frontier" | "review" | "outline" | "polish" | "format" | "analyze";
  projectId?: number;
  topic?: string;
  content?: string;
  literatureIds?: number[];
  extra?: string;
  modelId?: number | null;
}
```

服务端会校验 mode、必填项、课题存在性，并截断超长输入：
- 单次正文上限 40,000 字符；
- 单篇摘要 / 笔记上限 1,200 字符；
- 综述最多纳入 30 篇文献；
- 超时 180 秒。

## 5. 提示词策略

所有模式共享系统约束（不得虚构、区分事实与推断、中文 Markdown、不寒暄），再按模式追加任务结构：

| 模式 | 输入 | 输出结构 |
|---|---|---|
| frontier | 主题 + 课题上下文 | 研究热点 / 趋势判断 / 机会与风险 / 建议检索式 / 证据边界 |
| review | 勾选文献 + 主题/补充材料 | 背景与问题 / 研究脉络 / 观点对比表 / 研究缺口 / 可推进问题 / 参考文献 |
| outline | 题目/主题 + 已有材料 | 题目建议 / 摘要要点 / 关键词 / 章节框架 / 方法与数据 / 写作顺序与风险 |
| polish | 原文 + 风格 | 润色后文本 / 主要修改说明表 |
| format | 原文 + 检查重点 | 问题清单表 / 修改后文本 / 仍需人工确认 |
| analyze | 数据材料 + 研究问题 | 数据概况 / 可执行分析 / 初步观察 / 可视化建议 / 结论与局限 |

## 6. 页面信息架构

```
/research
┌────────────────────────────────────────────────────────────┐
│ 助研工作台         [课题选择器] [新建] [编辑] [删除]          │
├────────────────────────────────────────────────────────────┤
│ 概览 │ 文献库 │ 前沿追踪 │ 学术写作 │ 数据分析 │ 产出        │
├────────────────────────────────────────────────────────────┤
│ 概览：统计卡 + 课题说明 + 快捷入口 + 最近产出                 │
│ 文献库：搜索 / 新增 / 勾选 / 生成综述 / 编辑 / 删除           │
│ 前沿追踪：主题 + 补充材料 + 额外要求 → Markdown 结果          │
│ 学术写作：框架 / 综述 / 润色 / 规范检查（Segmented 切换）      │
│ 数据分析：研究问题 + 数据材料 → 分析建议                      │
│ 产出：列表 / 详情抽屉 / 编辑 / 复制 / 导出笔记 / 删除         │
└────────────────────────────────────────────────────────────┘
```

### 6.1 关键交互

- 课题选择持久化在 `localStorage["research.currentProjectId"]`。
- 切换课题自动重载文献与产出，并清理失效的文献勾选。
- 文献库勾选后，点“用选中文献生成综述”直接切到「学术写作 → 文献综述」并保留勾选。
- AI 生成期间显示加载态；结果区可复制、保存为产出。
- 产出详情抽屉支持编辑标题/正文；导出笔记调用后端创建普通笔记。

## 7. 文件清单

### 后端

- `src-tauri/src/models/research.rs`
- `src-tauri/src/database/research.rs`
- `src-tauri/src/services/research.rs`
- `src-tauri/src/commands/research.rs`
- `src-tauri/src/database/schema.rs`（v81 → v82）
- `src-tauri/src/lib.rs`（命令注册）

### 前端

- `src/types/research.ts`
- `src/lib/api/research.ts`
- `src/pages/research/index.tsx`
- `src/pages/research/AiWorkbench.tsx`
- `src/pages/research/LiteraturePanel.tsx`
- `src/pages/research/OutputsPanel.tsx`
- `src/modules/help/research.md`
- `src/Router.tsx`、`src/store/index.ts`、`src/modules/registry.ts`、
  `src/components/layout/ActivityBar.tsx`、`src/components/layout/Sidebar.tsx`、
  `src/pages/feature-toggle/index.tsx`

## 8. 迭代计划

### 已完成（MVP）

- 课题 / 文献 / 产出 CRUD 与 SQLite 迁移。
- 五种 AI 工作流 + 统一可信约束。
- 文献勾选生成综述、结果保存、产出编辑与导出笔记。
- 桌面入口、可选视图开关、帮助文档。

### 后续可做

1. **文献文件导入**：从本地 PDF/Word 抽取标题、摘要与正文，复用 `services/pdf.rs` / `doc_extract.rs`。
2. **引用管理**：BibTeX / RIS 导入导出，引用编号与参考文献表自动对齐。
3. **联网检索**：通过 Rust 代理接入 arXiv / Crossref / Semantic Scholar，返回真实元数据后再喂给 AI。
4. **数据文件分析**：复用 `dataset` / `excel_import`，生成可交互图表而非仅文本建议。
5. **课题归档与检索**：跨课题搜索文献与产出，接入现有全文索引。
6. **提示词模板化**：允许用户维护自己的“综述风格”“开题报告模板”，复用 `prompt_templates`。
