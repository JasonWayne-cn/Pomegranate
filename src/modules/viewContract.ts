import type { ReactNode } from "react";

/** 视图来源：内置 / JS 插件 / 扩展包 */
export type ModuleViewSource = "builtin" | "plugin" | "extension";

/** 视图布局：标准（带标题栏、可滚动） / 全屏（页面自理） */
export type ModuleViewLayout = "standard" | "fullscreen";

/**
 * 模块视图统一元数据。
 *
 * 方案 3：插件与扩展共用同一份视图契约和容器，
 * 但渲染方式保持各自独立（插件自渲染 DOM，扩展由宿主 React 渲染）。
 */
export interface ModuleViewMeta {
  id: string;
  title: string;
  source: ModuleViewSource;
  /** 来源显示名，例如“插件”“扩展包”；为空时按 source 生成 */
  sourceLabel?: string;
  icon?: ReactNode;
  layout?: ModuleViewLayout;
  /** 插件视图对应的插件 ID，便于在容器中标注来源 */
  pluginId?: string;
}
