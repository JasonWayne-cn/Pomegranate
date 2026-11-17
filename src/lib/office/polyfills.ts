/**
 * WebView 环境下的 Node 全局补齐。
 *
 * GenOffice 引擎把 `Buffer` 当全局使用；Vite 的 node:* alias 只能覆盖
 * ESM import，覆盖不了全局标识符。这里在引擎模块被求值前注入 Buffer。
 *
 * 注意：本模块必须作为 Worker/引擎入口的**第一个** import。
 */
import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };

if (!g.Buffer) {
  g.Buffer = Buffer;
}

export {};
