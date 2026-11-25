import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Sparkles,
  BookOpenText,
  ListChecks,
  Languages,
  MessageCircle,
  MessageSquarePlus,
  Plus,
  Link2,
  Share2,
  Download,
  Trash2,
  Pencil,
  Check,
  Plug,
} from "lucide-react";
import { ShareConfigModal } from "@/components/config-share/ShareConfigModal";
import { ImportConfigModal } from "@/components/config-share/ImportConfigModal";
import { exportAiModel, type Envelope } from "@/lib/configShare";
import { message, Modal } from "antd";
import { aiChatApi, aiModelApi } from "@/lib/api";
import type { AiConversation, AiModel } from "@/types";
import { relativeTime } from "@/lib/utils";
import { MobileAiModelModal } from "@/components/ai/MobileAiModelModal";
import { MSheet } from "@/components/mobile/MSheet";

/**
 * 移动端 AI 助手列表页（设计稿：06-ai.html）
 *
 * 结构：
 * - 顶栏：标题"AI 助手" + 当前模型/对话数 + 搜索按钮
 * - 模型 chips 横滑（点击切换 default 模型）
 * - 4 个快捷入口（写作 / 解读 / 任务规划 / 翻译） — 点击 = 用预设 Prompt 创建新对话
 * - 对话历史列表（按 updated_at desc）
 * - 右下 FAB（橙色）= 创建空白对话
 *
 * 跳转：
 * - 点击对话 / FAB / 快捷入口 → 暂走 /ai?conv=ID（桌面 AiChatPage 已支持），
 *   等 MobileAiChat 做完再换 /ai-chat/:id
 */

interface QuickEntry {
  key: string;
  icon: React.ReactNode;
  bg: string;
  label: string;
  /** 创建对话后预填到首条 user 消息的 prompt（暂未实现 prefill，先创建空对话） */
  preset?: string;
}

const QUICK_ENTRIES: QuickEntry[] = [
  {
    key: "write",
    icon: <Sparkles size={20} className="text-[var(--m-accent)]" />,
    bg: "bg-[var(--m-tint-accent)]",
    label: "写作助手",
  },
  {
    key: "read",
    icon: <BookOpenText size={20} className="text-[var(--m-primary)]" />,
    bg: "bg-[var(--m-tint-primary)]",
    label: "解读文档",
  },
  {
    key: "tasks",
    icon: <ListChecks size={20} className="text-[var(--m-success)]" />,
    bg: "bg-[var(--m-tint-success)]",
    label: "任务规划",
  },
  {
    key: "translate",
    icon: <Languages size={20} className="text-[var(--m-accent)]" />,
    bg: "bg-[var(--m-tint-accent)]",
    label: "翻译润色",
  },
];

export function MobileAi() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<AiModel | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [shareEnv, setShareEnv] = useState<Envelope | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [convs, mods] = await Promise.all([
        aiChatApi.listConversations().catch(() => [] as AiConversation[]),
        aiModelApi.list().catch(() => [] as AiModel[]),
      ]);
      setConversations(convs);
      setModels(mods);
    } catch (e) {
      console.error("[MobileAi] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const defaultModel = models.find((m) => m.is_default) ?? models[0];

  async function switchDefaultModel(id: number) {
    try {
      await aiModelApi.setDefault(id);
      await load();
    } catch (e) {
      message.error(`切换失败: ${e}`);
    }
  }

  function openConversation(conv: AiConversation) {
    navigate(`/ai-chat/${conv.id}`);
  }

  async function createNew() {
    try {
      const conv = await aiChatApi.createConversation();
      navigate(`/ai-chat/${conv.id}`);
    } catch (e) {
      message.error(`创建失败: ${e}`);
    }
  }

  function openNewModel() {
    setEditingModel(null);
    setAddModelOpen(true);
  }

  function openEditModel(m: AiModel) {
    setEditingModel(m);
    setAddModelOpen(true);
  }

  async function testModel(m: AiModel) {
    if (testingId != null) return;
    setTestingId(m.id);
    try {
      const r = await aiModelApi.testSaved(m.id);
      if (r.ok) {
        message.success(`连通正常 · ${r.latency_ms}ms`);
      } else {
        message.error("连接失败，请检查地址 / Key");
      }
    } catch (e) {
      message.error(`测试失败: ${e}`);
    } finally {
      setTestingId(null);
    }
  }

  function deleteModel(m: AiModel) {
    Modal.confirm({
      title: `删除模型「${m.name}」？`,
      content: "使用该模型的对话会失去关联模型，之后可在对话里重选。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await aiModelApi.delete(m.id);
          message.success("已删除");
          await load();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  // 会话按「今天 / 昨天 / 更早」分组
  const groupedConversations = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const groups: { label: string; items: AiConversation[] }[] = [
      { label: "今天", items: [] },
      { label: "昨天", items: [] },
      { label: "更早", items: [] },
    ];
    for (const c of conversations) {
      const t = new Date(c.updated_at).getTime();
      if (t >= today.getTime()) groups[0].items.push(c);
      else if (t >= yesterday.getTime()) groups[1].items.push(c);
      else groups[2].items.push(c);
    }
    return groups.filter((g) => g.items.length > 0);
  }, [conversations]);

  return (
    <div className="text-[var(--m-ink-1)]">
      {/* 顶栏 */}
      <div className="bg-[var(--m-surface)] px-4 pt-3 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[var(--m-ink-1)]">AI 助手</h1>
            <div className="mt-0.5 text-xs text-[var(--m-ink-3)]">
              {defaultModel ? defaultModel.name : "未配置模型"} ·{" "}
              {conversations.length} 个对话
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (defaultModel) setShareEnv(exportAiModel(defaultModel, null));
                else message.warning("请先配置一个 AI 模型");
              }}
              aria-label="分享当前模型"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--m-well)] active:opacity-70"
            >
              <Share2 size={18} className="text-[var(--m-ink-2)]" />
            </button>
            <button
              onClick={() => setImportOpen(true)}
              aria-label="导入模型"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--m-well)] active:opacity-70"
            >
              <Download size={18} className="text-[var(--m-ink-2)]" />
            </button>
            <button
              aria-label="搜索"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--m-well)] active:opacity-70"
            >
              <Search size={18} className="text-[var(--m-ink-2)]" />
            </button>
          </div>
        </div>

        {/* 模型 chips */}
        <div className="m-scroll-x mt-3 flex gap-2 -mx-4 px-4 pb-1">
          {models.length === 0 ? (
            <span className="shrink-0 rounded-full bg-[var(--m-well)] px-3 py-1.5 text-sm text-[var(--m-ink-3)]">
              请到 设置 → AI 模型 添加
            </span>
          ) : (
            models.map((m) => (
              <button
                key={m.id}
                onClick={() => switchDefaultModel(m.id)}
                className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
                  m.is_default
                    ? "border border-[var(--m-accent)] bg-[var(--m-tint-accent)] text-[var(--m-accent)]"
                    : "bg-[var(--m-well)] text-[var(--m-ink-2)]"
                }`}
              >
                {m.name}
                {m.is_default && " ✓"}
              </button>
            ))
          )}
          <button
            onClick={openNewModel}
            aria-label="新增模型"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--m-well)] text-[var(--m-ink-2)]"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* 主体 */}
      <div className="bg-[var(--m-page)] pb-24">
        {/* 4 快捷入口 */}
        <div className="px-4 py-3">
          <div className="grid grid-cols-4 gap-3">
            {QUICK_ENTRIES.map((q) => (
              <button
                key={q.key}
                onClick={createNew}
                className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
              >
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl ${q.bg}`}
                >
                  {q.icon}
                </div>
                <span className="text-[11px] text-[var(--m-ink-2)]">{q.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 对话历史标题 */}
        <div className="flex items-center justify-between px-4 pt-1 pb-1 text-xs font-medium text-[var(--m-ink-3)]">
          <span>对话历史</span>
          <button
            onClick={() => setManageOpen(true)}
            className="text-[var(--m-primary)]"
          >
            管理
          </button>
        </div>

        {/* 对话列表 */}
        {loading && conversations.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--m-ink-3)]">
            加载中...
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-[var(--m-ink-3)]">
            <MessageSquarePlus size={40} className="text-[var(--m-ink-3)]" />
            <span className="text-sm">还没有对话</span>
            <span className="text-xs text-[var(--m-ink-3)]">
              点右下橙色按钮开始对话
            </span>
          </div>
        ) : (
          groupedConversations.map((group) => (
            <div key={group.label}>
              <div className="px-4 pb-1 pt-3 text-[11px] font-medium text-[var(--m-ink-3)]">
                {group.label}
              </div>
              {group.items.map((conv) => (
                <ConversationCard
                  key={conv.id}
                  conv={conv}
                  modelName={
                    models.find((m) => m.id === conv.model_id)?.name ??
                    "未知模型"
                  }
                  onClick={() => openConversation(conv)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* FAB（替代全局蓝色 + FAB，MobileLayout 已感知 /ai 隐藏全局 FAB） */}
      <button
        onClick={createNew}
        aria-label="新对话"
        className="fixed right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--m-accent)] text-[var(--m-on-primary)] shadow-[0_8px_24px_var(--kb-primary-light)] active:scale-95 transition-transform"
        style={{
          bottom: `calc(64px + env(safe-area-inset-bottom, 0px) + 16px)`,
        }}
      >
        <MessageSquarePlus size={24} />
      </button>

      {/* 模型管理 */}
      <MSheet
        open={manageOpen}
        title={`AI 模型 · ${models.length} 个`}
        onClose={() => setManageOpen(false)}
        maxHeight="80vh"
      >
        <div className="px-4 pb-2">
          <button
            onClick={openNewModel}
            className="flex w-full items-center justify-center gap-1 rounded-xl bg-[var(--m-primary)] py-2.5 text-sm font-medium text-[var(--m-on-primary)] active:opacity-80"
          >
            <Plus size={16} /> 新增模型服务
          </button>
        </div>
        {models.length === 0 ? (
          <div className="px-4 py-4 text-center text-xs text-[var(--m-ink-3)]">
            还没有模型服务
          </div>
        ) : (
          <div className="pb-2">
            {models.map((m) => (
              <div
                key={m.id}
                className="border-t border-[var(--m-line-weak)] px-4 py-3 first:border-t-0"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--m-ink-1)]">
                    {m.name}
                  </span>
                  {m.is_default && (
                    <span className="rounded bg-[var(--m-tint-accent)] px-1.5 py-0.5 text-[10px] text-[var(--m-accent)]">
                      默认
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-[var(--m-ink-3)]">
                  {m.provider} · {m.model_id}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => openEditModel(m)}
                    className="flex items-center gap-1 rounded-lg bg-[var(--m-well)] px-2.5 py-1.5 text-xs text-[var(--m-ink-2)] active:opacity-70"
                  >
                    <Pencil size={13} /> 编辑
                  </button>
                  <button
                    onClick={() => void switchDefaultModel(m.id)}
                    disabled={m.is_default}
                    className="flex items-center gap-1 rounded-lg bg-[var(--m-well)] px-2.5 py-1.5 text-xs text-[var(--m-ink-2)] active:opacity-70 disabled:opacity-40"
                  >
                    <Check size={13} /> 设默认
                  </button>
                  <button
                    onClick={() => void testModel(m)}
                    disabled={testingId === m.id}
                    className="flex items-center gap-1 rounded-lg bg-[var(--m-well)] px-2.5 py-1.5 text-xs text-[var(--m-ink-2)] active:opacity-70 disabled:opacity-40"
                  >
                    <Plug size={13} /> {testingId === m.id ? "测试中…" : "测试"}
                  </button>
                  <button
                    onClick={() => deleteModel(m)}
                    className="flex items-center gap-1 rounded-lg bg-[var(--m-tint-danger)] px-2.5 py-1.5 text-xs text-[var(--m-danger)] active:opacity-70"
                  >
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </MSheet>

      <MobileAiModelModal
        open={addModelOpen}
        editing={editingModel}
        onClose={() => {
          setAddModelOpen(false);
          setEditingModel(null);
        }}
        onSaved={() => {
          void load();
        }}
        okText="保存"
      />

      <ShareConfigModal
        open={shareEnv !== null}
        onClose={() => setShareEnv(null)}
        envelope={shareEnv}
      />

      <ImportConfigModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
      />
    </div>
  );
}

function ConversationCard({
  conv,
  modelName,
  onClick,
}: {
  conv: AiConversation;
  modelName: string;
  onClick: () => void;
}) {
  const hasNotes = conv.attached_note_ids && conv.attached_note_ids.length > 0;

  return (
    <button
      onClick={onClick}
      className="block w-full px-4 mb-2 text-left active:opacity-80"
    >
      <div className="rounded-2xl bg-[var(--m-surface)] p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--m-tint-accent)]">
            <MessageCircle size={16} className="text-[var(--m-accent)]" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-[var(--m-ink-1)]">
              {conv.title || "未命名对话"}
            </h3>
            <div className="mt-2 flex items-center gap-2 text-xs text-[var(--m-ink-3)]">
              <span className="rounded bg-[var(--m-tint-accent)] px-1.5 py-0.5 text-[10px] text-[var(--m-accent)]">
                {modelName}
              </span>
              {hasNotes && (
                <span className="flex items-center gap-1 text-[var(--m-ink-2)]">
                  <Link2 size={12} />
                  {conv.attached_note_ids.length} 篇
                </span>
              )}
              <span className="ml-auto">{relativeTime(conv.updated_at)}</span>
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}
