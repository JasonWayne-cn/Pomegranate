#!/usr/bin/env node
/**
 * 同步 vendored GenOffice 引擎。
 *
 * 用法：
 *   node scripts/sync-genoffice-vendor.mjs --source D:/AI/ALL-PPT/genoffice
 *   node scripts/sync-genoffice-vendor.mjs --source ... --check
 *
 * 说明：
 * - 复制纯引擎源码（zip-gate / pptx-engine / pptx-render / docx-engine / pptx-ops / agent-core 子文件）
 * - pptx-ops 是引擎的操作层（无 Electron 依赖），用于编辑事务与撤销语义
 * - 自动重新应用本地 `@ts-nocheck` 补丁（上游 tsconfig 未开 noUnusedLocals）
 * - 更新 vendor/genoffice/README.md 中的 commit
 * - `--check` 只比对上游 commit，不做复制
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "src", "vendor", "genoffice");

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const source = resolve(getArg("--source", "D:/AI/ALL-PPT/genoffice"));
const checkOnly = args.includes("--check");

if (!existsSync(join(source, "packages", "pptx-engine", "src"))) {
  console.error(`[vendor] 找不到 GenOffice 源码：${source}`);
  process.exit(1);
}

const commit = execFileSync("git", ["-C", source, "rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();

console.log(`[vendor] 上游 commit: ${commit}`);

if (checkOnly) {
  const readme = readFileSync(join(VENDOR, "README.md"), "utf8");
  const match = /commit `([0-9a-f]+)`/.exec(readme);
  if (match?.[1] === commit) {
    console.log("[vendor] 已是最新");
    process.exit(0);
  }
  console.log(`[vendor] vendor 版本 ${match?.[1] ?? "unknown"}，上游为 ${commit}`);
  process.exit(0);
}

const copies = [
  ["packages/zip-gate/src", "zip-gate"],
  ["packages/pptx-engine/src", "pptx-engine"],
  ["packages/pptx-render/src", "pptx-render"],
  ["packages/docx-engine/src", "docx-engine"],
  ["packages/pptx-ops/src", "pptx-ops"],
];

for (const [from, to] of copies) {
  const src = join(source, from);
  const dst = join(VENDOR, to);
  if (!existsSync(src)) {
    console.warn(`[vendor] 跳过（不存在）: ${from}`);
    continue;
  }
  cpSync(src, dst, { recursive: true, force: true });
  console.log(`[vendor] 已复制 ${from} → ${to}`);
}

const agentCore = join(source, "packages", "agent-core", "src", "redact-range.ts");
if (existsSync(agentCore)) {
  mkdirSync(join(VENDOR, "agent-core"), { recursive: true });
  copyFileSync(agentCore, join(VENDOR, "agent-core", "redact-range.ts"));
  console.log("[vendor] 已复制 agent-core/redact-range.ts");
}

for (const name of ["LICENSE", "NOTICE"]) {
  const file = join(source, name);
  if (existsSync(file)) copyFileSync(file, join(VENDOR, name));
}

// 上游源码使用自己的 tsconfig（未开 noUnusedLocals），本项目严格模式需要局部忽略。
const TS_NOCHECK = [
  "pptx-engine/vendor/mtx/lzcomp.ts",
  "pptx-render/build-chart.ts",
  "pptx-render/scene3d.ts",
  "docx-engine/resolve-props.ts",
];
const HEADER = "// @ts-nocheck -- vendored 上游源码：上游使用自己的 tsconfig（未开 noUnusedLocals）。\n";
function applyNoCheck(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return;
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("// @ts-nocheck")) writeFileSync(file, HEADER + text);
}
for (const rel of TS_NOCHECK) applyNoCheck(join(VENDOR, rel));

// 操作层整体忽略类型检查：上游为独立 tsconfig（宽松），本地严格模式下整目录放开。
function walkTs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full);
    else if (entry.name.endsWith(".ts")) applyNoCheck(full);
  }
}
walkTs(join(VENDOR, "pptx-ops"));

const readmePath = join(VENDOR, "README.md");
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8");
  const next = readme
    .replace(/commit `[0-9a-f]+`/, `commit \`${commit}\``)
    .replace(/（\d{4}-\d{2}-\d{2}）/, `（${new Date().toISOString().slice(0, 10)}）`);
  writeFileSync(readmePath, next);
}

console.log("[vendor] 完成。请运行：npx tsc --noEmit && npx vitest run src/lib/office");
