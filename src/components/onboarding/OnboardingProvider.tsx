import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Tour } from "antd";
import type { TourProps } from "antd";
import { TOURS } from "@/lib/onboarding/tours";
import type { OnboardingTourId } from "@/lib/onboarding/types";

type TourSteps = NonNullable<TourProps["steps"]>;

export interface OnboardingContextValue {
  /** 手动开始指定引导 */
  startTour: (id: OnboardingTourId) => void;
  activeTour: OnboardingTourId | null;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  startTour: () => {},
  activeTour: null,
});

/**
 * 把「选择器定义」解析成 antd Tour 需要的元素。
 * 锚点不存在（功能关闭、面板折叠、数据未加载）时跳过该步，
 * 而不是让整个引导失败。
 */
function resolveSteps(id: OnboardingTourId): TourSteps {
  return TOURS[id].steps.flatMap((step) => {
    const target = document.querySelector<HTMLElement>(step.target);
    if (!target) return [];
    return [
      {
        title: step.title,
        description: step.description,
        target: () => target,
        placement: step.placement,
      },
    ];
  });
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<TourSteps>([]);
  const [current, setCurrent] = useState(0);
  const [activeTour, setActiveTour] = useState<OnboardingTourId | null>(null);
  const activeRef = useRef<OnboardingTourId | null>(null);

  const startTour = useCallback((id: OnboardingTourId) => {
    const resolved = resolveSteps(id);
    // 当前页面没有任何可用锚点时不启动，也不记为已完成（下次进入再试）
    if (resolved.length === 0) return;
    activeRef.current = id;
    setActiveTour(id);
    setSteps(resolved);
    setCurrent(0);
    setOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    activeRef.current = null;
    setOpen(false);
    setActiveTour(null);
    setCurrent(0);
  }, []);

  const value = useMemo(
    () => ({ startTour, activeTour }),
    [startTour, activeTour],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
      <Tour
        open={open}
        current={current}
        steps={steps}
        onChange={setCurrent}
        onClose={handleClose}
        onFinish={handleClose}
        scrollIntoViewOptions={{ block: "center" }}
      />
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  return useContext(OnboardingContext);
}
