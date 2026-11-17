#!/usr/bin/env node
// scripts/patch-win7-pe.mjs
// Win7 PE 后处理：在 cargo build 之后、NSIS 打包之前执行（tauri beforeBundleCommand）。
//
// 按 PE 结构定位（不是全文件字符串替换）：
//   1. 子系统版本 → 6.1；release 主程序子系统类型 → GUI
//   2. 静态导入 / 延迟导入描述符：DLL 名原地重映射（NUL 填充，长度不得增加）
//   3. 导入函数名替换（raw-dylib 的 Win8+ API）
//   4. 清空 Bound Import 目录（缓存的旧 DLL 名会干扰加载）
//
// 用法：
//   node scripts/patch-win7-pe.mjs [--dry-run] [--verbose]
//   node scripts/patch-win7-pe.mjs --target <exe> [--target <exe>]

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseImports, parsePe, readCString, writeCStringInPlace } from "./lib/pe.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_TAURI = join(ROOT, "src-tauri");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const verbose = argv.includes("--verbose");
const explicitTargets = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--target" && argv[i + 1]) explicitTargets.push(argv[++i]);
}

// ─── 重映射表 ───────────────────────────────────────────────────
const DLL_REMAPS = [
  // Win8+ 同步 API Set → 本地 shim（WaitOnAddress 等由 shim 实现，
  // InitOnce*/SRWLock/ConditionVariable 由 .def 转发 kernel32）
  { from: "api-ms-win-core-synch-l1-2-0.dll", to: "win7synch.dll" },
  // bcryptprimitives 是系统已知 DLL 名，绝不能放同名自制 DLL；shim 输出为 win7rt.dll
  { from: "bcryptprimitives.dll", to: "win7rt.dll" },
  // Win7 无 winrt-string / winrt-error API Set，合并到 WinRT shim
  { from: "api-ms-win-core-winrt-string-l1-1-0.dll", to: "api-ms-win-core-winrt-l1-1-0.dll" },
  { from: "api-ms-win-core-winrt-error-l1-1-0.dll", to: "api-ms-win-core-winrt-l1-1-0.dll" },
  // Win7 无 combase.dll；CoTaskMem* 自 XP 起在 ole32
  { from: "combase.dll", to: "ole32.dll" },
];

// 函数名（新名不得长于旧名）
const FUNC_REMAPS = [
  // Rust std::time 静态导入 → Win7 kernel32 可用
  { from: "GetSystemTimePreciseAsFileTime", to: "GetSystemTimeAsFileTime" },
  // windows crate raw-dylib 导入（不受 DELAYLOAD 控制）；Win7 ole32 无这些导出。
  // 替换为同 DLL 中存在的函数名以通过加载器解析；Win7 上不应被实际调用。
  { from: "CoIncrementMTAUsage", to: "CoTaskMemAlloc" },
  { from: "RoGetAgileReference", to: "CoTaskMemAlloc" },
];

// ─── 单个文件补丁 ──────────────────────────────────────────────

function patchOne(path, apply) {
  const buffer = readFileSync(path);
  const pe = parsePe(buffer);
  const imports = parseImports(buffer, pe);
  const stats = { path, dllRemaps: [], funcRemaps: [], boundCleared: false, subsystemGui: false };

  const isDebugPath = /[\\/]debug[\\/]/i.test(path);
  const isExe = path.toLowerCase().endsWith(".exe");
  // kb-mcp 是 stdio sidecar，必须保持 CONSOLE 子系统
  const isSidecar = /kb-mcp/i.test(path);

  // 子系统版本 6.1；仅主程序 release exe 的 CONSOLE(3) → GUI(2)
  const currentSubsystem = buffer.readUInt16LE(pe.subsystemOffset);
  const wantsGui = isExe && !isDebugPath && !isSidecar && currentSubsystem === 3;
  if (apply) {
    buffer.writeUInt16LE(6, pe.majorSubsystemOffset);
    buffer.writeUInt16LE(1, pe.minorSubsystemOffset);
    if (wantsGui) buffer.writeUInt16LE(2, pe.subsystemOffset);
  }
  stats.subsystemGui = wantsGui;

  // DLL 名 + 函数名（静态与延迟导入同样处理）
  for (const entry of [...imports.static, ...imports.delay]) {
    const current = readCString(buffer, entry.dllOffset)?.text ?? entry.dll;
    const dllMap = DLL_REMAPS.find((m) => m.from.toLowerCase() === current.toLowerCase());
    if (dllMap) {
      stats.dllRemaps.push(`${current} → ${dllMap.to}`);
      if (apply) writeCStringInPlace(buffer, entry.dllOffset, current, dllMap.to);
    }
    for (const fn of entry.functions) {
      if (fn.ordinal || fn.offset < 0) continue;
      const fnMap = FUNC_REMAPS.find((m) => m.from === fn.name);
      if (!fnMap) continue;
      stats.funcRemaps.push(`${fn.dll}!${fn.name} → ${fnMap.to}`);
      if (apply) writeCStringInPlace(buffer, fn.offset, fn.name, fnMap.to);
    }
  }

  // 清空 Bound Import 目录（RVA + Size）
  if (pe.dirs[11].rva !== 0) {
    if (apply) {
      buffer.writeUInt32LE(0, pe.dataDirOffset + 11 * 8);
      buffer.writeUInt32LE(0, pe.dataDirOffset + 11 * 8 + 4);
    }
    stats.boundCleared = true;
  }

  if (apply) writeFileSync(path, buffer);

  // 校验：Win7 上必然导致启动失败的导入名不得残留
  if (apply) {
    const after = readFileSync(path);
    if (after.includes(Buffer.from("GetSystemTimePreciseAsFileTime\0", "ascii"))) {
      throw new Error("GetSystemTimePreciseAsFileTime 仍残留");
    }
  }

  return stats;
}

// ─── 目标发现 ──────────────────────────────────────────────────

function discoverTargets() {
  if (explicitTargets.length) return explicitTargets.map((p) => resolve(p));
  const candidates = [];
  // 只处理本次构建 profile 的产物：避免 release 打包时误触被其他会话占用的 debug exe
  const profiles =
    process.env.WIN7_BUILD_PROFILE === "debug" ? ["debug"] : ["release"];
  // cargo 产物名为 package name（intelligent_notebook.exe），
  // Tauri bundler 在后续阶段才改名为 mainBinaryName（Pomegranate.exe）。
  const exeNames = ["Pomegranate.exe", "intelligent_notebook.exe", "IntelligentNoteBook.exe"];
  for (const profile of profiles) {
    for (const name of exeNames) {
      candidates.push(join(SRC_TAURI, "target", profile, name));
      candidates.push(join(SRC_TAURI, "target", "x86_64-pc-windows-msvc", profile, name));
    }
  }
  const binaries = join(SRC_TAURI, "binaries");
  if (existsSync(binaries)) {
    for (const file of readdirSync(binaries)) {
      if (file.endsWith(".exe") && !file.startsWith("api-ms-win-")) {
        candidates.push(join(binaries, file));
      }
    }
  }
  // 只补丁本次构建产出的较新文件，避免反复处理陈旧产物
  const now = Date.now();
  return candidates.filter(
    (p) => existsSync(p) && now - statSync(p).mtimeMs < 6 * 60 * 60 * 1000,
  );
}

// ─── 主流程 ────────────────────────────────────────────────────

const targets = discoverTargets();
if (targets.length === 0) {
  console.error("[patch-win7-pe] 未发现可补丁的 PE 目标（构建是否已完成？）");
  process.exit(1);
}

let failures = 0;
for (const target of targets) {
  try {
    const stats = patchOne(target, !dryRun);
    const detail = [
      `subsystem=6.1${stats.subsystemGui ? "+GUI" : ""}`,
      `dllRemaps=${stats.dllRemaps.length}`,
      `funcRemaps=${stats.funcRemaps.length}`,
      stats.boundCleared ? "boundImport=cleared" : "",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`[patch-win7-pe] ${dryRun ? "DRY " : ""}${target} (${detail})`);
    if (verbose) {
      for (const d of stats.dllRemaps) console.log(`  DLL  ${d}`);
      for (const f of stats.funcRemaps) console.log(`  FUNC ${f}`);
    }
  } catch (error) {
    failures++;
    console.error(`[patch-win7-pe] FAILED ${target}: ${error.message}`);
  }
}

if (failures > 0) {
  console.error(`[patch-win7-pe] ${failures} 个目标补丁失败`);
  process.exit(1);
}
console.log(`[patch-win7-pe] 完成：${targets.length} 个目标`);
