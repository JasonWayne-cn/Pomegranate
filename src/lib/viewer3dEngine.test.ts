import { describe, it, expect } from "vitest";
import {
  buildViewer3dTree,
  collectAllMeshKeys,
  collectAllNodeIds,
  collectHiddenMeshKeys,
  forEachViewer3dMaterial,
  meshKeyFromUserData,
  type Viewer3dMaterial,
  type Viewer3dModel,
  type Viewer3dNode,
  type Viewer3dThreeMesh,
} from "./viewer3dEngine";

class FakeNode implements Viewer3dNode {
  constructor(
    private readonly id: number,
    private readonly name: string,
    private readonly meshIndices: number[],
    private readonly children: FakeNode[] = [],
  ) {}

  GetId(): number {
    return this.id;
  }
  GetName(): string {
    return this.name;
  }
  ChildNodeCount(): number {
    return this.children.length;
  }
  GetChildNode(index: number): Viewer3dNode {
    return this.children[index];
  }
  MeshIndexCount(): number {
    return this.meshIndices.length;
  }
  GetMeshIndex(index: number): number {
    return this.meshIndices[index];
  }
}

function makeModel(): Viewer3dModel {
  const root = new FakeNode(0, "", [0, 1], [
    new FakeNode(1, "Part A", [0]),
    new FakeNode(2, "", [0, 1], [new FakeNode(3, "Bolt", [0])]),
  ]);
  return { GetRootNode: () => root };
}

describe("三维结构树", () => {
  it("按节点/网格构建树，空名称使用回退标签", () => {
    const tree = buildViewer3dTree(makeModel(), "YX-50_1.obj");

    expect(tree.label).toBe("YX-50_1.obj");
    expect(tree.meshes.map((mesh) => mesh.key)).toEqual(["0:0", "0:1"]);
    expect(tree.children.map((node) => node.label)).toEqual([
      "Part A",
      "节点 2",
    ]);
    expect(tree.children[1].children[0].label).toBe("Bolt");
    expect(tree.children[1].children[0].meshes[0].key).toBe("3:0");
  });

  it("隐藏节点覆盖整个子树，隐藏网格只影响自身", () => {
    const tree = buildViewer3dTree(makeModel(), "root");

    const onlyMeshes = collectHiddenMeshKeys(
      tree,
      new Set(),
      new Set(["0:1", "3:0"]),
    );
    expect([...onlyMeshes].sort()).toEqual(["0:1", "3:0"]);

    const hideNode2 = collectHiddenMeshKeys(tree, new Set(["n:2"]), new Set());
    expect([...hideNode2].sort()).toEqual(["2:0", "2:1", "3:0"]);

    const hideRoot = collectHiddenMeshKeys(tree, new Set(["n:0"]), new Set());
    expect([...hideRoot].sort()).toEqual([
      "0:0",
      "0:1",
      "1:0",
      "2:0",
      "2:1",
      "3:0",
    ]);
  });

  it("父节点隐藏优先于子节点单独显示", () => {
    const tree = buildViewer3dTree(makeModel(), "root");
    const hidden = collectHiddenMeshKeys(
      tree,
      new Set(["n:2"]),
      new Set(["3:0"]),
    );
    expect(hidden.has("3:0")).toBe(true);
  });

  it("收集全部节点/网格 key", () => {
    const tree = buildViewer3dTree(makeModel(), "root");
    expect(collectAllNodeIds(tree)).toEqual(["n:0", "n:1", "n:2", "n:3"]);
    expect(collectAllMeshKeys(tree)).toHaveLength(6);
  });
});

describe("引擎 userData 与材质遍历", () => {
  it("从 originalMeshInstance 提取网格 key", () => {
    expect(
      meshKeyFromUserData({
        originalMeshInstance: { GetId: () => ({ GetKey: () => "7:2" }) },
      }),
    ).toBe("7:2");
    expect(meshKeyFromUserData({})).toBeNull();
    expect(meshKeyFromUserData(undefined)).toBeNull();
  });

  it("兼容单材质与材质数组", () => {
    const seen: number[] = [];
    const material = { opacity: 1 } as Viewer3dMaterial;
    const single = { material } as unknown as Viewer3dThreeMesh;
    forEachViewer3dMaterial(single, () => seen.push(1));

    const multi = {
      material: [material, material, material],
    } as unknown as Viewer3dThreeMesh;
    forEachViewer3dMaterial(multi, () => seen.push(1));

    expect(seen).toHaveLength(4);
  });
});
