/** PPT 多阶段流程的前进复用判断。 */
import type { PptJob } from "@/types/extension";

/** 作业是否已有可复用的草稿（草稿完成或已导出）。 */
export function hasDraft(job?: PptJob | null): boolean {
  return Boolean(
    job &&
      job.status === "succeeded" &&
      (job.stage === "draft_ready" || job.stage === "done"),
  );
}

/** 大纲未改动且版式未变化时，可跳过重新渲染直接进入草稿阶段。 */
export function canReuseDraft(
  job: PptJob | null | undefined,
  planDirty: boolean,
  styleDirty: boolean,
): boolean {
  return hasDraft(job) && !planDirty && !styleDirty;
}

/** 已成功导出且内容未变化时，可跳过重新导出直接进入结果阶段。 */
export function canReuseExport(
  job: PptJob | null | undefined,
  planDirty: boolean,
  styleDirty: boolean,
): boolean {
  return hasDraft(job) && job?.stage === "done" && !planDirty && !styleDirty;
}
