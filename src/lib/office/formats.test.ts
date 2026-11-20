import { describe, expect, it } from "vitest";
import {
  baseName,
  formatOf,
  isEditable,
  officePathForSource,
  stripExtension,
} from "./formats";

describe("formatOf", () => {
  it("识别常见 OOXML 扩展名", () => {
    expect(formatOf("报告.pptx")).toBe("pptx");
    expect(formatOf("C:/tmp/合同.PPTM")).toBe("pptx");
    expect(formatOf("a.docx")).toBe("docx");
    expect(formatOf("b.docm")).toBe("docx");
    expect(formatOf("c.xlsx")).toBe("xlsx");
    expect(formatOf("d.XLSM")).toBe("xlsx");
    expect(formatOf("e.pdf")).toBe("pdf");
  });

  it("拒绝不支持的类型", () => {
    expect(formatOf("a.txt")).toBeNull();
    expect(formatOf("no-extension")).toBeNull();
  });
});

describe("路径工具", () => {
  it("baseName 兼容 Windows 与 POSIX 分隔符", () => {
    expect(baseName("C:\\docs\\a.pptx")).toBe("a.pptx");
    expect(baseName("/home/user/a.docx")).toBe("a.docx");
    expect(baseName("a.xlsx")).toBe("a.xlsx");
  });

  it("stripExtension 去掉最后一个扩展名", () => {
    expect(stripExtension("年度.报告.pptx")).toBe("年度.报告");
    expect(stripExtension("noext")).toBe("noext");
  });

  it("PDF 不可编辑", () => {
    expect(isEditable("pptx")).toBe(true);
    expect(isEditable("docx")).toBe(true);
    expect(isEditable("xlsx")).toBe(true);
    expect(isEditable("pdf")).toBe(false);
  });
});

describe("officePathForSource", () => {
  it("二进制文档走 Office 工作台（只读）", () => {
    const pdf = officePathForSource("C:\\docs\\参考文献\\a.pdf");
    expect(pdf).toMatch(/^\/office\?/);
    expect(pdf).toContain("readonly=1");
    expect(decodeURIComponent(pdf!)).toContain("a.pdf");
    expect(officePathForSource("C:\\docs\\a.docx")).toMatch(/^\/office\?/);
    expect(officePathForSource("C:\\docs\\a.xlsx")).toMatch(/^\/office\?/);
  });

  it("普通文本与空路径返回 null", () => {
    expect(officePathForSource("C:\\docs\\a.md")).toBeNull();
    expect(officePathForSource("C:\\docs\\a.txt")).toBeNull();
    expect(officePathForSource(null)).toBeNull();
  });
});
