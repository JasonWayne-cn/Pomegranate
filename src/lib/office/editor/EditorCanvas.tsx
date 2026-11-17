/**
 * 轻量画布编辑器（SVG + DOM 叠加层）。
 *
 * - SVG 由 Worker 渲染，带 `data-office-id`，拖动时临时隐藏原节点
 * - 命中测试基于 RenderSlide 的节点几何，不解析 SVG
 * - 拖动/缩放只在本地做轮廓预览，松手提交 `setTransform`
 * - 双击文本节点进入内联文本编辑，提交 `setText`
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RenderSlide } from "@genoffice/pptx-render";
import {
  collectEditableNodes,
  handlePoints,
  hitTest,
  moveBox,
  resizeBox,
  scaleBox,
  type Box,
  type EditorNode,
  type ResizeHandle,
} from "./geometry";

interface EditorCanvasProps {
  scene: RenderSlide;
  svg: string;
  selectedId: string | null;
  onSelect: (node: EditorNode | null) => void;
  onCommitTransform: (node: EditorNode, box: Box) => void;
  onCommitText: (node: EditorNode, text: string) => void;
  busy?: boolean;
}

type DragState =
  | {
      kind: "move";
      node: EditorNode;
      startX: number;
      startY: number;
      dx: number;
      dy: number;
      active: boolean;
    }
  | {
      kind: "resize";
      node: EditorNode;
      handle: ResizeHandle;
      startX: number;
      startY: number;
      dx: number;
      dy: number;
      active: boolean;
    };

interface EditingState {
  node: EditorNode;
  value: string;
  cancelled: boolean;
}

const HANDLE_SIZE = 8;

function setNodeHidden(host: HTMLElement | null, id: string, hidden: boolean): void {
  if (!host) return;
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&");
  // 只匹配直接子节点：顶层节点包在 <svg> 下，组内子节点不参与选择。
  const el = host.querySelector<SVGElement>(`svg > g[data-office-id="${escaped}"]`);
  el?.style.setProperty("opacity", hidden ? "0.15" : "");
}

export function EditorCanvas({
  scene,
  svg,
  selectedId,
  onSelect,
  onCommitTransform,
  onCommitText,
  busy,
}: EditorCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgHostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const nodes = useMemo(() => collectEditableNodes(scene), [scene]);
  const selected = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const scale = width > 0 ? width / scene.widthPx : 1;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  function pointFromEvent(event: React.PointerEvent | React.MouseEvent): { x: number; y: number } {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  }

  function beginDrag(event: React.PointerEvent) {
    if (busy || editing || event.button !== 0) return;
    const { x, y } = pointFromEvent(event);
    const node = hitTest(nodes, x, y);
    if (!node) {
      onSelect(null);
      return;
    }
    onSelect(node);
    if (node.background) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      kind: "move",
      node,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      active: false,
    });
  }

  function beginResize(event: React.PointerEvent, handle: ResizeHandle) {
    event.stopPropagation();
    if (busy || !selected || selected.rotationDeg !== 0) return;
    containerRef.current?.setPointerCapture(event.pointerId);
    setDrag({
      kind: "resize",
      node: selected,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      active: false,
    });
  }

  function handlePointerMove(event: React.PointerEvent) {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    const active = drag.active || Math.abs(dx) > 2 / scale || Math.abs(dy) > 2 / scale;
    if (active && !drag.active) setNodeHidden(svgHostRef.current, drag.node.id, true);
    setDrag({ ...drag, dx, dy, active });
  }

  function handlePointerUp() {
    if (!drag) return;
    setNodeHidden(svgHostRef.current, drag.node.id, false);
    if (drag.active) {
      const box =
        drag.kind === "move"
          ? moveBox(drag.node.box, drag.dx, drag.dy)
          : resizeBox(drag.node.box, drag.handle, drag.dx, drag.dy);
      onCommitTransform(drag.node, box);
    }
    setDrag(null);
  }

  function handleDoubleClick(event: React.MouseEvent) {
    if (busy) return;
    const { x, y } = pointFromEvent(event);
    const node = hitTest(nodes, x, y);
    if (!node?.text) return;
    onSelect(node);
    setEditing({ node, value: node.text, cancelled: false });
  }

  function commitText() {
    if (!editing || editing.cancelled) return;
    if (editing.value !== editing.node.text) {
      onCommitText(editing.node, editing.value);
    }
    setEditing(null);
  }

  const previewBox: Box | null = drag
    ? drag.kind === "move"
      ? moveBox(drag.node.box, drag.dx, drag.dy)
      : resizeBox(drag.node.box, drag.handle, drag.dx, drag.dy)
    : null;

  const outline = selected
    ? scaleBox(previewBox ?? selected.box, scale)
    : null;

  return (
    <div
      ref={containerRef}
      className="relative w-full select-none bg-white shadow-sm"
      style={{ aspectRatio: `${scene.widthPx} / ${scene.heightPx}`, cursor: busy ? "wait" : "default" }}
      onPointerDown={beginDrag}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      <div
        ref={svgHostRef}
        className="pointer-events-none absolute inset-0 [&>svg]:h-full [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />

      {outline && !editing && (
        <div
          className="pointer-events-none absolute border-2 border-blue-500"
          style={{
            left: outline.x,
            top: outline.y,
            width: outline.w,
            height: outline.h,
            transform: selected && selected.rotationDeg ? `rotate(${selected.rotationDeg}deg)` : undefined,
            transformOrigin: "center",
          }}
        >
          {!drag && selected && selected.rotationDeg === 0 && !selected.background && (
            <>
              {handlePoints(outline).map((point) => (
                <div
                  key={point.handle}
                  className="pointer-events-auto absolute rounded-sm border border-white bg-blue-500"
                  style={{
                    left: point.x - outline.x - HANDLE_SIZE / 2,
                    top: point.y - outline.y - HANDLE_SIZE / 2,
                    width: HANDLE_SIZE,
                    height: HANDLE_SIZE,
                    cursor: handleCursor(point.handle),
                  }}
                  onPointerDown={(event) => beginResize(event, point.handle)}
                />
              ))}
            </>
          )}
        </div>
      )}

      {editing && (
        <textarea
          ref={textareaRef}
          className="absolute m-0 resize-none border-2 border-blue-500 bg-white/95 p-1 outline-none"
          style={{
            left: editing.node.box.x * scale,
            top: editing.node.box.y * scale,
            width: Math.max(120, editing.node.box.w * scale),
            minHeight: Math.max(40, editing.node.box.h * scale),
            fontSize: Math.max(12, 16 * scale),
            lineHeight: 1.4,
          }}
          value={editing.value}
          onChange={(event) => setEditing({ ...editing, value: event.target.value })}
          onBlur={commitText}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setEditing(null);
            } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commitText();
            }
          }}
        />
      )}
    </div>
  );
}

function handleCursor(handle: ResizeHandle): string {
  if (handle === "n" || handle === "s") return "ns-resize";
  if (handle === "e" || handle === "w") return "ew-resize";
  if (handle === "nw" || handle === "se") return "nwse-resize";
  return "nesw-resize";
}
