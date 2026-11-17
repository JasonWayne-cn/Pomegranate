/**
 * `node:zlib` 的浏览器替身。
 *
 * GenOffice 引擎目前只用到 `deflateSync`（media-insert 里拼 PNG 的 IDAT）。
 * fflate 的 `zlibSync` 与 Node `zlib.deflateSync` 一样输出 zlib 包装流。
 */
import { inflateSync, zlibSync } from "fflate";

export function deflateSync(data: Uint8Array): Uint8Array {
  return zlibSync(data);
}

/** Node `zlib.inflateRawSync`：无 zlib 头的 raw DEFLATE。 */
export function inflateRawSync(data: Uint8Array): Uint8Array {
  return inflateSync(data);
}

/** Node `zlib.crc32`（Node 20+）的同步实现，返回无符号 32 位整数。 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
