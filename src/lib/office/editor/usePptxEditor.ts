/**
 * PPTX 编辑会话 Hook：把 Worker RPC 收窄成页面需要的状态机。
 * 场景（RenderSlide）由 Worker 持有，这里只缓存当前页。
 */
import { useCallback, useRef, useState, type RefObject } from "react";
import type { PptxWorkerClient } from "@/lib/office/pptxWorkerClient";
import type { PptxEditOp, PptxSceneResult } from "@/lib/office/editor/protocol";
import type { Box, EditorNode } from "@/lib/office/editor/geometry";

interface Options {
  clientRef: RefObject<PptxWorkerClient | null>;
  onThumbnail: (slide: number, svg: string) => void;
  onError: (error: unknown) => void;
}

export function usePptxEditor({ clientRef, onThumbnail, onError }: Options) {
  const [scene, setScene] = useState<PptxSceneResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sceneRef = useRef<PptxSceneResult | null>(null);

  const apply = useCallback(
    async (action: (client: PptxWorkerClient) => Promise<PptxSceneResult>, clearSelection = false) => {
      const client = clientRef.current;
      if (!client) return;
      setBusy(true);
      try {
        const result = await action(client);
        sceneRef.current = result;
        setScene(result);
        onThumbnail(result.slide, result.svg);
        if (clearSelection) setSelectedId(null);
      } catch (error) {
        onError(error);
      } finally {
        setBusy(false);
      }
    },
    [clientRef, onThumbnail, onError],
  );

  const openSlide = useCallback(
    (index: number) => apply((client) => client.getScene(index), true),
    [apply],
  );

  const applyEdit = useCallback(
    (edit: PptxEditOp) => {
      const index = sceneRef.current?.slide ?? 0;
      return apply((client) => client.applyOp(index, edit));
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

  const undo = useCallback(() => apply((client) => client.undo(), true), [apply]);
  const redo = useCallback(() => apply((client) => client.redo(), true), [apply]);

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
    undo,
    redo,
    reset,
  };
}
