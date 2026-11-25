import PromptsSection from "@/components/settings/PromptsSection";
import { useIsMobile } from "@/hooks/useIsMobile";
import { MobilePrompts } from "./MobilePrompts";

/**
 * 兼容页：提示词管理已并入「AI 问答 → 配置 → 提示词」。
 *
 * 保留 /prompts 路由，供移动端与历史书签直接访问；桌面端入口已从
 * ActivityBar / Sidebar 移除。移动端只读浏览 + 复制，编辑仍走桌面。
 */
export default function PromptsPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobilePrompts /> : <PromptsSection />;
}
