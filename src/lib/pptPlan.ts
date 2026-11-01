import type { PptPlan, PptSlide } from "@/types/extension";

/** 创建一页空白大纲。 */
export function blankSlide(index: number): PptSlide {
  return {
    page: index + 1,
    title: `第 ${index + 1} 页`,
    coreMessage: "",
    bullets: [],
  };
}

function renumber(slides: PptSlide[]): PptSlide[] {
  return slides.map((slide, index) => ({ ...slide, page: index + 1 }));
}

/** 不可变地更新某一页。 */
export function updatePlanSlide(
  plan: PptPlan,
  index: number,
  patch: Partial<PptSlide>,
): PptPlan {
  return {
    ...plan,
    slides: plan.slides.map((slide, i) =>
      i === index ? { ...slide, ...patch } : slide,
    ),
  };
}

/** 在末尾追加一页。 */
export function addPlanSlide(plan: PptPlan): PptPlan {
  return {
    ...plan,
    slides: renumber([...plan.slides, blankSlide(plan.slides.length)]),
  };
}

/** 删除一页并重新编号。 */
export function removePlanSlide(plan: PptPlan, index: number): PptPlan {
  return {
    ...plan,
    slides: renumber(plan.slides.filter((_, i) => i !== index)),
  };
}

/** 上移/下移一页；越界时保持原样。 */
export function movePlanSlide(
  plan: PptPlan,
  index: number,
  delta: number,
): PptPlan {
  const target = index + delta;
  if (target < 0 || target >= plan.slides.length) {
    return plan;
  }
  const slides = [...plan.slides];
  const [item] = slides.splice(index, 1);
  slides.splice(target, 0, item);
  return { ...plan, slides: renumber(slides) };
}
