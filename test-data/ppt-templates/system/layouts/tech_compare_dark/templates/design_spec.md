---
layout_id: tech_compare_dark
kind: layout
category: scenario
summary: 科技工具对比结构，覆盖工具定位、工具档案、核心区别、数据对比、组合方案、决策树、对照表与总结。
keywords: [tech, comparison, product, decision, matrix]
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
page_types: [cover, positioning, product_card, core_difference, data_comparison, combination, decision_tree, comparison_table, summary]
placeholders:
  01_cover: ['{{TITLE}}', '{{SUBTITLE}}']
  02_positioning: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{TOOL_1_NAME}}', '{{TOOL_1_POSITIONING}}', '{{TOOL_1_STAGE}}', '{{TOOL_1_NOTE}}', '{{TOOL_2_NAME}}', '{{TOOL_2_POSITIONING}}', '{{TOOL_2_STAGE}}', '{{TOOL_2_NOTE}}', '{{TOOL_3_NAME}}', '{{TOOL_3_POSITIONING}}', '{{TOOL_3_STAGE}}', '{{TOOL_3_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  03_product_card: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{TOOL_NAME}}', '{{TAGLINE}}', '{{ORIGIN}}', '{{INSTALL_COMMAND}}', '{{INFO_1}}', '{{INFO_2}}', '{{INFO_3}}', '{{INFO_4}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  04_core_difference: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{DIFF_ROW_1}}', '{{DIFF_ROW_2}}', '{{DIFF_ROW_3}}', '{{DIFF_ROW_4}}', '{{DIFF_ROW_5}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  05_data_comparison: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{DATA_INSIGHT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  06_combination: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{STAGE_1_TOOL}}', '{{STAGE_1_DETAIL}}', '{{STAGE_2_TOOL}}', '{{STAGE_2_DETAIL}}', '{{STAGE_3_TOOL}}', '{{STAGE_3_DETAIL}}', '{{COMBINATION_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  07_decision_tree: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{ROOT_QUESTION}}', '{{BRANCH_1_QUESTION}}', '{{BRANCH_2_QUESTION}}', '{{BRANCH_3_QUESTION}}', '{{OUTCOME_1}}', '{{OUTCOME_2}}', '{{OUTCOME_3}}', '{{DECISION_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  08_comparison_table: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{MATRIX_ROW_1}}', '{{MATRIX_ROW_2}}', '{{MATRIX_ROW_3}}', '{{MATRIX_ROW_4}}', '{{MATRIX_ROW_5}}', '{{MATRIX_ROW_6}}', '{{MATRIX_ROW_7}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  09_summary: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{TAKEAWAY_1_TITLE}}', '{{TAKEAWAY_1_DETAIL}}', '{{TAKEAWAY_2_TITLE}}', '{{TAKEAWAY_2_DETAIL}}', '{{TAKEAWAY_3_TITLE}}', '{{TAKEAWAY_3_DETAIL}}', '{{RESOURCE_1}}', '{{RESOURCE_1_NOTE}}', '{{RESOURCE_2}}', '{{RESOURCE_2_NOTE}}', '{{RESOURCE_3}}', '{{RESOURCE_3_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
---

# Tech Tool Comparison — Design Specification

## IV. Signature Design Elements

- 顶部 4 px 识别线贯穿全部页面（预览值，可由下游身份覆盖）。
- 深色底 + 面板卡片 + 工具识别色（预览值，可由下游身份覆盖）。
- 封面几何切角 + 三个工具标签。
- 工具卡：左侧名称/定位/来源/安装命令，右侧四项适配信息。
- 决策树：根问题→三分支→三结果；对照表：七维矩阵。
- 代码块使用深底 + 等宽命令。

## V. Page Roster

| File | Layout key | Picker name | Content shape and slot behavior |
|---|---|---|---|
| `01_cover.svg` | `cover` | Cover | 封面：标题/副标题 + 三工具标签 + 几何切角。 |
| `02_positioning.svg` | `positioning` | Positioning | 三列工具定位：工具名、一句话定位、最佳阶段、备注。 |
| `03_product_card.svg` | `product-card` | Product Card | 工具档案：名称、标语、来源、安装命令、四项适配信息。 |
| `04_core_difference.svg` | `core-difference` | Core Difference | 五行核心区别表（维度 / 工具 A / 工具 B）。 |
| `05_data_comparison.svg` | `data-comparison` | Data Comparison | 三工具效率柱状图 + 右侧数据解读。 |
| `06_combination.svg` | `combination` | Combination | 环境→0→1→1→N 三阶段组合方案。 |
| `07_decision_tree.svg` | `decision-tree` | Decision Tree | 根问题→三分支→三结果的选型决策树。 |
| `08_comparison_table.svg` | `comparison-table` | Comparison Table | 七维工具对照表。 |
| `09_summary.svg` | `summary` | Summary | 三条总结 + 三项资源链接。 |
