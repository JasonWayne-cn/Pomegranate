/**
 * 三维查看器格式与路径工具（纯函数，不依赖 Tauri / DOM）。
 *
 * 内置引擎可离线解析的格式集合。
 *
 * CAD 格式（step/iges/brep/fcstd）使用 `public/viewer3d/vendor/occt/` 的 OCCT WASM；
 * 3DM / IFC 仍需要 rhino3dm / web-ifc，尚未接入。
 */
export const VIEWER3D_EXTS = [
  "stl",
  "obj",
  "off",
  "ply",
  "3ds",
  "gltf",
  "glb",
  "3mf",
  "amf",
  "dae",
  "fbx",
  "wrl",
  // CAD（OCCT）
  "step",
  "stp",
  "iges",
  "igs",
  "brep",
  "brp",
  "fcstd",
] as const;

/** 引擎支持、但语义不专属于三维的容器格式：只允许显式"作为三维模型插入"时使用 */
export const VIEWER3D_ARCHIVE_EXTS = ["zip"] as const;

/** 工具栏"插入三维模型"可选的完整格式集合 */
export const VIEWER3D_IMPORT_EXTS = [
  ...VIEWER3D_EXTS,
  ...VIEWER3D_ARCHIVE_EXTS,
] as const;

export type Viewer3dExt = (typeof VIEWER3D_EXTS)[number];

/** 需要 OCCT WASM 解析的 CAD 格式 */
export const VIEWER3D_CAD_EXTS = [
  "step",
  "stp",
  "iges",
  "igs",
  "brep",
  "brp",
  "fcstd",
] as const;

/**
 * 从路径/文件名提取小写扩展名（不含点）。
 *
 * 也允许直接传裸扩展名（如 "stl"），方便预览器按已解析的 ext 判断。
 */
export function viewer3dExtOf(pathOrName: string): string {
  const clean = pathOrName.split(/[?#]/)[0].replace(/\\/g, "/");
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const idx = base.lastIndexOf(".");
  if (idx < 0) return base.toLowerCase();
  if (idx === base.length - 1) return "";
  return base.slice(idx + 1).toLowerCase();
}

/** 是否是"语义明确属于三维"的格式（用于附件链接自动路由） */
export function isViewer3dExt(pathOrName: string): boolean {
  return (VIEWER3D_EXTS as readonly string[]).includes(
    viewer3dExtOf(pathOrName),
  );
}

/** 内置引擎能否读取（含显式插入的 zip 模型包） */
export function isViewer3dImportable(pathOrName: string): boolean {
  return (VIEWER3D_IMPORT_EXTS as readonly string[]).includes(
    viewer3dExtOf(pathOrName),
  );
}

/** 是否需要 OCCT WASM 解码（CAD） */
export function isViewer3dCadExt(pathOrName: string): boolean {
  return (VIEWER3D_CAD_EXTS as readonly string[]).includes(
    viewer3dExtOf(pathOrName),
  );
}

/** 取真实的文件名：kb-asset 路径最后一段 */
export function viewer3dFileName(pathOrName: string): string {
  const clean = pathOrName.replace(/\\/g, "/").split(/[?#]/)[0];
  const parts = clean.split("/");
  return parts[parts.length - 1] || "model";
}

/** 人类可读体积 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** 格式展示名（用于卡片徽标） */
export function viewer3dFormatLabel(pathOrName: string): string {
  const ext = viewer3dExtOf(pathOrName);
  return ext ? ext.toUpperCase() : "3D";
}
