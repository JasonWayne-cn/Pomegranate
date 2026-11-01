import { describe, expect, it } from "vitest";
import {
  addPlanSlide,
  movePlanSlide,
  removePlanSlide,
  updatePlanSlide,
} from "./pptPlan";
import type { PptPlan } from "@/types/extension";

function plan(): PptPlan {
  return {
    title: "测试",
    slides: [
      { page: 1, title: "A", coreMessage: "", bullets: [] },
      { page: 2, title: "B", coreMessage: "", bullets: [] },
      { page: 3, title: "C", coreMessage: "", bullets: [] },
    ],
  };
}

describe("pptPlan", () => {
  it("更新单页且不修改原对象", () => {
    const source = plan();
    const next = updatePlanSlide(source, 1, { title: "B2" });
    expect(next.slides[1].title).toBe("B2");
    expect(source.slides[1].title).toBe("B");
  });

  it("删除后重新编号", () => {
    const next = removePlanSlide(plan(), 1);
    expect(next.slides.map((slide) => slide.title)).toEqual(["A", "C"]);
    expect(next.slides.map((slide) => slide.page)).toEqual([1, 2]);
  });

  it("移动越界时保持原样", () => {
    const source = plan();
    expect(movePlanSlide(source, 0, -1)).toBe(source);
    expect(movePlanSlide(source, 2, 1)).toBe(source);
  });

  it("移动后重新编号", () => {
    const next = movePlanSlide(plan(), 0, 1);
    expect(next.slides.map((slide) => slide.title)).toEqual(["B", "A", "C"]);
    expect(next.slides.map((slide) => slide.page)).toEqual([1, 2, 3]);
  });

  it("追加空白页", () => {
    const next = addPlanSlide(plan());
    expect(next.slides).toHaveLength(4);
    expect(next.slides[3].page).toBe(4);
    expect(next.slides[3].title).toBe("第 4 页");
  });
});
