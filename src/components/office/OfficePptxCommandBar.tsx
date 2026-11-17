/** PPTX 命令栏（Phase 1）：幻灯片增删、复制、排序。 */
import { Button, Space, Tooltip, theme as antdTheme } from "antd";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import { moveTarget } from "@/lib/office/editor/slideActions";

interface OfficePptxCommandBarProps {
  pageCount: number;
  activeSlide: number;
  busy: boolean;
  onInsert: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (to: number) => void;
}

export function OfficePptxCommandBar({
  pageCount,
  activeSlide,
  busy,
  onInsert,
  onDuplicate,
  onDelete,
  onMove,
}: OfficePptxCommandBarProps) {
  const { token } = antdTheme.useToken();
  const prev = moveTarget(activeSlide, pageCount, -1);
  const next = moveTarget(activeSlide, pageCount, 1);

  return (
    <div
      className="flex h-10 shrink-0 items-center gap-2 px-3"
      style={{
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Space size={4} wrap>
        <Tooltip title="新建幻灯片 (Ctrl+M)">
          <Button size="small" icon={<Plus size={14} />} disabled={busy} onClick={onInsert}>
            新建
          </Button>
        </Tooltip>
        <Tooltip title="复制当前页 (Ctrl+Shift+D)">
          <Button size="small" icon={<Copy size={14} />} disabled={busy} onClick={onDuplicate}>
            复制
          </Button>
        </Tooltip>
        <Tooltip title={pageCount <= 1 ? "至少保留一页" : "删除当前页"}>
          <Button
            size="small"
            danger
            icon={<Trash2 size={14} />}
            disabled={busy || pageCount <= 1}
            onClick={onDelete}
          >
            删除
          </Button>
        </Tooltip>
        <Tooltip title="上移当前页 (Alt+↑)">
          <Button
            size="small"
            icon={<ArrowUp size={14} />}
            disabled={busy || prev == null}
            onClick={() => prev != null && onMove(prev)}
          />
        </Tooltip>
        <Tooltip title="下移当前页 (Alt+↓)">
          <Button
            size="small"
            icon={<ArrowDown size={14} />}
            disabled={busy || next == null}
            onClick={() => next != null && onMove(next)}
          />
        </Tooltip>
      </Space>
      <div className="flex-1" />
      <span className="text-[11px]" style={{ color: token.colorTextTertiary }}>
        Tab 切换元素 · 方向键微移 · Ctrl+Z 撤销 · Ctrl+S 保存
      </span>
    </div>
  );
}
