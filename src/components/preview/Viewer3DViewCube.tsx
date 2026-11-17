/**
 * SVG 投影 ViewCube：6 个标准面 + 12 条棱 + 8 个等轴测角点。
 *
 * - 不创建额外 WebGL 上下文；通过 rAF 轮询引擎相机，重新投影 SVG。
 * - 在立方体区域拖动可直接旋转主视图；短点击仍按面/棱/角切换。
 */
import { useEffect, useRef, useState } from "react";
import { theme as antdTheme } from "antd";
import {
  alignedFaceView,
  cameraDirection,
  orbitCameraFromState,
  orbitStateFromCamera,
  orbitStateWithDelta,
  type Viewer3dOrbitState,
  type Viewer3dProjection,
  type Viewer3dViewSpec,
} from "@/lib/viewer3dView";
import {
  VIEWER3D_CUBE_VIEW_HEIGHT,
  VIEWER3D_CUBE_VIEW_WIDTH,
  buildViewer3dCubeProjection,
  type Viewer3dCubeProjection,
} from "@/lib/viewer3dViewCube";
import {
  applyViewer3dView,
  type Viewer3dEmbeddedViewer,
  type Viewer3dEngine,
} from "@/services/viewer3d";

interface Props {
  viewer: Viewer3dEmbeddedViewer;
  engine: Viewer3dEngine;
  /** 主视图当前投影方式，切换标准视角时保持一致 */
  projection: Viewer3dProjection;
}

function cameraKey(viewer: Viewer3dEmbeddedViewer): string {
  const cam = viewer.GetViewer().GetCamera();
  const round = (value: number) => value.toFixed(3);
  return [
    round(cam.eye.x),
    round(cam.eye.y),
    round(cam.eye.z),
    round(cam.center.x),
    round(cam.center.y),
    round(cam.center.z),
    round(cam.up.x),
    round(cam.up.y),
    round(cam.up.z),
  ].join(",");
}

export function Viewer3DViewCube({ viewer, engine, projection }: Props) {
  const { token } = antdTheme.useToken();
  const [projectionData, setProjectionData] = useState<Viewer3dCubeProjection>(
    () => buildViewer3dCubeProjection(viewer.GetViewer().GetCamera()),
  );
  const [activeFaceId, setActiveFaceId] = useState<string | null>(() =>
    alignedFaceView(cameraDirection(viewer.GetViewer().GetCamera()))?.id ?? null,
  );
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    state: Viewer3dOrbitState;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    let raf = 0;
    let lastKey = "";
    const tick = () => {
      try {
        const key = cameraKey(viewer);
        if (key !== lastKey) {
          lastKey = key;
          const cam = viewer.GetViewer().GetCamera();
          setProjectionData(buildViewer3dCubeProjection(cam));
          setActiveFaceId(alignedFaceView(cameraDirection(cam))?.id ?? null);
        }
      } catch {
        // 相机/引擎销毁过程中忽略
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewer]);

  function applyView(view: Viewer3dViewSpec) {
    applyViewer3dView(engine, viewer, view, projection);
  }

  function applyViewFromSvg(view: Viewer3dViewSpec) {
    if (suppressClickRef.current) return;
    applyView(view);
  }

  function handlePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    suppressClickRef.current = false;
    // 不在 pointerdown 时立即捕获指针：捕获会把后续 click 重定向到 SVG 根节点，
    // 导致面/棱/角上的 onClick 不触发。只在真正开始拖动后再捕获。
    try {
      const camera = viewer.GetViewer().GetCamera();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        state: orbitStateFromCamera(camera),
        moved: false,
      };
    } catch {
      dragRef.current = null;
    }
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;

    if (!drag.moved) {
      drag.moved = true;
      suppressClickRef.current = true;
      setDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // 指针已结束时忽略
      }
    }

    try {
      const state = orbitStateWithDelta(drag.state, dx, dy);
      viewer.GetViewer().SetCamera(orbitCameraFromState(engine, state));
    } catch {
      // 引擎销毁过程中忽略
    }
  }

  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    dragRef.current = null;
    setDragging(false);
  }

  return (
    <div
      className="absolute right-2 top-2 z-20 select-none rounded-md p-1.5"
      style={{
        width: 138,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        boxShadow: token.boxShadowSecondary,
      }}
    >
      <svg
        viewBox={`0 0 ${VIEWER3D_CUBE_VIEW_WIDTH} ${VIEWER3D_CUBE_VIEW_HEIGHT}`}
        width="100%"
        role="img"
        aria-label="三维视图控制器"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
      >
        <defs>
          <linearGradient id="viewcube-face" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={token.colorFillSecondary} />
            <stop offset="100%" stopColor={token.colorFill} />
          </linearGradient>
          <linearGradient id="viewcube-inset" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={token.colorBgContainer} />
            <stop offset="100%" stopColor={token.colorFillQuaternary} />
          </linearGradient>
          <filter id="viewcube-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow
              dx="0"
              dy="1.5"
              stdDeviation="1.5"
              floodColor="#000"
              floodOpacity="0.18"
            />
          </filter>
        </defs>

        {projectionData.faces.map((face) => {
          const active = face.view.id === activeFaceId;
          const hovered = hoveredId === face.view.id;
          return (
            <g
              key={face.view.id}
              style={{ cursor: "pointer" }}
              onClick={() => applyViewFromSvg(face.view)}
              onMouseEnter={() => setHoveredId(face.view.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <polygon
                points={face.points}
                fill={active ? token.colorPrimary : "url(#viewcube-face)"}
                fillOpacity={active ? 0.22 : 1}
                stroke={active ? token.colorPrimary : token.colorBorder}
                strokeWidth={hovered ? 2.2 : 1.5}
                strokeLinejoin="round"
                filter="url(#viewcube-shadow)"
              />
              <polygon
                points={face.insetPoints}
                fill={active ? token.colorPrimary : "url(#viewcube-inset)"}
                fillOpacity={active ? 0.12 : 1}
                stroke={active ? token.colorPrimary : token.colorBorderSecondary}
                strokeWidth={1}
                strokeLinejoin="round"
              />
              <text
                x={face.labelX}
                y={face.labelY}
                transform={`rotate(${face.labelAngle} ${face.labelX} ${face.labelY})`}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={13}
                fontWeight={600}
                fill={active ? token.colorPrimary : token.colorText}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {face.view.label}
              </text>
            </g>
          );
        })}

        {projectionData.edges.map((edge) => {
          const hovered = hoveredId === edge.key;
          return (
            <g
              key={edge.key}
              style={{ cursor: "pointer" }}
              onClick={() => applyViewFromSvg(edge.view)}
              onMouseEnter={() => setHoveredId(edge.key)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <title>{edge.view.label}</title>
              <line
                x1={edge.x1}
                y1={edge.y1}
                x2={edge.x2}
                y2={edge.y2}
                stroke="transparent"
                strokeWidth={12}
                pointerEvents="stroke"
              />
              <line
                x1={edge.x1}
                y1={edge.y1}
                x2={edge.x2}
                y2={edge.y2}
                stroke={hovered ? token.colorPrimary : "rgba(255,255,255,0.8)"}
                strokeWidth={hovered ? 2.6 : 1.4}
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {projectionData.corners.map((corner) => {
          const hovered = hoveredId === corner.key;
          return (
            <g
              key={corner.key}
              style={{ cursor: "pointer" }}
              onClick={() => applyViewFromSvg(corner.view)}
              onMouseEnter={() => setHoveredId(corner.key)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <circle cx={corner.x} cy={corner.y} r={11} fill="transparent" />
              <circle
                cx={corner.x}
                cy={corner.y}
                r={hovered ? 4.6 : 3.2}
                fill={hovered ? token.colorPrimary : token.colorBgContainer}
                stroke={token.colorBorder}
                strokeWidth={1}
              />
            </g>
          );
        })}

      </svg>
    </div>
  );
}
