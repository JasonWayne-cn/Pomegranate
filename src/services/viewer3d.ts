/**
 * 三维查看器引擎加载与模型读取。
 *
 * 引擎产物：`public/viewer3d/o3dv.min.js`（Online 3D Viewer 0.18，全局 `OV`）。
 * 使用 File 对象喂给引擎，避免 WebView 对 asset 协议的 CORS / 扩展名限制。
 */
import { sourceFileApi, systemApi } from "@/lib/api";
import { isEncryptedAsset } from "@/lib/assetUrl";
import {
  formatBytes,
  isViewer3dImportable,
  viewer3dFileName,
} from "@/lib/viewer3d";
import {
  forEachViewer3dMaterial,
  meshKeyFromUserData,
  type Viewer3dEmbeddedViewer,
  type Viewer3dEngine,
  type Viewer3dMaterial,
} from "@/lib/viewer3dEngine";
import {
  buildViewer3dCamera,
  cameraDirection,
  type Viewer3dProjection,
  type Viewer3dViewSpec,
} from "@/lib/viewer3dView";

export type {
  Viewer3dColor,
  Viewer3dEdgeSettings,
  Viewer3dEmbedParams,
  Viewer3dEmbeddedViewer,
  Viewer3dEngine,
  Viewer3dMaterial,
  Viewer3dMeshUserData,
  Viewer3dModel,
  Viewer3dNode,
  Viewer3dThreeMesh,
  Viewer3dTreeMesh,
  Viewer3dTreeNode,
  Viewer3dViewerApi,
} from "@/lib/viewer3dEngine";

/** 单文件上限：base64 走 IPC，过大会明显卡顿 */
export const MAX_VIEWER3D_BYTES = 64 * 1024 * 1024;

type WindowWithOV = Window & { OV?: Viewer3dEngine };

let enginePromise: Promise<Viewer3dEngine> | null = null;

/** 动态加载离线引擎（只加载一次，失败后允许重试） */
export function loadViewer3dEngine(): Promise<Viewer3dEngine> {
  const win = window as WindowWithOV;
  if (win.OV) return Promise.resolve(win.OV);
  if (enginePromise) return enginePromise;

  enginePromise = new Promise<Viewer3dEngine>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${import.meta.env.BASE_URL}viewer3d/o3dv.min.js`;
    script.async = true;
    script.onload = () => {
      if (win.OV) {
        resolve(win.OV);
      } else {
        enginePromise = null;
        reject(new Error("三维引擎未正确导出 OV"));
      }
    };
    script.onerror = () => {
      enginePromise = null;
      script.remove();
      reject(new Error("三维引擎加载失败"));
    };
    document.head.appendChild(script);
  });

  return enginePromise;
}

function base64ByteLength(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 把笔记里的 `kb-asset://<rel>` 解析为 File。
 *
 * - 用 File 而非 asset URL：引擎按 File.name 判断扩展名，且不依赖网络/CORS
 * - 加密附件（.enc）暂不支持：密文不能交给解析器
 * - 超过上限直接报错，避免 IPC 与主线程被大字符串拖死
 */
export async function readViewer3dFile(rel: string): Promise<File> {
  if (!isViewer3dImportable(rel)) {
    throw new Error("不支持的三维格式");
  }
  if (isEncryptedAsset(rel)) {
    throw new Error("加密笔记中的三维附件暂不支持预览，请用系统应用打开");
  }

  const abs = await systemApi.resolveAssetAbsolute(rel);
  const base64 = await sourceFileApi.readFileAsBase64(abs);
  const size = base64ByteLength(base64);
  if (size > MAX_VIEWER3D_BYTES) {
    throw new Error(
      `模型文件过大（约 ${formatBytes(size)}），请用系统应用打开，或先压缩为 zip`,
    );
  }

  const bytes = base64ToBytes(base64);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new File([buffer], viewer3dFileName(rel), {
    type: "application/octet-stream",
  });
}

/** 把 Ant Design 主题色（#rrggbb）转成引擎背景色 */
export function themeColorToRgb(
  color: string | undefined,
): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(color ?? "");
  if (!match) return [32, 32, 32];
  const hex = match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

// ───────────────────────── 显示控制 ─────────────────────────

/** 按隐藏网格 key 集合更新可见性（边线复用 mesh.userData，自动跟随） */
export function applyViewer3dVisibility(
  viewer: Viewer3dEmbeddedViewer,
  hiddenKeys: ReadonlySet<string>,
): void {
  viewer.GetViewer().SetMeshesVisibility((userData) => {
    const key = meshKeyFromUserData(userData);
    return key === null || !hiddenKeys.has(key);
  });
}

/** 线框显示：仅作用于面材质，线/边线材质没有 wireframe 属性 */
export function applyViewer3dWireframe(
  viewer: Viewer3dEmbeddedViewer,
  enabled: boolean,
): void {
  viewer.GetViewer().mainModel.EnumerateMeshes((mesh) => {
    forEachViewer3dMaterial(mesh, (material) => {
      if (typeof material.wireframe === "boolean") {
        material.wireframe = enabled;
        material.needsUpdate = true;
      }
    });
  });
  viewer.GetViewer().Render();
}

/** 平滑 / 平面着色（依赖几何体法线，导入器已生成） */
export function applyViewer3dFlatShading(
  viewer: Viewer3dEmbeddedViewer,
  flat: boolean,
): void {
  viewer.GetViewer().mainModel.EnumerateMeshes((mesh) => {
    forEachViewer3dMaterial(mesh, (material) => {
      if (typeof material.flatShading === "boolean") {
        material.flatShading = flat;
        material.needsUpdate = true;
      }
    });
  });
  viewer.GetViewer().Render();
}

/**
 * 记录材质自身的透明度，全局滑杆只做乘算，避免把模型自带的玻璃/半透明材质
 * 在初始 100% 时强制改成不透明。
 */
const originalOpacity = new WeakMap<Viewer3dMaterial, number>();
const originalTransparent = new WeakMap<Viewer3dMaterial, boolean>();
const originalDepthWrite = new WeakMap<Viewer3dMaterial, boolean>();

/**
 * 全局透明度。
 *
 * 引擎按模型材质复用 three.js material，因此这里会影响所有使用同一材质的零件；
 * 若需要"只让选中节点半透明"，需要为节点克隆材质（后续独立实现）。
 */
export function applyViewer3dOpacity(
  viewer: Viewer3dEmbeddedViewer,
  opacity: number,
): void {
  const clamped = Math.min(1, Math.max(0.05, opacity));
  viewer.GetViewer().mainModel.EnumerateMeshes((mesh) => {
    forEachViewer3dMaterial(mesh, (material) => {
      if (!originalOpacity.has(material)) {
        originalOpacity.set(material, material.opacity);
        originalTransparent.set(material, material.transparent);
        originalDepthWrite.set(material, material.depthWrite);
      }

      const baseOpacity = originalOpacity.get(material) ?? 1;
      const value = baseOpacity * clamped;
      material.opacity = value;
      // 只有用户主动调低透明度时才强制 transparent/depthWrite；
      // 100% 时恢复材质自身的设置（可能是玻璃等半透明材质）
      material.transparent =
        clamped < 0.999
          ? true
          : (originalTransparent.get(material) ?? false);
      material.depthWrite =
        clamped < 0.999
          ? false
          : (originalDepthWrite.get(material) ?? true);
      material.needsUpdate = true;
    });
  });
  viewer.GetViewer().Render();
}

/**
 * 实体边线开关。
 *
 * 首次开启会为每个网格生成 EdgesGeometry，大模型可能卡顿数秒。
 * 关闭时只清理边线模型，不会重建主模型。
 */
export function applyViewer3dEdges(
  engine: Viewer3dEngine,
  viewer: Viewer3dEmbeddedViewer,
  enabled: boolean,
): void {
  const edgeColor = new engine.RGBColor(120, 120, 120);
  const settings = new engine.EdgeSettings(enabled, edgeColor, 30);
  viewer.GetViewer().SetEdgeSettings(settings);
}

// ───────────────────────── 视角 ─────────────────────────

/** 当前相机方向（eye - center 归一化） */
export function getViewer3dDirection(
  viewer: Viewer3dEmbeddedViewer,
): [number, number, number] | null {
  try {
    return cameraDirection(viewer.GetViewer().GetCamera());
  } catch {
    return null;
  }
}

/** 切换到标准/等轴测视角并适应窗口 */
export function applyViewer3dView(
  engine: Viewer3dEngine,
  viewer: Viewer3dEmbeddedViewer,
  view: Viewer3dViewSpec,
  projection: Viewer3dProjection = "orthographic",
): void {
  const api = viewer.GetViewer();
  const sphere = api.GetBoundingSphere(() => true);
  if (!sphere) return;

  api.SetProjectionMode(
    projection === "orthographic"
      ? engine.ProjectionMode.Orthographic
      : engine.ProjectionMode.Perspective,
  );
  api.SetCamera(buildViewer3dCamera(engine, view, sphere));
  api.FitSphereToWindow(sphere, false);
  api.AdjustClippingPlanesToSphere(sphere);
}

/** 仅适应窗口，不改变方向 */
export function applyViewer3dFit(viewer: Viewer3dEmbeddedViewer): void {
  const api = viewer.GetViewer();
  const sphere = api.GetBoundingSphere(() => true);
  if (!sphere) return;
  api.FitSphereToWindow(sphere, false);
  api.AdjustClippingPlanesToSphere(sphere);
}

/**
 * 切换透视/正交，保持模型当前位置与视角。
 *
 * 只切换投影方式：引擎用当前相机距离和 fov 推导正交视锥，因此 eye/center/up
 * 不变时两种投影在模型中心平面的成像一致；若再调用 FitSphereToWindow，
 * 会重新计算相机距离导致画面缩放跳变。
 */
export function applyViewer3dProjection(
  engine: Viewer3dEngine,
  viewer: Viewer3dEmbeddedViewer,
  projection: Viewer3dProjection,
): void {
  viewer.GetViewer().SetProjectionMode(
    projection === "orthographic"
      ? engine.ProjectionMode.Orthographic
      : engine.ProjectionMode.Perspective,
  );
}
