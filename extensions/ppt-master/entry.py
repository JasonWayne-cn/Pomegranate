#!/usr/bin/env python3
"""PPT Master 扩展入口。

由主程序以固定参数启动：
    python entry.py --job <job_dir>/job.json

只读取 job 目录内的输入，只写 project/ 与 output/。
输出 JSONL 事件到 stdout。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

JOB_DIR = Path.cwd()

PALETTES = {
    "default": ("#1f2937", "#2563eb", "#f8fafc", "#e2e8f0"),
    "editorial_bleed": ("#111827", "#dc2626", "#fef2f2", "#fecaca"),
    "moments_square": ("#1f2937", "#d97706", "#fffbeb", "#fde68a"),
    "presentation_core": ("#0f172a", "#2563eb", "#eff6ff", "#bfdbfe"),
    "presentation_core_43": ("#1e293b", "#0891b2", "#ecfeff", "#a5f3fc"),
    "report_core": ("#0b2545", "#1d4ed8", "#eff6ff", "#bfdbfe"),
    "story_vertical": ("#2e1065", "#7c3aed", "#f5f3ff", "#ddd6fe"),
    "xiaohongshu_post": ("#450a0a", "#e11d48", "#fff1f2", "#fecdd3"),
    "aviation_training_blue": ("#595959", "#0071BC", "#FFFFFF", "#DCEEFD"),
    "academic_defense": ("#0f172a", "#7c3aed", "#f5f3ff", "#ddd6fe"),
    "government_blue": ("#0b2545", "#1d4ed8", "#eff6ff", "#bfdbfe"),
    "government_red": ("#3f0d12", "#b91c1c", "#fef2f2", "#fecaca"),
    "ai_ops": ("#0b1020", "#06b6d4", "#ecfeff", "#a5f3fc"),
    "medical_university": ("#042f2e", "#0d9488", "#f0fdfa", "#99f6e4"),
}


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str, level: str = "info") -> None:
    emit({"type": "log", "level": level, "message": message})


def progress(stage: str, percent: int, message: str = "") -> None:
    emit({"type": "progress", "stage": stage, "percent": percent, "message": message})


def fail(code: str, message: str) -> "NoReturn":
    emit({"type": "error", "code": code, "message": message})
    raise SystemExit(1)


def safe_name(value: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip().strip(".")
    return value[:80] or "AI_PPT"


def read_text(path: Path, limit: int = 200_000) -> str:
    return path.read_text(encoding="utf-8", errors="replace")[:limit]


def wrap_text(text: str, limit: int, max_lines: int) -> list[str]:
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    lines: list[str] = []
    while text and len(lines) < max_lines:
        lines.append(text[:limit])
        text = text[limit:]
    if text and lines:
        lines[-1] = lines[-1][:-1] + "…"
    return lines


CHART_TYPE_TO_KEY = {
    "line": "line_chart",
    "column": "column_chart",
    "bar": "horizontal_bar_chart",
    "pie": "pie_chart",
    "doughnut": "donut_chart",
    "donut": "donut_chart",
    "area": "area_chart",
    "scatter": "scatter_chart",
    "bubble": "bubble_chart",
    "gantt": "gantt_chart",
    "funnel": "funnel_chart",
    "radar": "radar_chart",
    "waterfall": "waterfall_chart",
    "treemap": "treemap_chart",
    "heatmap": "heatmap_chart",
    "gauge": "gauge_chart",
    "histogram": "histogram_chart",
    "stacked_area": "stacked_area_chart",
    "stacked_bar": "stacked_bar_chart",
    "grouped_bar": "grouped_bar_chart",
    "pareto": "pareto_chart",
    "matrix": "matrix_2x2",
    "progress": "progress_bar_chart",
    "word_cloud": "word_cloud",
}


def pack_root() -> Path:
    return Path(os.environ.get("PPT_EXTENSION_ROOT", Path(__file__).resolve().parent))


def derive_page_type(file_name: str) -> str:
    return re.sub(r"^\d+[a-z]?_", "", Path(file_name).stem)


def layout_pages(layout_id: str | None) -> dict[str, Path]:
    if not layout_id:
        return {}
    base = pack_root() / "templates" / "layouts" / layout_id
    if (base / "templates").is_dir():
        base = base / "templates"
    if not base.is_dir():
        return {}
    pages: dict[str, Path] = {}
    for file in sorted(base.glob("*.svg")):
        pages[derive_page_type(file.name)] = file
    return pages


def copy_layout_assets(pages: dict[str, Path], project: Path, layout_id: str) -> None:
    if not pages:
        return
    dest = project / "templates" / f"layout_{layout_id}"
    dest.mkdir(parents=True, exist_ok=True)
    for source in pages.values():
        shutil.copy2(source, dest / source.name)

    # 模板 SVG 可能通过 ../images/、../assets/ 引用同目录资源；
    # 生成页位于 project/svg_output/，因此资源需复制到 project/<name>/。
    first = next(iter(pages.values()))
    layout_root = first.parent.parent if first.parent.name == "templates" else first.parent
    if not layout_root.is_dir():
        return
    for child in layout_root.iterdir():
        if not child.is_dir() or child.name in {"templates", "exports"}:
            continue
        shutil.copytree(child, project / child.name, dirs_exist_ok=True)


def normalize_chart(chart: object) -> dict | None:
    if not isinstance(chart, dict):
        return None
    categories = chart.get("categories")
    series = chart.get("series")
    if not isinstance(categories, list) or not isinstance(series, list):
        return None
    cats = [str(item).strip() for item in categories if str(item).strip()][:12]
    if not cats:
        return None
    out_series = []
    for item in series[:4]:
        if not isinstance(item, dict):
            continue
        values = []
        for value in (item.get("values") or [])[: len(cats)]:
            try:
                values.append(float(value))
            except (TypeError, ValueError):
                values.append(0.0)
        if not values:
            continue
        values.extend([0.0] * (len(cats) - len(values)))
        out_series.append(
            {"name": str(item.get("name") or "Series"), "values": values[: len(cats)]}
        )
    if not out_series:
        return None
    chart_type = str(chart.get("type") or "column").strip().lower()
    if chart_type not in {
        "column",
        "bar",
        "line",
        "area",
        "pie",
        "donut",
        "doughnut",
        "scatter",
        "radar",
        "gantt",
    }:
        chart_type = "column"
    return {
        "type": chart_type,
        "categories": cats,
        "series": out_series,
    }


def chart_data_for_slide(slide: dict, preferred_key: str | None) -> dict | None:
    normalized = normalize_chart(slide.get("chart"))
    if normalized:
        return normalized

    # 从“标签：数值”形式的要点中提取简单图表数据
    pairs: list[tuple[str, float]] = []
    for bullet in slide.get("bullets") or []:
        text = str(bullet).lstrip("•- ").strip()
        match = re.match(
            r"^(.+?)[：:]\s*([-+]?\d+(?:\.\d+)?)\s*(?:%|万元|亿元|万|亿|个|台|套|人|小时|分钟)?\s*$",
            text,
        )
        if match:
            pairs.append((match.group(1).strip(), float(match.group(2))))
    if len(pairs) < 3:
        return None

    context = " ".join(
        [slide.get("title", ""), slide.get("coreMessage", "")]
        + [str(item) for item in slide.get("bullets") or []]
    )
    chart_type = "column"
    if any(word in context for word in ("占比", "比例", "构成", "份额")):
        chart_type = "doughnut"
    elif any(word in context for word in ("趋势", "增长", "变化", "走势")):
        chart_type = "line"
    if preferred_key and preferred_key.endswith("_chart") and chart_type == "column":
        chart_type = preferred_key[: -len("_chart")]
    return {
        "type": chart_type,
        "categories": [item[0] for item in pairs][:12],
        "series": [{"name": "数值", "values": [item[1] for item in pairs][:12]}],
    }


def chart_template_path(chart: dict, preferred_key: str | None) -> Path | None:
    charts_dir = pack_root() / "templates" / "charts"
    candidates: list[str] = []
    if preferred_key:
        candidates.append(preferred_key)
    chart_type = str(chart.get("type") or "").lower()
    mapped = CHART_TYPE_TO_KEY.get(chart_type)
    if mapped:
        candidates.append(mapped)
    candidates.append(f"{chart_type}_chart")
    for key in candidates:
        path = charts_dir / f"{key}.svg"
        if path.is_file():
            return path
    return None


DEFAULT_CHART_COLORS = ["#0071BC", "#50AAF4", "#C1232D", "#FFC000", "#595959", "#8B9298"]


def chart_colors(chart_path: Path | None) -> list[str]:
    if chart_path is not None:
        try:
            text = chart_path.read_text(encoding="utf-8")
            match = re.search(
                r'<metadata type="application/json">(.*?)</metadata>', text, re.S
            )
            if match:
                payload = json.loads(match.group(1))
                colors = payload.get("style", {}).get("colors")
                if isinstance(colors, list):
                    valid = [
                        str(color)
                        for color in colors
                        if isinstance(color, str) and color.startswith("#")
                    ]
                    if valid:
                        return valid
        except (OSError, json.JSONDecodeError):
            pass
    return DEFAULT_CHART_COLORS


def _chart_text(x: float, y: float, text: str, anchor: str = "middle", size: int = 14) -> str:
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" '
        f'font-family="Microsoft YaHei, PingFang SC, sans-serif" '
        f'font-size="{size}" fill="#595959">{escape(str(text))}</text>'
    )


def _chart_legend(series: list[dict], colors: list[str], x: float, y: float) -> str:
    parts = []
    for index, item in enumerate(series):
        color = colors[index % len(colors)]
        offset = x + index * 180
        parts.append(
            f'<rect x="{offset:.1f}" y="{y - 10:.1f}" width="12" height="12" fill="{color}"/>'
        )
        parts.append(_chart_text(offset + 18, y, item.get("name") or "Series", "start", 14))
    return "".join(parts)


def render_chart_fragment(chart: dict, width: float, height: float, colors: list[str]) -> str:
    categories = [str(item) for item in chart.get("categories") or []]
    series = [item for item in chart.get("series") or [] if item.get("values")]
    if not categories or not series:
        return ""
    chart_type = str(chart.get("type") or "column").lower()
    if chart_type in {"doughnut", "donut", "pie"}:
        return _render_pie_chart(
            categories,
            series,
            width,
            height,
            colors,
            donut=chart_type in {"doughnut", "donut"},
        )
    if chart_type in {"bar", "horizontal_bar"}:
        return _render_bar_chart(categories, series, width, height, colors)
    if chart_type in {"line", "area", "scatter"}:
        return _render_line_chart(categories, series, width, height, colors, chart_type)
    return _render_column_chart(categories, series, width, height, colors)


def _render_column_chart(
    categories: list[str],
    series: list[dict],
    width: float,
    height: float,
    colors: list[str],
) -> str:
    pad_left = min(64.0, width * 0.18)
    pad_right = min(24.0, width * 0.06)
    pad_top = min(44.0, height * 0.18)
    pad_bottom = min(54.0, height * 0.22)
    plot_w = max(1.0, width - pad_left - pad_right)
    plot_h = max(1.0, height - pad_top - pad_bottom)
    baseline = pad_top + plot_h
    max_value = max(
        [float(value) for item in series for value in item.get("values") or []]
        + [1.0]
    )
    group_w = plot_w / max(len(categories), 1)
    bar_w = group_w / (len(series) + 0.6)
    parts = [
        f'<line x1="{pad_left}" y1="{baseline}" x2="{width - pad_right}" y2="{baseline}" stroke="#CBD5E1" stroke-width="1"/>'
    ]
    for tick in range(5):
        value = max_value * tick / 4
        y = baseline - plot_h * tick / 4
        parts.append(
            f'<line x1="{pad_left}" y1="{y:.1f}" x2="{width - pad_right}" y2="{y:.1f}" stroke="#E2E8F0" stroke-width="1"/>'
        )
        parts.append(_chart_text(pad_left - 8, y + 5, f"{value:.0f}", "end", 14))
    for cat_index, category in enumerate(categories):
        center = pad_left + group_w * (cat_index + 0.5)
        parts.append(_chart_text(center, baseline + 22, category, "middle", 14))
        for series_index, item in enumerate(series):
            values = item.get("values") or []
            value = float(values[cat_index]) if cat_index < len(values) else 0.0
            bar_h = max(0.0, plot_h * value / max_value) if max_value else 0.0
            x = pad_left + group_w * cat_index + bar_w * (series_index + 0.35)
            y = baseline - bar_h
            parts.append(
                f'<rect x="{x:.1f}" y="{y:.1f}" width="{max(0.0, bar_w):.1f}" height="{bar_h:.1f}" '
                f'fill="{colors[series_index % len(colors)]}" rx="2"/>'
            )
            if len(categories) <= 8:
                parts.append(_chart_text(x + bar_w / 2, y - 6, f"{value:g}", "middle", 14))
    if width >= 320:
        parts.append(_chart_legend(series, colors, pad_left, height - 12))
    return "".join(parts)


def _render_bar_chart(
    categories: list[str],
    series: list[dict],
    width: float,
    height: float,
    colors: list[str],
) -> str:
    pad_left = min(130.0, width * 0.25)
    pad_right = min(30.0, width * 0.06)
    pad_top = min(24.0, height * 0.12)
    pad_bottom = min(44.0, height * 0.18)
    plot_w = max(1.0, width - pad_left - pad_right)
    plot_h = max(1.0, height - pad_top - pad_bottom)
    max_value = max(
        [float(value) for item in series for value in item.get("values") or []]
        + [1.0]
    )
    row_h = plot_h / max(len(categories), 1)
    bar_h = row_h / (len(series) + 0.6)
    parts = []
    for row_index, category in enumerate(categories):
        y_center = pad_top + row_h * (row_index + 0.5)
        parts.append(_chart_text(pad_left - 12, y_center + 5, category, "end", 13))
        for series_index, item in enumerate(series):
            values = item.get("values") or []
            value = float(values[row_index]) if row_index < len(values) else 0.0
            bar_w = max(0.0, plot_w * value / max_value) if max_value else 0.0
            y = pad_top + row_h * row_index + bar_h * (series_index + 0.3)
            parts.append(
                f'<rect x="{pad_left}" y="{y:.1f}" width="{bar_w:.1f}" height="{max(0.0, bar_h):.1f}" '
                f'fill="{colors[series_index % len(colors)]}" rx="2"/>'
            )
            if len(categories) <= 8:
                parts.append(_chart_text(pad_left + bar_w + 6, y + bar_h / 2 + 5, f"{value:g}", "start", 14))
    if width >= 320:
        parts.append(_chart_legend(series, colors, pad_left, height - 12))
    return "".join(parts)


def _render_line_chart(
    categories: list[str],
    series: list[dict],
    width: float,
    height: float,
    colors: list[str],
    chart_type: str,
) -> str:
    pad_left = min(64.0, width * 0.18)
    pad_right = min(24.0, width * 0.06)
    pad_top = min(44.0, height * 0.18)
    pad_bottom = min(54.0, height * 0.22)
    plot_w = max(1.0, width - pad_left - pad_right)
    plot_h = max(1.0, height - pad_top - pad_bottom)
    baseline = pad_top + plot_h
    max_value = max(
        [float(value) for item in series for value in item.get("values") or []]
        + [1.0]
    )
    count = max(len(categories), 2)
    parts = [
        f'<line x1="{pad_left}" y1="{baseline}" x2="{width - pad_right}" y2="{baseline}" stroke="#CBD5E1" stroke-width="1"/>'
    ]
    for tick in range(5):
        value = max_value * tick / 4
        y = baseline - plot_h * tick / 4
        parts.append(
            f'<line x1="{pad_left}" y1="{y:.1f}" x2="{width - pad_right}" y2="{y:.1f}" stroke="#E2E8F0" stroke-width="1"/>'
        )
        parts.append(_chart_text(pad_left - 8, y + 5, f"{value:.0f}", "end", 14))
    for cat_index, category in enumerate(categories):
        x = pad_left + plot_w * cat_index / (count - 1)
        parts.append(_chart_text(x, baseline + 22, category, "middle", 14))
    for series_index, item in enumerate(series):
        values = item.get("values") or []
        color = colors[series_index % len(colors)]
        points = []
        for cat_index in range(len(categories)):
            value = float(values[cat_index]) if cat_index < len(values) else 0.0
            x = pad_left + plot_w * cat_index / (count - 1)
            y = baseline - plot_h * value / max_value if max_value else baseline
            points.append((x, y))
        if chart_type == "area" and points:
            path = (
                f"M {points[0][0]:.1f} {baseline:.1f} "
                + " ".join(f"L {x:.1f} {y:.1f}" for x, y in points)
                + f" L {points[-1][0]:.1f} {baseline:.1f} Z"
            )
            parts.append(f'<path d="{path}" fill="{color}" opacity="0.16"/>')
        polyline = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
        parts.append(
            f'<polyline points="{polyline}" fill="none" stroke="{color}" stroke-width="3" stroke-linejoin="round"/>'
        )
        for x, y in points:
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="{color}"/>')
    if width >= 320:
        parts.append(_chart_legend(series, colors, pad_left, height - 12))
    return "".join(parts)


def _render_pie_chart(
    categories: list[str],
    series: list[dict],
    width: float,
    height: float,
    colors: list[str],
    donut: bool = False,
) -> str:
    values = [float(value) for value in (series[0].get("values") or [])]
    if not values:
        return ""
    total = sum(abs(value) for value in values) or 1.0
    cx, cy = width * 0.32, height * 0.48
    radius = max(4.0, min(width, height) * 0.34)
    start = -90.0
    parts = []
    for index, value in enumerate(values):
        angle = 360.0 * abs(value) / total
        end = start + angle
        large = 1 if angle > 180 else 0
        x1 = cx + radius * math.cos(math.radians(start))
        y1 = cy + radius * math.sin(math.radians(start))
        x2 = cx + radius * math.cos(math.radians(end))
        y2 = cy + radius * math.sin(math.radians(end))
        color = colors[index % len(colors)]
        parts.append(
            f'<path d="M {cx:.1f} {cy:.1f} L {x1:.1f} {y1:.1f} '
            f'A {radius:.1f} {radius:.1f} 0 {large} 1 {x2:.1f} {y2:.1f} Z" '
            f'fill="{color}" stroke="#FFFFFF" stroke-width="2"/>'
        )
        start = end
    if donut:
        parts.append(
            f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{radius * 0.55:.1f}" fill="#FFFFFF"/>'
        )
    legend_x = width * 0.62
    legend_y = height * 0.18
    for index, category in enumerate(categories[:10]):
        color = colors[index % len(colors)]
        y = legend_y + index * 26
        value = values[index] if index < len(values) else 0
        percent = 100 * abs(value) / total
        parts.append(f'<rect x="{legend_x:.1f}" y="{y - 11:.1f}" width="12" height="12" fill="{color}"/>')
        parts.append(
            _chart_text(
                legend_x + 18,
                y,
                f"{category}  {value:g} ({percent:.0f}%)",
                "start",
                14,
            )
        )
    return "".join(parts)


def stamp_chart_fallback_hash(svg: str) -> str:
    """Bind the native chart metadata to the visible SVG fallback."""
    scripts = pack_root() / "ppt-master" / "skills" / "ppt-master" / "scripts"
    if not scripts.is_dir():
        return svg
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    try:
        from pptx_shapes.semantic_hash import svg_native_fallback_fingerprint
    except Exception as exc:  # noqa: BLE001
        log(f"无法加载图表语义哈希模块: {exc}", "warn")
        return svg
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        log(f"图表 SVG 解析失败: {exc}", "warn")
        return svg
    marker = next(
        (
            element
            for element in root.iter()
            if element.get("data-pptx-replace-with") == "chart"
        ),
        None,
    )
    if marker is None:
        return svg
    digest = svg_native_fallback_fingerprint(marker, document_root=root)

    pattern = re.compile(
        r'(<[A-Za-z]+\b[^>]*\bdata-pptx-replace-with="chart"[^>]*?)(\s*>)'
    )

    def replace_tag(match: re.Match[str]) -> str:
        tag = re.sub(r'\s+data-pptx-fallback-sha256="[^"]*"', "", match.group(1))
        return f'{tag} data-pptx-fallback-sha256="{digest}"{match.group(2)}'

    return pattern.sub(replace_tag, svg, count=1)


def replace_header_texts(svg: str, title: str, subtitle: str) -> str:
    header = re.search(r'(<g\s+id="header"[^>]*>)(.*?)(</g>)', svg, re.S)
    if not header:
        return svg
    body = header.group(2)
    count = {"value": 0}

    def replace_text(match: re.Match[str]) -> str:
        index = count["value"]
        count["value"] += 1
        if index > 1:
            return match.group(0)
        content = title if index == 0 else subtitle
        return f"{match.group(1)}{escape(content)}{match.group(3)}"

    body = re.sub(r"(<text\b[^>]*>)(.*?)(</text>)", replace_text, body, flags=re.S)
    return svg[: header.start(2)] + body + svg[header.end(2) :]


def fill_chart_svg(svg: str, slide: dict, plan: dict, chart: dict) -> str:
    def replace_metadata(match: re.Match[str]) -> str:
        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError:
            return match.group(0)
        if not isinstance(payload, dict):
            return match.group(0)
        payload["categories"] = chart["categories"]
        payload["series"] = [
            {"name": item["name"], "values": item["values"]}
            for item in chart["series"]
        ]
        return (
            '<metadata type="application/json">\n'
            + json.dumps(payload, ensure_ascii=False, indent=2)
            + "\n</metadata>"
        )

    svg = re.sub(
        r'<metadata type="application/json">(.*?)</metadata>',
        replace_metadata,
        svg,
        flags=re.S,
    )
    subtitle = slide.get("coreMessage") or ""
    if not subtitle:
        subtitle = "数据来源：素材整理"
    svg = replace_header_texts(svg, slide.get("title") or plan["title"], subtitle)
    return stamp_chart_fallback_hash(svg)


def content_lines(bullets: list[str], core: str) -> list[str]:
    items = [str(item).strip() for item in bullets if str(item).strip()]
    if not items and core.strip():
        items = [core.strip()]
    lines: list[str] = []
    for item in items:
        wrapped = wrap_text(item, 40, 3)
        if not wrapped:
            continue
        lines.append("• " + wrapped[0])
        lines.extend("   " + extra for extra in wrapped[1:])
        if len(lines) >= 12:
            break
    return lines[:12]


def replace_content_area(
    svg: str,
    bullets: list[str],
    core: str,
    chart: dict | None = None,
    colors: list[str] | None = None,
) -> str:
    match = re.search(r"(<text\b[^>]*>)\{\{CONTENT_AREA\}\}(</text>)", svg, re.S)
    if not match:
        return svg
    if chart:
        fragment = render_chart_fragment(
            chart, 980, 340, colors or DEFAULT_CHART_COLORS
        )
        if fragment:
            replacement = f'<g transform="translate(140,180)">{fragment}</g>'
            return svg[: match.start()] + replacement + svg[match.end() :]
    open_tag = match.group(1)
    fill_match = re.search(r'fill="([^"]+)"', open_tag)
    font_match = re.search(r'font-family="([^"]+)"', open_tag)
    fill = fill_match.group(1) if fill_match else "#595959"
    font = font_match.group(1) if font_match else "Arial, 微软雅黑, sans-serif"
    lines = content_lines(bullets, core)
    if not lines:
        return svg[: match.start()] + svg[match.end() :]
    x, y = 140, 220
    tspans = []
    for index, line in enumerate(lines):
        dy = 0 if index == 0 else 34
        tspans.append(f'<tspan x="{x}" dy="{dy}">{escape(line)}</tspan>')
    replacement = (
        f'<text x="{x}" y="{y}" font-family="{font}" font-size="24" fill="{fill}">'
        + "".join(tspans)
        + "</text>"
    )
    return svg[: match.start()] + replacement + svg[match.end() :]


def _text_width_units(text: str) -> float:
    return sum(1.2 if ord(char) > 127 else 0.6 for char in text)


def fit_text_element(
    open_tag: str,
    text: str,
    close_tag: str,
    max_width: float = 1120,
    min_size: int = 24,
) -> str:
    size_match = re.search(r'font-size="([0-9.]+)"', open_tag)
    size = float(size_match.group(1)) if size_match else 24.0
    units = _text_width_units(text)
    estimated = units * size
    if estimated <= max_width:
        return f"{open_tag}{text}{close_tag}"
    new_size = max(min_size, int(size * max_width / estimated))
    open_tag = re.sub(r'font-size="[0-9.]+"', f'font-size="{new_size}"', open_tag)
    estimated = units * new_size
    if estimated <= max_width:
        return f"{open_tag}{text}{close_tag}"
    max_chars = max(8, int(max_width / (new_size * 1.2)))
    lines = wrap_text(text, max_chars, 6)
    if not lines:
        return ""
    x_match = re.search(r'\bx="([0-9.-]+)"', open_tag)
    x = x_match.group(1) if x_match else "0"
    line_height = max(18, int(new_size * 1.3))
    tspans = []
    for index, line in enumerate(lines):
        dy = 0 if index == 0 else line_height
        tspans.append(f'<tspan x="{x}" dy="{dy}">{line}</tspan>')
    return f"{open_tag}{''.join(tspans)}{close_tag}"


def replace_text_placeholder(
    svg: str,
    key: str,
    value: str,
    max_width: float = 1120,
    min_size: int = 24,
) -> str:
    pattern = re.compile(
        r"(<text\b[^>]*>)([^<]*)\{\{" + re.escape(key) + r"\}\}([^<]*)(</text>)",
        re.S,
    )

    def replace(match: re.Match[str]) -> str:
        open_tag, before, after, close_tag = match.groups()
        text = (before + escape(str(value)) + after).strip()
        if not text:
            return ""
        return fit_text_element(open_tag, text, close_tag, max_width, min_size)

    return pattern.sub(replace, svg)


def fill_card_titles(svg: str, bullets: list[str]) -> str:
    texts = [str(item).strip() for item in bullets if str(item).strip()]
    index = {"value": 0}
    pattern = re.compile(r"(<text\b[^>]*>)模块标题(</text>)")

    def replace(match: re.Match[str]) -> str:
        position = index["value"]
        index["value"] += 1
        if position >= len(texts):
            return ""
        text = _bullet_parts(texts[position])[0][:30]
        return fit_text_element(
            match.group(1),
            escape(text),
            match.group(2),
            max_width=300,
            min_size=12,
        )

    return pattern.sub(replace, svg)


def _token_replacements(
    slide: dict,
    index: int,
    plan: dict,
    job: dict,
    section_name: str,
) -> dict[str, str]:
    options = job.get("options") or {}
    title = slide.get("title") or plan["title"]
    core = slide.get("coreMessage") or ""
    bullets = [str(item).strip() for item in (slide.get("bullets") or []) if str(item).strip()]
    kpi_values = []
    for bullet in bullets:
        match = re.match(r"^(.+?)[：:]\s*([-+]?\d+(?:\.\d+)?)", bullet)
        if match:
            kpi_values.append(match.group(2))
    half = max(1, len(bullets) // 2)
    left = "；".join(bullets[:half])
    right = "；".join(bullets[half:])
    replacements = {
        "TITLE": plan["title"],
        "SUBTITLE": core or title,
        "AUTHOR": "Pomegranate",
        "DATE": time.strftime("%Y-%m-%d"),
        "PAGE_TITLE": title,
        "SECTION_NAME": section_name or plan["title"],
        "PAGE_NUM": str(index + 1),
        "CHAPTER_NUM": f"{index + 1:02d}",
        "CHAPTER_TITLE": title,
        "CHAPTER_DESC": core,
        "THANK_YOU": "谢谢",
        "CONTACT_INFO": options.get("audience") or "",
        "KEY_MESSAGE": core or title,
        "SOURCE": "素材整理",
        "CAPTION": bullets[0] if bullets else core,
        "BRAND_LINE": "Pomegranate",
        "CLOSING_MESSAGE": "谢谢",
        "CTA_TEXT": options.get("audience") or "欢迎交流",
        "QUOTE_TEXT": core or (bullets[0] if bullets else title),
        "SUPPORT_TEXT": core or (bullets[0] if bullets else ""),
        "FOOTER_NOTE": "",
        "LEFT_TITLE": _bullet_parts(bullets[0])[0] if bullets else "",
        "RIGHT_TITLE": _bullet_parts(bullets[1])[0] if len(bullets) > 1 else "",
        "LEFT_CONTENT": left or core,
        "RIGHT_CONTENT": right or core,
    }
    for item_index in range(1, 5):
        replacements[f"STEP_{item_index}"] = bullets[item_index - 1] if item_index <= len(bullets) else ""
        replacements[f"ITEM_{item_index}"] = bullets[item_index - 1] if item_index <= len(bullets) else ""
        replacements[f"CARD_{item_index}"] = bullets[item_index - 1] if item_index <= len(bullets) else ""
        replacements[f"CAPTION_{item_index}"] = bullets[item_index - 1] if item_index <= len(bullets) else ""
        replacements[f"KPI_{item_index}"] = (
            kpi_values[item_index - 1]
            if item_index <= len(kpi_values)
            else (bullets[item_index - 1] if item_index <= len(bullets) else "")
        )
    # 卡片版式最多 6 槽；标题与说明分开填充，避免同一句话重复两遍。
    for item_index in range(1, 7):
        item = bullets[item_index - 1] if item_index <= len(bullets) else ""
        label, detail, _ = _bullet_parts(item)
        replacements[f"CARD_{item_index}_TITLE"] = label
        replacements[f"CARD_{item_index}_DETAIL"] = detail
    for item_index, item in enumerate(plan["slides"][:6], start=1):
        replacements[f"TOC_ITEM_{item_index}_TITLE"] = item["title"]
        replacements[f"TOC_ITEM_{item_index}_DESC"] = item.get("coreMessage") or ""
    return replacements


def _bullet_parts(text: str) -> tuple[str, str, str]:
    """把一条要点拆成短标题、说明和数值。

    没有“标题：说明”分隔符时，标题取首句/首分句，说明只保留剩余部分；
    短句没有剩余部分时说明为空。这样标题与正文不会得到完全相同的文本。
    """
    value = str(text).strip().lstrip("•- ").strip()
    match = re.match(r"^(.+?)[：:]\s*(.+)$", value)
    if match:
        label, detail = match.group(1).strip(), match.group(2).strip()
    else:
        label = detail = ""
        for separator in ("。", "！", "？", "；", ";", "\n"):
            position = value.find(separator)
            if position > 0:
                label = value[:position].strip()
                detail = value[position + 1 :].strip()
                break
        if not label:
            for separator in ("，", ","):
                position = value.find(separator)
                if position > 0:
                    label = value[:position].strip()
                    detail = value[position + 1 :].strip()
                    break
        if not label:
            label = value
        if len(label) > 18:
            # 标题过长时退化为摘要，说明保留完整原句，避免标题正文逐字重复。
            label = label[:18].rstrip() + "…"
            detail = value
    label = label or value
    number = re.search(r"[-+]?\d+(?:\.\d+)?", detail) or re.search(
        r"[-+]?\d+(?:\.\d+)?", value
    )
    return label, detail, (number.group(0) if number else "")


def _resolve_token(
    token: str,
    slide: dict,
    index: int,
    plan: dict,
    job: dict,
    section_name: str,
) -> str:
    """把模板中的任意 {{TOKEN}} 映射到当前页/大纲内容。"""
    token = token.strip().upper()
    tokens = _token_replacements(slide, index, plan, job, section_name)
    if token in tokens:
        return str(tokens[token])

    options = job.get("options") or {}
    title = slide.get("title") or plan["title"]
    core = slide.get("coreMessage") or ""
    bullets = [
        str(item).strip()
        for item in (slide.get("bullets") or [])
        if str(item).strip()
    ]

    def item_at(number: int) -> str:
        # 只取本页要点；越界返回空，禁止回退到其他页或本页标题，
        # 否则空槽会填入无关内容并造成整页重复。
        if 1 <= number <= len(bullets):
            return bullets[number - 1]
        return ""

    def slide_at(number: int) -> dict | None:
        if 1 <= number <= len(plan["slides"]):
            return plan["slides"][number - 1]
        return None

    fixed = {
        "PAGE_TITLE": title,
        "TITLE": title,
        "HEADING": title,
        "SECTION_NAME": section_name or plan["title"],
        "SUBTITLE": core or title,
        "CHAPTER_SUBTITLE": core or title,
        "TAGLINE": core or title,
        "META_LINE": core or title,
        "CONTEXT_LINE": core or title,
        "CONTEXT_TITLE": title,
        "CONTEXT_DETAIL": core or title,
        "KEY_MESSAGE": core or title,
        "INSIGHT": core or (bullets[0] if bullets else title),
        "CORE_QUOTE": core or (bullets[0] if bullets else title),
        "CORE_TERM": title,
        "CORE_TERM_EN": title,
        "DEFINITION": core or (bullets[0] if bullets else title),
        "QUOTE": core or (bullets[0] if bullets else title),
        "POSITION_STATEMENT": core or title,
        "POSITION_DETAIL": core or (bullets[0] if bullets else title),
        "CLOSING_STATEMENT": core or "谢谢",
        "ENDING_SUBTITLE": options.get("audience") or core or "",
        "THANK_YOU": "谢谢",
        "CONTACT_INFO": options.get("audience") or "",
        "AUTHOR": "Pomegranate",
        "DATE": time.strftime("%Y-%m-%d"),
        "ORGANISATION": options.get("audience") or "Pomegranate",
        "CLIENT": options.get("audience") or "",
        "REFERENCE": "素材整理",
        "ATTRIBUTION": "素材整理",
        "SOURCE": "素材整理",
        "SOURCE_LINE": "素材整理",
        "TABLE_NOTE": "数据来源：素材整理",
        "SUMMARY_NOTE": "数据来源：素材整理",
        "APPENDIX_NOTE": "附录",
        "DELIVERY_NOTE": core or (bullets[0] if bullets else ""),
        "FINANCING_RISK": core or (bullets[0] if bullets else ""),
        "RISK_SCORE": core or (bullets[0] if bullets else ""),
        "COMPARISON_INSIGHT": core or (bullets[0] if bullets else ""),
        "KEY_IMPLICATION": core or (bullets[0] if bullets else ""),
        "OUTLOOK_SIGNAL": core or (bullets[0] if bullets else ""),
        "FINAL_ALGORITHM": core or (bullets[0] if bullets else ""),
        "ROOT_CAUSE": core or (bullets[0] if bullets else ""),
        "ROOT_QUESTION": core or title,
        "DECISION_NOTE": core or (bullets[0] if bullets else ""),
        "COMBINATION_NOTE": core or (bullets[0] if bullets else ""),
        "PROCESS_NOTE": core or (bullets[0] if bullets else ""),
        "WORKFLOW_NOTE": core or (bullets[0] if bullets else ""),
        "TIMELINE_NOTE": core or (bullets[0] if bullets else ""),
        "MAP_NOTE": core or (bullets[0] if bullets else ""),
        "RELATIONSHIP_NOTE": core or (bullets[0] if bullets else ""),
        "MODEL_NOTE": core or (bullets[0] if bullets else ""),
        "FIGURE_CAPTION": bullets[0] if bullets else core,
        "YAO_ANALYSIS": core or (bullets[0] if bullets else ""),
        "YAO_POSITION": core or title,
        "YAO_TEXT": core or (bullets[0] if bullets else ""),
        "TEXT_TITLE": title,
        "TEXT_DETAIL": core or (bullets[0] if bullets else ""),
        "INSTALL_COMMAND": "pip install python-pptx",
        "PROGRAMME_LINK": "",
        "ORIGIN": title,
        "SUMMARY": core or (bullets[0] if bullets else ""),
        "TAKEAWAY": core or (bullets[0] if bullets else ""),
        "PAGE_NUM": str(index + 1),
        "CHAPTER_NUM": f"{index + 1:02d}",
        "CHAPTER_TITLE": title,
        "CHAPTER_DESC": core or title,
        # 签名栏默认留空；没有签署信息时不应把页面要点误填到人名/日期槽位。
        "SIGN_1": "",
        "SIGN_2": "",
        "SIGN_3": "",
    }
    if token in fixed:
        return str(fixed[token])

    toc = re.match(r"^TOC_ITEM_(\d+)_(TITLE|DESC)$", token)
    if toc:
        position = int(toc.group(1)) - 1
        if 0 <= position < len(plan["slides"]):
            item = plan["slides"][position]
            return (
                item.get("title") or ""
                if toc.group(2) == "TITLE"
                else item.get("coreMessage") or ""
            )
        return ""

    match = re.match(r"^([A-Z]+(?:_[A-Z]+)*)_(\d+)(?:_([A-Z]+))?$", token)
    if not match:
        return ""
    prefix, number, suffix = match.group(1), int(match.group(2)), match.group(3) or ""

    if prefix == "SECTION":
        item = slide_at(number)
        if not item:
            return ""
        if suffix in ("TITLE", "LABEL", "NAME"):
            return item.get("title") or ""
        if suffix in ("DESC", "DETAIL", "NOTE", "TEXT"):
            return item.get("coreMessage") or ""
        return item.get("coreMessage") or item.get("title") or ""

    # 模板槽位数量有限（表格 5 行、提示 3 条、流程 5 步、卡片 6 张）；
    # 超出的要点合并到最后一个槽位，避免直接丢失。
    capacity = {"ROW": 5, "NOTICE": 3, "STEP": 5, "CARD": 6}.get(prefix)
    if capacity and number == capacity and len(bullets) > capacity:
        remainder = bullets[number - 1 :]
        if suffix in ("TITLE", "LABEL", "NAME", "THEME"):
            return _bullet_parts(remainder[0])[0]
        if suffix in (
            "DETAIL",
            "DESC",
            "NOTE",
            "POSITIONING",
            "STAGE",
            "IMPACT",
            "QUESTION",
            "HIGHLIGHT",
        ):
            return "；".join(
                _bullet_parts(item)[1] or item for item in remainder
            )
        return "；".join(remainder)

    raw = item_at(number)
    label, detail, value = _bullet_parts(raw)
    if suffix in ("TITLE", "LABEL", "NAME", "THEME", "TOOL"):
        return label or raw
    if suffix in ("VALUE", "METRIC", "KPI"):
        return value or detail or raw
    if suffix == "DELTA":
        return "—"
    if suffix in ("DETAIL", "DESC", "NOTE", "POSITIONING", "STAGE", "IMPACT", "QUESTION", "HIGHLIGHT"):
        # 没有独立说明时保持为空，不能回退到整条要点，否则标题与正文重复。
        return detail
    if suffix in ("TEXT", "DATA", "ROW", "META", "SOURCE"):
        return raw
    return raw


def _shift_number(element: ET.Element, attribute: str, delta: float) -> None:
    raw = element.get(attribute)
    if raw is None:
        return
    try:
        element.set(attribute, _fmt(float(raw) + delta))
    except ValueError:
        pass


def _shift_element(element: ET.Element, dx: float, dy: float) -> None:
    """平移元素及其后代的绝对坐标，用于卡片重排。"""
    tag = _local_tag(element)
    if tag in ("rect", "image", "use"):
        _shift_number(element, "x", dx)
        _shift_number(element, "y", dy)
    elif tag == "circle":
        _shift_number(element, "cx", dx)
        _shift_number(element, "cy", dy)
    elif tag == "line":
        _shift_number(element, "x1", dx)
        _shift_number(element, "x2", dx)
        _shift_number(element, "y1", dy)
        _shift_number(element, "y2", dy)
    elif tag in ("text", "tspan"):
        _shift_number(element, "x", dx)
        _shift_number(element, "y", dy)
    raw_bounds = element.get("data-pptx-bounds")
    if raw_bounds:
        parts = raw_bounds.split()
        if len(parts) == 4:
            try:
                bx, by, bw, bh = (float(part) for part in parts)
                element.set(
                    "data-pptx-bounds",
                    f"{_fmt(bx + dx)} {_fmt(by + dy)} {_fmt(bw)} {_fmt(bh)}",
                )
            except ValueError:
                pass
    for child in element:
        _shift_element(child, dx, dy)


def localize_template_labels(svg: str) -> str:
    """把模板里的英文占位标签换成中文，避免成稿出现 CONTENT AREA 等残留。"""
    svg = svg.replace(">CONTENT AREA<", ">内容要点<")
    # 表格数据行横跨三列，表头改为单列标题，删除多余的两列标签。
    svg = re.sub(
        r'<text\b[^>]*\bid="tbl-head-2"[^>]*>.*?</text>', "", svg, flags=re.S
    )
    svg = re.sub(
        r'<text\b[^>]*\bid="tbl-head-3"[^>]*>.*?</text>', "", svg, flags=re.S
    )
    svg = svg.replace(">ITEM<", ">条目与说明<")
    return svg


def _drop_empty_cards(svg: str, bullet_count: int) -> str:
    """按实际条目数删除空卡并重排剩余卡片。

    模板的卡片采用固定编号（card-N / card-bar-N / card-dot-N /
    card-title-slot-N / card-body-slot-N）。当要点少于卡片数时，
    删除多出的卡片，避免空卡或空槽被填入无关内容。
    """
    if bullet_count <= 0:
        return svg
    if "CARD_1_TITLE" not in svg and 'id="card-title-slot-1"' not in svg:
        return svg
    try:
        ET.register_namespace("", SVG_NS)
        root = ET.fromstring(svg)
    except ET.ParseError:
        return svg
    parents = _parent_map(root)
    cards: dict[int, ET.Element] = {}
    for element in root.iter():
        match = re.fullmatch(r"card-(\d+)", element.get("id") or "")
        if match:
            cards[int(match.group(1))] = element
    if not cards:
        return svg

    ordered = sorted(cards)
    keep = set(ordered[: max(1, min(bullet_count, len(ordered)))])
    removable = re.compile(
        r"card(?:-bar|-dot|-title-slot|-body-slot)?-(\d+)$"
    )
    for element in list(root.iter()):
        match = removable.fullmatch(element.get("id") or "")
        if not match:
            continue
        if int(match.group(1)) in keep:
            continue
        parent = parents.get(element)
        if parent is None:
            continue
        try:
            parent.remove(element)
        except ValueError:
            pass

    kept = ordered[: len(keep)]
    count = len(kept)
    if count <= 3:
        row_counts = [count]
        y_positions = [(720 - 214) / 2]
    else:
        cols = 2 if count == 4 else 3
        first_row = min(cols, count)
        row_counts = [first_row, count - first_row]
        y_positions = [156, 394]

    index = 0
    for row, row_count in enumerate(row_counts):
        if row_count <= 0:
            continue
        row_width = row_count * 344 + (row_count - 1) * 32
        x_start = (1280 - row_width) / 2
        for col in range(row_count):
            number = kept[index]
            index += 1
            card = cards.get(number)
            if card is None:
                continue
            try:
                old_x = float(card.get("x") or 0)
                old_y = float(card.get("y") or 0)
            except ValueError:
                continue
            new_x = x_start + col * (344 + 32)
            new_y = y_positions[row]
            dx, dy = new_x - old_x, new_y - old_y
            if abs(dx) < 0.01 and abs(dy) < 0.01:
                continue
            for element_id in (
                f"card-bar-{number}",
                f"card-dot-{number}",
                f"card-title-slot-{number}",
                f"card-body-slot-{number}",
            ):
                target = next(
                    (
                        item
                        for item in root.iter()
                        if item.get("id") == element_id
                    ),
                    None,
                )
                if target is not None:
                    _shift_element(target, dx, dy)
            _shift_element(card, dx, dy)

    return ET.tostring(root, encoding="unicode")


def fill_layout_svg(
    svg: str,
    slide: dict,
    index: int,
    plan: dict,
    job: dict,
    section_name: str,
    chart: dict | None = None,
    chart_colors: list[str] | None = None,
) -> str:
    replacements = _token_replacements(slide, index, plan, job, section_name)
    core = slide.get("coreMessage") or ""
    layout_id = (job.get("templates") or {}).get("layoutId")
    _, _, canvas_width, _ = _detect_canvas(layout_id)
    max_width = max(160, canvas_width - 80)
    for key, value in replacements.items():
        svg = replace_text_placeholder(
            svg,
            key,
            value,
            max_width=360 if key.startswith("TOC_ITEM") else max_width,
            min_size=14 if key.startswith("TOC_ITEM") else 24,
        )
    if "模块标题" in svg:
        svg = fill_card_titles(svg, slide.get("bullets") or [])
        svg = replace_text_placeholder(
            svg, "CONTENT_AREA", core, max_width=max_width, min_size=14
        )
    else:
        svg = replace_content_area(
            svg,
            slide.get("bullets") or [],
            core,
            chart=chart,
            colors=chart_colors,
        )
    svg = re.sub(r"\{\{[A-Z0-9_]+\}\}", "", svg)
    return localize_template_labels(
        _drop_empty_cards(svg, len(slide.get("bullets") or []))
    )


SVG_NS = "http://www.w3.org/2000/svg"
CHART_PLACEHOLDER_KEYS = {
    "chart",
    "chart_area",
    "chart_placeholder",
    "native_chart",
}
CONTENT_PLACEHOLDER_KEYS = {
    "content",
    "content_area",
    "body",
    "bullets",
    "content_text",
    "object",
    "table",
}
PICTURE_PLACEHOLDER_KEYS = {"picture", "image", "photo", "img"}

# flat 模式下 quality checker 禁止出现这些结构标记（bounds / replace-with 等仍保留）。
PPTX_STRUCTURE_ATTRS = {
    "data-pptx-master",
    "data-pptx-master-name",
    "data-pptx-layout",
    "data-pptx-layout-name",
    "data-pptx-show-master-shapes",
    "data-pptx-show-inherited-shapes",
    "data-pptx-layer",
    "data-pptx-layout-kind",
    "data-pptx-placeholder",
    "data-pptx-binding",
    "data-pptx-carrier",
    "data-pptx-idx",
}

CANVAS_BY_SIZE = {
    (1280, 720): "ppt169",
    (1024, 768): "ppt43",
    (1080, 1080): "moments",
    (1242, 1660): "xiaohongshu",
    (1080, 1920): "story",
    (1920, 1080): "banner",
    (1240, 1754): "a4",
    (900, 383): "wechat",
}


def _fmt(value: float) -> str:
    return f"{value:.1f}".rstrip("0").rstrip(".")


def _parse_bounds(value: str | None) -> tuple[float, float, float, float] | None:
    if not value:
        return None
    parts = [part for part in re.split(r"[\s,]+", value.strip()) if part]
    if len(parts) < 4:
        return None
    try:
        return (float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3]))
    except ValueError:
        return None


def _find_bounds(
    element: ET.Element,
    parents: dict[ET.Element, ET.Element],
) -> tuple[float, float, float, float] | None:
    node: ET.Element | None = element
    while node is not None:
        bounds = _parse_bounds(node.get("data-pptx-bounds"))
        if bounds is not None:
            return bounds
        node = parents.get(node)
    return None


def _detect_canvas(layout_id: str | None) -> tuple[str, str, int, int]:
    """从所选版式的第一张 SVG 推导画布格式，避免非 16:9 模板写错 spec_lock。"""
    pages = layout_pages(layout_id)
    if pages:
        try:
            text = next(iter(pages.values())).read_text(encoding="utf-8")
        except OSError:
            text = ""
        match = re.search(r'\bwidth="([0-9.]+)"\s+height="([0-9.]+)"', text)
        if match:
            width = int(round(float(match.group(1))))
            height = int(round(float(match.group(2))))
            key = CANVAS_BY_SIZE.get((width, height))
            if key:
                return key, f"0 0 {width} {height}", width, height
    return "ppt169", "0 0 1280 720", 1280, 720


def strip_pptx_structure_attrs(svg: str) -> str:
    """移除 flat 导出不允许的结构化标记，保留 bounds / replace-with 等导出标记。"""
    try:
        ET.register_namespace("", SVG_NS)
        ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
        root = ET.fromstring(svg)
    except ET.ParseError:
        pattern = re.compile(
            r"\s(?:" + "|".join(re.escape(name) for name in PPTX_STRUCTURE_ATTRS) + r')="[^"]*"'
        )
        return pattern.sub("", svg)
    for element in root.iter():
        for attr in list(element.attrib):
            if attr in PPTX_STRUCTURE_ATTRS:
                del element.attrib[attr]
            elif attr == "data-pptx-bounds" and not element.get(
                "data-pptx-replace-with"
            ):
                # 普通槽位已在填充阶段按 bounds 排版；flat 导出保留 bounds
                # 会让质量检查把模板自身的设计性叠压判为模块冲突。
                del element.attrib[attr]
    return ET.tostring(root, encoding="unicode")


def _local_tag(element: ET.Element) -> str:
    tag = element.tag
    if isinstance(tag, str) and "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _placeholder_key(element: ET.Element) -> str | None:
    for name in ("data-pptx-placeholder", "data-placeholder"):
        value = element.get(name)
        if not value:
            continue
        key = value.strip().split()[0].lower()
        return key.replace("-", "_").replace(" ", "_")
    return None


def _parent_map(root: ET.Element) -> dict[ET.Element, ET.Element]:
    return {child: parent for parent in root.iter() for child in parent}


def _placeholder_value(
    key: str,
    index: int,
    slide: dict,
    plan: dict,
    job: dict,
    section_name: str,
) -> str | None:
    options = job.get("options") or {}
    title = slide.get("title") or plan["title"]
    core = slide.get("coreMessage") or ""
    mapping = {
        "title": title,
        "presentation_title": plan["title"],
        "page_title": title,
        "slide_title": title,
        "heading": title,
        "subtitle": core or title,
        "core_message": core,
        "description": core,
        "section_name": section_name or plan["title"],
        "chapter_title": title,
        "chapter_num": f"{index + 1:02d}",
        "page_num": str(index + 1),
        "page_number": str(index + 1),
        "pagenum": str(index + 1),
        "slide_number": str(index + 1),
        "footer": options.get("audience") or "Pomegranate",
        "author": "Pomegranate",
        "date": time.strftime("%Y-%m-%d"),
        "thank_you": "谢谢",
        "contact_info": options.get("audience") or "",
    }
    if key in mapping:
        return mapping[key]
    toc = re.match(r"toc_item_(\d+)_(title|desc)", key)
    if toc:
        position = int(toc.group(1)) - 1
        if 0 <= position < len(plan["slides"]):
            item = plan["slides"][position]
            if toc.group(2) == "title":
                return item.get("title") or ""
            return item.get("coreMessage") or ""
    # 结构化模板里还有 source / caption / key_message / step_1 等键，
    # 统一复用 {{TOKEN}} 的取值，避免只做文本替换而绕过槽位排版。
    resolved = _resolve_token(key.upper(), slide, index, plan, job, section_name)
    return resolved or None


def _text_target(element: ET.Element) -> ET.Element | None:
    if _local_tag(element) == "text":
        return element
    for child in element.iter():
        if _local_tag(child) == "text":
            return child
    return None


def _carrier_token(element: ET.Element) -> str | None:
    target = _text_target(element)
    if target is None:
        return None
    text = "".join(target.itertext())
    match = re.search(r"\{\{([A-Z0-9_]+)\}\}", text)
    return match.group(1) if match else None


def _apply_text(
    element: ET.Element,
    value: str,
    max_width: float = 1120,
    min_size: int = 24,
    lines: list[str] | None = None,
    bounds: tuple[float, float, float, float] | None = None,
) -> bool:
    """把文本写入 SVG text 元素；按槽位 bounds 缩字号、换行并限制行数。"""
    target = _text_target(element)
    if target is None:
        return False
    for child in list(target):
        target.remove(child)
    target.text = ""

    anchor = (target.get("text-anchor") or "start").strip().lower()
    x = 0.0
    max_height: float | None = None
    if bounds:
        bx, by, bw, bh = bounds
        padding = min(24.0, max(4.0, min(bw, bh) * 0.04))
        max_width = max(80.0, bw - 2 * padding)
        max_height = max(20.0, bh - 2 * padding)
        min_size = min(float(min_size), max(8.0, max_height * 0.8))
        if anchor == "middle":
            x = bx + bw / 2
        elif anchor == "end":
            x = bx + bw - padding
        else:
            x = bx + padding
        target.set("x", _fmt(x))
    else:
        try:
            x = float(target.get("x") or 0)
        except ValueError:
            x = 0.0

    try:
        size = float(target.get("font-size") or 24)
    except ValueError:
        size = 24.0
    if bounds and max_height is not None:
        max_font = max(8.0, max_height * 0.85)
        if size > max_font:
            size = max(float(min_size), max_font)
            target.set("font-size", _fmt(size))

    if lines is None:
        text = str(value).strip()
        if not text:
            return True
        source_lines = [text]
        units = _text_width_units(text)
        estimated = units * size
        if estimated > max_width:
            size = max(float(min_size), size * max_width / max(estimated, 1.0))
            target.set("font-size", _fmt(size))
            estimated = units * size
        if estimated <= max_width:
            target.text = text
            if bounds:
                target.set("y", _fmt(by + padding + size))
            return True
        max_chars = max(8, int(max_width / max(size * 1.2, 1e-6)))
        lines = wrap_text(text, max_chars, 12)
    else:
        source_lines = [str(line) for line in lines if str(line).strip()]
        max_chars = max(8, int(max_width / max(size * 1.2, 1e-6)))
        wrapped: list[str] = []
        for line in source_lines:
            wrapped.extend(wrap_text(line, max_chars, 4) or [line])
        lines = wrapped

    if not lines:
        return True

    line_height = max(12, int(size * 1.3))
    if max_height is not None:
        max_lines = max(1, int(max_height // line_height))
        while size > float(min_size) and len(lines) > max_lines:
            size = max(float(min_size), size * 0.9)
            max_chars = max(8, int(max_width / max(size * 1.2, 1e-6)))
            wrapped = []
            for line in source_lines:
                wrapped.extend(wrap_text(line, max_chars, 4) or [line])
            lines = wrapped
            line_height = max(12, int(size * 1.3))
            max_lines = max(1, int(max_height // line_height))
        if len(lines) > max_lines:
            dropped = len(lines) - max_lines
            lines = lines[:max_lines]
            if lines:
                lines[-1] = lines[-1].rstrip("…").rstrip() + "…"
            log(
                f"文本超出槽位 {element.get('id') or 'text'}，已截断 {dropped} 行",
                "warn",
            )
        target.set("font-size", _fmt(size))

    if bounds:
        target.set("y", _fmt(by + padding + size))
    for position, line in enumerate(lines):
        tspan = ET.SubElement(target, f"{{{SVG_NS}}}tspan")
        tspan.set("x", _fmt(x))
        tspan.set("dy", "0" if position == 0 else str(line_height))
        tspan.text = line
    return True


def _replace_with_chart(
    root: ET.Element,
    parents: dict[ET.Element, ET.Element],
    element: ET.Element,
    chart: dict,
    colors: list[str],
    bounds: tuple[float, float, float, float] | None = None,
) -> bool:
    parent = parents.get(element)
    if parent is None:
        return False
    if bounds:
        x, y, width, height = bounds
    else:
        try:
            x = float(element.get("x") or 140)
            y = float(element.get("y") or 180)
            width = float(element.get("width") or 980)
            height = float(element.get("height") or 340)
        except ValueError:
            x, y, width, height = 140.0, 180.0, 980.0, 340.0
    fragment = render_chart_fragment(chart, width, height, colors)
    if not fragment:
        return False
    try:
        wrapper = ET.fromstring(f'<svg xmlns="{SVG_NS}">{fragment}</svg>')
    except ET.ParseError as exc:
        log(f"图表片段解析失败: {exc}", "warn")
        return False
    group = ET.Element(f"{{{SVG_NS}}}g")
    group.set("transform", f"translate({x:.1f},{y:.1f})")
    for child in list(wrapper):
        wrapper.remove(child)
        group.append(child)
    try:
        position = list(parent).index(element)
    except ValueError:
        position = len(parent)
    try:
        parent.remove(element)
        parent.insert(position, group)
    except ValueError:
        return False
    return True


def _replace_with_native_placeholder(
    root: ET.Element,
    parents: dict[ET.Element, ET.Element],
    element: ET.Element,
    page: int,
    bounds: tuple[float, float, float, float] | None = None,
) -> bool:
    """原生图表模式：把图表槽位替换为带名称的透明矩形。

    该矩形由 svg_to_pptx 导出为同名 shape，导出后由 python-pptx
    删除并在同一位置插入可编辑的原生图表。
    """
    parent = parents.get(element)
    if parent is None:
        return False
    if bounds:
        x, y, width, height = bounds
    else:
        try:
            x = float(element.get("x") or 140)
            y = float(element.get("y") or 180)
            width = float(element.get("width") or 980)
            height = float(element.get("height") or 340)
        except ValueError:
            x, y, width, height = 140.0, 180.0, 980.0, 340.0
    rect = ET.Element(f"{{{SVG_NS}}}rect")
    rect.set("x", f"{x:.1f}")
    rect.set("y", f"{y:.1f}")
    rect.set("width", f"{width:.1f}")
    rect.set("height", f"{height:.1f}")
    rect.set("fill", "none")
    rect.set("stroke", "none")
    rect.set("data-pptx-shape-name", f"NATIVE_CHART_P{page:02d}")
    try:
        position = list(parent).index(element)
    except ValueError:
        position = len(parent)
    try:
        parent.remove(element)
        parent.insert(position, rect)
    except ValueError:
        return False
    return True


def fill_structured_layout(
    svg: str,
    slide: dict,
    index: int,
    plan: dict,
    job: dict,
    section_name: str,
    chart: dict | None = None,
    colors: list[str] | None = None,
    native_placeholder: bool = False,
) -> str:
    """填充使用 data-pptx-placeholder 的结构化版式。

    ``native_placeholder`` 为真时，图表槽位改为带名称的透明矩形，
    供后续叠加可编辑的原生图表。
    """
    try:
        ET.register_namespace("", SVG_NS)
        ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        log(f"结构化版式解析失败，回退内置渲染: {exc}", "warn")
        return svg

    parents = _parent_map(root)
    placeholders = [
        element
        for element in root.iter()
        if _placeholder_key(element) is not None
    ]
    has_chart_slot = any(
        _placeholder_key(element) in CHART_PLACEHOLDER_KEYS
        for element in placeholders
    )
    palette = colors or DEFAULT_CHART_COLORS

    for element in placeholders:
        key = _placeholder_key(element)
        if not key:
            continue
        bounds = _find_bounds(element, parents)
        carrier_token = _carrier_token(element)
        if (
            carrier_token
            and carrier_token not in {"CONTENT_AREA", "CONTENT", "BODY", "BULLETS"}
            and key not in CHART_PLACEHOLDER_KEYS
            and key not in PICTURE_PLACEHOLDER_KEYS
        ):
            resolved = _resolve_token(
                carrier_token, slide, index, plan, job, section_name
            )
            if resolved:
                _apply_text(
                    element,
                    resolved,
                    max_width=1120,
                    min_size=10,
                    bounds=bounds,
                )
            # 有明确 token 的槽位以 token 结果为准；为空就留空，
            # 不再回退到通用 body 内容，避免空卡被整页要点填充。
            continue
        if key in CHART_PLACEHOLDER_KEYS:
            if chart:
                if native_placeholder:
                    _replace_with_native_placeholder(
                        root,
                        parents,
                        element,
                        int(slide.get("page") or index + 1),
                        bounds,
                    )
                else:
                    _replace_with_chart(root, parents, element, chart, palette, bounds)
            else:
                parent = parents.get(element)
                if parent is not None:
                    try:
                        parent.remove(element)
                    except ValueError:
                        pass
            continue

        if key in PICTURE_PLACEHOLDER_KEYS:
            # 图片槽位常与标题/文字槽位重叠（出血图）。flat 模式下删除其
            # bounds，避免质量检查把设计上的叠压误判为模块冲突。
            element.attrib.pop("data-pptx-bounds", None)
            continue

        if key in CONTENT_PLACEHOLDER_KEYS:
            if chart and not has_chart_slot:
                if native_placeholder:
                    _replace_with_native_placeholder(
                        root,
                        parents,
                        element,
                        int(slide.get("page") or index + 1),
                        bounds,
                    )
                elif not _replace_with_chart(
                    root, parents, element, chart, palette, bounds
                ):
                    continue
            else:
                lines = content_lines(
                    slide.get("bullets") or [],
                    slide.get("coreMessage") or "",
                )
                if not lines:
                    lines = [slide.get("coreMessage") or ""]
                _apply_text(
                    element,
                    "",
                    max_width=1000,
                    min_size=12,
                    lines=lines,
                    bounds=bounds,
                )
            continue

        value = _placeholder_value(key, index, slide, plan, job, section_name)
        if value is None:
            continue
        max_width = 360 if key.startswith("toc_item") else 1120
        min_size = 12 if key.startswith("toc_item") else 20
        _apply_text(
            element,
            value,
            max_width=max_width,
            min_size=min_size,
            bounds=bounds,
        )

    result = ET.tostring(root, encoding="unicode")
    # 结构化模板里仍可能残留 {{TOKEN}}（例如 KEY_MESSAGE / SOURCE / STEP_1）。
    layout_id = (job.get("templates") or {}).get("layoutId")
    _, _, canvas_width, _ = _detect_canvas(layout_id)
    max_width = max(160, canvas_width - 80)
    for token in set(re.findall(r"\{\{([A-Z0-9_]+)\}\}", result)):
        value = _resolve_token(token, slide, index, plan, job, section_name)
        if value:
            result = replace_text_placeholder(
                result, token, value, max_width=max_width, min_size=10
            )
    result = re.sub(r"\{\{[A-Z0-9_]+\}\}", "", result)
    return localize_template_labels(
        _drop_empty_cards(result, len(slide.get("bullets") or []))
    )


def choose_page_type(
    slide: dict,
    index: int,
    total: int,
    pages: dict[str, Path],
) -> str | None:
    available = set(pages)
    title = slide.get("title") or ""
    bullets = [str(item) for item in (slide.get("bullets") or [])]
    # 封面/结束页只承担标题与一句摘要；有实质要点时改用内容版式，避免丢内容。
    if index == 0 and "cover" in available and len(bullets) < 3:
        return "cover"
    if (
        index == total - 1
        and total > 2
        and "ending" in available
        and len(bullets) < 3
    ):
        return "ending"
    if "toc" in available and re.search(r"目录|agenda|contents", title, re.I):
        return "toc"
    if "chapter" in available and re.match(
        r"^(第.+?[章节部分]|part\s*\d+|section\s*\d+)", title, re.I
    ):
        return "chapter"
    # 优先使用结构化规划给出的页面意图，标题关键词只作为兜底。
    chart_type = str(slide.get("chartType") or slide.get("chart_type") or "").strip().lower()
    relation = str(slide.get("relation") or "").strip().lower()
    density = str(slide.get("density") or "").strip().lower()
    if chart_type in ("timeline", "process") and "process_steps" in available:
        return "process_steps"
    if chart_type in ("compare", "matrix") and "content_table" in available:
        return "content_table"
    if chart_type == "cards" and "content_cards" in available:
        return "content_cards"
    if chart_type == "highlight" and "safety_notice" in available:
        return "safety_notice"
    if chart_type == "summary" and "content" in available:
        return "content"
    if relation in ("timeline", "process") and "process_steps" in available:
        return "process_steps"
    if relation == "compare" and "content_table" in available:
        return "content_table"
    if relation == "cause" and "content" in available:
        return "content"
    if relation == "category" and "content_cards" in available:
        return "content_cards"
    if density == "anchor" and "content" in available:
        return "content"
    if density == "dense" and len(bullets) >= 4 and "content_table" in available:
        return "content_table"
    # 按内容语义选择版式，避免所有内容页都落到同一种卡片版式。
    if "content" in available and re.search(
        r"研究范围|核心结论|总体|概述|总览|研究定位|总结|优先|先读|阅读顺序", title
    ):
        return "content"
    if "safety_notice" in available and re.search(
        r"边界|风险|注意|限制|禁止|误区|不能", title
    ):
        return "safety_notice"
    if "process_steps" in available and re.search(
        r"路线|步骤|流程|阶段|实施|行动|下一步|落地|推进", title
    ):
        return "process_steps"
    if "content_table" in available and len(bullets) >= 4 and (
        any("|" in item for item in bullets)
        or re.search(r"清单|对比|等级|参数|指标|矩阵|优先级|^P\d|P\d+\s*[/、,，]", title)
    ):
        return "content_table"
    if "content" in available and re.search(
        r"用法|如何进入|怎么用|实现路径|进入软件", title
    ):
        return "content"
    if "content_cards" in available and len(bullets) >= 3:
        return "content_cards"
    if "content_text_image" in available and slide.get("images"):
        return "content_text_image"
    if "content" in available:
        return "content"
    for page_type in available:
        if "content" in page_type:
            return page_type
    return None


def alternate_page_type(
    page_type: str | None,
    previous: str | None,
    pages: dict[str, Path],
    bullets: list[str],
) -> str | None:
    """连续两页使用同一版式时切换到备选版式，避免整份 PPT 节奏单一。"""
    if not page_type or page_type != previous:
        return page_type
    options = {
        "content_cards": ("content_table", "content"),
        "content_table": ("content_cards", "content"),
        "content": ("content_cards",),
    }.get(page_type, ())
    for option in options:
        if option not in pages:
            continue
        if option == "content_table" and len(bullets) < 4:
            continue
        return option
    return page_type


def normalize_plan(plan: dict, source: str, job: dict) -> dict:
    title = (plan.get("title") or job.get("source", {}).get("title") or "AI PPT").strip()
    slides = plan.get("slides") or []
    if not isinstance(slides, list) or not slides:
        slides = []
        headings = []
        for line in source.splitlines():
            line = line.strip()
            if line.startswith("#"):
                value = line.lstrip("#").strip()
                if value:
                    headings.append(value)
        if not headings:
            headings = [title]
        for index, heading in enumerate(headings[:40], start=1):
            slides.append({"page": index, "title": heading, "coreMessage": "", "bullets": []})
    normalized = []
    for index, slide in enumerate(slides[:40], start=1):
        if not isinstance(slide, dict):
            continue
        bullets = slide.get("bullets") or []
        if not isinstance(bullets, list):
            bullets = []
        entry = {
            "page": index,
            "title": str(slide.get("title") or f"第 {index} 页").strip(),
            "coreMessage": str(slide.get("coreMessage") or "").strip(),
            "bullets": [str(item).strip() for item in bullets if str(item).strip()][:6],
        }
        chart = normalize_chart(slide.get("chart"))
        if chart:
            entry["chart"] = chart
        normalized.append(entry)
    if not normalized:
        normalized = [{"page": 1, "title": title, "coreMessage": "", "bullets": []}]
    return {"title": title, "slides": normalized}


def build_design_spec(plan: dict, job: dict) -> str:
    templates = job.get("templates") or {}
    options = job.get("options") or {}
    lines = [
        f"# {plan['title']}",
        "",
        "## I. 生成信息",
        "",
        f"- 听众：{options.get('audience') or '未指定'}",
        f"- 语言：{options.get('language') or 'zh-CN'}",
        f"- 版式模板：{templates.get('layoutId') or 'default'}",
        f"- 图表模板：{', '.join(templates.get('chartIds') or []) or '无'}",
        f"- 页数：{len(plan['slides'])}",
        "",
        "## II. 页面规划",
        "",
    ]
    for slide in plan["slides"]:
        lines.append(f"### P{slide['page']:02d} {slide['title']}")
        if slide.get("coreMessage"):
            lines.append(f"- 核心信息：{slide['coreMessage']}")
        for bullet in slide.get("bullets", []):
            lines.append(f"- {bullet}")
        lines.append("")
    lines.extend(["## IX. Content Outline", "", "### Part 1: 主要内容", ""])
    for slide in plan["slides"]:
        content = "；".join(slide.get("bullets") or []) or slide.get("coreMessage") or slide["title"]
        lines.extend(
            [
                f"#### Slide {slide['page']:02d} - {slide['title']}",
                "",
                "- **Audience move**: 了解背景 → 理解关键结论",
                "- **Relationships**: 页面内容按叙事顺序排列",
                f"- **Title**: {slide['title']}",
                f"- **Core message**: {slide.get('coreMessage') or slide['title']}",
                f"- **Content**: {content}",
                "",
            ]
        )
    lines.extend(
        [
            "## X. Speaker Notes Requirements",
            "",
            "- **Generation**: disabled",
            "- **Filename**: match each SVG filename under notes/",
            "- **Content**: none",
            "",
        ]
    )
    return "\n".join(lines)


def build_spec_lock(
    plan: dict,
    job: dict,
    extra_sizes: list[float] | None = None,
) -> str:
    templates = job.get("templates") or {}
    layout = templates.get("layoutId") or "default"
    palette = PALETTES.get(layout, PALETTES["default"])
    canvas_format, viewbox, _, _ = _detect_canvas(layout)
    lines = [
        "# SPEC LOCK",
        "",
        "## canvas",
        f"- viewBox: {viewbox}",
        f"- format: {canvas_format}",
        "",
        "## colors",
        f"- bg: {palette[2]}",
        f"- primary: {palette[0]}",
        f"- accent: {palette[1]}",
        f"- text: {palette[0]}",
        f"- secondary_text: {palette[0]}",
        f"- divider: {palette[3]}",
        "",
        "## icons",
        "- library: none",
        "- inventory: none",
        "",
        "## page_rhythm",
    ]
    for slide in plan["slides"]:
        lines.append(f"- P{slide['page']:02d}: anchor")
    lines.extend([
        "",
        "## typography",
        "- font_family: Microsoft YaHei, PingFang SC, sans-serif",
        "- title_family: Microsoft YaHei, PingFang SC, sans-serif",
        "- body_family: Microsoft YaHei, PingFang SC, sans-serif",
        "- title: 44",
        "- body: 24",
        "- caption: 14",
        "- label: 15",
        "- body_small: 20",
        "- page_title: 32",
        "- section_title: 37",
    ])
    declared_anchors = [44.0, 24.0, 14.0, 15.0, 20.0, 32.0, 37.0]
    seen_sizes: set[int] = set()
    for size in extra_sizes or []:
        rounded = int(round(float(size)))
        if rounded <= 0 or rounded in seen_sizes:
            continue
        if any(abs(float(size) - anchor) <= 2.0 for anchor in declared_anchors):
            continue
        seen_sizes.add(rounded)
        lines.append(f"- display_{rounded}: {rounded}")
    lines.extend([
        "",
        "## communication",
        f"- primary_language: {(job.get('options') or {}).get('language') or 'zh-CN'}",
        f"- audience: {(job.get('options') or {}).get('audience') or 'General'}",
        "- objective: present the source material clearly",
        f"- core_message: {plan['title']}",
        "",
        "## pptx_structure",
        "- mode: flat",
        "",
        "## slides",
    ])
    for slide in plan["slides"]:
        lines.append(f"- P{slide['page']:02d} {slide['title']}")
    lines.append("")
    return "\n".join(lines)


def build_notes(plan: dict) -> str:
    lines = [f"# {plan['title']} · 讲稿", ""]
    for slide in plan["slides"]:
        lines.append(f"## P{slide['page']:02d} {slide['title']}")
        if slide.get("coreMessage"):
            lines.append(slide["coreMessage"])
        for bullet in slide.get("bullets", []):
            lines.append(f"- {bullet}")
        lines.append("")
    return "\n".join(lines)


def render_svg(slide: dict, total: int, layout: str) -> str:
    ink, accent, bg, surface = PALETTES.get(layout, PALETTES["default"])
    _, _, canvas_w, canvas_h = _detect_canvas(layout)
    sx = canvas_w / 1280.0
    sy = canvas_h / 720.0
    scale = min(sx, sy)

    def X(value: float) -> str:
        return _fmt(value * sx)

    def Y(value: float) -> str:
        return _fmt(value * sy)

    def F(value: float) -> int:
        return max(10, int(round(value * scale)))

    bullets = slide.get("bullets") or []
    if not bullets and slide.get("coreMessage"):
        bullets = [slide["coreMessage"]]
    max_chars = max(12, int(34 / max(sx, 0.1)))
    body_lines: list[str] = []
    for bullet in bullets[:5]:
        wrapped = wrap_text(bullet, max_chars, 2)
        if wrapped:
            body_lines.append("• " + wrapped[0])
            body_lines.extend("   " + line for line in wrapped[1:])
    y = 240.0
    body_svg = []
    for line in body_lines[:12]:
        body_svg.append(
            f'<text x="{X(120)}" y="{Y(y)}" font-size="{F(26)}" fill="{ink}">{escape(line)}</text>'
        )
        y += 52
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_w}" height="{canvas_h}" viewBox="0 0 {canvas_w} {canvas_h}"
     font-family="Microsoft YaHei, PingFang SC, sans-serif">
  <rect width="{canvas_w}" height="{canvas_h}" fill="{bg}"/>
  <rect x="0" y="0" width="{X(18)}" height="{canvas_h}" fill="{accent}"/>
  <rect x="{X(80)}" y="{Y(96)}" width="{X(1120)}" height="{F(2)}" fill="{surface}"/>
  <text x="{X(120)}" y="{Y(180)}" font-size="{F(46)}" font-weight="700" fill="{ink}">{escape(slide["title"])}</text>
  {''.join(body_svg)}
  <text x="{X(1140)}" y="{Y(672)}" font-size="{F(24)}" fill="{ink}" opacity="0.6">{slide["page"]} / {total}</text>
</svg>
'''


def find_script(name: str) -> Path | None:
    root = Path(os.environ.get("PPT_EXTENSION_ROOT", Path(__file__).resolve().parent))
    candidates = [
        root / "ppt-master" / "skills" / "ppt-master" / "scripts" / name,
        root / "skills" / "ppt-master" / "scripts" / name,
        root / "ppt-master" / name,
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def find_svg_to_pptx() -> Path | None:
    return find_script("svg_to_pptx.py")


def collect_font_sizes(project: Path) -> list[float]:
    svg_dir = project / "svg_output"
    if not svg_dir.is_dir():
        return []
    sizes: set[float] = set()
    for path in sorted(svg_dir.glob("*.svg")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for raw in re.findall(r'font-size="([0-9.]+)"', text):
            try:
                value = float(raw)
            except ValueError:
                continue
            if value > 0:
                sizes.add(round(value, 2))
    return sorted(sizes)


def restamp_native_fallbacks(project: Path) -> None:
    """内容替换后重新计算 Chart/Table 可见回退的基线哈希。"""
    script = find_script("stamp_native_fallbacks.py")
    svg_dir = project / "svg_output"
    if script is None or not svg_dir.is_dir():
        return
    log("重新计算原生对象回退基线")
    try:
        result = subprocess.run(
            [sys.executable, str(script), str(svg_dir), "--write"],
            cwd=str(script.parent),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
    except Exception as exc:  # noqa: BLE001
        log(f"原生对象基线重算异常: {exc}", "warn")
        return
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "")[-300:]
        log(f"原生对象基线重算失败: {detail}", "warn")


def run_quality_check(script: Path, project: Path) -> bool:
    log(f"运行 SVG 质量检查: {script}")
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                str(project),
                "--canonical-authoring",
                "--stage",
                "final",
                "--json",
            ],
            cwd=str(script.parent),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
    except Exception as exc:  # noqa: BLE001
        log(f"SVG 质量检查异常: {exc}", "warn")
        return False
    for line in (result.stdout or "").splitlines()[-20:]:
        log(line)
    if result.returncode != 0:
        for line in (result.stderr or "").splitlines()[-10:]:
            log(line, "warn")
        return False
    return True


def export_with_ppt_master(
    script: Path,
    project: Path,
    output: Path,
    plan: dict,
    force: bool = False,
) -> Path | None:
    log(f"使用 ppt-master 导出: {script}{'（兼容模式）' if force else ''}")
    command = [sys.executable, str(script), str(project)]
    if force:
        command.append("--enable-dangerous-nonconforming-svg-export")
    try:
        result = subprocess.run(
            command,
            cwd=str(script.parent),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
    except Exception as exc:  # noqa: BLE001
        log(f"ppt-master 导出异常，回退 python-pptx: {exc}", "warn")
        return None
    if result.stdout:
        for line in result.stdout.splitlines()[-30:]:
            log(line)
    if result.returncode != 0:
        log(f"ppt-master 导出失败（{result.returncode}），回退 python-pptx", "warn")
        if result.stderr:
            for line in result.stderr.splitlines()[-20:]:
                log(line, "warn")
        return None
    exports = sorted((project / "exports").glob("*.pptx"), key=lambda p: p.stat().st_mtime)
    if not exports:
        log("ppt-master 未产出 pptx，回退 python-pptx", "warn")
        return None
    target = output / exports[-1].name
    target.write_bytes(exports[-1].read_bytes())
    return target


def attach_native_charts(
    pptx_path: Path,
    plan: dict,
    palette: list[str] | None = None,
) -> bool:
    """在模板导出结果中，把 NATIVE_CHART_Pxx 占位替换为原生图表。"""
    try:
        from pptx import Presentation  # type: ignore
        from pptx.chart.data import CategoryChartData  # type: ignore
        from pptx.enum.chart import XL_CHART_TYPE  # type: ignore
    except Exception:  # noqa: BLE001
        return False
    chart_types = {
        "column": getattr(XL_CHART_TYPE, "COLUMN_CLUSTERED"),
        "bar": getattr(XL_CHART_TYPE, "BAR_CLUSTERED"),
        "line": getattr(XL_CHART_TYPE, "LINE_MARKERS"),
        "area": getattr(XL_CHART_TYPE, "AREA"),
        "pie": getattr(XL_CHART_TYPE, "PIE"),
        "donut": getattr(XL_CHART_TYPE, "DOUGHNUT"),
        "doughnut": getattr(XL_CHART_TYPE, "DOUGHNUT"),
        "radar": getattr(
            XL_CHART_TYPE, "RADAR", getattr(XL_CHART_TYPE, "LINE_MARKERS")
        ),
    }
    colors = [color for color in (palette or []) if re.match(r"^#[0-9A-Fa-f]{6}$", color)]
    colors = colors or ["#0071BC", "#FFC000", "#C1232D", "#0B4F8A"]
    try:
        prs = Presentation(str(pptx_path))
    except Exception as exc:  # noqa: BLE001
        log(f"打开导出结果失败: {exc}", "warn")
        return False
    slides = list(prs.slides)
    attached = 0
    for index, slide_spec in enumerate(plan["slides"]):
        chart = normalize_chart(slide_spec.get("chart"))
        if not chart or index >= len(slides):
            continue
        page_no = int(slide_spec.get("page") or index + 1)
        name = f"NATIVE_CHART_P{page_no:02d}"
        page = slides[index]
        target = next((shape for shape in page.shapes if shape.name == name), None)
        if target is None:
            log(f"P{page_no:02d} 未找到图表占位，保留矢量图表", "warn")
            continue
        left, top, width, height = (
            target.left,
            target.top,
            target.width,
            target.height,
        )
        target._element.getparent().remove(target._element)
        data = CategoryChartData()
        data.categories = chart["categories"]
        chart_kind = str(chart.get("type") or "column").lower()
        kind = chart_types.get(chart_kind, getattr(XL_CHART_TYPE, "COLUMN_CLUSTERED"))
        series = (
            chart["series"][:1]
            if kind in (
                getattr(XL_CHART_TYPE, "PIE"),
                getattr(XL_CHART_TYPE, "DOUGHNUT"),
            )
            else chart["series"][:4]
        )
        for item in series:
            data.add_series(item["name"], item["values"])
        frame = page.shapes.add_chart(kind, left, top, width, height, data)
        apply_native_chart_style(frame.chart, kind, colors)
        attached += 1
        log(f"P{page_no:02d} 已叠加原生图表：{chart_kind} / {len(series)} 系列")
    if attached == 0:
        return False
    prs.save(str(pptx_path))
    return True


def export_with_native_overlay(
    script: Path | None,
    project: Path,
    output: Path,
    plan: dict,
    palette: list[str] | None = None,
) -> Path | None:
    """用模板版式导出 pptx，再把原生图表叠加到图表槽位。"""
    if script is None:
        return None
    native_dir = project / "svg_native"
    native_pages = sorted(native_dir.glob("*.svg")) if native_dir.is_dir() else []
    if not native_pages:
        log("缺少 svg_native，回退独立配色页导出", "warn")
        return None
    svg_dir = project / "svg_output"
    backups: dict[str, bytes] = {}
    for page in svg_dir.glob("*.svg"):
        backups[page.name] = page.read_bytes()
    try:
        for page in native_pages:
            (svg_dir / page.name).write_bytes(page.read_bytes())
        # 原生占位页没有矢量图表，质量门禁可能不通过；与主流程一致，
        # 未通过时使用兼容模式导出，优先保住模板版式。
        quality_ok = True
        checker = find_script("svg_quality_checker.py")
        if checker is not None:
            quality_ok = run_quality_check(checker, project)
        if not quality_ok:
            log("原生图表占位页未通过质量门禁，使用兼容模式导出", "warn")
        artifact = export_with_ppt_master(
            script, project, output, plan, force=not quality_ok
        )
        if artifact is None:
            log("模板导出失败，回退独立配色页", "warn")
            return None
        if not attach_native_charts(artifact, plan, palette):
            log("原生图表叠加失败，回退独立配色页", "warn")
            return None
        return artifact
    finally:
        for name, data in backups.items():
            (svg_dir / name).write_bytes(data)


def spec_palette(project: Path) -> list[str]:
    """从 spec_lock.md 提取模板主色，供原生图表使用。"""
    path = project / "spec_lock.md"
    try:
        text = read_text(path, 200_000)
    except Exception:  # noqa: BLE001
        return []
    seen: list[str] = []
    for match in re.finditer(r"#([0-9A-Fa-f]{6})", text):
        color = "#" + match.group(1).upper()
        if color in {"#FFFFFF", "#000000"} or color in seen:
            continue
        seen.append(color)
        if len(seen) >= 6:
            break
    return seen


def apply_native_chart_style(chart_object, kind, colors: list[str]) -> None:
    """统一原生图表的图例、配色、数据标签与网格线。"""
    from pptx.dml.color import RGBColor  # type: ignore
    from pptx.util import Pt  # type: ignore
    from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION  # type: ignore

    def rgb(hex_color: str):
        value = hex_color.lstrip("#")
        return RGBColor(
            int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
        )

    chart_object.has_legend = True
    chart_object.legend.position = XL_LEGEND_POSITION.BOTTOM
    chart_object.legend.include_in_layout = False
    chart_object.legend.font.size = Pt(11)
    chart_object.legend.font.name = "Microsoft YaHei"
    chart_object.has_title = False
    chart_object.font.size = Pt(11)
    chart_object.font.name = "Microsoft YaHei"
    plot = chart_object.plots[0]
    if kind in (
        getattr(XL_CHART_TYPE, "COLUMN_CLUSTERED"),
        getattr(XL_CHART_TYPE, "BAR_CLUSTERED"),
    ):
        plot.gap_width = 60
    # 系列配色沿用模板调色板。
    for index, series_obj in enumerate(plot.series):
        series_obj.format.fill.solid()
        series_obj.format.fill.fore_color.rgb = rgb(colors[index % len(colors)])
        if kind in (
            getattr(XL_CHART_TYPE, "LINE_MARKERS"),
            getattr(XL_CHART_TYPE, "AREA"),
        ):
            series_obj.format.line.color.rgb = rgb(colors[index % len(colors)])
    # 数据标签与网格线，提升原生图表的可读性。
    if kind not in (
        getattr(XL_CHART_TYPE, "PIE"),
        getattr(XL_CHART_TYPE, "DOUGHNUT"),
    ):
        plot.has_data_labels = True
        plot.data_labels.font.size = Pt(10)
        plot.data_labels.number_format = "0.##"
        value_axis = chart_object.value_axis
        value_axis.has_major_gridlines = True
        value_axis.major_gridlines.format.line.color.rgb = rgb("#D9E2EC")
        value_axis.tick_labels.font.size = Pt(10)
        category_axis = chart_object.category_axis
        category_axis.tick_labels.font.size = Pt(10)
    if kind == getattr(XL_CHART_TYPE, "DOUGHNUT"):
        try:
            chart_object.plots[0].doughnut_hole_size = 55
        except Exception:  # noqa: BLE001
            pass


def export_with_python_pptx(
    plan: dict,
    output: Path,
    native_charts: bool = False,
    palette: list[str] | None = None,
) -> Path:
    try:
        from pptx import Presentation  # type: ignore
        from pptx.dml.color import RGBColor  # type: ignore
        from pptx.util import Inches, Pt  # type: ignore
        from pptx.chart.data import CategoryChartData  # type: ignore
        from pptx.enum.chart import (  # type: ignore
            XL_CHART_TYPE,
            XL_LEGEND_POSITION,
        )
        from pptx.enum.shapes import MSO_SHAPE  # type: ignore
    except Exception:  # noqa: BLE001
        fail(
            "MISSING_DEPENDENCY",
            "未找到 ppt-master 的 svg_to_pptx.py，且内嵌 Python 未安装 python-pptx。"
            "请使用 build-ppt-extension.mjs 构建完整扩展包，或安装 python-pptx。",
        )

    chart_types = {
        "column": getattr(XL_CHART_TYPE, "COLUMN_CLUSTERED"),
        "bar": getattr(XL_CHART_TYPE, "BAR_CLUSTERED"),
        "line": getattr(XL_CHART_TYPE, "LINE_MARKERS"),
        "area": getattr(XL_CHART_TYPE, "AREA"),
        "pie": getattr(XL_CHART_TYPE, "PIE"),
        "donut": getattr(XL_CHART_TYPE, "DOUGHNUT"),
        "doughnut": getattr(XL_CHART_TYPE, "DOUGHNUT"),
        "radar": getattr(XL_CHART_TYPE, "RADAR", getattr(XL_CHART_TYPE, "LINE_MARKERS")),
    }
    colors = [color for color in (palette or []) if re.match(r"^#[0-9A-Fa-f]{6}$", color)]
    colors = colors or ["#0071BC", "#FFC000", "#C1232D", "#0B4F8A"]

    def rgb(hex_color: str):
        value = hex_color.lstrip("#")
        return RGBColor(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))

    def add_bullets(page, slide, top, height, size=18):
        body = page.shapes.add_textbox(
            Inches(0.9), Inches(top), Inches(11.5), Inches(height)
        )
        frame = body.text_frame
        frame.word_wrap = True
        bullets = slide.get("bullets") or (
            [slide["coreMessage"]] if slide.get("coreMessage") else []
        )
        if not bullets:
            bullets = ["（本页由文档大纲生成，可在工程目录中补充内容）"]
        for index, bullet in enumerate(bullets[:5]):
            paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
            paragraph.text = f"• {bullet}"
            paragraph.font.size = Pt(size)
            paragraph.font.name = "Microsoft YaHei"
            paragraph.font.color.rgb = rgb("#1F2937")

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    for slide in plan["slides"]:
        page = prs.slides.add_slide(blank)
        # 顶部色带 + 标题，保持与模板页相近的视觉起点。
        band = page.shapes.add_shape(
            MSO_SHAPE.RECTANGLE,
            Inches(0),
            Inches(0),
            prs.slide_width,
            Inches(0.12),
        )
        band.fill.solid()
        band.fill.fore_color.rgb = rgb(colors[0])
        band.line.fill.background()
        title_box = page.shapes.add_textbox(
            Inches(0.8), Inches(0.5), Inches(11.7), Inches(0.9)
        )
        title_frame = title_box.text_frame
        title_frame.text = slide["title"]
        title_frame.paragraphs[0].font.size = Pt(30)
        title_frame.paragraphs[0].font.bold = True
        title_frame.paragraphs[0].font.name = "Microsoft YaHei"
        title_frame.paragraphs[0].font.color.rgb = rgb(colors[0])

        chart = normalize_chart(slide.get("chart")) if native_charts else None
        if chart:
            add_bullets(page, slide, 1.5, 1.1, size=15)
            try:
                data = CategoryChartData()
                data.categories = chart["categories"]
                chart_kind = str(chart.get("type") or "column").lower()
                kind = chart_types.get(
                    chart_kind,
                    getattr(XL_CHART_TYPE, "COLUMN_CLUSTERED"),
                )
                series = chart["series"][:1] if kind in (
                    getattr(XL_CHART_TYPE, "PIE"),
                    getattr(XL_CHART_TYPE, "DOUGHNUT"),
                ) else chart["series"][:4]
                for item in series:
                    data.add_series(item["name"], item["values"])
                frame = page.shapes.add_chart(
                    kind,
                    Inches(0.8),
                    Inches(2.8),
                    Inches(11.7),
                    Inches(4.2),
                    data,
                )
                apply_native_chart_style(frame.chart, kind, colors)
                log(
                    f"P{slide.get('page', '?')} 原生图表：{chart_kind} / "
                    f"{len(series)} 系列",
                )
            except Exception as exc:  # noqa: BLE001
                log(
                    f"P{slide.get('page', '?')} 原生图表创建失败，回退纯文本: {exc}",
                    "warn",
                )
                add_bullets(page, slide, 1.8, 5.0)
        else:
            add_bullets(page, slide, 1.8, 5.0)

    target = output / f"{safe_name(plan['title'])}_{time.strftime('%Y%m%d_%H%M%S')}.pptx"
    prs.save(str(target))
    return target


def resolve_stage(job: dict) -> str:
    """读取并校验 options.stage；未知值按 full 处理以兼容旧作业。"""
    options = job.get("options") or {}
    stage = str(options.get("stage") or "full").lower()
    return stage if stage in ("render", "export", "full") else "full"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    args = parser.parse_args()

    job_path = Path(args.job)
    if not job_path.is_file():
        fail("JOB_NOT_FOUND", f"job.json 不存在: {job_path}")
    job = json.loads(read_text(job_path, 1_000_000))
    job_id = job.get("jobId", "unknown")
    log(f"PPT 扩展启动 job={job_id}")

    project = JOB_DIR / job.get("projectDir", "project")
    output = JOB_DIR / job.get("outputDir", "output")
    (project / "svg_output").mkdir(parents=True, exist_ok=True)
    (project / "templates").mkdir(parents=True, exist_ok=True)
    (project / "notes").mkdir(parents=True, exist_ok=True)
    (project / "exports").mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)

    source_path = JOB_DIR / job.get("source", {}).get("markdownPath", "input/source.md")
    source = read_text(source_path) if source_path.is_file() else ""
    plan = normalize_plan(job.get("plan") or {}, source, job)

    progress("plan", 20, "整理页面计划")
    (project / "slide_plan.json").write_text(
        json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (project / "design_spec.md").write_text(build_design_spec(plan, job), encoding="utf-8")
    (project / "spec_lock.md").write_text(build_spec_lock(plan, job), encoding="utf-8")
    (project / "notes" / "total.md").write_text(build_notes(plan), encoding="utf-8")
    log("design_spec.md / spec_lock.md / slide_plan.json 已生成")

    options = job.get("options") or {}
    stage = resolve_stage(job)
    log(f"执行阶段: {stage}")

    if stage == "export":
        draft_pages = sorted((project / "svg_output").glob("*.svg"))
        if not draft_pages:
            fail("NO_DRAFT", "草稿目录为空，请先生成草稿")
        log(f"导出阶段：复用现有草稿 {len(draft_pages)} 页")
        progress("export", 70, "读取已确认草稿")
        # AI 页面是整页绝对坐标，不能携带模板 master/layout/bounds 元数据；
        # 否则 flat 导出会因结构校验失败回退纯文本（图表/表格丢失）。
        selection_path = project / "page_selection.json"
        ai_pages: set[int] = set()
        if selection_path.is_file():
            try:
                selection = json.loads(selection_path.read_text(encoding="utf-8"))
                ai_pages = {
                    int(item["page"])
                    for item in selection.get("pages", [])
                    if isinstance(item, dict) and "page" in item
                }
            except Exception:
                ai_pages = set()
        for page in draft_pages:
            match = re.match(r"P(\d+)\.svg$", page.name, re.I)
            if not match or int(match.group(1)) not in ai_pages:
                continue
            text = page.read_text(encoding="utf-8")
            cleaned = re.sub(r'\s+data-pptx-[A-Za-z0-9_-]+="[^"]*"', "", text)
            for pattern in (
                r'\s+dominant-baseline="[^"]*"',
                r'\s+alignment-baseline="[^"]*"',
                r'\s+paint-order="[^"]*"',
                r'\s+vector-effect="[^"]*"',
                r'\s+mix-blend-mode="[^"]*"',
                r'\s+isolation="[^"]*"',
            ):
                cleaned = re.sub(pattern, "", cleaned)
            if cleaned != text:
                page.write_text(cleaned, encoding="utf-8")
                log(f"已清理 {page.name} 的不兼容 SVG 属性")
        # 复用已有 SVG 时仍补齐模板图片等资源，避免 svg_to_pptx 因缺图回退。
        layout = (job.get("templates") or {}).get("layoutId") or "default"
        pages = layout_pages(layout)
        if pages:
            copy_layout_assets(pages, project, layout)
        # 复用已有 SVG 时仍需把实际字号补进 spec_lock，避免质量门禁误判。
        (project / "spec_lock.md").write_text(
            build_spec_lock(plan, job, collect_font_sizes(project)),
            encoding="utf-8",
        )
        restamp_native_fallbacks(project)
        return export_pptx(plan, project, output, options)

    progress("render", 40, "生成 SVG 页面")
    native_charts = bool(options.get("nativeCharts"))
    native_dir = project / "svg_native"
    native_dir.mkdir(parents=True, exist_ok=True)
    # AI 页级生成失败时只渲染 fallbackPages，保留已生成的 AI 页面。
    fallback_pages: set[int] = set()
    raw_fallback = options.get("fallbackPages")
    if isinstance(raw_fallback, list):
        for item in raw_fallback:
            try:
                fallback_pages.add(int(item))
            except (TypeError, ValueError):
                continue
    if fallback_pages:
        log(f"仅渲染模板兜底页: {sorted(fallback_pages)}")
        for stale in (project / "svg_output").glob("*.svg"):
            match = re.match(r"^P(\d+)\.svg$", stale.name, re.I)
            if not match or int(match.group(1)) not in fallback_pages:
                continue
            try:
                stale.unlink()
            except OSError:
                pass
        for stale in native_dir.glob("*.svg"):
            match = re.match(r"^P(\d+)\.svg$", stale.name, re.I)
            if not match or int(match.group(1)) not in fallback_pages:
                continue
            try:
                stale.unlink()
            except OSError:
                pass
    else:
        # 完整渲染时清理旧页，避免删减页数后残留过期 SVG。
        for stale in (project / "svg_output").glob("*.svg"):
            try:
                stale.unlink()
            except OSError:
                pass
        for stale in native_dir.glob("*.svg"):
            try:
                stale.unlink()
            except OSError:
                pass
    layout = (job.get("templates") or {}).get("layoutId") or "default"
    pages = layout_pages(layout)
    if pages:
        copy_layout_assets(pages, project, layout)
        log(f"已复制版式资源: {layout}（{len(pages)} 页）")
    preferred_chart_ids = (job.get("templates") or {}).get("chartIds") or []
    preferred_chart = preferred_chart_ids[0] if preferred_chart_ids else None
    section_name = plan["title"]
    previous_type = None

    for index, slide in enumerate(plan["slides"]):
        filename = f"P{slide['page']:02d}.svg"
        if fallback_pages and int(slide.get("page") or 0) not in fallback_pages:
            log(f"P{slide.get('page', 0):02d} 保留 AI 草稿，跳过模板渲染")
            if native_charts:
                existing = project / "svg_output" / filename
                if existing.is_file():
                    (native_dir / filename).write_bytes(existing.read_bytes())
            continue
        svg: str | None = None
        svg_native: str | None = None
        chart = chart_data_for_slide(slide, preferred_chart)
        chart_path = chart_template_path(chart, preferred_chart) if chart else None
        colors = chart_colors(chart_path) if chart else None

        if chart and pages:
            content_type = "content" if "content" in pages else next(
                (page for page in pages if "content" in page), None
            )
            if content_type:
                base = pages[content_type].read_text(encoding="utf-8")
                if "data-pptx-placeholder" in base:
                    svg = fill_structured_layout(
                        base,
                        slide,
                        index,
                        plan,
                        job,
                        section_name,
                        chart=chart,
                        colors=colors,
                    )
                    if native_charts:
                        svg_native = fill_structured_layout(
                            base,
                            slide,
                            index,
                            plan,
                            job,
                            section_name,
                            chart=chart,
                            colors=colors,
                            native_placeholder=True,
                        )
                    previous_type = content_type
                    log(
                        f"P{slide['page']:02d} 使用结构化版式+图表: "
                        f"{layout}/{content_type}"
                    )
                elif "{{" in base:
                    svg = fill_layout_svg(
                        base,
                        slide,
                        index,
                        plan,
                        job,
                        section_name,
                        chart=chart,
                        chart_colors=colors,
                    )
                    log(
                        f"P{slide['page']:02d} 使用版式+图表片段: "
                        f"{layout}/{content_type}"
                    )

        if svg is None:
            page_type = choose_page_type(slide, index, len(plan["slides"]), pages)
            page_type = alternate_page_type(
                page_type, previous_type, pages, slide.get("bullets") or []
            )
            previous_type = page_type
            if page_type and pages.get(page_type):
                base = pages[page_type].read_text(encoding="utf-8")
                if "data-pptx-placeholder" in base:
                    svg = fill_structured_layout(
                        base, slide, index, plan, job, section_name
                    )
                    log(
                        f"P{slide['page']:02d} 使用结构化版式: "
                        f"{layout}/{page_type}"
                    )
                elif "{{" in base:
                    svg = fill_layout_svg(base, slide, index, plan, job, section_name)
                    log(f"P{slide['page']:02d} 使用版式: {layout}/{page_type}")
                if svg is not None and page_type == "chapter":
                    section_name = slide["title"]
        if svg is None:
            svg = render_svg(slide, len(plan["slides"]), layout)
            log(f"P{slide['page']:02d} 使用内置渲染器")
        (project / "svg_output" / filename).write_text(
            strip_pptx_structure_attrs(svg), encoding="utf-8"
        )
        if native_charts:
            native_svg = svg_native if svg_native is not None else svg
            (native_dir / filename).write_text(
                strip_pptx_structure_attrs(native_svg), encoding="utf-8"
            )
    log(f"已生成 {len(plan['slides'])} 页 SVG")
    # 模板实际字号可能超出预置角色；把实际使用到的字号补进 spec_lock，
    # 避免质量检查把模板固有字号判为未声明的重复字号。
    (project / "spec_lock.md").write_text(
        build_spec_lock(plan, job, collect_font_sizes(project)),
        encoding="utf-8",
    )
    restamp_native_fallbacks(project)

    if stage == "render":
        progress("draft_ready", 100, "草稿已生成")
        log("草稿生成完成，等待确认后导出")
        emit({"type": "done", "stage": "draft_ready"})
        return 0

    return export_pptx(plan, project, output, options)


def speaker_note_of(slide: dict) -> str:
    return str(slide.get("speakerNote") or slide.get("speaker_note") or "").strip()


def attach_speaker_notes(pptx_path: Path, plan: dict) -> bool:
    """把每页 speakerNote 写入 PPTX 备注页；无备注时不做任何改动。"""
    notes = [speaker_note_of(slide) for slide in plan.get("slides") or []]
    if not any(notes):
        return False
    try:
        from pptx import Presentation  # type: ignore
    except Exception as exc:  # noqa: BLE001
        log(f"python-pptx 不可用，跳过演讲备注: {exc}", "warn")
        return False
    try:
        prs = Presentation(str(pptx_path))
        for slide, note in zip(prs.slides, notes):
            if not note:
                continue
            slide.notes_slide.notes_text_frame.text = note
        prs.save(str(pptx_path))
        log(f"已写入 {sum(1 for note in notes if note)} 页演讲备注")
        return True
    except Exception as exc:  # noqa: BLE001
        log(f"写入演讲备注失败: {exc}", "warn")
        return False


def export_pptx(plan: dict, project: Path, output: Path, options: dict) -> int:
    progress("export", 75, "导出 PPTX")
    artifact: Path | None = None
    native_charts = bool(options.get("nativeCharts"))
    has_chart = any(
        normalize_chart(slide.get("chart")) for slide in plan["slides"]
    )
    script = find_svg_to_pptx()
    if native_charts and has_chart:
        # 优先保留模板版式：先把图表槽位换成占位形状，导出后再叠加原生图表。
        artifact = export_with_native_overlay(
            script,
            project,
            output,
            plan,
            spec_palette(project),
        )
        if artifact is not None:
            log("使用模板版式 + 原生图表导出")
        else:
            try:
                artifact = export_with_python_pptx(
                    plan,
                    output,
                    native_charts=True,
                    palette=spec_palette(project),
                )
                log("使用独立配色页导出原生图表")
            except Exception as exc:  # noqa: BLE001
                log(f"原生图表导出失败，回退标准导出: {exc}", "warn")
                artifact = None

    quality_ok = True
    if artifact is None and script is not None:
        checker = find_script("svg_quality_checker.py")
        if checker is not None:
            quality_ok = run_quality_check(checker, project)
            if not quality_ok:
                log(
                    "SVG 质量检查未通过，尝试兼容模式导出以保留模板样式",
                    "warn",
                )
    if artifact is None and script is not None:
        artifact = export_with_ppt_master(
            script, project, output, plan, force=not quality_ok
        )
    if artifact is None:
        artifact = export_with_python_pptx(plan, output)

    # 无论走 SVG 还是原生图表导出，都补齐演讲备注。
    attach_speaker_notes(artifact, plan)

    size = artifact.stat().st_size
    emit(
        {
            "type": "artifact",
            "path": str(artifact.relative_to(JOB_DIR)).replace("\\", "/"),
            "size": size,
        }
    )
    progress("done", 100, "生成完成")
    emit({"type": "done", "stage": "done"})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        emit({"type": "error", "code": "UNEXPECTED", "message": str(exc)})
        raise SystemExit(1)
