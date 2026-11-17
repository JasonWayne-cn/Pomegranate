import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addElement, createBlankPptx, openPptx } from "@genoffice/pptx-engine";
import {
  listPptxTextItems,
  openPptxSession,
  renderPptxSlides,
  savePptxSession,
  updatePptxText,
} from "./pptxEngine";
import { renderSlideSvg } from "./renderSlideSvg";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("GenOffice PPTX 引擎适配层", () => {
  it("打开空白 PPTX 并生成 RenderTree 预览", async () => {
    const bytes = await createBlankPptx();
    const session = await openPptxSession(bytes);

    expect(session.info.slideCount).toBe(1);
    expect(session.info.widthPx).toBeGreaterThan(0);
    expect(session.info.heightPx).toBeGreaterThan(0);

    const slides = renderPptxSlides(session, 960);
    expect(slides).toHaveLength(1);
    const svg = renderSlideSvg(slides[0]!.render);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox=");
  });

  it("可以修改文本框内容并重新打开验证", async () => {
    const blank = await createBlankPptx();
    const opened = await openPptx(blank);
    addElement(opened.deck.slides[0]!, {
      kind: "textbox",
      offset: { x: 914400, y: 914400, cx: 3657600, cy: 914400 },
      paragraphs: [{ runs: [{ text: "原始标题" }] }],
    });
    const withText = await savePptxSession({
      opened,
      mediaCache: new Map(),
      info: { slideCount: 1, widthPx: 0, heightPx: 0, hash: opened.deck.originalHash },
    });

    const session = await openPptxSession(withText);
    const items = listPptxTextItems(session);
    expect(items.length).toBe(1);
    expect(items[0]!.text).toContain("原始标题");

    expect(updatePptxText(session, 0, items[0]!.elementId, "修改后的标题")).toBe(true);
    const saved = await savePptxSession(session);
    const reopened = await openPptxSession(saved);
    const reopenedItems = listPptxTextItems(reopened);
    expect(reopenedItems[0]!.text).toContain("修改后的标题");
  });

  it("无编辑保存保持字节一致", async () => {
    const bytes = await createBlankPptx();
    const session = await openPptxSession(bytes);
    const saved = await savePptxSession(session);

    expect(saved.byteLength).toBe(bytes.byteLength);
    expect(sha256(saved)).toBe(sha256(bytes));
    expect(session.info.hash).toBe(sha256(bytes));
  });
});
