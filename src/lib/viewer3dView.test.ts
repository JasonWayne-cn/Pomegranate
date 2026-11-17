import { describe, it, expect } from "vitest";
import type { Viewer3dEngine } from "./viewer3dEngine";
import {
  VIEWER3D_BEST_VIEW,
  VIEWER3D_EDGE_VIEWS,
  VIEWER3D_FACE_VIEWS,
  VIEWER3D_ISO_VIEWS,
  alignedFaceView,
  buildViewer3dCamera,
  cameraDirection,
  cornerViewForSigns,
  cubeTransformFromDirection,
  edgeViewForDirection,
  nearestFaceView,
  normalizeDirection,
  orbitCameraFromState,
  orbitStateFromCamera,
  orbitStateWithDelta,
} from "./viewer3dView";

const fakeEngine = {
  Coord3D: class {
    constructor(
      public x: number,
      public y: number,
      public z: number,
    ) {}
  },
  Camera: class {
    constructor(
      public eye: { x: number; y: number; z: number },
      public center: { x: number; y: number; z: number },
      public up: { x: number; y: number; z: number },
      public fov: number,
    ) {}
  },
} as unknown as Viewer3dEngine;

const sphere = { center: { x: 1, y: 2, z: 3 }, radius: 10 };

describe("三维视角数学", () => {
  it("方向归一化与零向量兜底", () => {
    expect(normalizeDirection([0, 0, 0])).toEqual([0, 0, 1]);
    expect(normalizeDirection([2, 0, 0])).toEqual([1, 0, 0]);
    const [x, y, z] = normalizeDirection([1, 1, 1]);
    expect(x).toBeCloseTo(Math.sqrt(1 / 3));
    expect(y).toBeCloseTo(Math.sqrt(1 / 3));
    expect(z).toBeCloseTo(Math.sqrt(1 / 3));
  });

  it("从相机提取方向", () => {
    const dir = cameraDirection({
      eye: { x: 5, y: 0, z: 5 },
      center: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      fov: 45,
    });
    expect(dir[0]).toBeCloseTo(Math.SQRT1_2);
    expect(dir[2]).toBeCloseTo(Math.SQRT1_2);
  });

  it("方向映射到 CSS 立方体旋转", () => {
    const front = cubeTransformFromDirection([0, 0, 1]);
    expect(front.yaw).toBeCloseTo(0);
    expect(front.pitch).toBeCloseTo(0);
    expect(front.transform).toContain("rotateX(0deg)");
    expect(front.transform).toContain("rotateY(0deg)");

    const right = cubeTransformFromDirection([1, 0, 0]);
    expect(right.yaw).toBeCloseTo(90);
    expect(right.transform).toContain("rotateY(-90deg)");

    const top = cubeTransformFromDirection([0, 1, 0]);
    expect(top.pitch).toBeCloseTo(90);
    expect(top.transform).toContain("rotateX(-90deg)");
  });

  it("最近面判断", () => {
    expect(nearestFaceView([0, 0, 1]).id).toBe("front");
    expect(nearestFaceView([1, 0, 0]).id).toBe("right");
    expect(nearestFaceView([0, 1, 0]).id).toBe("top");
    expect(nearestFaceView([0.9, 0, 0.1]).id).toBe("right");
  });

  it("只有正对面才高亮，等轴测不强行高亮", () => {
    expect(alignedFaceView([0, 0, 1])?.id).toBe("front");
    expect(alignedFaceView([1, 1, 1])).toBeNull();
    expect(alignedFaceView([1, 0.5, 0])).toBeNull();
  });

  it("构造标准视角相机", () => {
    const front = VIEWER3D_FACE_VIEWS.find((v) => v.id === "front")!;
    const camera = buildViewer3dCamera(fakeEngine, front, sphere);
    expect(camera.center.x).toBe(1);
    expect(camera.center.y).toBe(2);
    expect(camera.center.z).toBe(3);
    expect(camera.eye.z).toBeGreaterThan(3);
    expect(camera.up.y).toBe(1);
    expect(camera.fov).toBe(45);

    const top = VIEWER3D_FACE_VIEWS.find((v) => v.id === "top")!;
    const topCamera = buildViewer3dCamera(fakeEngine, top, sphere);
    expect(topCamera.eye.y).toBeGreaterThan(2);
    expect(topCamera.up.z).toBe(-1);
  });

  it("8 个等轴测角点，最佳视角为前上右", () => {
    expect(VIEWER3D_ISO_VIEWS).toHaveLength(8);
    expect(VIEWER3D_BEST_VIEW).toBe(VIEWER3D_ISO_VIEWS[0]);
    expect(VIEWER3D_BEST_VIEW.label).toBe("前上右");
    expect(new Set(VIEWER3D_ISO_VIEWS.map((v) => v.id)).size).toBe(8);
    expect(VIEWER3D_FACE_VIEWS).toHaveLength(6);
    expect(cornerViewForSigns(1, 1, 1).id).toBe("iso-front-top-right");
    expect(cornerViewForSigns(-1, 1, 1).id).toBe("iso-front-top-left");
    expect(cornerViewForSigns(-1, -1, -1).id).toBe("iso-back-bottom-left");
  });

  it("12 条棱视角与方向映射", () => {
    expect(VIEWER3D_EDGE_VIEWS).toHaveLength(12);
    expect(new Set(VIEWER3D_EDGE_VIEWS.map((view) => view.id)).size).toBe(12);
    expect(edgeViewForDirection(1, 1, 0).label).toBe("右上");
    expect(edgeViewForDirection(0, 1, 1).label).toBe("上前");
    expect(edgeViewForDirection(-1, 0, -1).label).toBe("左后");
  });

  it("拖动旋转的球坐标与相机还原", () => {
    const camera = {
      eye: { x: 0, y: 0, z: 5 },
      center: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      fov: 45,
    };
    const state = orbitStateFromCamera(camera);
    expect(state.radius).toBeCloseTo(5);
    expect(state.azimuth).toBeCloseTo(0);
    expect(state.elevation).toBeCloseTo(0);

    const next = orbitStateWithDelta(state, 10, 0);
    expect(next.azimuth).toBeCloseTo(-0.1);
    const clamped = orbitStateWithDelta(state, 0, 10000);
    expect(clamped.elevation).toBeLessThan(Math.PI / 2);

    const rotated = orbitCameraFromState(fakeEngine, next);
    expect(rotated.center.z).toBe(0);
    expect(rotated.eye.z).toBeLessThan(5);
    expect(rotated.fov).toBe(45);
  });
});
