/** PPT 图表模板中文名称与选择说明。 */
import type { PptChartMeta } from "@/types/extension";

export interface PptChartDescriptor {
  name: string;
  description: string;
}

export const PPT_CHARTS: Record<string, PptChartDescriptor> = {
  area_chart: {
    name: "面积图",
    description: "适合 1–2 条累积趋势，强调总量随时间变化。",
  },
  bar_of_pie_chart: {
    name: "饼图明细条形",
    description: "饼图构成中，把长尾小项展开为条形明细。",
  },
  box_plot_chart: {
    name: "箱线图",
    description: "展示分组分布：中位数、四分位与离群值。",
  },
  bubble_chart: {
    name: "气泡图",
    description: "三个维度的相关性：x、y 与气泡大小。",
  },
  bullet_chart: {
    name: "子弹图",
    description: "3–7 个 KPI 的目标值与实际值对比。",
  },
  butterfly_chart: {
    name: "蝶形图",
    description: "共享轴的两组镜像数据，如人口金字塔、A/B 对比。",
  },
  column_chart: {
    name: "柱状图",
    description: "单系列类别数值比较，适合 3–8 个类别。",
  },
  donut_chart: {
    name: "环形图",
    description: "3–6 项占比，中心可突出总量或核心 KPI。",
  },
  dual_axis_line_chart: {
    name: "双轴折线图",
    description: "两个不同单位或量级的指标随时间对比。",
  },
  dumbbell_chart: {
    name: "哑铃图",
    description: "5–10 项的前后变化或两状态差异。",
  },
  funnel_chart: {
    name: "漏斗图",
    description: "3–5 个顺序转化阶段，数值逐级递减。",
  },
  gantt_chart: {
    name: "甘特图",
    description: "6–12 个任务的项目排期、时长与依赖。",
  },
  gauge_chart: {
    name: "仪表盘",
    description: "单个有界指标对照目标值或阈值。",
  },
  grouped_bar_chart: {
    name: "分组柱状图",
    description: "2–4 个系列在同一类别下并排对比。",
  },
  heatmap_chart: {
    name: "热力图",
    description: "二维矩阵的强度分布，如活跃度、相关性。",
  },
  histogram_chart: {
    name: "直方图",
    description: "大量观测值的数值分布与区间统计。",
  },
  horizontal_bar_chart: {
    name: "条形图",
    description: "5–12 项排名，尤其适合长标签类别。",
  },
  line_chart: {
    name: "折线图",
    description: "1–3 条时间序列的方向与趋势。",
  },
  matrix_2x2: {
    name: "2×2 矩阵",
    description: "4–10 项按两个维度定位，气泡大小表示第三维。",
  },
  pareto_chart: {
    name: "帕累托图",
    description: "80/20 贡献分析：降序柱加累计线。",
  },
  pie_chart: {
    name: "饼图",
    description: "3–6 项简单占比，突出整体构成。",
  },
  pie_of_pie_chart: {
    name: "复合饼图",
    description: "饼图中的小项需要二级饼图展开明细。",
  },
  progress_bar_chart: {
    name: "进度条",
    description: "3–8 项各自的完成百分比。",
  },
  radar_chart: {
    name: "雷达图",
    description: "4–8 个能力维度、1–3 个对象的评分对比。",
  },
  sankey_chart: {
    name: "桑基图",
    description: "3 阶段且带量级的分流：来源、节点与去向。",
  },
  scatter_chart: {
    name: "散点图",
    description: "x-y 相关性、聚类或离群点观察。",
  },
  stacked_area_chart: {
    name: "堆叠面积图",
    description: "2–4 个系列，同时观察总量与构成变化。",
  },
  stacked_bar_chart: {
    name: "堆叠柱状图",
    description: "类别内部 2–4 个组成部分，总量仍然重要。",
  },
  stock_chart: {
    name: "K 线图",
    description: "按日期的开盘、最高、最低、收盘价格走势。",
  },
  sunburst_chart: {
    name: "旭日图",
    description: "2–3 层级的部分与整体构成关系。",
  },
  treemap_chart: {
    name: "矩形树图",
    description: "多层级或分组面积占比，项目多且大小不一。",
  },
  waterfall_chart: {
    name: "瀑布图",
    description: "从起始值到结束值的逐步增减拆解。",
  },
  word_cloud: {
    name: "词云",
    description: "20–30 个关键词，字号表示频率或权重。",
  },
};

export function chartDisplayName(
  id: string,
  meta?: PptChartMeta | null,
): string {
  const fromMeta = meta?.nameZh?.trim();
  if (fromMeta) return fromMeta;
  return PPT_CHARTS[id]?.name ?? id;
}

export function chartDescription(
  id: string,
  meta?: PptChartMeta | null,
): string {
  const fromMeta = meta?.descriptionZh?.trim();
  if (fromMeta) return fromMeta;
  return PPT_CHARTS[id]?.description ?? "";
}
