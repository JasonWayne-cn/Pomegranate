/**
 * PPTX 编辑会话 Hook：把 Worker RPC 收窄成页面需要的状态机。
 * 场景（RenderSlide）由 Worker 持有，这里只缓存当前页。
 */
import { useCallback, useRef, useState, type RefObject } from "react";
import type { PptxWorkerClient } from "@/lib/office/pptxWorkerClient";
import type {
  PptxEditOp,
  PptxSceneResult,
  PptxSlideAction,
} from "@/lib/office/editor/protocol";
import type { Box, EditorNode } from "@/lib/office/editor/geometry";

interface Options {
  clientRef: RefObject<PptxWorkerClient | null>;
  onThumbnail: (slide: number, svg: string) => void;
  onError: (error: unknown) => void;
  /** 文档发生可撤销的变更后回调（用于标记 dirty）。 */
  onApplied?: (result: PptxSceneResult) => void;
  /** 结构变更后返回了全部缩略图时的回调。 */
  onDeck?: (result: PptxSceneResult) => void;
}

export function usePptxEditor({ clientRef, onThumbnail, onError, onApplied, onDeck }: Options) {
  const [scene, setScene] = useState<PptxSceneResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sceneRef = useRef<PptxSceneResult | null>(null);

  const apply = useCallback(
    async (
      action: (client: PptxWorkerClient) => Promise<PptxSceneResult>,
      options: { clearSelection?: boolean; applied?: boolean } = {},
    ) => {
      const client = clientRef.current;
      if (!client) return;
      setBusy(true);
      try {
        const result = await action(client);
        sceneRef.current = result;
        setScene(result);
        onThumbnail(result.slide, result.svg);
        if (result.slides?.length) onDeck?.(result);
        if (options.clearSelection) setSelectedId(null);
        if (options.applied) onApplied?.(result);
      } catch (error) {
        onError(error);
      } finally {
        setBusy(false);
      }
    },
    [clientRef, onThumbnail, onError, onApplied, onDeck],
  );

  const openSlide = useCallback(
    (index: number) => apply((client) => client.getScene(index), { clearSelection: true }),
    [apply],
  );

  const applyEdit = useCallback(
    (edit: PptxEditOp) => {
      const index = sceneRef.current?.slide ?? 0;
      return apply((client) => client.applyOp(index, edit), { applied: true });
    },
    [apply],
  );

  const commitTransform = useCallback(
    (node: EditorNode, box: Box) =>
      applyEdit({
        kind: "transform",
        el: node.id,
        box: { x: box.x, y: box.y, w: box.w, h: box.h },
        rotDeg: node.rotationDeg,
      }),
    [applyEdit],
  );

  const commitText = useCallback(
    (node: EditorNode, text: string) => applyEdit({ kind: "text", el: node.id, text }),
    [applyEdit],
  );

  const commitRotation = useCallback(
    (node: EditorNode, rotDeg: number) =>
      applyEdit({
        kind: "transform",
        el: node.id,
        box: { x: node.box.x, y: node.box.y, w: node.box.w, h: node.box.h },
        rotDeg,
      }),
    [applyEdit],
  );

  /** 填充/描边/字体/对齐等样式编辑。 */
  const commitStyle = useCallback(
    (edit: PptxEditOp) => applyEdit(edit),
    [applyEdit],
  );

  const undoSelf = useCallback(
    () => apply((client) => client.undo(), { clearSelection: true, applied: true }),
    [apply],
  );
  const redoSelf = useCallback(
    () => apply((client) => client.redo(), { clearSelection: true, applied: true }),
    [apply],
  );

  const slideAction = useCallback(
    (action: PptxSlideAction) => {
      const index = sceneRef.current?.slide ?? 0;
      return apply((client) => client.slideOp(index, action), {
        applied: true,
        clearSelection: true,
      });
    },
    [apply],
  );

  const reset = useCallback(() => {
    sceneRef.current = null;
    setScene(null);
    setSelectedId(null);
  }, []);

  return {
    scene,
    selectedId,
    busy,
    canUndo: scene?.canUndo ?? false,
    canRedo: scene?.canRedo ?? false,
    openSlide,
    select: (node: EditorNode | null) => setSelectedId(node?.id ?? null),
    commitTransform,
    commitText,
    commitRotation,
    commitStyle,
    undo: undoSelf,
    redo: redoSelf,
    insertSlide: () => slideAction({ kind: "insert-blank" }),
    duplicateSlide: () => slideAction({ kind: "duplicate" }),
    deleteSlide: () => slideAction({ kind: "delete" }),
    moveSlide: (to: number) => slideAction({ kind: "move", to }),
    reset,
  };
}
