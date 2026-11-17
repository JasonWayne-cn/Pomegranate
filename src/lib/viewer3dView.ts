/**
 * 三维标准视角与 ViewCube 纯逻辑。
 *
 * 模型在引擎加载后已统一为 Y 轴向上，因此标准方向按 Y-up 定义。
 */
import type {
  Viewer3dBoundingSphere,
  Viewer3dCamera,
  Viewer3dEngine,
} from "./viewer3dEngine";

export type Viewer3dProjection = "perspective" | "orthographic";

export interface Viewer3dViewSpec {
  id: string;
  label: string;
  dir: readonly [number, number, number];
  up: readonly [number, number, number];
}

export const VIEWER3D_FACE_VIEWS: readonly Viewer3dViewSpec[] = [
  { id: "front", label: "前", dir: [0, 0, 1], up: [0, 1, 0] },
  { id: "back", label: "后", dir: [0, 0, -1], up: [0, 1, 0] },
  { id: "left", label: "左", dir: [-1, 0, 0], up: [0, 1, 0] },
  { id: "right", label: "右", dir: [1, 0, 0], up: [0, 1, 0] },
  { id: "top", label: "顶", dir: [0, 1, 0], up: [0, 0, -1] },
  { id: "bottom", label: "底", dir: [0, -1, 0], up: [0, 0, 1] },
];

/** 八个等轴测角点 */
export const VIEWER3D_ISO_VIEWS: readonly Viewer3dViewSpec[] = [
  { id: "iso-front-top-right", label: "前上右", dir: [1, 1, 1], up: [0, 1, 0] },
  { id: "iso-front-top-left", label: "前上左", dir: [-1, 1, 1], up: [0, 1, 0] },
  { id: "iso-back-top-right", label: "后上右", dir: [1, 1, -1], up: [0, 1, 0] },
  { id: "iso-back-top-left", label: "后上左", dir: [-1, 1, -1], up: [0, 1, 0] },
  { id: "iso-front-bottom-right", label: "前下右", dir: [1, -1, 1], up: [0, 1, 0] },
  { id: "iso-front-bottom-left", label: "前下左", dir: [-1, -1, 1], up: [0, 1, 0] },
  { id: "iso-back-bottom-right", label: "后下右", dir: [1, -1, -1], up: [0, 1, 0] },
  { id: "iso-back-bottom-left", label: "后下左", dir: [-1, -1, -1], up: [0, 1, 0] },
];

export const VIEWER3D_BEST_VIEW = VIEWER3D_ISO_VIEWS[0];

/** 由立方体角点的符号（±1）找到对应的等轴测视角 */
export function cornerViewForSigns(
  sx: number,
  sy: number,
  sz: number,
): Viewer3dViewSpec {
  const x = sx >= 0 ? 1 : -1;
  const y = sy >= 0 ? 1 : -1;
  const z = sz >= 0 ? 1 : -1;
  return (
    VIEWER3D_ISO_VIEWS.find(
      (view) => view.dir[0] === x && view.dir[1] === y && view.dir[2] === z,
    ) ?? VIEWER3D_ISO_VIEWS[0]
  );
}

/** 12 条棱的视角（两个面之间的方向） */
export const VIEWER3D_EDGE_VIEWS: readonly Viewer3dViewSpec[] = [
  { id: "edge-right-top", label: "右上", dir: [1, 1, 0], up: [0, 1, 0] },
  { id: "edge-left-top", label: "左上", dir: [-1, 1, 0], up: [0, 1, 0] },
  { id: "edge-right-bottom", label: "右下", dir: [1, -1, 0], up: [0, 1, 0] },
  { id: "edge-left-bottom", label: "左下", dir: [-1, -1, 0], up: [0, 1, 0] },
  { id: "edge-right-front", label: "右前", dir: [1, 0, 1], up: [0, 1, 0] },
  { id: "edge-left-front", label: "左前", dir: [-1, 0, 1], up: [0, 1, 0] },
  { id: "edge-right-back", label: "右后", dir: [1, 0, -1], up: [0, 1, 0] },
  { id: "edge-left-back", label: "左后", dir: [-1, 0, -1], up: [0, 1, 0] },
  { id: "edge-top-front", label: "上前", dir: [0, 1, 1], up: [0, 1, 0] },
  { id: "edge-top-back", label: "上后", dir: [0, 1, -1], up: [0, 1, 0] },
  { id: "edge-bottom-front", label: "下前", dir: [0, -1, 1], up: [0, 1, 0] },
  { id: "edge-bottom-back", label: "下后", dir: [0, -1, -1], up: [0, 1, 0] },
];

export function edgeViewForDirection(
  x: number,
  y: number,
  z: number,
): Viewer3dViewSpec {
  return (
    VIEWER3D_EDGE_VIEWS.find(
      (view) => view.dir[0] === x && view.dir[1] === y && view.dir[2] === z,
    ) ?? VIEWER3D_EDGE_VIEWS[0]
  );
}

export function normalizeDirection(
  dir: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z] = dir;
  const length = Math.hypot(x, y, z);
  if (length < 1e-9) return [0, 0, 1];
  return [x / length, y / length, z / length];
}

export function cameraDirection(
  camera: Viewer3dCamera,
): [number, number, number] {
  return normalizeDirection([
    camera.eye.x - camera.center.x,
    camera.eye.y - camera.center.y,
    camera.eye.z - camera.center.z,
  ]);
}

/** 构造一个能容纳包围球的相机；FitSphereToWindow 会再精确调整距离 */
export function buildViewer3dCamera(
  engine: Viewer3dEngine,
  view: Viewer3dViewSpec,
  sphere: Viewer3dBoundingSphere,
): Viewer3dCamera {
  const dir = normalizeDirection(view.dir);
  const center = new engine.Coord3D(
    sphere.center.x,
    sphere.center.y,
    sphere.center.z,
  );
  const distance = Math.max(sphere.radius * 4, 1);
  const eye = new engine.Coord3D(
    center.x + dir[0] * distance,
    center.y + dir[1] * distance,
    center.z + dir[2] * distance,
  );
  const up = new engine.Coord3D(view.up[0], view.up[1], view.up[2]);
  // 必须用引擎 Camera：FitSphereToWindow 内部会调用 Camera.Clone()
  return new engine.Camera(eye, center, up, 45);
}

/**
 * 方向 → CSS 3D 旋转。
 *
 * CSS 立方体约定：+Z 为前、+X 为右、+Y 向下。
 * yaw 使用 atan2(x, z)，pitch 使用 asin(y)，再取负号让对应面朝向观察者。
 */
export function cubeTransformFromDirection(
  dir: readonly [number, number, number],
): { yaw: number; pitch: number; transform: string } {
  const [x, y, z] = normalizeDirection(dir);
  const yaw = (Math.atan2(x, z) * 180) / Math.PI;
  const pitch = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
  return {
    yaw,
    pitch,
    transform: `rotateX(${-pitch}deg) rotateY(${-yaw}deg)`,
  };
}

export interface Viewer3dOrbitState {
  azimuth: number;
  elevation: number;
  radius: number;
  center: [number, number, number];
  fov: number;
}

/** 从相机提取球坐标，供拖动旋转使用 */
export function orbitStateFromCamera(
  camera: Viewer3dCamera,
): Viewer3dOrbitState {
  const dx = camera.eye.x - camera.center.x;
  const dy = camera.eye.y - camera.center.y;
  const dz = camera.eye.z - camera.center.z;
  const radius = Math.max(Math.hypot(dx, dy, dz), 1e-3);
  const azimuth = Math.atan2(dx, dz);
  const elevation = Math.asin(
    Math.max(-1, Math.min(1, dy / radius)),
  );
  return {
    azimuth,
    elevation,
    radius,
    center: [camera.center.x, camera.center.y, camera.center.z],
    fov: camera.fov,
  };
}

/** 按鼠标位移更新球坐标（dx/dy 为相对起点的总位移） */
export function orbitStateWithDelta(
  state: Viewer3dOrbitState,
  dx: number,
  dy: number,
  sensitivity = 0.01,
): Viewer3dOrbitState {
  const limit = Math.PI / 2 - 0.02;
  return {
    ...state,
    azimuth: state.azimuth - dx * sensitivity,
    elevation: Math.max(
      -limit,
      Math.min(limit, state.elevation + dy * sensitivity),
    ),
  };
}

/** 由球坐标生成引擎相机（Y 轴向上） */
export function orbitCameraFromState(
  engine: Viewer3dEngine,
  state: Viewer3dOrbitState,
): Viewer3dCamera {
  const cosEl = Math.cos(state.elevation);
  const offsetX = state.radius * cosEl * Math.sin(state.azimuth);
  const offsetY = state.radius * Math.sin(state.elevation);
  const offsetZ = state.radius * cosEl * Math.cos(state.azimuth);
  const [cx, cy, cz] = state.center;
  const eye = new engine.Coord3D(cx + offsetX, cy + offsetY, cz + offsetZ);
  const center = new engine.Coord3D(cx, cy, cz);
  const up = new engine.Coord3D(0, 1, 0);
  return new engine.Camera(eye, center, up, state.fov);
}

/** 当前方向最接近的立方体面（用于高亮） */
export function nearestFaceView(
  dir: readonly [number, number, number],
): Viewer3dViewSpec {
  const [x, y, z] = normalizeDirection(dir);
  let best = VIEWER3D_FACE_VIEWS[0];
  let bestDot = -Infinity;
  for (const view of VIEWER3D_FACE_VIEWS) {
    const dot = x * view.dir[0] + y * view.dir[1] + z * view.dir[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = view;
    }
  }
  return best;
}

/**
 * 只有相机方向足够接近某个面时才返回该面。
 * 等轴测/自由旋转时返回 null，避免错误高亮“前”。
 */
export function alignedFaceView(
  dir: readonly [number, number, number],
  threshold = 0.98,
): Viewer3dViewSpec | null {
  const [x, y, z] = normalizeDirection(dir);
  const view = nearestFaceView([x, y, z]);
  const dot = x * view.dir[0] + y * view.dir[1] + z * view.dir[2];
  return dot >= threshold ? view : null;
}
