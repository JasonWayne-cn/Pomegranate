/**
 * 语音转写统一入口。
 *
 * 所有录音入口（MicButton / AsrToggleController / QuickCaptureAsrModal）共用：
 *   1. Blob → 16kHz mono WAV（失败回退原始 webm）；
 *   2. `asr_transcribe_audio`；
 *   3. 可选的术语纠错（`asr_correct_text`，后端未启用时立即原样返回）。
 *
 * 纠错失败只影响文案质量，不影响录入：这里吞掉错误并使用原始识别文本。
 */
import { asrApi } from "@/lib/api";
import { blobToWav16kBase64 } from "@/lib/audio/wav";
import type { AsrTextChange } from "@/types";

export interface TranscribeOutcome {
  /** 最终文本（已应用纠错 / 可选去尾标点） */
  text: string;
  /** 原始识别文本（未纠错） */
  rawText: string;
  /** 被采纳的术语替换；为空表示未改动 */
  corrections: AsrTextChange[];
  /** 是否走通了 WAV 管线（false = 回退了原始录音格式） */
  usedWav: boolean;
}

export interface TranscribeOptions {
  /** 语言提示（zh / en / auto），缺省 auto */
  language?: string;
  /** 剥掉末尾标点（适合标题 / 文件名 / 标签名等输入） */
  stripTrailingPunctuation?: boolean;
  /** 跳过纠错（默认 false） */
  skipCorrection?: boolean;
}

export async function transcribeBlob(
  blob: Blob,
  options: TranscribeOptions = {},
): Promise<TranscribeOutcome> {
  if (blob.size === 0) {
    throw new Error("没有录到声音");
  }

  let audioBase64: string;
  let mime: string;
  let usedWav = false;

  try {
    audioBase64 = await blobToWav16kBase64(blob);
    mime = "audio/wav";
    usedWav = true;
  } catch (e) {
    // WebView 未能解码（极少见）：退回原始 webm/opus，行为与改造前一致
    console.warn("WAV 转换失败，回退原始录音格式", e);
    audioBase64 = await blobToBase64(blob);
    mime = blob.type || "audio/webm";
  }

  const result = await asrApi.transcribe({
    audioBase64,
    mime,
    language: options.language ?? "auto",
  });

  const rawText = (result.text ?? "").trim();
  let text = rawText;
  let corrections: AsrTextChange[] = [];

  if (text && !options.skipCorrection) {
    try {
      const corr = await asrApi.correctText(text);
      if (corr.corrected && corr.corrected !== text) {
        text = corr.corrected;
        corrections = corr.changes ?? [];
      }
    } catch (e) {
      console.warn("术语纠错失败，使用原始识别文本", e);
    }
  }

  if (options.stripTrailingPunctuation) {
    text = trimTrailingPunctuation(text);
  }

  return { text, rawText, corrections, usedWav };
}

/** 末尾标点 + 空白裁切（用于文件夹名 / 标签等不该带句尾标点的场景）。 */
export function trimTrailingPunctuation(text: string): string {
  return text.replace(
    /[\s。！？，、；：…．\.\?\!\,\;\:""''『』「」（）()【】\[\]]+$/g,
    "",
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader 失败"));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.readAsDataURL(blob);
  });
}
