import type { ReactNode } from "react";
import { MSheet } from "./MSheet";

/**
 * 移动端底部动作面板（Bottom Action Sheet）。
 *
 * 取代桌面端坐标锚定的右键 Dropdown（`useContextMenu` + `ContextMenuOverlay`）——
 * 触屏场景下：从底部滑出、大点击热区（≥56px）、适配安全区、点遮罩关闭。
 * 配合 `@/hooks/useLongPress`：长按列表项 → 打开本面板承载该项的操作。
 *
 * 实现已收口到通用 `MSheet`（动画/安全区/键盘/下滑关闭一处维护）。
 */
export interface ActionSheetItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** 危险操作（删除等）红色高亮 */
  danger?: boolean;
  onClick: () => void;
}

interface ActionSheetProps {
  open: boolean;
  /** 面板顶部说明（如文档标题），可选 */
  title?: string;
  items: ActionSheetItem[];
  onClose: () => void;
}

export function ActionSheet({ open, title, items, onClose }: ActionSheetProps) {
  return (
    <MSheet open={open} title={title} onClose={onClose}>
      <div className="py-1">
        {items.map((it) => (
          <button
            key={it.key}
            onClick={() => {
              it.onClick();
              onClose();
            }}
            className="flex w-full items-center gap-3 px-5 text-left active:bg-[var(--m-well)]"
            style={{
              minHeight: 56,
              color: it.danger ? "var(--m-danger)" : "var(--m-ink-1)",
            }}
          >
            {it.icon && <span className="shrink-0">{it.icon}</span>}
            <span className="text-base">{it.label}</span>
          </button>
        ))}
      </div>

      {/* 取消 —— 与操作区用粗分隔条隔开 */}
      <div className="mt-1 border-t-[6px] border-[var(--m-well)]">
        <button
          onClick={onClose}
          className="w-full text-base font-medium text-[var(--m-ink-2)] active:bg-[var(--m-well)]"
          style={{ minHeight: 56 }}
        >
          取消
        </button>
      </div>
    </MSheet>
  );
}
