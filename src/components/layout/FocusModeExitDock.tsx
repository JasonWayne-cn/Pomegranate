import { Minimize2 } from "lucide-react";

interface Props {
  onExit: () => void;
}

/**
 * 专注模式退出胶囊。
 *
 * 专注模式会隐藏活动栏 / 侧栏 / 顶栏，编辑器工具栏上的按钮是唯一可见入口。
 * 但在标签栏切走文档、从历史栈进入其它页面等情况下，用户身边没有任何「退出」
 * 按钮，只能靠猜快捷键（Esc / F11），体感像卡死。这里在窗口右下角常驻一枚
 * 低干扰胶囊：默认 72% 不透明度，悬停变实，点它或按 Esc 都能退出。
 *
 * 位置避开编辑页底部的 30px 链接状态栏（bottom: 44px），也避开右下角
 * 无其它常驻浮层（任务页多选条是居中且仅任务页出现）。
 */
export function FocusModeExitDock({ onExit }: Props) {
  return (
    <button
      type="button"
      className="focus-mode-dock"
      onClick={onExit}
      title="退出专注模式 (Esc)"
      aria-label="退出专注模式"
    >
      <Minimize2 size={14} />
      <span>专注模式 · Esc 退出</span>
    </button>
  );
}
