/** DOCX 预览与内联段落编辑（Phase 3）。 */
import { useEffect, useRef, useState } from "react";
import { theme as antdTheme } from "antd";

interface DocxPageViewProps {
  html: string;
  zoom: number;
  busy?: boolean;
  /** 模型中的纯文本（不含列表项目符号等展示装饰） */
  blocks?: Array<{ blockIndex: number; text: string }>;
  onCommit: (blockIndex: number, text: string) => void;
}

interface EditingState {
  blockIndex: number;
  original: string;
  value: string;
  rect: { left: number; top: number; width: number; height: number };
}

export function DocxPageView({ html, zoom, busy, blocks, onCommit }: DocxPageViewProps) {
  const { token } = antdTheme.useToken();
  const [editing, setEditing] = useState<EditingState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  function handleDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (busy) return;
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-block-index]");
    if (!element) return;
    const blockIndex = Number(element.dataset.blockIndex);
    if (!Number.isFinite(blockIndex)) return;
    const rect = element.getBoundingClientRect();
    cancelledRef.current = false;
    const modelText = blocks?.find((block) => block.blockIndex === blockIndex)?.text;
    const initial = modelText ?? element.textContent ?? "";
    setEditing({
      blockIndex,
      original: initial,
      value: initial,
      rect: {
        left: rect.left,
        top: rect.top,
        width: Math.max(160, rect.width),
        height: Math.max(36, rect.height),
      },
    });
  }

  function commit() {
    if (!editing || cancelledRef.current) {
      setEditing(null);
      return;
    }
    const next = editing.value;
    const changed = next !== editing.original;
    setEditing(null);
    if (changed) onCommit(editing.blockIndex, next);
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-gray-100 p-4">
      <div style={{ zoom: zoom / 100 }}>
        <div
          onDoubleClick={handleDoubleClick}
          className="cursor-text"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      {editing && (
        <textarea
          ref={textareaRef}
          className="fixed z-50 m-0 resize-none rounded border-2 p-1 outline-none"
          style={{
            left: editing.rect.left,
            top: editing.rect.top,
            width: editing.rect.width,
            height: editing.rect.height,
            minHeight: 36,
            background: token.colorBgContainer,
            borderColor: token.colorPrimary,
            font: "inherit",
          }}
          value={editing.value}
          onChange={(event) => setEditing({ ...editing, value: event.target.value })}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              cancelledRef.current = true;
              setEditing(null);
            } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit();
            }
          }}
        />
      )}
    </div>
  );
}
