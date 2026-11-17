import { describe, expect, it } from "vitest";
import type { RenderSlide } from "@genoffice/pptx-render";
import {
  collectEditableNodes,
  hitTest,
  moveBox,
  resizeBox,
  scaleBox,
  type EditorNode,
} from "./geometry";

function node(overrides: Partial<EditorNode> & Pick<EditorNode, "id">): EditorNode {
  return {
    type: "shape",
    box: { x: 0, y: 0, w: 100, h: 50 },
    rotationDeg: 0,
    centerX: 50,
    centerY: 25,
    background: false,
    text: null,
    ...overrides,
  };
}

function slide(nodes: Array<Record<string, unknown>>): RenderSlide {
  return {
    widthPx: 960,
    heightPx: 540,
    scale: 1,
    background: { kind: "none" },
    nodes,
  } as unknown as RenderSlide;
}

const rawNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  sourceId: id,
  type: "shape",
  box: { x: 0, y: 0, w: 100, h: 50, rotationDeg: 0, centerX: 50, centerY: 25, flipH: false, flipV: false },
  ...extra,
});

describe("collectEditableNodes", () => {
  it("跳过母版装饰节点并提取文本", () => {
    const scene = slide([
      rawNode("a", {
        type: "text",
        text: { lines: [{ runs: [{ text: "Hello" }] }, { runs: [{ text: "World" }] }] },
        box: { x: 10, y: 10, w: 200, h: 80, rotationDeg: 0, centerX: 110, centerY: 50 },
      }),
      rawNode("deco", { decoration: true }),
      rawNode("bg", { background: true }),
    ]);
    const nodes = collectEditableNodes(scene);
    expect(nodes.map((entry) => entry.id)).toEqual(["a", "bg"]);
    expect(nodes[0]!.text).toBe("Hello\nWorld");
    expect(nodes[1]!.background).toBe(true);
  });
});

describe("hitTest", () => {
  it("命中最后绘制的节点", () => {
    const nodes = [node({ id: "under" }), node({ id: "over", box: { x: 20, y: 0, w: 50, h: 50 } })];
    expect(hitTest(nodes, 30, 20)?.id).toBe("over");
    expect(hitTest(nodes, 5, 5)?.id).toBe("under");
    expect(hitTest(nodes, 500, 500)).toBeNull();
  });

  it("按节点旋转反向变换命中", () => {
    const rotated = node({
      id: "rot",
      rotationDeg: 90,
      box: { x: 0, y: 0, w: 100, h: 50 },
      centerX: 50,
      centerY: 25,
    });
    // 未旋转时 (50,70) 在矩形外；旋转 90° 后落在矩形内
    expect(hitTest([rotated], 50, 70)?.id).toBe("rot");
  });
});

describe("resizeBox", () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };

  it("从西侧拖动同时移动左边界", () => {
    expect(resizeBox(start, "w", 20, 0)).toEqual({ x: 120, y: 100, w: 180, h: 100 });
  });

  it("从东南角拖动只改尺寸", () => {
    expect(resizeBox(start, "se", 30, 10)).toEqual({ x: 100, y: 100, w: 230, h: 110 });
  });

  it("最小尺寸时保持另一侧边界不动", () => {
    const box = resizeBox(start, "w", 500, 0);
    expect(box.w).toBe(8);
    expect(box.x).toBe(292);
  });
});

describe("moveBox / scaleBox", () => {
  it("平移不改变尺寸", () => {
    expect(moveBox({ x: 1, y: 2, w: 3, h: 4 }, 10, -5)).toEqual({ x: 11, y: -3, w: 3, h: 4 });
  });

  it("按容器比例缩放", () => {
    expect(scaleBox({ x: 10, y: 20, w: 100, h: 50 }, 0.5)).toEqual({
      x: 5,
      y: 10,
      w: 50,
      h: 25,
    });
  });
});
