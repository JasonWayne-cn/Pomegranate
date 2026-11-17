import { describe, expect, it } from "vitest";
import type { RenderSlide } from "@genoffice/pptx-render";
import { renderSlideSvg } from "./renderSlideSvg";

function slideWith(nodes: unknown[]): RenderSlide {
  return {
    widthPx: 960,
    heightPx: 540,
    scale: 1,
    background: { kind: "solid", color: "#FFFFFF" },
    nodes,
  } as unknown as RenderSlide;
}

describe("PPTX RenderTree → SVG", () => {
  it("渲染表格单元格与边框", () => {
    const svg = renderSlideSvg(
      slideWith([
        {
          id: "t1",
          sourceId: "t1",
          type: "table",
          box: { x: 40, y: 40, w: 400, h: 120, rotationDeg: 0, centerX: 240, centerY: 100 },
          gridX: [0, 200, 400],
          gridY: [0, 60, 120],
          cells: [
            {
              x: 0,
              y: 0,
              w: 200,
              h: 60,
              row: 0,
              col: 0,
              fill: { kind: "solid", color: "#F3F4F6" },
              text: {
                lines: [
                  {
                    top: 0,
                    height: 24,
                    runs: [
                      {
                        text: "区域",
                        x: 4,
                        baselineY: 18,
                        fontFamily: "sans-serif",
                        fontSizePx: 14,
                        color: "#111111",
                        bold: false,
                        italic: false,
                        underline: false,
                        widthPx: 28,
                      },
                    ],
                  },
                ],
                insets: { l: 0, t: 0, r: 0, b: 0 },
                anchor: "top",
                fontScale: 1,
                contentHeight: 24,
                wrap: true,
              },
            },
          ],
        },
      ]),
    );
    expect(svg).toContain("区域");
    expect(svg).toContain("<rect");
  });

  it("渲染柱状图与标签", () => {
    const svg = renderSlideSvg(
      slideWith([
        {
          id: "c1",
          sourceId: "c1",
          type: "chart",
          box: { x: 40, y: 40, w: 400, h: 260, rotationDeg: 0, centerX: 240, centerY: 170 },
          gridLines: [],
          axisLines: [],
          labels: [
            {
              text: "收入",
              x: 10,
              y: 10,
              fontSizePx: 12,
              color: "#333333",
            },
          ],
          bars: [{ x: 20, y: 100, w: 40, h: 120, color: "#0071BC" }],
          polylines: [],
          markers: [],
          swatches: [],
        },
      ]),
    );
    expect(svg).toContain("收入");
    expect(svg).toContain('fill="#0071BC"');
  });
});
