import { describe, expect, it } from "vitest";
import { buildBlankDocx, type Block } from "@genoffice/docx-engine";
import { openDocxSession, renderDocxHtml, saveDocxWithEdits } from "./docxEngine";

function block(partial: Partial<Block>): Block {
  return {
    id: "b1",
    type: "paragraph",
    docxIndex: 0,
    originalXml: null,
    ...partial,
  } as Block;
}

describe("DOCX 预览渲染", () => {
  it("渲染标题、段落与加粗文本", () => {
    const { html } = renderDocxHtml([
      block({ type: "heading", level: 1, runs: [{ text: "季度报告" }] }),
      block({
        runs: [
          { text: "营收 " },
          { text: "+31%", bold: true, color: "C1232D" },
        ],
      }),
    ]);
    expect(html).toContain("<h1");
    expect(html).toContain("季度报告");
    expect(html).toContain("font-weight:700");
    expect(html).toContain("#C1232D");
  });

  it("按显式分页符拆页并渲染页眉页脚", () => {
    const { html, pageCount } = renderDocxHtml(
      [
        block({ runs: [{ text: "第一页" }] }),
        block({ runs: [{ text: "第二页" }], format: { pageBreakBefore: true } }),
      ],
      { headerText: "季度报告", footerText: "机密", showPageNumbers: true },
    );
    expect(pageCount).toBe(2);
    expect(html).toContain("季度报告");
    expect(html).toContain("机密");
    expect(html).toContain("2 / 2");
  });

  it("无编辑保存 DOCX 仍可被重新解析", async () => {
    const bytes = await buildBlankDocx({ omitGeneratorFields: true });
    const session = await openDocxSession(bytes);
    const saved = await saveDocxWithEdits(session.parsed, {});
    const reopened = await openDocxSession(saved);
    expect(reopened.info.blockCount).toBeGreaterThanOrEqual(0);
  });

  it("字体度量会参与分页估算", () => {
    const blocks = Array.from({ length: 20 }, (_, index) =>
      block({ runs: [{ text: `段落 ${index} ${"A".repeat(120)}` }] }),
    );
    const base = {
      family: "Calibri",
      matched_family: "Calibri",
      ascent: 0.8,
      descent: 0.2,
      line_gap: 0,
      avg_cjk: 1,
      space: 0.25,
    };
    const narrow = renderDocxHtml(blocks, {
      fontMetrics: { calibri: { ...base, avg_latin: 0.2 } },
    });
    const wide = renderDocxHtml(blocks, {
      fontMetrics: { calibri: { ...base, avg_latin: 0.8 } },
    });
    expect(wide.pageCount).toBeGreaterThanOrEqual(narrow.pageCount);
  });

  it("无显式分页符时按估算高度自动分页", () => {
    const blocks = Array.from({ length: 60 }, (_, index) =>
      block({ runs: [{ text: `第 ${index} 段：${"内容".repeat(40)}` }] }),
    );
    const { pageCount } = renderDocxHtml(blocks);
    expect(pageCount).toBeGreaterThan(1);
  });

  it("渲染表格与单元格文本", () => {
    const { html } = renderDocxHtml([
      block({
        type: "table",
        table: {
          rows: [
            [
              { paras: ["指标"] },
              { paras: ["数值"] },
            ],
            [
              { paras: ["毛利率"] },
              { paras: ["42%"] },
            ],
          ],
        } as Block["table"],
      }),
    ]);
    expect(html).toContain("<table");
    expect(html).toContain("毛利率");
    expect(html).toContain("42%");
  });
});
