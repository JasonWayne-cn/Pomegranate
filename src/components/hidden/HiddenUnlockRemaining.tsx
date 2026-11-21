import { useEffect, useState, type CSSProperties } from "react";
import { HIDDEN_UNLOCK_TTL_MS, useAppStore } from "@/store";

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 隐藏文档 PIN 会话剩余时间（仅在已解锁时每秒刷新） */
export function useHiddenUnlockRemaining(): {
  unlocked: boolean;
  remainingMs: number;
  label: string;
} {
  const unlockedAt = useAppStore((s) => s.hiddenUnlockedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (unlockedAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [unlockedAt]);

  const remainingMs =
    unlockedAt == null
      ? 0
      : Math.max(0, HIDDEN_UNLOCK_TTL_MS - (now - unlockedAt));

  return {
    unlocked: unlockedAt != null && remainingMs > 0,
    remainingMs,
    label: formatRemaining(remainingMs),
  };
}

/**
 * 倒计时文本「密钥 9:58」。未解锁时不渲染。
 *
 * 计时状态收在这个小组件内部，避免每秒把整个面板 / 文件夹树重渲染一遍。
 */
export function HiddenUnlockCountdown({ style }: { style?: CSSProperties }) {
  const { unlocked, label } = useHiddenUnlockRemaining();
  if (!unlocked) return null;
  return (
    <span
      style={{
        fontSize: 11,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
    >
      密钥 {label}
    </span>
  );
}

/** Tooltip 标题：未解锁时只显示基础文案，解锁后附带剩余时间 */
export function HiddenUnlockTitle({ text }: { text: string }) {
  const { unlocked, label } = useHiddenUnlockRemaining();
  return (
    <span>
      {text}
      {unlocked ? ` · 密钥剩余 ${label}` : ""}
    </span>
  );
}
