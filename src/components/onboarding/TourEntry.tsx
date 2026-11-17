import { Button, Dropdown, Tooltip } from "antd";
import { Compass, Map } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useOnboarding } from "@/components/onboarding/OnboardingProvider";
import type { OnboardingTourId } from "@/lib/onboarding/types";

/** 当前路由对应的页面引导；无独立引导时只能查看应用总览 */
function tourIdForPath(pathname: string): OnboardingTourId | null {
  if (pathname === "/") return "home";
  if (pathname === "/notes") return "notes";
  if (pathname === "/daily") return "daily";
  return null;
}

/**
 * Header 右侧的「新手引导」入口：手动重放当前页引导或应用总览。
 */
export function TourEntry() {
  const location = useLocation();
  const { startTour } = useOnboarding();
  const pageTour = tourIdForPath(location.pathname);

  function handleMenuClick(key: string) {
    if (key === "page" && pageTour) {
      startTour(pageTour);
      return;
    }
    if (key === "app") {
      startTour("app");
    }
  }

  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        items: [
          {
            key: "page",
            label: "重放当前页引导",
            disabled: !pageTour,
          },
          {
            key: "app",
            label: "应用总览",
            icon: <Map size={14} />,
          },
        ],
        onClick: ({ key }) => handleMenuClick(key),
      }}
    >
      <Tooltip title="新手引导">
        <Button type="text" icon={<Compass size={16} />} />
      </Tooltip>
    </Dropdown>
  );
}
