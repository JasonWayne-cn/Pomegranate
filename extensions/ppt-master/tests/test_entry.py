"""entry.py 的纯函数测试。

运行：
    python -m unittest discover -s extensions/ppt-master/tests -v
"""

from __future__ import annotations

import ast
import os
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import entry  # noqa: E402


class EntryTests(unittest.TestCase):
    def test_normalize_plan_uses_headings(self):
        plan = entry.normalize_plan(
            {},
            "# 第一章\n正文\n## 第二章\n",
            {"source": {"title": "测试"}},
        )
        self.assertEqual(plan["title"], "测试")
        self.assertEqual([slide["title"] for slide in plan["slides"]], ["第一章", "第二章"])

    def test_normalize_chart_clamps_and_fills(self):
        chart = entry.normalize_chart(
            {
                "type": "unknown",
                "categories": ["A", "B", "C"],
                "series": [{"name": "S", "values": [1, "2"]}],
            }
        )
        self.assertIsNotNone(chart)
        self.assertEqual(chart["type"], "column")
        self.assertEqual(len(chart["series"][0]["values"]), 3)
        self.assertEqual(chart["series"][0]["values"][2], 0.0)

    def test_fill_structured_layout_title_and_content(self):
        svg = """<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
  <text x="80" y="120" font-size="44" data-pptx-placeholder="title">旧标题</text>
  <text x="80" y="220" font-size="24" data-pptx-placeholder="content">旧内容</text>
</svg>"""
        slide = {
            "page": 1,
            "title": "新标题",
            "coreMessage": "核心信息",
            "bullets": ["第一点", "第二点"],
        }
        plan = {"title": "演示标题", "slides": [slide]}
        result = entry.fill_structured_layout(
            svg, slide, 0, plan, {"options": {}}, "章节"
        )
        self.assertIn("新标题", result)
        self.assertIn("第一点", result)
        self.assertIn("第二点", result)
        self.assertNotIn("旧标题", result)

    def test_fill_structured_layout_chart_slot(self):
        svg = """<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
  <text x="80" y="120" font-size="44" data-pptx-placeholder="title">标题</text>
  <rect x="140" y="200" width="600" height="300" data-pptx-placeholder="chart"/>
</svg>"""
        slide = {"page": 1, "title": "图表页", "coreMessage": "", "bullets": []}
        plan = {"title": "演示", "slides": [slide]}
        chart = {
            "type": "column",
            "categories": ["A", "B", "C"],
            "series": [{"name": "S", "values": [1, 2, 3]}],
        }
        result = entry.fill_structured_layout(
            svg, slide, 0, plan, {"options": {}}, "章节", chart=chart
        )
        self.assertIn("translate(140.0,200.0)", result)
        self.assertNotIn("data-pptx-placeholder=\"chart\"", result)

    def test_entry_parses_as_python38(self):
        source = (ROOT / "entry.py").read_text(encoding="utf-8")
        ast.parse(source, filename="entry.py", feature_version=(3, 8))

    def test_strip_structure_attrs_keeps_native_markers(self):
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg">'
            '<g data-pptx-placeholder="chart" data-pptx-bounds="1 2 3 4" '
            'data-pptx-replace-with="chart" data-pptx-fallback-sha256="abc">'
            '<rect width="10" height="10"/></g></svg>'
        )
        result = entry.strip_pptx_structure_attrs(svg)
        self.assertNotIn("data-pptx-placeholder", result)
        self.assertIn('data-pptx-bounds="1 2 3 4"', result)
        self.assertIn('data-pptx-replace-with="chart"', result)
        self.assertIn('data-pptx-fallback-sha256="abc"', result)

    def test_token_replacements_cover_structured_keys(self):
        slide = {
            "page": 2,
            "title": "页面标题",
            "coreMessage": "核心信息",
            "bullets": ["A：10", "B：20", "C：30"],
        }
        replacements = entry._token_replacements(
            slide, 1, {"title": "演示", "slides": [slide]}, {"options": {}}, "章节"
        )
        self.assertEqual(replacements["SOURCE"], "素材整理")
        self.assertEqual(replacements["STEP_1"], "A：10")
        self.assertEqual(replacements["KPI_2"], "20")
        self.assertEqual(replacements["KEY_MESSAGE"], "核心信息")

    def test_detect_canvas_for_non_169_layout(self):
        with tempfile.TemporaryDirectory() as temp:
            templates = (
                Path(temp) / "templates" / "layouts" / "story" / "templates"
            )
            templates.mkdir(parents=True)
            (templates / "01_cover.svg").write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" '
                'viewBox="0 0 1080 1920"></svg>',
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"PPT_EXTENSION_ROOT": temp}):
                key, viewbox, width, height = entry._detect_canvas("story")
            self.assertEqual(key, "story")
            self.assertEqual(viewbox, "0 0 1080 1920")
            self.assertEqual((width, height), (1080, 1920))

    def test_resolve_stage_defaults_to_full(self):
        self.assertEqual(entry.resolve_stage({}), "full")
        self.assertEqual(entry.resolve_stage({"options": {}}), "full")
        self.assertEqual(entry.resolve_stage({"options": {"stage": "RENDER"}}), "render")
        self.assertEqual(entry.resolve_stage({"options": {"stage": "export"}}), "export")
        self.assertEqual(entry.resolve_stage({"options": {"stage": "unknown"}}), "full")

    def test_copy_layout_assets_copies_images_to_project_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            templates = root / "templates" / "layouts" / "demo" / "templates"
            templates.mkdir(parents=True)
            cover = templates / "01_cover.svg"
            cover.write_text("<svg/>", encoding="utf-8")
            images = root / "templates" / "layouts" / "demo" / "images"
            images.mkdir()
            (images / "logo.png").write_bytes(b"png")
            (root / "templates" / "layouts" / "demo" / "exports").mkdir()
            project = root / "project"
            project.mkdir()

            entry.copy_layout_assets({"cover": cover}, project, "demo")

            self.assertEqual((project / "images" / "logo.png").read_bytes(), b"png")
            self.assertTrue(
                (project / "templates" / "layout_demo" / "01_cover.svg").is_file()
            )
            self.assertFalse((project / "exports").exists())

    def test_bullet_parts_does_not_duplicate_long_sentence(self):
        label, detail, _ = entry._bullet_parts(
            "P06 的检测圆是特定手部空间近似元素，不是所有工种的统一净距。"
        )
        self.assertNotEqual(label, detail)
        self.assertLessEqual(len(label), 20)
        self.assertIn("统一净距", detail)

    def test_bullet_parts_short_sentence_has_no_detail(self):
        label, detail, _ = entry._bullet_parts("粗筛")
        self.assertEqual(label, "粗筛")
        self.assertEqual(detail, "")

    def test_card_tokens_do_not_cross_pages(self):
        slide = {
            "page": 1,
            "title": "本页",
            "coreMessage": "本页核心",
            "bullets": ["P06 检测圆是特定手部空间近似元素，不是统一净距。", "粗筛"],
        }
        plan = {
            "title": "演示",
            "slides": [slide, {"title": "下一页", "coreMessage": "下一页核心", "bullets": []}],
        }
        job = {"options": {}}
        title = entry._resolve_token("CARD_1_TITLE", slide, 0, plan, job, "章节")
        detail = entry._resolve_token("CARD_1_DETAIL", slide, 0, plan, job, "章节")
        self.assertNotEqual(title, detail)
        self.assertEqual(
            entry._resolve_token("CARD_2_DETAIL", slide, 0, plan, job, "章节"), ""
        )
        # 第 5 条不存在时不能回退到其他页或本页标题
        self.assertEqual(
            entry._resolve_token("CARD_5_TITLE", slide, 0, plan, job, "章节"), ""
        )
        # SECTION token 仍按页序号取大纲内容
        self.assertEqual(
            entry._resolve_token("SECTION_2_TITLE", slide, 0, plan, job, "章节"),
            "下一页",
        )
        # 签署栏没有签署信息时保持为空，不能填入页面要点
        self.assertEqual(
            entry._resolve_token("SIGN_1", slide, 0, plan, job, "章节"), ""
        )

    def test_fill_card_titles_uses_short_label(self):
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg">'
            '<text x="0" y="0" font-size="17">模块标题</text>'
            '<text x="0" y="40" font-size="17">模块标题</text>'
            "</svg>"
        )
        bullets = [
            "P01 的几何顺序研究已覆盖包围盒与干涉矩阵。",
            "P06 的检测圆是特定手部空间近似元素，不是统一净距。",
        ]
        result = entry.fill_card_titles(svg, bullets)
        self.assertNotIn("P01 的几何顺序研究已覆盖包围盒与干涉矩阵。", result)
        self.assertIn("…", result)

    def test_apply_text_marks_truncation(self):
        root = entry.ET.fromstring(
            '<svg xmlns="http://www.w3.org/2000/svg">'
            '<g id="end-sign-slot-1"><text font-size="24">占位</text></g>'
            "</svg>"
        )
        element = root[0]
        long_text = "建立22项文献证据表，标注证据等级与需要补读的文献清单。"
        entry._apply_text(
            element,
            long_text,
            max_width=80,
            min_size=8,
            bounds=(0, 0, 80, 20),
        )
        rendered = "".join(element.itertext())
        self.assertIn("…", rendered)
        self.assertNotIn("需要补读的文献清单", rendered)

    def test_alternate_page_type_breaks_runs(self):
        pages = {
            "content_cards": Path("cards.svg"),
            "content_table": Path("table.svg"),
            "content": Path("content.svg"),
        }
        self.assertEqual(
            entry.alternate_page_type(
                "content_cards",
                "content_cards",
                pages,
                ["A：1", "B：2", "C：3", "D：4"],
            ),
            "content_table",
        )
        self.assertEqual(
            entry.alternate_page_type(
                "content_cards", "content_cards", pages, ["A", "B", "C"]
            ),
            "content",
        )
        self.assertEqual(
            entry.alternate_page_type(
                "content_table",
                "content_table",
                pages,
                ["A：1", "B：2", "C：3", "D：4"],
            ),
            "content_cards",
        )

    def test_slot_capacity_merges_overflow(self):
        slide = {
            "page": 1,
            "title": "文献页",
            "bullets": ["A：1", "B：2", "C：3", "D：4", "E：5", "F：6"],
        }
        plan = {"title": "演示", "slides": [slide]}
        job = {"options": {}}
        self.assertEqual(
            entry._resolve_token("ROW_5_DATA", slide, 0, plan, job, "章节"),
            "E：5；F：6",
        )
        self.assertEqual(
            entry._resolve_token("NOTICE_3_TITLE", slide, 0, plan, job, "章节"),
            "C",
        )

    def test_choose_page_type_uses_structured_intent(self):
        pages = {
            key: Path(f"{key}.svg")
            for key in (
                "content",
                "content_table",
                "content_cards",
                "safety_notice",
                "process_steps",
            )
        }
        bullets = ["A：1", "B：2", "C：3", "D：4"]
        self.assertEqual(
            entry.choose_page_type(
                {
                    "title": "P01 基线",
                    "relation": "timeline",
                    "chartType": "process",
                    "bullets": bullets,
                },
                1,
                10,
                pages,
            ),
            "process_steps",
        )
        self.assertEqual(
            entry.choose_page_type(
                {"title": "某页", "chartType": "compare", "bullets": bullets},
                1,
                10,
                pages,
            ),
            "content_table",
        )
        self.assertEqual(
            entry.choose_page_type(
                {"title": "某页", "chartType": "cards", "bullets": bullets},
                1,
                10,
                pages,
            ),
            "content_cards",
        )

    def test_localize_template_labels(self):
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg">'
            '<text id="content-panel-label">CONTENT AREA</text>'
            '<text id="tbl-head-1">ITEM</text>'
            '<text id="tbl-head-2">PARAMETER</text>'
            '<text id="tbl-head-3">NOTE</text>'
            "</svg>"
        )
        result = entry.localize_template_labels(svg)
        self.assertIn("内容要点", result)
        self.assertIn("条目与说明", result)
        self.assertNotIn("PARAMETER", result)
        self.assertNotIn(">NOTE<", result)

    def test_choose_page_type_varies_by_content(self):
        pages = {
            key: Path(f"{key}.svg")
            for key in (
                "cover",
                "toc",
                "chapter",
                "content",
                "content_table",
                "content_cards",
                "safety_notice",
                "process_steps",
                "ending",
            )
        }

        def pick(title, bullets=None):
            slide = {
                "title": title,
                "bullets": bullets or ["A：1", "B：2", "C：3", "D：4"],
            }
            return entry.choose_page_type(slide, 1, 10, pages)

        self.assertEqual(pick("证据等级与使用边界"), "safety_notice")
        self.assertEqual(pick("项目改进路线建议"), "process_steps")
        self.assertEqual(pick("结论与后续阅读清单"), "content_table")
        self.assertEqual(pick("核心结论"), "content")
        self.assertEqual(pick("手部可达与人因研究"), "content_cards")
        self.assertEqual(
            entry.choose_page_type({"title": "封面", "bullets": []}, 0, 10, pages),
            "cover",
        )
        self.assertEqual(
            entry.choose_page_type({"title": "下一步", "bullets": []}, 9, 10, pages),
            "ending",
        )
        # 首尾页有实质要点时改用内容版式，避免封面吞掉内容
        self.assertEqual(
            entry.choose_page_type(
                {"title": "手部研究", "bullets": ["A", "B", "C", "D"]}, 0, 10, pages
            ),
            "content_cards",
        )

    def test_drop_empty_cards_removes_and_reflows(self):
        cards = []
        for index, (x, y) in enumerate(
            [(80, 156), (456, 156), (832, 156), (80, 394), (456, 394), (832, 394)],
            start=1,
        ):
            cards.append(
                f'<rect id="card-{index}" x="{x}" y="{y}" width="344" height="214"/>'
            )
            cards.append(
                f'<g id="card-title-slot-{index}" data-pptx-bounds="'
                f'{x + 24} {y + 58} 296 34"><text x="{x + 24}" y="{y + 84}">'
                f"标题{index}</text></g>"
            )
        svg = '<svg xmlns="http://www.w3.org/2000/svg">' + "".join(cards) + "</svg>"
        result = entry._drop_empty_cards(svg, 4)
        self.assertNotIn('id="card-5"', result)
        self.assertNotIn('id="card-6"', result)
        self.assertNotIn('id="card-title-slot-5"', result)
        self.assertIn('id="card-4"', result)

        root = entry.ET.fromstring(result)
        positions = {
            element.get("id"): (float(element.get("x")), float(element.get("y")))
            for element in root
            if re.fullmatch(r"card-\d+", element.get("id", ""))
        }
        # 4 张卡重排为 2x2，第二行居中
        self.assertAlmostEqual(positions["card-1"][0], 280.0)
        self.assertAlmostEqual(positions["card-2"][0], 656.0)
        self.assertAlmostEqual(positions["card-3"][0], 280.0)
        self.assertAlmostEqual(positions["card-3"][1], 394.0)
        self.assertAlmostEqual(positions["card-4"][0], 656.0)
        self.assertAlmostEqual(positions["card-4"][1], 394.0)


    def test_native_chart_export_and_speaker_notes(self):
        try:
            import pptx  # noqa: F401
        except Exception:  # noqa: BLE001
            self.skipTest("python-pptx not installed")
        plan = {
            "title": "原生图表冒烟",
            "slides": [
                {
                    "page": 1,
                    "title": "季度数据",
                    "coreMessage": "",
                    "bullets": ["口径说明"],
                    "speakerNote": "第一页备注：说明统计口径。",
                    "chart": {
                        "type": "column",
                        "categories": ["一季度", "二季度", "三季度"],
                        "series": [{"name": "产量", "values": [12, 19, 27]}],
                    },
                },
                {
                    "page": 2,
                    "title": "结论",
                    "coreMessage": "",
                    "bullets": ["结论一"],
                    "speakerNote": "第二页备注：强调增长趋势。",
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            artifact = entry.export_with_python_pptx(
                plan,
                output,
                native_charts=True,
                palette=["#0B4F8A", "#FFC000", "#C1232D"],
            )
            self.assertTrue(artifact.is_file())
            self.assertTrue(entry.attach_speaker_notes(artifact, plan))
            with zipfile.ZipFile(artifact) as archive:
                names = archive.namelist()
                self.assertTrue(
                    any(
                        name.startswith("ppt/charts/chart") and name.endswith(".xml")
                        for name in names
                    )
                )
                note_names = [
                    name
                    for name in names
                    if name.startswith("ppt/notesSlides/notesSlide")
                    and name.endswith(".xml")
                ]
                self.assertTrue(note_names)
                note_text = "".join(
                    archive.read(name).decode("utf-8", "ignore")
                    for name in note_names
                )
                self.assertIn("第一页备注", note_text)
                self.assertIn("第二页备注", note_text)


if __name__ == "__main__":
    unittest.main()
