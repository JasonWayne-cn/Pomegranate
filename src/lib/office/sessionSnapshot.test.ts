import { describe, expect, it } from "vitest";
import { parseSessionSnapshot } from "./sessionSnapshot";

describe("parseSessionSnapshot", () => {
  it("解析有效快照", () => {
    expect(
      parseSessionSnapshot('{"paths":["a.pptx","b.docx"],"activePath":"b.docx"}'),
    ).toEqual({ paths: ["a.pptx", "b.docx"], activePath: "b.docx" });
  });

  it("过滤非法条目", () => {
    expect(parseSessionSnapshot('{"paths":["a.pptx",1,null,""],"activePath":7}')).toEqual({
      paths: ["a.pptx"],
      activePath: null,
    });
  });

  it("无效输入返回 null", () => {
    expect(parseSessionSnapshot(null)).toBeNull();
    expect(parseSessionSnapshot("not-json")).toBeNull();
    expect(parseSessionSnapshot('{"paths":[]}')).toBeNull();
    expect(parseSessionSnapshot('{"paths":"x"}')).toBeNull();
  });
});
