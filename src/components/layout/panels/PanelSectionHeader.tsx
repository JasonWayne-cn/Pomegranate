import type { ReactNode } from "react";
import { theme as antdTheme } from "antd";

/** 面板顶栏统一高度：文档（文件夹/标签）与隐藏文档共用，切换时高度不跳动 */
export const PANEL_SECTION_HEADER_HEIGHT = 44;

/**
 * 侧栏面板顶部栏的统一容器。
 *
 * 之前「文档」用 Segmented 顶栏、「隐藏文档」用自己的标题栏，二者内边距不同，
 * 在两个视图之间切换时下面的内容区会上下跳一下。收口到固定高度的同一个容器，
 * 内容各自往里塞即可。
 */
export function PanelSectionHeader({ children }: { children: ReactNode }) {
  const { token } = antdTheme.useToken();
  return (
    <div
      className="shrink-0"
      style={{
        height: PANEL_SECTION_HEADER_HEIGHT,
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {children}
    </div>
  );
}
