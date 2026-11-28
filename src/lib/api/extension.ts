import { invoke } from "@tauri-apps/api/core";
import type {
  ExtensionInfo,
  ExtensionInspection,
  ExtensionVersionInfo,
  PptCatalog,
  PptDraftKind,
  PptDraftPage,
  PptDraftStatus,
  PptExtensionStatus,
  PptJob,
  PptJobInput,
  PptLocalFileSource,
  PptMetaSource,
  PptMetaSuggestion,
  PptPageCandidatesResponse,
  PptPageSelection,
  PptPlan,
  PptSlide,
  PptSourceMeta,
} from "@/types/extension";

export const extensionApi = {
  list: () => invoke<ExtensionInfo[]>("extension_list"),
  inspectZip: (path: string) =>
    invoke<ExtensionInspection>("extension_inspect_zip", { path }),
  installZip: (path: string) =>
    invoke<ExtensionInfo>("extension_install_zip", { path }),
  enable: (id: string) => invoke<void>("extension_enable", { id }),
  disable: (id: string) => invoke<void>("extension_disable", { id }),
  uninstall: (id: string) => invoke<boolean>("extension_uninstall", { id }),
  verify: (id: string) => invoke<boolean>("extension_verify", { id }),
  readTextAsset: (id: string, relativePath: string) =>
    invoke<string>("extension_read_text_asset", { id, relativePath }),
  pptCatalog: (id = "ppt-master") =>
    invoke<PptCatalog>("extension_ppt_catalog", { id }),
  pptLayoutPreview: (id: string, layoutId: string) =>
    invoke<string>("extension_ppt_layout_preview", { id, layoutId }),
  listVersions: (id: string) =>
    invoke<ExtensionVersionInfo[]>("extension_list_versions", { id }),
  rollback: (id: string, version: string) =>
    invoke<ExtensionInfo>("extension_rollback", { id, version }),
};

export const pptExtensionApi = {
  status: () => invoke<PptExtensionStatus>("ppt_extension_status"),
  suggestMeta: (sources: PptMetaSource[], modelId?: number | null) =>
    invoke<PptMetaSuggestion>("ppt_extension_suggest_meta", {
      sources,
      modelId: modelId ?? null,
    }),
  extractLocalFile: (path: string) =>
    invoke<PptLocalFileSource>("ppt_extension_extract_local_file", { path }),
  createJob: (input: PptJobInput) =>
    invoke<PptJob>("ppt_extension_create_job", { input }),
  startJob: (jobId: string, exportDir?: string | null) =>
    invoke<void>("ppt_extension_start_job", { jobId, exportDir }),
  renderDraft: (
    jobId: string,
    options: {
      plan?: PptPlan | null;
      layoutId?: string | null;
      chartIds?: string[] | null;
      nativeCharts?: boolean | null;
      kind?: PptDraftKind;
    } = {},
  ) =>
    invoke<void>("ppt_extension_render_draft", {
      jobId,
      plan: options.plan ?? null,
      layoutId: options.layoutId ?? null,
      chartIds: options.chartIds ?? null,
      nativeCharts: options.nativeCharts ?? null,
      kind: options.kind ?? "formal",
    }),
  renderAiDraft: (
    jobId: string,
    candidateCount = 3,
    mode: "bestOf" | "oneShot" | "programmatic" = "bestOf",
  ) =>
    invoke<void>("ppt_extension_render_ai_draft", {
      jobId,
      candidateCount,
      mode,
    }),
  regenerateAiPage: (
    jobId: string,
    page: number,
    candidateCount = 3,
    modelId: number | null = null,
    instruction: string | null = null,
  ) =>
    invoke<void>("ppt_extension_regenerate_ai_page", {
      jobId,
      page,
      candidateCount,
      modelId,
      instruction,
    }),
  getJobOptions: (jobId: string) =>
    invoke<Record<string, unknown>>("ppt_extension_job_options", { jobId }),
  /** 历史作业的素材清单（恢复“素材来源”列表） */
  jobSources: (jobId: string) =>
    invoke<PptSourceMeta[]>("ppt_extension_job_sources", { jobId }),
  /** 移除历史作业的一项素材，同步 source.md 与清单 */
  removeJobSource: (jobId: string, sourceId: number, path?: string | null) =>
    invoke<PptSourceMeta[]>("ppt_extension_remove_job_source", {
      jobId,
      sourceId,
      path: path ?? null,
    }),
  /** 读取素材理解（understanding.md），不存在时返回空串 */
  readUnderstanding: (jobId: string) =>
    invoke<string>("ppt_extension_read_understanding", { jobId }),
  /** 读取已落盘的步骤日志（切换/重开作业回填） */
  readStepLogs: (jobId: string) =>
    invoke<{
      material: string[];
      understanding: string[];
      planning: string[];
      engine: string[];
    }>("ppt_extension_read_step_logs", { jobId }),
  /** 素材理解文件路径 */
  understandingFile: (jobId: string) =>
    invoke<string>("ppt_extension_understanding_file", { jobId }),
  /** 补充素材文件路径（不存在时为 null） */
  manualSourceFile: (jobId: string) =>
    invoke<string | null>("ppt_extension_manual_source_file", { jobId }),
  /** 单条素材对应的源文件路径 */
  sourceItemFile: (jobId: string, sourceId: number, path?: string | null) =>
    invoke<string>("ppt_extension_source_item_file", {
      jobId,
      sourceId,
      path: path ?? null,
    }),
  /** 删除补充素材 manual.md */
  deleteManualSource: (jobId: string) =>
    invoke<void>("ppt_extension_delete_manual_source", { jobId }),
  /** 生成或重新生成素材理解 */
  buildUnderstanding: (jobId: string, modelId?: number | null, force = false) =>
    invoke<string>("ppt_extension_build_understanding", {
      jobId,
      modelId: modelId ?? null,
      force,
    }),
  /** 向历史作业追加素材 */
  appendJobSources: (
    jobId: string,
    noteIds: number[],
    localFiles: {
      path: string;
      title?: string;
      sourceType?: string;
      text?: string;
    }[],
    manualText?: string,
  ) =>
    invoke<PptSourceMeta[]>("ppt_extension_append_job_sources", {
      jobId,
      noteIds,
      localFiles: localFiles.map((file) => ({
        path: file.path,
        title: file.title ?? "",
        sourceType: file.sourceType ?? "",
        text: file.text ?? "",
      })),
      manualText: manualText ?? "",
    }),
  getSourceFile: (jobId: string) =>
    invoke<string>("ppt_extension_source_file", { jobId }),
  getPageSelection: (jobId: string) =>
    invoke<PptPageSelection>("ppt_extension_page_selection", { jobId }),
  /** 草稿页级指纹状态：用于导出前置校验与界面提示。 */
  draftStatus: (jobId: string) =>
    invoke<PptDraftStatus>("ppt_extension_draft_status", { jobId }),
  getPageCandidates: (jobId: string, page: number) =>
    invoke<PptPageCandidatesResponse>("ppt_extension_page_candidates", {
      jobId,
      page,
    }),
  selectPageCandidate: (jobId: string, page: number, index: number) =>
    invoke<void>("ppt_extension_select_page_candidate", {
      jobId,
      page,
      index,
    }),
  rerenderDraft: (
    jobId: string,
    options: {
      plan?: PptPlan | null;
      layoutId?: string | null;
      chartIds?: string[] | null;
      nativeCharts?: boolean | null;
      kind?: PptDraftKind;
    } = {},
  ) =>
    invoke<void>("ppt_extension_rerender_draft", {
      jobId,
      plan: options.plan ?? null,
      layoutId: options.layoutId ?? null,
      chartIds: options.chartIds ?? null,
      nativeCharts: options.nativeCharts ?? null,
      kind: options.kind ?? "formal",
    }),
  exportDraft: (jobId: string, exportDir?: string | null) =>
    invoke<void>("ppt_extension_export_draft", { jobId, exportDir }),
  listDraftPages: (jobId: string, kind: PptDraftKind = "formal") =>
    invoke<PptDraftPage[]>("ppt_extension_list_draft_pages", { jobId, kind }),
  readDraftPage: (jobId: string, file: string, kind: PptDraftKind = "formal") =>
    invoke<string>("ppt_extension_read_draft_page", { jobId, file, kind }),
  cancelJob: (jobId: string) =>
    invoke<void>("ppt_extension_cancel_job", { jobId }),
  /** 暂停 AI 草稿生成（页块边界生效，已完成页保留） */
  pauseJob: (jobId: string) =>
    invoke<void>("ppt_extension_pause_job", { jobId }),
  /** 继续已暂停的 AI 草稿生成 */
  resumeJob: (jobId: string) =>
    invoke<void>("ppt_extension_resume_job", { jobId }),
  /** 查询作业是否处于暂停状态（重新进入页面时恢复界面用） */
  jobPaused: (jobId: string) =>
    invoke<boolean>("ppt_extension_job_paused", { jobId }),
  /** 恢复作业：running 但本进程已无生成循环时标记为中断失败 */
  recoverJob: (jobId: string) =>
    invoke<PptJob | null>("ppt_extension_recover_job", { jobId }),
  cancelPlanning: (planningId: string) =>
    invoke<void>("ppt_extension_cancel_planning", { planningId }),
  /** 暂停大纲规划（在阶段/分块边界生效） */
  pausePlanning: (planningId: string) =>
    invoke<void>("ppt_extension_pause_planning", { planningId }),
  /** 继续已暂停的大纲规划 */
  resumePlanning: (planningId: string) =>
    invoke<void>("ppt_extension_resume_planning", { planningId }),
  /** 查询大纲规划是否暂停 */
  planningPaused: (planningId: string) =>
    invoke<boolean>("ppt_extension_planning_paused", { planningId }),
  getJob: (jobId: string) =>
    invoke<PptJob | null>("ppt_extension_get_job", { jobId }),
  listJobs: (limit = 30) =>
    invoke<PptJob[]>("ppt_extension_list_jobs", { limit }),
  cleanupJobs: (keepLatest = 10) =>
    invoke<number>("ppt_extension_cleanup_jobs", { keepLatest }),
  getPlan: (jobId: string) =>
    invoke<PptPlan>("ppt_extension_get_plan", { jobId }),
  updatePlan: (jobId: string, plan: PptPlan) =>
    invoke<PptPlan>("ppt_extension_update_plan", { jobId, plan }),
  /** 仅更新单页大纲，不清空已有草稿 */
  patchPlanSlide: (jobId: string, slide: PptSlide) =>
    invoke<void>("ppt_extension_patch_plan_slide", { jobId, slide }),
  regeneratePlan: (
    jobId: string,
    slideCount?: number | null,
    modelId?: number | null,
    planningId?: string | null,
  ) =>
    invoke<PptPlan>("ppt_extension_regenerate_plan", {
      jobId,
      slideCount: slideCount ?? null,
      modelId: modelId ?? null,
      planningId: planningId ?? null,
    }),
  validatePlan: (plan: PptPlan) =>
    invoke<PptPlan>("ppt_extension_validate_plan", { plan }),
  updateJobOptions: (
    jobId: string,
    options: {
      layoutId: string | null;
      chartIds: string[];
      nativeCharts: boolean;
      timeoutSecs?: number | null;
      modelId?: number | null;
    },
  ) =>
    invoke<PptJob>("ppt_extension_update_job_options", {
      jobId,
      layoutId: options.layoutId,
      chartIds: options.chartIds,
      nativeCharts: options.nativeCharts,
      timeoutSecs: options.timeoutSecs ?? null,
      modelId: options.modelId ?? null,
    }),
  retryJob: (jobId: string) =>
    invoke<PptJob>("ppt_extension_retry_job", { jobId }),
  deleteJob: (jobId: string) =>
    invoke<boolean>("ppt_extension_delete_job", { jobId }),
  exportDiagnostics: (jobId: string, targetDir: string) =>
    invoke<string>("ppt_extension_export_diagnostics", { jobId, targetDir }),
};
