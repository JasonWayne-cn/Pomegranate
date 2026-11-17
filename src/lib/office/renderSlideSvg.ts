/**
 * RenderTree → SVG 的极简渲染器（P0 Spike）。
 *
 * 目标是把 GenOffice 的 RenderSlide 变成可在 React 里直接
 * `dangerouslySetInnerHTML` 的 SVG，用来验证"解析 + 布局 + 预览"链路。
 * 它不追求像素级保真：图表/表格/复杂效果先用占位，后续再按需扩展。
 */
import type {
  ChartRenderNode,
  GroupRenderNode,
  PictureRenderNode,
  RenderFill,
  RenderNode,
  RenderSlide,
  RenderStroke,
  RenderTextLayout,
  ShapeRenderNode,
  TableRenderNode,
} from "@genoffice/pptx-render";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function num(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "0";
}

interface ResolvedFill {
  attr: string;
  defs: string;
  /** 图片填充时用于在形状上方叠一张图（近似） */
  image?: { href: string; opacity?: number };
}

let gradientSeq = 0;

function resolveFill(fill: RenderFill | undefined): ResolvedFill {
  if (!fill || fill.kind === "none") return { attr: 'fill="none"', defs: "" };
  if (fill.kind === "solid") return { attr: `fill="${escapeXml(fill.color)}"`, defs: "" };
  if (fill.kind === "gradient") {
    const id = `g${++gradientSeq}`;
    const rad = (fill.angleDeg * Math.PI) / 180;
    const x1 = 50 - Math.cos(rad) * 50;
    const y1 = 50 - Math.sin(rad) * 50;
    const x2 = 50 + Math.cos(rad) * 50;
    const y2 = 50 + Math.sin(rad) * 50;
    const stops = fill.stops
      .map(
        (stop) =>
          `<stop offset="${num(Math.max(0, Math.min(1, stop.pos)) * 100)}%" stop-color="${escapeXml(stop.color)}"/>`,
      )
      .join("");
    return {
      attr: `fill="url(#${id})"`,
      defs: `<linearGradient id="${id}" x1="${num(x1)}%" y1="${num(y1)}%" x2="${num(x2)}%" y2="${num(y2)}%">${stops}</linearGradient>`,
    };
  }
  if (fill.kind === "image" && fill.dataUrl) {
    return {
      attr: 'fill="none"',
      defs: "",
      image: { href: fill.dataUrl, opacity: fill.alpha },
    };
  }
  // 图案填充等：Spike 阶段退化为浅灰，避免整块消失。
  return { attr: 'fill="#e5e7eb"', defs: "" };
}

function strokeAttr(stroke: RenderStroke | undefined): string {
  if (!stroke) return "";
  const dash = stroke.dash?.length ? ` stroke-dasharray="${stroke.dash.map(num).join(" ")}"` : "";
  return ` stroke="${escapeXml(stroke.color)}" stroke-width="${num(stroke.widthPx)}"${dash}`;
}

function renderTextLayout(text: RenderTextLayout | undefined, boxX: number, boxY: number): string {
  if (!text) return "";
  const baseX = boxX + text.insets.l;
  const baseY = boxY + text.insets.t;
  const parts: string[] = [];
  for (const line of text.lines) {
    for (const run of line.runs) {
      if (!run.text) continue;
      const weight = run.bold ? "bold" : "normal";
      const style = run.italic ? "italic" : "normal";
      const decoration =
        run.underline && run.strike
          ? "underline line-through"
          : run.underline
            ? "underline"
            : run.strike
              ? "line-through"
              : "none";
      if (run.highlight) {
        parts.push(
          `<rect x="${num(baseX + run.x)}" y="${num(baseY + run.baselineY - run.fontSizePx * 0.9)}" width="${num(run.widthPx)}" height="${num(run.fontSizePx * 1.2)}" fill="${escapeXml(run.highlight)}"/>`,
        );
      }
      parts.push(
        `<text x="${num(baseX + run.x)}" y="${num(baseY + run.baselineY)}" font-family="${escapeXml(run.fontFamily || "sans-serif")}" font-size="${num(run.fontSizePx)}" font-weight="${weight}" font-style="${style}" text-decoration="${decoration}" fill="${escapeXml(run.color)}">${escapeXml(run.text)}</text>`,
      );
    }
  }
  return parts.join("");
}

function renderText(node: ShapeRenderNode): string {
  return renderTextLayout(node.text, node.box.x, node.box.y);
}

function renderImageFill(
  image: { href: string; opacity?: number },
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const opacity = image.opacity != null ? ` opacity="${num(image.opacity)}"` : "";
  return `<image href="${escapeXml(image.href)}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="xMidYMid slice"${opacity}/>`;
}

function renderShape(node: ShapeRenderNode, defs: string[]): string {
  const fill = resolveFill(node.fill);
  if (fill.defs) defs.push(fill.defs);
  const stroke = strokeAttr(node.stroke);
  const transform =
    node.box.rotationDeg && node.box.rotationDeg !== 0
      ? ` transform="rotate(${num(node.box.rotationDeg)} ${num(node.box.centerX)} ${num(node.box.centerY)})"`
      : "";
  const { x, y, w, h } = node.box;
  let geometry: string;
  if (node.line) {
    const pts = node.line.points;
    if (node.line.bezier?.length) {
      const d = [`M ${num(x + pts[0]!)} ${num(y + pts[1]!)}`];
      for (let i = 0; i + 5 < node.line.bezier.length; i += 6) {
        const b = node.line.bezier;
        d.push(
          `C ${num(x + b[i]!)} ${num(y + b[i + 1]!)} ${num(x + b[i + 2]!)} ${num(y + b[i + 3]!)} ${num(x + b[i + 4]!)} ${num(y + b[i + 5]!)}`,
        );
      }
      geometry = `<path d="${d.join(" ")}" fill="none"${stroke}/>`;
    } else {
      const points = [];
      for (let i = 0; i + 1 < pts.length; i += 2) {
        points.push(`${num(x + pts[i]!)},${num(y + pts[i + 1]!)}`);
      }
      geometry = `<polyline points="${points.join(" ")}" fill="none"${stroke}/>`;
    }
  } else if (node.pathData) {
    geometry = `<g transform="translate(${num(x)} ${num(y)})"><path d="${escapeXml(node.pathData)}" ${fill.attr}${stroke}/></g>`;
  } else if (node.polygonPoints?.length) {
    const points = [];
    for (let i = 0; i + 1 < node.polygonPoints.length; i += 2) {
      points.push(`${num(node.polygonPoints[i]!)},${num(node.polygonPoints[i + 1]!)}`);
    }
    geometry = `<g transform="translate(${num(x)} ${num(y)})"><polygon points="${points.join(" ")}" ${fill.attr}${stroke}/></g>`;
  } else if (node.presetGeometry === "ellipse" || node.presetGeometry === "oval") {
    geometry = `<ellipse cx="${num(x + w / 2)}" cy="${num(y + h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}" ${fill.attr}${stroke}/>`;
  } else {
    const rx = node.cornerRadiusPx ? ` rx="${num(node.cornerRadiusPx)}"` : "";
    geometry = `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${rx} ${fill.attr}${stroke}/>`;
  }
  const imageFill = fill.image ? renderImageFill(fill.image, x, y, w, h) : "";
  return `<g${transform}>${geometry}${imageFill}${renderText(node)}</g>`;
}

function renderPicture(node: PictureRenderNode): string {
  if (!node.dataUrl) {
    return `<rect x="${num(node.box.x)}" y="${num(node.box.y)}" width="${num(node.box.w)}" height="${num(node.box.h)}" fill="#e5e7eb"/>`;
  }
  return renderImageFill({ href: node.dataUrl, opacity: node.opacity }, node.box.x, node.box.y, node.box.w, node.box.h);
}

function renderTable(node: TableRenderNode, defs: string[]): string {
  const parts: string[] = [`<g transform="translate(${num(node.box.x)} ${num(node.box.y)})">`];
  if (node.bgFill) {
    const bg = resolveFill(node.bgFill);
    if (bg.defs) defs.push(bg.defs);
    if (bg.attr !== 'fill="none"') {
      parts.push(
        `<rect x="0" y="0" width="${num(node.box.w)}" height="${num(node.box.h)}" ${bg.attr}/>`,
      );
    }
  }
  for (const cell of node.cells) {
    const fill = resolveFill(cell.fill);
    if (fill.defs) defs.push(fill.defs);
    parts.push(
      `<rect x="${num(cell.x)}" y="${num(cell.y)}" width="${num(cell.w)}" height="${num(cell.h)}" ${fill.attr}/>`,
    );
    if (cell.borders) {
      const b = cell.borders;
      const edges: Array<[number, number, number, number, RenderStroke | undefined]> = [
        [cell.x, cell.y, cell.x + cell.w, cell.y, b.t],
        [cell.x, cell.y + cell.h, cell.x + cell.w, cell.y + cell.h, b.b],
        [cell.x, cell.y, cell.x, cell.y + cell.h, b.l],
        [cell.x + cell.w, cell.y, cell.x + cell.w, cell.y + cell.h, b.r],
      ];
      for (const [x1, y1, x2, y2, stroke] of edges) {
        if (!stroke) continue;
        parts.push(
          `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${escapeXml(stroke.color)}" stroke-width="${num(stroke.widthPx)}"/>`,
        );
      }
    }
    if (cell.text) parts.push(renderTextLayout(cell.text, cell.x, cell.y));
  }
  parts.push("</g>");
  return parts.join("");
}

function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + Math.cos(rad) * r, y: cy + Math.sin(rad) * r };
}

function wedgePath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startDeg: number,
  sweepDeg: number,
): string {
  const endDeg = startDeg + sweepDeg;
  const outerStart = polar(cx, cy, outerR, startDeg);
  const outerEnd = polar(cx, cy, outerR, endDeg);
  const largeArc = Math.abs(sweepDeg) > 180 ? 1 : 0;
  if (innerR <= 0) {
    return `M ${num(cx)} ${num(cy)} L ${num(outerStart.x)} ${num(outerStart.y)} A ${num(outerR)} ${num(outerR)} 0 ${largeArc} 1 ${num(outerEnd.x)} ${num(outerEnd.y)} Z`;
  }
  const innerStart = polar(cx, cy, innerR, startDeg);
  const innerEnd = polar(cx, cy, innerR, endDeg);
  return `M ${num(outerStart.x)} ${num(outerStart.y)} A ${num(outerR)} ${num(outerR)} 0 ${largeArc} 1 ${num(outerEnd.x)} ${num(outerEnd.y)} L ${num(innerEnd.x)} ${num(innerEnd.y)} A ${num(innerR)} ${num(innerR)} 0 ${largeArc} 0 ${num(innerStart.x)} ${num(innerStart.y)} Z`;
}

function renderChart(node: ChartRenderNode, defs: string[]): string {
  const parts: string[] = [`<g transform="translate(${num(node.box.x)} ${num(node.box.y)})">`];
  if (node.bgFill) {
    const bg = resolveFill(node.bgFill);
    if (bg.defs) defs.push(bg.defs);
    if (bg.attr !== 'fill="none"') {
      parts.push(
        `<rect x="0" y="0" width="${num(node.box.w)}" height="${num(node.box.h)}" ${bg.attr}/>`,
      );
    }
  }
  if (node.plotRect) {
    const p = node.plotRect;
    const fill = resolveFill(p.fill);
    if (fill.defs) defs.push(fill.defs);
    const stroke = p.borderColor
      ? ` stroke="${escapeXml(p.borderColor)}" stroke-width="${num(p.borderWidthPx ?? 1)}"`
      : "";
    parts.push(
      `<rect x="${num(p.x)}" y="${num(p.y)}" width="${num(p.w)}" height="${num(p.h)}" ${fill.attr}${stroke}/>`,
    );
  }
  for (const line of [...node.gridLines, ...node.axisLines]) {
    const dash = "dash" in line && line.dash?.length ? ` stroke-dasharray="${line.dash.map(num).join(" ")}"` : "";
    parts.push(
      `<line x1="${num(line.x1)}" y1="${num(line.y1)}" x2="${num(line.x2)}" y2="${num(line.y2)}" stroke="${escapeXml(line.color)}" stroke-width="${num(line.widthPx ?? 1)}"${dash}/>`,
    );
  }
  for (const bar of node.bars) {
    const fill = bar.fill ? resolveFill(bar.fill) : { attr: `fill="${escapeXml(bar.color)}"`, defs: "" };
    if (fill.defs) defs.push(fill.defs);
    parts.push(
      `<rect x="${num(bar.x)}" y="${num(bar.y)}" width="${num(bar.w)}" height="${num(bar.h)}" ${fill.attr}/>`,
    );
  }
  for (const wedge of node.wedges ?? []) {
    if (wedge.noFill) continue;
    const stroke = wedge.stroke
      ? ` stroke="${escapeXml(wedge.stroke)}" stroke-width="${num(wedge.strokeWidthPx ?? 1)}"`
      : ' stroke="#ffffff" stroke-width="1"';
    parts.push(
      `<path d="${wedgePath(wedge.cx, wedge.cy, wedge.outerR, wedge.innerR, wedge.startDeg, wedge.sweepDeg)}" fill="${escapeXml(wedge.color)}"${stroke}/>`,
    );
  }
  for (const path of node.paths ?? []) {
    const dy = path.dy ? ` transform="translate(0 ${num(path.dy)})"` : "";
    const stroke = path.stroke
      ? ` stroke="${escapeXml(path.stroke)}" stroke-width="${num(path.strokeWidthPx ?? 1)}"`
      : "";
    parts.push(`<path d="${escapeXml(path.d)}" fill="${escapeXml(path.fill)}"${stroke}${dy}/>`);
  }
  for (const poly of node.polylines) {
    const points = [];
    for (let i = 0; i + 1 < poly.points.length; i += 2) {
      points.push(`${num(poly.points[i]!)},${num(poly.points[i + 1]!)}`);
    }
    const fill = poly.closed && poly.fill ? escapeXml(poly.fill) : "none";
    parts.push(
      `<polyline points="${points.join(" ")}" fill="${fill}" stroke="${escapeXml(poly.color)}" stroke-width="${num(poly.widthPx)}"/>`,
    );
  }
  for (const marker of node.markers) {
    parts.push(
      `<circle cx="${num(marker.x)}" cy="${num(marker.y)}" r="${num(marker.r)}" fill="${escapeXml(marker.color)}"/>`,
    );
  }
  for (const swatch of node.swatches) {
    parts.push(
      `<rect x="${num(swatch.x)}" y="${num(swatch.y)}" width="${num(swatch.w)}" height="${num(swatch.h)}" fill="${escapeXml(swatch.color)}"/>`,
    );
  }
  for (const label of node.labels) {
    const rotate = label.rotationDeg ? ` transform="rotate(${num(label.rotationDeg)} ${num(label.x)} ${num(label.y)})"` : "";
    const weight = label.bold ? "bold" : "normal";
    const style = label.italic ? "italic" : "normal";
    parts.push(
      `<text x="${num(label.x)}" y="${num(label.y + label.fontSizePx * 0.9)}" font-family="${escapeXml(label.fontFamily || "sans-serif")}" font-size="${num(label.fontSizePx)}" font-weight="${weight}" font-style="${style}" fill="${escapeXml(label.color)}"${rotate}>${escapeXml(label.text)}</text>`,
    );
  }
  parts.push("</g>");
  return parts.join("");
}

/** 渲染单个节点（不含 defs）。顶层节点会被包一层带 `data-office-id` 的 <g>，
 *  供交互层做命中/显隐；组内子节点不参与顶层选择。 */
function renderNodeBody(node: RenderNode, defs: string[]): string {
  switch (node.type) {
    case "shape":
    case "text":
      return renderShape(node as ShapeRenderNode, defs);
    case "picture":
      return renderPicture(node as PictureRenderNode);
    case "group": {
      const group = node as GroupRenderNode;
      return `<g transform="translate(${num(group.box.x)} ${num(group.box.y)})">${group.children.map((child) => renderNode(child, defs)).join("")}</g>`;
    }
    case "table":
      return renderTable(node as TableRenderNode, defs);
    case "chart":
      return renderChart(node as ChartRenderNode, defs);
    default:
      return "";
  }
}

function renderNode(node: RenderNode, defs: string[]): string {
  const body = renderNodeBody(node, defs);
  if (!body) return "";
  const id = escapeXml(node.sourceId || node.id);
  return `<g data-office-id="${id}" data-office-type="${escapeXml(node.type)}">${body}</g>`;
}

export function renderSlideSvg(slide: RenderSlide): string {
  gradientSeq = 0;
  const defs: string[] = [];
  const background = resolveFill(slide.background);
  if (background.defs) defs.push(background.defs);
  const bg =
    background.attr === 'fill="none"'
      ? ""
      : `<rect x="0" y="0" width="${num(slide.widthPx)}" height="${num(slide.heightPx)}" ${background.attr}/>`;
  const body = slide.nodes.map((node) => renderNode(node, defs)).join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(slide.widthPx)} ${num(slide.heightPx)}" width="${num(slide.widthPx)}" height="${num(slide.heightPx)}" role="img">`,
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    bg,
    body,
    "</svg>",
  ].join("");
}
