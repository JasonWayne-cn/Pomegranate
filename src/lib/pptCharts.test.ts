import { describe, expect, it } from "vitest";
import { chartDescription, chartDisplayName } from "./pptCharts";

describe("pptCharts", () => {
  it("使用中文名称并支持元数据覆盖", () => {
    expect(chartDisplayName("column_chart")).toBe("柱状图");
    expect(chartDisplayName("custom", { nameZh: "自定义图表" })).toBe(
      "自定义图表",
    );
    expect(chartDisplayName("unknown")).toBe("unknown");
  });

  it("优先使用 descriptionZh，其次内置说明", () => {
    expect(chartDescription("pie_chart", { descriptionZh: "中文说明" })).toBe(
      "中文说明",
    );
    expect(chartDescription("pie_chart")).toContain("占比");
    expect(chartDescription("unknown")).toBe("");
  });
});
