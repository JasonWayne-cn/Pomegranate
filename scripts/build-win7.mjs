#!/usr/bin/env node
// scripts/build-win7.mjs
// Windows 7 兼容版构建脚本
//
// 用法：
//   pnpm build:win7                  — release 构建
//   pnpm build:win7 --debug           — debug 构建
//
// 流程：
//   1. 用 tauri.win7.conf.json 替换 tauri.conf.json（备份原文件）
//   2. 运行 pnpm tauri build --bundles nsis
//   3. 产物重命名为 知识库_Setup_x.x.x_win7.exe
//   4. 恢复原 tauri.conf.json
//
// 前置条件：
//   1. WebView2 109 Fixed Runtime 已解压到 src-tauri/WebView2-FixedRuntime-109/
//   2. 前端依赖已安装 (pnpm install)
//   3. kb-mcp sidecar 已构建 (pnpm build:mcp)

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const CONFIG = join(SRC_TAURI, "tauri.conf.json");
const WIN7_CONFIG = join(SRC_TAURI, "tauri.win7.conf.json");
const CONFIG_BACKUP = join(SRC_TAURI, "tauri.conf.json.bak");
const BUNDLE_DIR = join(SRC_TAURI, "target", "release", "bundle", "nsis");

const argv = process.argv.slice(2);
const isDebug = argv.includes("--debug");

// ─── 读取版本号 ─────────────────────────────
function getVersion() {
  // 从 tauri.win7.conf.json 读取（避免读 package.json 单独解析）
  const raw = execSync(`node -e "console.log(require('${WIN7_CONFIG.replace(/\\/g, "/")}').version)"`, {
    cwd: ROOT,
    encoding: "utf8",
  });
  return raw.trim();
}

// ─── 验证前置条件 ──────────────────────────
function checkPrerequisites() {
  const webview2Dir = join(SRC_TAURI, "WebView2-FixedRuntime-109");
  const webview2Exe = join(webview2Dir, "msedgewebview2.exe");

  if (!existsSync(webview2Exe)) {
    console.error("[build-win7] 错误: 找不到 WebView2 109 Fixed Runtime");
    console.error(`  预期位置: ${webview2Exe}`);
    console.error("  请从以下地址下载并解压到该目录:");
    console.error("    https://www.nuget.org/packages/Microsoft.Web.WebView2/109.0.1518.78");
    process.exit(1);
  }
  console.log(`[build-win7] WebView2 Runtime 已就绪: ${webview2Dir}`);
}

// ─── 切换配置 ──────────────────────────────
function switchConfig() {
  if (existsSync(CONFIG_BACKUP)) {
    console.error("[build-win7] 检测到残留备份文件，可能上次构建未正常完成");
    console.error(`  手动删除 ${CONFIG_BACKUP} 后重试`);
    // 尝试恢复
    copyFileSync(CONFIG_BACKUP, CONFIG);
    unlinkSync(CONFIG_BACKUP);
    console.log("[build-win7] 已自动恢复原配置，请重新运行");
    process.exit(1);
  }

  // 备份原配置
  copyFileSync(CONFIG, CONFIG_BACKUP);
  console.log(`[build-win7] 已备份原配置 → ${CONFIG_BACKUP}`);

  // 替换为 Win7 配置
  copyFileSync(WIN7_CONFIG, CONFIG);
  console.log(`[build-win7] 已切换到 Win7 配置 ← ${WIN7_CONFIG}`);
}

// ─── 恢复配置 ──────────────────────────────
function restoreConfig() {
  if (existsSync(CONFIG_BACKUP)) {
    copyFileSync(CONFIG_BACKUP, CONFIG);
    unlinkSync(CONFIG_BACKUP);
    console.log("[build-win7] 已恢复原配置");
  }
}

// ─── 构建 ───────────────────────────────────
function build() {
  const debugFlag = isDebug ? " --debug" : "";
  const cmd = `pnpm tauri build --bundles nsis${debugFlag}`;
  console.log(`[build-win7] 开始构建: ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

// ─── PE 子系统版本锁定 ─────────────────────────
// Tauri build 先编译 Rust 再跑 NSIS，NSIS 嵌入的 exe 就是刚编译的产物。
// 这里在 cargo build 完成后、makensis 运行前，把 exe 的 PE 子系统版本
// 修正为 6.1 (Windows 7)，确保加载器不会因版本号过低而拒绝。
// 注意：tauri build 内部顺序是 cargo → nsis，我们需要 2-phase 构建。
function patchPE(phase) {
  const EXE = join(SRC_TAURI, "target", isDebug ? "debug" : "release", "IntelligentNoteBook.exe");
  if (!existsSync(EXE)) {
    if (phase === "post") console.warn("[build-win7] 未找到 exe，跳过 PE 补丁");
    return;
  }

  const { execSync: run } = require("node:child_process");
  try {
    run(
      `python -c "import struct; f=open('${EXE.replace(/\\/g, "/")}','r+b'); d=f.read(); o=struct.unpack_from('<I',d,0x3C)[0]+72; f.seek(o); f.write(struct.pack('<HH',6,1)); f.close()"`,
      { stdio: "pipe" }
    );
    console.log("[build-win7] PE 子系统已锁定为 6.1 (Windows 7)");
  } catch {
    console.warn("[build-win7] PE 补丁失败（python 不可用，子系统保持默认）");
  }
}

// ─── 重命名产物 ─────────────────────────────
function renameOutput() {
  if (!existsSync(BUNDLE_DIR)) {
    console.warn("[build-win7] 未找到 NSIS 产物目录，跳过重命名");
    return;
  }

  const version = getVersion();
  const files = readdirSync(BUNDLE_DIR);
  const installer = files.find((f) => f.endsWith(".exe"));
  if (!installer) {
    console.warn("[build-win7] 未找到 .exe 安装包，跳过重命名");
    return;
  }

  const src = join(BUNDLE_DIR, installer);
  const dstName = installer.replace(/_x64-setup\.exe$/, `_${version}_win7_x64-setup.exe`);
  const dst = join(BUNDLE_DIR, dstName);

  if (src !== dst) {
    renameSync(src, dst);
    console.log(`[build-win7] 产物已重命名: ${dstName}`);
  }
}

// ─── 主流程 ─────────────────────────────────
function main() {
  console.log("[build-win7] === Windows 7 兼容版构建开始 ===");

  checkPrerequisites();
  switchConfig();

  try {
    // Phase 1: cargo build（产生 .exe）
    const profile = isDebug ? "debug" : "release";
    const cargoCmd = `cargo build --${profile}`;
    console.log(`[build-win7] Phase 1: ${cargoCmd}`);
    execSync(cargoCmd, { cwd: SRC_TAURI, stdio: "inherit" });

    // Patch PE 子系统 → 6.1
    patchPE("post");

    // Phase 2: NSIS 打包（tauri build 检测到 Rust 产物已就绪，跳过编译）
    const tauriCmd = `pnpm tauri build --bundles nsis${isDebug ? " --debug" : ""}`;
    console.log(`[build-win7] Phase 2: ${tauriCmd}`);
    execSync(tauriCmd, { cwd: ROOT, stdio: "inherit" });

    renameOutput();
    console.log("[build-win7] === 构建成功 ===");
  } catch (err) {
    console.error("[build-win7] === 构建失败 ===");
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    restoreConfig();
  }
}

main();
