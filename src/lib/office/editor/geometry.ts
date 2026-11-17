/**
 * 编辑器几何与命中测试（纯函数，便于单测）。
 *
 * 输入是 `pptx-render` 的 RenderSlide：节点坐标已是页面 px（fitWidth 尺度），
 * 与 SVG 的 viewBox 一致，因此交互层只需要一个线性缩放系数。
 */
import type { RenderNode, RenderSlide } from "@genoffice/pptx-render";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditorNode {
  /** 引擎 parse-time 元素 id（写回时作为 op target.el） */
  id: string;
  type: RenderNode["type"];
  box: Box;
  rotationDeg: number;
  centerX: number;
  centerY: number;
  /** 整页背景类元素：可选但不可拖动 */
  background: boolean;
  /** 可内联编辑的纯文本（多段以 \n 连接）；非文本节点为 null */
  text: string | null;
}

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const RESIZE_HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function nodeText(node: RenderNode): string | null {
  if (node.type !== "shape" && node.type !== "text") return null;
  const text = (node as { text?: { lines?: Array<{ runs?: Array<{ text?: string }> }> } }).text;
  if (!text?.lines?.length) return null;
  return text.lines
    .map((line) => (line.runs ?? []).map((run) => run.text ?? "").join(""))
    .join("\n");
}

/** 顶层可选节点（组只整体选中；母版装饰不可选）。 */
export function collectEditableNodes(scene: RenderSlide): EditorNode[] {
  const nodes: EditorNode[] = [];
  for (const node of scene.nodes) {
    if (node.decoration) continue;
    nodes.push({
      id: node.sourceId || node.id,
      type: node.type,
      box: { x: node.box.x, y: node.box.y, w: node.box.w, h: node.box.h },
      rotationDeg: node.box.rotationDeg ?? 0,
      centerX: node.box.centerX,
      centerY: node.box.centerY,
      background: !!node.background,
      text: nodeText(node),
    });
  }
  return nodes;
}

/** 绕节点中心反向旋转，把点变换到节点本地坐标。 */
export function toLocalPoint(node: EditorNode, x: number, y: number): { x: number; y: number } {
  const deg = node.rotationDeg;
  if (!deg) return { x, y };
  const rad = (-deg * Math.PI) / 180;
  const dx = x - node.centerX;
  const dy = y - node.centerY;
  return {
    x: node.centerX + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: node.centerY + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

export function containsPoint(node: EditorNode, x: number, y: number): boolean {
  const p = toLocalPoint(node, x, y);
  const { box } = node;
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

/** 自上而下命中（后绘制 = 更靠上）。 */
export function hitTest(nodes: EditorNode[], x: number, y: number): EditorNode | null {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    if (containsPoint(node, x, y)) return node;
  }
  return null;
}

export function handlePoints(box: Box): Array<{ handle: ResizeHandle; x: number; y: number }> {
  const { x, y, w, h } = box;
  return [
    { handle: "nw", x, y },
    { handle: "n", x: x + w / 2, y },
    { handle: "ne", x: x + w, y },
    { handle: "e", x: x + w, y: y + h / 2 },
    { handle: "se", x: x + w, y: y + h },
    { handle: "s", x: x + w / 2, y: y + h },
    { handle: "sw", x, y: y + h },
    { handle: "w", x, y: y + h / 2 },
  ];
}

export function moveBox(box: Box, dx: number, dy: number): Box {
  return { ...box, x: box.x + dx, y: box.y + dy };
}

const MIN_SIZE = 8;

export function resizeBox(start: Box, handle: ResizeHandle, dx: number, dy: number): Box {
  let { x, y, w, h } = start;
  if (handle.includes("w")) {
    x += dx;
    w -= dx;
  }
  if (handle.includes("e")) {
    w += dx;
  }
  if (handle.includes("n")) {
    y += dy;
    h -= dy;
  }
  if (handle.includes("s")) {
    h += dy;
  }
  if (w < MIN_SIZE) {
    if (handle.includes("w")) x = start.x + start.w - MIN_SIZE;
    w = MIN_SIZE;
  }
  if (h < MIN_SIZE) {
    if (handle.includes("n")) y = start.y + start.h - MIN_SIZE;
    h = MIN_SIZE;
  }
  return { x, y, w, h };
}

/** 页面 px → 容器 px。 */
export function scaleBox(box: Box, scale: number): Box {
  return { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale };
}
