import { lazy, Suspense } from "react";
import { Skeleton } from "antd";
import { useAppStore } from "@/store";
import { DocSectionTabs } from "./DocSectionTabs";

const NotesPanel = lazy(() =>
  import("./NotesPanel").then((m) => ({ default: m.NotesPanel })),
);
const TagsPanel = lazy(() =>
  import("./TagsPanel").then((m) => ({ default: m.TagsPanel })),
);

/**
 * NotesTagsPanel —— 文档面板的「文件夹 / 标签」双视图外壳。
 *
 * 用户反馈：标签和文档本来就是同一批内容的两种组织方式，却要在 Activity Bar
 * 上来回切两个图标；希望在文档面板顶部用标签页切换，右侧列表区不变。
 *
 * **刻意不合并两个面板的内部实现**：NotesPanel(2686 行) 和 TagsPanel(817 行)
 * 各自带着虚拟滚动、右键菜单、拖拽、inline 重命名，且结构同构（标题栏 → 搜索 → 树）。
 * 与其抽公共树组件重写（回归风险高、收益仅是少几百行），不如加这层薄壳按需渲染 ——
 * 两个面板一行不动，交互零变化。
 *
 * 顶部的「文件夹 | 标签」分段控件与隐藏文档面板共用（见 DocSectionTabs）。
 * 两个子面板都是 lazy 的：只切到哪个才加载哪个，首屏不为没看的那个买单。
 */
export function NotesTagsPanel() {
  const tab = useAppStore((s) => s.notesPanelTab);

  return (
    <div className="flex flex-col h-full" style={{ overflow: "hidden" }}>
      <DocSectionTabs scope="doc" />

      <div className="flex-1 min-h-0">
        <Suspense
          fallback={
            <div style={{ padding: "10px 12px" }}>
              <Skeleton active paragraph={{ rows: 5 }} title={false} />
            </div>
          }
        >
          {tab === "tags" ? <TagsPanel /> : <NotesPanel />}
        </Suspense>
      </div>
    </div>
  );
}
