/**
 * SVG ViewCube 的正交投影纯数学。
 *
 * 输入引擎相机（eye/center/up），输出可见面、棱、角点在 2D SVG 中的位置。
 * 不依赖 DOM/WebGL，便于单测。
 */
import type { Viewer3dCamera } from "./viewer3dEngine";
import {
  VIEWER3D_FACE_VIEWS,
  cornerViewForSigns,
  edgeViewForDirection,
  type Viewer3dViewSpec,
} from "./viewer3dView";

type Vec3 = readonly [number, number, number];

export interface CubePoint2D {
  x: number;
  y: number;
  depth: number;
}

export interface CubeFaceProjection {
  view: Viewer3dViewSpec;
  points: string;
  insetPoints: string;
  labelX: number;
  labelY: number;
  labelAngle: number;
  depth: number;
}

export interface CubeCornerProjection {
  key: string;
  view: Viewer3dViewSpec;
  x: number;
  y: number;
}

export interface CubeEdgeProjection {
  key: string;
  view: Viewer3dViewSpec;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Viewer3dCubeProjection {
  faces: CubeFaceProjection[];
  edges: CubeEdgeProjection[];
  corners: CubeCornerProjection[];
}

/** SVG 画布尺寸（仅包含立方体） */
export const VIEWER3D_CUBE_VIEW_WIDTH = 200;
export const VIEWER3D_CUBE_VIEW_HEIGHT = 192;
const CENTER_X = 100;
const CENTER_Y = 96;
const SCALE = 46;

interface FaceDef {
  viewId: string;
  normal: Vec3;
  corners: readonly [Vec3, Vec3, Vec3, Vec3];
  tangent: Vec3;
}

const FACE_DEFS: readonly FaceDef[] = [
  {
    viewId: "front",
    normal: [0, 0, 1],
    corners: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
    tangent: [1, 0, 0],
  },
  {
    viewId: "back",
    normal: [0, 0, -1],
    corners: [
      [1, -1, -1],
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
    ],
    tangent: [-1, 0, 0],
  },
  {
    viewId: "right",
    normal: [1, 0, 0],
    corners: [
      [1, -1, 1],
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
    ],
    tangent: [0, 0, -1],
  },
  {
    viewId: "left",
    normal: [-1, 0, 0],
    corners: [
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
    ],
    tangent: [0, 0, 1],
  },
  {
    viewId: "top",
    normal: [0, 1, 0],
    corners: [
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
      [-1, 1, -1],
    ],
    tangent: [1, 0, 0],
  },
  {
    viewId: "bottom",
    normal: [0, -1, 0],
    corners: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
    tangent: [1, 0, 0],
  },
];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  if (length < 1e-9) return [0, 0, 0];
  return [a[0] / length, a[1] / length, a[2] / length];
}

function faceView(viewId: string): Viewer3dViewSpec {
  return (
    VIEWER3D_FACE_VIEWS.find((view) => view.id === viewId) ??
    VIEWER3D_FACE_VIEWS[0]
  );
}

export function buildViewer3dCubeProjection(
  camera: Viewer3dCamera,
): Viewer3dCubeProjection {
  const forward = normalize([
    camera.center.x - camera.eye.x,
    camera.center.y - camera.eye.y,
    camera.center.z - camera.eye.z,
  ]);
  const up = normalize([camera.up.x, camera.up.y, camera.up.z]);

  let right = cross(forward, up);
  if (Math.hypot(right[0], right[1], right[2]) < 1e-6) {
    right = [1, 0, 0];
  }
  right = normalize(right);
  const trueUp = normalize(cross(right, forward));
  const viewDir: Vec3 = [-forward[0], -forward[1], -forward[2]];

  const project = (p: Vec3): CubePoint2D => ({
    x: CENTER_X + SCALE * dot(p, right),
    y: CENTER_Y - SCALE * dot(p, trueUp),
    depth: dot(p, forward),
  });

  const faces: CubeFaceProjection[] = [];
  for (const face of FACE_DEFS) {
    const facing = dot(face.normal, viewDir);
    if (facing <= 1e-6) continue;

    const projected = face.corners.map(project);
    const points = projected.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");

    const center = projected.reduce(
      (acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4 }),
      { x: 0, y: 0 },
    );
    const insetPoints = projected
      .map((p) => {
        const x = center.x + (p.x - center.x) * 0.8;
        const y = center.y + (p.y - center.y) * 0.8;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");

    const tangentX = dot(face.tangent, right);
    const tangentY = -dot(face.tangent, trueUp);
    let labelAngle = (Math.atan2(tangentY, tangentX) * 180) / Math.PI;
    if (labelAngle > 90) labelAngle -= 180;
    if (labelAngle < -90) labelAngle += 180;

    faces.push({
      view: faceView(face.viewId),
      points,
      insetPoints,
      labelX: center.x,
      labelY: center.y,
      labelAngle,
      depth: projected.reduce((sum, p) => sum + p.depth, 0) / 4,
    });
  }
  faces.sort((a, b) => b.depth - a.depth);

  const corners: CubeCornerProjection[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const normals: Vec3[] = [
          [sx, 0, 0],
          [0, sy, 0],
          [0, 0, sz],
        ];
        const visible = normals.some((normal) => dot(normal, viewDir) > 1e-6);
        if (!visible) continue;
        const p = project([sx, sy, sz]);
        corners.push({
          key: `${sx}:${sy}:${sz}`,
          view: cornerViewForSigns(sx, sy, sz),
          x: p.x,
          y: p.y,
        });
      }
    }
  }

  const edges: CubeEdgeProjection[] = [];
  const axisPairs: Array<[number, number, number]> = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 2, 0],
  ];
  for (const [i, j, k] of axisPairs) {
    for (const si of [-1, 1]) {
      for (const sj of [-1, 1]) {
        const n1: [number, number, number] = [0, 0, 0];
        n1[i] = si;
        const n2: [number, number, number] = [0, 0, 0];
        n2[j] = sj;
        if (dot(n1, viewDir) <= 1e-6 && dot(n2, viewDir) <= 1e-6) {
          continue;
        }

        const dir: [number, number, number] = [0, 0, 0];
        dir[i] = si;
        dir[j] = sj;

        const p1: [number, number, number] = [0, 0, 0];
        p1[i] = si;
        p1[j] = sj;
        p1[k] = -1;
        const p2: [number, number, number] = [0, 0, 0];
        p2[i] = si;
        p2[j] = sj;
        p2[k] = 1;

        const a = project(p1);
        const b = project(p2);
        edges.push({
          key: `edge:${i}:${si}:${j}:${sj}`,
          view: edgeViewForDirection(dir[0], dir[1], dir[2]),
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
        });
      }
    }
  }

  return { faces, edges, corners };
}
