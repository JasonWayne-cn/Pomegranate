#!/usr/bin/env node
// scripts/check-win7-imports.mjs
// Win7 导入门禁：在 PE 补丁之后、NSIS 打包之前运行。
//
// 校验内容：
//   1. 未重映射的 Win8+ DLL 不得出现在静态/延迟导入表
//   2. Win8+ 函数不得以静态/延迟导入形式残留（stub 应已消除导入）
//   3. 本地 shim DLL 必须存在，且导出覆盖被引用的全部函数
//   4. shim 文件名不得是 KnownDLLs 系统名
//   5. 可选：用 Win7 基线 DLL 校验其余静态导入（--baseline <dir>）
//
// 用法：
//   node scripts/check-win7-imports.mjs [--baseline <win7-system32-dir>] [--verbose]
//   node scripts/check-win7-imports.mjs --target <exe> [--target ...]
//
// 退出码：0 = 通过；1 = 存在阻断项或文件缺失。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseExports, parseImports, parsePe } from "./lib/pe.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const BINARIES = join(SRC_TAURI, "binaries");

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const explicitTargets = [];
let baselineDir = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--target" && argv[i + 1]) explicitTargets.push(argv[++i]);
  if (argv[i] === "--baseline" && argv[i + 1]) baselineDir = resolve(argv[++i]);
}

// 本地 shim（文件名必须与 build.ps1 输出一致）
const LOCAL_SHIMS = new Set([
  "win7synch.dll",
  "win7rt.dll",
  "api-ms-win-core-winrt-l1-1-0.dll",
]);

// KnownDLLs / 系统关键 DLL 名，禁止用作本地 shim
const KNOWN_DLL_NAMES = new Set([
  "kernel32.dll",
  "kernelbase.dll",
  "user32.dll",
  "ntdll.dll",
  "bcryptprimitives.dll",
  "bcrypt.dll",
  "combase.dll",
  "ole32.dll",
  "advapi32.dll",
  "api-ms-win-core-synch-l1-2-0.dll",
]);

// 必须已被重映射的 Win8+ DLL
const BLOCKED_DLLS = new Set([
  "api-ms-win-core-synch-l1-2-0.dll",
  "bcryptprimitives.dll",
  "combase.dll",
  "api-ms-win-core-winrt-string-l1-1-0.dll",
  "api-ms-win-core-winrt-error-l1-1-0.dll",
  "api-ms-win-crt-private-l1-1-0.dll",
]);

// Win8+ 函数：不得以静态/延迟导入形式残留（应由 stub 消除或被本地 shim 提供）
const WIN8_FUNCTIONS = new Set([
  "GetSystemTimePreciseAsFileTime",
  "CoIncrementMTAUsage",
  "RoGetAgileReference",
  "ProcessPrng",
  "WaitOnAddress",
  "WakeByAddressSingle",
  "WakeByAddressAll",
  "RtlWaitOnAddress",
  "RtlWakeAddressSingle",
  "RtlWakeAddressAll",
  "DiscardVirtualMemory",
  "GetCurrentThreadStackLimits",
  "SetThreadDescription",
  "GetThreadDescription",
  "EventSetInformation",
]);

// ─── shim 导出表加载 ────────────────────────────────────────────

const shimExports = new Map();
function loadShimExports(name) {
  if (shimExports.has(name)) return shimExports.get(name);
  const path = join(BINARIES, name);
  if (!existsSync(path)) {
    shimExports.set(name, null);
    return null;
  }
  try {
    const buffer = readFileSync(path);
    const pe = parsePe(buffer);
    const exports = parseExports(buffer, pe);
    shimExports.set(name, exports);
    return exports;
  } catch (error) {
    console.error(`[check-win7] 无法解析 shim ${name}: ${error.message}`);
    shimExports.set(name, null);
    return null;
  }
}

// 预检：shim 文件存在且不撞 KnownDLLs
const fatal = [];
for (const name of LOCAL_SHIMS) {
  if (KNOWN_DLL_NAMES.has(name.toLowerCase())) {
    fatal.push(`本地 shim 名 "${name}" 与 KnownDLLs/系统 DLL 冲突`);
  }
  const exports = loadShimExports(name);
  if (!exports) {
    fatal.push(`缺少本地 shim: src-tauri/binaries/${name}`);
  } else if (verbose) {
    console.log(`[check-win7] shim ${name}: ${exports.size} exports`);
  }
}

// ─── 基线导出表（可选）─────────────────────────────────────────

const baselineExports = new Map();
function loadBaselineExports(dll) {
  if (!baselineDir) return null;
  if (baselineExports.has(dll)) return baselineExports.get(dll);
  const path = join(baselineDir, dll);
  if (!existsSync(path)) {
    baselineExports.set(dll, null);
    return null;
  }
  try {
    const buffer = readFileSync(path);
    const pe = parsePe(buffer);
    const exports = parseExports(buffer, pe);
    baselineExports.set(dll, exports);
    return exports;
  } catch {
    baselineExports.set(dll, null);
    return null;
  }
}

// ─── 目标发现 ──────────────────────────────────────────────────

function discoverTargets() {
  if (explicitTargets.length) return explicitTargets.map((p) => resolve(p));
  const candidates = [];
  const profiles =
    process.env.WIN7_BUILD_PROFILE === "debug" ? ["debug"] : ["release"];
  const exeNames = ["Pomegranate.exe", "intelligent_notebook.exe", "IntelligentNoteBook.exe"];
  for (const profile of profiles) {
    for (const name of exeNames) {
      candidates.push(join(SRC_TAURI, "target", profile, name));
      candidates.push(join(SRC_TAURI, "target", "x86_64-pc-windows-msvc", profile, name));
    }
  }
  if (existsSync(BINARIES)) {
    for (const file of readdirSync(BINARIES)) {
      if (file.endsWith(".exe") && !file.startsWith("api-ms-win-")) {
        candidates.push(join(BINARIES, file));
      }
    }
  }
  const now = Date.now();
  return candidates.filter(
    (p) => existsSync(p) && now - statSync(p).mtimeMs < 6 * 60 * 60 * 1000,
  );
}

// ─── 单个文件校验 ──────────────────────────────────────────────

function checkOne(path) {
  const problems = [];
  const buffer = readFileSync(path);
  const pe = parsePe(buffer);
  const imports = parseImports(buffer, pe);
  let staticDlls = 0;
  let staticFuncs = 0;
  let delayDlls = 0;

  const groups = [
    ["static", imports.static],
    ["delay", imports.delay],
  ];
  for (const [kind, entries] of groups) {
    for (const entry of entries) {
      const dll = entry.dll.toLowerCase();
      if (kind === "static") staticDlls++;
      if (kind === "delay") delayDlls++;
      staticFuncs += entry.functions.length;

      if (LOCAL_SHIMS.has(dll)) {
        const exports = loadShimExports(dll);
        if (!exports) {
          problems.push(`${kind} 导入本地 shim ${dll}，但 binaries 中不存在`);
          continue;
        }
        for (const fn of entry.functions) {
          if (!fn.ordinal && !exports.has(fn.name)) {
            problems.push(`${kind} 导入 ${dll}!${fn.name}，但 shim 未导出该函数`);
          }
        }
        continue;
      }

      if (BLOCKED_DLLS.has(dll)) {
        problems.push(`${kind} 仍导入未重映射的 Win8+ DLL: ${entry.dll}`);
        continue;
      }

      // 非本地 shim：检查函数级黑名单
      for (const fn of entry.functions) {
        if (!fn.ordinal && WIN8_FUNCTIONS.has(fn.name)) {
          problems.push(`${kind} 仍导入 Win8+ 函数: ${entry.dll}!${fn.name}`);
        }
      }

      // 可选基线校验（只校验能找到的 Win7 系统 DLL）
      if (kind === "static" && baselineDir) {
        const base = loadBaselineExports(entry.dll);
        if (base) {
          for (const fn of entry.functions) {
            if (!fn.ordinal && !base.has(fn.name)) {
              problems.push(`Win7 基线缺少导出: ${entry.dll}!${fn.name}`);
            }
          }
        } else if (verbose) {
          console.log(`[check-win7] 基线中未找到 ${entry.dll}（跳过）`);
        }
      }
    }
  }

  return { problems, summary: { staticDlls, staticFuncs, delayDlls } };
}

// ─── 主流程 ────────────────────────────────────────────────────

const targets = discoverTargets();
if (targets.length === 0) {
  fatal.push("未发现可校验的 PE 目标（构建是否已完成？）");
}

let failureCount = fatal.length;
for (const message of fatal) {
  console.error(`[check-win7] FATAL ${message}`);
}

for (const target of targets) {
  try {
    const { problems, summary } = checkOne(target);
    const detail = `static: ${summary.staticDlls} dll / ${summary.staticFuncs} funcs, delay: ${summary.delayDlls}`;
    if (problems.length === 0) {
      console.log(`[check-win7] PASS ${target} (${detail})`);
    } else {
      failureCount += problems.length;
      console.error(`[check-win7] FAIL ${target} (${detail})`);
      for (const problem of problems) console.error(`  - ${problem}`);
    }
  } catch (error) {
    failureCount++;
    console.error(`[check-win7] FAIL ${target}: ${error.message}`);
  }
}

if (failureCount > 0) {
  console.error(`[check-win7] 门禁失败：${failureCount} 个问题`);
  process.exit(1);
}
console.log(`[check-win7] 门禁通过：${targets.length} 个目标`);
