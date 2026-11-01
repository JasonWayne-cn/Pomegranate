import { invoke } from "@tauri-apps/api/core";
import type {
  ExtensionInfo,
  ExtensionInspection,
  ExtensionVersionInfo,
  PptCatalog,
  PptDraftPage,
  PptExtensionStatus,
  PptJob,
  PptJobInput,
  PptLocalFileSource,
  PptMetaSource,
  PptMetaSuggestion,
  PptPageSelection,
  PptPlan,
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
    } = {},
  ) =>
    invoke<void>("ppt_extension_render_draft", {
      jobId,
      plan: options.plan ?? null,
      layoutId: options.layoutId ?? null,
      chartIds: options.chartIds ?? null,
      nativeCharts: options.nativeCharts ?? null,
    }),
  renderAiDraft: (jobId: string, candidateCount = 2) =>
    invoke<void>("ppt_extension_render_ai_draft", { jobId, candidateCount }),
  regenerateAiPage: (jobId: string, page: number, candidateCount = 2) =>
    invoke<void>("ppt_extension_regenerate_ai_page", {
      jobId,
      page,
      candidateCount,
    }),
  getPageSelection: (jobId: string) =>
    invoke<PptPageSelection>("ppt_extension_page_selection", { jobId }),
  rerenderDraft: (
    jobId: string,
    options: {
      plan?: PptPlan | null;
      layoutId?: string | null;
      chartIds?: string[] | null;
      nativeCharts?: boolean | null;
    } = {},
  ) =>
    invoke<void>("ppt_extension_rerender_draft", {
      jobId,
      plan: options.plan ?? null,
      layoutId: options.layoutId ?? null,
      chartIds: options.chartIds ?? null,
      nativeCharts: options.nativeCharts ?? null,
    }),
  exportDraft: (jobId: string, exportDir?: string | null) =>
    invoke<void>("ppt_extension_export_draft", { jobId, exportDir }),
  listDraftPages: (jobId: string) =>
    invoke<PptDraftPage[]>("ppt_extension_list_draft_pages", { jobId }),
  readDraftPage: (jobId: string, file: string) =>
    invoke<string>("ppt_extension_read_draft_page", { jobId, file }),
  cancelJob: (jobId: string) =>
    invoke<void>("ppt_extension_cancel_job", { jobId }),
  cancelPlanning: (planningId: string) =>
    invoke<void>("ppt_extension_cancel_planning", { planningId }),
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
    },
  ) =>
    invoke<PptJob>("ppt_extension_update_job_options", {
      jobId,
      layoutId: options.layoutId,
      chartIds: options.chartIds,
      nativeCharts: options.nativeCharts,
      timeoutSecs: options.timeoutSecs ?? null,
    }),
  retryJob: (jobId: string) =>
    invoke<PptJob>("ppt_extension_retry_job", { jobId }),
  deleteJob: (jobId: string) =>
    invoke<boolean>("ppt_extension_delete_job", { jobId }),
  exportDiagnostics: (jobId: string, targetDir: string) =>
    invoke<string>("ppt_extension_export_diagnostics", { jobId, targetDir }),
};
