import { create } from "zustand";
import { aiChatApi } from "@/lib/api";
import type { AiConversation } from "@/types";

/**
 * AI 对话列表的跨组件共享状态。
 *
 * 左侧历史会话位于全局 SidePanel（AiPanel）中，右侧问答区在 pages/ai。
 * 两处必须看到同一份列表和同一个选中会话，故把「列表 + 当前会话」提到这里。
 * 不持久化：后端 SQLite 才是 source-of-truth，每次进页面重新拉即可。
 */
interface AiChatStore {
  conversations: AiConversation[];
  activeConvId: number | null;
  setActiveConvId: (id: number | null) => void;
  loadConversations: () => Promise<AiConversation[]>;
  createConversation: () => Promise<AiConversation>;
  deleteConversation: (id: number) => Promise<void>;
  renameConversation: (id: number, title: string) => Promise<void>;
  /** 批量清理：days 不传 = 全清；传 N = 清理 N 天前未活动的对话。返回删除条数 */
  cleanupConversations: (days?: number) => Promise<number>;
  updateConversationModel: (id: number, modelId: number) => Promise<void>;
  updateAgentSettings: (
    id: number,
    maxRounds: number,
    toolTimeout: number,
    mcpEnabled: boolean,
  ) => Promise<void>;
}

export const useAiChatStore = create<AiChatStore>((set, get) => ({
  conversations: [],
  activeConvId: null,

  setActiveConvId: (id) => set({ activeConvId: id }),

  loadConversations: async () => {
    const list = await aiChatApi.listConversations();
    set({ conversations: list });
    return list;
  },

  createConversation: async () => {
    const conv = await aiChatApi.createConversation();
    await get().loadConversations();
    set({ activeConvId: conv.id });
    return conv;
  },

  deleteConversation: async (id) => {
    await aiChatApi.deleteConversation(id);
    const list = await get().loadConversations();
    const current = get().activeConvId;
    if (current === id || (current != null && !list.some((c) => c.id === current))) {
      set({ activeConvId: null });
    }
  },

  renameConversation: async (id, title) => {
    await aiChatApi.renameConversation(id, title);
    // 局部更新避免整列表抖动；后端是 source-of-truth，下一次 list 会校正
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, title } : c,
      ),
    }));
  },

  cleanupConversations: async (days) => {
    const removed = await aiChatApi.deleteConversationsBefore(days);
    const list = await get().loadConversations();
    const current = get().activeConvId;
    if (current != null && !list.some((c) => c.id === current)) {
      set({ activeConvId: null });
    }
    return removed;
  },

  updateConversationModel: async (id, modelId) => {
    await aiChatApi.updateConversationModel(id, modelId);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, model_id: modelId } : c,
      ),
    }));
  },

  updateAgentSettings: async (id, maxRounds, toolTimeout, mcpEnabled) => {
    await aiChatApi.updateAgentSettings(id, maxRounds, toolTimeout, mcpEnabled);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id
          ? {
              ...c,
              agent_max_rounds: maxRounds,
              agent_tool_timeout: toolTimeout,
              agent_mcp_enabled: mcpEnabled,
            }
          : c,
      ),
    }));
  },
}));
