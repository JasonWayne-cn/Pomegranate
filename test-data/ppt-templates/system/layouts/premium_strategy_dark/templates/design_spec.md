---
layout_id: premium_strategy_dark
kind: layout
category: scenario
summary: 高端战略评估结构，覆盖封面、目录、执行摘要、项目定位、技术参数、商业模式、融资结构、风险矩阵、宏观危机、结论、展望与附录。
keywords: [strategy, assessment, infrastructure, risk, report]
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
page_types: [cover, toc, executive_summary, project_positioning, technical_params, business_model, financing_structure, risk_matrix, macro_crisis, conclusions, outlook, appendix]
placeholders:
  01_cover: ['{{TITLE}}', '{{SUBTITLE}}', '{{META_LINE}}', '{{CONTEXT_LINE}}']
  02_toc: ['{{SECTION_1_TITLE}}', '{{SECTION_2_TITLE}}', '{{SECTION_3_TITLE}}', '{{SECTION_4_TITLE}}', '{{SECTION_5_TITLE}}', '{{SECTION_6_TITLE}}']
  03_executive_summary: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{KPI_1_VALUE}}', '{{KPI_2_VALUE}}', '{{KPI_3_VALUE}}', '{{KPI_4_VALUE}}', '{{CONCLUSION_1_TITLE}}', '{{CONCLUSION_1_DETAIL}}', '{{CONCLUSION_2_TITLE}}', '{{CONCLUSION_2_DETAIL}}', '{{CONCLUSION_3_TITLE}}', '{{CONCLUSION_3_DETAIL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  04_project_positioning: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{POSITION_STATEMENT}}', '{{POSITION_DETAIL}}', '{{MAP_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  05_technical_params: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{PARAM_1_VALUE}}', '{{PARAM_2_VALUE}}', '{{PARAM_3_VALUE}}', '{{PARAM_4_VALUE}}', '{{PARAM_5_VALUE}}', '{{PARAM_6_VALUE}}', '{{TABLE_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  06_business_model: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{MODEL_1_TITLE}}', '{{MODEL_1_DETAIL}}', '{{MODEL_2_TITLE}}', '{{MODEL_2_DETAIL}}', '{{MODEL_3_TITLE}}', '{{MODEL_3_DETAIL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  07_financing_structure: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{LAYER_1_VALUE}}', '{{LAYER_2_VALUE}}', '{{LAYER_3_VALUE}}', '{{LAYER_4_VALUE}}', '{{FINANCING_RISK}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  08_risk_matrix: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{RISK_REGISTER}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  09_macro_crisis: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{CAUSE_1_TITLE}}', '{{CAUSE_1_DETAIL}}', '{{CAUSE_2_TITLE}}', '{{CAUSE_2_DETAIL}}', '{{CAUSE_3_TITLE}}', '{{CAUSE_3_DETAIL}}', '{{TIMELINE_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  10_conclusions: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{CONCLUSION_1_TITLE}}', '{{CONCLUSION_1_DETAIL}}', '{{CONCLUSION_2_TITLE}}', '{{CONCLUSION_2_DETAIL}}', '{{CONCLUSION_3_TITLE}}', '{{CONCLUSION_3_DETAIL}}', '{{CLOSING_STATEMENT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  11_outlook: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{HORIZON_1_TITLE}}', '{{HORIZON_1_DETAIL}}', '{{HORIZON_2_TITLE}}', '{{HORIZON_2_DETAIL}}', '{{HORIZON_3_TITLE}}', '{{HORIZON_3_DETAIL}}', '{{OUTLOOK_SIGNAL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  12_appendix: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{APPENDIX_1_TITLE}}', '{{APPENDIX_1_SOURCE}}', '{{APPENDIX_2_TITLE}}', '{{APPENDIX_2_SOURCE}}', '{{APPENDIX_3_TITLE}}', '{{APPENDIX_3_SOURCE}}', '{{APPENDIX_4_TITLE}}', '{{APPENDIX_4_SOURCE}}', '{{APPENDIX_5_TITLE}}', '{{APPENDIX_5_SOURCE}}', '{{APPENDIX_6_TITLE}}', '{{APPENDIX_6_SOURCE}}', '{{APPENDIX_7_TITLE}}', '{{APPENDIX_7_SOURCE}}', '{{APPENDIX_NOTE}}', '{{PAGE_NUM}}']
---

# Premium Strategy Assessment — Design Specification

## IV. Signature Design Elements

- 顶部 4 px 识别线贯穿全部页面（预览值，可由下游身份覆盖）。
- 内容页固定页眉带：左侧 kicker + 标题 + 副标题。
- 目录页采用 360 px 左栏 + 右侧编号列表。
- 指标条采用四列等宽卡片，顶部 4 px 强调线。
- 资本结构页用水平分层条表达优先级与规模。
- 风险矩阵页用 3×3 底 + 风险点 + 右侧登记册。

## V. Page Roster

| File | Layout key | Picker name | Content shape and slot behavior |
|---|---|---|---|
| `01_cover.svg` | `cover` | Cover | 全幅封面：标签、标题/副标题、元信息与上下文行。 |
| `02_toc.svg` | `toc` | Table of Contents | 左栏目录 + 右侧六项编号标题。 |
| `03_executive_summary.svg` | `executive-summary` | Executive Summary | 页眉 + 四项 KPI + 三张结论卡。 |
| `04_project_positioning.svg` | `project-positioning` | Project Positioning | 左文右图：战略定位陈述 + 空间/梯级示意。 |
| `05_technical_params.svg` | `technical-params` | Technical Parameters | 六行参数表：单位、数值、备注。 |
| `06_business_model.svg` | `business-model` | Business Model | 左侧股权环形图 + 右侧三步商业逻辑。 |
| `07_financing_structure.svg` | `financing-structure` | Financing Structure | 四层资本结构条 + 右侧融资风险说明。 |
| `08_risk_matrix.svg` | `risk-matrix` | Risk Matrix | 3×3 风险矩阵 + 右侧风险登记册。 |
| `09_macro_crisis.svg` | `macro-crisis` | Macro Crisis | 三因并列 + 底部危机时间线。 |
| `10_conclusions.svg` | `conclusions` | Conclusions | 三条编号结论 + 底部收束判断。 |
| `11_outlook.svg` | `outlook` | Strategic Outlook | 短期/中期/长期三列展望。 |
| `12_appendix.svg` | `appendix` | Appendix | 七行数据索引表 + 附录说明。 |
