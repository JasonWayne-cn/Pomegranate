/**
 * Online 3D Viewer 引擎最小类型面 + 结构树纯逻辑。
 *
 * 引擎全局 `OV` 由 `public/viewer3d/o3dv.min.js` 注入。esbuild 只压缩标识符，
 * 不 mangle 属性名，因此这里声明的 `GetModel / GetViewer / mainModel` 等方法
 * 在压缩产物中仍然可用。
 */

export interface Viewer3dMeshUserData {
  originalMeshInstance?: {
    GetId(): { GetKey(): string };
  };
}

export interface Viewer3dMaterial {
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
  wireframe?: boolean;
  flatShading?: boolean;
  needsUpdate: boolean;
}

export interface Viewer3dThreeMesh {
  material: Viewer3dMaterial | Viewer3dMaterial[];
  visible: boolean;
  userData: Viewer3dMeshUserData;
}

export interface Viewer3dNode {
  GetId(): number;
  GetName(): string;
  ChildNodeCount(): number;
  GetChildNode(index: number): Viewer3dNode;
  /** 注意：Node 上是 MeshIndexCount，Model 上才是 MeshCount */
  MeshIndexCount(): number;
  GetMeshIndex(index: number): number;
}

export interface Viewer3dModel {
  GetRootNode(): Viewer3dNode;
}

export interface Viewer3dMainModel {
  EnumerateMeshes(callback: (mesh: Viewer3dThreeMesh) => void): void;
  EnumerateLines(callback: (mesh: Viewer3dThreeMesh) => void): void;
  EnumerateEdges(callback: (mesh: Viewer3dThreeMesh) => void): void;
}

/** 引擎类实例只做不透明占位，避免引入 any */
export interface Viewer3dColor {
  readonly __viewer3dColor?: never;
}

export interface Viewer3dEdgeSettings {
  readonly __viewer3dEdgeSettings?: never;
}

export interface Viewer3dEmbedParams {
  backgroundColor?: Viewer3dColor;
  onModelLoaded?: () => void;
  onModelLoadFailed?: () => void;
}

export interface Viewer3dCoord3D {
  x: number;
  y: number;
  z: number;
}

export interface Viewer3dCamera {
  eye: Viewer3dCoord3D;
  center: Viewer3dCoord3D;
  up: Viewer3dCoord3D;
  fov: number;
}

export interface Viewer3dBoundingSphere {
  center: { x: number; y: number; z: number };
  radius: number;
}

export interface Viewer3dViewerApi {
  mainModel: Viewer3dMainModel;
  SetMeshesVisibility(
    isVisible: (userData: Viewer3dMeshUserData) => boolean,
  ): void;
  SetEdgeSettings(settings: Viewer3dEdgeSettings): void;
  Render(): void;
  GetCamera(): Viewer3dCamera;
  SetCamera(camera: Viewer3dCamera): void;
  SetProjectionMode(mode: number): void;
  FitSphereToWindow(
    sphere: Viewer3dBoundingSphere,
    animation: boolean,
  ): void;
  GetBoundingSphere(
    needToProcess: (userData: Viewer3dMeshUserData) => boolean,
  ): Viewer3dBoundingSphere | null;
  AdjustClippingPlanesToSphere(sphere: Viewer3dBoundingSphere): void;
}

export interface Viewer3dEmbeddedViewer {
  LoadModelFromFileList(files: File[]): void;
  LoadModelFromUrlList(urls: string[]): void;
  Resize(): void;
  Destroy(): void;
  GetModel(): Viewer3dModel | null;
  GetViewer(): Viewer3dViewerApi;
}

export interface Viewer3dEngine {
  EmbeddedViewer: new (
    parent: HTMLElement,
    params: Viewer3dEmbedParams,
  ) => Viewer3dEmbeddedViewer;
  RGBAColor: new (
    r: number,
    g: number,
    b: number,
    a: number,
  ) => Viewer3dColor;
  RGBColor: new (r: number, g: number, b: number) => Viewer3dColor;
  EdgeSettings: new (
    showEdges: boolean,
    edgeColor: Viewer3dColor,
    edgeThreshold: number,
  ) => Viewer3dEdgeSettings;
  /** OV.Coord3D，用于构造相机 eye/center/up */
  Coord3D: new (x: number, y: number, z: number) => Viewer3dCoord3D;
  /** OV.Camera，必须使用引擎类实例（FitSphereToWindow 内部会调用 Camera.Clone） */
  Camera: new (
    eye: Viewer3dCoord3D,
    center: Viewer3dCoord3D,
    up: Viewer3dCoord3D,
    fov: number,
  ) => Viewer3dCamera;
  /** OV.ProjectionMode 枚举 */
  ProjectionMode: {
    Perspective: number;
    Orthographic: number;
  };
}

// ───────────────────────── 结构树 ─────────────────────────

export interface Viewer3dTreeMesh {
  /** 与 `MeshInstanceId.GetKey()` 一致：`<nodeId>:<meshIndex>` */
  key: string;
  label: string;
}

export interface Viewer3dTreeNode {
  /** UI 唯一键：`n:<nodeId>` */
  id: string;
  nodeId: number;
  label: string;
  meshes: Viewer3dTreeMesh[];
  children: Viewer3dTreeNode[];
}

function buildNode(
  node: Viewer3dNode,
  fallbackLabel: string,
): Viewer3dTreeNode {
  const nodeId = node.GetId();
  const meshCount = node.MeshIndexCount();
  const meshes: Viewer3dTreeMesh[] = [];
  for (let i = 0; i < meshCount; i += 1) {
    const meshIndex = node.GetMeshIndex(i);
    meshes.push({
      key: `${nodeId}:${meshIndex}`,
      label: meshCount > 1 ? `网格 ${i + 1}` : "网格",
    });
  }

  const children: Viewer3dTreeNode[] = [];
  const childCount = node.ChildNodeCount();
  for (let i = 0; i < childCount; i += 1) {
    const child = node.GetChildNode(i);
    children.push(buildNode(child, `节点 ${child.GetId()}`));
  }

  const name = node.GetName()?.trim();
  return {
    id: `n:${nodeId}`,
    nodeId,
    label: name || fallbackLabel,
    meshes,
    children,
  };
}

/** 把引擎模型树转换为可渲染的纯数据树 */
export function buildViewer3dTree(
  model: Viewer3dModel,
  rootLabel: string,
): Viewer3dTreeNode {
  return buildNode(model.GetRootNode(), rootLabel);
}

/**
 * 计算当前应隐藏的网格 key 集合。
 * 节点隐藏会覆盖整个子树；网格自身的隐藏状态在父节点重新显示后保留。
 */
export function collectHiddenMeshKeys(
  root: Viewer3dTreeNode,
  hiddenNodes: ReadonlySet<string>,
  hiddenMeshes: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();

  function walk(node: Viewer3dTreeNode, ancestorHidden: boolean): void {
    const selfHidden = ancestorHidden || hiddenNodes.has(node.id);
    for (const mesh of node.meshes) {
      if (selfHidden || hiddenMeshes.has(mesh.key)) {
        hidden.add(mesh.key);
      }
    }
    for (const child of node.children) {
      walk(child, selfHidden);
    }
  }

  walk(root, false);
  return hidden;
}

export function collectAllNodeIds(root: Viewer3dTreeNode): string[] {
  const ids: string[] = [];
  function walk(node: Viewer3dTreeNode): void {
    ids.push(node.id);
    node.children.forEach(walk);
  }
  walk(root);
  return ids;
}

export function collectAllMeshKeys(root: Viewer3dTreeNode): string[] {
  const keys: string[] = [];
  function walk(node: Viewer3dTreeNode): void {
    node.meshes.forEach((mesh) => keys.push(mesh.key));
    node.children.forEach(walk);
  }
  walk(root);
  return keys;
}

/** 从引擎 mesh.userData 提取网格 key；无法识别时返回 null（视为可见） */
export function meshKeyFromUserData(
  userData: Viewer3dMeshUserData | undefined,
): string | null {
  const instance = userData?.originalMeshInstance;
  if (!instance) return null;
  try {
    return instance.GetId().GetKey();
  } catch {
    return null;
  }
}

/** three.js Mesh.material 可能是数组，统一遍历 */
export function forEachViewer3dMaterial(
  mesh: Viewer3dThreeMesh,
  fn: (material: Viewer3dMaterial) => void,
): void {
  const material = mesh.material;
  if (Array.isArray(material)) {
    material.forEach(fn);
  } else if (material) {
    fn(material);
  }
}
