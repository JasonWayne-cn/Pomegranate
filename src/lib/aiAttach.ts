/**
 * 把若干篇文档一键挂载到一个全新的 AI 对话，并跳转到 AI 页。
 *
 * 用于「文档 → AI」入口（文档列表批量、文档编辑器单条等场景）。
 * 行为：
 *  1. 创建一条新对话（标题用第一篇文档标题截短，便于以后辨识）
 *  2. 调 setAttachedNotes 把这批 note IDs 挂上去（整对话共享）
 *  3. navigate('/ai', { state: { activeConvId } })，AI 页会读 state 自动选中
 *
 * 失败容忍：任意一步失败抛出原始错误，由调用方决定 message.error / 回滚。
 */
import { aiChatApi } from "@/lib/api";
import type { NavigateFunction } from "react-router-dom";

export async function startAiChatWithNotes(
  noteIds: number[],
  firstTitle: string | undefined,
  navigate: NavigateFunction,
): Promise<void> {
  if (noteIds.length === 0) return;
  // 标题：第一篇文档 + (n) 后缀；首屏看起来比"新对话"友好
  const baseTitle = (firstTitle || "文档").slice(0, 24);
  const title =
    noteIds.length > 1
      ? `${baseTitle} 等 ${noteIds.length} 篇`
      : baseTitle;

  const conv = await aiChatApi.createConversation(title);
  await aiChatApi.setAttachedNotes(conv.id, noteIds);
  navigate("/ai", { state: { activeConvId: conv.id } });
}
