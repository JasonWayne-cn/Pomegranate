import { useEffect, useRef, useState } from "react";
import { Progress } from "antd";
import type { LlmGraphProgress } from "@/types";

/** 实体类型配色（LLM 图谱） */
export function entityTypeColor(type: string, token: any): string {
  switch (type) {
    case "artifact":
      return token.colorPrimary;
    case "concept":
      return token.colorInfo;
    case "method":
      return token.colorSuccess;
    case "data":
      return token.colorWarning;
    case "person":
      return token.colorError;
    case "content":
      return token.colorTextSecondary;
    case "organization":
      return token.colorPrimaryBorder;
    case "event":
      return token.colorTextTertiary;
    default:
      return token.colorTextSecondary;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

/** 单块预计耗时（毫秒）：用于无历史数据时的剩余时间估算 */
const AVG_CHUNK_MS = 60_000;

/** 抽取进度：进度条 + 第 x/y 块、已用时间、预计剩余 */
export function ExtractionProgress({
  progress,
  token,
}: {
  progress: LlmGraphProgress;
  token: any;
}) {
  const [now, setNow] = useState(Date.now());
  const receivedAt = useRef(Date.now());

  useEffect(() => {
    receivedAt.current = Date.now();
    setNow(Date.now());
  }, [progress]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const liveElapsed =
    progress.elapsed_ms + Math.max(0, now - receivedAt.current);
  const sinceChunk =
    progress.phase === "chunk-start"
      ? Math.max(0, now - receivedAt.current)
      : 0;

  const completedChunks =
    progress.phase === "chunk-done" || progress.phase === "note-done"
      ? progress.chunk
      : Math.max(0, progress.chunk - 1);
  const inChunk =
    progress.phase === "chunk-start"
      ? Math.min(0.9, sinceChunk / AVG_CHUNK_MS)
      : 0;
  const chunkPart =
    progress.chunks > 0
      ? Math.min(1, (completedChunks + inChunk) / progress.chunks)
      : progress.phase === "note-done"
        ? 1
        : 0;
  const idx = Math.max(0, progress.note_index - 1);
  const fraction =
    progress.note_total > 1
      ? Math.min(1, (idx + chunkPart) / progress.note_total)
      : chunkPart;

  const remainingChunks =
    progress.chunks > 0
      ? progress.chunks -
        completedChunks +
        Math.max(0, progress.note_total - progress.note_index) * progress.chunks
      : 0;
  const eta =
    progress.phase === "note-error"
      ? null
      : Math.max(0, remainingChunks * AVG_CHUNK_MS - sinceChunk);

  const notePrefix =
    progress.note_total > 1
      ? `第 ${progress.note_index}/${progress.note_total} 篇 · `
      : "";
  const phaseText =
    progress.phase === "note-start"
      ? "准备中"
      : progress.phase === "note-done"
        ? "完成"
        : progress.phase === "note-error"
          ? "失败"
          : `第 ${progress.chunk}/${progress.chunks} 块`;
  const text = `${notePrefix}${phaseText} · 已用 ${formatDuration(liveElapsed)}${
    eta != null ? ` · 预计剩余 ${formatDuration(eta)}` : ""
  }`;

  return (
    <div style={{ width: 220 }}>
      <Progress
        percent={Math.round(fraction * 100)}
        size="small"
        showInfo={false}
        strokeColor={token.colorPrimary}
      />
      <div
        style={{
          fontSize: 11,
          color: token.colorTextTertiary,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={progress.error ? `${text}：${progress.error}` : text}
      >
        {text}
      </div>
    </div>
  );
}
