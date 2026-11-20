/** 工作台状态栏：页码、缩放、保存状态。 */
import { Slider, theme as antdTheme, Tooltip } from "antd";
import { Minus, Plus } from "lucide-react";
import { FORMAT_LABEL } from "@/lib/office/formats";
import type { OfficeSessionMeta } from "@/store/office";

interface OfficeStatusBarProps {
  session: OfficeSessionMeta | null;
  activeSlide: number;
  zoom: number;
  onZoom: (next: number) => void;
  busy?: boolean;
}

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

export function OfficeStatusBar({
  session,
  activeSlide,
  zoom,
  onZoom,
  busy,
}: OfficeStatusBarProps) {
  const { token } = antdTheme.useToken();
  if (!session) return null;

  const pageText =
    session.pageCount && session.pageCount > 0
      ? `${Math.min(activeSlide + 1, session.pageCount)} / ${session.pageCount}`
      : null;

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-3 px-3 text-[11px]"
      style={{
        background: token.colorBgContainer,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        color: token.colorTextSecondary,
      }}
    >
      <span>{FORMAT_LABEL[session.format]}</span>
      {pageText && <span>第 {pageText} 页</span>}
      {session.status === "error" && (
        <span style={{ color: token.colorError }}>打开失败</span>
      )}
      {busy && <span>处理中…</span>}

      <div className="flex-1" />

      <Tooltip title="缩小">
        <button
          type="button"
          aria-label="缩小"
          className="rounded p-0.5 hover:bg-black/10 disabled:opacity-40"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => onZoom(Math.max(ZOOM_MIN, zoom - ZOOM_STEP))}
        >
          <Minus size={12} />
        </button>
      </Tooltip>
      <button
        type="button"
        className="min-w-[48px] rounded px-1 tabular-nums hover:bg-black/10"
        onClick={() => onZoom(100)}
        title="重置为 100%"
      >
        {zoom}%
      </button>
      <Tooltip title="放大">
        <button
          type="button"
          aria-label="放大"
          className="rounded p-0.5 hover:bg-black/10 disabled:opacity-40"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => onZoom(Math.min(ZOOM_MAX, zoom + ZOOM_STEP))}
        >
          <Plus size={12} />
        </button>
      </Tooltip>
      <Slider
        className="!m-0"
        style={{ width: 120 }}
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={zoom}
        tooltip={{ formatter: (v) => `${v}%` }}
        onChange={(value) => onZoom(value)}
      />
    </div>
  );
}
