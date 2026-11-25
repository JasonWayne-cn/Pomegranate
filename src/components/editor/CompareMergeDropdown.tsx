/**
 * 编辑器工具栏「对比 / 合并」下拉按钮。
 *
 * 把原来的两个独立按钮（与剪贴板对比、与其它文档对比）收进一个 Dropdown，
 * 减少工具栏占用。具体弹窗逻辑仍由 CompareClipboardButton / CompareNotesButton
 * 各自持有，这里通过 ref 触发它们的 open()，并以 showTrigger={false} 隐藏原按钮。
 */
import { useRef } from "react";
import { Button, Dropdown, Tooltip } from "antd";
import { ChevronDown, Diff, FileDiff } from "lucide-react";
import type { Editor } from "@tiptap/react";
import {
  CompareClipboardButton,
  type CompareTriggerHandle,
} from "./CompareClipboardButton";
import { CompareNotesButton } from "./CompareNotesButton";

interface Props {
  editor: Editor;
  /** 当前文档 id；用于「与其它文档对比」排除自身 */
  noteId?: number;
}

export function CompareMergeDropdown({ editor, noteId }: Props) {
  const clipboardRef = useRef<CompareTriggerHandle>(null);
  const notesRef = useRef<CompareTriggerHandle>(null);

  return (
    <>
      <Tooltip title="对比 / 合并" mouseEnterDelay={0.5}>
        <Dropdown
          trigger={["click"]}
          placement="bottomLeft"
          menu={{
            items: [
              {
                key: "clipboard",
                icon: <Diff size={14} />,
                label: "与剪贴板对比 / 合并",
                onClick: () => clipboardRef.current?.open(),
              },
              {
                key: "notes",
                icon: <FileDiff size={14} />,
                label: "与其它文档对比 / 合并",
                onClick: () => notesRef.current?.open(),
              },
            ],
          }}
        >
          <Button
            type="text"
            size="small"
            style={{ minWidth: 40, height: 26, padding: "0 4px" }}
          >
            <span className="inline-flex items-center gap-0.5">
              <Diff size={15} />
              <ChevronDown size={11} style={{ opacity: 0.6 }} />
            </span>
          </Button>
        </Dropdown>
      </Tooltip>

      <CompareClipboardButton
        ref={clipboardRef}
        editor={editor}
        showTrigger={false}
      />
      <CompareNotesButton
        ref={notesRef}
        editor={editor}
        noteId={noteId}
        showTrigger={false}
      />
    </>
  );
}
