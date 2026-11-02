import { invoke } from "@tauri-apps/api/core";
import type {
  PptTemplateCatalog,
  PptTemplateInstallInput,
  PptTemplateInstallResult,
  PptTemplatePreview,
  PptTemplateReconcileReport,
  PptUserTemplate,
} from "@/types/pptTemplate";

export const pptTemplateApi = {
  inspect: (path: string) =>
    invoke<PptTemplatePreview[]>("ppt_template_inspect", { path }),
  install: (input: PptTemplateInstallInput) =>
    invoke<PptTemplateInstallResult>("ppt_template_install", { input }),
  list: () => invoke<PptUserTemplate[]>("ppt_template_list"),
  catalog: () => invoke<PptTemplateCatalog>("ppt_template_catalog"),
  preview: (id: string) => invoke<string>("ppt_template_preview", { id }),
  rename: (id: string, displayName: string, description?: string | null) =>
    invoke<void>("ppt_template_rename", { id, displayName, description }),
  setEnabled: (id: string, enabled: boolean) =>
    invoke<void>("ppt_template_set_enabled", { id, enabled }),
  remove: (id: string) => invoke<boolean>("ppt_template_delete", { id }),
  verify: (id: string) => invoke<boolean>("ppt_template_verify", { id }),
  exportPack: (id: string, target: string) =>
    invoke<string>("ppt_template_export", { id, target }),
  reconcile: () =>
    invoke<PptTemplateReconcileReport>("ppt_template_reconcile"),
};
