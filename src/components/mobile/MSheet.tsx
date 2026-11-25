import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";

/**
 * 移动端通用底部面板（MSheet）。
 *
 * 统一承载：ActionSheet、TaskCreateSheet、TextPromptModal、各种 Picker。
 * - 遮罩淡入 + 面板滑入（keyframes 在 styles/mobile.css）
 * - 顶部把手可下滑关闭（触摸拖动 > 96px）
 * - 键盘弹出时顶在键盘之上；否则让出底部安全区
 * - 打开时锁定背景滚动
 */
export interface MSheetProps {
  open: boolean;
  title?: string;
  children: ReactNode;
  onClose: () => void;
  /** 面板最大高度，默认 85vh */
  maxHeight?: number | string;
  /** 是否让出软键盘高度（含输入框的面板必须为 true） */
  keyboardAware?: boolean;
  /** 点击遮罩是否关闭，默认 true */
  dismissOnBackdrop?: boolean;
}

export function MSheet({
  open,
  title,
  children,
  onClose,
  maxHeight = "85vh",
  keyboardAware = false,
  dismissOnBackdrop = true,
}: MSheetProps) {
  const keyboardInset = useKeyboardInset();
  const [dragY, setDragY] = useState(0);
  const startYRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setDragY(0);
      startYRef.current = null;
    }
  }, [open]);

  if (!open) return null;

  function onTouchStart(e: React.TouchEvent) {
    startYRef.current = e.touches[0]?.clientY ?? null;
  }

  function onTouchMove(e: React.TouchEvent) {
    if (startYRef.current == null) return;
    const dy = (e.touches[0]?.clientY ?? 0) - startYRef.current;
    setDragY(Math.max(0, dy));
  }

  function onTouchEnd() {
    if (dragY > 96) onClose();
    setDragY(0);
    startYRef.current = null;
  }

  const bottomPad =
    keyboardAware && keyboardInset > 0
      ? keyboardInset
      : "env(safe-area-inset-bottom, 0px)";

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/40 animate-[mFadeIn_0.15s_ease]"
        onClick={dismissOnBackdrop ? onClose : undefined}
      />

      <div
        className="relative z-10 flex max-h-full flex-col rounded-t-[var(--m-radius-sheet)] bg-[var(--m-surface)] text-[var(--m-ink-1)] animate-[mSheetUp_0.22s_ease]"
        style={{
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragY > 0 ? "none" : "transform 0.18s ease",
          paddingBottom: bottomPad,
          maxHeight,
        }}
      >
        {/* 把手：拖动关闭，不劫持内容滚动 */}
        <div
          className="flex shrink-0 touch-none flex-col items-center pt-2 pb-1"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <span className="h-1 w-9 rounded-full bg-[var(--m-line)]" />
          {title && (
            <div className="mt-2 max-w-full truncate px-6 text-center text-xs text-[var(--m-ink-3)]">
              {title}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </div>
    </div>
  );
}
