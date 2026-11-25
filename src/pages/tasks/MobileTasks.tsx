import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Modal, message } from "antd";
import {
  Search,
  X,
  Flame,
  Calendar,
  Plus,
  CheckCircle2,
  Circle,
  Pencil,
  Trash2,
} from "lucide-react";
import { taskApi } from "@/lib/api";
import type { Task } from "@/types";
import { useLongPress } from "@/hooks/useLongPress";
import { ActionSheet, type ActionSheetItem } from "@/components/mobile/ActionSheet";
import { TaskCreateSheet } from "@/components/mobile/TaskCreateSheet";
import { SwipeRow } from "@/components/mobile/SwipeRow";

/**
 * 移动端待办（设计稿：08-tasks.html）
 *
 * 结构：
 * - 顶栏：标题 + 统计 + 搜索/过滤
 * - 分类 chips（暂用静态：全部/今日/本周/已完成）
 * - 今日组（红色高亮）+ 本周组 + 已完成组
 * - 每条任务：checkbox + 标题 + 元信息（截止时间、优先级标识）
 *
 * 暂不实现：子任务展开、详情弹窗、批量编辑
 * 这些走 T-M010 任务详情页（独立路由 /tasks/:id 后续做）
 *
 * 新建：右下 FAB → TaskCreateSheet（本页自带 FAB，MobileLayout 的 PAGES_WITH_OWN_FAB
 * 已把 /tasks 排除在全局 + FAB 之外，避免两个悬浮按钮重叠）。
 * /quick-create 的「新建任务」跳 `/tasks?new=1`，落地即自动弹出新建面板。
 */

type GroupKey = "today" | "week" | "done";

export function MobileTasks() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<GroupKey | "all">("all");
  // 长按唤起的动作面板
  const [sheetTask, setSheetTask] = useState<Task | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [keyword, setKeyword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // status=0 todo + status=1 done 都拉，前端按时间分组
      const [todo, done] = await Promise.all([
        taskApi.list({ status: 0 }).catch(() => [] as Task[]),
        taskApi.list({ status: 1 }).catch(() => [] as Task[]),
      ]);
      setTasks([...todo, ...done.slice(0, 20)]); // 已完成只取最近 20 条
    } catch (e) {
      console.error("[MobileTasks] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 从 /quick-create 带 ?new=1 进来 → 直接弹新建面板，并把参数消费掉
  // （否则返回本页 / 刷新时会重复弹）
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // 分组
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const next7End = new Date(todayEnd);
  next7End.setDate(next7End.getDate() + 7);

  // 本地关键词过滤（标题 + 备注）；移动端不走后端全文搜索，列表本身已是全量拉取
  const kw = keyword.trim().toLowerCase();
  const visibleTasks = kw
    ? tasks.filter(
        (t) =>
          t.title.toLowerCase().includes(kw) ||
          (t.description ?? "").toLowerCase().includes(kw),
      )
    : tasks;

  const todoTasks = visibleTasks.filter((t) => t.status === 0);
  const doneTasks = visibleTasks.filter((t) => t.status === 1);
  const todayTasks = todoTasks.filter((t) => {
    if (!t.due_date) return false;
    return new Date(t.due_date).getTime() <= todayEnd.getTime();
  });
  const weekTasks = todoTasks.filter((t) => {
    if (!t.due_date) return false;
    const d = new Date(t.due_date).getTime();
    return d > todayEnd.getTime() && d <= next7End.getTime();
  });
  const noDateTasks = todoTasks.filter((t) => !t.due_date);

  const stats = {
    today: todayTasks.length,
    week: weekTasks.length,
    done: doneTasks.length,
    all: todoTasks.length,
  };

  // 切换状态。未完成的循环任务勾选 = 完成本次（推进到下一次），与桌面端一致；
  // 直接 toggleStatus 会把整条循环标成完成，以后再也不会出现。
  async function toggleTask(task: Task) {
    try {
      if (task.status === 0 && task.repeat_kind !== "none") {
        await taskApi.completeOccurrence(task.id);
        message.success("已完成本次，已推进到下一次");
      } else {
        await taskApi.toggleStatus(task.id);
      }
      await load();
    } catch (e) {
      console.error("toggle task failed:", e);
    }
  }

  // 删除任务（永久，无回收站 → 二次确认）
  function confirmDeleteTask(task: Task) {
    Modal.confirm({
      title: `删除「${task.title}」？`,
      content: "任务删除后不可恢复。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await taskApi.delete(task.id);
          message.success("已删除");
          await load();
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  }

  // 长按动作面板操作项
  const sheetItems: ActionSheetItem[] = sheetTask
    ? [
        {
          key: "toggle",
          label: sheetTask.status === 1 ? "标记为未完成" : "标记为完成",
          icon:
            sheetTask.status === 1 ? (
              <Circle size={20} />
            ) : (
              <CheckCircle2 size={20} />
            ),
          onClick: () => toggleTask(sheetTask),
        },
        {
          key: "edit",
          label: "编辑详情",
          icon: <Pencil size={20} />,
          onClick: () => navigate(`/task-detail/${sheetTask.id}`),
        },
        {
          key: "delete",
          label: "删除",
          icon: <Trash2 size={20} />,
          danger: true,
          onClick: () => confirmDeleteTask(sheetTask),
        },
      ]
    : [];

  return (
    <div className="text-[var(--m-ink-1)]">
      {/* 顶栏 */}
      <div className="bg-[var(--m-surface)] px-4 pt-3 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[var(--m-ink-1)]">待办</h1>
            <div className="mt-0.5 text-xs text-[var(--m-ink-3)]">
              今日 {stats.today} 项 · 本周 {stats.week} 项 · 已完成 {stats.done}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              aria-label={searchOpen ? "关闭搜索" : "搜索"}
              onClick={() => {
                setSearchOpen((v) => !v);
                if (searchOpen) setKeyword("");
              }}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--m-well)] active:bg-slate-200"
            >
              {searchOpen ? (
                <X size={18} className="text-[var(--m-ink-2)]" />
              ) : (
                <Search size={18} className="text-[var(--m-ink-2)]" />
              )}
            </button>
          </div>
        </div>

        {/* 搜索框（点顶栏放大镜展开）—— 本地过滤，不发请求 */}
        {searchOpen && (
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索待办标题 / 备注"
            className="mt-3 w-full rounded-xl bg-[var(--m-well)] px-4 py-2.5 text-sm text-[var(--m-ink-1)] outline-none placeholder:text-[var(--m-ink-3)]"
          />
        )}

        {/* 分类 chips */}
        <div className="m-scroll-x mt-3 flex gap-2 -mx-4 px-4 pb-1">
          <Chip
            active={activeTab === "all"}
            onClick={() => setActiveTab("all")}
            label={`所有 ${stats.all}`}
          />
          <Chip
            active={activeTab === "today"}
            onClick={() => setActiveTab("today")}
            label={`⏰ 今日 ${stats.today}`}
            activeColor="bg-[var(--m-tint-danger)] text-[var(--m-danger)]"
          />
          <Chip
            active={activeTab === "week"}
            onClick={() => setActiveTab("week")}
            label={`📅 本周 ${stats.week}`}
            activeColor="bg-[var(--m-tint-warning)] text-[var(--m-warning)]"
          />
          <Chip
            active={activeTab === "done"}
            onClick={() => setActiveTab("done")}
            label={`✅ 已完成 ${stats.done}`}
            activeColor="bg-[var(--m-tint-success)] text-[var(--m-success)]"
          />
        </div>
      </div>

      {/* 列表 */}
      <div className="bg-[var(--m-page)] pb-24">
        {loading && tasks.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--m-ink-3)]">
            加载中...
          </div>
        ) : todoTasks.length === 0 && doneTasks.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-[var(--m-ink-3)]">
            {kw ? (
              <>
                <Search size={40} className="text-[var(--m-ink-3)]" />
                <span className="text-sm">没有匹配「{keyword.trim()}」的待办</span>
              </>
            ) : (
              <>
                <Plus size={40} className="text-[var(--m-ink-3)]" />
                <span className="text-sm">暂无待办，享受当下 ✨</span>
                <button
                  onClick={() => setCreateOpen(true)}
                  className="mt-2 rounded-full bg-[var(--m-primary)] px-5 py-2 text-sm font-medium text-[var(--m-on-primary)] active:opacity-80"
                >
                  添加第一条
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            {/* 今日 */}
            {(activeTab === "all" || activeTab === "today") &&
              todayTasks.length > 0 && (
                <>
                  <SectionHeader
                    icon={<Flame size={14} className="text-[var(--m-danger)]" />}
                    text={`今日 · ${todayTasks.length} 项`}
                    color="text-[var(--m-danger)]"
                  />
                  <Group tasks={todayTasks} onToggle={toggleTask} onDelete={confirmDeleteTask} onOpen={(t) => navigate(`/task-detail/${t.id}`)} onLongPress={setSheetTask} />
                </>
              )}

            {/* 本周 */}
            {(activeTab === "all" || activeTab === "week") &&
              weekTasks.length > 0 && (
                <>
                  <SectionHeader
                    icon={<Calendar size={14} className="text-[var(--m-warning)]" />}
                    text="本周"
                    color="text-[var(--m-warning)]"
                  />
                  <Group tasks={weekTasks} onToggle={toggleTask} onDelete={confirmDeleteTask} onOpen={(t) => navigate(`/task-detail/${t.id}`)} onLongPress={setSheetTask} />
                </>
              )}

            {/* 无截止日期 */}
            {activeTab === "all" && noDateTasks.length > 0 && (
              <>
                <SectionHeader text={`其它 · ${noDateTasks.length} 项`} />
                <Group tasks={noDateTasks} onToggle={toggleTask} onDelete={confirmDeleteTask} onOpen={(t) => navigate(`/task-detail/${t.id}`)} onLongPress={setSheetTask} />
              </>
            )}

            {/* 已完成 */}
            {(activeTab === "all" || activeTab === "done") &&
              doneTasks.length > 0 && (
                <>
                  <SectionHeader text={`已完成 · ${doneTasks.length} 项`} />
                  <Group tasks={doneTasks} onToggle={toggleTask} onDelete={confirmDeleteTask} onOpen={(t) => navigate(`/task-detail/${t.id}`)} onLongPress={setSheetTask} faded />
                </>
              )}
          </>
        )}
      </div>

      {/* 新建 FAB（本页自带，全局 FAB 在 /tasks 下已被 MobileLayout 隐藏） */}
      <button
        onClick={() => setCreateOpen(true)}
        aria-label="新建待办"
        className="fixed right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--m-primary)] text-[var(--m-on-primary)] shadow-[0_8px_24px_var(--kb-primary-light)] active:scale-95 transition-transform"
        style={{
          bottom: `calc(64px + env(safe-area-inset-bottom, 0px) + 16px)`,
        }}
      >
        <Plus size={28} strokeWidth={2.5} />
      </button>

      {/* 长按任务唤起的底部操作面板 */}
      <ActionSheet
        open={sheetTask !== null}
        title={sheetTask?.title}
        items={sheetItems}
        onClose={() => setSheetTask(null)}
      />

      {/* 新建待办面板 */}
      <TaskCreateSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void load()}
      />
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  activeColor,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  activeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
        active
          ? activeColor || "bg-[var(--m-primary)] text-[var(--m-on-primary)]"
          : "bg-[var(--m-well)] text-[var(--m-ink-2)]"
      }`}
    >
      {label}
    </button>
  );
}

function SectionHeader({
  icon,
  text,
  color = "text-[var(--m-ink-3)]",
}: {
  icon?: React.ReactNode;
  text: string;
  color?: string;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 px-4 pt-3 pb-1 text-xs font-semibold ${color}`}
    >
      {icon}
      <span>{text}</span>
    </div>
  );
}

function Group({
  tasks,
  onToggle,
  onDelete,
  onOpen,
  onLongPress,
  faded,
}: {
  tasks: Task[];
  onToggle: (task: Task) => void;
  onDelete: (task: Task) => void;
  onOpen: (task: Task) => void;
  onLongPress: (task: Task) => void;
  faded?: boolean;
}) {
  return (
    <div className="mx-4 mb-2 divide-y divide-[var(--m-line-weak)] overflow-hidden rounded-2xl bg-[var(--m-surface)]">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          onToggle={onToggle}
          onDelete={onDelete}
          onOpen={onOpen}
          onLongPress={onLongPress}
          faded={faded}
        />
      ))}
    </div>
  );
}

function TaskRow({
  task,
  onToggle,
  onDelete,
  onOpen,
  onLongPress,
  faded,
}: {
  task: Task;
  onToggle: (task: Task) => void;
  onDelete: (task: Task) => void;
  onOpen: (task: Task) => void;
  onLongPress: (task: Task) => void;
  faded?: boolean;
}) {
  const due = task.due_date ? new Date(task.due_date) : null;
  const overdue = due && due.getTime() < Date.now() && task.status === 0;

  // 长按任务文本区唤起动作面板；轻点仍进详情。checkbox 独立不受影响。
  // 长按后紧接的 click 用 firedRef 吞掉，避免「弹面板后手抬起又进详情」。
  const firedRef = useRef(false);
  const longPress = useLongPress(() => {
    firedRef.current = true;
    onLongPress(task);
  });

  return (
    <SwipeRow
      actions={[
        {
          key: "toggle",
          label: task.status === 1 ? "撤销" : "完成",
          icon: task.status === 1 ? <Circle size={18} /> : <CheckCircle2 size={18} />,
          tone: "primary",
          onAction: () => onToggle(task),
        },
        {
          key: "delete",
          label: "删除",
          icon: <Trash2 size={18} />,
          tone: "danger",
          onAction: () => onDelete(task),
        },
      ]}
    >
    <div className={`px-4 py-3 ${faded ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={task.status === 1}
          onChange={() => onToggle(task)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded"
        />
        <div
          {...longPress}
          role="button"
          onTouchStart={() => {
            firedRef.current = false;
          }}
          onClick={() => {
            if (firedRef.current) {
              firedRef.current = false;
              return;
            }
            onOpen(task);
          }}
          className="flex-1 min-w-0 select-none text-left active:opacity-60"
          style={{ WebkitTouchCallout: "none" }}
        >
          <div
            className={`text-sm ${
              task.status === 1
                ? "text-[var(--m-ink-3)] line-through"
                : "font-medium text-[var(--m-ink-1)]"
            }`}
          >
            {task.title}
          </div>
          {(due || task.priority === 0) && (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--m-ink-3)]">
              {task.priority === 0 && (
                <span className="rounded bg-[var(--m-tint-danger)] px-1.5 py-0.5 text-[var(--m-danger)]">
                  紧急
                </span>
              )}
              {due && (
                <span
                  className={
                    overdue ? "font-medium text-[var(--m-danger)]" : "text-[var(--m-ink-3)]"
                  }
                >
                  {overdue ? "⏰ 已逾期 " : "📅 "}
                  {due.toLocaleDateString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                  })}{" "}
                  {due.toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </SwipeRow>
  );
}
