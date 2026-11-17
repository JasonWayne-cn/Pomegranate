import { describe, it, expect } from "vitest";
import type { Viewer3dCamera } from "./viewer3dEngine";
import { buildViewer3dCubeProjection } from "./viewer3dViewCube";

function camera(
  eye: [number, number, number],
  center: [number, number, number],
  up: [number, number, number],
): Viewer3dCamera {
  return {
    eye: { x: eye[0], y: eye[1], z: eye[2] },
    center: { x: center[0], y: center[1], z: center[2] },
    up: { x: up[0], y: up[1], z: up[2] },
    fov: 45,
  };
}

describe("SVG ViewCube 投影", () => {
  it("前视图只显示前面", () => {
    const projection = buildViewer3dCubeProjection(
      camera([0, 0, 5], [0, 0, 0], [0, 1, 0]),
    );
    expect(projection.faces.map((face) => face.view.id)).toEqual(["front"]);
    expect(projection.faces[0].points).toContain("54.00,142.00");
    expect(projection.faces[0].points).toContain("146.00,50.00");

    // 只有 z=1 的四个角在可见面上
    expect(projection.corners).toHaveLength(4);
    expect(projection.corners.every((corner) => corner.key.endsWith(":1"))).toBe(
      true,
    );
    // 前面四条棱可见
    expect(projection.edges).toHaveLength(4);
  });

  it("右视图显示右面", () => {
    const projection = buildViewer3dCubeProjection(
      camera([5, 0, 0], [0, 0, 0], [0, 1, 0]),
    );
    expect(projection.faces.map((face) => face.view.id)).toEqual(["right"]);
    expect(projection.corners).toHaveLength(4);
  });

  it("顶视图显示顶面", () => {
    const projection = buildViewer3dCubeProjection(
      camera([0, 5, 0], [0, 0, 0], [0, 0, -1]),
    );
    expect(projection.faces.map((face) => face.view.id)).toEqual(["top"]);
    expect(projection.faces[0].view.label).toBe("顶");
  });

  it("等轴测显示前/顶/右三个面与 7 个角点", () => {
    const projection = buildViewer3dCubeProjection(
      camera([5, 5, 5], [0, 0, 0], [0, 1, 0]),
    );
    expect(new Set(projection.faces.map((face) => face.view.id))).toEqual(
      new Set(["front", "top", "right"]),
    );
    expect(projection.corners).toHaveLength(7);
    expect(projection.edges).toHaveLength(9);
  });

  it("面标签角度稳定", () => {
    const projection = buildViewer3dCubeProjection(
      camera([5, 5, 5], [0, 0, 0], [0, 1, 0]),
    );
    for (const face of projection.faces) {
      expect(Number.isFinite(face.labelAngle)).toBe(true);
      expect(face.points.split(" ")).toHaveLength(4);
      expect(face.insetPoints.split(" ")).toHaveLength(4);
    }
  });

  it("棱/角点的点击视角与位置符号一致", () => {
    const projection = buildViewer3dCubeProjection(
      camera([5, 5, 5], [0, 0, 0], [0, 1, 0]),
    );
    for (const corner of projection.corners) {
      const signs = corner.key.split(":").map(Number);
      expect(corner.view.dir).toEqual(signs);
    }
    for (const edge of projection.edges) {
      // 每条棱的视角由两个相邻面的法线合成，只应有两个 ±1 分量
      expect(edge.view.dir.filter((value) => value !== 0)).toHaveLength(2);
    }
  });
});
