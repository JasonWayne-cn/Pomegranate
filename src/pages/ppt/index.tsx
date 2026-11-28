import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Pagination,
  Popconfirm,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Circle,
  Download,
  Eye,
  FilePlus2,
  FileText,
  FolderOpen,
  History,
  Info,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
  Sparkles,
  Trash2,
} from "lucide-react";
import { aiModelApi, folderApi, noteApi } from "@/lib/api";
import { extensionApi, pptExtensionApi } from "@/lib/api/extension";
import { pptTemplateApi } from "@/lib/api/pptTemplate";
import {
  addPlanSlide,
  movePlanSlide,
  removePlanSlide,
  updatePlanSlide,
} from "@/lib/pptPlan";
import { layoutDescription, layoutDisplayName } from "@/lib/pptLayouts";
import { chartDescription, chartDisplayName } from "@/lib/pptCharts";
import { loadLastExportDir, saveLastExportDir } from "@/lib/pptPrefs";
import type { Folder, Note } from "@/types";
import type {
  PptChartMeta,
  PptDraftPage,
  PptExtensionStatus,
  PptJob,
  PptJobEvent,
  PptLocalFileSource,
  PptLogEvent,
  PptDraftGenerationMode,
  PptDraftKind,
  PptDraftPageEvent,
  PptDraftStatus,
  PptMetaSource,
  PptPageCandidatesResponse,
  PptPageRegenEvent,
  PptPageSelection,
  PptPlan,
  PptPlanProgressEvent,
  PptPlanSnapshotEvent,
  PptSlide,
  PptSourceMeta,
} from "@/types/extension";
import type { PptTemplateCatalog } from "@/types/pptTemplate";

const { Text, Paragraph } = Typography;
const PAGE_SIZE = 5;

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function localFileSource(path: string): PptLocalFileSource {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const title = dot > 0 ? name.slice(0, dot) : name;
  const sourceType = dot > 0 ? name.slice(dot + 1).toLowerCase() : "file";
  return {
    path,
    title: title || name || "本地文件",
    sourceType,
    text: "",
    wordCount: 0,
  };
}

function sourceTypeLabel(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "pdf") return "PDF";
  if (lower === "doc" || lower === "docx") return "Word";
  if (lower === "md" || lower === "markdown") return "Markdown";
  if (lower === "txt" || lower === "text") return "TXT";
  return value.toUpperCase() || "文件";
}

const JOB_STATUS_META: Record<string, { color: string; label: string }> = {
  ready: { color: "blue", label: "待渲染" },
  running: { color: "processing", label: "生成中" },
  succeeded: { color: "green", label: "已完成" },
  failed: { color: "red", label: "失败" },
  cancelled: { color: "default", label: "已取消" },
};

function jobStatusTag(status: string, stage?: string) {
  if (status === "succeeded" && stage && stage !== "done") {
    return <Tag color="cyan">草稿已生成</Tag>;
  }
  const meta = JOB_STATUS_META[status] ?? { color: "default", label: status };
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

const PPT_STEP_TITLES = [
  "设置与素材",
  "制定大纲",
  "效果与模板",
  "草稿预览",
  "导出",
] as const;

/** 每个步骤的静态说明。短句常显，长说明进标题旁的 ⓘ 悬停提示。 */
const PPT_STEP_META = [
  {
    short: "选择文档并填写生成要求",
    tip: "选择文档或添加本地文件作为素材，可补充正文素材与生成要求。确认后进入下一步生成大纲。",
  },
  {
    short: "编辑标题、要点与页序",
    tip: "AI 逐页扩展出大纲；左侧选择页面，右侧编辑标题、核心信息与要点。此步不渲染页面，模板与效果在下一步查看。",
  },
  {
    short: "选模板并程序化预览",
    tip: "左侧选择版式模板与中性样式，右侧用「模板生成预览」快速查看效果。预览只写入 svg_preview，不会覆盖正式草稿。",
  },
  {
    short: "AI 生成并确认正式草稿",
    tip: "进入本步骤不会自动生成。选择单候选或三候选后点击「生成预览」，按所选模板与效果逐页渲染，确认后进入导出。",
  },
  {
    short: "导出可编辑 PPTX",
    tip: "确认正式草稿后选择导出目录并导出 PPTX；导出只读取正式草稿，不含模板预览页。",
  },
] as const;

/** 单页大纲签名：只比较影响预览的内容。 */
function slideSignature(slide: PptSlide): string {
  return JSON.stringify({
    page: slide.page,
    title: slide.title,
    coreMessage: slide.coreMessage,
    bullets: slide.bullets,
    chart: slide.chart ?? null,
  });
}

/** 保存/载入时的每页签名基线。 */
function planBaselineOf(plan: PptPlan | null): Map<number, string> | null {
  if (!plan) return null;
  return new Map(plan.slides.map((slide) => [slide.page, slideSignature(slide)]));
}

/** 把评分扣分项翻译成可执行的修改建议。 */
function scoreSuggestion(issue: string): string {
  if (issue.startsWith("未覆盖 evidence")) {
    return "在页面文字中加入大纲 evidence 的关键短句或数字。";
  }
  if (issue.startsWith("evidence 覆盖不足")) {
    return "补充更多 evidence 中的关键事实/数据，建议至少覆盖一半。";
  }
  if (issue.includes("结构过于相似")) {
    return "更换版式结构（时间轴/左右对比/卡片等）或调整视觉重心。";
  }
  if (issue.startsWith("文本泄漏")) {
    return "删除页面中不应出现的内部术语或占位文本。";
  }
  if (issue.includes("过于简单")) {
    return "增加内容层级、要点或图形元素，避免页面过空。";
  }
  if (issue.includes("颜色不在 spec_lock")) {
    return "改用模板规范色板，减少自定义颜色。";
  }
  if (issue.includes("字号越界")) {
    return "将字号调整到 10–72 范围，保持层级清晰。";
  }
  return "按提示调整内容或结构后点击「重新生成此页」。";
}

function StepTitle({
  title,
  short,
  tip,
}: {
  title: string;
  short?: string;
  tip?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="truncate">{title}</span>
        {tip && (
          <Tooltip title={tip} placement="bottomLeft" mouseEnterDelay={0.15}>
            <Info
              size={14}
              tabIndex={0}
              aria-label="步骤说明"
              className="shrink-0 cursor-help text-slate-400 outline-none"
            />
          </Tooltip>
        )}
      </div>
      {short && (
        <div className="mt-0.5 text-xs font-normal text-slate-500">{short}</div>
      )}
    </div>
  );
}

/** 当前作业持久化键：离开页面后重新进入可继续上次流程 */
const PPT_ACTIVE_JOB_KEY = "ppt.activeJobId";

/** 从草稿文件名解析页码，草稿未生成时也能定位对应文案页。 */
function pageFromDraftFile(file: string | null): number | null {
  if (!file) return null;
  const match = /P(\d+)\.svg$/i.exec(file);
  return match ? Number(match[1]) : null;
}

interface StepRailItem {
  title: string;
  description: string;
  tip?: string;
  disabled?: boolean;
}

/** 右侧竖向步骤导航：状态、摘要与直接跳转都在这里。 */
/** 每页标题行右侧的 AI 模型选择。 */
function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: { id: number; name: string }[];
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <span className="flex items-center gap-1 text-xs text-slate-500">
      AI 模型
      <Select
        size="small"
        allowClear
        placeholder="默认"
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={models.map((model) => ({
          value: model.id,
          label: model.name,
        }))}
        className="w-40"
      />
    </span>
  );
}

/** 表单字段标签 + 悬停说明。 */
function FieldLabel({ label, tip }: { label: string; tip?: string }) {
  return (
    <span className="mb-1 flex items-center gap-1 text-sm">
      {label}
      {tip && (
        <Tooltip title={tip} placement="topLeft" mouseEnterDelay={0.15}>
          <Info
            size={13}
            tabIndex={0}
            aria-label={`${label}说明`}
            className="cursor-help text-slate-400 outline-none"
          />
        </Tooltip>
      )}
    </span>
  );
}

function StepRail({
  items,
  current,
  viewStep,
  onSelect,
  onNewJob,
  onOpenHistory,
  recentJobs,
  currentJobId,
  onOpenJob,
}: {
  items: StepRailItem[];
  current: number;
  viewStep: number;
  onSelect: (index: number) => void;
  onNewJob: () => void;
  onOpenHistory: () => void;
  recentJobs: PptJob[];
  currentJobId?: string;
  onOpenJob: (job: PptJob) => void;
}) {
  return (
    <aside className="flex h-full w-14 shrink-0 flex-col gap-1.5 overflow-y-auto border-l border-slate-200 bg-white/70 px-2 py-3 xl:w-44">
      <button
        type="button"
        title="新建PPT作业"
        onClick={onNewJob}
        className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-2 py-2 text-left text-sm text-blue-600 transition hover:border-blue-300"
      >
        <Plus size={16} className="shrink-0" />
        <span className="hidden truncate xl:block">新建PPT作业</span>
      </button>
      <button
        type="button"
        title="历史PPT作业"
        onClick={onOpenHistory}
        className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-2 text-left text-sm text-slate-600 transition hover:border-blue-300 hover:text-blue-600"
      >
        <History size={16} className="shrink-0" />
        <span className="hidden truncate xl:block">历史PPT作业</span>
      </button>
      {recentJobs.length > 0 && (
        <div className="mb-1 hidden flex-col gap-0.5 xl:flex">
          {recentJobs.map((record) => (
            <button
              key={record.id}
              type="button"
              title={record.title}
              onClick={() => onOpenJob(record)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition hover:bg-slate-50 ${
                record.id === currentJobId ? "bg-blue-50 text-blue-600" : ""
              }`}
            >
              <FileText size={12} className="shrink-0 text-slate-400" />
              <span className="truncate text-slate-600">{record.title}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mb-0.5 mt-3 hidden border-t border-slate-200 px-2 pt-2 text-xs font-medium text-slate-400 xl:block">
        PPT制作流程
      </div>
      <div className="mx-1 my-1 border-t border-slate-200 xl:hidden" />
      {items.map((item, index) => {
        const done = index < current;
        const isCurrent = index === current;
        const viewing = index === viewStep;
        return (
          <button
            key={item.title}
            type="button"
            title={item.title}
            aria-current={isCurrent ? "step" : undefined}
            onClick={() => onSelect(index)}
            className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left transition ${
              viewing
                ? "bg-blue-50 ring-1 ring-blue-200"
                : "hover:bg-slate-50"
            }`}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium ${
                done
                  ? "border-emerald-200 bg-emerald-50 text-emerald-600"
                  : isCurrent
                    ? "border-blue-500 bg-blue-500 text-white"
                    : "border-slate-200 bg-white text-slate-400"
              }`}
            >
              {done ? <CheckCircle2 size={14} /> : index + 1}
            </span>
            <span className="hidden min-w-0 flex-1 xl:block">
              <span className="flex items-center gap-1 text-sm font-medium text-slate-700">
                <span className="truncate">{item.title}</span>
                {viewing && !isCurrent && (
                  <Eye size={12} className="shrink-0 text-blue-500" />
                )}
              </span>
              <span className="line-clamp-2 text-xs leading-4 text-slate-500">
                {item.description}
              </span>
            </span>
          </button>
        );
      })}
    </aside>
  );
}

function StepPreviewPlaceholder({
  step,
  description,
  hints,
}: {
  step: number;
  description: string;
  hints: string[];
}) {
  return (
    <Card
      className="mt-4"
      title={<StepTitle title={`${PPT_STEP_TITLES[step]} · 预览`} short={description} />}
      extra={<Tag color="blue">尚未开始</Tag>}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {hints.map((hint) => (
          <div
            key={hint}
            className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-600"
          >
            {hint}
          </div>
        ))}
      </div>
      <Skeleton active title={false} paragraph={{ rows: 4 }} />
    </Card>
  );
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function chartMapOf(
  raw: PptTemplateCatalog["charts"] | undefined,
): Record<string, PptChartMeta> {
  if (!raw) return {};
  const nested = (raw as { charts?: Record<string, PptChartMeta> }).charts;
  if (nested && typeof nested === "object") return nested;
  return raw as Record<string, PptChartMeta>;
}

function newPlanningId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `plan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function PptPage() {
  const navigate = useNavigate();
  const inTauri = isTauri();
  const [status, setStatus] = useState<PptExtensionStatus | null>(null);
  const [catalog, setCatalog] = useState<PptTemplateCatalog | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);

  // 文档默认分页展示，每页 5 篇；搜索时按关键词过滤
  const [searchKeyword, setSearchKeyword] = useState("");
  const [documents, setDocuments] = useState<Note[]>([]);
  const [docPage, setDocPage] = useState(1);
  const [docTotal, setDocTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [selectedNotes, setSelectedNotes] = useState<Note[]>([]);

  // 本地文件素材（只保存路径/标题，正文在创建作业时由后端提取一次）
  const [localSources, setLocalSources] = useState<PptLocalFileSource[]>([]);
  /** 打开历史作业时从 source_manifest.json 恢复的素材（只读展示） */
  const [restoredSources, setRestoredSources] = useState<PptSourceMeta[]>([]);
  /** 素材理解（understanding.md） */
  const [understanding, setUnderstanding] = useState("");
  const [understandingLoading, setUnderstandingLoading] = useState(false);
  /** 补充素材文件 manual.md 的路径（存在时显示查看链接） */
  const [manualPath, setManualPath] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState("");
  const [suggestingMeta, setSuggestingMeta] = useState(false);
  const titleTouched = useRef(false);
  const audienceTouched = useRef(false);
  const suggestTimer = useRef<number | null>(null);
  const suggestSeq = useRef(0);
  const selectedNotesRef = useRef<Note[]>([]);
  const localSourcesRef = useRef<PptLocalFileSource[]>([]);
  const [layoutId, setLayoutId] = useState<string | undefined>();
  const [chartIds, setChartIds] = useState<string[]>([]);
  const [language, setLanguage] = useState("zh-CN");
  const [extraRequirements, setExtraRequirements] = useState("");
  const [manualText, setManualText] = useState("");
  const [exportDir, setExportDir] = useState<string | null>(null);
  const [modelId, setModelId] = useState<number | undefined>();
  const [models, setModels] = useState<Array<{ id: number; name: string }>>([]);

  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [slideCount, setSlideCount] = useState<number | undefined>();
  const [planDirty, setPlanDirty] = useState(false);
  const [styleDirty, setStyleDirty] = useState(false);
  /** 后端按页级指纹判定的草稿状态；用于导出前置校验。 */
  const [draftStatus, setDraftStatus] = useState<PptDraftStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [job, setJob] = useState<PptJob | null>(null);
  const [engineProgress, setEngineProgress] = useState(0);
  const [step, setStep] = useState(0);
  // 导航条展示的步骤。与真实流程步骤 step 分离：点击导航只切换视图，不推进流程。
  const [viewStep, setViewStep] = useState(0);
  const [plan, setPlan] = useState<PptPlan | null>(null);
  const [planningId, setPlanningId] = useState<string | null>(null);
  const [nativeCharts, setNativeCharts] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<PptJob[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [layoutPreviews, setLayoutPreviews] = useState<Record<string, string>>({});
  const [previewFailed, setPreviewFailed] = useState<Record<string, true>>({});
  const previewLoaded = useRef<Set<string>>(new Set());
  const [draftSvgs, setDraftSvgs] = useState<Record<string, string>>({});
  const [draftLoading, setDraftLoading] = useState(false);
  // 步骤三模板预览（svg_preview），与正式草稿状态分离。
  const [previewPages, setPreviewPages] = useState<PptDraftPage[]>([]);
  const [previewSvgs, setPreviewSvgs] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSelectedFile, setPreviewSelectedFile] = useState<string | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [pageSelection, setPageSelection] = useState<PptPageSelection | null>(null);
  const [pageCandidates, setPageCandidates] =
    useState<PptPageCandidatesResponse | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [regenPage, setRegenPage] = useState<number | null>(null);
  const [regenPromptPage, setRegenPromptPage] = useState<number | null>(null);
  const [regenInstruction, setRegenInstruction] = useState("");
  /** 草稿预览页内联提示词（按当前选中页） */
  const [inlineRegenText, setInlineRegenText] = useState("");
  const [regenProgress, setRegenProgress] = useState<PptPageRegenEvent | null>(null);
  const [selectedDraftFile, setSelectedDraftFile] = useState<string | null>(null);
  const [planProgress, setPlanProgress] = useState<PptPlanProgressEvent | null>(null);
  /** 大纲生成日志（仅 planning 阶段） */
  const [planLogs, setPlanLogs] = useState<string[]>([]);
  /** 素材处理日志（material / understanding 阶段） */
  const [materialLogs, setMaterialLogs] = useState<string[]>([]);
  /** 规划中的大纲快照：标题清单/逐页扩展，实时喂给左侧列表 */
  const [planningSlides, setPlanningSlides] = useState<PptSlide[]>([]);
  const [planningPaused, setPlanningPaused] = useState(false);
  const [draftProgress, setDraftProgress] = useState<PptDraftPageEvent | null>(null);
  const [draftDoneCount, setDraftDoneCount] = useState(0);
  // 正式生成方式（正式草稿预览步骤）：快速预览固定使用程序化排版
  const [formalMode, setFormalMode] =
    useState<PptDraftGenerationMode>("oneShot");
  // 当前草稿是否已按模板/正式效果渲染，用于区分「快速预览草稿」与「正式草稿」
  const [formalized, setFormalized] = useState(false);
  // 用户是否暂停了本轮 AI 草稿生成（后端在页块边界生效）
  const [paused, setPaused] = useState(false);
  const renderPurposeRef = useRef<"preview" | "formal" | null>(null);
  /** 正在进行中的渲染产物类别，用于 done 事件分流。 */
  const renderKindRef = useRef<PptDraftKind>("formal");
  /** 已自动加载过模板预览的作业 id，避免 effect 循环触发。 */
  const previewAutoLoadedJob = useRef<string | null>(null);
  /** 最近一次保存/加载的每页大纲签名，用于内容级脏检测。 */
  const planBaselineRef = useRef<Map<number, string> | null>(null);
  const draftDonePages = useRef<Set<number>>(new Set());
  /** 只在首次挂载时恢复上次作业，避免重复触发 */
  const restoredActiveJob = useRef(false);

  const folderName = useMemo(() => {
    const map = new Map<number, string>();
    for (const folder of folders) map.set(folder.id, folder.name);
    return map;
  }, [folders]);

  const loadStatus = useCallback(async () => {
    // 浏览器里没有 Tauri IPC，直接跳过，避免弹出 "window.__TAURI_INTERNALS__ is undefined"
    if (!isTauri()) return;
    try {
      const next = await pptExtensionApi.status();
      setStatus(next);
      if (next.installed && next.enabled && next.supportsPpt) {
        setCatalog(await pptTemplateApi.catalog());
      }
    } catch (e) {
      message.error(`读取扩展状态失败：${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    folderApi.list().then(setFolders).catch(() => undefined);
    aiModelApi
      .list()
      .then((list) => {
        setModels(list.map((m) => ({ id: m.id, name: m.name })));
        if (list.length > 0) setModelId((current) => current ?? list[0].id);
      })
      .catch(() => undefined);
  }, [loadStatus]);

  // 记住当前作业：离开页面后重新进入可以恢复上次流程
  useEffect(() => {
    if (!job?.id) return;
    try {
      localStorage.setItem(PPT_ACTIVE_JOB_KEY, job.id);
    } catch {
      // localStorage 不可用时忽略
    }
  }, [job?.id]);

  // 重新进入页面：恢复上次作业；若任务仍在后台运行或已暂停，界面直接接上
  useEffect(() => {
    if (restoredActiveJob.current) return;
    restoredActiveJob.current = true;
    let activeId: string | null = null;
    try {
      activeId = localStorage.getItem(PPT_ACTIVE_JOB_KEY);
    } catch {
      activeId = null;
    }
    if (!activeId) return;
    void (async () => {
      try {
        // listJobs 会顺手回收超时无进展的 running 作业；
        // recoverJob 再判断当前进程是否真的还有生成循环，没有就标记中断失败
        const jobs = await pptExtensionApi
          .listJobs(30)
          .catch(() => [] as PptJob[]);
        const recovered = await pptExtensionApi
          .recoverJob(activeId)
          .catch(() => null);
        const record =
          recovered ??
          jobs.find((item) => item.id === activeId) ??
          (await pptExtensionApi.getJob(activeId));
        if (!record) {
          try {
            localStorage.removeItem(PPT_ACTIVE_JOB_KEY);
          } catch {
            // ignore
          }
          return;
        }
        await resumeJob(record);
        if (record.status === "running") {
          setRunning(true);
          const isPaused = await pptExtensionApi
            .jobPaused(activeId)
            .catch(() => false);
          setPaused(isPaused);
        }
      } catch {
        // 恢复失败不阻塞新开作业
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 生成中健康检查：若 Rust 侧生成循环已消失（应用重启/强杀），把界面从
  // 「永远卡在 5% 且没有日志」的假运行状态里拉回来，标记为中断。
  useEffect(() => {
    if (!running || !job?.id) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await pptExtensionApi.recoverJob(job.id);
          if (
            fresh &&
            fresh.status === "failed" &&
            fresh.errorCode === "interrupted"
          ) {
            setJob(fresh);
            setRunning(false);
            setPaused(false);
            message.error("生成进程已中断（应用可能已重启），请点击重试或重新生成");
          }
        } catch {
          // 查询失败不打断当前界面
        }
      })();
    }, 5000);
    return () => clearInterval(timer);
  }, [running, job?.id, message]);

  useEffect(() => {
    const handler = () => {
      previewLoaded.current.clear();
      setLayoutPreviews({});
      setPreviewFailed({});
      void loadStatus();
    };
    window.addEventListener("app:ppt-templates-changed", handler);
    return () =>
      window.removeEventListener("app:ppt-templates-changed", handler);
  }, [loadStatus]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen("extension:auto-installed", () => {
      void loadStatus();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [loadStatus]);

  useEffect(() => {
    let disposed = false;
    void loadLastExportDir().then((dir) => {
      if (!disposed && dir) setExportDir(dir);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const layoutKey = useMemo(
    () => Object.keys(catalog?.layouts ?? {}).join("|"),
    [catalog],
  );

  useEffect(() => {
    if (!status?.installed || !status.enabled || !layoutKey) return;
    let disposed = false;
    // 记录本轮已发出但未完成的请求；StrictMode 的首次 effect 会被立即
    // 清理，若不释放标记，第二轮 effect 会跳过请求，封面将一直停在加载态。
    const pending = new Set<string>();
    for (const id of layoutKey.split("|")) {
      if (!id || previewLoaded.current.has(id)) continue;
      previewLoaded.current.add(id);
      pending.add(id);
      const meta = catalog?.layouts[id];
      const request =
        meta?.source === "user"
          ? pptTemplateApi.preview(id)
          : extensionApi.pptLayoutPreview(
              catalog?.extensionId ?? "ppt-master",
              id,
            );
      request
        .then((svg) => {
          pending.delete(id);
          if (!disposed) {
            setLayoutPreviews((prev) => ({ ...prev, [id]: svg }));
          }
        })
        .catch(() => {
          pending.delete(id);
          previewLoaded.current.delete(id);
          if (!disposed) {
            setPreviewFailed((prev) => ({ ...prev, [id]: true }));
          }
        });
    }
    return () => {
      disposed = true;
      for (const id of pending) {
        previewLoaded.current.delete(id);
      }
    };
  }, [catalog, layoutKey, status?.installed, status?.enabled]);

  const refreshDraftStatus = useCallback(async (jobId: string) => {
    try {
      setDraftStatus(await pptExtensionApi.draftStatus(jobId));
    } catch {
      setDraftStatus(null);
    }
  }, []);

  const loadDraft = useCallback(async (jobId: string, kind: PptDraftKind = "formal") => {
    setDraftLoading(true);
    try {
      const pages = await pptExtensionApi.listDraftPages(jobId, kind);
      // 重新进入/续跑时：已落盘的页数就是当前完成数
      setDraftDoneCount(pages.length);
      const entries = await Promise.all(
        pages.map(
          async (page) =>
            [page.file, await pptExtensionApi.readDraftPage(jobId, page.file, kind)] as const,
        ),
      );
      const map = Object.fromEntries(entries);
      setDraftSvgs(map);
      if (kind === "formal") {
        try {
          setPageSelection(await pptExtensionApi.getPageSelection(jobId));
        } catch {
          setPageSelection(null);
        }
      }
      setSelectedDraftFile((current) =>
        current && map[current] ? current : pages[0]?.file ?? null,
      );
      if (kind === "formal") {
        void refreshDraftStatus(jobId);
      }
    } catch (e) {
      message.error(`加载草稿失败：${String(e)}`);
    } finally {
      setDraftLoading(false);
    }
  }, [refreshDraftStatus]);

  /** 加载步骤三的模板预览页（svg_preview）。 */
  const loadPreview = useCallback(async (jobId: string) => {
    setPreviewLoading(true);
    try {
      const pages = await pptExtensionApi.listDraftPages(jobId, "preview");
      const entries = await Promise.all(
        pages.map(
          async (page) =>
            [page.file, await pptExtensionApi.readDraftPage(jobId, page.file, "preview")] as const,
        ),
      );
      const map = Object.fromEntries(entries);
      setPreviewPages(pages);
      setPreviewSvgs(map);
      setPreviewSelectedFile((current) =>
        current && map[current] ? current : pages[0]?.file ?? null,
      );
      setPreviewStale(false);
    } catch (e) {
      message.error(`加载模板预览失败：${String(e)}`);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const loadDocuments = useCallback(async (page: number, keyword: string) => {
    setSearching(true);
    try {
      const result = await noteApi.list({
        page,
        page_size: PAGE_SIZE,
        keyword: keyword.trim() || undefined,
      });
      setDocuments(result.items);
      setDocTotal(result.total);
    } catch (e) {
      message.error(`加载文档失败：${String(e)}`);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDocuments(docPage, searchKeyword);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [docPage, searchKeyword, loadDocuments]);

  useEffect(() => {
    selectedNotesRef.current = selectedNotes;
  }, [selectedNotes]);

  useEffect(() => {
    localSourcesRef.current = localSources;
  }, [localSources]);

  useEffect(
    () => () => {
      if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
    },
    [],
  );

  const requestMetaSuggestion = useCallback(
    (notes: Note[], locals: PptLocalFileSource[]) => {
      const sources: PptMetaSource[] = [
        ...notes.map((note) => ({
          title: note.title || "无标题文档",
          sourceType: "note",
          excerpt: (note.content || "")
            .replace(/<[^>]+>/g, " ")
            .slice(0, 1200),
        })),
        ...locals.map((file) => ({
          title: file.title || baseName(file.path),
          sourceType: file.sourceType,
          excerpt: "",
        })),
      ].filter((source) => source.title.trim());
      if (sources.length === 0) {
        setSuggestingMeta(false);
        return;
      }
      if (titleTouched.current && audienceTouched.current) {
        return;
      }
      if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
      const seq = ++suggestSeq.current;
      suggestTimer.current = window.setTimeout(async () => {
        setSuggestingMeta(true);
        try {
          const result = await pptExtensionApi.suggestMeta(
            sources,
            modelId ?? null,
          );
          if (seq !== suggestSeq.current) return;
          if (!titleTouched.current && result.title?.trim()) {
            setTitle(result.title.trim());
          }
          if (!audienceTouched.current && result.audience?.trim()) {
            setAudience(result.audience.trim());
          }
        } catch (e) {
          // AI 不可用时保持手动输入，不打断用户
          console.warn("PPT 素材识别失败", e);
        } finally {
          if (seq === suggestSeq.current) setSuggestingMeta(false);
        }
      }, 500);
    },
    [modelId],
  );

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const register = (unlisten: UnlistenFn) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    };

    void (async () => {
      register(
        await listen<PptLogEvent>("ppt-extension://log", (event) => {
          const payload = event.payload;
          const append = (line: string) => {
            setLogs((prev) => {
              const next = [...prev, line];
              return next.length > 300 ? next.slice(next.length - 300) : next;
            });
          };
          try {
            const parsed = JSON.parse(payload.line);
            if (parsed && typeof parsed === "object") {
              if (parsed.type === "progress") {
                const percent = Number(parsed.percent);
                if (Number.isFinite(percent)) setEngineProgress(percent);
                append(
                  `[进度${parsed.stage ? `·${parsed.stage}` : ""}] ${
                    Number.isFinite(percent) ? `${percent}%` : ""
                  } ${parsed.message ?? ""}`.trim(),
                );
                return;
              }
              if (parsed.type === "log") {
                append(`[${parsed.level ?? "info"}] ${parsed.message ?? ""}`);
                return;
              }
              if (parsed.type === "artifact") {
                append(`[产物] ${parsed.path ?? ""}`);
                return;
              }
              if (parsed.type === "error") {
                append(`[错误] ${parsed.message ?? payload.line}`);
                return;
              }
            }
          } catch {
            // 非 JSON 行按原始流输出
          }
          append(
            payload.stream === "system"
              ? `[系统] ${payload.line}`
              : `[${payload.stream}] ${payload.line}`,
          );
        }),
      );
      // 大纲规划独立日志：快速预览页单独展示
      register(
        await listen<PptLogEvent>("ppt-extension://plan-log", (event) => {
          const append = (prev: string[]) => {
            const next = [...prev, event.payload.line];
            return next.length > 300 ? next.slice(next.length - 300) : next;
          };
          if (event.payload.phase === "planning") {
            setPlanLogs(append);
          } else {
            setMaterialLogs(append);
          }
        }),
      );
      // 大纲快照：标题清单/逐页扩展实时刷新左侧列表
      register(
        await listen<PptPlanSnapshotEvent>(
          "ppt-extension://plan-snapshot",
          (event) => {
            setPlanningSlides(event.payload.slides as PptSlide[]);
          },
        ),
      );
      const onJobEvent = (event: { payload: PptJobEvent }) => {
        const payload = event.payload;
        if (payload.job) {
          setJob(payload.job);
        } else {
          setJob((prev) =>
            prev
              ? {
                  ...prev,
                  status: payload.status,
                  stage: payload.stage ?? prev.stage,
                }
              : prev,
          );
        }
        if (payload.status === "running") {
          setRunning(true);
          return;
        }
        if (payload.status === "paused") {
          // 已暂停：释放 UI 锁，允许切换步骤、修改生成方式/模型后继续。
          setRunning(false);
          setDraftLoading(false);
          setPreviewLoading(false);
          setPaused(true);
          renderPurposeRef.current = null;
          message.info("已暂停：已完成页面已保存，可修改生成方式/模型后继续");
          if (payload.job?.id) void loadDraft(payload.job.id, "formal");
          return;
        }
        if (["succeeded", "failed", "cancelled"].includes(payload.status)) {
          setRunning(false);
          setPaused(false);
          setDraftLoading(false);
          setPreviewLoading(false);
          const kind = payload.kind ?? renderKindRef.current;
          if (payload.status === "succeeded") {
            setEngineProgress(100);
            setPlanDirty(false);
            setStyleDirty(false);
            const stage = payload.job?.stage ?? payload.stage;
            const jobId = payload.job?.id;
            if (kind === "preview") {
              // 模板预览不推进流程，也不改正式草稿状态。
              message.success("模板预览已生成");
              if (jobId) void loadPreview(jobId);
              return;
            }
            if (stage === "draft_ready") {
              renderPurposeRef.current = null;
              setFormalized(true);
              message.success("正式 PPT 已生成，可预览后导出");
              // 正式草稿预览是独立步骤
              setStep(3);
              if (jobId) void loadDraft(jobId, "formal");
            } else {
              setFormalized(true);
              message.success("PPT 导出完成");
              setStep(4);
              if (jobId) void refreshDraftStatus(jobId);
            }
          } else {
            renderPurposeRef.current = null;
            message.error(
              payload.job?.errorMessage ??
                (payload.status === "cancelled" ? "已取消生成" : "PPT 生成失败"),
            );
          }
        }
      };
      register(
        await listen<PptPlanProgressEvent>("ppt-extension://plan-progress", (event) => {
          setPlanProgress(event.payload);
        }),
      );
      register(
        await listen<PptDraftPageEvent>("ppt-extension://draft-page", (event) => {
          const payload = event.payload;
          setDraftProgress(payload);
          if (["selected", "reused", "fallback", "failed"].includes(payload.status)) {
            if (!draftDonePages.current.has(payload.page)) {
              draftDonePages.current.add(payload.page);
              setDraftDoneCount(draftDonePages.current.size);
            }
          }
          if (payload.status === "selected" || payload.status === "reused") {
            const file = `P${String(payload.page).padStart(2, "0")}.svg`;
            void (async () => {
              try {
                const svg = await pptExtensionApi.readDraftPage(payload.jobId, file);
                setDraftSvgs((prev) => ({ ...prev, [file]: svg }));
                setSelectedDraftFile((current) => current ?? file);
              } catch {
                // 页面文件可能尚未落盘，完成事件会统一刷新
              }
            })();
          }
        }),
      );
      register(
        await listen<PptPageRegenEvent>(
          "ppt-extension://page-regenerate",
          (event) => {
            setRegenProgress(event.payload);
          },
        ),
      );
      register(await listen<PptJobEvent>("ppt-extension://job", onJobEvent));
      register(await listen<PptJobEvent>("ppt-extension://done", onJobEvent));
      register(await listen<PptJobEvent>("ppt-extension://error", onJobEvent));
    })();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [loadDraft]);

  const selectedCount = selectedNotes.length + localSources.length;
  const selectedChars = selectedNotes.reduce(
    (sum, note) => sum + (note.word_count || note.content.length),
    0,
  );
  // 历史作业：没有新的临时选择时，展示从 source_manifest 恢复的原始素材
  const showRestoredSources =
    !!job &&
    selectedNotes.length === 0 &&
    localSources.length === 0 &&
    restoredSources.length > 0;
  const restoredSourceChars = showRestoredSources
    ? restoredSources.reduce((sum, source) => sum + (source.wordCount ?? 0), 0)
    : 0;
  const displaySelectedCount =
    selectedCount +
    (showRestoredSources ? restoredSources.length : 0) +
    (job && selectedCount === 0 && manualPath ? 1 : 0);
  const progressPercent = running
    ? Math.max(5, Math.min(95, engineProgress || 5))
    : job?.status === "succeeded"
      ? 100
      : 0;

  const selectedNoteIds = useMemo(
    () => new Set(selectedNotes.map((note) => note.id)),
    [selectedNotes],
  );

  function addNoteSource(note: Note) {
    if (job) {
      // 已存在作业：直接追加到作业素材并持久化。
      void (async () => {
        try {
          await pptExtensionApi.appendJobSources(job.id, [note.id], []);
          await refreshJobSources(job.id);
          message.success(`已加入作业：${note.title || "无标题"}`);
        } catch (e) {
          message.error(`添加素材失败：${String(e)}`);
        }
      })();
      return;
    }
    if (selectedNoteIds.has(note.id)) return;
    const next = [...selectedNotesRef.current, note];
    selectedNotesRef.current = next;
    setSelectedNotes(next);
    requestMetaSuggestion(next, localSourcesRef.current);
    message.success(`已添加：${note.title || "无标题"}`);
  }

  function removeNoteSource(id: number) {
    const next = selectedNotesRef.current.filter((note) => note.id !== id);
    selectedNotesRef.current = next;
    if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
    suggestSeq.current += 1;
    setSuggestingMeta(false);
    setSelectedNotes(next);
  }

  function removeLocalSource(path: string) {
    const next = localSourcesRef.current.filter(
      (source) => source.path !== path,
    );
    localSourcesRef.current = next;
    if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
    suggestSeq.current += 1;
    setSuggestingMeta(false);
    setLocalSources(next);
  }

  async function addLocalFiles() {
    let selected: string | string[] | null = null;
    try {
      selected = await openDialog({
        multiple: true,
        directory: false,
        filters: [
          {
            name: "文档",
            extensions: ["md", "markdown", "txt", "pdf", "doc", "docx", "xlsx"],
          },
        ],
      });
    } catch (e) {
      message.error(String(e));
      return;
    }
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const existing = new Set([
      ...localSourcesRef.current.map((source) => source.path),
      ...restoredSources
        .map((source) => source.path)
        .filter((value): value is string => !!value),
    ]);
    const added = paths
      .filter((path) => !existing.has(path))
      .map(localFileSource);
    if (added.length === 0) return;
    if (job) {
      // 已存在作业：直接追加本地文件到作业素材。
      try {
        await pptExtensionApi.appendJobSources(
          job.id,
          [],
          added.map((item) => ({
            path: item.path,
            title: item.title,
            sourceType: item.sourceType,
          })),
        );
        await refreshJobSources(job.id);
        message.success(`已加入 ${added.length} 个本地文件`);
      } catch (e) {
        message.error(`添加本地文件失败：${String(e)}`);
      }
      return;
    }
    const next = [...localSourcesRef.current, ...added];
    localSourcesRef.current = next;
    setLocalSources(next);
    requestMetaSuggestion(selectedNotesRef.current, next);
  }

  async function pickExportDir() {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (selected && !Array.isArray(selected)) {
        setExportDir(selected);
        void saveLastExportDir(selected);
      }
    } catch (e) {
      message.error(String(e));
    }
  }

  function validateSources(): boolean {
    if (!status?.installed || !status.enabled) {
      message.warning("请先安装并启用 PPT 扩展包");
      return false;
    }
    if (!title.trim()) {
      message.warning("请填写 PPT 标题");
      return false;
    }
    // 历史作业的素材已固化在 source.md 中，无需重新选择文档。
    if (job && plan) {
      return true;
    }
    if (selectedCount === 0 && !manualText.trim()) {
      message.warning("请至少添加一个文档/本地文件，或填写补充素材");
      return false;
    }
    return true;
  }

  async function handleGenerate() {
    // 历史作业的素材已固化在 source.md，不能再走 createJob（否则没有可用正文）。
    // 这里改为“用现有素材重新生成大纲”。
    if (job) {
      await handleRegenerateOutline();
      return;
    }
    if (!validateSources()) return;
    setCreating(true);
    setLogs([]);
    setPlanLogs([]);
    setMaterialLogs([]);
    setPlanningSlides([]);
    setPlanningPaused(false);
    setPlanProgress(null);
    // 立即进入快速预览步骤，边生成大纲边展示日志与页面标题
    setStep(1);
    setJob(null);
    setPlan(null);
    planBaselineRef.current = null;
    setRestoredSources([]);
    setDraftSvgs({});
    setSelectedDraftFile(null);
    setEngineProgress(0);
    setPlanDirty(false);
    setStyleDirty(false);
    setFormalized(false);
    // 新作业从快速预览开始，模板与图表效果留到「效果与模板」步骤再选
    setLayoutId(undefined);
    setChartIds([]);
    setNativeCharts(false);
    const requestId = newPlanningId();
    setPlanningId(requestId);
    try {
      const created = await pptExtensionApi.createJob({
        noteIds: selectedNotes.map((note) => note.id),
        mountNoteIds: [],
        localFiles: localSources.map((source) => ({
          path: source.path,
          title: source.title,
          sourceType: source.sourceType,
        })),
        manualText,
        title: title.trim(),
        audience,
        slideCount: slideCount ?? null,
        layoutId: null,
        chartIds: [],
        language,
        extraRequirements: extraRequirements.trim() || null,
        exportDir,
        modelId: modelId ?? null,
        planningId: requestId,
        nativeCharts: false,
      });
      setJob(created);
      const nextPlan = await pptExtensionApi.getPlan(created.id);
      applySavedPlan(nextPlan);
      setPlanningSlides([]);
      setPlanDirty(false);
      setStyleDirty(false);
      // 作业创建后素材以作业清单为准，清空临时选择并读取清单/理解。
      setRestoredSources(
        await pptExtensionApi.jobSources(created.id).catch(() => []),
      );
      selectedNotesRef.current = [];
      localSourcesRef.current = [];
      setSelectedNotes([]);
      setLocalSources([]);
      setManualText("");
      pptExtensionApi
        .readUnderstanding(created.id)
        .then(setUnderstanding)
        .catch(() => undefined);
      message.success("文案大纲已生成，请确认并编辑后进入下一步");
      setStep(1);
      void loadHistory();
    } catch (e) {
      message.error(`生成大纲失败：${String(e)}`);
      setStep(0);
    } finally {
      setCreating(false);
      setPlanningId(null);
      setPlanningPaused(false);
      setPlanProgress(null);
    }
  }

  /** 启动正式草稿渲染（AI 单候选/三候选，或模板生成预览）。 */
  function startDraftRender(jobId: string, mode: PptDraftGenerationMode) {
    renderPurposeRef.current = "formal";
    renderKindRef.current = "formal";
    setRunning(true);
    setPaused(false);
    // 新一轮生成/续跑开始后，在完成前不再视为可导出的正式草稿。
    setFormalized(false);
    setLogs([]);
    setEngineProgress(0);
    setDraftSvgs({});
    setSelectedDraftFile(null);
    setPageCandidates(null);
    setPageSelection(null);
    draftDonePages.current = new Set();
    setDraftDoneCount(0);
    setDraftProgress(null);
    setDraftLoading(true);
    // 正式生成直接进入「正式草稿预览」步骤，边渲染边预览
    setStep(3);
    const effectiveCount = mode === "bestOf" ? 3 : 1;
    void pptExtensionApi
      .renderAiDraft(jobId, effectiveCount, mode)
      .catch((error) => {
        renderPurposeRef.current = null;
        setRunning(false);
        setDraftLoading(false);
        message.error(`正式 PPT 生成失败：${String(error)}`);
      });
  }

  /** 启动步骤三的模板预览（引擎确定性填充，写入 svg_preview）。 */
  function startTemplatePreview(jobId: string) {
    renderKindRef.current = "preview";
    setPreviewLoading(true);
    setRunning(true);
    setLogs([]);
    setEngineProgress(0);
    setPreviewPages([]);
    setPreviewSvgs({});
    setPreviewSelectedFile(null);
    void pptExtensionApi
      .renderDraft(jobId, { kind: "preview" })
      .catch((error) => {
        setRunning(false);
        setPreviewLoading(false);
        message.error(`模板预览生成失败：${String(error)}`);
      });
  }

  async function handleRegenerateOutline() {
    if (!job) {
      void handleGenerate();
      return;
    }
    const requestId = newPlanningId();
    setPlanningId(requestId);
    setRegenerating(true);
    setLogs([]);
    setPlanLogs([]);
    setMaterialLogs([]);
    setPlanningSlides([]);
    setPlanningPaused(false);
    setPlanProgress(null);
    setEngineProgress(0);
    // 无论从步骤 0 还是步骤 1 触发，都切到快速预览页展示日志与实时大纲
    setStep(1);
    try {
      const next = await pptExtensionApi.regeneratePlan(
        job.id,
        slideCount ?? null,
        modelId ?? null,
        requestId,
      );
      applySavedPlan(next);
      setPlanningSlides([]);
      setPlanDirty(false);
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: "ready",
              stage: "outline_ready",
              pptxPath: null,
              finalPptxPath: null,
              errorCode: null,
              errorMessage: null,
            }
          : prev,
      );
      message.success(`大纲已重新生成（${next.slides.length} 页）`);
      setStep(1);
    } catch (e) {
      setPlanningSlides([]);
      message.error(`重新生成大纲失败：${String(e)}`);
    } finally {
      setRegenerating(false);
      setPlanningId(null);
      setPlanningPaused(false);
      setPlanProgress(null);
    }
  }

  async function handleCancelPlanning() {
    if (!planningId) return;
    try {
      await pptExtensionApi.cancelPlanning(planningId);
      setPlanningPaused(false);
      message.info("已请求取消大纲生成");
    } catch (e) {
      message.error(String(e));
    }
  }

  /** 暂停 / 继续大纲生成（后端在当前阶段/分块结束后停止推进） */
  async function handleTogglePlanningPause() {
    if (!planningId) return;
    try {
      if (planningPaused) {
        await pptExtensionApi.resumePlanning(planningId);
        setPlanningPaused(false);
        message.success("已继续生成大纲");
      } else {
        await pptExtensionApi.pausePlanning(planningId);
        setPlanningPaused(true);
        message.info("已暂停：当前阶段完成后停止推进");
      }
    } catch (e) {
      message.error(`操作失败：${String(e)}`);
    }
  }

  /** 读取当前大纲并保存，返回可用于渲染的 plan。 */
  async function saveCurrentPlan(): Promise<PptPlan | null> {
    if (!job) return null;
    let currentPlan = plan;
    try {
      if (!currentPlan) {
        currentPlan = await pptExtensionApi.getPlan(job.id);
        applySavedPlan(currentPlan);
      }
    } catch (e) {
      message.error(`读取大纲失败：${String(e)}`);
      return null;
    }
    if (!currentPlan?.slides.length) {
      message.warning("大纲至少需要 1 页");
      return null;
    }
    try {
      const normalized = await pptExtensionApi.updatePlan(job.id, currentPlan);
      applySavedPlan(normalized);
      setPlanDirty(false);
      return normalized;
    } catch (e) {
      message.error(`保存大纲失败：${String(e)}`);
      return null;
    }
  }

  /** 模板预览：保存文案与模板选项后，用引擎确定性填充写入 svg_preview。 */
  async function handleTemplatePreview() {
    if (!job) return;
    if (planDirty) {
      const saved = await saveCurrentPlan();
      if (!saved) return;
      // 大纲变化后后端会清空正式草稿，同步重置前端正式状态。
      setFormalized(false);
      setDraftSvgs({});
      setSelectedDraftFile(null);
      setPageSelection(null);
    }
    if (styleDirty) {
      try {
        const updated = await pptExtensionApi.updateJobOptions(job.id, {
          // 空字符串表示显式清空模板，null 会被后端视为“保持原值”
          layoutId: layoutId ?? "",
          chartIds,
          nativeCharts,
        });
        setJob(updated);
        setStyleDirty(false);
        setFormalized(false);
        setDraftSvgs({});
        setSelectedDraftFile(null);
        setPageSelection(null);
      } catch (e) {
        message.error(`保存模板设置失败：${String(e)}`);
        return;
      }
    }
    startTemplatePreview(job.id);
  }

  /** 正式生成/继续：应用模板、生成方式与模型，按所选效果渲染（暂停后复用已完成页）。 */
  async function handleRenderFormal() {
    if (!job) return;
    // 仅文案有改动才保存；否则保存会清空已完成草稿，破坏暂停续跑。
    if (planDirty) {
      const saved = await saveCurrentPlan();
      if (!saved) return;
    }
    try {
      const updatedJob = await pptExtensionApi.updateJobOptions(job.id, {
        // 空字符串表示显式清空模板，null 会被后端视为“保持原值”
        layoutId: layoutId ?? "",
        chartIds,
        nativeCharts,
        modelId: modelId ?? null,
      });
      setJob(updatedJob);
      setStyleDirty(false);
      // 模板变化时后端会清空 svg_preview，前端同步重置，避免回到步骤三看到旧图。
      setPreviewPages([]);
      setPreviewSvgs({});
      setPreviewSelectedFile(null);
      setPreviewStale(true);
      // 草稿预览只走 AI 单候选/三候选，避免误用程序模板渲染。
      const mode: PptDraftGenerationMode =
        formalMode === "bestOf" ? "bestOf" : "oneShot";
      startDraftRender(updatedJob.id, mode);
    } catch (e) {
      message.error(`启动正式生成失败：${String(e)}`);
    }
  }

  function getRegenModal() {
    return document.querySelector<HTMLElement>(".ppt-regen-modal");
  }

  function resetRegenModalPosition() {
    const modal = getRegenModal();
    if (modal) modal.style.transform = "";
  }

  function beginRegenModalDrag(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const modal = getRegenModal();
    if (!modal) return;
    event.preventDefault();
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(
      modal.style.transform,
    );
    const originX = match ? Number(match[1]) : 0;
    const originY = match ? Number(match[2]) : 0;
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: MouseEvent) => {
      modal.style.transform = `translate(${originX + moveEvent.clientX - startX}px, ${originY + moveEvent.clientY - startY}px)`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  async function handleConfirmRegenPrompt() {
    if (regenPromptPage == null) return;
    const page = regenPromptPage;
    const ok = await handleRegeneratePage(page, regenInstruction);
    if (ok) {
      setRegenPromptPage(null);
      setRegenProgress(null);
    }
  }

  async function handleRegeneratePage(page: number, instruction?: string) {
    if (!job) return false;
    setRegenPage(page);
    try {
      await pptExtensionApi.regenerateAiPage(
        job.id,
        page,
        3,
        null,
        instruction?.trim() || null,
      );
      const file = `P${String(page).padStart(2, "0")}.svg`;
      const svg = await pptExtensionApi.readDraftPage(job.id, file);
      setDraftSvgs((prev) => ({ ...prev, [file]: svg }));
      try {
        setPageSelection(await pptExtensionApi.getPageSelection(job.id));
      } catch {
        // 评分读取失败不影响预览刷新
      }
      setSelectedDraftFile(file);
      void refreshDraftStatus(job.id);
      message.success(`P${page} 已重新生成`);
      return true;
    } catch (e) {
      message.error(`重新生成第 ${page} 页失败：${String(e)}`);
      return false;
    } finally {
      setRegenPage(null);
    }
  }

  /** 草稿预览页内联提示词重新生成本页。 */
  async function handleInlineRegen(slide: PptSlide) {
    if (!job) return;
    if (isSlideDirty(slide)) {
      try {
        // 先仅同步该页文案（不清空其他页草稿），再重生成，避免整页预览消失。
        await pptExtensionApi.patchPlanSlide(job.id, slide);
        const baseline = planBaselineRef.current;
        if (baseline) baseline.set(slide.page, slideSignature(slide));
        recomputePlanDirty(plan);
      } catch (e) {
        message.error(`保存本页文案失败：${String(e)}`);
        return;
      }
    }
    const ok = await handleRegeneratePage(slide.page, inlineRegenText);
    if (ok) setInlineRegenText("");
  }

  async function handleSelectCandidate(index: number) {
    if (!job || !selectedDraftSlide) return;
    try {
      await pptExtensionApi.selectPageCandidate(
        job.id,
        selectedDraftSlide.page,
        index,
      );
      const file = `P${String(selectedDraftSlide.page).padStart(2, "0")}.svg`;
      const svg = await pptExtensionApi.readDraftPage(job.id, file);
      setDraftSvgs((prev) => ({ ...prev, [file]: svg }));
      setPageCandidates((prev) =>
        prev ? { ...prev, selected: index } : prev,
      );
      try {
        setPageSelection(await pptExtensionApi.getPageSelection(job.id));
      } catch {
        // 评分刷新失败不影响页面切换
      }
      void refreshDraftStatus(job.id);
      message.success("已切换结构候选");
    } catch (e) {
      message.error(`切换候选失败：${String(e)}`);
    }
  }

  async function handleExport() {
    if (!job) return;
    if (job.status === "paused") {
      message.warning("生成已暂停，请先继续生成并完成后再导出");
      return;
    }
    if (!formalized) {
      message.warning("请先在「草稿预览」生成正式草稿再导出");
      return;
    }
    // 以后端页级指纹状态为准：加页后又删页（内容未变）仍视为可导出。
    let status = draftStatus;
    try {
      status = await pptExtensionApi.draftStatus(job.id);
      setDraftStatus(status);
    } catch {
      // 状态读取失败时退回 formalized 检查，由后端导出前再次把关。
      status = draftStatus;
    }
    if (
      status &&
      status.status !== "fresh" &&
      status.status !== "order_stale"
    ) {
      const detail = status.pages
        .filter((page) => page.status !== "ready")
        .slice(0, 4)
        .map(
          (page) =>
            `P${String(page.page).padStart(2, "0")} ${page.message}`,
        )
        .join("；");
      message.warning(detail ? `草稿未就绪：${detail}` : "请先生成草稿后再导出");
      return;
    }
    setRunning(true);
    setLogs([]);
    setEngineProgress(0);
    setStep(4);
    try {
      await pptExtensionApi.exportDraft(job.id, exportDir);
    } catch (e) {
      setRunning(false);
      message.error(`启动导出失败：${String(e)}`);
    }
  }

  /** 从历史作业素材中移除一项（同步 source.md 与清单）。 */
  async function handleRemoveRestoredSource(source: PptSourceMeta) {
    if (!job || running) return;
    try {
      const next = await pptExtensionApi.removeJobSource(
        job.id,
        source.id,
        source.path ?? null,
      );
      setRestoredSources(next);
      const refreshed = await pptExtensionApi.getJob(job.id);
      if (refreshed) setJob(refreshed);
      // 素材变化后旧草稿与预览全部失效。
      setFormalized(false);
      setDraftSvgs({});
      setSelectedDraftFile(null);
      setPageSelection(null);
      setPreviewPages([]);
      setPreviewSvgs({});
      setPreviewSelectedFile(null);
      setPreviewStale(false);
      setUnderstanding("");
      message.success("已移除素材，重新生成大纲时将不再包含该文档");
      void loadHistory();
    } catch (e) {
      message.error(`移除素材失败：${String(e)}`);
    }
  }

  /** 生成 / 重新生成素材理解。 */
  async function handleUnderstand(force: boolean) {
    if (!job) {
      message.warning("请先在「制定大纲」生成作业，再分析素材");
      return;
    }
    setUnderstandingLoading(true);
    setMaterialLogs([]);
    try {
      const text = await pptExtensionApi.buildUnderstanding(
        job.id,
        modelId,
        force,
      );
      setUnderstanding(text);
      message.success(force ? "素材理解已重新生成" : "素材理解已就绪");
      Modal.confirm({
        title: "素材理解完成",
        content: "已理解素材，是否进入下一步「制定大纲」？",
        okText: "进入制定大纲",
        cancelText: "留在此页",
        onOk: () => setStep(1),
      });
    } catch (e) {
      message.error(`素材理解失败：${String(e)}`);
    } finally {
      setUnderstandingLoading(false);
    }
  }

  /** 把补充素材追加到当前历史作业。 */
  async function handleAppendManual() {
    if (!job || !manualText.trim()) return;
    try {
      await pptExtensionApi.appendJobSources(job.id, [], [], manualText.trim());
      // 保持输入框内容回显，仅刷新 manual.md 链接状态
      setManualPath(
        await pptExtensionApi.manualSourceFile(job.id).catch(() => null),
      );
      await refreshJobSources(job.id);
      message.success("补充素材已加入作业");
    } catch (e) {
      message.error(`追加素材失败：${String(e)}`);
    }
  }

  /** 打开素材理解文件。 */
  async function openUnderstandingFile(jobId: string) {
    try {
      const path = await pptExtensionApi.understandingFile(jobId);
      await openPath(path);
    } catch (e) {
      message.error(`打开素材理解失败：${String(e)}`);
    }
  }

  /** 打开补充素材文件 manual.md。 */
  async function openManualFile() {
    if (!job) return;
    try {
      const path = manualPath ?? (await pptExtensionApi.manualSourceFile(job.id));
      if (!path) {
        message.info("尚未追加过补充素材");
        return;
      }
      await openPath(path);
    } catch (e) {
      message.error(`打开补充素材失败：${String(e)}`);
    }
  }

  /** 查看某条历史素材的源文件。 */
  async function openSourceItem(source: PptSourceMeta) {
    if (!job) return;
    try {
      const path = await pptExtensionApi.sourceItemFile(
        job.id,
        source.id,
        source.path ?? null,
      );
      await openPath(path);
    } catch (e) {
      message.error(`查看素材失败：${String(e)}`);
    }
  }

  /** 删除补充素材 manual.md。 */
  async function handleDeleteManual() {
    if (!job) return;
    try {
      await pptExtensionApi.deleteManualSource(job.id);
      setManualPath(null);
      await refreshJobSources(job.id);
      message.success("已删除补充素材");
    } catch (e) {
      message.error(`删除补充素材失败：${String(e)}`);
    }
  }

  /** 历史作业追加素材后刷新清单与理解。 */
  async function refreshJobSources(jobId: string) {
    try {
      setRestoredSources(await pptExtensionApi.jobSources(jobId));
      setUnderstanding("");
      // 素材变化 → 理解/草稿/预览全部失效
      const refreshed = await pptExtensionApi.getJob(jobId);
      if (refreshed) setJob(refreshed);
      setFormalized(false);
      setDraftSvgs({});
      setSelectedDraftFile(null);
      setPageSelection(null);
      setPreviewPages([]);
      setPreviewSvgs({});
      setPreviewSelectedFile(null);
      setPreviewStale(false);
    } catch {
      // ignore
    }
  }

  async function resumeJob(record: PptJob) {
    try {
      const [nextPlan, options, sources] = await Promise.all([
        pptExtensionApi.getPlan(record.id),
        pptExtensionApi.getJobOptions(record.id).catch(() => null),
        pptExtensionApi
          .jobSources(record.id)
          .catch(() => [] as PptSourceMeta[]),
      ]);
      setJob(record);
      applySavedPlan(nextPlan);
      // 恢复历史作业的素材来源（只读展示），并清掉当前未提交的临时选择
      setSelectedNotes([]);
      setLocalSources([]);
      setRestoredSources(sources ?? []);
      setPlanDirty(false);
      setStyleDirty(false);
      setHistoryOpen(false);
      if (record.status === "running") setRunning(true);
      let generationMode: string | undefined;
      if (options) {
        const mode = options.generationMode;
        if (mode === "bestOf" || mode === "oneShot" || mode === "programmatic") {
          generationMode = mode;
        }
        if (typeof options.nativeCharts === "boolean") {
          setNativeCharts(options.nativeCharts);
        }
        if (typeof options.slideCount === "number") {
          setSlideCount(options.slideCount);
        }
        // 回填设置页字段，否则打开历史作业后返回风格/设置会显示为空。
        if (typeof options.title === "string" && options.title.trim()) {
          setTitle(options.title.trim());
          titleTouched.current = true;
        }
        if (typeof options.audience === "string") {
          setAudience(options.audience);
          audienceTouched.current = true;
        }
        const nextLayoutId =
          typeof options.layoutId === "string" && options.layoutId
            ? options.layoutId
            : undefined;
        setLayoutId(nextLayoutId);
        setChartIds(
          Array.isArray(options.chartIds)
            ? options.chartIds.filter(
                (id): id is string => typeof id === "string",
              )
            : [],
        );
        if (typeof options.language === "string" && options.language) {
          setLanguage(options.language);
        }
        if (typeof options.extraRequirements === "string") {
          setExtraRequirements(options.extraRequirements);
        }
        // 旧作业没有保存 manualText 时清空，避免沿用上一个作业的补充材料
        setManualText(
          typeof options.manualText === "string" ? options.manualText : "",
        );
        setModelId(
          typeof options.modelId === "number" ? options.modelId : undefined,
        );
      }
      // 草稿预览页只允许 AI 单/三候选；历史作业里的 programmatic 归一为单候选。
      const nextFormalMode: PptDraftGenerationMode =
        generationMode === "bestOf" ? "bestOf" : "oneShot";
      setFormalMode(nextFormalMode);
      const nextStep =
        record.stage === "done" || record.stage === "exporting"
          ? 4
          : record.stage === "draft_ready" || record.stage === "rendering_draft"
            ? 3
            : 1;
      setFormalized(
        record.stage === "done" ||
          record.stage === "exporting" ||
          record.stage === "draft_ready",
      );
      setStep(nextStep);
      setPaused(record.status === "paused");
      if (record.status === "running" && record.stage === "rendering_draft") {
        renderPurposeRef.current = "formal";
        renderKindRef.current = "formal";
      }
      void loadPreview(record.id);
      if (
        ["rendering_draft", "draft_ready", "exporting", "done"].includes(
          record.stage,
        )
      ) {
        void loadDraft(record.id, "formal");
      }
    } catch (e) {
      message.error(`打开作业失败：${String(e)}`);
    }
  }

  function handleStepChange(next: number) {
    if (next === viewStep) return;
    if (busy) {
      message.info("正在生成中，暂不能切换步骤");
      return;
    }
    // 向后导航：前置条件满足就真正推进流程，否则只读预览。
    if (next > step) {
      const reachable =
        next <= 1
          ? true
          : next <= 3
            ? !!plan
            : formalized && !planDirty && !styleDirty;
      if (reachable) {
        setStep(next);
        return;
      }
    }
    setViewStep(next);
  }

  function updateSlide(index: number, patch: Partial<PptSlide>) {
    setPlan((prev) => (prev ? updatePlanSlide(prev, index, patch) : prev));
    setPlanDirty(true);
  }

  /** 载入/保存后的大纲作为基线，后续按内容差异判断是否改动。 */
  function applySavedPlan(next: PptPlan | null) {
    planBaselineRef.current = planBaselineOf(next);
    setPlan(next);
    setPlanDirty(false);
  }

  /** 某页内容是否与基线不同（新增页也视为有改动）。 */
  function isSlideDirty(slide: PptSlide): boolean {
    const baseline = planBaselineRef.current;
    if (!baseline) return false;
    return baseline.get(slide.page) !== slideSignature(slide);
  }

  function recomputePlanDirty(current: PptPlan | null) {
    const baseline = planBaselineRef.current;
    if (!current || !baseline) {
      setPlanDirty(false);
      return;
    }
    const dirty =
      baseline.size !== current.slides.length ||
      current.slides.some(
        (slide) => baseline.get(slide.page) !== slideSignature(slide),
      );
    setPlanDirty(dirty);
  }

  function addSlide(afterIndex?: number) {
    if (!plan) return;
    const insertAt =
      afterIndex == null || afterIndex < 0
        ? plan.slides.length
        : Math.min(afterIndex + 1, plan.slides.length);
    setPlan(addPlanSlide(plan, afterIndex));
    setPlanDirty(true);
    setSelectedDraftFile(
      `P${String(insertAt + 1).padStart(2, "0")}.svg`,
    );
    // 后端草稿未变；刷新状态用于提示「新增页未生成」。
    if (job) void refreshDraftStatus(job.id);
    message.info(
      `已在第 ${insertAt} 页后新增一页；左侧草稿仍是旧版本，点击「生成预览」后同步`,
    );
  }

  function removeSlide(index: number) {
    if (!plan) return;
    const nextPlan = removePlanSlide(plan, index);
    setPlan(nextPlan);
    setPlanDirty(true);
    // 删除后把选中项移到相邻有效页，避免停留在已不存在的 Pxx.svg。
    const fallback =
      nextPlan.slides[Math.min(index, nextPlan.slides.length - 1)];
    setSelectedDraftFile(
      fallback ? `P${String(fallback.page).padStart(2, "0")}.svg` : null,
    );
    // 仅改前端大纲时后端仍为 fresh；若此前保存过则会显示 stale。
    if (job) void refreshDraftStatus(job.id);
    message.info("已删除该页；点击「重新生成草稿」后左侧预览同步");
  }

  function moveSlide(index: number, delta: number) {
    if (!plan) return;
    const target = index + delta;
    if (target < 0 || target >= plan.slides.length) return;
    const nextPlan = movePlanSlide(plan, index, delta);
    setPlan(nextPlan);
    setPlanDirty(true);
    const moved = nextPlan.slides[target];
    if (moved) {
      setSelectedDraftFile(`P${String(moved.page).padStart(2, "0")}.svg`);
    }
    if (job) void refreshDraftStatus(job.id);
    message.info(
      `已将第 ${index + 1} 页${delta < 0 ? "上移" : "下移"}到第 ${target + 1} 页；左侧草稿是旧顺序，点击「重新生成草稿」后同步`,
    );
  }

  function changeLayout(next?: string) {
    setLayoutId(next);
    setStyleDirty(true);
    setPreviewStale(true);
  }

  function changeChartIds(next: string[]) {
    setChartIds(next);
    setStyleDirty(true);
    setPreviewStale(true);
  }

  function changeNativeCharts(next: boolean) {
    setNativeCharts(next);
    setStyleDirty(true);
    setPreviewStale(true);
  }

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistory(await pptExtensionApi.listJobs(50));
    } catch (e) {
      message.error(`加载历史作业失败：${String(e)}`);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (historyOpen && isTauri()) void loadHistory();
  }, [historyOpen, loadHistory]);

  // 右侧栏「最近 5 个历史 PPT」需要在页面加载时就拿到数据
  useEffect(() => {
    if (isTauri()) void loadHistory();
  }, [loadHistory]);

  // 打开作业时读取素材理解
  useEffect(() => {
    if (!job?.id || !isTauri()) {
      setUnderstanding("");
      return;
    }
    let cancelled = false;
    pptExtensionApi
      .readUnderstanding(job.id)
      .then((text) => {
        if (!cancelled) setUnderstanding(text);
      })
      .catch(() => {
        if (!cancelled) setUnderstanding("");
      });
    return () => {
      cancelled = true;
    };
  }, [job?.id]);

  // 打开作业时回填各步骤已保存的日志
  useEffect(() => {
    if (!job?.id || !isTauri()) return;
    let cancelled = false;
    pptExtensionApi
      .readStepLogs(job.id)
      .then((data) => {
        if (cancelled) return;
        setMaterialLogs([...data.material, ...data.understanding]);
        setPlanLogs(data.planning);
        setLogs(data.engine);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [job?.id]);

  // 打开作业时探测补充素材文件
  useEffect(() => {
    if (!job?.id || !isTauri()) {
      setManualPath(null);
      return;
    }
    let cancelled = false;
    pptExtensionApi
      .manualSourceFile(job.id)
      .then((path) => {
        if (!cancelled) setManualPath(path);
      })
      .catch(() => {
        if (!cancelled) setManualPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [job?.id]);

  async function handleRetryJob(jobId: string) {
    try {
      const created = await pptExtensionApi.retryJob(jobId);
      const nextPlan = await pptExtensionApi.getPlan(created.id);
      setJob(created);
      applySavedPlan(nextPlan);
      setPlanDirty(false);
      setStyleDirty(false);
      setDraftSvgs({});
      setSelectedDraftFile(null);
      setHistoryOpen(false);
      message.success("已基于原素材和大纲创建新作业");
      setStep(1);
    } catch (e) {
      message.error(`重试失败：${String(e)}`);
    }
  }

  /** 新建 PPT 作业：清空当前编辑态，回到素材步骤。 */
  function handleNewJob() {
    if (running || creating || regenerating) {
      message.info("正在生成中，暂不能新建作业");
      return;
    }
    setJob(null);
    setPlan(null);
    planBaselineRef.current = null;
    setRestoredSources([]);
    setUnderstanding("");
    setSelectedNotes([]);
    setLocalSources([]);
    setManualText("");
    setTitle("");
    setAudience("");
    setExtraRequirements("");
    setSlideCount(undefined);
    setLayoutId(undefined);
    setChartIds([]);
    setNativeCharts(false);
    setPlanDirty(false);
    setStyleDirty(false);
    setFormalized(false);
    setPaused(false);
    setStep(0);
    setPlanLogs([]);
    setMaterialLogs([]);
    setPlanningSlides([]);
    setLogs([]);
    setDraftSvgs({});
    setSelectedDraftFile(null);
    setPageSelection(null);
    setPageCandidates(null);
    setPreviewPages([]);
    setPreviewSvgs({});
    setPreviewSelectedFile(null);
    setPreviewStale(false);
    try {
      localStorage.removeItem(PPT_ACTIVE_JOB_KEY);
    } catch {
      // ignore
    }
    void loadHistory();
  }

  async function handleDeleteJob(jobId: string) {
    try {
      await pptExtensionApi.deleteJob(jobId);
      if (job?.id === jobId) {
        setJob(null);
        setPlan(null);
        planBaselineRef.current = null;
        setRestoredSources([]);
        setSlideCount(undefined);
        setPlanDirty(false);
        setStyleDirty(false);
        setFormalized(false);
        setPaused(false);
        setStep(0);
        try {
          localStorage.removeItem(PPT_ACTIVE_JOB_KEY);
        } catch {
          // ignore
        }
      }
      message.success("作业已删除");
      await loadHistory();
    } catch (e) {
      message.error(`删除失败：${String(e)}`);
    }
  }

  async function handleDiagnostics(jobId: string) {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (!selected || Array.isArray(selected)) return;
      const path = await pptExtensionApi.exportDiagnostics(jobId, selected);
      message.success(`诊断包已导出：${path}`);
      await revealItemInDir(path);
    } catch (e) {
      message.error(`导出诊断包失败：${String(e)}`);
    }
  }

  async function handleCleanupJobs() {
    try {
      const removed = await pptExtensionApi.cleanupJobs(10);
      message.success(`已清理 ${removed} 个旧作业`);
      await loadHistory();
    } catch (e) {
      message.error(`清理失败：${String(e)}`);
    }
  }

  async function handleCancel() {
    if (!job) return;
    try {
      await pptExtensionApi.cancelJob(job.id);
      message.info("已请求取消");
    } catch (e) {
      message.error(String(e));
    }
  }

  /** 暂停 / 继续 AI 草稿生成（后端在页块边界生效，已完成页保留） */
  async function handleTogglePause() {
    if (!job) return;
    try {
      if (paused) {
        await pptExtensionApi.resumeJob(job.id);
        setPaused(false);
        message.success("已继续生成");
      } else {
        await pptExtensionApi.pauseJob(job.id);
        setPaused(true);
        message.info("已暂停：当前页块完成后停止推进");
      }
    } catch (e) {
      message.error(`操作失败：${String(e)}`);
    }
  }

  const layoutOptions = useMemo(
    () =>
      Object.entries(catalog?.layouts ?? {}).map(([id, meta]) => ({
        value: id,
        label: `${layoutDisplayName(id, meta)}${meta.page_count ? ` · ${meta.page_count} 页` : ""}`,
        description: layoutDescription(meta),
        source: meta.source,
        support: {
          supportsStructured: meta.supportsStructured,
          structured: meta.structured,
          supportsLegacy: meta.supportsLegacy,
          legacy: meta.legacy,
        },
      })),
    [catalog],
  );

  const selectedLayoutLabel = useMemo(() => {
    if (!layoutId) return "";
    return layoutDisplayName(layoutId, catalog?.layouts?.[layoutId]);
  }, [layoutId, catalog]);

  const selectedPageNumber = pageFromDraftFile(selectedDraftFile);
  const selectedDraftIndex =
    selectedPageNumber == null
      ? -1
      : (plan?.slides.findIndex((slide) => slide.page === selectedPageNumber) ?? -1);
  const selectedDraftSlide =
    selectedDraftIndex >= 0 ? plan?.slides[selectedDraftIndex] : undefined;
  // 制定大纲页默认选中第一页，便于直接编辑
  useEffect(() => {
    if (viewStep !== 1 || !plan?.slides.length || selectedDraftFile) return;
    setSelectedDraftFile(
      `P${String(plan.slides[0].page).padStart(2, "0")}.svg`,
    );
  }, [viewStep, plan, selectedDraftFile]);

  const previewCandidatePage = previewSelectedFile
    ? pageFromDraftFile(previewSelectedFile)
    : previewPages[0]?.page ?? null;
  const candidatePage =
    viewStep === 2 ? previewCandidatePage : selectedDraftSlide?.page;

  useEffect(() => {
    // 页面候选属于效果与模板页：步骤三按当前模板预览页取候选。
    if (!job?.id || viewStep !== 2 || !candidatePage) {
      setPageCandidates(null);
      return;
    }
    let cancelled = false;
    setCandidateLoading(true);
    void pptExtensionApi
      .getPageCandidates(job.id, candidatePage)
      .then((data) => {
        if (!cancelled) setPageCandidates(data);
      })
      .catch(() => {
        if (!cancelled) setPageCandidates(null);
      })
      .finally(() => {
        if (!cancelled) setCandidateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [job?.id, viewStep, candidatePage, draftSvgs, previewSelectedFile]);
  const busy = running || creating || regenerating;
  const previewingFuture = viewStep > step;
  // 预览后续步骤时，隐藏会触发生成/导出的操作，避免误触
  const previewLock = previewingFuture ? { disabled: true } : {};

  // 真实流程推进时，视图自动跟随到该步骤
  useEffect(() => {
    setViewStep(step);
  }, [step]);

  // 按内容签名判断大纲是否真的改动（增页后删回不再误判为已修改）。
  useEffect(() => {
    if (!plan) return;
    if (planBaselineRef.current == null) return;
    recomputePlanDirty(plan);
  }, [plan]);

  // 进入「效果与模板」时按需读取模板预览；每个作业只自动加载一次，避免闪烁。
  useEffect(() => {
    if (!job?.id || viewStep !== 2) return;
    if (previewAutoLoadedJob.current === job.id) return;
    previewAutoLoadedJob.current = job.id;
    void loadPreview(job.id);
  }, [job?.id, viewStep, loadPreview]);

  const chartOptions = useMemo(() => {
    // charts_index.json 的结构是 { meta, aliases, charts: { area_chart: {...}, ... } }
    const chartMap = chartMapOf(catalog?.charts);
    return Object.entries(chartMap).map(([id, meta]) => ({
      value: id,
      label: chartDisplayName(id, meta),
      description: chartDescription(id, meta),
    }));
  }, [catalog]);

  if (status && (!status.installed || !status.enabled || !status.supportsPpt)) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Card>
          <Space direction="vertical" size="middle" className="w-full">
            <Typography.Title level={3} className="!mb-0">
              PPT 生成需要扩展包
            </Typography.Title>
            <Alert
              type={status.installed ? "warning" : "info"}
              showIcon
              message={
                status.installed
                  ? status.enabled
                    ? "当前扩展包不提供 PPT 引擎"
                    : "PPT 扩展包已禁用"
                  : "尚未安装 PPT 扩展包"
              }
              description="扩展包按需安装，主程序不会内置 Python 引擎。安装并启用后即可在此通过文档生成 PPT。"
            />
            <Space>
              <Button type="primary" onClick={() => navigate("/extensions")}>
                前往扩展管理
              </Button>
              <Button onClick={() => void loadStatus()}>重新检测</Button>
            </Space>
          </Space>
        </Card>
      </div>
    );
  }

  /** 草稿工作区：左侧文案页列表，右侧预览与编辑。
   * showPreview=false 时用于「制定大纲」：只编辑文案，不展示任何 SVG 预览。 */
  function renderDraftWorkspace({
    mode,
    emptyHint,
    showPreview = true,
  }: {
    mode: "preview" | "formal";
    emptyHint: string;
    showPreview?: boolean;
  }) {
    // 大纲规划中优先展示快照（标题清单/逐页扩展），不必等最终 plan
    const slides =
      (creating || regenerating) && planningSlides.length > 0
        ? planningSlides
        : plan?.slides ?? [];
    const stateVerb = mode === "preview" ? "快速排版" : "正式生成";
    const fileOf = (page: number) => `P${String(page).padStart(2, "0")}.svg`;
    // 还没选页时默认展示第一页的大纲，生成过程中也能先看到文案内容
    const activeFile = selectedDraftFile ?? (slides[0] ? fileOf(slides[0].page) : null);
    const activeSlide = activeFile
      ? slides.find((slide) => fileOf(slide.page) === activeFile)
      : undefined;
    // 只有当前页文案改动/新增页时才隐藏该页预览；其他页继续显示。
    const activeDirty = activeSlide ? isSlideDirty(activeSlide) : planDirty;
    const activeSvg =
      activeFile && !activeDirty ? draftSvgs[activeFile] : undefined;
    const activeRendering =
      !!activeSlide && running && draftProgress?.page === activeSlide.page;
    return (
      <div className="space-y-3">
        {running && (
          <>
            <Progress
              percent={
                draftProgress && draftProgress.total > 0
                  ? Math.round((draftDoneCount / draftProgress.total) * 100)
                  : progressPercent
              }
              status="active"
            />
            {draftProgress && (
              <Text type="secondary">
                {`${stateVerb}中：${draftDoneCount}/${draftProgress.total} · 当前 P${draftProgress.page} · 候选 ${draftProgress.candidateCount || "…"} · ${draftProgress.status}`}
              </Text>
            )}
            {mode === "formal" && formalMode !== "programmatic" && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="small"
                  icon={paused ? <Play size={13} /> : <Pause size={13} />}
                  onClick={() => void handleTogglePause()}
                >
                  {paused ? "继续生成" : "暂停"}
                </Button>
                <Text type="secondary" className="text-xs">
                  {paused
                    ? "已暂停：当前批次完成后停止推进，已完成页面保留"
                    : "暂停在当前批次（2 页）结束后生效"}
                </Text>
              </div>
            )}
          </>
        )}
        {!running && job && ["failed", "cancelled"].includes(job.status) && (
          <Alert
            type="error"
            showIcon
            message={`${mode === "preview" ? "预览" : "正式 PPT"}生成${
              job.status === "cancelled" ? "已取消" : "失败"
            }`}
            description={job.errorMessage ?? job.errorCode ?? "未知错误"}
          />
        )}
        {!running && draftLoading ? (
          <Text type="secondary">正在加载草稿页面…</Text>
        ) : slides.length === 0 ? (
          <Empty description="暂无文案大纲" />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="max-h-[640px] overflow-y-auto rounded border border-slate-200">
              {planDirty && (
                <div className="sticky top-0 z-[1] border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                  文案已修改：预览仍是旧内容，重新生成后更新
                </div>
              )}
              <List
                size="small"
                dataSource={slides}
                renderItem={(slide) => {
                  const file = `P${String(slide.page).padStart(2, "0")}.svg`;
                  const rendered =
                    !isSlideDirty(slide) && Boolean(draftSvgs[file]);
                  // 评分只属于已渲染且未改动的页面；新增页/改动后不继承旧评分。
                  const selectionEntry = rendered
                    ? pageSelection?.pages.find(
                        (item) => item.page === slide.page,
                      )
                    : undefined;
                  const score = selectionEntry?.score;
                  const scoreIssues = selectionEntry?.issues ?? [];
                  const rendering =
                    !rendered && running && draftProgress?.page === slide.page;
                  const statusLabel = rendered
                    ? "已完成"
                    : rendering
                      ? "渲染中"
                      : "未开始";
                  return (
                    <List.Item
                      className={`cursor-pointer !px-3 ${
                        selectedDraftFile === file ? "bg-blue-50" : ""
                      }`}
                      onClick={() => setSelectedDraftFile(file)}
                    >
                      <div className="flex w-full items-center gap-2">
                        {showPreview && (
                          <Tooltip title={statusLabel}>
                            {rendered ? (
                              <CheckCircle2
                                size={15}
                                className="shrink-0 text-emerald-500"
                              />
                            ) : rendering ? (
                              <Loader2
                                size={15}
                                className="shrink-0 animate-spin text-blue-500"
                              />
                            ) : (
                              <Circle
                                size={15}
                                className="shrink-0 text-slate-300"
                              />
                            )}
                          </Tooltip>
                        )}
                        <Tag color="blue">P{slide.page}</Tag>
                        <div className="min-w-0 flex-1">
                          <Text
                            ellipsis={{ tooltip: slide.title }}
                            className="block"
                          >
                            {slide.title}
                          </Text>
                          <Text
                            type="secondary"
                            className="block text-xs"
                            ellipsis
                          >
                            {slide.coreMessage || (showPreview ? (rendered ? file : statusLabel) : "")}
                          </Text>
                        </div>
                        {showPreview && score != null && (
                          <Tooltip
                            placement="left"
                            title={
                              <div className="max-w-[300px]">
                                <div>评分：{score}</div>
                                <div className="mt-1">扣分原因</div>
                                {scoreIssues.length > 0 ? (
                                  <ul className="mt-1 list-disc space-y-1 pl-4">
                                    {scoreIssues.map((issue, issueIndex) => (
                                      <li key={`${issueIndex}-${issue}`}>
                                        <div>{issue}</div>
                                        <div className="text-xs text-slate-300">
                                          建议：{scoreSuggestion(issue)}
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <div className="mt-1 text-xs">
                                    暂无扣分原因（旧评分，重新生成此页可获取明细）
                                  </div>
                                )}
                                {(slide.evidence?.length ?? 0) > 0 && (
                                  <div className="mt-2">
                                    <div>内容应包含（evidence）</div>
                                    <ul className="mt-1 list-disc pl-4 text-xs">
                                      {slide.evidence?.map((item, itemIndex) => (
                                        <li key={`${itemIndex}-${item}`}>
                                          {item}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            }
                          >
                            <span className="cursor-help">
                              <Tag
                                color={
                                  score >= 70
                                    ? "green"
                                    : score >= 55
                                      ? "gold"
                                      : "red"
                                }
                              >
                                {score}
                              </Tag>
                            </span>
                          </Tooltip>
                        )}
                      </div>
                    </List.Item>
                  );
                }}
              />
            </div>
            <div className="space-y-3">
              {showPreview && activeSlide ? (
                <>
                  {/* 页面预览（未渲染时占位） */}
                  {activeSvg ? (
                    <div className="flex min-h-[320px] items-center justify-center rounded border border-slate-200 bg-slate-50 p-2">
                      <img
                        src={svgDataUrl(activeSvg)}
                        alt="页面预览"
                        className="max-h-[420px] w-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="flex min-h-[220px] items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 p-4">
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                          activeRendering
                            ? "正在渲染本页…"
                            : running
                              ? "等待渲染…"
                              : activeDirty
                                ? "本页文案已修改，点击「重新生成此页」后更新"
                                : "页面预览尚未生成"
                        }
                      />
                    </div>
                  )}
                  {mode === "formal" && !running && (
                    <div className="flex items-end gap-2 rounded-md border border-slate-200 px-3 py-2">
                      <Input.TextArea
                        className="min-w-0 flex-1"
                        rows={2}
                        value={inlineRegenText}
                        onChange={(e) => setInlineRegenText(e.target.value)}
                        disabled={previewingFuture}
                        placeholder="输入本页修改提示词，例如：突出对比数据、减少文字、换用时间轴结构…"
                      />
                      <Button
                        type="primary"
                        className="shrink-0"
                        icon={<Sparkles size={14} />}
                        loading={regenPage === activeSlide.page}
                        disabled={previewingFuture}
                        onClick={() => void handleInlineRegen(activeSlide)}
                      >
                        重新生成此页
                      </Button>
                    </div>
                  )}
                </>
              ) : showPreview ? (
                <Empty description={running ? "正在渲染预览…" : emptyHint} />
              ) : null}
              {selectedDraftSlide && !running && (
                <Card
                  size="small"
                  title={`编辑 P${selectedDraftSlide.page}`}
                  extra={
                    previewingFuture ? (
                      <Tag color="blue">只读预览</Tag>
                    ) : (
                      <Space size={4}>
                        <Tooltip title="在当前页之后新增一页">
                          <Button
                            icon={<Plus size={14} />}
                            size="small"
                            type="text"
                            onClick={() =>
                              addSlide(selectedDraftIndex)
                            }
                          />
                        </Tooltip>
                        <Tooltip title="上移">
                          <Button
                            size="small"
                            type="text"
                            icon={<ArrowUp size={14} />}
                            disabled={selectedDraftIndex <= 0}
                            onClick={() => moveSlide(selectedDraftIndex, -1)}
                          />
                        </Tooltip>
                        <Tooltip title="下移">
                          <Button
                            size="small"
                            type="text"
                            icon={<ArrowDown size={14} />}
                            disabled={
                              !plan ||
                              selectedDraftIndex >= plan.slides.length - 1
                            }
                            onClick={() => moveSlide(selectedDraftIndex, 1)}
                          />
                        </Tooltip>
                        <Popconfirm
                          title="删除这一页？"
                          onConfirm={() => removeSlide(selectedDraftIndex)}
                          disabled={!!plan && plan.slides.length <= 1}
                        >
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<Trash2 size={14} />}
                            disabled={!!plan && plan.slides.length <= 1}
                          />
                        </Popconfirm>
                      </Space>
                    )
                  }
                >
                  <Space direction="vertical" size="small" className="w-full">
                    <div>
                      <FieldLabel
                        label="页面标题"
                        tip="该页幻灯片的主标题，通常是一句结论或主题词。"
                      />
                      <Input
                        value={selectedDraftSlide.title}
                        {...previewLock}
                        onChange={(event) =>
                          updateSlide(selectedDraftIndex, {
                            title: event.target.value,
                          })
                        }
                        placeholder="例如：技术演进路线"
                      />
                    </div>
                    <div>
                      <FieldLabel
                        label="核心信息 / 副标题"
                        tip="一句话核心结论，用于补充主标题，常作为页面副标题或引语。"
                      />
                      <Input.TextArea
                        rows={2}
                        value={selectedDraftSlide.coreMessage}
                        {...previewLock}
                        onChange={(event) =>
                          updateSlide(selectedDraftIndex, {
                            coreMessage: event.target.value,
                          })
                        }
                        placeholder="例如：从规则驱动走向数据驱动"
                      />
                    </div>
                    <div>
                      <FieldLabel
                        label="要点（每行一条）"
                        tip="页面正文要点，建议 3–6 条短句；每行一条，空行会被忽略。"
                      />
                      <Input.TextArea
                        rows={4}
                        value={selectedDraftSlide.bullets.join("\n")}
                        {...previewLock}
                        onChange={(event) =>
                          updateSlide(selectedDraftIndex, {
                            bullets: event.target.value
                              .split("\n")
                              .map((value) => value.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder={"第一行一条要点\n第二条要点\n第三条要点"}
                      />
                    </div>
                    {selectedDraftSlide.chart && (
                      <Tag color="purple">
                        图表：{selectedDraftSlide.chart.type} ·{" "}
                        {selectedDraftSlide.chart.categories.length} 类
                      </Tag>
                    )}
                    <Text type="secondary" className="text-xs">
                      {showPreview
                        ? "修改文案后，点击「重新生成此页」刷新；第一版不支持 SVG 元素拖拽。"
                        : "修改文案或页序后，进入下一步生成时会使用最新内容。"}
                    </Text>
                  </Space>
                </Card>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  type SourceRow =
    | { key: string; kind: "source"; source: PptSourceMeta }
    | { key: string; kind: "manual" };
  const sourceRows: SourceRow[] = [
    ...restoredSources.map((source) => ({
      key: `source-${source.path ?? source.id}`,
      kind: "source" as const,
      source,
    })),
    ...(job && manualPath ? [{ key: "manual", kind: "manual" as const }] : []),
  ];

  const previewActiveFile =
    previewSelectedFile ?? previewPages[0]?.file ?? null;
  const previewActiveSvg = previewActiveFile
    ? previewSvgs[previewActiveFile]
    : undefined;

  const stepItems: StepRailItem[] = [
    {
      title: PPT_STEP_TITLES[0],
      tip: PPT_STEP_META[0].tip,
      description:
        displaySelectedCount > 0
          ? `已选 ${displaySelectedCount} 项素材`
          : "选择文档 / 填写标题",
    },
    {
      title: PPT_STEP_TITLES[1],
      tip: PPT_STEP_META[1].tip,
      description: plan
        ? `${plan.slides.length} 页大纲`
        : "生成并确认大纲",
    },
    {
      title: PPT_STEP_TITLES[2],
      tip: PPT_STEP_META[2].tip,
      description: previewLoading
        ? "正在生成模板预览"
        : previewStale
          ? "模板已改，需重新预览"
          : previewPages.length > 0
            ? `${previewPages.length} 页模板预览`
            : selectedLayoutLabel
              ? `版式：${selectedLayoutLabel}`
              : "选模板并生成预览",
    },
    {
      title: PPT_STEP_TITLES[3],
      tip: PPT_STEP_META[3].tip,
      description: formalized
        ? "正式草稿已生成，可预览后导出"
        : running
          ? "正在渲染正式草稿"
          : "生成并确认正式草稿",
    },
    {
      title: PPT_STEP_TITLES[4],
      tip: PPT_STEP_META[4].tip,
      description:
        job?.status === "succeeded" && job.stage === "done"
          ? "已导出"
          : "导出可编辑 PPTX",
    },
  ];

  return (
    // /ppt 走 ModuleViewFrame 的 fullscreen 布局（正文容器 overflow:hidden），
    // 主区独立滚动，右侧步骤列常驻。
    <div className="flex h-full w-full">
    <main className="min-w-0 flex-1 overflow-y-auto">
    <div className="mx-auto max-w-6xl p-6">
      {status?.platformCompatible === false && (
        <Alert
          className="mb-4"
          type="error"
          showIcon
          message="当前平台与扩展包不兼容"
          description={`扩展包支持的平台与当前平台 ${status.platform ?? ""} 不匹配，请安装对应平台的扩展包。`}
        />
      )}

      {status?.win7 && (
        <Alert
          className="mb-4"
          type="warning"
          showIcon
          message="检测到 Windows 7"
          description={
            status.embeddedPython
              ? "当前扩展包使用内嵌 Python。请先在目标机器上实测 Python 3.10+ 是否可运行；官方 CPython 3.10+ 不支持 Win7。"
              : "当前扩展包使用系统 Python。Win7 上请改用可在该平台运行的 Python 3.8.10 内嵌构建，或暂时不启用 PPT 生成。"
          }
        />
      )}

      {!inTauri && (
        <Alert
          className="mb-4"
          type="info"
          showIcon
          message="浏览器预览模式"
          description="当前页面运行在浏览器中，PPT 扩展与本地数据接口不可用，界面仅用于查看布局与导航。"
        />
      )}

      {running && step <= 1 && planProgress && (
        <Alert
          className="mb-4"
          type="info"
          showIcon
          message={planProgress.message}
          description={
            planProgress.total > 0
              ? `进度 ${planProgress.current}/${planProgress.total} · 阶段 ${planProgress.stage}`
              : `阶段：${planProgress.stage}`
          }
        />
      )}

      {viewStep === 0 && (
      <div className="space-y-4">
        <Card
          title={
            <StepTitle
              title="PPT设置"
              tip="先选择素材后，系统会自动识别并填充 PPT 标题与汇报对象。"
            />
          }
          extra={
            <ModelPicker
              models={models}
              value={modelId}
              onChange={setModelId}
              disabled={busy}
            />
          }
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <FieldLabel
                label="PPT 标题"
                tip="作为主题参与大纲规划，同时用于导出文件名。"
              />
              <Input
                value={title}
                onChange={(e) => {
                  titleTouched.current = true;
                  setTitle(e.target.value);
                }}
                placeholder="例如：技术研究及发展趋势分析"
              />
              {suggestingMeta && (
                <Text type="secondary" className="mt-1 block text-xs">
                  AI 正在根据素材识别标题与汇报对象…
                </Text>
              )}
            </div>
            <div>
              <FieldLabel
                label="汇报对象"
                tip="告诉 AI 讲给谁听，会影响内容深度与语气。"
              />
              <Input
                value={audience}
                onChange={(e) => {
                  audienceTouched.current = true;
                  setAudience(e.target.value);
                }}
                placeholder="例如：本科教学、企业客户、技术评审"
              />
            </div>
            <div>
              <Text className="mb-1 block">语言</Text>
              <Select
                className="w-full"
                value={language}
                onChange={setLanguage}
                options={[
                  { value: "zh-CN", label: "简体中文" },
                  { value: "en-US", label: "English" },
                ]}
              />
            </div>
            <div className="md:col-span-3">
              <FieldLabel
                label="生成要求（结构 / 风格）"
                tip="仅作为规划指令使用，不参与素材理解：只约束大纲结构与风格，不替代素材内容。"
              />
              <div className="flex items-end gap-3">
                <Input.TextArea
                  className="min-w-0 flex-1"
                  rows={2}
                  value={extraRequirements}
                  onChange={(e) => setExtraRequirements(e.target.value)}
                  placeholder="例如：偏重工艺流程图、少用文字；只约束大纲结构与风格，不替代素材内容"
                />
                <Tooltip
                  title={!job ? "生成大纲后可理解素材" : undefined}
                  placement="topRight"
                >
                  <Button
                    className="shrink-0 font-medium"
                    type={job ? "primary" : "default"}
                    size="large"
                    icon={<Sparkles size={16} />}
                    loading={understandingLoading}
                    disabled={running}
                    onClick={() =>
                      void handleUnderstand(Boolean(understanding.trim()))
                    }
                  >
                    理解素材
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>
        </Card>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title={`素材来源（已选 ${displaySelectedCount} 项）`}
          extra={
            <Text type="secondary">
              {showRestoredSources ? (
                <span>
                  历史素材 {restoredSources.length} 项 · 约{" "}
                  {restoredSourceChars.toLocaleString()} 字（只读）
                </span>
              ) : (
                <>
                  {selectedChars > 0
                    ? `文档约 ${selectedChars.toLocaleString()} 字符`
                    : ""}
                  {localSources.length > 0
                    ? `${selectedChars > 0 ? " · " : ""}本地文件 ${localSources.length} 个（生成时读取）`
                    : ""}
                </>
              )}
            </Text>
          }
        >
          <div className="mb-3 flex items-center gap-2">
            <Input.Search
              allowClear
              loading={searching}
              placeholder="搜索文档"
              value={searchKeyword}
              onChange={(e) => {
                setSearchKeyword(e.target.value);
                setDocPage(1);
              }}
              className="min-w-0 max-w-[320px] flex-1"
            />
            <Button
              icon={<FilePlus2 size={14} />}
              onClick={() => void addLocalFiles()}
              className="shrink-0"
            >
              添加本地文件
            </Button>
          </div>

          <List
            size="small"
            loading={searching}
            dataSource={documents}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    searchKeyword.trim() ? "没有匹配的文档" : "暂无文档"
                  }
                />
              ),
            }}
            className="max-h-[260px] overflow-y-auto"
            renderItem={(note) => {
              const added =
                selectedNoteIds.has(note.id) ||
                restoredSources.some((source) => source.id === note.id);
              const encrypted = note.is_encrypted;
              return (
                <List.Item
                  className="!px-1"
                  actions={[
                    <Tooltip
                      key="add"
                      title={
                        encrypted
                          ? "已加密，无法添加"
                          : added
                            ? "已添加"
                            : "添加到素材源"
                      }
                    >
                      <span>
                        <Button
                          size="small"
                          type="text"
                          aria-label="添加到素材源"
                          icon={<ChevronRight size={16} />}
                          disabled={added || encrypted}
                          onClick={() => addNoteSource(note)}
                        />
                      </span>
                    </Tooltip>,
                  ]}
                >
                  <List.Item.Meta
                    avatar={<FileText size={16} className="text-blue-600" />}
                    title={
                      <div className="flex min-w-0 items-center gap-1">
                        <Text
                          className="min-w-0 flex-1"
                          style={{ maxWidth: "100%" }}
                          ellipsis={{ tooltip: note.title || "无标题" }}
                        >
                          {note.title || "无标题"}
                        </Text>
                        {note.folder_id != null && (
                          <Tag className="shrink-0">
                            {folderName.get(note.folder_id) ?? "文件夹"}
                          </Tag>
                        )}
                        {encrypted && (
                          <Tag color="red" className="shrink-0">
                            已加密
                          </Tag>
                        )}
                      </div>
                    }
                    description={
                      <Text type="secondary" className="text-xs">
                        {note.word_count ?? note.content.length} 字 ·{" "}
                        {note.updated_at?.slice(0, 16).replace("T", " ") ?? ""}
                      </Text>
                    }
                  />
                </List.Item>
              );
            }}
          />

          <div className="mt-3 flex justify-center">
            <Pagination
              size="small"
              current={docPage}
              pageSize={PAGE_SIZE}
              total={docTotal}
              showSizeChanger={false}
              showTotal={(total) => `共 ${total} 篇`}
              onChange={(page) => setDocPage(page)}
            />
          </div>

        </Card>

        <Card title="素材源">
          <Space direction="vertical" size="middle" className="w-full">
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <Text>已选素材（{displaySelectedCount}）</Text>
                <Text type="secondary" className="text-xs">
                  {showRestoredSources
                    ? restoredSourceChars > 0
                      ? `约 ${restoredSourceChars.toLocaleString()} 字符（只读）`
                      : ""
                    : selectedChars > 0
                      ? `约 ${selectedChars.toLocaleString()} 字符`
                      : ""}
                </Text>
              </div>
              {displaySelectedCount === 0 ? (
                <Text type="secondary" className="text-xs">
                  从「素材来源」添加文档或本地文件
                </Text>
              ) : selectedCount === 0 ? null : (
                <div className="max-h-[160px] overflow-y-auto rounded-md border border-slate-200">
                  <List
                    size="small"
                    dataSource={[
                      ...selectedNotes.map((note) => ({
                        key: `note-${note.id}`,
                        title: note.title || "无标题",
                        tag: "文档",
                        detail: `${note.word_count ?? note.content.length} 字`,
                        onRemove: () => removeNoteSource(note.id),
                      })),
                      ...localSources.map((source) => ({
                        key: `file-${source.path}`,
                        title: source.title || baseName(source.path),
                        tag: sourceTypeLabel(source.sourceType),
                        detail: "",
                        onRemove: () => removeLocalSource(source.path),
                      })),
                    ]}
                    renderItem={(item) => (
                      <List.Item
                        className="!px-3"
                        actions={[
                          <Button
                            key="remove"
                            type="text"
                            danger
                            size="small"
                            icon={<Trash2 size={14} />}
                            onClick={item.onRemove}
                          />,
                        ]}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          <FileText size={14} className="shrink-0 text-slate-500" />
                          <Text
                            className="min-w-0 flex-1"
                            style={{ maxWidth: "100%" }}
                            ellipsis={{ tooltip: item.title }}
                          >
                            {item.title}
                          </Text>
                          <Tag color="blue" className="shrink-0">
                            {item.tag}
                          </Tag>
                          {item.detail && (
                            <Text type="secondary" className="shrink-0 text-xs">
                              {item.detail}
                            </Text>
                          )}
                        </div>
                      </List.Item>
                    )}
                  />
                </div>
              )}
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <Text type="secondary">
                  补充素材（可选，作为正文素材参与大纲）
                </Text>
                {job && (
                  <Button
                    size="small"
                    disabled={!manualText.trim() || running || previewingFuture}
                    onClick={() => void handleAppendManual()}
                  >
                    追加到作业
                  </Button>
                )}
              </div>
              <Input.TextArea
                rows={3}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder="粘贴需要纳入的正文/资料；会作为素材写入作业，与所选文档同等参与理解与规划"
              />
            </div>
            {job &&
              selectedNotes.length === 0 &&
              localSources.length === 0 &&
              (showRestoredSources || manualPath) && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                <Text type="secondary" className="mb-1 block text-xs">
                  历史作业素材（只读）
                </Text>
                <List
                  size="small"
                  rowKey={(row) => row.key}
                  dataSource={sourceRows}
                  renderItem={(row) =>
                    row.kind === "manual" ? (
                      <List.Item
                        className="!px-2 !py-1"
                        actions={[
                          <Tooltip key="view" title="查看补充素材">
                            <Button
                              size="small"
                              type="text"
                              aria-label="查看补充素材"
                              icon={<Eye size={14} />}
                              onClick={() => void openManualFile()}
                            />
                          </Tooltip>,
                          <Popconfirm
                            key="remove"
                            title="删除补充素材？"
                            description="将删除 manual.md，并让素材理解与草稿失效。"
                            onConfirm={() => void handleDeleteManual()}
                            disabled={running || previewingFuture}
                          >
                            <Button
                              size="small"
                              type="text"
                              danger
                              aria-label="删除补充素材"
                              icon={<Minus size={14} />}
                              disabled={running || previewingFuture}
                            />
                          </Popconfirm>,
                        ]}
                      >
                        <div className="flex w-full min-w-0 items-center gap-2">
                          <Tag color="purple">补充</Tag>
                          <Text ellipsis className="min-w-0 flex-1">
                            追加素材 manual.md
                          </Text>
                        </div>
                      </List.Item>
                    ) : (
                      <List.Item
                        className="!px-2 !py-1"
                        actions={[
                          <Tooltip key="view" title="查看素材文件">
                            <Button
                              size="small"
                              type="text"
                              aria-label="查看素材"
                              icon={<Eye size={14} />}
                              onClick={() => void openSourceItem(row.source)}
                            />
                          </Tooltip>,
                          <Tooltip key="remove" title="从作业素材中移除">
                            <Button
                              size="small"
                              type="text"
                              danger
                              disabled={running || previewingFuture}
                              aria-label="移除素材"
                              icon={<Minus size={14} />}
                              onClick={() =>
                                void handleRemoveRestoredSource(row.source)
                              }
                            />
                          </Tooltip>,
                        ]}
                      >
                        <div className="flex w-full min-w-0 items-center gap-2">
                          <Tag
                            color={row.source.id > 0 ? "blue" : "geekblue"}
                          >
                            {row.source.id > 0 ? "文档" : "本地文件"}
                          </Tag>
                          <Text ellipsis className="min-w-0 flex-1">
                            {row.source.title || "未命名素材"}
                          </Text>
                          <Text type="secondary" className="shrink-0 text-xs">
                            {(row.source.wordCount ?? 0).toLocaleString()} 字
                          </Text>
                        </div>
                      </List.Item>
                    )
                  }
                />
              </div>
            )}
            {job &&
              plan &&
              selectedNotes.length === 0 &&
              localSources.length === 0 &&
              !manualText.trim() && (
                <Alert
                  type="info"
                  showIcon
                  message="当前打开的是历史作业"
                  description={
                    understanding.trim() ? (
                      <span>
                        当前作业素材已提炼为{" "}
                        <Button
                          type="link"
                          size="small"
                          className="!h-auto !p-0 align-baseline"
                          onClick={() => void openUnderstandingFile(job.id)}
                        >
                          understanding.md
                        </Button>
                        ，生成大纲时会复用；素材变化后需再次理解。
                      </span>
                    ) : (
                      "当前作业尚未生成素材理解。"
                    )
                  }
                />
              )}
          </Space>
        </Card>
        </div>
        {(materialLogs.length > 0 ||
          creating ||
          regenerating ||
          understandingLoading) && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Space size={6}>
                <Text strong>素材处理日志</Text>
                <Tag
                  color={
                    creating || regenerating || understandingLoading
                      ? "processing"
                      : "default"
                  }
                >
                  {creating || regenerating || understandingLoading
                    ? "进行中"
                    : "已结束"}
                </Tag>
              </Space>
            </div>
            <div className="mt-2 max-h-[180px] overflow-y-auto rounded border border-slate-200 bg-white p-2 font-mono text-xs">
              {materialLogs.length === 0 ? (
                <Text type="secondary">等待素材处理日志…</Text>
              ) : (
                materialLogs.map((line, index) => (
                  <div
                    key={`${index}-${line.slice(0, 12)}`}
                    className="whitespace-pre-wrap break-all"
                  >
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      )}

      {viewStep === 1 && (
        <Card
          className="mt-4"
          title={
            <StepTitle
              title={
                creating || regenerating
                  ? "大纲生成 · AI 逐页扩展"
                  : `制定大纲${plan ? `（${plan.slides.length} 页）` : ""}`
              }
              short={
                creating || regenerating
                  ? "AI 正在分块理解素材并逐页扩展，可随时暂停/继续"
                  : PPT_STEP_META[1].short
              }
              tip={PPT_STEP_META[1].tip}
            />
          }
          extra={
            <Space size={8} wrap>
              {previewingFuture && <Tag color="blue">只读预览</Tag>}
              <ModelPicker
                models={models}
                value={modelId}
                onChange={setModelId}
                disabled={busy}
              />
            </Space>
          }
        >
          <Space direction="vertical" size="middle" className="w-full">
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 px-3 py-2">
              <Text>目标页数</Text>
              <InputNumber
                min={1}
                max={40}
                value={slideCount}
                placeholder="自动"
                disabled={running || creating || regenerating}
                {...previewLock}
                onChange={(value) =>
                  setSlideCount(typeof value === "number" ? value : undefined)
                }
              />
              <Text type="secondary" className="text-xs">
                留空由 AI 决定；修改页数后重新生成
              </Text>
              <span className="flex-1" />
              {(creating || regenerating) && (
                <>
                  <Button
                    icon={planningPaused ? <Play size={14} /> : <Pause size={14} />}
                    disabled={!planningId}
                    onClick={() => void handleTogglePlanningPause()}
                  >
                    {planningPaused ? "继续大纲" : "暂停大纲"}
                  </Button>
                  <Button
                    danger
                    icon={<Square size={14} />}
                    onClick={() => void handleCancelPlanning()}
                  >
                    取消规划
                  </Button>
                </>
              )}
              <Button
                type="primary"
                size="large"
                icon={<Sparkles size={16} />}
                loading={regenerating || creating}
                disabled={running || previewingFuture}
                onClick={() => void handleRegenerateOutline()}
              >
                {job ? "重新生成大纲" : "生成大纲"}
              </Button>
            </div>
            {planDirty && (
              <Alert
                type="warning"
                showIcon
                message="文案已修改"
                description="下一步生成模板预览或正式 PPT 时会使用最新文案。"
              />
            )}
            {renderDraftWorkspace({
              mode: "preview",
              emptyHint:
                creating || regenerating
                  ? "正在生成大纲，页面会陆续出现在左侧列表…"
                  : "在左侧选择页面，右侧编辑标题与要点",
              showPreview: false,
            })}
            {(creating || regenerating || planLogs.length > 0) && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Space size={6}>
                    <Text strong>大纲生成日志</Text>
                    <Tag
                      color={creating || regenerating ? "processing" : "default"}
                    >
                      {creating || regenerating
                        ? planningPaused
                          ? "已暂停"
                          : "进行中"
                        : "已结束"}
                    </Tag>
                  </Space>
                  <Text type="secondary" className="text-xs">
                    {planningPaused
                      ? "已暂停：当前阶段完成后停止推进"
                      : "暂停在当前阶段/分块结束后生效"}
                  </Text>
                </div>
                {(creating || regenerating) && planProgress && (
                  <div className="mt-2">
                    <Progress
                      size="small"
                      status="active"
                      percent={
                        planProgress.total > 0
                          ? Math.min(
                              100,
                              Math.round(
                                (planProgress.current / planProgress.total) *
                                  100,
                              ),
                            )
                          : 0
                      }
                    />
                    <Text type="secondary" className="text-xs">
                      {planProgress.message}
                    </Text>
                  </div>
                )}
                <div className="mt-2 max-h-[180px] overflow-y-auto rounded border border-slate-200 bg-white p-2 font-mono text-xs">
                  {planLogs.length === 0 ? (
                    <Text type="secondary">等待大纲日志…</Text>
                  ) : (
                    planLogs.map((line, index) => (
                      <div
                        key={`${index}-${line.slice(0, 12)}`}
                        className="whitespace-pre-wrap break-all"
                      >
                        {line}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </Space>
        </Card>
      )}

      {viewStep === 2 && (
        <Card
          className="mt-4"
          title={
            <StepTitle
              title={
                selectedLayoutLabel
                  ? `效果与模板 · ${selectedLayoutLabel}`
                  : "效果与模板 · 中性"
              }
              short={PPT_STEP_META[2].short}
              tip={PPT_STEP_META[2].tip}
            />
          }
          extra={
            <Space size={8} wrap>
              {previewingFuture && <Tag color="blue">只读预览</Tag>}
              <ModelPicker
                models={models}
                value={modelId}
                onChange={setModelId}
                disabled={busy}
              />
            </Space>
          }
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            {/* 左：模板列表 */}
            <div className="max-h-[560px] overflow-y-auto rounded-md border border-slate-200">
              <button
                type="button"
                disabled={previewingFuture || running}
                onClick={() => changeLayout(undefined)}
                className={`flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-70 ${
                  !layoutId ? "bg-blue-50" : "hover:bg-slate-50"
                }`}
              >
                <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-slate-100 text-xs text-slate-500">
                  中性
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">不使用模板</span>
                  <span className="block truncate text-xs text-slate-500">
                    内置结构与配色
                  </span>
                </span>
              </button>
              {layoutOptions.map((option) => {
                const selected = layoutId === option.value;
                const preview = layoutPreviews[option.value];
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={previewingFuture || running}
                    onClick={() =>
                      changeLayout(selected ? undefined : option.value)
                    }
                    className={`flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-70 ${
                      selected ? "bg-blue-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <span className="flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-50">
                      {preview ? (
                        <img
                          src={svgDataUrl(preview)}
                          alt={option.label}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <span className="text-[10px] text-slate-400">
                          {previewFailed[option.value] ? "无图" : "…"}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="truncate text-sm">{option.label}</span>
                        {option.source === "user" && (
                          <Tag color="green" className="!mr-0">
                            用户
                          </Tag>
                        )}
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        {option.description ||
                          (option.support?.supportsStructured
                            ? `结构化占位 ${option.support.structured} 页`
                            : "")}
                      </span>
                    </span>
                  </button>
                );
              })}
              {layoutOptions.length === 0 && (
                <div className="px-3 py-2 text-xs text-amber-600">
                  扩展包未提供版式索引，将使用内置渲染器。
                </div>
              )}
            </div>

            {/* 右：模板生成预览 */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 px-3 py-2">
                <Text strong className="shrink-0">
                  {selectedLayoutLabel ?? "中性"}
                </Text>
                <Text className="shrink-0 text-sm">图表模板</Text>
                <Select
                  mode="multiple"
                  allowClear
                  className="min-w-[180px] max-w-[320px] flex-1"
                  placeholder={
                    chartOptions.length ? "选择图表模板（可选）" : "无图表索引"
                  }
                  options={chartOptions}
                  value={chartIds}
                  onChange={changeChartIds}
                  disabled={running}
                  optionFilterProp="label"
                  optionRender={(option) => {
                    const data = option.data as {
                      label: string;
                      description?: string;
                    };
                    return (
                      <div className="py-0.5">
                        <div>{data.label}</div>
                        {data.description && (
                          <div className="text-xs text-slate-500">
                            {data.description}
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                <Tooltip title="开启后优先用 python-pptx 生成可编辑图表；图表页可能不沿用版式模板">
                  <span className="flex shrink-0 items-center gap-1 text-xs text-slate-500">
                    原生图表
                    <Switch
                      size="small"
                      checked={nativeCharts}
                      onChange={changeNativeCharts}
                      disabled={running || previewingFuture}
                    />
                  </span>
                </Tooltip>
                <Button
                  className="ml-auto"
                  type="primary"
                  size="large"
                  icon={<Sparkles size={16} />}
                  loading={previewLoading && running}
                  disabled={running || previewingFuture || !job}
                  onClick={() => void handleTemplatePreview()}
                >
                  模板生成预览
                </Button>
              </div>

              {styleDirty && job && !running && (
                <Alert
                  type="warning"
                  showIcon
                  message="模板或效果已修改"
                  description="点击「模板生成预览」按新模板刷新；正式草稿需在下一步重新生成。"
                />
              )}

              <div className="flex min-h-[320px] items-center justify-center rounded-md border border-slate-200 bg-slate-50 p-2">
                {previewLoading ? (
                  <Text type="secondary">正在生成模板预览…</Text>
                ) : previewActiveSvg ? (
                  <img
                    src={svgDataUrl(previewActiveSvg)}
                    alt="模板预览"
                    className="max-h-[420px] w-full object-contain"
                  />
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="选择模板后点击「模板生成预览」查看效果"
                  />
                )}
              </div>

              {previewPages.length > 1 && (
                <div className="flex flex-wrap gap-1">
                  {previewPages.map((page) => (
                    <button
                      key={page.file}
                      type="button"
                      onClick={() => setPreviewSelectedFile(page.file)}
                      className={`rounded border px-2 py-0.5 text-xs ${
                        previewActiveFile === page.file
                          ? "border-blue-500 bg-blue-50 text-blue-600"
                          : "border-slate-200 text-slate-600 hover:border-blue-300"
                      }`}
                    >
                      P{page.page}
                    </button>
                  ))}
                </div>
              )}

              <Text type="secondary" className="text-xs">
                {previewStale
                  ? "模板已改，预览为旧版本"
                  : "模板生成预览只写入 svg_preview，不影响正式草稿。"}
              </Text>

              {pageCandidates && pageCandidates.candidates.length > 1 && (
                <Card
                  size="small"
                  loading={candidateLoading}
                  title="页面候选"
                >
                  <div className="grid grid-cols-3 gap-2">
                    {pageCandidates.candidates.map((candidate) => (
                      <button
                        key={candidate.index}
                        type="button"
                        disabled={previewingFuture || running}
                        onClick={() =>
                          void handleSelectCandidate(candidate.index)
                        }
                        className={`rounded border p-1 text-left disabled:cursor-not-allowed disabled:opacity-70 ${
                          candidate.index === pageCandidates.selected
                            ? "border-blue-500 ring-2 ring-blue-200"
                            : "border-slate-200"
                        }`}
                      >
                        <img
                          src={svgDataUrl(candidate.svg)}
                          alt={candidate.motif}
                          className="w-full"
                        />
                        <div className="mt-1 flex items-center justify-between text-xs">
                          <Tooltip title={candidate.note || undefined}>
                            <span className="truncate">
                              {candidate.label || candidate.motif}
                            </span>
                          </Tooltip>
                          <Tag
                            color={candidate.score >= 70 ? "green" : "gold"}
                          >
                            {candidate.score}
                          </Tag>
                        </div>
                      </button>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          </div>
          {(running || logs.length > 0) && (
            <div className="mt-4">
              <Text type="secondary" className="mb-1 block text-xs">
                引擎日志
              </Text>
              <div className="max-h-[200px] overflow-y-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs">
                {logs.length === 0 ? (
                  <Text type="secondary">等待引擎输出…</Text>
                ) : (
                  logs.map((line, index) => (
                    <div
                      key={`${index}-${line.slice(0, 12)}`}
                      className="whitespace-pre-wrap break-all"
                    >
                      {line}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </Card>
      )}

      {viewStep === 3 && (job || running || formalized) && (
        <Card
          className="mt-4"
          title={
            <StepTitle
              title="草稿预览"
              short={PPT_STEP_META[3].short}
              tip={PPT_STEP_META[3].tip}
            />
          }
          extra={
            <Space size={8} wrap>
              {previewingFuture && <Tag color="blue">只读预览</Tag>}
              <ModelPicker
                models={models}
                value={modelId}
                onChange={setModelId}
                disabled={busy}
              />
            </Space>
          }
        >
          <Space direction="vertical" size="middle" className="w-full">
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 px-3 py-2">
              <Text strong>生成方式</Text>
              <Segmented
                value={formalMode === "programmatic" ? "oneShot" : formalMode}
                disabled={running || previewingFuture}
                onChange={(value) =>
                  setFormalMode(value as PptDraftGenerationMode)
                }
                options={[
                  { label: "单候选页", value: "oneShot" },
                  { label: "三候选页", value: "bestOf" },
                ]}
              />
              <Text type="secondary" className="text-xs">
                {formalMode === "bestOf"
                  ? "每页最多生成 3 个候选，质量优先、耗时最长"
                  : "每页生成 1 个候选，速度与质量平衡"}
              </Text>
              {job?.status === "paused" && <Tag color="gold">已暂停</Tag>}
              <Button
                className="ml-auto"
                type="primary"
                size="large"
                icon={<Sparkles size={16} />}
                loading={running}
                disabled={previewingFuture}
                onClick={() => void handleRenderFormal()}
              >
                {job?.status === "paused"
                  ? "继续生成"
                  : formalized
                    ? "重新生成预览"
                    : "生成预览"}
              </Button>
            </div>
            {renderDraftWorkspace({
              mode: "formal",
              emptyHint: "选择生成方式后点击「生成预览」开始渲染",
            })}
          </Space>
        </Card>
      )}

      {viewStep === 3 && !(job || running || formalized) && (
        <StepPreviewPlaceholder
          step={3}
          description="先完成「设置与素材」并生成大纲；进入本步骤后选择生成方式，点击「生成预览」按正式模板逐页渲染草稿，确认后再进入导出。"
          hints={["选择生成方式", "正式模板逐页预览", "确认后进入导出"]}
        />
      )}

      {viewStep === 4 && (running || job) && (
        <Card
          className="mt-4"
          title={running ? "正在导出 PPTX" : "导出 PPTX"}
          extra={
            <Space size={8} wrap>
              <ModelPicker
                models={models}
                value={modelId}
                onChange={setModelId}
                disabled={busy}
              />
              {running ? (
                <Button
                  danger
                  size="small"
                  icon={<Square size={14} />}
                  onClick={() => void handleCancel()}
                >
                  取消导出
                </Button>
              ) : (
                previewingFuture && <Tag color="blue">只读预览</Tag>
              )}
            </Space>
          }
        >
          <Space direction="vertical" size="middle" className="w-full">
            <Progress
              percent={progressPercent}
              status={
                running
                  ? "active"
                  : job?.status === "failed"
                    ? "exception"
                    : "normal"
              }
            />
            {!formalized && !running && (
              <Alert
                type="warning"
                showIcon
                message="当前是程序化预览草稿"
                description="建议先在「草稿预览」生成正式草稿再导出；也可以直接导出当前程序化排版的结果。"
              />
            )}
            {!running &&
              draftStatus &&
              draftStatus.status !== "fresh" &&
              draftStatus.status !== "order_stale" && (
                <Alert
                  type="warning"
                  showIcon
                  message="草稿未就绪"
                  description={
                    draftStatus.pages
                      .filter((page) => page.status !== "ready")
                      .slice(0, 6)
                      .map(
                        (page) =>
                          `P${String(page.page).padStart(2, "0")} ${page.message}`,
                      )
                      .join("；") || "请先在「草稿预览」生成正式草稿"
                  }
                />
              )}
            <div>
              <Text className="mb-1 block">导出目录</Text>
              <Space.Compact className="w-full">
                <Input
                  value={exportDir ?? ""}
                  readOnly
                  placeholder="默认保存在作业目录的 output/ 下"
                />
                <Button
                  icon={<FolderOpen size={14} />}
                  disabled={running || previewingFuture}
                  onClick={() => void pickExportDir()}
                >
                  选择
                </Button>
              </Space.Compact>
            </div>
            {job?.status === "succeeded" && job.stage === "done" && (
              <Alert
                type="success"
                showIcon
                message="导出完成"
                description={job.finalPptxPath ?? job.pptxPath ?? ""}
                action={
                  <Space>
                    <Button
                      size="small"
                      onClick={() => {
                        const path = job.finalPptxPath ?? job.pptxPath;
                        if (path) void openPath(path);
                      }}
                    >
                      打开 PPT
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        if (job.projectPath) void revealItemInDir(job.projectPath);
                      }}
                    >
                      打开工程目录
                    </Button>
                  </Space>
                }
              />
            )}
            {job && ["failed", "cancelled"].includes(job.status) && (
              <Alert
                type="error"
                showIcon
                message={`导出${job.status === "cancelled" ? "已取消" : "失败"}`}
                description={job.errorMessage ?? job.errorCode ?? "未知错误"}
              />
            )}
            {job?.projectPath && (
              <Paragraph
                className="!mb-0"
                copyable={{ text: job.projectPath }}
                type="secondary"
              >
                工程目录：{job.projectPath}
              </Paragraph>
            )}
            <div className="max-h-[240px] overflow-y-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs">
              {logs.length === 0 ? (
                <Text type="secondary">等待引擎输出…</Text>
              ) : (
                logs.map((line, index) => (
                  <div
                    key={`${index}-${line.slice(0, 12)}`}
                    className="whitespace-pre-wrap break-all"
                  >
                    {line}
                  </div>
                ))
              )}
            </div>
            <div className="sticky bottom-0 z-10 mt-2 flex justify-end bg-white/95 py-2">
              <Button
                size="large"
                type="primary"
                icon={<Download size={16} />}
                disabled={running || previewingFuture}
                onClick={() => void handleExport()}
              >
                {job?.stage === "done" ? "重新导出" : "导出 PPTX"}
              </Button>
            </div>
          </Space>
        </Card>
      )}

      {viewStep === 4 && !(running || job) && (
        <StepPreviewPlaceholder
          step={4}
          description="正式草稿确认后可导出为可编辑 PPTX。这里显示导出进度、输出路径，以及打开 PPT / 工程目录的操作。"
          hints={["导出目录选择", "导出进度与日志", "打开 PPT / 工程目录"]}
        />
      )}

      <Drawer
        title="历史PPT作业"
        width={820}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        extra={
          <Button size="small" onClick={() => void handleCleanupJobs()}>
            清理旧作业
          </Button>
        }
      >
        <Table<PptJob>
          rowKey="id"
          size="small"
          loading={historyLoading}
          dataSource={history}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: "暂无历史作业" }}
          columns={[
            {
              title: "标题",
              dataIndex: "title",
              render: (value: string, record) => (
                <div className="min-w-0">
                  <Text ellipsis={{ tooltip: value }}>{value}</Text>
                  {record.errorMessage && (
                    <Text type="danger" className="block text-xs">
                      {record.errorMessage}
                    </Text>
                  )}
                </div>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 110,
              render: (value: string, record) =>
                jobStatusTag(value, record.stage),
            },
            {
              title: "创建时间",
              dataIndex: "createdAt",
              width: 150,
              render: (value: string) => value?.slice(0, 16).replace("T", " "),
            },
            {
              title: "操作",
              width: 390,
              render: (_, record) => (
                <Space size={4} wrap>
                  <Button
                    size="small"
                    onClick={() => void resumeJob(record)}
                  >
                    继续
                  </Button>
                  <Button
                    size="small"
                    disabled={
                      record.stage !== "done" ||
                      (!record.finalPptxPath && !record.pptxPath)
                    }
                    onClick={() => {
                      const path = record.finalPptxPath ?? record.pptxPath;
                      if (path) void openPath(path);
                    }}
                  >
                    打开 PPT
                  </Button>
                  <Button
                    size="small"
                    disabled={!record.projectPath}
                    onClick={() => {
                      if (record.projectPath) void revealItemInDir(record.projectPath);
                    }}
                  >
                    工程目录
                  </Button>
                  <Button
                    size="small"
                    icon={<RotateCcw size={12} />}
                    onClick={() => void handleRetryJob(record.id)}
                  >
                    重试
                  </Button>
                  <Button
                    size="small"
                    icon={<Download size={12} />}
                    onClick={() => void handleDiagnostics(record.id)}
                  >
                    诊断
                  </Button>
                  <Popconfirm
                    title="删除该作业及工作目录？"
                    onConfirm={() => void handleDeleteJob(record.id)}
                  >
                    <Button size="small" danger icon={<Trash2 size={12} />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Drawer>

      <Modal
        open={regenPromptPage !== null}
        className="ppt-regen-modal"
        title={
          <div
            onMouseDown={beginRegenModalDrag}
            style={{ cursor: "move", userSelect: "none" }}
            title="按住标题可拖动窗口"
          >
            {regenPromptPage !== null
              ? `重新生成 P${regenPromptPage}`
              : "重新生成此页"}
          </div>
        }
        okText="重新生成"
        cancelText="取消"
        confirmLoading={regenPage !== null && regenPage === regenPromptPage}
        maskClosable={false}
        onOk={() => void handleConfirmRegenPrompt()}
        onCancel={() => {
          if (regenPage === regenPromptPage) return;
          setRegenPromptPage(null);
          resetRegenModalPosition();
        }}
        afterOpenChange={(open) => {
          if (!open) {
            resetRegenModalPosition();
            setRegenProgress(null);
          }
        }}
      >
        <Space direction="vertical" size="small" className="w-full">
          <Text type="secondary">
            可描述希望 AI 如何修改本页，例如“改成左右对比布局，突出转化率数据”或“减少文字，用三段流程箭头表达”。留空则按当前内容重新生成。
          </Text>
          <Input.TextArea
            rows={4}
            maxLength={500}
            showCount
            autoFocus
            value={regenInstruction}
            onChange={(event) => setRegenInstruction(event.target.value)}
            placeholder="例如：改成左右对比布局，左侧列问题，右侧列解决方案"
            disabled={regenPage !== null && regenPage === regenPromptPage}
          />
          {regenPromptPage !== null &&
            ((regenPage !== null && regenPage === regenPromptPage) ||
              regenProgress !== null) && (
              <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <Progress
                size="small"
                status={
                  regenProgress?.status === "failed" ? "exception" : "active"
                }
                percent={
                  regenProgress && regenProgress.total > 0
                    ? Math.min(
                        100,
                        Math.round(
                          (regenProgress.current / regenProgress.total) * 100,
                        ),
                      )
                    : 0
                }
              />
              <Text type="secondary" className="mt-1 block text-xs">
                {regenProgress?.message ?? "正在准备重新生成…"}
              </Text>
            </div>
          )}
        </Space>
      </Modal>
    </div>
    </main>
    <StepRail
      items={stepItems}
      current={step}
      viewStep={viewStep}
      onSelect={handleStepChange}
      onNewJob={handleNewJob}
      onOpenHistory={() => setHistoryOpen(true)}
      recentJobs={history.slice(0, 5)}
      currentJobId={job?.id}
      onOpenJob={(record) => {
        setHistoryOpen(false);
        void resumeJob(record);
      }}
    />
    </div>
  );
}
