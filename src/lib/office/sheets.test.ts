import { describe, expect, it } from "vitest";
import { buildSheetGrid, columnLabel, excelRowNumber, pushCapped } from "./sheets";

describe("columnLabel", () => {
  it("生成 Excel 列字母", () => {
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(1)).toBe("B");
    expect(columnLabel(25)).toBe("Z");
    expect(columnLabel(26)).toBe("AA");
    expect(columnLabel(27)).toBe("AB");
    expect(columnLabel(51)).toBe("AZ");
    expect(columnLabel(52)).toBe("BA");
    expect(columnLabel(701)).toBe("ZZ");
    expect(columnLabel(702)).toBe("AAA");
  });
});

describe("buildSheetGrid", () => {
  const sheet = {
    headers: ["银行", "金额"],
    rows: [
      ["广发", "20"],
      ["南京", "20"],
    ],
  };

  it("表头行作为第一行", () => {
    const grid = buildSheetGrid(sheet);
    expect(grid).toHaveLength(3);
    expect(grid[0]).toMatchObject({ key: -1, header: true, cells: ["银行", "金额"] });
    expect(grid[1]).toMatchObject({ key: 0, header: false, cells: ["广发", "20"] });
  });

  it("行号从 1 开始且连续", () => {
    const grid = buildSheetGrid(sheet);
    expect(grid.map(excelRowNumber)).toEqual([1, 2, 3]);
  });
});

describe("pushCapped", () => {
  it("未超限时追加", () => {
    expect(pushCapped([1], 2, 3)).toEqual([1, 2]);
  });

  it("超限时丢弃最旧项", () => {
    expect(pushCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });
});
