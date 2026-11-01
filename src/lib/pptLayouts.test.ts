import { describe, expect, it } from "vitest";
import { layoutDescription, layoutDisplayName } from "./pptLayouts";

describe("pptLayouts", () => {
  it("使用中文名称并支持元数据覆盖", () => {
    expect(layoutDisplayName("kpi_report_core")).toBe("KPI 报告");
    expect(
      layoutDisplayName("custom", { nameZh: "自定义模板" }),
    ).toBe("自定义模板");
    expect(layoutDisplayName("unknown")).toBe("unknown");
  });

  it("优先使用 descriptionZh，其次 summary", () => {
    expect(layoutDescription({ descriptionZh: "中文说明" })).toBe("中文说明");
    expect(layoutDescription({ summary: "上游摘要" })).toBe("上游摘要");
    expect(layoutDescription(null)).toBe("");
  });
});
