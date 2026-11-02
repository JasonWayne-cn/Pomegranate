/** PPT 版式中文名称与说明。 */

type LayoutMetaLike = {
  nameZh?: string | null;
  descriptionZh?: string | null;
  summary?: string | null;
};

export const PPT_LAYOUT_NAMES: Record<string, string> = {
  // 当前内置模板
  kpi_report_core: "KPI 报告",
  insight_explainer: "浅色学术讲解",
  aviation_training_blue: "航空维修蓝",
  mbb_dense_report: "MBB 高密度咨询报告",
  premium_strategy_dark: "高端战略深色",
  oriental_classic_research: "东方古典研究",
  tech_compare_dark: "科技工具对比",
  // 旧版模板兼容
  editorial_bleed: "杂志出血版",
  moments_square: "朋友圈方形",
  presentation_core: "通用演示 16:9",
  presentation_core_43: "通用演示 4:3",
  report_core: "正式报告",
  story_vertical: "竖屏故事",
  xiaohongshu_post: "小红书图文",
};

export function layoutDisplayName(
  id: string,
  meta?: LayoutMetaLike | null,
): string {
  const fromMeta = meta?.nameZh?.trim();
  if (fromMeta) return fromMeta;
  return PPT_LAYOUT_NAMES[id] ?? id;
}

export function layoutDescription(
  meta?: LayoutMetaLike | null,
): string {
  return meta?.descriptionZh?.trim() || meta?.summary?.trim() || "";
}
