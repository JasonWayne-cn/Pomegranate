/** 工作台文档标签：独立于笔记 TabBar，支持脏标记与关闭。 */
import { theme as antdTheme, Tooltip } from "antd";
import { X } from "lucide-react";
import { FORMAT_LABEL } from "@/lib/office/formats";
import type { OfficeSessionMeta } from "@/store/office";

interface OfficeTabStripProps {
  sessions: OfficeSessionMeta[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

export function OfficeTabStrip({
  sessions,
  activeId,
  onActivate,
  onClose,
}: OfficeTabStripProps) {
  const { token } = antdTheme.useToken();
  if (sessions.length === 0) return null;

  return (
    <div
      className="flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto px-2"
      style={{
        background: token.colorBgLayout,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {sessions.map((session) => {
        const active = session.id === activeId;
        return (
          <div
            key={session.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onActivate(session.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onActivate(session.id);
            }}
            className="group flex min-w-0 max-w-[240px] cursor-pointer items-center gap-2 rounded-t px-3 text-xs"
            style={{
              background: active ? token.colorBgContainer : "transparent",
              borderBottom: active ? `2px solid ${token.colorPrimary}` : "2px solid transparent",
              color: active ? token.colorText : token.colorTextSecondary,
            }}
            title={session.path}
          >
            <span className="shrink-0 text-[10px]" style={{ color: token.colorTextTertiary }}>
              {FORMAT_LABEL[session.format]}
            </span>
            <span className="truncate">{session.name}</span>
            {session.dirty && (
              <Tooltip title="未保存">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: token.colorWarning }}
                />
              </Tooltip>
            )}
            <button
              type="button"
              aria-label={`关闭 ${session.name}`}
              className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onClose(session.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
