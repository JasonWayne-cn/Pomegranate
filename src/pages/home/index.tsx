import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import {
  Input,
  Typography,
  Button,
  Modal,
  Popover,
  Segmented,
  App as AntdApp,
  theme as antdTheme,
} from "antd";
import {
  NotebookText,
  CalendarDays,
  Pin,
  Bot,
  CheckSquare,
  PencilLine,
  Send,
  Flame,
  MessageCircle,
  Check,
  Star,
  Copy,
  Edit3,
  Trash2,
  ExternalLink,
  ChevronRight,
  CornerDownRight,
  PenTool,
  Eye,
  EyeOff,
  FilePlus2,
  Plus,
  X,
  RotateCcw,
} from "lucide-react";
import { Tooltip as AntTooltip } from "antd";
import {
  noteApi,
  dailyApi,
  systemApi,
  taskApi,
  trashApi,
  aiChatApi,
  imageApi,
} from "@/lib/api";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";
import { relativeTime, localYmd, todayYmd } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { NewNoteButton } from "@/components/NewNoteButton";
import { NewTodoButton } from "@/components/NewTodoButton";
import { MicButton } from "@/components/MicButton";
import { HomeSearchInput } from "@/components/HomeSearchInput";
import { useAppStore } from "@/store";
import { useHomeWidgetsStore } from "@/store/homeWidgets";
import {
  useHomeLayoutStore,
  type HomeWidgetId,
  COL_SPAN_MAP,
  ROW_SPAN_MAP,
  WIDGET_ROW_HEIGHT,
} from "@/store/homeLayout";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { SortableWidget } from "@/components/home/SortableWidget";
import { HomeWidget } from "@/components/home/HomeWidget";
import { WritingHeatmap } from "@/components/home/WritingHeatmap";
import { useFeatureEnabled } from "@/hooks/useFeatureEnabled";
import type {
  Note,
  DashboardStats,
  DailyWritingStat,
  Task,
  AiConversation,
  NotesOnDay,
} from "@/types";
import { SubtaskList } from "@/components/tasks/SubtaskList";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { CreateTaskModal } from "@/components/tasks/CreateTaskModal";
import {
  escapeHtml,
  fileToBase64,
  imageFilesFrom,
  quickImagesHtml,
  quickTextToNote,
} from "@/lib/quickNote";

const { Text } = Typography;

/** 待办速览的四个分组 */
type TodoTab = "overdue" | "today" | "upcoming" | "noDue";

/** 首页「问 AI」推荐问题：通用、不依赖具体笔记内容 */
const ASK_AI_SUGGESTIONS = ["总结我这周写的内容", "最近有哪些没写完的笔记", "找出没有链接的孤立笔记"];

/** 按小时给问候语 */
function greetingFor(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 9) return "早上好";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** 「11 月 3 日 · 星期二」 */
function homeDateLabel(d: Date): string {
  const wk = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${wk}`;
}

/** 笔记类型图标块：日记橙、白板蓝、普通笔记主色 */
function NoteTypeIcon({ isDaily, noteType }: { isDaily: boolean; noteType: string }) {
  const { token } = antdTheme.useToken();
  const whiteboard = noteType === "whiteboard";
  return (
    <span
      className="kb-cico sm"
      title={isDaily ? "日记" : whiteboard ? "白板" : "笔记"}
      style={{ color: isDaily ? token.colorWarning : whiteboard ? token.colorInfo : token.colorPrimary }}
    >
      {isDaily ? <CalendarDays size={14} /> : whiteboard ? <PenTool size={14} /> : <NotebookText size={14} />}
    </span>
  );
}

/** 观测元素高度：返回 [高度, 回调 ref]。折叠/展开导致挂载变化时自动重连。 */
function useMeasuredHeight(fallback: number): [number, (node: HTMLDivElement | null) => void] {
  const [height, setHeight] = useState(fallback);
  const roRef = useRef<ResizeObserver | null>(null);
  const observe = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!node) return;
    const ro = new ResizeObserver(() => setHeight(node.clientHeight));
    ro.observe(node);
    setHeight(node.clientHeight);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);
  return [height, observe];
}

/**
 * 桌面端首页（对齐知识库新版）：
 *   ① 页头：日期 + 问候 + 搜索 + 新建笔记 + 重置布局 + 隐私模式
 *   ② 随手记：一个输入框两个去处（存为新笔记 / 记到今天的日记），支持粘贴图片
 *   ③ 待办（快速添加 + 分组胶囊）｜ 笔记（最近编辑 / 置顶）
 *   ④ 写作活力（5 指标 + 年度热力图）｜ 问 AI
 *
 * 保留原工作台的拖拽排序、列宽/行高调整、折叠、「重置布局」。
 */
function DesktopHomePage() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const refreshTaskStats = useAppStore((s) => s.refreshTaskStats);
  const privacyMode = useHomeWidgetsStore((s) => s.privacyMode);

  // 功能模块开关：用户在设置里关闭某模块时，首页相关的卡片/按钮也要联动隐藏
  const tasksEnabled = useFeatureEnabled("tasks");
  const dailyEnabled = useFeatureEnabled("daily");
  const aiEnabled = useFeatureEnabled("ai");

  // ─── 数据状态 ─────────────────────────────────────
  const [recentNotes, setRecentNotes] = useState<Note[]>([]);
  const [pinnedNotes, setPinnedNotes] = useState<Note[]>([]);
  /** 笔记总数（笔记列表口径：不含日记 / 隐藏） */
  const [notesTotal, setNotesTotal] = useState(0);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [trend, setTrend] = useState<DailyWritingStat[]>([]);
  /** 今日待办速览(今天 + 逾期,前端筛 / 切片) */
  const [todayTasks, setTodayTasks] = useState<Task[]>([]);
  /** 即将到期速览(今天之后,按 due 升序) */
  const [upcomingTasks, setUpcomingTasks] = useState<Task[]>([]);
  /** 无截止日期速览 */
  const [noDueTasks, setNoDueTasks] = useState<Task[]>([]);
  /** 最近 AI 会话(用于"问 AI"卡 fallback 列表) */
  const [recentChats, setRecentChats] = useState<AiConversation[]>([]);
  /** 今日日记字数；null = 今天还没有日记（用只读 get，不能凭空建日记） */
  const [todayDailyWords, setTodayDailyWords] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // ─── 首页布局（可拖拽排序 + 折叠 + 宽高） ────────────
  const {
    widgets,
    collapsed,
    hydrate: hydrateLayout,
    setOrder,
    setColSpan,
    setHeight,
    toggleCollapse,
    resetLayout,
  } = useHomeLayoutStore();

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  /** 根据功能开关过滤可见 widget */
  const visibleWidgets = useMemo(() => {
    return widgets.filter((w) => {
      switch (w.id) {
        // 随手记不随日记模块开关消失：关掉日记仍可「存为新笔记」
        case "quick-note":
          return true;
        case "todo":
          return tasksEnabled;
        case "ai":
          return aiEnabled;
        default:
          return true;
      }
    });
  }, [widgets, dailyEnabled, tasksEnabled, aiEnabled]);

  const visibleWidgetIds = useMemo(
    () => visibleWidgets.map((w) => w.id),
    [visibleWidgets],
  );

  // ─── 输入态 ───────────────────────────────────────
  const [searchKeyword, setSearchKeyword] = useState("");
  const [quickNote, setQuickNote] = useState("");
  const [quickNoteSaving, setQuickNoteSaving] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  /** 随手记里粘贴的图片（保存时才存进对应笔记的素材目录）；url 是预览用的 blob 地址 */
  const [quickImages, setQuickImages] = useState<{ file: File; url: string }[]>([]);
  /** 待办卡顶部的快速添加 */
  const [quickTodo, setQuickTodo] = useState("");
  /** 往快速添加框里粘了截图：打开完整新建弹窗，带上已打的字和截图 */
  const [todoPasteDraft, setTodoPasteDraft] = useState<{ title: string; files: File[] } | null>(null);
  const [quickTodoSaving, setQuickTodoSaving] = useState(false);
  /** 笔记卡当前看哪个标签 */
  const [noteTab, setNoteTab] = useState<"recent" | "pinned">("recent");
  /** 待办卡当前看哪个分组；null = 还没手动选过 */
  const [todoTab, setTodoTab] = useState<TodoTab | null>(null);
  /** 热力图点开的那天 */
  const [dayPick, setDayPick] = useState<{ date: string; rect: DOMRect } | null>(null);
  const [dayNotes, setDayNotes] = useState<NotesOnDay | null>(null);
  /** 待办详情弹窗 */
  const [taskDetail, setTaskDetail] = useState<Task | null>(null);
  /** 编辑弹窗（详情 Modal 点「编辑」时打开）*/
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<number>>(new Set());

  // 待办 / 笔记卡片内容区高度 → 能放几行（随高度档位 / 窗口自适应）
  const [todoBodyHeight, todoBodyRef] = useMeasuredHeight(240);
  const [notesBodyHeight, notesBodyRef] = useMeasuredHeight(240);
  const todoRows = useMemo(
    () => Math.max(1, Math.floor((todoBodyHeight - 24) / 40) - 2),
    [todoBodyHeight],
  );
  const noteRows = useMemo(
    () => Math.max(2, Math.floor((notesBodyHeight - 24) / 40)),
    [notesBodyHeight],
  );

  // ─── 数据加载 ─────────────────────────────────────
  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [notesResult, dashStats, trendData, allTodos, chats, todayDaily] =
        await Promise.all([
          // 拉 24 条：要拆成「最近」和「置顶」两组，窗口高时每组最多能放十几条
          noteApi.list({ page: 1, page_size: 24 }),
          systemApi.getDashboardStats(),
          // 371 天 = 53 周：写作活力的年度热力图要一整年
          systemApi.getWritingTrend(371),
          taskApi.list({ status: 0 }).catch(() => [] as Task[]),
          aiChatApi.listConversations().catch(() => [] as AiConversation[]),
          dailyApi.get(todayYmd()).catch(() => null),
        ]);
      setRecentNotes(notesResult.items.filter((n) => !n.is_pinned));
      setNotesTotal(notesResult.total);
      setPinnedNotes(notesResult.items.filter((n) => n.is_pinned));
      setStats(dashStats);
      setTrend(trendData);
      // 四段筛：逾期+今日 / 今天之后（不卡 7 天）/ 无截止日期
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      const open = allTodos.filter((t) => t.status === 0);
      const allWithDue = open.filter((t) => t.due_date);
      const noDue = open.filter((t) => !t.due_date);
      const sortByDue = (a: Task, b: Task) =>
        new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime();
      const todayOrOverdue = allWithDue
        .filter((t) => new Date(t.due_date!).getTime() <= todayEnd.getTime())
        .sort(sortByDue);
      const upcoming = allWithDue
        .filter((t) => new Date(t.due_date!).getTime() > todayEnd.getTime())
        .sort(sortByDue);
      const noDueSorted = [...noDue].sort((a, b) => {
        if (a.important !== b.important) return a.important ? -1 : 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      setTodayTasks(todayOrOverdue);
      setUpcomingTasks(upcoming);
      setNoDueTasks(noDueSorted);
      setRecentChats(chats.slice(0, 3));
      setTodayDailyWords(todayDaily ? todayDaily.word_count : null);
    } catch (e) {
      console.error("加载首页数据失败:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
    void hydrateLayout();
  }, [loadDashboard, hydrateLayout]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const allIds = widgets.map((w) => w.id);
      const oldIdx = allIds.indexOf(active.id as HomeWidgetId);
      const newIdx = allIds.indexOf(over.id as HomeWidgetId);
      if (oldIdx === -1 || newIdx === -1) return;
      setOrder(arrayMove(allIds, oldIdx, newIdx));
    },
    [widgets, setOrder],
  );

  const handleResetLayout = useCallback(() => {
    Modal.confirm({
      title: "重置首页布局",
      content: "将所有 Widget 的位置、宽度、高度和折叠状态恢复为默认。",
      okText: "重置",
      cancelText: "取消",
      onOk: () => {
        resetLayout();
        message.success("已重置为默认布局");
      },
    });
  }, [resetLayout, message]);

  // ─── 搜索 ─────────────────────────────────────────
  const handleSearch = useCallback(() => {
    if (searchKeyword.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchKeyword.trim())}`);
    }
  }, [searchKeyword, navigate]);

  // ─── 今天的日记跳转 ────────────────────────────────
  const handleTodayNote = useCallback(async () => {
    try {
      const today = todayYmd();
      await dailyApi.getOrCreate(today);
      navigate(`/daily?date=${today}`);
    } catch (e) {
      message.error(`打开今天的日记失败: ${e}`);
    }
  }, [navigate, message]);

  // ─── 随手记的图片：粘贴进来先只做预览，保存时才存进目标笔记 ───────────
  const addQuickImages = useCallback((files: File[]) => {
    setQuickImages((prev) => [...prev, ...files.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  }, []);
  const removeQuickImage = useCallback((url: string) => {
    URL.revokeObjectURL(url);
    setQuickImages((prev) => prev.filter((i) => i.url !== url));
  }, []);
  const clearQuickImages = useCallback(() => {
    setQuickImages((prev) => {
      prev.forEach((i) => URL.revokeObjectURL(i.url));
      return [];
    });
  }, []);
  /** 把随手记里的图片存进这篇笔记的素材目录，返回正文里要追加的片段 */
  const saveQuickImagesTo = useCallback(
    async (noteId: number) => {
      const rels: string[] = [];
      for (const { file } of quickImages) {
        const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
        rels.push(await imageApi.save(noteId, file.name || `image.${ext}`, await fileToBase64(file)));
      }
      return quickImagesHtml(rels);
    },
    [quickImages],
  );
  const quickHasContent = quickNote.trim() !== "" || quickImages.length > 0;

  // ─── 随手记：记到今天的日记 ────────────────────────
  const handleQuickSaveNote = useCallback(async () => {
    const text = quickNote.trim();
    if (!text && quickImages.length === 0) return;
    setQuickNoteSaving(true);
    try {
      const today = todayYmd();
      const daily = await dailyApi.getOrCreate(today);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      // 用时间戳前缀分隔多条快速记录,内容追加到 content 末尾(content 是 HTML)
      const appendBlock =
        `<p><strong>[${hhmm}]</strong>${text ? " " + escapeHtml(text).replace(/\n/g, "<br>") : ""}</p>` +
        (await saveQuickImagesTo(daily.id));
      const newContent = (daily.content || "") + appendBlock;
      await noteApi.update(daily.id, {
        title: daily.title,
        content: newContent,
        folder_id: daily.folder_id,
      });
      message.success("已记到今天的日记");
      setQuickNote("");
      clearQuickImages();
      loadDashboard();
      useAppStore.getState().bumpNotesRefresh();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setQuickNoteSaving(false);
    }
  }, [quickNote, quickImages.length, message, loadDashboard, saveQuickImagesTo, clearQuickImages]);

  // ─── 随手记：存为新笔记（第一行当标题） ─────────────
  const handleQuickSaveAsNote = useCallback(async () => {
    const text = quickNote.trim();
    if (!text && quickImages.length === 0) return;
    setQuickNoteSaving(true);
    try {
      const { title, content } = text
        ? quickTextToNote(text)
        : { title: `随手记 ${todayYmd()}`, content: "" };
      const note = await noteApi.create({ title, content, folder_id: null });
      // 图片要存在这篇笔记的目录下，所以先建笔记、再存图、再补进正文
      if (quickImages.length > 0) {
        const imagesHtml = await saveQuickImagesTo(note.id);
        await noteApi.update(note.id, { title, content: content + imagesHtml, folder_id: null });
      }
      message.success(`已存为新笔记「${title}」`);
      setQuickNote("");
      clearQuickImages();
      loadDashboard();
      useAppStore.getState().bumpNotesRefresh();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setQuickNoteSaving(false);
    }
  }, [quickNote, quickImages.length, message, loadDashboard, saveQuickImagesTo, clearQuickImages]);

  // ─── 待办卡顶部快速添加：默认今天到期 ───────────────
  const handleQuickAddTodo = useCallback(async () => {
    const title = quickTodo.trim();
    if (!title) return;
    setQuickTodoSaving(true);
    try {
      await taskApi.create({ title, due_date: `${todayYmd()} 00:00:00` });
      setQuickTodo("");
      setTodoTab("today");
      refreshTaskStats();
      loadDashboard();
    } catch (e) {
      message.error(`添加待办失败: ${e}`);
    } finally {
      setQuickTodoSaving(false);
    }
  }, [quickTodo, message, refreshTaskStats, loadDashboard]);

  // ─── 热力图：点某天列出当天写过的笔记 ─────────────────
  const handleSelectDay = useCallback(
    (date: string, el: HTMLElement) => {
      setDayPick({ date, rect: el.getBoundingClientRect() });
      setDayNotes(null);
      systemApi
        .listNotesWrittenOn(date)
        .then(setDayNotes)
        .catch((e) => {
          setDayPick(null);
          message.error(`读取 ${date} 的笔记失败: ${e}`);
        });
    },
    [message],
  );

  // ─── 完成 / 切换待办状态 ──────────────────────────
  const handleToggleTask = useCallback(
    async (id: number) => {
      try {
        await taskApi.toggleStatus(id);
        refreshTaskStats();
        loadDashboard();
      } catch (e) {
        message.error(`操作失败: ${e}`);
      }
    },
    [message, refreshTaskStats, loadDashboard],
  );

  /** 同时 patch todayTasks / upcomingTasks / noDueTasks */
  const patchTask = useCallback((id: number, patch: Partial<Task>) => {
    setTodayTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
    setUpcomingTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
    setNoDueTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }, []);

  // ─── 右键菜单（笔记 + 待办两个 widget） ─────────────
  const noteCtx = useContextMenu<Note>();
  const taskCtx = useContextMenu<Task>();

  const noteMenuItems: ContextMenuEntry[] = useMemo(() => {
    const p = noteCtx.state.payload;
    if (!p) return [];
    return [
      {
        key: "open",
        label: "打开笔记",
        icon: <ExternalLink size={13} />,
        onClick: () => {
          noteCtx.close();
          navigate(`/notes/${p.id}`);
        },
      },
      {
        key: "copy-wiki",
        label: "复制为 wiki 链接",
        icon: <Copy size={13} />,
        onClick: () => {
          noteCtx.close();
          const link = `[[${p.title || "无标题"}]]`;
          navigator.clipboard
            .writeText(link)
            .then(() => message.success(`已复制：${link}`))
            .catch((e) => message.error(`复制失败：${e}`));
        },
      },
      { type: "divider" },
      {
        key: "trash",
        label: "移到回收站",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          noteCtx.close();
          Modal.confirm({
            title: `把「${p.title || "(无标题)"}」移到回收站？`,
            content: "可以在回收站恢复。",
            okText: "移入回收站",
            okButtonProps: { danger: true },
            async onOk() {
              try {
                await trashApi.softDelete(p.id);
                message.success("已移到回收站");
                loadDashboard();
              } catch (e) {
                message.error(`删除失败：${e}`);
              }
            },
          });
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteCtx.state.payload]);

  const taskMenuItems: ContextMenuEntry[] = useMemo(() => {
    const p = taskCtx.state.payload;
    if (!p) return [];
    const done = p.status === 1;
    return [
      {
        key: "toggle",
        label: done ? "标记为未完成" : "标记已完成",
        icon: <Check size={13} />,
        onClick: () => {
          taskCtx.close();
          void handleToggleTask(p.id);
        },
      },
      {
        key: "edit",
        label: "在待办页打开",
        icon: <Edit3 size={13} />,
        onClick: () => {
          taskCtx.close();
          navigate(`/tasks?taskId=${p.id}`);
        },
      },
      { type: "divider" },
      {
        key: "delete",
        label: "删除任务",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => {
          taskCtx.close();
          Modal.confirm({
            title: `删除任务「${p.title || "(无标题)"}」？`,
            content: "此操作不可恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            async onOk() {
              try {
                await taskApi.delete(p.id);
                message.success("已删除");
                refreshTaskStats();
                loadDashboard();
              } catch (e) {
                message.error(`删除失败：${e}`);
              }
            },
          });
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskCtx.state.payload]);

  // ─── 问 AI 直接发送 ───────────────────────────────
  const handleAskAi = useCallback(async () => {
    const q = aiQuestion.trim();
    if (!q) return;
    try {
      const conv = await aiChatApi.createConversation(q.slice(0, 30));
      navigate("/ai", {
        state: { activeConvId: conv.id, pendingPrompt: q },
      });
      setAiQuestion("");
    } catch (e) {
      message.error(`新建会话失败: ${e}`);
    }
  }, [aiQuestion, navigate, message]);

  // ─── 派生指标(纯前端从 trend 计算) ────────────────
  const vitalityMetrics = useMemo(() => {
    // trend 是按日期升序,只含有笔记的日期（后端已含日记、排除外部索引）
    const todayStr = localYmd(new Date());
    const trendByDate = new Map(trend.map((d) => [d.date, d]));

    // 连续写作天数:从今天往前数,直到某天没写作
    let streak = 0;
    const cursor = new Date();
    for (let i = 0; i < 365; i++) {
      const ymd = localYmd(cursor);
      const d = trendByDate.get(ymd);
      if (d && d.word_count > 0) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else {
        // 如果今天还没写,允许从昨天起算(避免一进首页就 = 0)
        if (i === 0) {
          cursor.setDate(cursor.getDate() - 1);
          continue;
        }
        break;
      }
    }

    // 距上次写作:用后端 last_written_at（含日记、排除导入）
    const lastWritingAt = stats?.last_written_at ?? undefined;
    const lastSinceLabel = lastWritingAt ? relativeTime(lastWritingAt) : "—";

    // 本周字数(最近 7 天) + 上周字数(8-14 天)对比
    let thisWeek = 0;
    let lastWeek = 0;
    const now = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const ymd = localYmd(d);
      const stat = trendByDate.get(ymd);
      if (!stat) continue;
      if (i < 7) thisWeek += stat.word_count;
      else lastWeek += stat.word_count;
    }
    const weekDelta = lastWeek > 0
      ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100)
      : null;

    return {
      totalNotes: stats?.total_notes ?? 0,
      totalWords: stats?.total_words ?? 0,
      streak,
      lastSinceLabel,
      thisWeekWords: thisWeek,
      weekDelta,
      todayStr,
      trendByDate,
    };
  }, [trend, stats]);

  // 待办速览四段：逾期（昨天及更早）/ 今日 / 即将到期 / 无截止日期
  const todoGroups = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();
    const overdue: Task[] = [];
    const today: Task[] = [];
    for (const t of todayTasks) {
      // todayTasks 已经是 due ≤ 今天结束 的，按 todayStart 切：早于今天 0:00 = 逾期
      if (new Date(t.due_date!).getTime() < todayStartMs) overdue.push(t);
      else today.push(t);
    }
    return {
      overdue: overdue.slice(0, todoRows),
      overdueTotal: overdue.length,
      today: today.slice(0, todoRows),
      todayTotal: today.length,
      upcoming: upcomingTasks.slice(0, todoRows),
      upcomingTotal: upcomingTasks.length,
      noDue: noDueTasks.slice(0, todoRows),
      noDueTotal: noDueTasks.length,
    };
  }, [todayTasks, upcomingTasks, noDueTasks, todoRows]);
  const totalTodoCount =
    todoGroups.overdueTotal +
    todoGroups.todayTotal +
    todoGroups.upcomingTotal +
    todoGroups.noDueTotal;
  const displayedRecent = useMemo(() => recentNotes.slice(0, noteRows), [recentNotes, noteRows]);

  // 全局隐私模式快捷键（Ctrl/⌘+Shift+H）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "h"
      ) {
        e.preventDefault();
        useHomeWidgetsStore.getState().togglePrivacyMode();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const todayWords =
    vitalityMetrics.trendByDate.get(vitalityMetrics.todayStr)?.word_count ?? 0;

  // ─── 各 widget 的内容 ──────────────────────────────
  const renderQuickNote = () => (
    // flex 纵向布局：输入区在上，底栏按钮用 margin-top:auto 始终贴内容框右下角
    <div style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <Input.TextArea
        variant="borderless"
        className="kb-quick-input"
        rows={2}
        placeholder="想到什么先记下来…"
        value={quickNote}
        onChange={(e) => setQuickNote(e.target.value)}
        // 粘贴截图 / 图片：进下面的缩略图条，保存时存进目标笔记；图文混合时文字照常粘进来
        onPaste={(e) => {
          const files = imageFilesFrom(e.clipboardData);
          if (files.length === 0) return;
          if (!e.clipboardData.getData("text/plain").trim()) e.preventDefault();
          addQuickImages(files);
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            if (dailyEnabled) handleQuickSaveNote();
            else handleQuickSaveAsNote();
          }
        }}
        autoSize={{ minRows: 2, maxRows: 5 }}
      />
      {quickImages.length > 0 && (
        <div className="kb-quick-imgs">
          {quickImages.map((img) => (
            <span key={img.url} className="kb-quick-img">
              <img src={img.url} alt="" />
              <button type="button" title="移除" onClick={() => removeQuickImage(img.url)}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="kb-quick-foot" style={{ marginTop: "auto", flexShrink: 0 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Ctrl / ⌘ + Enter {dailyEnabled ? "记到今天的日记" : "保存"} · 可粘贴图片
        </Text>
        <span className="flex-1" />
        {quickNote.trim() && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {quickNote.trim().length} 字
          </Text>
        )}
        <MicButton
          onTranscribed={(text) =>
            setQuickNote((prev) => (prev ? `${prev}\n${text}` : text))
          }
        />
        <Button
          type={dailyEnabled ? "default" : "primary"}
          icon={<FilePlus2 size={14} />}
          loading={quickNoteSaving}
          disabled={!quickHasContent}
          onClick={handleQuickSaveAsNote}
          title="单独建一篇笔记，第一行作标题"
        >
          存为新笔记
        </Button>
        {dailyEnabled && (
          <Button
            type="primary"
            icon={<CalendarDays size={14} />}
            loading={quickNoteSaving}
            disabled={!quickHasContent}
            onClick={handleQuickSaveNote}
            title="带上时间追加到今天的日记末尾"
          >
            记到今天的日记
          </Button>
        )}
      </div>
    </div>
  );

  const renderTodo = () => {
    const sections: Array<{ key: TodoTab; items: Task[]; total: number; label: string }> = [
      { key: "overdue", items: todoGroups.overdue, total: todoGroups.overdueTotal, label: "逾期" },
      { key: "today", items: todoGroups.today, total: todoGroups.todayTotal, label: "今日" },
      { key: "upcoming", items: todoGroups.upcoming, total: todoGroups.upcomingTotal, label: "即将到期" },
      { key: "noDue", items: todoGroups.noDue, total: todoGroups.noDueTotal, label: "无截止日期" },
    ];
    const activeKey: TodoTab =
      todoTab ??
      (todoGroups.todayTotal > 0
        ? "today"
        : (sections.find((s) => s.total > 0)?.key ?? "today"));
    const active = sections.find((s) => s.key === activeKey)!;

    const renderTaskRow = (task: Task, sectionKey: TodoTab) => {
      const due = new Date(task.due_date ?? Date.now());
      const dueMs = due.getTime();
      const desc = task.description?.trim();
      const ctxActive = taskCtx.state.payload?.id === task.id;
      const hasSubtasks = task.subtask_total > 0;
      const expanded = expandedTodoIds.has(task.id);

      let dueText: string;
      let dueBad = false;
      if (sectionKey === "overdue") {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const days = Math.max(1, Math.round((todayStart.getTime() - dueMs) / 86400000));
        dueText = days === 1 ? "昨天" : `${days} 天前`;
        dueBad = true;
      } else if (sectionKey === "today") {
        const hh = String(due.getHours()).padStart(2, "0");
        const mm = String(due.getMinutes()).padStart(2, "0");
        const allDay = hh === "00" && mm === "00";
        dueText = allDay ? "今天" : `${hh}:${mm}`;
        dueBad = !allDay && dueMs < Date.now();
      } else if (sectionKey === "upcoming") {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        dueText = `+${Math.max(1, Math.ceil((dueMs - todayStart.getTime()) / 86400000))} 天`;
      } else {
        dueText = "无期限";
      }

      return (
        <Fragment key={task.id}>
          <li
            className={"kb-hm-td" + (ctxActive ? " is-ctx" : "")}
            title={desc || undefined}
            onClick={() => setTaskDetail(task)}
            onContextMenu={(e) => {
              e.preventDefault();
              taskCtx.open(e.nativeEvent, task);
            }}
          >
            <button
              type="button"
              className="kb-task-ck"
              aria-label="标记完成"
              onClick={(e) => {
                e.stopPropagation();
                handleToggleTask(task.id);
              }}
            />
            <span className="kb-hm-td-tx">{task.title}</span>
            {task.important && (
              <Star size={12} style={{ color: token.colorPrimary, flexShrink: 0 }} fill={token.colorPrimary} />
            )}
            {hasSubtasks && (
              <button
                type="button"
                className="kb-hm-badge is-btn"
                title={expanded ? "折叠子任务" : "展开子任务"}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpandedTodoIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(task.id)) next.delete(task.id);
                    else next.add(task.id);
                    return next;
                  });
                }}
              >
                <CornerDownRight size={11} />
                {task.subtask_done}/{task.subtask_total}
              </button>
            )}
            {task.priority === 0 && <span className="kb-hm-badge is-r">紧急</span>}
            {task.priority === 2 && <span className="kb-hm-badge">低</span>}
            <span className={"kb-hm-due" + (dueBad ? " is-bad" : "")}>{dueText}</span>
          </li>
          {expanded && hasSubtasks && (
            <li className="kb-hm-sub" onClick={(e) => e.stopPropagation()}>
              <SubtaskList
                parentTaskId={task.id}
                compact
                onChanged={(done, total) =>
                  patchTask(task.id, { subtask_done: done, subtask_total: total })
                }
              />
            </li>
          )}
        </Fragment>
      );
    };

    return (
      <div ref={todoBodyRef} style={{ height: "100%", overflowY: "auto" }}>
        <div className="kb-hm-add">
          <Input
            variant="borderless"
            size="small"
            prefix={<Plus size={14} />}
            placeholder="添加今天的待办，回车保存"
            value={quickTodo}
            disabled={quickTodoSaving}
            onChange={(e) => setQuickTodo(e.target.value)}
            onPressEnter={handleQuickAddTodo}
            onPaste={(e) => {
              const files = imageFilesFrom(e.clipboardData);
              if (files.length === 0) return;
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain").trim();
              setTodoPasteDraft({ title: [quickTodo.trim(), text].filter(Boolean).join(" "), files });
            }}
          />
          <NewTodoButton
            variant="inline"
            onSaved={() => {
              loadDashboard();
              refreshTaskStats();
            }}
          />
        </div>
        <div className="kb-hm-pills">
          {sections.map((s) => (
            <button
              key={s.key}
              type="button"
              className={s.key === activeKey ? "is-on" : undefined}
              onClick={() => setTodoTab(s.key)}
            >
              {s.label}
              <b className={s.key === "overdue" && s.total > 0 ? "is-bad" : undefined}>{s.total}</b>
            </button>
          ))}
        </div>
        {active.items.length === 0 ? (
          <div className="kb-hm-empty">
            {loading ? "加载中…" : totalTodoCount === 0 ? "暂无待办，享受当下 ✨" : `「${active.label}」里没有待办`}
          </div>
        ) : (
          <ul className="kb-hm-list">
            {active.items.map((t) => renderTaskRow(t, active.key))}
            {active.total > active.items.length && (
              <li className="kb-hm-more">
                <button type="button" onClick={() => navigate("/tasks")}>
                  + 还有 {active.total - active.items.length} 条…
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    );
  };

  const renderNotes = () => {
    const list = noteTab === "recent" ? displayedRecent : pinnedNotes.slice(0, noteRows);
    const tabTotal =
      noteTab === "recent" ? Math.max(0, notesTotal - pinnedNotes.length) : pinnedNotes.length;
    const remaining = tabTotal - list.length;
    if (list.length === 0) {
      return noteTab === "recent" ? (
        <EmptyState description={loading ? "加载中…" : "还没有笔记"} />
      ) : (
        <div className="kb-hm-empty">在笔记编辑器右上角可置顶</div>
      );
    }
    return (
      <div ref={notesBodyRef} className="kb-hm-list" role="list" style={{ height: "100%", overflowY: "auto" }}>
        {list.map((note) => {
          const ctxActive = noteCtx.state.payload?.id === note.id;
          return (
            <div
              key={note.id}
              role="listitem"
              className={"kb-hm-nr" + (ctxActive ? " is-ctx" : "")}
              title={`${note.title} · ${note.word_count} 字`}
              onClick={() => navigate(`/notes/${note.id}`)}
              onContextMenu={(e) => {
                e.preventDefault();
                noteCtx.open(e.nativeEvent, note);
              }}
            >
              <div className="kb-nr">
                {noteTab === "pinned" ? (
                  <Pin size={14} style={{ color: token.colorPrimary, flexShrink: 0 }} />
                ) : (
                  <NoteTypeIcon isDaily={note.is_daily} noteType={note.note_type} />
                )}
                <Text ellipsis style={{ fontSize: 13.5, flex: 1, minWidth: 0 }}>
                  {note.title}
                </Text>
                <time className="kb-hm-time">{relativeTime(note.updated_at)}</time>
              </div>
            </div>
          );
        })}
        {remaining > 0 && (
          <div className="kb-hm-more">
            <button type="button" onClick={() => navigate("/notes")}>
              + 还有 {remaining} 篇…
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderWriting = () => (
    <div style={{ height: "100%", overflowY: "auto" }}>
      {/* 统计指标已移到卡片标题栏，正文只留年度热力图 */}
      <WritingHeatmap trend={trend} onSelectDay={handleSelectDay} />
      <Popover
        open={!!dayPick}
        onOpenChange={(o) => {
          if (!o) setDayPick(null);
        }}
        trigger="click"
        placement="top"
        title={dayPick ? `${dayPick.date} 写过的笔记` : ""}
        content={
          <div className="kb-day-notes">
            {!dayNotes ? (
              <div className="kb-hm-empty">加载中…</div>
            ) : dayNotes.notes.length === 0 ? (
              <div className="kb-hm-empty">
                {dayNotes.hidden_count > 0 ? "这天只编辑过隐藏笔记" : "这天的笔记后来又改过，已算到更晚的日期"}
              </div>
            ) : (
              <ul className="kb-hm-list">
                {dayNotes.notes.map((n) => (
                  <li
                    key={n.id}
                    className="kb-hm-nr"
                    onClick={() => {
                      setDayPick(null);
                      navigate(`/notes/${n.id}`);
                    }}
                  >
                    <NoteTypeIcon isDaily={n.is_daily} noteType={n.note_type} />
                    <Text ellipsis style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                      {n.title || "无标题"}
                    </Text>
                    <time className="kb-hm-time">{n.word_count.toLocaleString()} 字</time>
                  </li>
                ))}
              </ul>
            )}
            {dayNotes && dayNotes.hidden_count > 0 && dayNotes.notes.length > 0 && (
              <div className="kb-day-notes-foot">另有 {dayNotes.hidden_count} 篇隐藏笔记</div>
            )}
          </div>
        }
      >
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: dayPick?.rect.left ?? 0,
            top: dayPick?.rect.top ?? 0,
            width: dayPick?.rect.width ?? 0,
            height: dayPick?.rect.height ?? 0,
            pointerEvents: "none",
          }}
        />
      </Popover>
    </div>
  );

  const renderAi = () => (
    <div>
      <Input
        className="kb-ask-in"
        placeholder="基于你的笔记回答，回答附出处…"
        value={aiQuestion}
        onChange={(e) => setAiQuestion(e.target.value)}
        onPressEnter={handleAskAi}
        suffix={
          <Button
            type="primary"
            size="small"
            className="kb-ask-send"
            icon={<Send size={13} />}
            disabled={!aiQuestion.trim()}
            onClick={handleAskAi}
          />
        }
      />
      <div className="kb-ask-sugs">
        {ASK_AI_SUGGESTIONS.map((q) => (
          <button key={q} type="button" onClick={() => setAiQuestion(q)}>
            {q}
          </button>
        ))}
      </div>
      {recentChats.length > 0 ? (
        <ul className="kb-hm-list kb-ask-chats">
          {recentChats.map((chat) => (
            <li key={chat.id} className="kb-hm-nr is-sm" onClick={() => navigate(`/ai?cid=${chat.id}`)}>
              <MessageCircle size={13} style={{ flexShrink: 0, color: "var(--kb-text-tertiary)" }} />
              <span className="kb-hm-td-tx">{chat.title || "未命名会话"}</span>
              <time className="kb-hm-time">{relativeTime(chat.updated_at)}</time>
            </li>
          ))}
        </ul>
      ) : (
        <Text type="secondary" style={{ fontSize: 11 }}>
          输入问题回车直接发送,自动新建对话
        </Text>
      )}
    </div>
  );

  const renderWidgetContent = (id: HomeWidgetId) => {
    switch (id) {
      case "quick-note":
        return renderQuickNote();
      case "todo":
        return renderTodo();
      case "recent":
        return renderNotes();
      case "writing-stat":
        return renderWriting();
      case "ai":
        return renderAi();
      default:
        return null;
    }
  };

  const widgetChrome = (id: HomeWidgetId) => {
    const w = widgets.find((x) => x.id === id)!;
    return {
      collapsed: collapsed[id] ?? false,
      onToggle: () => toggleCollapse(id),
      colSpan: w.colSpan,
      heightLevel: w.heightLevel,
      onColSpanChange: (s: typeof w.colSpan) => setColSpan(id, s),
      onHeightChange: (h: typeof w.heightLevel) => setHeight(id, h),
    };
  };

  const widgetBodyStyle = (id: HomeWidgetId) => {
    switch (id) {
      case "quick-note":
        return { padding: "8px 16px 10px" };
      case "todo":
      case "recent":
        return { padding: "0 8px 8px" };
      case "writing-stat":
        // 指标已进标题栏，正文只剩热力图，上下收紧
        return { padding: "8px 14px 10px" };
      case "ai":
        return { padding: "12px 14px" };
      default:
        return undefined;
    }
  };

  const renderWidgetHeader = (id: HomeWidgetId) => {
    switch (id) {
      case "quick-note":
        return {
          title: (
            <span className="flex items-center gap-2">
              <span className="kb-cico sm" style={{ color: token.colorPrimary }}>
                <PencilLine size={14} />
              </span>
              <b style={{ fontSize: 14 }}>随手记</b>
              <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {dailyEnabled ? "先记下来，再决定放哪儿" : "第一行作标题，存成一篇新笔记"}
              </Text>
            </span>
          ),
          extra: dailyEnabled ? (
            <button type="button" className="kb-lnk kb-quick-daily" onClick={handleTodayNote}>
              <CalendarDays size={12} />
              今天的日记 · {todayDailyWords == null ? "未开始" : `${todayDailyWords.toLocaleString()} 字`}
              <ChevronRight size={12} />
            </button>
          ) : undefined,
        };
      case "todo":
        return {
          title: (
            <span className="flex items-center gap-2">
              <CheckSquare size={14} style={{ color: token.colorSuccess }} />
              待办
              {totalTodoCount > 0 && <span className="kb-card-n">共 {totalTodoCount} 条</span>}
            </span>
          ),
          extra: (
            <button type="button" className="kb-lnk" onClick={() => navigate("/tasks")}>
              全部待办
              <ChevronRight size={12} />
            </button>
          ),
        };
      case "recent":
        return {
          title: (
            <span className="flex items-center gap-2">
              <NotebookText size={14} style={{ color: token.colorPrimary }} />
              <Segmented
                size="small"
                value={noteTab}
                onChange={(v) => setNoteTab(v as "recent" | "pinned")}
                options={[
                  { label: "最近编辑", value: "recent" },
                  {
                    label: (
                      <span className="inline-flex items-center gap-1">
                        <Pin size={12} />
                        置顶{pinnedNotes.length > 0 ? ` ${pinnedNotes.length}` : ""}
                      </span>
                    ),
                    value: "pinned",
                  },
                ]}
              />
              {notesTotal > 0 && <span className="kb-card-n">共 {notesTotal} 篇</span>}
            </span>
          ),
          extra: (
            <button type="button" className="kb-lnk" onClick={() => navigate("/notes")}>
              全部笔记
              <ChevronRight size={12} />
            </button>
          ),
        };
      case "writing-stat": {
        const wordsShort =
          vitalityMetrics.totalWords >= 10000
            ? (vitalityMetrics.totalWords / 10000).toFixed(1)
            : vitalityMetrics.totalWords.toLocaleString();
        const wordsSuffix = vitalityMetrics.totalWords >= 10000 ? "万字" : "字";
        return {
          // 指标移到标题栏：正文只留热力图，减少内容框高度占用
          title: (
            <span className="kb-write-head">
              <span className="kb-write-title">
                <span className="kb-cico sm is-warn">
                  <Flame size={14} />
                </span>
                <b style={{ fontSize: 14 }}>写作活力</b>
              </span>
              <span className="kb-write-stats">
                <HeaderStat value={vitalityMetrics.totalNotes} label="笔记总数" />
                <HeaderStat
                  value={wordsShort}
                  suffix={wordsSuffix}
                  label="总字数"
                  title={`${vitalityMetrics.totalWords.toLocaleString()} 字`}
                />
                <HeaderStat value={vitalityMetrics.streak} suffix="天" label="连续写作" />
                <HeaderStat value={vitalityMetrics.lastSinceLabel} label="距上次写作" />
                <HeaderStat
                  value={vitalityMetrics.thisWeekWords.toLocaleString()}
                  suffix="字"
                  label="本周字数"
                  extra={
                    vitalityMetrics.weekDelta != null && (
                      <span
                        className="text-[10px]"
                        style={{
                          color:
                            vitalityMetrics.weekDelta >= 0
                              ? token.colorSuccess
                              : token.colorError,
                        }}
                      >
                        {vitalityMetrics.weekDelta >= 0 ? "▲" : "▼"}
                        {Math.abs(vitalityMetrics.weekDelta)}%
                      </span>
                    )
                  }
                />
              </span>
            </span>
          ),
          extra: (
            <Text type="secondary" style={{ fontSize: 11 }}>
              近一年
            </Text>
          ),
        };
      }
      case "ai":
        return {
          title: (
            <span className="flex items-center gap-2">
              <Bot size={14} style={{ color: token.colorPrimary }} />
              问 AI
            </span>
          ),
          extra: (
            <button type="button" className="kb-lnk" onClick={() => navigate("/ai")}>
              所有会话
              <ChevronRight size={12} />
            </button>
          ),
        };
      default:
        return { title: null, extra: undefined };
    }
  };

  return (
    <div
      className="kb-home"
      style={{ width: "100%", minHeight: "100%", display: "flex", flexDirection: "column" }}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
        {/* ① 页头：日期 + 问候 ｜ 搜索 + 新建笔记 + 重置布局 + 隐私模式 */}
        <div className="kb-home-head">
          <div className="kb-home-greet">
            <div className="kb-home-date">{homeDateLabel(new Date())}</div>
            <h1>
              {greetingFor(new Date().getHours())}，今天写了{" "}
              <span className="kb-home-num">{todayWords.toLocaleString()}</span> 字
            </h1>
          </div>
          <div className="kb-home-tools" data-tour="home-search">
            <div className="kb-home-search">
              <HomeSearchInput
                value={searchKeyword}
                onChange={setSearchKeyword}
                onPressEnter={handleSearch}
              />
            </div>
            <NewNoteButton size="large" />
            <AntTooltip title="重置为默认布局" mouseEnterDelay={0.4}>
              <Button
                size="large"
                type="text"
                className="kb-home-privacy"
                icon={<RotateCcw size={17} />}
                onClick={handleResetLayout}
              />
            </AntTooltip>
            <AntTooltip
              title={privacyMode ? "退出隐私模式 (Ctrl+Shift+H)" : "隐私模式：遮住首页卡片 (Ctrl+Shift+H)"}
            >
              <Button
                size="large"
                type="text"
                className={privacyMode ? "kb-home-privacy is-on" : "kb-home-privacy"}
                icon={privacyMode ? <EyeOff size={17} /> : <Eye size={17} />}
                onClick={() => useHomeWidgetsStore.getState().togglePrivacyMode()}
              />
            </AntTooltip>
          </div>
        </div>

        {/* ②-⑤ 可拖拽排序 + 可调宽高 + 可折叠的 Widget 区 */}
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={visibleWidgetIds} strategy={rectSortingStrategy}>
            <div
              className="grid grid-cols-12 gap-3"
              style={{ gridAutoRows: `${WIDGET_ROW_HEIGHT}px` }}
            >
              {visibleWidgets.map((w) => {
                const isCollapsed = collapsed[w.id] ?? false;
                // Tailwind 4 不能扫描动态拼接的类名，必须用静态映射
                const COL_CLASS: Record<number, string> = {
                  4: "col-span-4",
                  6: "col-span-6",
                  8: "col-span-8",
                  12: "col-span-12",
                };
                const colSpanClass = COL_CLASS[COL_SPAN_MAP[w.colSpan]] ?? "col-span-12";
                // 折叠时只占一行；展开时按高度档位跨行
                const rowSpan = isCollapsed ? 1 : ROW_SPAN_MAP[w.heightLevel];
                const header = renderWidgetHeader(w.id);
                const chrome = widgetChrome(w.id);

                return (
                  <div
                    key={w.id}
                    className={colSpanClass}
                    data-tour={`home-widget-${w.id}`}
                    style={{ gridRow: `span ${rowSpan}` }}
                  >
                    <SortableWidget id={w.id}>
                      {({ dragHandleProps }) => (
                        <HomeWidget
                          id={w.id}
                          title={header.title}
                          extra={header.extra}
                          bodyStyle={widgetBodyStyle(w.id)}
                          dragHandleProps={dragHandleProps}
                          collapsed={chrome.collapsed}
                          onToggle={chrome.onToggle}
                          colSpan={chrome.colSpan}
                          heightLevel={chrome.heightLevel}
                          onColSpanChange={chrome.onColSpanChange}
                          onHeightChange={chrome.onHeightChange}
                        >
                          {renderWidgetContent(w.id)}
                        </HomeWidget>
                      )}
                    </SortableWidget>
                  </div>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* 待办详情弹窗 — 只读视图 + 标记完成 + 子任务 + 编辑入口 */}
      <TaskDetailModal
        task={taskDetail}
        onClose={() => setTaskDetail(null)}
        onToggleStatus={(id) => void handleToggleTask(id)}
        onSubtaskChanged={(id, done, total) => {
          patchTask(id, { subtask_done: done, subtask_total: total });
        }}
        onEdit={(t) => setEditingTask(t)}
      />
      {/* 待办快速添加里粘了截图 → 完整新建弹窗（截图已在附件条里） */}
      <CreateTaskModal
        open={!!todoPasteDraft}
        presetTitle={todoPasteDraft?.title}
        presetFiles={todoPasteDraft?.files}
        presetDueDate={todayYmd()}
        onClose={() => setTodoPasteDraft(null)}
        onSaved={() => {
          setTodoPasteDraft(null);
          setQuickTodo("");
          setTodoTab("today");
          refreshTaskStats();
          void loadDashboard();
        }}
      />
      {/* 详情 Modal 点「编辑」→ CreateTaskModal 编辑态；保存后重拉首页数据 */}
      <CreateTaskModal
        open={!!editingTask}
        editing={editingTask}
        onClose={() => setEditingTask(null)}
        onSaved={() => {
          setEditingTask(null);
          void loadDashboard();
        }}
        onSubtaskChanged={(done, total) => {
          if (!editingTask) return;
          patchTask(editingTask.id, {
            subtask_done: done,
            subtask_total: total,
          });
        }}
      />

      {/* 最近笔记右键菜单 */}
      <ContextMenuOverlay
        open={!!noteCtx.state.payload}
        x={noteCtx.state.x}
        y={noteCtx.state.y}
        items={noteMenuItems}
        onClose={noteCtx.close}
      />

      {/* 今日待办右键菜单 */}
      <ContextMenuOverlay
        open={!!taskCtx.state.payload}
        x={taskCtx.state.x}
        y={taskCtx.state.y}
        items={taskMenuItems}
        onClose={taskCtx.close}
      />
    </div>
  );
}

/** 写作活力：标题栏里的紧凑指标（数字 + 小字说明） */
function HeaderStat({
  value,
  suffix,
  label,
  extra,
  title,
}: {
  value: React.ReactNode;
  suffix?: string;
  label: string;
  extra?: React.ReactNode;
  /** 悬停提示：数字被换算（如「万字」）时放原值 */
  title?: string;
}) {
  return (
    <span className="kb-write-stat" title={title}>
      <span className="kb-write-stat-v">
        {value}
        {suffix && <small>{suffix}</small>}
        {extra && <span className="ml-1">{extra}</span>}
      </span>
      <span className="kb-write-stat-l">{label}</span>
    </span>
  );
}

// ─── 移动端 Wrapper（T-M008）─────────────────────────
import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileHome } from "./MobileHome";

/**
 * Wrapper：根据视口/平台决定渲染桌面版 or 移动版。
 * 注意：必须用 wrapper 模式而不是函数体内 early-return，
 * 否则 React Hooks 顺序会因平台不同而变化（违反 Hooks 规则）。
 */
export default function HomePage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileHome /> : <DesktopHomePage />;
}
