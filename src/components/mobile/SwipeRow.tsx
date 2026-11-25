import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * 移动端列表左滑行。
 *
 * - 手指横向滑动露出右侧操作按钮；纵向滑动不劫持（交给页面滚动）
 * - 同时只允许一行展开（通过自定义事件广播）
 * - 行已展开时，点击内容先收起，不触发内容自身 onClick
 *
 * 不引入手势库；Android WebView / iOS Safari 均可用。
 */
export interface SwipeAction {
  key: string;
  label: string;
  icon?: ReactNode;
  tone?: "primary" | "danger" | "neutral";
  onAction: () => void;
}

const ACTION_WIDTH = 76;
const SWIPE_EVENT = "m-swipe-open";

export function SwipeRow({
  children,
  actions,
  disabled = false,
}: {
  children: ReactNode;
  actions: SwipeAction[];
  disabled?: boolean;
}) {
  const rowId = useId();
  const maxOffset = actions.length * ACTION_WIDTH;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; y: number; base: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    function onOtherOpen(e: Event) {
      if ((e as CustomEvent<string>).detail !== rowId) setOffset(0);
    }
    window.addEventListener(SWIPE_EVENT, onOtherOpen);
    return () => window.removeEventListener(SWIPE_EVENT, onOtherOpen);
  }, [rowId]);

  if (disabled || actions.length === 0) {
    return <>{children}</>;
  }

  function openRow() {
    setOffset(-maxOffset);
    window.dispatchEvent(new CustomEvent(SWIPE_EVENT, { detail: rowId }));
  }

  function closeRow() {
    setOffset(0);
  }

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    startRef.current = { x: t.clientX, y: t.clientY, base: offset };
    movedRef.current = false;
  }

  function onTouchMove(e: React.TouchEvent) {
    const s = startRef.current;
    const t = e.touches[0];
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // 纵向意图优先：不拦截页面滚动
    if (!movedRef.current && Math.abs(dy) > Math.abs(dx)) return;
    if (Math.abs(dx) < 4 && !movedRef.current) return;
    movedRef.current = true;
    setDragging(true);
    const next = Math.min(0, Math.max(-maxOffset, s.base + dx));
    setOffset(next);
  }

  function onTouchEnd() {
    if (!startRef.current) {
      setDragging(false);
      return;
    }
    startRef.current = null;
    setDragging(false);
    if (!movedRef.current) {
      if (offset !== 0) closeRow();
      return;
    }
    if (offset < -maxOffset / 2) {
      openRow();
    } else {
      closeRow();
    }
  }

  return (
    <div
      className="relative overflow-hidden"
      style={{ touchAction: "pan-y" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* 右侧操作区 */}
      <div className="absolute inset-y-0 right-0 flex" style={{ width: maxOffset }}>
        {actions.map((a) => (
          <button
            key={a.key}
            onClick={() => {
              closeRow();
              a.onAction();
            }}
            className={`flex h-full flex-col items-center justify-center gap-0.5 text-xs font-medium text-[var(--m-on-primary)] ${
              a.tone === "danger"
                ? "bg-[var(--m-danger)]"
                : a.tone === "primary"
                  ? "bg-[var(--m-primary)]"
                  : "bg-[var(--m-ink-3)]"
            }`}
            style={{ width: ACTION_WIDTH, minHeight: 44 }}
          >
            {a.icon}
            <span>{a.label}</span>
          </button>
        ))}
      </div>

      {/* 内容层：展开时点击先收起 */}
      <div
        className="relative"
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? "none" : "transform 0.18s ease",
        }}
        onClickCapture={(e) => {
          if (offset !== 0) {
            e.preventDefault();
            e.stopPropagation();
            closeRow();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
