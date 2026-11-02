---
layout_id: mbb_dense_report
kind: layout
category: scenario
summary: 高密度咨询报告结构，覆盖行动标题、关键信息带、指标看板、重要性-绩效矩阵、根因、战略支柱、举措排序与路线图。
keywords: [consulting, dense, strategy, kpi, decision]
canvas_format: ppt169
canvas_width: 1280
canvas_height: 720
canvas_viewbox: "0 0 1280 720"
source_canvas_width: 1280
source_canvas_height: 720
source_viewbox: "0 0 1280 720"
replication_mode: standard
native_structure_mode: structured
page_count: 9
page_types: [cover, executive_summary, metrics_dashboard, distribution, importance_performance, root_cause, strategy_pillars, initiative_priority, roadmap]
placeholders:
  01_cover: ['{{TITLE}}', '{{SUBTITLE}}', '{{CLIENT}}', '{{DATE}}', '{{REFERENCE}}']
  02_executive_summary: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{KEY_MESSAGE}}', '{{METRIC_1_VALUE}}', '{{METRIC_2_VALUE}}', '{{METRIC_3_VALUE}}', '{{COLUMN_1_TEXT}}', '{{COLUMN_2_TEXT}}', '{{COLUMN_3_TEXT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  03_metrics_dashboard: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{KPI_1_VALUE}}', '{{KPI_2_VALUE}}', '{{KPI_3_VALUE}}', '{{KPI_4_VALUE}}', '{{INSIGHT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  04_distribution: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{INSIGHT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  05_importance_performance: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{INSIGHT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  06_root_cause: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{CAUSE_1_TITLE}}', '{{CAUSE_1_DETAIL}}', '{{CAUSE_2_TITLE}}', '{{CAUSE_2_DETAIL}}', '{{CAUSE_3_TITLE}}', '{{CAUSE_3_DETAIL}}', '{{CAUSE_4_TITLE}}', '{{CAUSE_4_DETAIL}}', '{{ROOT_CAUSE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  07_strategy_pillars: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{PILLAR_1_TITLE}}', '{{PILLAR_1_KPI}}', '{{PILLAR_1_DETAIL}}', '{{PILLAR_2_TITLE}}', '{{PILLAR_2_KPI}}', '{{PILLAR_2_DETAIL}}', '{{PILLAR_3_TITLE}}', '{{PILLAR_3_KPI}}', '{{PILLAR_3_DETAIL}}', '{{PILLAR_4_TITLE}}', '{{PILLAR_4_KPI}}', '{{PILLAR_4_DETAIL}}', '{{PROGRAMME_LINK}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  08_initiative_priority: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{INITIATIVE_1}}', '{{INITIATIVE_1_VALUE}}', '{{INITIATIVE_2}}', '{{INITIATIVE_2_VALUE}}', '{{INITIATIVE_3}}', '{{INITIATIVE_3_VALUE}}', '{{INITIATIVE_4}}', '{{INITIATIVE_4_VALUE}}', '{{INITIATIVE_5}}', '{{INITIATIVE_5_VALUE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  09_roadmap: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{MILESTONE_1}}', '{{MILESTONE_2}}', '{{MILESTONE_3}}', '{{MILESTONE_4}}', '{{DELIVERY_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
---

# High-Density Consulting Report — Design Specification

## IV. Signature Design Elements

- 顶部 6 px 识别线贯穿全部页面（预览值，可由下游身份覆盖）。
- 行动标题式页眉：标题即结论，副标题补充证据范围。
- 关键信息横带把整页结论前置。
- 指标卡采用左侧 5 px 竖条 + 浅色面板。
- 矩阵页使用四象限底、中央十字轴和编号气泡。
- 页脚固定为来源行 + 右对齐页码，保持报告可追溯性。

## V. Page Roster

| File | Layout key | Picker name | Content shape and slot behavior |
|---|---|---|---|
| `01_cover.svg` | `cover` | Cover | 封面：标题、副标题、客户、日期与参考号；无页码。 |
| `02_executive_summary.svg` | `executive-summary` | Executive Summary | 行动标题 + 关键信息带 + 三项指标 + 三列结论。 |
| `03_metrics_dashboard.svg` | `metrics-dashboard` | Metrics Dashboard | 四指标卡 + 趋势柱状图 + 右侧解读。 |
| `04_distribution.svg` | `distribution` | Distribution | 两组分布条 + 底部含义带。 |
| `05_importance_performance.svg` | `importance-performance-matrix` | Importance-Performance Matrix | 四象限矩阵 + 编号气泡 + 右侧阅读说明。 |
| `06_root_cause.svg` | `root-cause` | Root Cause | 四列根因 + 底部根因结论带。 |
| `07_strategy_pillars.svg` | `strategy-pillars` | Strategy Pillars | 四根支柱 + KPI + 底部项目联动。 |
| `08_initiative_priority.svg` | `initiative-priority` | Initiative Priority | 影响力/成本图 + 五项优先级排序。 |
| `09_roadmap.svg` | `roadmap` | Roadmap | 四季度 × 四工作流路线图 + 交付说明。 |
