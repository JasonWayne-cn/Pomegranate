---
layout_id: aviation_training_blue
kind: layout
category: scenario
summary: 航空装备与系统培训课件的结构模板，覆盖章节导航、参数表、模块卡、图文说明、安全提示、流程与位置图。
keywords: [aviation, training, technical, courseware, structured]
canvas_format: ppt169
canvas_width: 1280
canvas_height: 720
canvas_viewbox: "0 0 1280 720"
source_canvas_width: 1280
source_canvas_height: 720
source_viewbox: "0 0 1280 720"
replication_mode: standard
native_structure_mode: structured
page_count: 11
page_types: [cover, toc, chapter, content, content_table, content_cards, content_text_image, safety_notice, process_steps, position_map, ending]
placeholders:
  01_cover: ['{{TITLE}}', '{{SUBTITLE}}', '{{AUTHOR}}', '{{DATE}}']
  02_toc: ['{{SECTION_1_TITLE}}', '{{SECTION_1_DESC}}', '{{SECTION_2_TITLE}}', '{{SECTION_2_DESC}}', '{{SECTION_3_TITLE}}', '{{SECTION_3_DESC}}', '{{SECTION_4_TITLE}}', '{{SECTION_4_DESC}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  03_chapter: ['{{CHAPTER_NUM}}', '{{CHAPTER_TITLE}}', '{{CHAPTER_DESC}}']
  04_content: ['{{SECTION_NAME}}', '{{PAGE_TITLE}}', '{{CONTENT_AREA}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  05_content_table: ['{{SECTION_NAME}}', '{{PAGE_TITLE}}', '{{ROW_1_DATA}}', '{{ROW_2_DATA}}', '{{ROW_3_DATA}}', '{{ROW_4_DATA}}', '{{ROW_5_DATA}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  06_content_cards: ['{{SECTION_NAME}}', '{{PAGE_TITLE}}', '{{CARD_1_TITLE}}', '{{CARD_1_DETAIL}}', '{{CARD_2_TITLE}}', '{{CARD_2_DETAIL}}', '{{CARD_3_TITLE}}', '{{CARD_3_DETAIL}}', '{{CARD_4_TITLE}}', '{{CARD_4_DETAIL}}', '{{CARD_5_TITLE}}', '{{CARD_5_DETAIL}}', '{{CARD_6_TITLE}}', '{{CARD_6_DETAIL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  07_content_text_image: ['{{SECTION_NAME}}', '{{PAGE_TITLE}}', '{{TEXT_TITLE}}', '{{TEXT_DETAIL}}', '{{FIGURE_CAPTION}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  08_safety_notice: ['{{SECTION_NAME}}', '{{PAGE_TITLE}}', '{{NOTICE_1_TITLE}}', '{{NOTICE_1_DETAIL}}', '{{NOTICE_2_TITLE}}', '{{NOTICE_2_DETAIL}}', '{{NOTICE_3_TITLE}}', '{{NOTICE_3_DETAIL}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  09_process_steps: ['{{SECTION_NAME}}', '{{PAGE_TITLE}}', '{{STEP_1_TITLE}}', '{{STEP_1_DETAIL}}', '{{STEP_2_TITLE}}', '{{STEP_2_DETAIL}}', '{{STEP_3_TITLE}}', '{{STEP_3_DETAIL}}', '{{STEP_4_TITLE}}', '{{STEP_4_DETAIL}}', '{{STEP_5_TITLE}}', '{{STEP_5_DETAIL}}', '{{PROCESS_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  10_position_map: ['{{SECTION_NAME}}', '{{PAGE_TITLE}}', '{{ZONE_1_LABEL}}', '{{ZONE_2_LABEL}}', '{{ZONE_3_LABEL}}', '{{ZONE_4_LABEL}}', '{{ZONE_1_NOTE}}', '{{ZONE_2_NOTE}}', '{{ZONE_3_NOTE}}', '{{ZONE_4_NOTE}}', '{{SOURCE}}', '{{PAGE_NUM}}']
  11_ending: ['{{THANK_YOU}}', '{{ENDING_SUBTITLE}}', '{{SIGN_1}}', '{{SIGN_2}}', '{{SIGN_3}}', '{{CONTACT_INFO}}']
---

# Aviation Training Blue — Design Specification

## IV. Signature Design Elements

- 顶部 6 px 识别线贯穿全部页面；内容页使用蓝色方块 + 红色圆点作为页眉锚点。
- 页眉横向红色虚实指引线从章节名延伸至右侧，保留技术课件的标注感。
- 内容页统一为浅色内容面板 + 顶部蓝色条，正文槽占满面板内部安全区。
- 目录页使用 300 px 左侧目录栏 + 右侧四项编号列表。
- 章节页使用蓝色全幅底、白色编号圆、黄色细线与红色箭头。
- 参数表页为固定表头 + 整行内容槽；卡片页为 2×3 模块卡。
- 安全提示页为三行色块标签 + 标题/说明槽；流程页为五步横向卡 + 箭头。
- 位置图页为左侧机上示意 + 右侧区域说明列表。
- 正文与内容槽位字号不低于 16 pt（SVG 22 px）；页脚、页码与位置图小标签保留为注释级小字号。
- 原型中的蓝色/红色/黄色为中性预览值，不代表品牌身份；下游由 Brand/Style 覆盖。

## V. Page Roster

| File | Layout key | Picker name | Content shape and slot behavior |
|---|---|---|---|
| `01_cover.svg` | `cover` | Cover | 封面：左上角蓝色点阵、右上角 AVIC 标志图片、标题/副标题/作者/日期。 |
| `02_toc.svg` | `toc` | Table of Contents | 目录：左侧蓝色目录栏 + 四项编号标题与说明。 |
| `03_chapter.svg` | `chapter` | Chapter | 章节页：蓝色全幅底、大号编号圆、章节标题/描述、红色箭头。 |
| `04_content.svg` | `content` | Content | 通用内容页：章节页眉 + 红色虚线 + 浅蓝内容面板 + 正文槽。 |
| `05_content_table.svg` | `content-table` | Content Table | 参数表页：表头 + 五行整行内容槽，适合设备参数与检查清单。 |
| `06_content_cards.svg` | `content-cards` | Content Cards | 六卡片页：2×3 模块卡，每卡含标题与说明槽。 |
| `07_content_text_image.svg` | `content-text-image` | Content Text and Image | 图文说明页：左侧文字 + 右侧系统示意与图注。 |
| `08_safety_notice.svg` | `safety-notice` | Safety Notice | 安全提示页：注意/警告/禁止三行提示，含标题与说明槽。 |
| `09_process_steps.svg` | `process-steps` | Process Steps | 流程页：五步横向流程卡 + 箭头 + 底部说明。 |
| `10_position_map.svg` | `position-map` | Position Map | 位置图页：机上位置示意 + 四区标记 + 右侧区域说明。 |
| `11_ending.svg` | `ending` | Ending | 结束页：蓝色点阵横幅、感谢语、编制/审核/批准与联系方式。 |
