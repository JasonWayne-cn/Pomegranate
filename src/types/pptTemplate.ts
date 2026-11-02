/** 用户 PPT 模板（导入自 PPT-Master） */
import type { PptChartMeta, PptChartsIndex } from "./extension";

export interface PptUserTemplate {
  id: string;
  displayName: string;
  description?: string | null;
  dirPath: string;
  sourceKind: string;
  sourcePack?: string | null;
  canvasFormat: string;
  canvasWidth: number;
  canvasHeight: number;
  pageCount: number;
  pageTypes: string[];
  supportsStructured: boolean;
  supportsLegacy: boolean;
  coverFile?: string | null;
  contentHash?: string | null;
  enabled: boolean;
  /** ok | missing | invalid */
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PptTemplatePreview {
  id: string;
  displayName: string;
  description?: string | null;
  sourceKind: string;
  sourcePack?: string | null;
  canvasFormat: string;
  canvasWidth: number;
  canvasHeight: number;
  pageCount: number;
  pageTypes: string[];
  supportsStructured: boolean;
  supportsLegacy: boolean;
  coverFile?: string | null;
  coverSvg?: string | null;
  warnings: string[];
  conflict?: string | null;
  pageTypeMap: Record<string, string>;
}

export type PptTemplateConflictPolicy = "reject" | "overwrite" | "rename";

export interface PptTemplateInstallSelection {
  id: string;
  displayName?: string | null;
  description?: string | null;
  conflict?: PptTemplateConflictPolicy | null;
  keepImages?: boolean | null;
}

export interface PptTemplateInstallInput {
  path: string;
  selections: PptTemplateInstallSelection[];
}

export interface PptTemplateInstallFailure {
  id: string;
  message: string;
}

export interface PptTemplateInstallResult {
  installed: PptUserTemplate[];
  failed: PptTemplateInstallFailure[];
  warnings: string[];
}

export interface PptTemplateReconcileReport {
  added: string[];
  updated: string[];
  removed: string[];
  missing: string[];
  warnings: string[];
}

export interface PptTemplateCatalogEntry {
  id: string;
  nameZh?: string | null;
  descriptionZh?: string | null;
  summary?: string | null;
  canvas_format: string;
  page_count: number;
  page_types: string[];
  source: "extension" | "user" | string;
  structured: number;
  legacy: number;
  supportsStructured: boolean;
  supportsLegacy: boolean;
}

export interface PptTemplateCatalog {
  extensionId?: string | null;
  extensionVersion?: string | null;
  layouts: Record<string, PptTemplateCatalogEntry>;
  charts?: PptChartsIndex | Record<string, PptChartMeta> | null;
}
