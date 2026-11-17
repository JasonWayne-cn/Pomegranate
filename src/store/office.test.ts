import { describe, expect, it } from "vitest";
import { mergeRecent, type RecentFile } from "./office";

const file = (path: string, at = 0): RecentFile => ({
  path,
  name: path.split(/[\\/]/).pop() ?? path,
  format: path.endsWith(".pdf") ? "pdf" : "pptx",
  at,
});

describe("mergeRecent", () => {
  it("新条目置顶", () => {
    const list = [file("a.pptx"), file("b.pptx")];
    expect(mergeRecent(list, file("c.pptx")).map((item) => item.path)).toEqual([
      "c.pptx",
      "a.pptx",
      "b.pptx",
    ]);
  });

  it("按 path 去重", () => {
    const list = [file("a.pptx", 1), file("b.pptx", 2)];
    const next = mergeRecent(list, file("b.pptx", 3));
    expect(next).toHaveLength(2);
    expect(next[0]!.path).toBe("b.pptx");
    expect(next[0]!.at).toBe(3);
  });

  it("限制为 12 条", () => {
    const list = Array.from({ length: 12 }, (_, index) => file(`${index}.pptx`));
    const next = mergeRecent(list, file("new.pptx"));
    expect(next).toHaveLength(12);
    expect(next[0]!.path).toBe("new.pptx");
    expect(next.some((item) => item.path === "11.pptx")).toBe(false);
  });
});
