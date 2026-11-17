/**
 * `node:crypto` 的浏览器替身，只实现 GenOffice 引擎实际用到的两个 API：
 * - `createHash('sha256').update(bytes).digest('hex')`
 * - `randomUUID()`
 *
 * 引擎用哈希做归档指纹、用 UUID 生成 section id，均不涉及密钥材料。
 */
import { sha256 } from "@noble/hashes/sha256";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export interface HashLike {
  update(data: Uint8Array | string): HashLike;
  digest(encoding?: "hex"): string | Uint8Array;
}

export function createHash(algorithm: string): HashLike {
  if (algorithm.toLowerCase() !== "sha256") {
    throw new Error(`createHash: unsupported algorithm ${algorithm}`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const api: HashLike = {
    update(data) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      chunks.push(bytes);
      total += bytes.length;
      return api;
    },
    digest(encoding) {
      const all = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      const out = sha256(all);
      return encoding === "hex" ? toHex(out) : out;
    },
  };
  return api;
}

export function randomUUID(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // 极老的 WebView 兜底：时间 + Math.random，仅用于生成唯一 id，不作为随机源。
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
