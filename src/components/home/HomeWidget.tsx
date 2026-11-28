import { type CSSProperties, type ReactNode } from "react";
import { Card, Select, Tooltip, type CardProps } from "antd";
import { GripVertical, ChevronDown, ChevronRight } from "lucide-react";
import type { WidgetSize, WidgetHeight } from "@/store/homeLayout";
import { HideableCard } from "./HideableCard";
import type { HomeWidgetKey } from "@/store/homeWidgets";

/**
 * 首页 widget id → 隐私设置里的卡片 key。
 * 未列出的 widget（快速记一笔 / 写作活力）不参与遮盖。
 */
const BLUR_KEY_BY_WIDGET: Record<string, HomeWidgetKey> = {
  todo: "todo",
  recent: "recentNotes",
  pinned: "pinned",
  ai: "askAi",
};

export interface HomeWidgetProps {
  id: string;
  title: ReactNode;
  icon?: ReactNode;
  /** 卡片外层 className（用于首页样式定制） */
  className?: string;
  /** 卡片 body 样式覆盖（默认由 antd Card 决定） */
  bodyStyle?: CSSProperties;
  collapsed: boolean;
  onToggle: () => void;
  /** 拖拽手柄 props（由 dnd-kit useSortable 注入） */
  dragHandleProps?: Record<string, unknown>;
  /** antd Card 底部额外元素 */
  extra?: ReactNode;
  /** 当前宽度档位 */
  colSpan?: WidgetSize;
  /** 当前高度档位 */
  heightLevel?: WidgetHeight;
  /** 宽度切换回调 */
  onColSpanChange?: (size: WidgetSize) => void;
  /** 高度切换回调 */
  onHeightChange?: (h: WidgetHeight) => void;
  children: ReactNode;
}

/**
 * 首页可折叠 + 可拖拽 + 可调宽高的 Widget 容器。
 */
export function HomeWidget({
  id,
  title,
  icon,
  className,
  bodyStyle,
  collapsed,
  onToggle,
  dragHandleProps,
  extra,
  colSpan,
  heightLevel,
  onColSpanChange,
  onHeightChange,
  children,
}: HomeWidgetProps) {
  const blurKey = BLUR_KEY_BY_WIDGET[id];

  const cardProps: CardProps = {
    size: "small",
    className,
    style: { height: "100%", display: "flex", flexDirection: "column" },
    styles: {
      body: {
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        ...bodyStyle,
        ...(collapsed ? { padding: 0 } : {}),
      },
    },
    title: (
      <div
        className="flex items-center gap-2 cursor-grab active:cursor-grabbing select-none flex-1 min-w-0"
        {...dragHandleProps}
      >
        <GripVertical size={14} className="text-gray-400 shrink-0" />
        {icon}
        <span style={{ fontSize: 13, fontWeight: 600, userSelect: "none", minWidth: 0, flex: 1 }}>
          {title}
        </span>
      </div>
    ),
    extra: (
        <div className="flex items-center gap-2">
          {extra}
          {/* 宽度下拉：阻止 mousedown 冒泡，避免误触 dnd-kit 拖拽 */}
          {onColSpanChange && colSpan && (
            <Tooltip title="宽度" mouseEnterDelay={0.4}>
              <span onMouseDown={(e) => e.stopPropagation()}>
                <Select
                  size="small"
                  value={colSpan}
                  onChange={(v) => onColSpanChange(v as WidgetSize)}
                  style={{ width: 78 }}
                  options={[
                    { label: "1/3", value: "sm" },
                    { label: "1/2", value: "md" },
                    { label: "2/3", value: "lg" },
                    { label: "满", value: "xl" },
                  ]}
                />
              </span>
            </Tooltip>
          )}
          {/* 高度下拉：阻止 mousedown 冒泡，避免误触 dnd-kit 拖拽 */}
          {onHeightChange && heightLevel && (
            <Tooltip title="高度（跨行数）" mouseEnterDelay={0.4}>
              <span onMouseDown={(e) => e.stopPropagation()}>
                <Select
                  size="small"
                  value={heightLevel}
                  onChange={(v) => onHeightChange(v as WidgetHeight)}
                  style={{ width: 86 }}
                  options={[
                    { label: "矮 · 1行", value: "compact" },
                    { label: "中 · 2行", value: "normal" },
                    { label: "高 · 3行", value: "tall" },
                  ]}
                />
              </span>
            </Tooltip>
          )}
          {/* 折叠/展开 */}
          <button
            type="button"
            className="flex items-center justify-center w-6 h-6 rounded hover:bg-black/5 dark:hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-label={collapsed ? "展开" : "折叠"}
          >
            {collapsed ? (
              <ChevronRight size={14} className="text-gray-400" />
            ) : (
              <ChevronDown size={14} className="text-gray-400" />
            )}
          </button>
        </div>
    ),
  };

  // 参与隐私遮盖的卡片走 HideableCard（右上角多一个眼睛按钮）；
  // 其余卡片保持原来的普通 Card。
  return blurKey ? (
    <HideableCard widgetKey={blurKey} {...cardProps}>
      {!collapsed && children}
    </HideableCard>
  ) : (
    <Card {...cardProps}>{!collapsed && children}</Card>
  );
}
