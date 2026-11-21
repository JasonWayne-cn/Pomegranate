/**
 * Office 工作台状态：文档会话元数据 + 最近文件。
 *
 * 重对象（Worker、渲染场景、字节）不进 Zustand，放在页面的 runtime Map 里；
 * 这里只存可序列化的元数据，避免全局状态被大对象撑爆。
 */
import { create } from "zustand";
import type { OfficeFormat } from "@/lib/office/formats";

export interface OfficeSessionMeta {
  id: string;
  path: string;
  name: string;
  format: OfficeFormat;
  status: "loading" | "ready" | "error";
  error?: string;
  dirty: boolean;
  saving: boolean;
  pageCount?: number;
  /** 来自只读挂载：允许编辑但不能保存回原文件 */
  readOnly?: boolean;
}

export interface RecentFile {
  path: string;
  name: string;
  format: OfficeFormat;
  at: number;
}

const RECENT_KEY = "office.recentFiles";
const MAX_RECENT = 12;

/** 去重（按 path）+ 置顶 + 截断；纯函数便于单测。 */
export function mergeRecent(list: RecentFile[], entry: RecentFile): RecentFile[] {
  return [entry, ...list.filter((item) => item.path !== entry.path)].slice(0, MAX_RECENT);
}

function loadRecent(): RecentFile[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentFile =>
        !!item &&
        typeof item === "object" &&
        typeof (item as RecentFile).path === "string" &&
        typeof (item as RecentFile).name === "string" &&
        typeof (item as RecentFile).format === "string",
    );
  } catch {
    return [];
  }
}

function persistRecent(list: RecentFile[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 存储失败不影响使用 */
  }
}

interface OfficeStore {
  sessions: OfficeSessionMeta[];
  activeId: string | null;
  recent: RecentFile[];

  addSession: (meta: OfficeSessionMeta) => void;
  updateSession: (id: string, patch: Partial<OfficeSessionMeta>) => void;
  removeSession: (id: string) => void;
  setActive: (id: string | null) => void;

  addRecent: (entry: Omit<RecentFile, "at">) => void;
  removeRecent: (path: string) => void;
  /** 清空全部最近文件记录 */
  clearRecent: () => void;
}

export const useOfficeStore = create<OfficeStore>((set) => ({
  sessions: [],
  activeId: null,
  recent: loadRecent(),

  addSession: (meta) =>
    set((state) => ({ sessions: [...state.sessions, meta], activeId: meta.id })),

  updateSession: (id, patch) =>
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),

  removeSession: (id) =>
    set((state) => {
      const index = state.sessions.findIndex((item) => item.id === id);
      const sessions = state.sessions.filter((item) => item.id !== id);
      let activeId = state.activeId;
      if (activeId === id) {
        const next = sessions[Math.min(index, sessions.length - 1)];
        activeId = next?.id ?? null;
      }
      return { sessions, activeId };
    }),

  setActive: (id) => set({ activeId: id }),

  addRecent: (entry) =>
    set((state) => {
      const recent = mergeRecent(state.recent, { ...entry, at: Date.now() });
      persistRecent(recent);
      return { recent };
    }),

  removeRecent: (path) =>
    set((state) => {
      const recent = state.recent.filter((item) => item.path !== path);
      persistRecent(recent);
      return { recent };
    }),

  clearRecent: () =>
    set(() => {
      try {
        localStorage.removeItem(RECENT_KEY);
      } catch {
        /* 存储清理失败不影响内存状态 */
      }
      return { recent: [] };
    }),
}));
