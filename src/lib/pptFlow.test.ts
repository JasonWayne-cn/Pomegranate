import { describe, expect, it } from "vitest";
import { canReuseDraft, canReuseExport, hasDraft } from "./pptFlow";
import type { PptJob } from "@/types/extension";

function job(stage: string, status = "succeeded"): PptJob {
  return {
    id: "job-1",
    extensionId: "ppt-master",
    status,
    stage,
    title: "测试",
    workspacePath: "/tmp/job-1",
    createdAt: "2026-11-01T00:00:00Z",
  };
}

describe("pptFlow", () => {
  it("只有草稿完成或已导出才算有草稿", () => {
    expect(hasDraft(job("draft_ready"))).toBe(true);
    expect(hasDraft(job("done"))).toBe(true);
    expect(hasDraft(job("outline_ready"))).toBe(false);
    expect(hasDraft(job("rendering_draft"))).toBe(false);
    expect(hasDraft(job("draft_ready", "failed"))).toBe(false);
    expect(hasDraft(null)).toBe(false);
  });

  it("大纲或风格有改动时不能复用草稿", () => {
    expect(canReuseDraft(job("draft_ready"), false, false)).toBe(true);
    expect(canReuseDraft(job("draft_ready"), true, false)).toBe(false);
    expect(canReuseDraft(job("draft_ready"), false, true)).toBe(false);
  });

  it("只有已导出且内容未变时才能复用导出", () => {
    expect(canReuseExport(job("done"), false, false)).toBe(true);
    expect(canReuseExport(job("draft_ready"), false, false)).toBe(false);
    expect(canReuseExport(job("done"), true, false)).toBe(false);
    expect(canReuseExport(job("done"), false, true)).toBe(false);
  });
});
