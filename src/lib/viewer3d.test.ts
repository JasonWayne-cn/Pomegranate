import { describe, it, expect } from "vitest";
import {
  formatBytes,
  isViewer3dCadExt,
  isViewer3dExt,
  isViewer3dImportable,
  viewer3dExtOf,
  viewer3dFileName,
} from "./viewer3d";

describe("三维格式识别", () => {
  it("识别常见模型扩展名（大小写不敏感）", () => {
    expect(isViewer3dExt("model.stl")).toBe(true);
    expect(isViewer3dExt("MODEL.GLB")).toBe(true);
    expect(isViewer3dExt("a/b/零件.STL?v=1")).toBe(true);
    expect(isViewer3dExt("a\\b\\model.obj")).toBe(true);
  });

  it.each(["step", "stp", "iges", "igs", "brep", "brp", "fcstd"])(
    "OCCT CAD 格式 %s 可识别",
    (ext) => {
      expect(isViewer3dExt(`a/b/零件.${ext}`)).toBe(true);
      expect(isViewer3dImportable(`a/b/零件.${ext.toUpperCase()}`)).toBe(true);
      expect(isViewer3dCadExt(`a/b/零件.${ext}`)).toBe(true);
    },
  );

  it("普通网格格式不误判为 CAD", () => {
    expect(isViewer3dCadExt("model.stl")).toBe(false);
    expect(isViewer3dCadExt("model.glb")).toBe(false);
  });

  it("zip 默认不自动路由到三维，但可由节点显式导入", () => {
    expect(isViewer3dExt("models/bundle.zip")).toBe(false);
    expect(isViewer3dImportable("models/bundle.zip")).toBe(true);
    expect(isViewer3dImportable("report.docx")).toBe(false);
  });

  it("裸扩展名也能判断", () => {
    expect(viewer3dExtOf("glb")).toBe("glb");
    expect(isViewer3dExt("glb")).toBe(true);
  });

  it("从路径取文件名", () => {
    expect(viewer3dFileName("kb_assets/attachments/1/model.sTL")).toBe(
      "model.sTL",
    );
    expect(viewer3dFileName("a\\b\\模型.glb")).toBe("模型.glb");
  });

  it("体积格式化", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
