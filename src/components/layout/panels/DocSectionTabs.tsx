import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Segmented } from "antd";
import { FolderTree, Tags as TagsIcon } from "lucide-react";
import { useAppStore } from "@/store";
import { PanelSectionHeader } from "./PanelSectionHeader";

type SectionTab = "folders" | "tags";

/**
 * 「文件夹 | 标签」分段控件。
 *
 * 文档面板与隐藏文档面板共用同一条顶栏，保证两页切换时高度与视觉一致。
 * - scope="doc"：只切换 store 里的文档面板页签；
 * - scope="hidden"：切换页签的同时离开隐藏文档，回到对应的文档视图
 *   （文件夹 → /notes，标签 → /tags）。
 */
export function DocSectionTabs({ scope }: { scope: "doc" | "hidden" }) {
  const navigate = useNavigate();
  const tab = useAppStore((s) => s.notesPanelTab);
  const setTab = useAppStore((s) => s.setNotesPanelTab);
  const activeView = useAppStore((s) => s.activeView);

  // 文档面板：从 ActivityBar「文档 / 标签」进入时对齐页签
  useEffect(() => {
    if (scope !== "doc") return;
    if (activeView === "tags") setTab("tags");
    else if (activeView === "notes") setTab("folders");
  }, [scope, activeView, setTab]);

  // 隐藏文档属于「文件夹」体系，固定显示文件夹选中
  const value: SectionTab = scope === "hidden" ? "folders" : tab;

  function handleChange(next: SectionTab) {
    setTab(next);
    if (scope === "hidden") {
      navigate(next === "tags" ? "/tags" : "/notes");
    }
  }

  return (
    <PanelSectionHeader>
      <Segmented
        block
        size="small"
        value={value}
        onChange={(v) => handleChange(v as SectionTab)}
        style={{ flex: 1, minWidth: 0 }}
        options={[
          {
            value: "folders",
            label: (
              <span className="inline-flex items-center gap-1">
                <FolderTree size={13} />
                文件夹
              </span>
            ),
          },
          {
            value: "tags",
            label: (
              <span className="inline-flex items-center gap-1">
                <TagsIcon size={13} />
                标签
              </span>
            ),
          },
        ]}
      />
    </PanelSectionHeader>
  );
}
