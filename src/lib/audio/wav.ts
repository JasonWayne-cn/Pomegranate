/**
 * 语音输入音频管线：把 WebView 录制的任意格式音频统一成 16kHz 单声道 PCM16 WAV。
 *
 * 为什么要统一：
 *   - 当前 DashScope qwen3-asr 对 webm/opus 只是"实测兼容"，并非文档格式；
 *   - 未来接入本地 ASR / 其他云端厂商时都需要标准 WAV；
 *   - 16k mono 是最常见的语音模型输入，体积也远小于原始 webm 多声道。
 *
 * 编码部分（`encodeWavPcm16`）是纯函数，可在 node 环境单测；
 * 解码/重采样依赖浏览器 Web Audio（`OfflineAudioContext.decodeAudioData`
 * 会按 context 的 sampleRate 完成重采样），失败时调用方应回退原始 blob。
 */

export const ASR_SAMPLE_RATE = 16000;

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Float32 [-1,1] → 44 字节头 WAV（PCM16 单声道）。
 */
export function encodeWavPcm16(
  samples: Float32Array,
  sampleRate: number = ASR_SAMPLE_RATE,
): Uint8Array {
  const channels = 1;
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // clamp 到 [-1,1]，再映射到 int16 对称区间
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/** 多声道降混为单声道（平均）。 */
export function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels <= 1) {
    return buffer.getChannelData(0).slice();
  }
  const length = buffer.length;
  const out = new Float32Array(length);
  const gain = 1 / buffer.numberOfChannels;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      out[i] += data[i] * gain;
    }
  }
  return out;
}

/** Uint8Array → base64（分块，避免超长参数导致栈溢出）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Blob → 16kHz mono WAV base64。
 *
 * `OfflineAudioContext` 的 `decodeAudioData` 会按构造时指定的采样率重采样，
 * 所以这里直接拿到 16k 的 AudioBuffer。任何一步失败都会向上抛，
 * 调用方（`transcribeBlob`）负责回退到原始 blob 上传。
 */
export async function blobToWav16kBase64(blob: Blob): Promise<string> {
  const raw = await blob.arrayBuffer();
  const Ctx = globalThis.OfflineAudioContext;
  if (!Ctx) {
    throw new Error("当前环境不支持 OfflineAudioContext");
  }
  const ctx = new Ctx(1, 1, ASR_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(raw);
  const mono = mixToMono(decoded);
  const wav = encodeWavPcm16(mono, ASR_SAMPLE_RATE);
  return bytesToBase64(wav);
}
