/** 引导步骤的锚点使用 data-tour 选择器，避免依赖 class 或 DOM 层级 */
export type OnboardingTourId = "app" | "home" | "notes" | "daily";

export interface OnboardingStepDef {
  /** CSS 选择器，例如 [data-tour="home-search"] */
  target: string;
  title: string;
  description: string;
  placement?: "top" | "bottom" | "left" | "right";
}

export interface OnboardingTourDef {
  id: OnboardingTourId;
  title: string;
  steps: OnboardingStepDef[];
}
