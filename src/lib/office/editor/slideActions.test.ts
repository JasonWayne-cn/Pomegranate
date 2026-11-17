import { describe, expect, it } from "vitest";
import {
  activeAfterDelete,
  activeAfterInsert,
  cycleIndex,
  moveTarget,
} from "./slideActions";

describe("moveTarget", () => {
  it("首页不能上移、末页不能下移", () => {
    expect(moveTarget(0, 3, -1)).toBeNull();
    expect(moveTarget(2, 3, 1)).toBeNull();
    expect(moveTarget(0, 3, 1)).toBe(1);
    expect(moveTarget(2, 3, -1)).toBe(1);
  });

  it("单页时两个方向都不可移动", () => {
    expect(moveTarget(0, 1, -1)).toBeNull();
    expect(moveTarget(0, 1, 1)).toBeNull();
  });
});

describe("activeAfterDelete", () => {
  it("删除中间页后保持下标", () => {
    expect(activeAfterDelete(1, 3)).toBe(1);
  });

  it("删除末页后回退一页", () => {
    expect(activeAfterDelete(2, 3)).toBe(1);
  });

  it("只剩一页时钳制为 0", () => {
    expect(activeAfterDelete(0, 1)).toBe(0);
    expect(activeAfterDelete(5, 1)).toBe(0);
  });
});

describe("activeAfterInsert", () => {
  it("插入后激活新页", () => {
    expect(activeAfterInsert(0, 3)).toBe(1);
    expect(activeAfterInsert(2, 3)).toBe(3);
  });
});

describe("cycleIndex", () => {
  it("循环并支持反向", () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(-1, 3, 1)).toBe(0);
    expect(cycleIndex(-1, 3, -1)).toBe(2);
  });

  it("空列表返回 -1", () => {
    expect(cycleIndex(0, 0, 1)).toBe(-1);
  });
});
