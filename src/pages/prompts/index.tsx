import PromptsSection from "@/components/settings/PromptsSection";

/**
 * 兼容页：提示词管理已并入「AI 问答 → 配置 → 提示词」。
 *
 * 保留 /prompts 路由，供移动端与历史书签直接访问；桌面端入口已从
 * ActivityBar / Sidebar 移除。
 */
export default function PromptsPage() {
  return <PromptsSection />;
}
