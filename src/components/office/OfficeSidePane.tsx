/** 可拖拽宽度的侧栏（PPT 缩略图 / Word 导航共用）。 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { theme as antdTheme } from "antd";

interface OfficeSidePaneProps {
  storageKey: string;
  defaultWidth: number;
  min?: number;
  max?: number;
  children: ReactNode;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function OfficeSidePane({
  storageKey,
  defaultWidth,
  min = 120,
  max = 520,
  children,
}: OfficeSidePaneProps) {
  const { token } = antdTheme.useToken();
  const [width, setWidth] = useState(() => clamp(loadWidth(storageKey, defaultWidth), min, max));
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      /* 存储失败不影响布局 */
    }
  }, [storageKey, width]);

  return (
    <div className="flex min-h-0 self-stretch">
      <div className="min-h-0 shrink-0 overflow-hidden" style={{ width }}>
        {children}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        title="拖动调整宽度，双击重置"
        className="group relative w-1.5 shrink-0 cursor-col-resize select-none touch-none"
        style={{ background: token.colorBgContainer }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { startX: event.clientX, startWidth: width };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          setWidth(clamp(drag.startWidth + (event.clientX - drag.startX), min, max));
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onDoubleClick={() => setWidth(clamp(defaultWidth, min, max))}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover:bg-blue-400"
          style={{ background: token.colorBorderSecondary }}
        />
      </div>
    </div>
  );
}
