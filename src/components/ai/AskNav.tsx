import type { RefObject } from "react";
import { Tooltip, theme as antdTheme } from "antd";

export interface AskNavItem {
  id: number;
  /** 提问正文（用于悬停摘要） */
  text: string;
}

/**
 * AskNav —— 贴在消息区右边缘的提问导航。
 *
 * 一条细线 = 一次用户提问；点击滚动到对应气泡。
 * 定位依赖消息气泡上的 `id={`ask-${message.id}`}`。
 */
export function AskNav({
  questions,
  containerRef,
}: {
  questions: AskNavItem[];
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const { token } = antdTheme.useToken();

  if (questions.length < 2) return null;

  function jumpTo(id: number) {
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`#ask-${id}`);
    if (!el) return;
    container.scrollTo({
      top: Math.max(0, el.offsetTop - 16),
      behavior: "smooth",
    });
  }

  return (
    <div
      aria-label="提问导航"
      style={{
        position: "absolute",
        right: 6,
        top: 20,
        bottom: 20,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 6,
        zIndex: 5,
      }}
    >
      {questions.map((q) => (
        <Tooltip
          key={q.id}
          title={q.text.length > 80 ? `${q.text.slice(0, 80)}…` : q.text}
          placement="left"
        >
          <button
            type="button"
            onClick={() => jumpTo(q.id)}
            style={{
              width: 14,
              height: 3,
              padding: 0,
              border: "none",
              borderRadius: 2,
              cursor: "pointer",
              background: token.colorTextQuaternary,
              transition: "background .15s, transform .15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = token.colorPrimary;
              e.currentTarget.style.transform = "scaleX(1.4)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = token.colorTextQuaternary;
              e.currentTarget.style.transform = "scaleX(1)";
            }}
          />
        </Tooltip>
      ))}
    </div>
  );
}
