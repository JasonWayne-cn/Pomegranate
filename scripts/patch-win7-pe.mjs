#!/usr/bin/env node
// scripts/patch-win7-pe.mjs
// Tauri beforeBundleCommand: 在 cargo build 后、makensis 前执行
//
// 执行两个补丁：
// 1. PE 子系统版本锁定为 6.1 (Win7)
// 2. GetSystemTimePreciseAsFileTime → GetSystemTimeAsFileTime
// 3. delay-load DLL 名重映射：
//    api-ms-win-core-synch-l1-2-0.dll → bcryptprimitives.dll
//    (避免 Win7 API Set 机制将 Sleep 等函数路由到我们的 shim)

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const exePath = "src-tauri/target/release/IntelligentNoteBook.exe";

if (!existsSync(exePath)) {
  console.warn("[patch-win7-pe] EXE not found at", exePath);
  process.exit(0);
}

const buffer = readFileSync(exePath);
const peOffset = buffer.readUInt32LE(0x3c);
const opt = peOffset + 24;
const magic = buffer.readUInt16LE(opt);

// ─── 解析 PE sections（用于 RVA → 文件偏移转换） ───
const numSections = buffer.readUInt16LE(peOffset + 6);
const optHdrSize = buffer.readUInt16LE(peOffset + 20);
const sectionStart = peOffset + 24 + optHdrSize;

const sections = [];
for (let i = 0; i < numSections; i++) {
  const so = sectionStart + i * 40;
  sections.push({
    name: buffer.toString("ascii", so, so + 8).replace(/\0/g, ""),
    vrva: buffer.readUInt32LE(so + 12),
    vsize: buffer.readUInt32LE(so + 8),
    rawPtr: buffer.readUInt32LE(so + 20),
    rawSize: buffer.readUInt32LE(so + 16),
  });
}

function rvaToOffset(rva) {
  for (const s of sections) {
    if (rva >= s.vrva && rva < s.vrva + s.vsize) {
      return s.rawPtr + (rva - s.vrva);
    }
  }
  return -1;
}

// ─── Patch 1: 子系统版本 → 6.1 ──────────────────
buffer.writeUInt16LE(6, opt + 48);
buffer.writeUInt16LE(1, opt + 50);

// ─── Patch 2: GetSystemTimePreciseAsFileTime → GetSystemTimeAsFileTime ───
const fromGST = Buffer.from("GetSystemTimePreciseAsFileTime\0", "ascii");
const toGST = Buffer.from("GetSystemTimeAsFileTime\0", "ascii");
let n = 0, off = buffer.indexOf(fromGST);
while (off !== -1) {
  toGST.copy(buffer, off);
  buffer.fill(0, off + toGST.length, off + fromGST.length);
  n++;
  off = buffer.indexOf(fromGST, off + fromGST.length);
}

// ─── Patch 3: delay-load DLL 名重映射 ──────────
// 找到 delay-load 表中引用 api-ms-win-core-synch-l1-2-0.dll 的条目，
// 将其 DLL 名字符串替换为 bcryptprimitives.dll（更短，零填充）。
const dlFrom = Buffer.from("api-ms-win-core-synch-l1-2-0.dll\0", "ascii");
const dlTo = Buffer.from("bcryptprimitives.dll\0", "ascii");

let dlPatched = 0;
let dlOff = buffer.indexOf(dlFrom);
while (dlOff !== -1) {
  dlTo.copy(buffer, dlOff);
  buffer.fill(0, dlOff + dlTo.length, dlOff + dlFrom.length);
  dlPatched++;
  dlOff = buffer.indexOf(dlFrom, dlOff + dlFrom.length);
}

writeFileSync(exePath, buffer);
console.log(`[patch-win7-pe] patched (subsys=6.1, imports=${n}, delay-dl-rename=${dlPatched})`);
