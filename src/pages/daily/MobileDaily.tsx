import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Edit3,
  CheckSquare,
} from "lucide-react";
import { message } from "antd";
import { dailyApi, taskApi } from "@/lib/api";
import type { Note, Task } from "@/types";

/**
 * 移动端每日笔记页（设计稿：04-daily.html）
 *
 * 路由 /daily —— isMobile=true 时通过 wrapper 加载本组件。
 *
 * 功能：
 * - 顶栏：返回 + 「每日笔记」 + 设置（占位）
 * - 月份切换：上/下个月，标题"YYYY 年 M 月"
 * - 7×N 日历网格：周日开头；当月有日记的日期高亮蓝色；今天用粗框
 * - 点击格子：getOrCreate 当日日记 → 跳 /notes/:id 编辑
 * - 选中日期下方显示该日文档预览 + "继续编辑"按钮
 *
 * MVP 不做：
 * - 30 天写作热力图深浅四档（设计稿那个右下角图例）
 * - 「设置」面板（暂占位）
 */

type DateStr = string; // "2026-05-04"

function formatDate(d: Date): DateStr {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function MobileDaily() {
  const navigate = useNavigate();
  const today = new Date();
  const todayStr = formatDate(today);

  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-12
  const [selected, setSelected] = useState<DateStr>(todayStr);
  const [datesWithNote, setDatesWithNote] = useState<Set<DateStr>>(new Set());
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [loadingNote, setLoadingNote] = useState(false);
  const [todayTasks, setTodayTasks] = useState<Task[]>([]);

  const loadMonth = useCallback(async (y: number, m: number) => {
    try {
      const dates = await dailyApi.listDates(y, m);
      setDatesWithNote(new Set(dates));
    } catch (e) {
      console.error("[MobileDaily] listDates failed:", e);
    }
  }, []);

  const loadDay = useCallback(async (date: DateStr) => {
    setLoadingNote(true);
    try {
      const n = await dailyApi.get(date);
      setSelectedNote(n);
    } catch (e) {
      console.error("[MobileDaily] get failed:", e);
      setSelectedNote(null);
    } finally {
      setLoadingNote(false);
    }
  }, []);

  useEffect(() => {
    void loadMonth(year, month);
  }, [year, month, loadMonth]);

  useEffect(() => {
    void loadDay(selected);
  }, [selected, loadDay]);

  // 今日待办速览：未完成且截止日期落在今天
  useEffect(() => {
    let alive = true;
    taskApi
      .list({ status: 0 })
      .then((list) => {
        if (!alive) return;
        setTodayTasks(
          list
            .filter((t) => (t.due_date ?? "").slice(0, 10) === todayStr)
            .slice(0, 5),
        );
      })
      .catch(() => {
        if (alive) setTodayTasks([]);
      });
    return () => {
      alive = false;
    };
  }, [todayStr]);

  function prevMonth() {
    if (month === 1) {
      setYear(year - 1);
      setMonth(12);
    } else {
      setMonth(month - 1);
    }
  }
  function nextMonth() {
    if (month === 12) {
      setYear(year + 1);
      setMonth(1);
    } else {
      setMonth(month + 1);
    }
  }

  async function openSelectedDay() {
    try {
      const note = await dailyApi.getOrCreate(selected);
      navigate(`/notes/${note.id}`);
    } catch (e) {
      message.error(`打开失败: ${e}`);
    }
  }

  // 计算当月日历格子（含上月尾 + 本月 + 下月头）
  const firstDay = new Date(year, month - 1, 1);
  const firstWeekday = firstDay.getDay(); // 0=周日
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: { date: DateStr; day: number; inMonth: boolean }[] = [];
  // 上月尾
  for (let i = firstWeekday - 1; i >= 0; i--) {
    const d = new Date(year, month - 1, -i);
    cells.push({
      date: formatDate(d),
      day: d.getDate(),
      inMonth: false,
    });
  }
  // 当月
  for (let i = 1; i <= daysInMonth; i++) {
    cells.push({
      date: formatDate(new Date(year, month - 1, i)),
      day: i,
      inMonth: true,
    });
  }
  // 下月头补齐到 6 行（42 格）— 视觉稳定
  while (cells.length < 42) {
    const d = new Date(year, month - 1, daysInMonth + (cells.length - daysInMonth - firstWeekday + 1));
    cells.push({
      date: formatDate(d),
      day: d.getDate(),
      inMonth: false,
    });
  }

  const selectedDate = new Date(selected);
  const selectedLabel = `${selected} ${WEEKDAYS[selectedDate.getDay()] === "日" ? "周日" : "周" + WEEKDAYS[selectedDate.getDay()]}`;
  const isToday = selected === todayStr;

  return (
    <div className="text-[var(--m-ink-1)]">
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-[var(--m-line)] bg-[var(--m-surface)] px-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-[var(--m-ink-2)]" />
        </button>
        <h1 className="text-base font-semibold text-[var(--m-ink-1)]">日记</h1>
        <span className="h-10 w-10" aria-hidden />
      </header>

      {/* 月份切换 */}
      <div className="flex items-center justify-between border-b border-[var(--m-line)] bg-[var(--m-surface)] px-4 pt-3 pb-2">
        <button
          onClick={prevMonth}
          aria-label="上个月"
          className="flex h-9 w-9 items-center justify-center rounded-lg active:bg-[var(--m-well)]"
        >
          <ChevronLeft size={20} className="text-[var(--m-ink-2)]" />
        </button>
        <div className="text-base font-semibold">
          {year} 年 {month} 月
        </div>
        <button
          onClick={nextMonth}
          aria-label="下个月"
          className="flex h-9 w-9 items-center justify-center rounded-lg active:bg-[var(--m-well)]"
        >
          <ChevronRight size={20} className="text-[var(--m-ink-2)]" />
        </button>
      </div>

      {/* 日历 */}
      <div className="bg-[var(--m-surface)] px-3 pb-4">
        <div className="mb-1.5 grid grid-cols-7 text-center text-xs text-[var(--m-ink-3)]">
          {WEEKDAYS.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((c) => {
            const has = datesWithNote.has(c.date);
            const isSelected = c.date === selected;
            const isTodayCell = c.date === todayStr;
            return (
              <button
                key={c.date + (c.inMonth ? "" : "-out")}
                onClick={() => setSelected(c.date)}
                className={`flex h-9 items-center justify-center rounded-lg text-sm transition-colors ${
                  !c.inMonth
                    ? "text-[var(--m-ink-3)]"
                    : isSelected
                      ? "bg-[var(--m-primary)] text-[var(--m-on-primary)] font-bold"
                      : has
                        ? "bg-[var(--m-tint-primary)] text-[var(--m-primary)] font-semibold"
                        : isTodayCell
                          ? "border border-[var(--m-primary)] text-[var(--m-primary)] font-semibold"
                          : "text-[var(--m-ink-2)] active:bg-[var(--m-well)]"
                }`}
              >
                {c.day}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5 text-xs text-[var(--m-ink-3)]">
          <span>无</span>
          <div className="h-3 w-3 rounded bg-[var(--m-well)]" />
          <div className="h-3 w-3 rounded bg-[var(--m-tint-primary)]" />
          <div className="h-3 w-3 rounded bg-[var(--m-primary)]" />
          <span>当前</span>
        </div>
      </div>

      {/* 选中日的文档预览 */}
      <div className="bg-[var(--m-page)] px-4 py-3 pb-24">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--m-ink-1)]">
            {selectedLabel}
            {isToday && (
              <span className="ml-2 rounded bg-[var(--m-tint-primary)] px-1.5 py-0.5 text-xs text-[var(--m-primary)]">
                今天
              </span>
            )}
          </h2>
          {selectedNote && (
            <span className="text-xs text-[var(--m-ink-3)]">
              {selectedNote.word_count} 字
            </span>
          )}
        </div>

        {loadingNote ? (
          <div className="rounded-2xl bg-[var(--m-surface)] p-4 text-center text-sm text-[var(--m-ink-3)] shadow-sm">
            加载中…
          </div>
        ) : selectedNote ? (
          <div className="rounded-2xl bg-[var(--m-surface)] p-4 shadow-sm">
            <div className="text-sm leading-relaxed text-[var(--m-ink-2)] whitespace-pre-wrap line-clamp-12">
              {selectedNote.content || (
                <span className="italic text-[var(--m-ink-3)]">空白</span>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl bg-[var(--m-surface)] p-6 text-center shadow-sm">
            <div className="text-sm text-[var(--m-ink-2)]">这一天还没有日记</div>
            <div className="mt-1 text-xs text-[var(--m-ink-3)]">
              点击下方按钮开始记录
            </div>
          </div>
        )}

        {todayTasks.length > 0 && (
          <div className="mt-3 rounded-2xl bg-[var(--m-surface)] p-4">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 font-medium text-[var(--m-ink-3)]">
                <CheckSquare size={13} /> 今日待办 · {todayTasks.length}
              </span>
              <button
                onClick={() => navigate("/tasks")}
                className="text-[var(--m-primary)]"
              >
                全部 →
              </button>
            </div>
            <div className="flex flex-col">
              {todayTasks.map((t) => (
                <button
                  key={t.id}
                  onClick={() => navigate(`/task-detail/${t.id}`)}
                  className="flex items-center gap-2 py-1.5 text-left text-sm text-[var(--m-ink-1)] active:opacity-70"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--m-warning)]" />
                  <span className="truncate">{t.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={openSelectedDay}
          className="mt-3 flex h-11 w-full items-center justify-center rounded-xl bg-[var(--m-primary)] font-medium text-[var(--m-on-primary)] active:scale-[0.98] transition-transform"
        >
          <Edit3 size={16} className="mr-1.5" />
          {selectedNote ? "继续编辑" : "开始记录"}当天日记
        </button>
      </div>
    </div>
  );
}
