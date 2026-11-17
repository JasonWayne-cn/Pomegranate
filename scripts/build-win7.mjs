#!/usr/bin/env node
// scripts/build-win7.mjs
// Windows 7 兼容版一体化构建流水线。
//
// 用法：
//   pnpm build:win7                         — lite + full 双产物（默认）
//   pnpm build:win7 --variant lite          — 仅轻量版（不捆绑 WebView2）
//   pnpm build:win7 --variant full          — 仅完整版（捆绑 WebView2 109 Fixed Runtime）
//   pnpm build:win7 --debug                 — debug 构建
//   pnpm build:win7 --force-shim            — 强制重建 shim DLL
//
// 流程：
//   1. 校验工具链，构建/校验三个 shim DLL（win7synch / win7rt / WinRT）
//   2. 以 win7-compat feature 构建 kb-mcp sidecar
//   3. 逐 variant：切换 tauri 配置 → tauri build（内部执行 PE 补丁 + 导入门禁）
//      → 校验新产物 → 重命名
//   4. try/finally 恢复 tauri.conf.json

import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const CONFIG = join(SRC_TAURI, "tauri.conf.json");
const CONFIG_BACKUP = join(SRC_TAURI, "tauri.conf.json.bak");
const LITE_CONFIG = join(SRC_TAURI, "tauri.win7.conf.json");
const FULL_CONFIG = join(SRC_TAURI, "tauri.win7.full.conf.json");
const BINARIES = join(SRC_TAURI, "binaries");
const WEBVIEW2_RUNTIME = join(SRC_TAURI, "WebView2-FixedRuntime-109");

const argv = process.argv.slice(2);
const isDebug = argv.includes("--debug");
const forceShim = argv.includes("--force-shim");

function argValue(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return fallback;
}

const variantArg = argValue("--variant", "both");
const requestedVariants = variantArg === "both" ? ["lite", "full"] : [variantArg];
if (requestedVariants.some((v) => v !== "lite" && v !== "full")) {
  console.error(`[build-win7] 未知 variant: ${variantArg}（可选 lite / full / both）`);
  process.exit(1);
}

const VS2022_PATH = process.env.VS2022_PATH || "D:\\Dev\\MicrosoftVisualStudio\\2022\\Community";

// ─── 工具链 ────────────────────────────────────────────────────

function hostTriple() {
  const out = execSync("rustc -vV", { encoding: "utf8" });
  const match = out.match(/^host:\s*(\S+)$/m);
  if (!match) throw new Error("无法从 rustc -vV 解析 host triple");
  return match[1];
}

const TARGET_TRIPLE = hostTriple();

function checkPrerequisites() {
  console.log(`[build-win7] Rust: ${execSync("rustc --version", { encoding: "utf8" }).trim()}`);
  console.log(`[build-win7] target: ${TARGET_TRIPLE}`);
  if (!TARGET_TRIPLE.includes("windows")) {
    throw new Error("build:win7 只能在 Windows 主机上运行");
  }
}

function mtime(path) {
  return existsSync(path) ? statSync(path).mtimeMs : 0;
}

function newestMtime(paths) {
  return Math.max(0, ...paths.map(mtime));
}

// ─── Shim 构建 ─────────────────────────────────────────────────

const SHIMS = [
  {
    script: join(SRC_TAURI, "win7_winrt_shim", "build.ps1"),
    outputs: [
      join(BINARIES, "api-ms-win-core-winrt-l1-1-0.dll"),
      join(BINARIES, "win7rt.dll"),
    ],
    sources: [
      "win7_winrt_shim/build.ps1",
      "win7_winrt_shim/dllmain.c",
      "win7_winrt_shim/hstring.c",
      "win7_winrt_shim/hstring.h",
      "win7_winrt_shim/winrt_stubs.c",
      "win7_winrt_shim/exports.def",
      "win7_winrt_shim/bcrypt_stubs.c",
      "win7_winrt_shim/bcrypt_exports.def",
    ].map((p) => join(SRC_TAURI, p)),
  },
  {
    script: join(SRC_TAURI, "win7_synch_shim", "build.ps1"),
    outputs: [join(BINARIES, "win7synch.dll")],
    sources: [
      "win7_synch_shim/build.ps1",
      "win7_synch_shim/api-ms-win-core-synch-l1-2-0.c",
      "win7_synch_shim/exports.def",
    ].map((p) => join(SRC_TAURI, p)),
  },
];

function needsRebuild(shim) {
  if (forceShim) return true;
  if (!shim.outputs.every((p) => existsSync(p) && statSync(p).size > 0)) return true;
  return newestMtime(shim.sources) > Math.min(...shim.outputs.map(mtime));
}

function runPowerShellBuild(shim) {
  const vcvars = join(VS2022_PATH, "VC", "Auxiliary", "Build", "vcvars64.bat");
  const invoke = `powershell -NoProfile -ExecutionPolicy Bypass -File "${shim.script}"`;
  if (existsSync(vcvars)) {
    // 通过 vcvars64 注入 cl.exe/link.exe 环境。
    // execSync 在 Windows 上本身即由 cmd.exe 执行，无需再嵌套 cmd /c。
    execSync(`call "${vcvars}" >NUL 2>&1 && ${invoke}`, {
      cwd: ROOT,
      stdio: "inherit",
    });
  } else {
    console.warn(`[build-win7] vcvars64.bat 未找到（${vcvars}），尝试直接调用 build.ps1`);
    execSync(invoke, { cwd: ROOT, stdio: "inherit" });
  }
}

function buildShims() {
  mkdirSync(BINARIES, { recursive: true });
  // 清理旧命名的 shim，避免被误打包或误部署
  for (const legacy of ["bcryptprimitives.dll", "api-ms-win-core-synch-l1-2-0.dll"]) {
    const path = join(BINARIES, legacy);
    if (existsSync(path)) {
      rmSync(path, { force: true });
      console.log(`[build-win7] 已删除 legacy shim: ${legacy}`);
    }
  }
  for (const shim of SHIMS) {
    if (!needsRebuild(shim)) {
      console.log(`[build-win7] shim 已是最新：${shim.outputs.map((p) => p.split(/[\\/]/).pop()).join(", ")}`);
      continue;
    }
    console.log(`[build-win7] 构建 shim：${shim.script}`);
    runPowerShellBuild(shim);
    for (const output of shim.outputs) {
      if (!existsSync(output) || statSync(output).size === 0) {
        throw new Error(`shim 构建失败或输出为空：${output}`);
      }
    }
  }
}

// ─── kb-mcp sidecar ────────────────────────────────────────────

function buildSidecar() {
  console.log("[build-win7] 构建 kb-mcp sidecar（win7-compat）...");
  execSync("cargo build -p kb-mcp --release --features win7-compat", {
    cwd: SRC_TAURI,
    stdio: "inherit",
  });
  const src = join(SRC_TAURI, "target", "release", "kb-mcp.exe");
  if (!existsSync(src)) throw new Error(`未找到 sidecar 产物：${src}`);
  mkdirSync(BINARIES, { recursive: true });
  const dst = join(BINARIES, `kb-mcp-${TARGET_TRIPLE}.exe`);
  copyFileSync(src, dst);
  console.log(`[build-win7] sidecar → ${dst}`);
}

// ─── Tauri 配置切换 ────────────────────────────────────────────

function backupConfig() {
  if (existsSync(CONFIG_BACKUP)) {
    console.error("[build-win7] 检测到残留 tauri.conf.json.bak，已自动恢复");
    copyFileSync(CONFIG_BACKUP, CONFIG);
    unlinkSync(CONFIG_BACKUP);
  }
  copyFileSync(CONFIG, CONFIG_BACKUP);
}

function switchConfig(configPath) {
  if (!existsSync(configPath)) throw new Error(`缺少配置：${configPath}`);
  copyFileSync(configPath, CONFIG);
  console.log(`[build-win7] 配置 → ${configPath.split(/[\\/]/).pop()}`);
}

function restoreConfig() {
  if (existsSync(CONFIG_BACKUP)) {
    copyFileSync(CONFIG_BACKUP, CONFIG);
    unlinkSync(CONFIG_BACKUP);
    console.log("[build-win7] 已恢复 tauri.conf.json");
  }
}

function readVersion() {
  const config = JSON.parse(readFileSync(LITE_CONFIG, "utf8"));
  return config.version;
}

// ─── 构建与产物 ────────────────────────────────────────────────

function bundleDir() {
  return join(SRC_TAURI, "target", isDebug ? "debug" : "release", "bundle", "nsis");
}

function findFreshInstaller(startMs) {
  const dir = bundleDir();
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith("_x64-setup.exe") && !f.includes("_win7"))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).mtimeMs >= startMs)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function renameInstaller(installer, variant, version) {
  const dir = dirname(installer);
  for (const file of readdirSync(dir)) {
    if (file.includes(`_win7_${variant}_`) && file.endsWith(".exe")) {
      rmSync(join(dir, file), { force: true });
    }
  }
  const dst = join(dir, `Pomegranate_Setup_${version}_win7_${variant}_x64-setup.exe`);
  renameSync(installer, dst);
  return dst;
}

function runTauriBuild() {
  const args = ["tauri", "build", "--bundles", "nsis", "--features", "win7-compat"];
  if (isDebug) args.push("--debug");
  const command = `pnpm ${args.join(" ")}`;
  console.log(`[build-win7] ${command}`);
  try {
    execSync(command, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, WIN7_BUILD_PROFILE: isDebug ? "debug" : "release" },
    });
  } catch (error) {
    // 常见非零退出：未设置 TAURI_SIGNING_PRIVATE_KEY 时 updater 产物签名失败，
    // 但安装包本身已生成。是否成功以 findFreshInstaller 的 mtime 校验为准。
    console.warn(
      "[build-win7] tauri build 非零退出（签名密钥缺失等），继续校验安装包是否已生成",
    );
  }
}

// ─── 主流程 ────────────────────────────────────────────────────

function main() {
  console.log("[build-win7] === Windows 7 兼容构建开始 ===");
  checkPrerequisites();

  let variants = [...requestedVariants];
  if (variants.includes("full")) {
    if (!existsSync(join(WEBVIEW2_RUNTIME, "msedgewebview2.exe"))) {
      console.warn(
        `[build-win7] 未找到 WebView2 Fixed Runtime：${WEBVIEW2_RUNTIME}\n` +
          "  跳过 full 产物（部署方式见 .gitignore 注释 / 文档）",
      );
      variants = variants.filter((v) => v !== "full");
    }
    if (!existsSync(FULL_CONFIG)) variants = variants.filter((v) => v !== "full");
  }
  if (variants.length === 0) {
    console.error("[build-win7] 没有可构建的 variant");
    process.exit(1);
  }

  const version = readVersion();
  const outputs = [];

  backupConfig();
  try {
    buildShims();
    buildSidecar();

    for (const variant of variants) {
      console.log(`\n[build-win7] ── 构建 ${variant} ──`);
      switchConfig(variant === "full" ? FULL_CONFIG : LITE_CONFIG);
      const started = Date.now();
      runTauriBuild();

      const fresh = findFreshInstaller(started);
      if (!fresh) {
        throw new Error("tauri build 未产出新安装包（前端或 Rust 构建失败）");
      }
      const renamed = renameInstaller(fresh, variant, version);
      outputs.push(renamed);
      console.log(`[build-win7] 产物：${renamed}`);
    }

    console.log("\n[build-win7] === 构建成功 ===");
    for (const output of outputs) console.log(`  ${output}`);
  } finally {
    restoreConfig();
  }
}

try {
  main();
} catch (error) {
  console.error("[build-win7] === 构建失败 ===");
  console.error(error.message);
  process.exitCode = 1;
}
