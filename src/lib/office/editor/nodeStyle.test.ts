import { describe, expect, it } from "vitest";
import type { RenderNode } from "@genoffice/pptx-render";
import { pxToPt, styleOfNode } from "./nodeStyle";

function shape(extra: Record<string, unknown> = {}): RenderNode {
  return {
    id: "shape",
    sourceId: "shape",
    type: "shape",
    box: { x: 0, y: 0, w: 100, h: 50, rotationDeg: 0, centerX: 50, centerY: 25 },
    ...extra,
  } as unknown as RenderNode;
}

describe("pxToPt", () => {
  it("按 viewport scale 换算回 pt", () => {
    // 24pt @ scale 0.75 → 24px
    expect(pxToPt(24, 0.75)).toBe(24);
    // 24pt @ scale 1 → 32px
    expect(pxToPt(32, 1)).toBe(24);
  });

  it("非法 scale 回退到 0.75", () => {
    expect(pxToPt(24, 0)).toBe(24);
  });
});

describe("styleOfNode", () => {
  it("提取纯色填充、描边与文本样式", () => {
    const node = shape({
      fill: { kind: "solid", color: "#FF0000" },
      stroke: { color: "#00FF00", widthPt: 2.5 },
      text: {
        lines: [
          {
            align: "center",
            runs: [
              {
                fontFamily: "Arial",
                srcFontFamily: "微软雅黑",
                fontSizePx: 24,
                color: "#000000",
                bold: true,
                italic: false,
                underline: true,
              },
            ],
          },
        ],
      },
    });
    const style = styleOfNode(node, 0.75);
    expect(style.fillKind).toBe("solid");
    expect(style.fillColor).toBe("#FF0000");
    expect(style.strokeColor).toBe("#00FF00");
    expect(style.strokeWidthPt).toBe(2.5);
    expect(style.text).toEqual({
      fontFamily: "微软雅黑",
      fontSizePt: 24,
      color: "#000000",
      bold: true,
      italic: false,
      underline: true,
      align: "center",
    });
    expect(style.canFill).toBe(true);
    expect(style.canStroke).toBe(true);
  });

  it("非纯色填充不提供颜色且图片不可填充", () => {
    const node = shape({ fill: { kind: "gradient" } });
    const style = styleOfNode(node, 0.75);
    expect(style.fillColor).toBeUndefined();
    expect(style.fillKind).toBe("gradient");

    const picture = shape({ type: "picture" });
    const picStyle = styleOfNode(picture, 0.75);
    expect(picStyle.canFill).toBe(false);
    expect(picStyle.canStroke).toBe(true);
    expect(picStyle.text).toBeUndefined();
  });
});
