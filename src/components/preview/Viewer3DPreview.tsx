/**
 * 三维模型预览（内置离线引擎）。
 *
 * 设计：
 * - 按需动态加载 `public/viewer3d/o3dv.min.js`，不进入主 bundle
 * - 通过 `readViewer3dFile` 把文档附件读成 File 交给引擎，绕开 asset 协议 CORS
 * - 单实例挂载：Modal 关闭即 Destroy，释放 WebGL 上下文
 * - 引擎内部会注册 window resize 监听且不注销，这里在销毁后把 Resize 置空，
 *   避免后续窗口缩放访问已销毁的 renderer
 */
import { useEffect, useRef, useState } from "react";
import { Button, Spin, theme as antdTheme } from "antd";
import { AlertTriangle, RotateCw } from "lucide-react";
import {
  applyViewer3dEdges,
  applyViewer3dFit,
  applyViewer3dFlatShading,
  applyViewer3dOpacity,
  applyViewer3dProjection,
  applyViewer3dView,
  applyViewer3dVisibility,
  applyViewer3dWireframe,
  loadViewer3dEngine,
  readViewer3dFile,
  themeColorToRgb,
  type Viewer3dEmbeddedViewer,
  type Viewer3dEngine,
} from "@/services/viewer3d";
import {
  VIEWER3D_BEST_VIEW,
  type Viewer3dProjection,
} from "@/lib/viewer3dView";
import { Viewer3DViewCube } from "./Viewer3DViewCube";
import {
  buildViewer3dTree,
  collectAllNodeIds,
  collectHiddenMeshKeys,
  type Viewer3dTreeNode,
} from "@/lib/viewer3dEngine";
import { isViewer3dCadExt, viewer3dFileName } from "@/lib/viewer3d";
import {
  Viewer3DControls,
  type Viewer3dRenderMode,
  type Viewer3dShadingMode,
} from "./Viewer3DControls";
import { Viewer3DStructureTree } from "./Viewer3DStructureTree";

interface Props {
  /** 相对 data_dir 的 POSIX 路径（kb-asset:// 后那段） */
  rel: string;
  fileName?: string;
}

type Status = "loading" | "ready" | "error";

export function Viewer3DPreview({ rel, fileName }: Props) {
  const { token } = antdTheme.useToken();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer3dEmbeddedViewer | null>(null);
  const engineRef = useRef<Viewer3dEngine | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tree, setTree] = useState<Viewer3dTreeNode | null>(null);
  const [renderMode, setRenderMode] = useState<Viewer3dRenderMode>("solid");
  const [shading, setShading] = useState<Viewer3dShadingMode>("smooth");
  const [opacity, setOpacity] = useState(100);
  const [projection, setProjection] =
    useState<Viewer3dProjection>("orthographic");
  const [hiddenNodes, setHiddenNodes] = useState<Set<string>>(new Set());
  const [hiddenMeshes, setHiddenMeshes] = useState<Set<string>>(new Set());

  const bgHex = token.colorBgContainer ?? "#202020";
  const ready = status === "ready";
  const isCad = isViewer3dCadExt(rel);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let viewer: Viewer3dEmbeddedViewer | null = null;
    let observer: ResizeObserver | null = null;

    viewerRef.current = null;
    engineRef.current = null;
    container.innerHTML = "";
    setTree(null);
    setStatus("loading");
    setError(null);
    setHiddenNodes(new Set());
    setHiddenMeshes(new Set());

    const [r, g, b] = themeColorToRgb(bgHex);

    (async () => {
      try {
        const file = await readViewer3dFile(rel);
        if (disposed) return;

        const OV = await loadViewer3dEngine();
        if (disposed) return;

        const embedded = new OV.EmbeddedViewer(container, {
          backgroundColor: new OV.RGBAColor(r, g, b, 255),
          onModelLoaded: () => {
            if (disposed) return;
            // 结构树是增强功能：即使建树失败也要让模型正常显示
            try {
              const model = embedded.GetModel();
              if (model) {
                setTree(buildViewer3dTree(model, viewer3dFileName(rel)));
              }
            } catch (e) {
              console.warn("[viewer3d] 构建模型结构树失败:", e);
              setTree(null);
            }
            // 打开即最佳视角：前上右等轴测 + 正交 + fit
            try {
              const OV = engineRef.current;
              if (OV) {
                setProjection("orthographic");
                applyViewer3dView(OV, embedded, VIEWER3D_BEST_VIEW, "orthographic");
              }
            } catch (e) {
              console.warn("[viewer3d] 应用最佳视角失败:", e);
            }
            setStatus("ready");
          },
          onModelLoadFailed: () => {
            if (disposed) return;
            console.error("[viewer3d] 模型解析失败:", rel);
            setStatus("error");
            setError(
              isCad
                ? "CAD 模型解析失败：请确认应用已重启以加载 OCCT 解码器；若仍失败，可能是文件结构异常或内存不足。"
                : "模型解析失败。若模型依赖同目录的纹理/bin 文件，请打包为 zip 后重新插入。",
            );
          },
        });

        viewer = embedded;
        viewerRef.current = embedded;
        engineRef.current = OV;
        embedded.LoadModelFromFileList([file]);

        observer = new ResizeObserver(() => {
          embedded.Resize();
        });
        observer.observe(container);
      } catch (e) {
        if (disposed) return;
        setStatus("error");
        setError(String(e));
      }
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      try {
        viewer?.Destroy();
      } catch {
        // 引擎内部销毁失败不影响组件卸载
      }
      if (viewer) {
        // EmbeddedViewer 的 window resize 监听不会注销：销毁后把 Resize 置空，
        // 避免后续窗口缩放访问已释放的 WebGL renderer
        (viewer as unknown as { Resize: () => void }).Resize = () => {};
      }
      viewerRef.current = null;
      engineRef.current = null;
      container.innerHTML = "";
    };
  }, [rel, bgHex, attempt]);

  // ── 渲染设置：线框 / 边线 / 着色 / 透明度 ──
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer) return;
    applyViewer3dWireframe(viewer, renderMode === "wireframe");
  }, [ready, renderMode]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const engine = engineRef.current;
    if (!ready || !viewer || !engine) return;
    applyViewer3dEdges(engine, viewer, renderMode === "edges");
  }, [ready, renderMode]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer) return;
    applyViewer3dFlatShading(viewer, shading === "flat");
  }, [ready, shading]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer) return;
    applyViewer3dOpacity(viewer, opacity / 100);
  }, [ready, opacity]);

  // ── 结构树可见性 ──
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || !viewer || !tree) return;
    applyViewer3dVisibility(
      viewer,
      collectHiddenMeshKeys(tree, hiddenNodes, hiddenMeshes),
    );
  }, [ready, tree, hiddenNodes, hiddenMeshes]);

  function toggleNode(nodeId: string) {
    setHiddenNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function toggleMesh(meshKey: string) {
    setHiddenMeshes((prev) => {
      const next = new Set(prev);
      if (next.has(meshKey)) next.delete(meshKey);
      else next.add(meshKey);
      return next;
    });
  }

  function showAll() {
    setHiddenNodes(new Set());
    setHiddenMeshes(new Set());
  }

  function hideAll() {
    if (!tree) return;
    setHiddenNodes(new Set(collectAllNodeIds(tree)));
    setHiddenMeshes(new Set());
  }

  // ── 视角操作 ──
  function handleBestView() {
    const viewer = viewerRef.current;
    const engine = engineRef.current;
    if (!viewer || !engine) return;
    try {
      applyViewer3dView(engine, viewer, VIEWER3D_BEST_VIEW, projection);
    } catch (e) {
      console.warn("[viewer3d] 应用最佳视角失败:", e);
    }
  }

  function handleFit() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      applyViewer3dFit(viewer);
    } catch (e) {
      console.warn("[viewer3d] 适应窗口失败:", e);
    }
  }

  function handleToggleProjection() {
    const viewer = viewerRef.current;
    const engine = engineRef.current;
    if (!viewer || !engine) return;
    const next: Viewer3dProjection =
      projection === "orthographic" ? "perspective" : "orthographic";
    try {
      applyViewer3dProjection(engine, viewer, next);
      setProjection(next);
    } catch (e) {
      console.warn("[viewer3d] 切换投影方式失败:", e);
    }
  }

  const displayName = fileName || viewer3dFileName(rel);

  return (
    <div
      className="flex h-full w-full overflow-hidden"
      style={{ minHeight: 320, background: bgHex }}
    >
      {tree && (
        <aside
          className="flex w-[230px] shrink-0 flex-col"
          style={{
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
          }}
        >
          <Viewer3DStructureTree
            tree={tree}
            hiddenNodes={hiddenNodes}
            hiddenMeshes={hiddenMeshes}
            onToggleNode={toggleNode}
            onToggleMesh={toggleMesh}
            onShowAll={showAll}
            onHideAll={hideAll}
          />
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Viewer3DControls
          disabled={!ready}
          renderMode={renderMode}
          onRenderModeChange={setRenderMode}
          shading={shading}
          onShadingChange={setShading}
          opacity={opacity}
          onOpacityChange={setOpacity}
          projection={projection}
          onBestView={handleBestView}
          onFit={handleFit}
          onToggleProjection={handleToggleProjection}
        />

        <div className="relative min-h-[240px] flex-1">
          <div ref={containerRef} className="absolute inset-0" />

          {status === "ready" &&
            viewerRef.current &&
            engineRef.current && (
              <Viewer3DViewCube
                viewer={viewerRef.current}
                engine={engineRef.current}
                projection={projection}
              />
            )}

          {status === "loading" && (
            <div
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3"
              style={{ background: bgHex }}
            >
              <Spin />
              <span
                className="text-xs"
                style={{ color: token.colorTextSecondary }}
              >
                正在加载 {displayName}...
              </span>
              {isCad && (
                <span
                  className="text-[11px]"
                  style={{ color: token.colorTextTertiary }}
                >
                  CAD 首次解析需加载 OCCT WASM，可能需要 10–30 秒
                </span>
              )}
            </div>
          )}

          {status === "error" && (
            <div
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center"
              style={{ background: bgHex }}
            >
              <AlertTriangle
                size={36}
                strokeWidth={1.5}
                style={{ color: "#f59e0b" }}
              />
              <div
                className="max-w-md text-sm"
                style={{ color: token.colorTextSecondary }}
              >
                {error || "三维模型加载失败"}
              </div>
              <Button
                size="small"
                icon={<RotateCw size={14} />}
                onClick={() => setAttempt((n) => n + 1)}
              >
                重新加载
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
