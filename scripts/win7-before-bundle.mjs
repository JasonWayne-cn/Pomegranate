#!/usr/bin/env node
// scripts/win7-before-bundle.mjs
// Tauri beforeBundleCommand 单一入口：先打 PE 补丁，再跑导入门禁。
// 任一步失败都以非零退出，阻止 NSIS 生成不合格安装包。

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`[win7-before-bundle] ${script} 失败（exit ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

run("patch-win7-pe.mjs", ["--verbose"]);
run("check-win7-imports.mjs", ["--verbose"]);
