#!/usr/bin/env node
// scripts/patch-win7-pe.mjs
// Tauri beforeBundleCommand: 在 cargo build 后、makensis 前执行
// 锁定 PE 子系统为 6.1 + 替换 GetSystemTimePreciseAsFileTime

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const exePath = join("target", "release", "IntelligentNoteBook.exe");

if (!existsSync(exePath)) {
  console.warn("[patch-win7-pe] EXE not found at", exePath);
  process.exit(0);
}

const buffer = readFileSync(exePath);
const peOffset = buffer.readUInt32LE(0x3c);
const opt = peOffset + 24;

// Patch PE subsystem version to 6.1
buffer.writeUInt16LE(6, opt + 48);
buffer.writeUInt16LE(1, opt + 50);

// Patch GetSystemTimePreciseAsFileTime -> GetSystemTimeAsFileTime
const from = Buffer.from("GetSystemTimePreciseAsFileTime\0", "ascii");
const to = Buffer.from("GetSystemTimeAsFileTime\0", "ascii");
let n = 0, off = buffer.indexOf(from);
while (off !== -1) {
  to.copy(buffer, off);
  buffer.fill(0, off + to.length, off + from.length);
  n++;
  off = buffer.indexOf(from, off + from.length);
}

writeFileSync(exePath, buffer);
console.log(`[patch-win7-pe] patched (subsys=6.1, imports=${n})`);
