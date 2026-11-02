---
layout_id: kpi_report_core
kind: layout
category: scenario
summary: 中性 KPI 报告结构，覆盖年度回顾、区域经济财政与指标型汇报。
keywords: [kpi, report, annual-review, fiscal, dashboard]
canvas_format: ppt169
canvas_width: 1280
canvas_height: 720
canvas_viewbox: "0 0 1280 720"
source_canvas_width: 1280
source_canvas_height: 720
source_viewbox: "0 0 1280 720"
replication_mode: standard
native_structure_mode: structured
page_count: 12
page_types: [cover, toc, key_findings, kpi_overview, trend_chart, structure_breakdown, performance_table, risk_gauge, comparison, annual_review, summary_table, ending]
placeholders:
  01_cover: ['{{TITLE}}', '{{SUBTITLE}}', '{{ORGANISATION}}', '{{DATE}}']
  02_toc: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{SECTION_1_TITLE}}', '{{SECTION_1_DESC}}', '{{SECTION_2_TITLE}}', '{{SECTION_2_DESC}}', '{{SECTION_3_TITLE}}', '{{SECTION_3_DESC}}', '{{SECTION_4_TITLE}}', '{{SECTION_4_DESC}}']
  03_key_findings: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{FINDING_1_TITLE}}', '{{FINDING_1_DETAIL}}', '{{FINDING_1_METRIC}}', '{{FINDING_2_TITLE}}', '{{FINDING_2_DETAIL}}', '{{FINDING_2_METRIC}}', '{{FINDING_3_TITLE}}', '{{FINDING_3_DETAIL}}', '{{FINDING_3_METRIC}}', '{{KEY_IMPLICATION}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  04_kpi_overview: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{KPI_1_VALUE}}', '{{KPI_1_DELTA}}', '{{KPI_2_VALUE}}', '{{KPI_2_DELTA}}', '{{KPI_3_VALUE}}', '{{KPI_3_DELTA}}', '{{KPI_4_VALUE}}', '{{KPI_4_DELTA}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  05_trend_chart: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{INSIGHT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  06_structure_breakdown: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{SEGMENT_1_LABEL}}', '{{SEGMENT_1_VALUE}}', '{{SEGMENT_2_LABEL}}', '{{SEGMENT_2_VALUE}}', '{{SEGMENT_3_LABEL}}', '{{SEGMENT_3_VALUE}}', '{{SEGMENT_4_LABEL}}', '{{SEGMENT_4_VALUE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  07_performance_table: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{ROW_1_DATA}}', '{{ROW_2_DATA}}', '{{ROW_3_DATA}}', '{{ROW_4_DATA}}', '{{ROW_5_DATA}}', '{{ROW_6_DATA}}', '{{TABLE_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  08_risk_gauge: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{RISK_SCORE}}', '{{RISK_REGISTER}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  09_comparison: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{COMPARE_1_DETAIL}}', '{{COMPARE_2_DETAIL}}', '{{COMPARE_3_DETAIL}}', '{{COMPARISON_INSIGHT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  10_annual_review: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{PROJECT_1_TITLE}}', '{{PROJECT_1_DETAIL}}', '{{PROJECT_1_IMPACT}}', '{{PROJECT_2_TITLE}}', '{{PROJECT_2_DETAIL}}', '{{PROJECT_2_IMPACT}}', '{{PROJECT_3_TITLE}}', '{{PROJECT_3_DETAIL}}', '{{PROJECT_3_IMPACT}}', '{{QUARTER_1_HIGHLIGHT}}', '{{QUARTER_2_HIGHLIGHT}}', '{{QUARTER_3_HIGHLIGHT}}', '{{QUARTER_4_HIGHLIGHT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  11_summary_table: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{SUMMARY_ROW_1}}', '{{SUMMARY_ROW_2}}', '{{SUMMARY_ROW_3}}', '{{SUMMARY_ROW_4}}', '{{SUMMARY_ROW_5}}', '{{SUMMARY_ROW_6}}', '{{SUMMARY_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  12_ending: ['{{THANK_YOU}}', '{{ENDING_SUBTITLE}}', '{{CONTACT_INFO}}']
---

# KPI Report Core — Design Specification

## IV. Signature Design Elements

- 顶部 4 px 中性识别线；内容页统一标题/副标题/页脚结构。
- 指标卡：浅色面板 + 左侧强调条 + 大号数值 + 变化值。
- 趋势页：柱状图 + 折线覆盖 + 右侧解读栏。
- 结构页：环形分段 + 图例 + 百分比。
- 表格页：固定表头、行分隔与整行内容槽。
- 仪表页：半圆三段阈值 + 指针 + 右侧风险登记册。
- 全部颜色为中性预览值，不代表任何品牌身份；下游由 Brand/Style 覆盖。

## V. Page Roster

| File | Layout key | Picker name | Content shape and slot behavior |
|---|---|---|---|
| `01_cover.svg` | `cover` | Cover | 封面：标题、副标题、机构与日期；右侧抽象指标条。 |
| `02_toc.svg` | `toc` | Table of Contents | 四项目录：编号、标题、说明。 |
| `03_key_findings.svg` | `key-findings` | Key Findings | 三项核心发现卡 + 底部关键含义带。 |
| `04_kpi_overview.svg` | `kpi-overview` | KPI Overview | 四指标卡 + 基准对比条。 |
| `05_trend_chart.svg` | `trend-chart` | Trend Chart | 六期柱状趋势 + 折线 + 右侧解读。 |
| `06_structure_breakdown.svg` | `structure-breakdown` | Structure Breakdown | 环形结构 + 四段图例 + 百分比。 |
| `07_performance_table.svg` | `performance-table` | Performance Table | 六行指标表，整行内容槽。 |
| `08_risk_gauge.svg` | `risk-gauge` | Risk Gauge | 半圆风险仪表 + 风险登记册。 |
| `09_comparison.svg` | `comparison` | Comparison | 现状/基准/差距三列对比。 |
| `10_annual_review.svg` | `annual-review` | Annual Review | 三张项目卡 + 四季度时间线。 |
| `11_summary_table.svg` | `summary-table` | Summary Table | 六行关键指标汇总表。 |
| `12_ending.svg` | `ending` | Ending | 居中结束页：感谢语、副标题与联系方式。 |
