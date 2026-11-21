/**
 * 编辑器工具栏「与剪贴板对比」按钮。
 *
 * 难点：剪贴板里通常是**渲染后/纯文本**（你从别处复制的），而文档侧本身是 **markdown 源码**，两边粒度不一样
 * 几乎每行都判成差异。处理：打开时先猜剪贴板像不像 markdown，决定文档侧给"markdown 源码"还是"纯文本"；
 * 标题栏放一个「Markdown 源码 / 纯文本」切换，猜错了用户能手动切（切换会重建对比视图，靠 key）。
 *
 *  - markdown 模式：左=剪贴板（只读），右=文档 markdown 源码（可编辑，可逐块合并，「保存」用 markdown 重渲染文档）
 *  - 纯文本模式：  左=剪贴板（只读），右=文档可见纯文本（只读）—— 纯对比，不提供保存（纯文本塞回富文本文档会丢格式）
 *
 * 纯前端：剪贴板走 `@tauri-apps/plugin-clipboard-manager`（权限 `clipboard-manager:allow-read-text` 已声明）。
 */
import { useState } from "react";
import { Button, Segmented, Tooltip, message } from "antd";
import { Diff } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { DiffMergeModal, type DiffSide } from "./DiffMergeModal";
import { getNoteMarkdown, getNotePlainText, looksLikeMarkdown } from "./markdownDiffUtil";

interface Props {
  editor: Editor;
}

type Mode = "markdown" | "plain";

export function CompareClipboardButton({ editor }: Props) {
  const [open, setOpen] = useState(false);
  const [clip, setClip] = useState("");
  const [mode, setMode] = useState<Mode>("markdown");

  async function handleOpen() {
    let text = "";
    try {
      text = (await readText()) ?? "";
    } catch {
      text = "";
    }
    setClip(text);
    // 剪贴板像 markdown → 文档侧给源码（可合并）；否则给纯文本（纯对比）
    setMode(looksLikeMarkdown(text) ? "markdown" : "plain");
    setOpen(true);
  }

  const left: DiffSide = { label: "剪贴板", value: clip, editable: false };
  const right: DiffSide =
    mode === "markdown"
      ? { label: "当前文档 (markdown 源码)", value: getNoteMarkdown(editor), editable: true }
      : { label: "当前文档 (纯文本)", value: getNotePlainText(editor), editable: false };

  return (
    <>
      <Tooltip title="与剪贴板对比 / 合并（左=剪贴板，右=当前文档）" mouseEnterDelay={0.5}>
        <Button type="text" size="small" icon={<Diff size={15} />} onClick={handleOpen} />
      </Tooltip>
      {open && (
        <DiffMergeModal
          open={open}
          onClose={() => setOpen(false)}
          left={left}
          right={right}
          headerExtra={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span>文档侧</span>
              <Segmented
                size="small"
                value={mode}
                onChange={(v) => setMode(v as Mode)}
                options={[
                  { label: "Markdown 源码", value: "markdown" },
                  { label: "纯文本", value: "plain" },
                ]}
              />
            </span>
          }
          saveHint={
            mode === "markdown"
              ? "保存会用 markdown 重新生成整篇文档，表格 / 批注 / 嵌入 / 折叠等自定义块可能不完全保留。"
              : undefined
          }
          onSave={
            mode === "markdown"
              ? ({ right: newMd }) => {
                  // tiptap-markdown 让 setContent 接受 markdown 字符串
                  editor.commands.setContent(newMd, { emitUpdate: true });
                  message.success("已用合并结果更新文档内容");
                }
              : undefined
          }
        />
      )}
    </>
  );
}
