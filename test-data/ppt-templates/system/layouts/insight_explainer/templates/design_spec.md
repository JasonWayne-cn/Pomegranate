---
layout_id: insight_explainer
kind: layout
category: scenario
summary: 浅色学术与技术讲解结构，覆盖概念定义、模型、对比、框架、流程与案例。
keywords: [explainer, academic, technical, concept, framework]
canvas_format: ppt169
canvas_width: 1280
canvas_height: 720
canvas_viewbox: "0 0 1280 720"
source_canvas_width: 1280
source_canvas_height: 720
source_viewbox: "0 0 1280 720"
replication_mode: standard
native_structure_mode: structured
page_count: 14
page_types: [cover, contents, chapter, key_findings, concept_definition, model_diagram, comparison_table, quote, framework, workflow, case_study, quick_reference, recommended_reading, ending]
placeholders:
  01_cover: ['{{TITLE}}', '{{SUBTITLE}}', '{{SOURCE_LINE}}']
  02_contents: ['{{PAGE_TITLE}}', '{{SECTION_1_TITLE}}', '{{SECTION_1_DESC}}', '{{SECTION_2_TITLE}}', '{{SECTION_2_DESC}}', '{{SECTION_3_TITLE}}', '{{SECTION_3_DESC}}', '{{SECTION_4_TITLE}}', '{{SECTION_4_DESC}}', '{{SECTION_5_TITLE}}', '{{SECTION_5_DESC}}', '{{SECTION_6_TITLE}}', '{{SECTION_6_DESC}}']
  03_chapter: ['{{CHAPTER_NUM}}', '{{CHAPTER_TITLE}}', '{{CHAPTER_SUBTITLE}}', '{{CHAPTER_DESC}}']
  04_key_findings: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{FINDING_1_TITLE}}', '{{FINDING_1_DETAIL}}', '{{FINDING_1_METRIC}}', '{{FINDING_2_TITLE}}', '{{FINDING_2_DETAIL}}', '{{FINDING_2_METRIC}}', '{{FINDING_3_TITLE}}', '{{FINDING_3_DETAIL}}', '{{FINDING_3_METRIC}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  05_concept_definition: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{CORE_TERM}}', '{{CORE_TERM_EN}}', '{{DEFINITION}}', '{{FACET_1}}', '{{FACET_2}}', '{{FACET_3}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  06_model_diagram: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{MODEL_1_TITLE}}', '{{MODEL_1_DESC}}', '{{MODEL_2_TITLE}}', '{{MODEL_2_DESC}}', '{{MODEL_3_TITLE}}', '{{MODEL_3_DESC}}', '{{MODEL_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  07_comparison_table: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{COMPARE_ROW_1}}', '{{COMPARE_ROW_2}}', '{{COMPARE_ROW_3}}', '{{COMPARE_ROW_4}}', '{{COMPARE_ROW_5}}', '{{TABLE_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  08_quote: ['{{PAGE_TITLE}}', '{{QUOTE}}', '{{ATTRIBUTION}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  09_framework: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{QUADRANT_1_TITLE}}', '{{QUADRANT_1_DETAIL}}', '{{QUADRANT_2_TITLE}}', '{{QUADRANT_2_DETAIL}}', '{{QUADRANT_3_TITLE}}', '{{QUADRANT_3_DETAIL}}', '{{QUADRANT_4_TITLE}}', '{{QUADRANT_4_DETAIL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  10_workflow: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{STEP_1_TITLE}}', '{{STEP_1_DETAIL}}', '{{STEP_2_TITLE}}', '{{STEP_2_DETAIL}}', '{{STEP_3_TITLE}}', '{{STEP_3_DETAIL}}', '{{STEP_4_TITLE}}', '{{STEP_4_DETAIL}}', '{{STEP_5_TITLE}}', '{{STEP_5_DETAIL}}', '{{WORKFLOW_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  11_case_study: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{CONTEXT_TITLE}}', '{{CONTEXT_DETAIL}}', '{{APPLICATION_TITLE}}', '{{APPLICATION_DETAIL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  12_quick_reference: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{TERM_1}}', '{{TERM_1_DEFINITION}}', '{{TERM_2}}', '{{TERM_2_DEFINITION}}', '{{TERM_3}}', '{{TERM_3_DEFINITION}}', '{{TERM_4}}', '{{TERM_4_DEFINITION}}', '{{TERM_5}}', '{{TERM_5_DEFINITION}}', '{{TERM_6}}', '{{TERM_6_DEFINITION}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  13_recommended_reading: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{READING_1_TITLE}}', '{{READING_1_META}}', '{{READING_2_TITLE}}', '{{READING_2_META}}', '{{READING_3_TITLE}}', '{{READING_3_META}}', '{{READING_4_TITLE}}', '{{READING_4_META}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  14_ending: ['{{THANK_YOU}}', '{{ENDING_SUBTITLE}}', '{{CONTACT_INFO}}']
---

# Insight Explainer — Design Specification

## IV. Signature Design Elements

- 顶部 4 px 中性识别线；内容页统一标题/副标题/页脚结构。
- 封面右侧同心轨道图表达“从现象到机制”的讲解路径。
- 章节页采用 420 px 浅色左栏 + 大号章节编号 + 右侧标题/副标题/描述。
- 概念页：左侧核心术语，右侧工作定义 + 三条要点。
- 模型页：三层递减宽度堆叠，表达可见行为→模式→机制。
- 框架页：2×2 象限；流程页：五步横向卡片 + 箭头。
- 速查表：术语/定义两列；推荐阅读：四张卡片。
- 全部颜色为中性预览值，不代表任何品牌身份。

## V. Page Roster

| File | Layout key | Picker name | Content shape and slot behavior |
|---|---|---|---|
| `01_cover.svg` | `cover` | Cover | 封面：标题、副标题、来源行；右侧同心轨道示意。 |
| `02_contents.svg` | `contents` | Contents | 六项双列目录：编号、标题、说明。 |
| `03_chapter.svg` | `chapter` | Chapter | 章节页：大号章节编号 + 章节标题/副标题/描述。 |
| `04_key_findings.svg` | `key-findings` | Key Findings | 三项核心发现卡 + 指标。 |
| `05_concept_definition.svg` | `concept-definition` | Concept Definition | 核心术语 + 工作定义 + 三条要点。 |
| `06_model_diagram.svg` | `model-diagram` | Model Diagram | 三层模型堆叠 + 右侧阅读注记。 |
| `07_comparison_table.svg` | `comparison-table` | Comparison Table | 五行多维对比表。 |
| `08_quote.svg` | `quote` | Quote | 大号引文 + 出处。 |
| `09_framework.svg` | `framework` | Framework | 2×2 框架象限。 |
| `10_workflow.svg` | `workflow` | Workflow | 五步流程 + 底部说明。 |
| `11_case_study.svg` | `case-study` | Case Study | 左情境/右应用案例页。 |
| `12_quick_reference.svg` | `quick-reference` | Quick Reference | 六项术语速查表。 |
| `13_recommended_reading.svg` | `recommended-reading` | Recommended Reading | 四张推荐阅读卡。 |
| `14_ending.svg` | `ending` | Ending | 居中结束页：感谢语、副标题与联系方式。 |
