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
  Steps,
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
  Download,
  FilePlus2,
  FileText,
  FileUp,
  FolderOpen,
  History,
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
import { canReuseDraft, canReuseExport } from "@/lib/pptFlow";
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
  PptDraftPageEvent,
  PptMetaSource,
  PptPageCandidatesResponse,
  PptPageRegenEvent,
  PptPageSelection,
  PptPlan,
  PptPlanProgressEvent,
  PptSlide,
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

function stepForStage(stage?: string): number {
  switch (stage) {
    case "style":
      return 1;
    case "outline_ready":
      return 2;
    case "rendering_draft":
    case "draft_ready":
      return 3;
    case "exporting":
    case "done":
      return 4;
    default:
      return 2;
  }
}

const PPT_STEP_TITLES = [
  "素材与设置",
  "风格确认",
  "大纲确认",
  "草稿修改",
  "最终导出",
] as const;

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
      title={`${PPT_STEP_TITLES[step]} · 预览`}
      extra={<Tag color="blue">尚未开始</Tag>}
    >
      <Space direction="vertical" size="middle" className="w-full">
        <Alert
          type="info"
          showIcon
          message={`第 ${step + 1} 步尚未开始，以下是该步骤的页面结构预览`}
          description={description}
        />
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
        <Skeleton active title={false} paragraph={{ rows: 5 }} />
      </Space>
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
  const [draftPages, setDraftPages] = useState<PptDraftPage[]>([]);
  const [draftSvgs, setDraftSvgs] = useState<Record<string, string>>({});
  const [draftLoading, setDraftLoading] = useState(false);
  const [pageSelection, setPageSelection] = useState<PptPageSelection | null>(null);
  const [pageCandidates, setPageCandidates] =
    useState<PptPageCandidatesResponse | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [regenPage, setRegenPage] = useState<number | null>(null);
  const [regenPromptPage, setRegenPromptPage] = useState<number | null>(null);
  const [regenInstruction, setRegenInstruction] = useState("");
  const [regenProgress, setRegenProgress] = useState<PptPageRegenEvent | null>(null);
  const [selectedDraftFile, setSelectedDraftFile] = useState<string | null>(null);
  const [planProgress, setPlanProgress] = useState<PptPlanProgressEvent | null>(null);
  const [draftProgress, setDraftProgress] = useState<PptDraftPageEvent | null>(null);
  const [draftDoneCount, setDraftDoneCount] = useState(0);
  const [draftMode, setDraftMode] =
    useState<PptDraftGenerationMode>("programmatic");
  const draftDonePages = useRef<Set<number>>(new Set());

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

  const loadDraft = useCallback(async (jobId: string) => {
    setDraftLoading(true);
    try {
      const pages = await pptExtensionApi.listDraftPages(jobId);
      setDraftPages(pages);
      const entries = await Promise.all(
        pages.map(
          async (page) =>
            [page.file, await pptExtensionApi.readDraftPage(jobId, page.file)] as const,
        ),
      );
      const map = Object.fromEntries(entries);
      setDraftSvgs(map);
      try {
        setPageSelection(await pptExtensionApi.getPageSelection(jobId));
      } catch {
        setPageSelection(null);
      }
      setSelectedDraftFile((current) =>
        current && map[current] ? current : pages[0]?.file ?? null,
      );
    } catch (e) {
      message.error(`加载草稿失败：${String(e)}`);
    } finally {
      setDraftLoading(false);
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
        if (["succeeded", "failed", "cancelled"].includes(payload.status)) {
          setRunning(false);
          if (payload.status === "succeeded") {
            setEngineProgress(100);
            setPlanDirty(false);
            setStyleDirty(false);
            const stage = payload.job?.stage ?? payload.stage;
            const jobId = payload.job?.id;
            if (stage === "draft_ready") {
              message.success("草稿已生成，可预览和修改");
              setStep(3);
              if (jobId) void loadDraft(jobId);
            } else {
              message.success("PPT 导出完成");
              setStep(4);
            }
          } else {
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
                setDraftPages((prev) => {
                  if (prev.some((item) => item.file === file)) return prev;
                  return [
                    ...prev,
                    { file, page: payload.page, title: `P${payload.page}` },
                  ].sort((left, right) => left.page - right.page);
                });
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
    const existing = new Set(
      localSourcesRef.current.map((source) => source.path),
    );
    const added = paths
      .filter((path) => !existing.has(path))
      .map(localFileSource);
    if (added.length > 0) {
      const next = [...localSourcesRef.current, ...added];
      localSourcesRef.current = next;
      setLocalSources(next);
      requestMetaSuggestion(selectedNotesRef.current, next);
    }
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
      message.warning("请至少添加一个文档/本地文件，或填写补充材料");
      return false;
    }
    return true;
  }

  function goToStyle() {
    if (!validateSources()) return;
    setStep(1);
  }

  async function handleGenerate() {
    if (!validateSources()) return;
    setCreating(true);
    setLogs([]);
    setJob(null);
    setPlan(null);
    setDraftPages([]);
    setDraftSvgs({});
    setSelectedDraftFile(null);
    setEngineProgress(0);
    setSlideCount(undefined);
    setPlanDirty(false);
    setStyleDirty(false);
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
        layoutId: layoutId ?? null,
        chartIds,
        language,
        extraRequirements: extraRequirements.trim() || null,
        exportDir,
        modelId: modelId ?? null,
        planningId: requestId,
        nativeCharts,
      });
      setJob(created);
      const nextPlan = await pptExtensionApi.getPlan(created.id);
      setPlan(nextPlan);
      setPlanDirty(false);
      setStyleDirty(false);
      setStep(2);
      message.success("大纲已生成，请确认或编辑后生成草稿");
    } catch (e) {
      message.error(`生成大纲失败：${String(e)}`);
    } finally {
      setCreating(false);
      setPlanningId(null);
    }
  }

  async function goToOutline() {
    if (!job) {
      void handleGenerate();
      return;
    }
    if (plan) {
      setStep(2);
      return;
    }
    try {
      const next = await pptExtensionApi.getPlan(job.id);
      setPlan(next);
      setPlanDirty(false);
      setStep(2);
    } catch {
      void handleGenerate();
    }
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
    setEngineProgress(0);
    try {
      const next = await pptExtensionApi.regeneratePlan(
        job.id,
        slideCount ?? null,
        modelId ?? null,
        requestId,
      );
      setPlan(next);
      setPlanDirty(false);
      setDraftPages([]);
      setDraftSvgs({});
      setSelectedDraftFile(null);
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
    } catch (e) {
      message.error(`重新生成大纲失败：${String(e)}`);
    } finally {
      setRegenerating(false);
      setPlanningId(null);
    }
  }

  async function handleCancelPlanning() {
    if (!planningId) return;
    try {
      await pptExtensionApi.cancelPlanning(planningId);
      message.info("已请求取消大纲生成");
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleRenderDraft() {
    if (!job) return;
    let currentPlan = plan;
    try {
      if (!currentPlan) {
        currentPlan = await pptExtensionApi.getPlan(job.id);
        setPlan(currentPlan);
      }
    } catch (e) {
      message.error(`读取大纲失败：${String(e)}`);
      return;
    }
    if (!currentPlan?.slides.length) {
      message.warning("大纲至少需要 1 页");
      return;
    }
    setRunning(true);
    setLogs([]);
    setEngineProgress(0);
    setDraftPages([]);
    setDraftSvgs({});
    setSelectedDraftFile(null);
    try {
      const updatedJob = await pptExtensionApi.updateJobOptions(job.id, {
        layoutId: layoutId ?? null,
        chartIds,
        nativeCharts,
      });
      setJob(updatedJob);
      const normalized = await pptExtensionApi.updatePlan(updatedJob.id, currentPlan);
      setPlan(normalized);
      setPlanDirty(false);
      setStyleDirty(false);
      draftDonePages.current = new Set();
      setDraftDoneCount(0);
      setDraftProgress(null);
      setDraftLoading(true);
      setStep(3);
      const effectiveCount = draftMode === "bestOf" ? 3 : 1;
      void pptExtensionApi
        .renderAiDraft(updatedJob.id, effectiveCount, draftMode)
        .catch((error) => {
        setRunning(false);
        setDraftLoading(false);
        message.error(`草稿生成失败：${String(error)}`);
      });
    } catch (e) {
      setRunning(false);
      message.error(`启动草稿渲染失败：${String(e)}`);
    }
  }

  function goToDraft() {
    if (reuseDraft) {
      setStep(3);
      if (job && draftPages.length === 0) void loadDraft(job.id);
      return;
    }
    void handleRenderDraft();
  }

  function goToExport() {
    if (reuseExport) {
      setStep(4);
      return;
    }
    if (planDirty || styleDirty) {
      message.warning("内容或风格已修改，请先点击「重新生成草稿」");
      return;
    }
    void handleExport();
  }

  async function handleRerenderDraft() {
    if (!job || !plan) return;
    setRunning(true);
    setLogs([]);
    setEngineProgress(0);
    setDraftPages([]);
    setDraftSvgs({});
    setSelectedDraftFile(null);
    try {
      const updatedJob = await pptExtensionApi.updateJobOptions(job.id, {
        layoutId: layoutId ?? null,
        chartIds,
        nativeCharts,
      });
      setJob(updatedJob);
      const normalized = await pptExtensionApi.updatePlan(job.id, plan);
      setPlan(normalized);
      setPlanDirty(false);
      setStyleDirty(false);
      draftDonePages.current = new Set();
      setDraftDoneCount(0);
      setDraftProgress(null);
      setDraftLoading(true);
      setStep(3);
      const effectiveCount = draftMode === "bestOf" ? 3 : 1;
      void pptExtensionApi
        .renderAiDraft(job.id, effectiveCount, draftMode)
        .catch((error) => {
        setRunning(false);
        setDraftLoading(false);
        message.error(`草稿生成失败：${String(error)}`);
      });
    } catch (e) {
      setRunning(false);
      message.error(`重新生成草稿失败：${String(e)}`);
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

  function openRegenPrompt(page: number) {
    setRegenInstruction("");
    setRegenProgress(null);
    setRegenPromptPage(page);
    requestAnimationFrame(resetRegenModalPosition);
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
      message.success(`P${page} 已重新生成`);
      return true;
    } catch (e) {
      message.error(`重新生成第 ${page} 页失败：${String(e)}`);
      return false;
    } finally {
      setRegenPage(null);
    }
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
      message.success("已切换结构候选");
    } catch (e) {
      message.error(`切换候选失败：${String(e)}`);
    }
  }

  async function handleExport() {
    if (!job) return;
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

  async function openSourceFile(jobId: string) {
    try {
      const path = await pptExtensionApi.getSourceFile(jobId);
      await openPath(path);
    } catch (e) {
      message.error(`打开素材失败：${String(e)}`);
    }
  }

  async function editOutline() {
    if (!job) return;
    if (plan) {
      setStep(2);
      return;
    }
    try {
      const next = await pptExtensionApi.getPlan(job.id);
      setPlan(next);
      setPlanDirty(false);
      setStep(2);
    } catch (e) {
      message.error(`读取大纲失败：${String(e)}`);
    }
  }

  async function resumeJob(record: PptJob) {
    try {
      const [nextPlan, options] = await Promise.all([
        pptExtensionApi.getPlan(record.id),
        pptExtensionApi.getJobOptions(record.id).catch(() => null),
      ]);
      setJob(record);
      setPlan(nextPlan);
      setPlanDirty(false);
      setStyleDirty(false);
      setStep(stepForStage(record.stage));
      setHistoryOpen(false);
      if (record.status === "running") setRunning(true);
      if (options) {
        const mode = options.generationMode;
        if (mode === "bestOf" || mode === "oneShot" || mode === "programmatic") {
          setDraftMode(mode);
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
        setLayoutId(
          typeof options.layoutId === "string" ? options.layoutId : undefined,
        );
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
        setModelId(
          typeof options.modelId === "number" ? options.modelId : undefined,
        );
      }
      if (["draft_ready", "exporting", "done"].includes(record.stage)) {
        void loadDraft(record.id);
      }
    } catch (e) {
      message.error(`打开作业失败：${String(e)}`);
    }
  }

  function backToSettings() {
    if (running) return;
    setStep(0);
  }

  function handleStepChange(next: number) {
    if (next === viewStep) return;
    if (busy) {
      message.info("正在生成中，暂不能切换步骤");
      return;
    }
    setViewStep(next);
  }

  function updateSlide(index: number, patch: Partial<PptSlide>) {
    setPlan((prev) => (prev ? updatePlanSlide(prev, index, patch) : prev));
    setPlanDirty(true);
  }

  function addSlide() {
    if (!plan) return;
    setPlan(addPlanSlide(plan));
    setPlanDirty(true);
    message.info(
      `已添加第 ${plan.slides.length + 1} 页；左侧草稿仍是旧版本，点击「重新生成草稿」后同步`,
    );
  }

  function removeSlide(index: number) {
    if (!plan) return;
    setPlan(removePlanSlide(plan, index));
    setPlanDirty(true);
    message.info("已删除该页；点击「重新生成草稿」后左侧预览同步");
  }

  function moveSlide(index: number, delta: number) {
    if (!plan) return;
    const target = index + delta;
    if (target < 0 || target >= plan.slides.length) return;
    setPlan(movePlanSlide(plan, index, delta));
    setPlanDirty(true);
    message.info(
      `已将第 ${index + 1} 页${delta < 0 ? "上移" : "下移"}到第 ${target + 1} 页；左侧草稿是旧顺序，点击「重新生成草稿」后同步`,
    );
  }

  function changeLayout(next?: string) {
    setLayoutId(next);
    setStyleDirty(true);
  }

  function changeChartIds(next: string[]) {
    setChartIds(next);
    setStyleDirty(true);
  }

  function changeNativeCharts(next: boolean) {
    setNativeCharts(next);
    setStyleDirty(true);
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
    if (historyOpen) void loadHistory();
  }, [historyOpen, loadHistory]);

  async function handleRetryJob(jobId: string) {
    try {
      const created = await pptExtensionApi.retryJob(jobId);
      const nextPlan = await pptExtensionApi.getPlan(created.id);
      setJob(created);
      setPlan(nextPlan);
      setPlanDirty(false);
      setStyleDirty(false);
      setDraftPages([]);
      setDraftSvgs({});
      setSelectedDraftFile(null);
      setStep(2);
      setHistoryOpen(false);
      message.success("已基于原素材和大纲创建新作业");
    } catch (e) {
      message.error(`重试失败：${String(e)}`);
    }
  }

  async function handleDeleteJob(jobId: string) {
    try {
      await pptExtensionApi.deleteJob(jobId);
      if (job?.id === jobId) {
        setJob(null);
        setPlan(null);
        setSlideCount(undefined);
        setPlanDirty(false);
        setStyleDirty(false);
        setStep(0);
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

  const selectedDraftPage = draftPages.find(
    (page) => page.file === selectedDraftFile,
  );
  const selectedDraftIndex = selectedDraftPage
    ? (plan?.slides.findIndex((slide) => slide.page === selectedDraftPage.page) ?? -1)
    : -1;
  const selectedDraftSlide =
    selectedDraftIndex >= 0 ? plan?.slides[selectedDraftIndex] : undefined;
  useEffect(() => {
    if (!job?.id || !selectedDraftSlide?.page) {
      setPageCandidates(null);
      return;
    }
    let cancelled = false;
    setCandidateLoading(true);
    void pptExtensionApi
      .getPageCandidates(job.id, selectedDraftSlide.page)
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
  }, [job?.id, selectedDraftSlide?.page, draftSvgs]);
  const reuseDraft = canReuseDraft(job, planDirty, styleDirty);
  const reuseExport = canReuseExport(job, planDirty, styleDirty);
  const busy = running || creating || regenerating;
  const previewing = viewStep !== step;
  const previewingFuture = viewStep > step;
  // 预览后续步骤时，隐藏会触发生成/导出的操作，避免误触
  const previewLock = previewingFuture ? { disabled: true } : {};

  // 真实流程推进时，视图自动跟随到该步骤
  useEffect(() => {
    setViewStep(step);
  }, [step]);

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

  const stepItems = [
    {
      title: PPT_STEP_TITLES[0],
      description:
        selectedCount > 0 ? `已选 ${selectedCount} 项素材` : "选择文档 / 填写标题",
    },
    {
      title: PPT_STEP_TITLES[1],
      description: selectedLayoutLabel || "版式、图表与生成选项",
    },
    {
      title: PPT_STEP_TITLES[2],
      description: plan ? `${plan.slides.length} 页大纲` : "逐页编辑标题与要点",
    },
    {
      title: PPT_STEP_TITLES[3],
      description:
        draftPages.length > 0
          ? `${draftPages.length} 页草稿`
          : "缩略图预览与单页重生成",
    },
    {
      title: PPT_STEP_TITLES[4],
      description:
        job?.status === "succeeded" && job.stage === "done"
          ? "已导出"
          : "导出可编辑 PPTX",
    },
  ].map((item, index) => ({
    ...item,
    disabled: busy && index !== step,
  }));

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <Typography.Title level={3} className="!mb-1">
            文档生成 PPT
          </Typography.Title>
          <Text type="secondary">
            搜索并选择多个文档，或添加本地 PDF/Word/Markdown 文件，AI 生成大纲后由本地 PPT 扩展渲染为可编辑 PPTX。
          </Text>
        </div>
        <Space>
          <Button icon={<FileUp size={14} />} onClick={() => navigate("/pptx-spike")}>
            打开 Office 文档（实验）
          </Button>
          <Button icon={<History size={14} />} onClick={() => setHistoryOpen(true)}>
            历史作业
          </Button>
        </Space>
      </div>

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

      <Steps
        className="mb-1"
        current={viewStep}
        onChange={handleStepChange}
        items={stepItems}
      />
      <Text type="secondary" className="mb-4 block text-xs">
        点击步骤可回看或预览页面；尚未开始的步骤以只读预览展示，不会推进当前生成流程。
      </Text>

      {previewing && (
        <Alert
          className="mb-4"
          type={previewingFuture ? "info" : "success"}
          showIcon
          message={
            previewingFuture
              ? `预览第 ${viewStep + 1} 步 · ${PPT_STEP_TITLES[viewStep]}`
              : `回看第 ${viewStep + 1} 步 · ${PPT_STEP_TITLES[viewStep]}`
          }
          description={
            previewingFuture
              ? `当前流程仍停留在第 ${step + 1} 步「${PPT_STEP_TITLES[step]}」。预览页面不显示生成/导出按钮，不会自动推进流程。`
              : `正在查看已完成的步骤，当前流程仍在第 ${step + 1} 步「${PPT_STEP_TITLES[step]}」。`
          }
          action={
            <Button size="small" onClick={() => setViewStep(step)}>
              返回当前步骤
            </Button>
          }
        />
      )}

      {running && step <= 2 && planProgress && (
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
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title={`素材来源（已选 ${selectedCount} 项）`}
          extra={
            <Text type="secondary">
              {selectedChars > 0
                ? `文档约 ${selectedChars.toLocaleString()} 字符`
                : ""}
              {localSources.length > 0
                ? `${selectedChars > 0 ? " · " : ""}本地文件 ${localSources.length} 个（生成时读取）`
                : ""}
            </Text>
          }
        >
          {job &&
            plan &&
            selectedNotes.length === 0 &&
            localSources.length === 0 &&
            !manualText.trim() && (
              <Alert
                type="info"
                showIcon
                className="mb-3"
                message="当前打开的是历史作业"
                description={
                  <Space size={4} wrap>
                    <span>
                      素材已固化为作业内的 source.md，重新生成大纲会复用这份素材；如需更换素材，请新建作业。
                    </span>
                    <Button
                      type="link"
                      size="small"
                      className="!h-auto !p-0"
                      onClick={() => void openSourceFile(job.id)}
                    >
                      查看 source.md
                    </Button>
                  </Space>
                }
              />
            )}
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
              const added = selectedNoteIds.has(note.id);
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
                          icon={<Plus size={16} />}
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

          <div className="mt-3">
            <div className="max-h-[120px] overflow-y-auto rounded-md border border-slate-200">
              {selectedCount === 0 ? (
                <div className="p-3">
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="从上方分页列表添加文档，或添加本地文件"
                  />
                </div>
              ) : (
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
              )}
            </div>
          </div>

          <div className="mt-3">
            <Text type="secondary" className="mb-1 block">
              补充材料（可选，会追加到素材末尾）
            </Text>
            <Input.TextArea
              rows={4}
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              placeholder="例如：本次汇报的重点、必须包含的案例或数据"
            />
          </div>
        </Card>

        <Card
          title="生成设置"
          extra={
            <Space wrap>
              <Button
                type="primary"
                icon={<Sparkles size={16} />}
                onClick={goToStyle}
              >
                下一步：选择风格
              </Button>
              {job && !running && (
                <Button
                  icon={<RotateCcw size={14} />}
                  onClick={() => void handleRenderDraft()}
                >
                  用当前大纲重新生成草稿
                </Button>
              )}
            </Space>
          }
        >
          <Space direction="vertical" size="middle" className="w-full">
            <div>
              <Text className="mb-1 block">PPT 标题</Text>
              <Input
                value={title}
                onChange={(e) => {
                  titleTouched.current = true;
                  setTitle(e.target.value);
                }}
                placeholder="例如：技术研究及发展趋势分析"
              />
              <Text type="secondary" className="mt-1 block text-xs">
                作为主题参与大纲规划，同时用于导出文件名
              </Text>
              {suggestingMeta && (
                <Text type="secondary" className="mt-1 block text-xs">
                  AI 正在根据素材识别标题与汇报对象…
                </Text>
              )}
            </div>
            <div>
              <Text className="mb-1 block">汇报对象</Text>
              <Input
                value={audience}
                onChange={(e) => {
                  audienceTouched.current = true;
                  setAudience(e.target.value);
                }}
                placeholder="例如：本科教学、企业客户、技术评审"
              />
              <Text type="secondary" className="mt-1 block text-xs">
                告诉 AI 讲给谁听，会影响内容深度与语气
              </Text>
            </div>
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
                  onClick={() => void pickExportDir()}
                >
                  选择
                </Button>
              </Space.Compact>
              <Text type="secondary" className="mt-1 block text-xs">
                最近一次选择的目录会自动记住
              </Text>
            </div>
            <div className="grid grid-cols-2 gap-3">
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
              <div>
                <Text className="mb-1 block">AI 模型</Text>
                <Select
                  className="w-full"
                  allowClear
                  placeholder="默认模型"
                  value={modelId}
                  onChange={setModelId}
                  options={models.map((m) => ({ value: m.id, label: m.name }))}
                />
              </div>
            </div>
            <div>
              <Text className="mb-1 block">额外要求</Text>
              <Input.TextArea
                rows={2}
                value={extraRequirements}
                onChange={(e) => setExtraRequirements(e.target.value)}
                placeholder="例如：偏重工艺流程图、少用文字"
              />
            </div>
          </Space>
        </Card>
      </div>
      )}

      {viewStep === 1 && (
        <Card
          title={
            selectedLayoutLabel
              ? `风格确认 · ${selectedLayoutLabel}`
              : "风格确认（未选择版式）"
          }
          extra={
            previewingFuture ? (
              <Tag color="blue">只读预览</Tag>
            ) : (
              <Space wrap>
                <Button onClick={backToSettings}>返回设置</Button>
                <Button
                  type="primary"
                  icon={<Sparkles size={16} />}
                  loading={creating}
                  onClick={() => void goToOutline()}
                >
                  {job && plan ? "继续到大纲确认" : "生成大纲"}
                </Button>
                {creating && (
                  <Button
                    danger
                    icon={<Square size={14} />}
                    onClick={() => void handleCancelPlanning()}
                  >
                    取消规划
                  </Button>
                )}
              </Space>
            )
          }
        >
          <Space direction="vertical" size="middle" className="w-full">
            <Alert
              type="info"
              showIcon
              message="选择版式与图表风格"
              description="封面预览来自版式包首张封面 SVG。确认后将根据素材生成大纲，再生成草稿供预览修改。"
            />
            {styleDirty && job && (
              <Alert
                type="warning"
                showIcon
                message="风格已修改"
                description="进入草稿阶段时会重新渲染一次以应用新的版式或图表设置；大纲不会重新生成。"
              />
            )}
            {layoutOptions.length === 0 ? (
              <Alert
                type="warning"
                showIcon
                message="扩展包未提供版式索引"
                description="将使用内置渲染器生成页面，可直接继续。"
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {layoutOptions.map((option) => {
                  const selected = layoutId === option.value;
                  const preview = layoutPreviews[option.value];
                  const support = option.support;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={previewingFuture}
                      onClick={() =>
                        changeLayout(selected ? undefined : option.value)
                      }
                      className={`overflow-hidden rounded-lg border text-left transition disabled:cursor-not-allowed disabled:opacity-70 ${
                        selected
                          ? "border-blue-500 ring-2 ring-blue-100"
                          : "border-slate-200 hover:border-blue-300"
                      }`}
                    >
                      <div className="flex h-36 items-center justify-center bg-slate-50">
                        {preview ? (
                          <img
                            src={svgDataUrl(preview)}
                            alt={option.label}
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <Text type="secondary">
                            {previewFailed[option.value]
                              ? "无封面预览"
                              : "预览加载中…"}
                          </Text>
                        )}
                      </div>
                      <div className="p-3">
                        <div className="flex items-center justify-between gap-2">
                          <Text strong ellipsis={{ tooltip: option.label }}>
                            {option.label}
                          </Text>
                          {option.source === "user" && (
                            <Tag color="green">用户</Tag>
                          )}
                          {selected && <Tag color="blue">已选</Tag>}
                        </div>
                        {option.description && (
                          <Text type="secondary" className="mt-1 block text-xs">
                            {option.description}
                          </Text>
                        )}
                        {support && (
                          <Text type="secondary" className="mt-1 block text-xs">
                            {support.supportsStructured
                              ? `结构化占位符 ${support.structured} 页`
                              : "仅支持 {{}} 占位符"}
                            {support.supportsLegacy
                              ? ` · {{}} ${support.legacy} 页`
                              : ""}
                          </Text>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <div>
              <Text className="mb-1 block">图表模板（可选）</Text>
              <Select
                mode="multiple"
                allowClear
                className="w-full"
                placeholder={
                  chartOptions.length ? "选择图表模板" : "扩展包未提供图表索引"
                }
                options={chartOptions}
                value={chartIds}
                onChange={changeChartIds}
                {...previewLock}
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
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2">
              <div>
                <Text className="block">原生 PowerPoint 图表</Text>
                <Text type="secondary" className="block text-xs">
                  开启后优先用 python-pptx 生成可编辑图表；图表页可能不沿用版式模板
                </Text>
              </div>
              <Switch
                checked={nativeCharts}
                onChange={changeNativeCharts}
                {...previewLock}
              />
            </div>
          </Space>
        </Card>
      )}

      {viewStep === 2 && plan && (
        <Card
          title={`大纲确认（${plan.slides.length} 页）`}
          extra={
            previewingFuture ? (
              <Tag color="blue">只读预览</Tag>
            ) : (
              <Space wrap>
                <Button onClick={() => setStep(1)} disabled={running}>
                  返回风格
                </Button>
                <Button icon={<Plus size={14} />} onClick={addSlide}>
                  添加页
                </Button>
                <Button
                  type="primary"
                  icon={<Sparkles size={16} />}
                  loading={running}
                  onClick={goToDraft}
                >
                  {reuseDraft ? "继续到草稿修改" : "确认大纲，生成草稿"}
                </Button>
              </Space>
            )
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-slate-200 px-3 py-2">
            <Text>目标页数</Text>
            <InputNumber
              min={1}
              max={40}
              value={slideCount}
              placeholder="自动"
              disabled={running || regenerating}
              {...previewLock}
              onChange={(value) =>
                setSlideCount(typeof value === "number" ? value : undefined)
              }
            />
            <Text type="secondary" className="text-xs">
              留空由 AI 决定；修改页数后点击「重新生成大纲」
            </Text>
            <Button
              icon={<RotateCcw size={14} />}
              loading={regenerating}
              disabled={running || previewingFuture}
              onClick={() => void handleRegenerateOutline()}
            >
              重新生成大纲
            </Button>
            {regenerating && (
              <Button
                danger
                icon={<Square size={14} />}
                onClick={() => void handleCancelPlanning()}
              >
                取消规划
              </Button>
            )}
          </div>
          <Alert
            className="mb-3"
            type="info"
            showIcon
            message="可调整页序、标题、核心信息与要点；图表数据由 AI 生成，当前不在此处编辑数值。修改后需重新生成草稿。"
          />
          <div className="max-h-[560px] overflow-y-auto pr-1">
            {plan.slides.map((slide, index) => (
              <Card
                key={`${index}-${slide.title.slice(0, 12)}`}
                size="small"
                className="mb-3"
                title={
                  <Space>
                    <Tag color="blue">P{index + 1}</Tag>
                    <Text>页面</Text>
                  </Space>
                }
                extra={
                  <Space size={4}>
                    <Tooltip title="上移">
                      <Button
                        size="small"
                        type="text"
                        icon={<ArrowUp size={14} />}
                        disabled={index === 0 || previewingFuture}
                        onClick={() => moveSlide(index, -1)}
                      />
                    </Tooltip>
                    <Tooltip title="下移">
                      <Button
                        size="small"
                        type="text"
                        icon={<ArrowDown size={14} />}
                        disabled={
                          index === plan.slides.length - 1 || previewingFuture
                        }
                        onClick={() => moveSlide(index, 1)}
                      />
                    </Tooltip>
                    <Popconfirm
                      title="删除这一页？"
                      onConfirm={() => removeSlide(index)}
                      disabled={plan.slides.length <= 1}
                    >
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<Trash2 size={14} />}
                        disabled={plan.slides.length <= 1 || previewingFuture}
                      />
                    </Popconfirm>
                  </Space>
                }
              >
                <Space direction="vertical" size="small" className="w-full">
                  <Input
                    value={slide.title}
                    {...previewLock}
                    onChange={(event) =>
                      updateSlide(index, { title: event.target.value })
                    }
                    placeholder="页面标题"
                  />
                  <Input.TextArea
                    rows={2}
                    value={slide.coreMessage}
                    {...previewLock}
                    onChange={(event) =>
                      updateSlide(index, { coreMessage: event.target.value })
                    }
                    placeholder="核心信息 / 副标题"
                  />
                  <Input.TextArea
                    rows={4}
                    value={slide.bullets.join("\n")}
                    {...previewLock}
                    onChange={(event) =>
                      updateSlide(index, {
                        bullets: event.target.value
                          .split("\n")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="每行一条要点"
                  />
                  {slide.chart && (
                    <Tag color="purple">
                      图表：{slide.chart.type} · {slide.chart.categories.length} 类
                    </Tag>
                  )}
                </Space>
              </Card>
            ))}
          </div>
        </Card>
      )}

      {viewStep === 2 && !plan && (
        <StepPreviewPlaceholder
          step={2}
          description="确认风格后，AI 会根据素材生成大纲。这里可以逐页调整标题、核心信息、要点与图表，再生成草稿。"
          hints={[
            "目标页数与重新生成大纲",
            "逐页编辑标题 / 核心信息 / 要点",
            "图表页标注图表类型与分类数",
          ]}
        />
      )}

      {viewStep === 3 && (running || job) && (
        <Card
          className="mt-4"
          title={
            running
              ? "正在生成草稿"
              : `草稿修改（${draftPages.length} 页）`
          }
          extra={
            running ? (
              <Button
                danger
                size="small"
                icon={<Square size={14} />}
                onClick={() => void handleCancel()}
              >
                取消生成
              </Button>
            ) : previewingFuture ? (
              <Tag color="blue">只读预览</Tag>
            ) : (
              <Space wrap>
                <Button size="small" onClick={() => setStep(2)}>
                  返回大纲
                </Button>
                <Button
                  size="small"
                  type={planDirty || styleDirty ? "primary" : "default"}
                  icon={<RotateCcw size={14} />}
                  onClick={() => void handleRerenderDraft()}
                >
                  重新生成草稿
                </Button>
                <Button
                  size="small"
                  type="primary"
                  icon={<Sparkles size={14} />}
                  disabled={draftPages.length === 0}
                  onClick={goToExport}
                >
                  {reuseExport ? "继续到最终导出" : "导出 PPTX"}
                </Button>
              </Space>
            )
          }
        >
          <Space direction="vertical" size="middle" className="w-full">
            <div className="flex flex-wrap items-center gap-3">
              <Text strong>生成方式</Text>
              <Segmented
                value={draftMode}
                disabled={running || previewingFuture}
                onChange={(value) =>
                  setDraftMode(value as PptDraftGenerationMode)
                }
                options={[
                  { label: "程序化生成", value: "programmatic" },
                  { label: "一次性生成", value: "oneShot" },
                  { label: "多次生成", value: "bestOf" },
                ]}
              />
              <Text type="secondary" className="text-xs">
                {draftMode === "bestOf"
                  ? "每页最多 3 个 AI 候选，质量优先、耗时最长"
                  : draftMode === "oneShot"
                    ? "每页 1 次 AI 连续生成，接近上游 skill，速度与质量平衡"
                    : "Rust 程序化排版，3 个结构候选选优，不调用 AI 生成页面，速度最快"}
              </Text>
            </div>
            {running ? (
              <>
                <Progress
                  percent={
                    draftProgress && draftProgress.total > 0
                      ? Math.round(
                          (draftDoneCount / draftProgress.total) * 100,
                        )
                      : progressPercent
                  }
                  status="active"
                />
                {draftProgress && (
                  <Text type="secondary">
                    {`草稿生成中：${draftDoneCount}/${draftProgress.total} · 当前 P${draftProgress.page} · 候选 ${draftProgress.candidateCount || "…"} · ${draftProgress.status}`}
                  </Text>
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
              </>
            ) : (
              <>
                {job && ["failed", "cancelled"].includes(job.status) && (
                  <Alert
                    type="error"
                    showIcon
                    message={`草稿生成${
                      job.status === "cancelled" ? "已取消" : "失败"
                    }`}
                    description={job.errorMessage ?? job.errorCode ?? "未知错误"}
                  />
                )}
                {(planDirty || styleDirty) && (
                  <Alert
                    type="warning"
                    showIcon
                    message="内容、页序或风格已修改"
                    description="左侧仍是旧草稿，页序调整不会自动刷新预览。重新生成后才会按新顺序渲染并允许导出。"
                    action={
                      <Button
                        size="small"
                        type="primary"
                        disabled={running || previewingFuture}
                        onClick={() => void handleRerenderDraft()}
                      >
                        立即重新生成
                      </Button>
                    }
                  />
                )}
                {draftLoading ? (
                  <Text type="secondary">正在加载草稿页面…</Text>
                ) : draftPages.length === 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="暂无草稿页面"
                    description="点击「重新生成草稿」开始渲染。"
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                    <div className="max-h-[640px] overflow-y-auto rounded border border-slate-200">
                      {planDirty && (
                        <div className="sticky top-0 z-[1] border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                          页序待同步：左侧仍是旧草稿顺序，重新生成后更新
                        </div>
                      )}
                      <List
                        size="small"
                        dataSource={draftPages}
                        renderItem={(page) => (
                          <List.Item
                            className={`cursor-pointer !px-3 ${
                              selectedDraftFile === page.file ? "bg-blue-50" : ""
                            }`}
                            onClick={() => setSelectedDraftFile(page.file)}
                          >
                            <div className="flex w-full items-center gap-2">
                              <Tag color="blue">P{page.page}</Tag>
                              <div className="min-w-0 flex-1">
                                <Text
                                  ellipsis={{ tooltip: page.title }}
                                  className="block"
                                >
                                  {page.title}
                                </Text>
                                <Text type="secondary" className="block text-xs">
                                  {page.file}
                                </Text>
                              </div>
                              {(() => {
                                const selection = pageSelection?.pages.find(
                                  (item) => item.page === page.page,
                                );
                                if (!selection) return null;
                                return (
                                  <Tag
                                    color={
                                      selection.score >= 70
                                        ? "green"
                                        : selection.score >= 55
                                          ? "gold"
                                          : "red"
                                    }
                                  >
                                    {selection.score}
                                  </Tag>
                                );
                              })()}
                              <Tooltip title="按提示词重新生成此页">
                                <Button
                                  size="small"
                                  type="text"
                                  loading={regenPage === page.page}
                                  disabled={previewingFuture}
                                  icon={<RotateCcw size={13} />}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openRegenPrompt(page.page);
                                  }}
                                />
                              </Tooltip>
                            </div>
                          </List.Item>
                        )}
                      />
                    </div>
                    <div className="space-y-3">
                      {selectedDraftFile && draftSvgs[selectedDraftFile] ? (
                        <div className="flex min-h-[320px] items-center justify-center rounded border border-slate-200 bg-slate-50 p-2">
                          <img
                            src={svgDataUrl(draftSvgs[selectedDraftFile])}
                            alt="草稿预览"
                            className="max-h-[420px] w-full object-contain"
                          />
                        </div>
                      ) : (
                        <Empty description="选择左侧页面预览" />
                      )}
                      {selectedDraftSlide &&
                        pageCandidates &&
                        pageCandidates.candidates.length > 1 && (
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
                                  disabled={previewingFuture}
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
                                    <Tooltip
                                      title={candidate.note || undefined}
                                    >
                                      <span className="truncate">
                                        {candidate.label || candidate.motif}
                                      </span>
                                    </Tooltip>
                                    <Tag
                                      color={
                                        candidate.score >= 70 ? "green" : "gold"
                                      }
                                    >
                                      {candidate.score}
                                    </Tag>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </Card>
                        )}
                      {selectedDraftSlide && (
                        <Card
                          size="small"
                          title={`编辑 P${selectedDraftSlide.page}`}
                          extra={
                            previewingFuture ? (
                              <Tag color="blue">只读预览</Tag>
                            ) : (
                            <Space size={4}>
                              <Button icon={<Plus size={14} />} size="small" type="text" onClick={addSlide} />
                              <Tooltip title="按提示词重新生成此页">
                                <Button
                                  size="small"
                                  type="text"
                                  icon={<Sparkles size={14} />}
                                  loading={regenPage === selectedDraftSlide.page}
                                  onClick={() => openRegenPrompt(selectedDraftSlide.page)}
                                />
                              </Tooltip>
                              <Tooltip title="上移">
                                <Button
                                  size="small"
                                  type="text"
                                  icon={<ArrowUp size={14} />}
                                  disabled={selectedDraftIndex <= 0}
                                  onClick={() =>
                                    moveSlide(selectedDraftIndex, -1)
                                  }
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
                            <Input
                              value={selectedDraftSlide.title}
                              {...previewLock}
                              onChange={(event) =>
                                updateSlide(selectedDraftIndex, {
                                  title: event.target.value,
                                })
                              }
                              placeholder="页面标题"
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
                              placeholder="核心信息 / 副标题"
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
                              placeholder="每行一条要点"
                            />
                            {selectedDraftSlide.chart && (
                              <Tag color="purple">
                                图表：{selectedDraftSlide.chart.type} ·{" "}
                                {selectedDraftSlide.chart.categories.length} 类
                              </Tag>
                            )}
                            <Text type="secondary" className="text-xs">
                              修改内容或页序后，点击「重新生成草稿」刷新预览；第一版不支持 SVG 元素拖拽。
                            </Text>
                          </Space>
                        </Card>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </Space>
        </Card>
      )}

      {viewStep === 3 && !(running || job) && (
        <StepPreviewPlaceholder
          step={3}
          description="大纲确认后会按页渲染草稿。这里可以查看每页缩略图、切换结构候选，并按提示词单独重生成某一页。"
          hints={[
            "页面缩略图列表与 SVG 预览",
            "候选评分与结构切换",
            "单页按提示词重新生成",
          ]}
        />
      )}

      {viewStep === 4 && (running || job) && (
        <Card
          className="mt-4"
          title={running ? "正在导出 PPTX" : "最终导出"}
          extra={
            running ? (
              <Button
                danger
                size="small"
                icon={<Square size={14} />}
                onClick={() => void handleCancel()}
              >
                取消导出
              </Button>
            ) : previewingFuture ? (
              <Tag color="blue">只读预览</Tag>
            ) : (
              <Space wrap>
                <Button size="small" onClick={() => setStep(3)}>
                  返回草稿
                </Button>
                <Button size="small" onClick={backToSettings}>
                  返回设置
                </Button>
                <Button size="small" onClick={() => void editOutline()}>
                  修改大纲
                </Button>
                <Button
                  size="small"
                  type="primary"
                  icon={<Sparkles size={14} />}
                  onClick={() => void handleExport()}
                >
                  重新导出
                </Button>
              </Space>
            )
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
          </Space>
        </Card>
      )}

      {viewStep === 4 && !(running || job) && (
        <StepPreviewPlaceholder
          step={4}
          description="草稿确认后可导出为可编辑 PPTX。这里显示导出进度、输出路径，以及打开 PPT / 工程目录的操作。"
          hints={["导出目录选择", "导出进度与日志", "打开 PPT / 工程目录"]}
        />
      )}

      <Drawer
        title="历史作业"
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
  );
}
