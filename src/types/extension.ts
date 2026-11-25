/** 功能扩展包（Engine Pack）类型 */

export interface ExtensionPythonRuntime {
  min?: string | null;
  max?: string | null;
  path?: string | null;
}

export interface ExtensionRuntime {
  type: string;
  entry: string;
  protocol?: string | null;
  python?: ExtensionPythonRuntime | null;
}

export interface ExtensionManifest {
  schemaVersion: number;
  apiVersion: number;
  protocolVersion: number;
  id: string;
  name: string;
  version: string;
  kind: string;
  minAppVersion?: string | null;
  platforms: string[];
  runtime: ExtensionRuntime;
  permissions: string[];
  contributes: Record<string, unknown>;
  integrity?: { sha256?: string | null; signature?: string | null } | null;
}

export interface ExtensionVersionInfo {
  version: string;
  path: string;
  contentHash: string;
  isCurrent: boolean;
  installedAt: string;
}

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  kind: string;
  path: string;
  enabled: boolean;
  status: string;
  contentHash: string;
  permissions: string[];
  supportsPpt: boolean;
  installedAt: string;
  updatedAt: string;
  manifest: ExtensionManifest;
}

export interface ExtensionInspection {
  manifest: ExtensionManifest;
  compatible: boolean;
  reason?: string | null;
  fileCount: number;
  uncompressedBytes: number;
  contentHash: string;
  rootPrefix?: string | null;
}

export interface PptExtensionStatus {
  installed: boolean;
  enabled: boolean;
  version?: string | null;
  supportsPpt: boolean;
  path?: string;
  integrityOk?: boolean;
  platform?: string;
  platformCompatible?: boolean;
  win7?: boolean;
  apiVersion?: number;
  protocolVersion?: number;
  embeddedPython?: boolean;
}

export interface PptLocalFileSource {
  path: string;
  title: string;
  sourceType: string;
  text: string;
  wordCount: number;
}

export interface PptLocalFileInput {
  path: string;
  title: string;
  sourceType: string;
  text?: string;
}

export interface PptMetaSource {
  title: string;
  sourceType: string;
  excerpt: string;
}

export interface PptMetaSuggestion {
  title: string;
  audience: string;
}

export interface PptJobInput {
  noteIds: number[];
  mountNoteIds: number[];
  localFiles: PptLocalFileInput[];
  manualText: string;
  title: string;
  audience: string;
  slideCount?: number | null;
  layoutId?: string | null;
  chartIds: string[];
  language?: string | null;
  extraRequirements?: string | null;
  exportDir?: string | null;
  modelId?: number | null;
  planningId?: string | null;
  timeoutSecs?: number | null;
  nativeCharts?: boolean | null;
}

export interface PptChartData {
  type: string;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
}

export interface PptContentBlock {
  label: string;
  text: string;
  detail: string;
}

export interface PptSlide {
  page: number;
  title: string;
  coreMessage: string;
  bullets: string[];
  chart?: PptChartData | null;
  images?: string[];
  /** 页面主题，相邻页不重复 */
  pageTheme?: string;
  /** 本页一句话主张 */
  mainClaim?: string;
  /** 本页内容范围 */
  contentScope?: string;
  /** 结构化内容块 */
  contentBlocks?: PptContentBlock[];
  /** 来自素材的证据或事实 */
  evidence?: string[];
  /** timeline | category | compare | cause | process | none */
  relation?: string;
  /** cards | timeline | process | matrix | compare | highlight | summary */
  chartType?: string;
  /** anchor | dense | breathing | balanced */
  density?: string;
  /** 视觉意图说明 */
  visualIntent?: string;
  /** 演讲备注 */
  speakerNote?: string;
}

export interface PptPlan {
  title: string;
  slides: PptSlide[];
}

export type PptJobStage =
  | "style"
  | "outline_ready"
  | "rendering_draft"
  | "draft_ready"
  | "exporting"
  | "done";

export interface PptDraftPage {
  file: string;
  page: number;
  title: string;
}

export interface PptPageCandidateScore {
  score: number;
  issues: string[];
  /** 候选方向：structure / visual / narrative（程序化候选为空） */
  direction?: string | null;
  label?: string | null;
  note?: string | null;
}

export interface PptPageSelectionEntry {
  page: number;
  /** 被选中的候选序号（当前恒为 0，候选已按分数排序） */
  selected: number;
  score: number;
  issues: string[];
  candidates: PptPageCandidateScore[];
}

export interface PptPageSelection {
  pages: PptPageSelectionEntry[];
}

export interface PptPageCandidate {
  index: number;
  motif: string;
  /** 候选展示名：方向标签或 motif 的中文名 */
  label?: string | null;
  /** 候选差异说明 */
  note?: string | null;
  score: number;
  issues: string[];
  svg: string;
}

export interface PptPageCandidatesResponse {
  page: number;
  selected: number;
  candidates: PptPageCandidate[];
}

export interface PptPlanProgressEvent {
  jobId: string;
  stage: "understanding" | "planning" | "validating" | "repairing";
  current: number;
  total: number;
  message: string;
}

export type PptDraftGenerationMode = "bestOf" | "oneShot" | "programmatic";

export interface PptDraftPageEvent {
  jobId: string;
  page: number;
  total: number;
  status: "generating" | "selected" | "reused" | "fallback" | "failed";
  score: number;
  candidateCount: number;
  issues: string[];
}

/** 单页按提示词重新生成时的候选进度。 */
export interface PptPageRegenEvent {
  jobId: string;
  page: number;
  current: number;
  total: number;
  status: "preparing" | "generating" | "scored" | "selected" | "failed";
  message: string;
}

export interface PptJob {
  id: string;
  extensionId: string;
  status: string;
  stage: PptJobStage | string;
  title: string;
  templateId?: string | null;
  workspacePath: string;
  projectPath?: string | null;
  pptxPath?: string | null;
  finalPptxPath?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  logTail?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface PptLayoutMeta {
  nameZh?: string;
  descriptionZh?: string;
  summary?: string;
  canvas_format?: string;
  page_count?: number;
  page_types?: string[];
}

export interface PptLayoutSupport {
  pageCount: number;
  pageTypes: string[];
  structured: number;
  legacy: number;
  supportsStructured: boolean;
  supportsLegacy: boolean;
}

export interface PptChartMeta {
  nameZh?: string;
  descriptionZh?: string;
  summary?: string;
}

export interface PptChartsIndex {
  meta?: Record<string, unknown>;
  aliases?: Record<string, string>;
  charts?: Record<string, PptChartMeta>;
}

export interface PptCatalog {
  extensionId: string;
  extensionVersion: string;
  layouts: Record<string, PptLayoutMeta> | null;
  charts: PptChartsIndex | Record<string, PptChartMeta> | null;
  layoutSupport: Record<string, PptLayoutSupport> | null;
}

export interface PptLogEvent {
  jobId: string;
  stream: string;
  line: string;
}

export interface PptJobEvent {
  jobId: string;
  status: string;
  stage?: string;
  job?: PptJob;
}
