/**
 * Viewer3DNode 的 React NodeView。
 *
 * 编辑器里只渲染轻量卡片；真正的三维引擎在全局附件预览 Modal 中按需加载。
 */
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Button, Tooltip, message, theme as antdTheme } from "antd";
import { Box, Eye, Trash2 } from "lucide-react";
import { parseKbAsset } from "@/lib/assetUrl";
import {
  formatBytes,
  viewer3dExtOf,
  viewer3dFileName,
} from "@/lib/viewer3d";
import { useAttachmentPreviewStore } from "@/store/attachmentPreview";
import { useEditorEditable } from "./useEditorEditable";

export function Viewer3DNodeView({
  node,
  editor,
  deleteNode,
}: NodeViewProps) {
  const { token } = antdTheme.useToken();
  const src: string = (node.attrs.src as string | null) ?? "";
  const rawName: string = (node.attrs.name as string | null) ?? "";
  const size: number = Number(node.attrs.size) || 0;
  const isEditable = useEditorEditable(editor);

  const rel = parseKbAsset(src);
  const displayName = rawName || (rel ? viewer3dFileName(rel) : "三维模型");
  const ext = rel ? viewer3dExtOf(rel) : "";

  function openPreview() {
    if (!rel) {
      message.error("模型路径无效，请重新插入");
      return;
    }
    useAttachmentPreviewStore.getState().open({
      rel,
      fileName: displayName,
      preview: "viewer3d",
    });
  }

  function stopMouseDown(e: React.MouseEvent) {
    e.stopPropagation();
  }

  return (
    <NodeViewWrapper
      className="tiptap-viewer3d-block"
      data-viewer3d-src={src}
      onDoubleClick={openPreview}
    >
      <div
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 my-3"
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillQuaternary,
        }}
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
          style={{
            background: token.colorFillSecondary,
            color: token.colorPrimary,
          }}
        >
          <Box size={18} />
        </div>

        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-medium"
            style={{ color: token.colorText }}
            title={displayName}
          >
            {displayName}
          </div>
          <div
            className="mt-0.5 flex items-center gap-2 text-xs"
            style={{ color: token.colorTextSecondary }}
          >
            {ext && (
              <span
                className="rounded px-1.5 py-0.5"
                style={{ background: token.colorFillSecondary }}
              >
                {ext.toUpperCase()}
              </span>
            )}
            <span>三维模型</span>
            {size > 0 && <span>{formatBytes(size)}</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1" onMouseDown={stopMouseDown}>
          <Tooltip title="打开三维预览">
            <Button
              size="small"
              type="primary"
              icon={<Eye size={14} />}
              onClick={openPreview}
            >
              预览
            </Button>
          </Tooltip>
          {isEditable && (
            <Tooltip title="移除三维模型">
              <Button
                size="small"
                type="text"
                danger
                icon={<Trash2 size={14} />}
                onClick={() => deleteNode()}
              />
            </Tooltip>
          )}
        </div>
      </div>
    </NodeViewWrapper>
  );
}
