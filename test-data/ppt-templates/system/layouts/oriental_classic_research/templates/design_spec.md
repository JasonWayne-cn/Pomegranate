---
layout_id: oriental_classic_research
kind: layout
category: special
summary: 东方古典研究结构，覆盖研究架构、章节页、语源解构、核心引文、四法则、六爻总览、爻位详解、关系网、现代应用与结论。
keywords: [oriental, classic, research, culture, i-ching]
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
page_types: [cover, research_architecture, chapter, etymology, core_insight, four_laws, six_yao_overview, yao_detail, relationship_network, modern_application, conclusion, ending]
placeholders:
  01_cover: ['{{TITLE}}', '{{SUBTITLE}}', '{{TAGLINE}}']
  02_research_architecture: ['{{PAGE_TITLE}}', '{{SECTION_1_TITLE}}', '{{SECTION_1_DESC}}', '{{SECTION_2_TITLE}}', '{{SECTION_2_DESC}}', '{{SECTION_3_TITLE}}', '{{SECTION_3_DESC}}', '{{SECTION_4_TITLE}}', '{{SECTION_4_DESC}}', '{{SECTION_5_TITLE}}', '{{SECTION_5_DESC}}', '{{SECTION_6_TITLE}}', '{{SECTION_6_DESC}}', '{{SECTION_7_TITLE}}', '{{SECTION_7_DESC}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  03_chapter: ['{{CHAPTER_NUM}}', '{{CHAPTER_TITLE}}', '{{CHAPTER_SUBTITLE}}', '{{CHAPTER_DESC}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  04_etymology: ['{{PAGE_TITLE}}', '{{ETYMOLOGY_INSIGHT}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  05_core_insight: ['{{PAGE_TITLE}}', '{{CORE_QUOTE}}', '{{INSIGHT_1_TITLE}}', '{{INSIGHT_1_DETAIL}}', '{{INSIGHT_2_TITLE}}', '{{INSIGHT_2_DETAIL}}', '{{INSIGHT_3_TITLE}}', '{{INSIGHT_3_DETAIL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  06_four_laws: ['{{PAGE_TITLE}}', '{{LAW_1_TITLE}}', '{{LAW_1_DETAIL}}', '{{LAW_2_TITLE}}', '{{LAW_2_DETAIL}}', '{{LAW_3_TITLE}}', '{{LAW_3_DETAIL}}', '{{LAW_4_TITLE}}', '{{LAW_4_DETAIL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  07_six_yao_overview: ['{{PAGE_TITLE}}', '{{YAO_1_TEXT}}', '{{YAO_1_THEME}}', '{{YAO_2_TEXT}}', '{{YAO_2_THEME}}', '{{YAO_3_TEXT}}', '{{YAO_3_THEME}}', '{{YAO_4_TEXT}}', '{{YAO_4_THEME}}', '{{YAO_5_TEXT}}', '{{YAO_5_THEME}}', '{{YAO_6_TEXT}}', '{{YAO_6_THEME}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  08_yao_detail: ['{{PAGE_TITLE}}', '{{YAO_POSITION}}', '{{YAO_TEXT}}', '{{YAO_ANALYSIS}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  09_relationship_network: ['{{PAGE_TITLE}}', '{{RELATIONSHIP_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  10_modern_application: ['{{PAGE_TITLE}}', '{{APPLICATION_1_TITLE}}', '{{APPLICATION_1_DETAIL}}', '{{APPLICATION_2_TITLE}}', '{{APPLICATION_2_DETAIL}}', '{{APPLICATION_3_TITLE}}', '{{APPLICATION_3_DETAIL}}', '{{APPLICATION_4_TITLE}}', '{{APPLICATION_4_DETAIL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  11_conclusion: ['{{PAGE_TITLE}}', '{{CONCLUSION_1_TITLE}}', '{{CONCLUSION_1_DETAIL}}', '{{CONCLUSION_2_TITLE}}', '{{CONCLUSION_2_DETAIL}}', '{{CONCLUSION_3_TITLE}}', '{{CONCLUSION_3_DETAIL}}', '{{FINAL_ALGORITHM}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  12_ending: ['{{THANK_YOU}}', '{{ENDING_SUBTITLE}}', '{{CONTACT_INFO}}']
---

# Oriental Classic Research — Design Specification

## IV. Signature Design Elements

- 顶部 3 px 识别线贯穿全部页面（预览值，可由下游身份覆盖）。
- 封面：三重同心圆 + 六爻线 + 卦象标签。
- 章节页：360 px 左栏 + 大号章节编号 + 右侧标题/副标题/描述。
- 六爻线：阴爻双段、阳爻整段；九三为唯一阳爻。
- 内容页：浅纸底 + 细分隔线 + 衬线标题。
- 结束页：双层框印章 + 大字收束。

## V. Page Roster

| File | Layout key | Picker name | Content shape and slot behavior |
|---|---|---|---|
| `01_cover.svg` | `cover` | Cover | 封面：同心圆、六爻线、标题/副标题/题眼。 |
| `02_research_architecture.svg` | `research-architecture` | Research Architecture | 七段研究架构：编号、标题、说明。 |
| `03_chapter.svg` | `chapter` | Chapter | 左栏章节页：大号编号 + 章节标题/副标题/描述。 |
| `04_etymology.svg` | `etymology` | Etymology | 语源解构：大字部件 + 解释槽。 |
| `05_core_insight.svg` | `core-insight` | Core Insight | 核心引文横带 + 三条洞见列。 |
| `06_four_laws.svg` | `four-laws` | Four Laws | 四法则 2×2 卡片。 |
| `07_six_yao_overview.svg` | `six-yao-overview` | Six Yao Overview | 六爻图 + 六行爻辞/主题表。 |
| `08_yao_detail.svg` | `yao-detail` | Yao Detail | 单爻详解：左爻位图 + 右爻辞/分析。 |
| `09_relationship_network.svg` | `relationship-network` | Relationship Network | 三卦关系网 + 右侧关系注记。 |
| `10_modern_application.svg` | `modern-application` | Modern Application | 四个现代应用卡片。 |
| `11_conclusion.svg` | `conclusion` | Conclusion | 三条结论 + 底部最终算法。 |
| `12_ending.svg` | `ending` | Ending | 结束页：双层框印章、感谢语与联系信息。 |
