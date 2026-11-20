/**
 * 从 RenderNode 提取属性面板需要的当前样式。
 * 纯函数：只读渲染树，不触碰文档模型。
 */
import type { RenderNode } from "@genoffice/pptx-render";

export interface EditorTextStyle {
  fontFamily?: string;
  /** pt */
  fontSizePt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right" | "justify";
}

export interface EditorNodeStyle {
  fillKind: "solid" | "none" | "gradient" | "image" | "pattern" | "unknown";
  fillColor?: string;
  strokeColor?: string;
  strokeWidthPt?: number;
  text?: EditorTextStyle;
  canFill: boolean;
  canStroke: boolean;
}

type AnyNode = RenderNode & {
  fill?: { kind: string; color?: string };
  stroke?: { color: string; widthPt: number };
  text?: {
    lines?: Array<{
      align?: EditorTextStyle["align"];
      runs?: Array<{
        fontFamily?: string;
        srcFontFamily?: string;
        fontSizePx?: number;
        color?: string;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
      }>;
    }>;
  };
};

/** 渲染 px → pt（渲染树坐标已乘以 viewport scale）。 */
export function pxToPt(px: number, scale: number): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 0.75;
  return Math.round(((px / safeScale) * 0.75 + Number.EPSILON) * 10) / 10;
}

export function styleOfNode(node: RenderNode, scale: number): EditorNodeStyle {
  const n = node as AnyNode;
  const canFill = n.type === "shape" || n.type === "text";
  const canStroke = canFill || n.type === "picture";

  const fillKind = (n.fill?.kind ?? "none") as EditorNodeStyle["fillKind"];
  const style: EditorNodeStyle = {
    fillKind,
    fillColor: fillKind === "solid" ? n.fill?.color : undefined,
    strokeColor: n.stroke?.color,
    strokeWidthPt: n.stroke?.widthPt,
    canFill,
    canStroke,
  };

  if (n.type === "shape" || n.type === "text") {
    const text = n.text;
    const line = text?.lines?.[0];
    const run = line?.runs?.[0];
    if (run) {
      style.text = {
        // fontFamily 可能是缺失字体替换结果，优先用模型原始字体名
        fontFamily: run.srcFontFamily ?? run.fontFamily,
        fontSizePt: run.fontSizePx != null ? pxToPt(run.fontSizePx, scale) : undefined,
        color: run.color,
        bold: run.bold,
        italic: run.italic,
        underline: run.underline,
        align: line?.align ?? "left",
      };
    }
  }

  return style;
}
