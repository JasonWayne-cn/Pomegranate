import { useMemo, useState } from "react";
import {
  Button,
  Dropdown,
  Input,
  Modal,
  Tooltip,
  message,
  theme as antdTheme,
} from "antd";
import type { MenuProps } from "antd";
import {
  Bot,
  Copy,
  Edit3,
  Files,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { useAiChatStore } from "@/store/aiChat";
import { aiChatApi } from "@/lib/api";
import type { AiConversation } from "@/types";
import { relativeTime } from "@/lib/utils";

/**
 * AiPanel —— Activity Bar「AI 问答」视图的 SidePanel。
 *
 * 与 SearchPanel 对齐：左侧历史记录独立成面板，宽度由 AppLayout 的统一拖拽
 * 分割条控制（可拖动 / 双击恢复默认 / 可折叠，宽度持久化）。
 * 右侧主区只负责聊天内容，不再自己画一条不可调的左侧栏。
 *
 * 对话列表状态放 useAiChatStore：面板与 pages/ai 共享同一份数据。
 */
export function AiPanel() {
  const { token } = antdTheme.useToken();

  const conversations = useAiChatStore((s) => s.conversations);
  const activeConvId = useAiChatStore((s) => s.activeConvId);
  const setActiveConvId = useAiChatStore((s) => s.setActiveConvId);
  const createConversation = useAiChatStore((s) => s.createConversation);
  const deleteConversation = useAiChatStore((s) => s.deleteConversation);
  const renameConversation = useAiChatStore((s) => s.renameConversation);
  const pinConversation = useAiChatStore((s) => s.pinConversation);
  const cloneConversation = useAiChatStore((s) => s.cloneConversation);
  const cleanupConversations = useAiChatStore((s) => s.cleanupConversations);

  const [convKeyword, setConvKeyword] = useState("");
  // 双击会话进入重命名态：editingConvId 标识哪条在编辑，editingTitle 是受控值
  const [editingConvId, setEditingConvId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const filteredConversations = useMemo(() => {
    const q = convKeyword.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, convKeyword]);

  /** 置顶 / 今天 / 更早 分组；后端已按 is_pinned DESC, updated_at DESC 排序 */
  const groupedConversations = useMemo(() => {
    const todayStr = new Date().toLocaleDateString("sv-SE");
    const groups: { label: string; items: AiConversation[] }[] = [];
    const pinned = filteredConversations.filter((c) => c.is_pinned);
    if (pinned.length) groups.push({ label: "置顶", items: pinned });
    const rest = filteredConversations.filter((c) => !c.is_pinned);
    const today = rest.filter((c) => c.updated_at.slice(0, 10) === todayStr);
    const earlier = rest.filter((c) => c.updated_at.slice(0, 10) !== todayStr);
    if (today.length) groups.push({ label: "今天", items: today });
    if (earlier.length) groups.push({ label: "更早", items: earlier });
    return groups;
  }, [filteredConversations]);

  async function handleCreate() {
    try {
      await createConversation();
    } catch (e) {
      message.error(`创建对话失败: ${e}`);
    }
  }

  async function commitRename() {
    if (editingConvId == null) return;
    const id = editingConvId;
    const title = editingTitle.trim();
    setEditingConvId(null);
    setEditingTitle("");
    // 空标题视为取消
    if (!title) return;
    const original = conversations.find((c) => c.id === id);
    if (!original || original.title === title) return;
    try {
      await renameConversation(id, title);
    } catch (e) {
      message.error(`重命名失败: ${e}`);
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteConversation(id);
    } catch (e) {
      message.error(`删除对话失败: ${e}`);
    }
  }

  async function handlePin(conv: AiConversation) {
    try {
      await pinConversation(conv.id, !conv.is_pinned);
    } catch (e) {
      message.error(`置顶失败: ${e}`);
    }
  }

  async function handleClone(conv: AiConversation) {
    try {
      await cloneConversation(conv.id);
      message.success("已克隆对话");
    } catch (e) {
      message.error(`克隆失败: ${e}`);
    }
  }

  async function handleArchive(conv: AiConversation) {
    try {
      await aiChatApi.archiveToNote(conv.id);
      message.success("已存为笔记");
    } catch (e) {
      message.error(`存为笔记失败: ${e}`);
    }
  }

  async function handleCopyMarkdown(conv: AiConversation) {
    try {
      const messages = await aiChatApi.listMessages(conv.id);
      const lines: string[] = [`# ${conv.title}`, ""];
      for (const m of messages) {
        lines.push(m.role === "user" ? "## 我" : "## AI", "", m.content, "");
      }
      await navigator.clipboard.writeText(lines.join("\n"));
      message.success("已复制 Markdown");
    } catch (e) {
      message.error(`复制失败: ${e}`);
    }
  }

  /** 批量清理：days = undefined 全清，否则清理 N 天前未活动的对话；走二次确认 */
  function handleCleanup(days: number | undefined) {
    const title = days == null ? "清空全部对话？" : `清理 ${days} 天前未活动的对话？`;
    const content =
      days == null
        ? "所有对话及其消息将被永久删除，且不可恢复。"
        : `所有 ${days} 天内没有活动的对话将被永久删除，且不可恢复。`;
    Modal.confirm({
      title,
      content,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        try {
          const removed = await cleanupConversations(days);
          if (removed === 0) {
            message.info("没有符合条件的对话");
            return;
          }
          message.success(`已清理 ${removed} 条对话`);
        } catch (e) {
          message.error(`清理失败: ${e}`);
        }
      },
    });
  }

  function renderConversation(conv: AiConversation) {
    const isActive = activeConvId === conv.id;
    // 同一组卡片操作复用给两处 trigger：右键整条 + 点击 MoreHorizontal
    // 阻止 e.domEvent 冒泡，避免触发 div 的 onClick 切换会话
    const convMenuItems: MenuProps["items"] = [
      {
        key: "pin",
        label: conv.is_pinned ? "取消置顶" : "置顶",
        icon: conv.is_pinned ? <PinOff size={12} /> : <Pin size={12} />,
        onClick: (e) => {
          e.domEvent.stopPropagation();
          void handlePin(conv);
        },
      },
      {
        key: "clone",
        label: "克隆",
        icon: <Files size={12} />,
        onClick: (e) => {
          e.domEvent.stopPropagation();
          void handleClone(conv);
        },
      },
      {
        key: "archive",
        label: "存为笔记",
        icon: <Save size={12} />,
        onClick: (e) => {
          e.domEvent.stopPropagation();
          void handleArchive(conv);
        },
      },
      {
        key: "copy-md",
        label: "复制 Markdown",
        icon: <Copy size={12} />,
        onClick: (e) => {
          e.domEvent.stopPropagation();
          void handleCopyMarkdown(conv);
        },
      },
      { type: "divider" },
      {
        key: "rename",
        label: "重命名",
        icon: <Edit3 size={12} />,
        onClick: (e) => {
          e.domEvent.stopPropagation();
          setEditingConvId(conv.id);
          setEditingTitle(conv.title);
        },
      },
      {
        key: "delete",
        label: "删除",
        danger: true,
        icon: <Trash2 size={12} />,
        onClick: (e) => {
          e.domEvent.stopPropagation();
          handleDelete(conv.id);
        },
      },
    ];
    return (
      <Dropdown
        key={conv.id}
        menu={{ items: convMenuItems }}
        trigger={["contextMenu"]}
      >
        <div
          className="cursor-pointer group"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            marginBottom: 2,
            borderRadius: 6,
            background: isActive ? `${token.colorPrimary}14` : "transparent",
            color: isActive ? token.colorPrimary : token.colorText,
            fontSize: 13,
            transition: "background .15s",
          }}
          onMouseEnter={(e) => {
            if (!isActive) {
              (e.currentTarget as HTMLDivElement).style.background =
                token.colorFillTertiary;
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              (e.currentTarget as HTMLDivElement).style.background = "transparent";
            }
          }}
          onClick={() => setActiveConvId(conv.id)}
        >
          {conv.is_pinned ? (
            <Pin
              size={13}
              style={{ flexShrink: 0, color: token.colorPrimary }}
            />
          ) : (
            <MessageSquare
              size={13}
              style={{
                flexShrink: 0,
                color: isActive ? token.colorPrimary : token.colorTextTertiary,
              }}
            />
          )}
          <div className="flex-1 min-w-0">
            {editingConvId === conv.id ? (
              // 重命名输入框：Enter / 失焦提交；Esc 放弃；点击不冒泡到 div 切换会话
              <Input
                autoFocus
                size="small"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onPressEnter={commitRename}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditingConvId(null);
                    setEditingTitle("");
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                style={{ fontSize: 13, padding: "2px 6px" }}
              />
            ) : (
              <div
                className="truncate select-none"
                onDoubleClick={(e) => {
                  // 双击重命名：阻止冒泡避免 div 的 onClick 切换会话；
                  // select-none + e.preventDefault 阻止双击选中文本
                  e.stopPropagation();
                  e.preventDefault();
                  setEditingConvId(conv.id);
                  setEditingTitle(conv.title);
                }}
                title="双击重命名"
              >
                {conv.title}
              </div>
            )}
            <div style={{ fontSize: 11, color: token.colorTextQuaternary }}>
              {relativeTime(conv.updated_at)}
            </div>
          </div>
          <button
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-black/5 transition-opacity"
            onClick={(e) => {
              // 不切换会话；不冒泡到外层 contextMenu Dropdown 的 click 监听
              e.stopPropagation();
              // 把"点三个点"翻译成一次右键事件，让外层 Dropdown
              // (trigger=contextMenu) 接住——单一 Dropdown 实例
              const ev = new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                view: window,
                button: 2,
                clientX: e.clientX,
                clientY: e.clientY,
              });
              e.currentTarget.dispatchEvent(ev);
            }}
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
      </Dropdown>
    );
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 视图标题 + 新对话 / 批量清理 */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Bot size={15} style={{ color: token.colorPrimary }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
          AI 问答
        </span>
        <div style={{ flex: 1 }} />
        <Tooltip title="新对话">
          <Button
            type="text"
            size="small"
            icon={<Plus size={14} />}
            style={{ width: 24, height: 24, padding: 0 }}
            onClick={handleCreate}
          />
        </Tooltip>
        <Dropdown
          menu={{
            items: [
              {
                key: "clean-7d",
                label: "清理 7 天前未活动",
                onClick: () => handleCleanup(7),
              },
              {
                key: "clean-30d",
                label: "清理 30 天前未活动",
                onClick: () => handleCleanup(30),
              },
              { type: "divider" },
              {
                key: "clean-all",
                label: "清空全部对话",
                danger: true,
                onClick: () => handleCleanup(undefined),
              },
            ],
          }}
          trigger={["click"]}
          placement="bottomRight"
        >
          <Tooltip title="批量清理历史会话">
            <Button
              type="text"
              size="small"
              icon={<MoreHorizontal size={14} />}
              style={{ width: 24, height: 24, padding: 0 }}
            />
          </Tooltip>
        </Dropdown>
      </div>

      {/* 会话搜索 */}
      <div className="p-2 shrink-0">
        <Input
          size="small"
          allowClear
          placeholder="搜索会话…"
          prefix={<Search size={13} style={{ color: token.colorTextQuaternary }} />}
          value={convKeyword}
          onChange={(e) => setConvKeyword(e.target.value)}
        />
      </div>

      {/* 会话列表 */}
      <div
        className="flex-1 overflow-auto"
        style={{ minHeight: 0, padding: "0 8px 8px" }}
      >
        {conversations.length === 0 ? (
          <div
            className="text-center py-6"
            style={{ color: token.colorTextQuaternary, fontSize: 12 }}
          >
            暂无对话
            <br />
            <span style={{ fontSize: 11 }}>点击上方 + 新建对话</span>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div
            className="text-center py-6"
            style={{ color: token.colorTextQuaternary, fontSize: 12 }}
          >
            没有匹配的会话
          </div>
        ) : (
          groupedConversations.map((group) => (
            <div key={group.label}>
              <div
                style={{
                  fontSize: 11,
                  color: token.colorTextQuaternary,
                  padding: "6px 10px 4px",
                  userSelect: "none",
                }}
              >
                {group.label}
              </div>
              {group.items.map(renderConversation)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
