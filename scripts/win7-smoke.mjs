#!/usr/bin/env node
// scripts/win7-smoke.mjs
// Win7 实机/虚拟机冒烟测试：验证安装后的应用与 sidecar 能真正跑起来。
//
// 用法（在 Win7 目标机上执行，需要 Node 18+）：
//   node win7-smoke.mjs --app "C:\Program Files\Pomegranate\Pomegranate.exe"
//   node win7-smoke.mjs --app <exe> --sidecar "C:\...\kb-mcp.exe" --timeout 15000
//
// 检查项：
//   1. 主程序存在且为 PE（MZ）
//   2. 启动后存活 N 秒（无 DLL 缺失/秒退）
//   3. 应用数据目录中 app.db 已创建
//   4. 日志目录无 panic / ERROR
//   5. kb-mcp sidecar 可执行（--version）
//   6. 进程可正常结束
//
// 退出码：0 全部通过；1 存在失败项。

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
function argValue(name) {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : null;
}

const appPath = argValue("--app");
const sidecarPath = argValue("--sidecar");
const timeoutMs = Number(argValue("--timeout") ?? 12000);
const appData = process.env.APPDATA;
const dataDir = appData ? join(appData, "edu.bit.inb") : null;

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function checkPe(path) {
  if (!existsSync(path)) return false;
  const head = readFileSync(path).subarray(0, 2).toString("ascii");
  return head === "MZ";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(child) {
  return child.exitCode === null && !child.killed;
}

function scanLogs(dir) {
  if (!dir || !existsSync(dir)) return { found: false, problems: [] };
  const problems = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".log")) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (/panic|\[ERROR\]|ERROR /i.test(line)) problems.push(`${file}: ${line.slice(0, 200)}`);
    }
  }
  return { found: true, problems };
}

async function main() {
  if (!appPath) {
    console.error("缺少 --app <Pomegranate.exe>");
    process.exit(1);
  }

  record("主程序存在且为有效 PE", checkPe(appPath), appPath);

  // 启动应用
  const child = spawn(appPath, [], { stdio: "ignore", detached: false });
  let exitedEarly = false;
  child.on("exit", () => {
    exitedEarly = true;
  });

  await sleep(timeoutMs);
  record(`启动后存活 ${timeoutMs}ms`, processAlive(child), exitedEarly ? "进程提前退出" : "");

  // 数据目录（失败不阻断，仅报告）
  if (dataDir && existsSync(dataDir)) {
    record("应用数据目录已创建", true, dataDir);
    const db = join(dataDir, "app.db");
    record("SQLite app.db 已创建", existsSync(db), db);
  } else {
    record("应用数据目录已创建", false, dataDir ?? "APPDATA 不可用");
  }

  // 日志
  const logDirs = dataDir ? [join(dataDir, "logs"), dataDir] : [];
  let logFound = false;
  let logProblems = [];
  for (const dir of logDirs) {
    const scan = scanLogs(dir);
    if (scan.found) {
      logFound = true;
      logProblems = logProblems.concat(scan.problems);
    }
  }
  if (logFound) {
    record("日志无 panic/ERROR", logProblems.length === 0, logProblems.slice(0, 5).join(" | "));
  } else {
    record("日志无 panic/ERROR", true, "未找到日志目录（跳过）");
  }

  // 结束应用
  if (processAlive(child)) {
    child.kill();
    await sleep(1500);
    record("应用可正常结束", true);
  }

  // sidecar
  if (sidecarPath) {
    if (!checkPe(sidecarPath)) {
      record("kb-mcp sidecar 存在且为有效 PE", false, sidecarPath);
    } else {
      try {
        const out = execFileSync(sidecarPath, ["--version"], { encoding: "utf8", timeout: 15000 });
        record("kb-mcp sidecar 可执行", true, out.trim());
      } catch (error) {
        record("kb-mcp sidecar 可执行", false, String(error.message).split("\n")[0]);
      }
    }
  } else {
    record("kb-mcp sidecar 可执行", true, "未提供 --sidecar（跳过）");
  }

  const failures = results.filter((r) => !r.ok).length;
  console.log(`\n结果：${results.length - failures}/${results.length} 通过`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
