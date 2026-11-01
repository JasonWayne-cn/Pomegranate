#!/usr/bin/env node
/**
 * 构建 PPT Master 扩展包（本地 zip）。
 *
 * 用法：
 *   node scripts/build-ppt-extension.mjs
 *   node scripts/build-ppt-extension.mjs --ppt-master-root "D:/path/to/ppt-master"
 *   node scripts/build-ppt-extension.mjs --python-runtime "D:/path/to/python-embed"
 *   node scripts/build-ppt-extension.mjs --signing-key "D:/keys/extension-private.pem"
 *
 * 输出：
 *   dist/extensions/ppt-master-extension-<version>-win7-x64.zip
 *
 * 签名可选。签名后需把构建日志中的 base64 公钥配置到主程序环境变量
 * PPT_EXTENSION_PUBLIC_KEY，否则主程序会拒绝安装带签名的包。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith("--")) {
      args[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sourceDir = path.join(projectRoot, "extensions", "ppt-master");
const outDir = path.resolve(args.out ?? path.join(projectRoot, "dist", "extensions"));
const buildDir = path.resolve(projectRoot, "build", "ppt-extension");
const pptMasterRoot = args["ppt-master-root"] ?? process.env.PPT_MASTER_ROOT ?? "";
const pythonRuntime = args["python-runtime"] ?? process.env.PYTHON_RUNTIME ?? "";
const signingKey = args["signing-key"] ?? process.env.PPT_EXTENSION_SIGNING_KEY ?? "";

if (!fs.existsSync(path.join(sourceDir, "extension.json"))) {
  throw new Error(`扩展源目录缺少 extension.json: ${sourceDir}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "extension.json"), "utf8"));
const packName = `ppt-master-extension-${manifest.version}-win7-x64`;
const stageDir = path.join(buildDir, packName);

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

copyDir(sourceDir, stageDir);
fs.mkdirSync(path.join(stageDir, "templates", "layouts"), { recursive: true });
fs.mkdirSync(path.join(stageDir, "templates", "charts"), { recursive: true });

if (pptMasterRoot) {
  const skillRoot = path.join(pptMasterRoot, "skills", "ppt-master");
  const scripts = path.join(skillRoot, "scripts");
  if (fs.existsSync(scripts)) {
    const skillStage = path.join(stageDir, "ppt-master", "skills", "ppt-master");
    copyDir(scripts, path.join(skillStage, "scripts"));
    // svg_to_pptx.py 会校验归属文件与 SKILL.md，必须原样保留。
    for (const name of [
      "LICENSE",
      "SPONSORS.md",
      "SPONSORS_CN.md",
      "SKILL.md",
      "requirements.txt",
    ]) {
      copyIfExists(path.join(skillRoot, name), path.join(skillStage, name));
    }
    console.log(`[build] 已复制 ppt-master scripts 与归属文件`);
  } else {
    console.warn(`[build] 未找到 scripts：${scripts}`);
  }

  copyIfExists(
    path.join(skillRoot, "templates", "layouts"),
    path.join(stageDir, "templates", "layouts"),
  );
  // 部分上游版本把图表模板放在 templates-old/charts，兼容回退。
  const chartsSource = path.join(skillRoot, "templates", "charts");
  const chartsFallback = path.join(skillRoot, "templates-old", "charts");
  if (fs.existsSync(chartsSource)) {
    copyDir(chartsSource, path.join(stageDir, "templates", "charts"));
  } else if (fs.existsSync(chartsFallback)) {
    copyDir(chartsFallback, path.join(stageDir, "templates", "charts"));
    console.log("[build] 未找到 templates/charts，已使用 templates-old/charts");
  } else {
    console.warn(`[build] 未找到图表模板: ${chartsSource}`);
  }
  for (const name of ["design_spec_reference.md", "spec_lock_reference.md"]) {
    copyIfExists(
      path.join(skillRoot, "templates", name),
      path.join(stageDir, "templates", name),
    );
  }
} else {
  console.warn("[build] 未提供 --ppt-master-root，扩展包仅包含内置渲染器与 python-pptx 导出");
}

// 上游存在“目录已放入但尚未登记”的模板（例如 aviation_training_blue）。
// 当前扩展只消费 layouts_index.json，这里把此类目录自动补进包内索引。
registerUnindexedLayouts(stageDir);
enrichLayoutSupport(stageDir);

if (pythonRuntime) {
  const target = path.join(stageDir, "runtime", "python");
  copyDir(pythonRuntime, target);
  const exe = path.join(target, "python.exe");
  if (!fs.existsSync(exe)) {
    console.warn(`[build] 内嵌 Python 目录未找到 python.exe：${target}`);
  } else {
    manifest.runtime.type = "python-embedded";
    manifest.runtime.python = {
      ...(manifest.runtime.python ?? {}),
      path: "runtime/python/python.exe",
    };
    fs.writeFileSync(
      path.join(stageDir, "extension.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    console.log("[build] 已内置 Python 运行时");
  }
} else {
  console.warn("[build] 未提供 --python-runtime，扩展将使用系统 python（需 3.8+，推荐 3.10+）");
}

const checksums = {};
for (const file of listFiles(stageDir)) {
  const rel = path.relative(stageDir, file).replace(/\\/g, "/");
  checksums[rel] = sha256File(file);
}
const checksumsPath = path.join(stageDir, "checksums.json");
fs.writeFileSync(checksumsPath, `${JSON.stringify(checksums, null, 2)}\n`, "utf8");

// 签名覆盖 checksums.json；主程序验签后再逐个校验清单里的文件哈希。
manifest.integrity = {
  ...(manifest.integrity ?? {}),
  sha256: sha256File(checksumsPath),
  signature: null,
};
if (signingKey) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(signingKey));
  const signature = crypto.sign(null, fs.readFileSync(checksumsPath), privateKey);
  manifest.integrity.signature = signature.toString("base64");
  const publicDer = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" });
  const rawPublicKey = publicDer.subarray(publicDer.length - 32);
  console.log(
    `[build] 公钥（PPT_EXTENSION_PUBLIC_KEY）: ${rawPublicKey.toString("base64")}`,
  );
  console.log(`[build] 已签名 checksums.json`);
} else {
  console.warn("[build] 未提供 --signing-key，扩展包不带签名");
}
fs.writeFileSync(
  path.join(stageDir, "extension.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `${packName}.zip`);
fs.rmSync(zipPath, { force: true });
// Windows 自带 tar 对 -a/zip 的支持不稳定，统一用 Compress-Archive。
const psQuote = (value) => value.replace(/'/g, "''");
const psCommand =
  `Compress-Archive -Path '${psQuote(path.join(stageDir, "*"))}' ` +
  `-DestinationPath '${psQuote(zipPath)}' -Force`;
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], {
  stdio: "inherit",
});

const size = fs.statSync(zipPath).size;
console.log(`[build] 完成: ${zipPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);

function registerUnindexedLayouts(stage) {
  const layoutsRoot = path.join(stage, "templates", "layouts");
  const indexFile = path.join(layoutsRoot, "layouts_index.json");
  if (!fs.existsSync(indexFile)) return;
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  let changed = false;
  for (const entry of fs.readdirSync(layoutsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (index[id]) continue;
    const templateDir = path.join(layoutsRoot, id, "templates");
    const specFile = path.join(templateDir, "design_spec.md");
    if (!fs.existsSync(specFile)) continue;
    const svgs = fs
      .readdirSync(templateDir)
      .filter((name) => name.toLowerCase().endsWith(".svg"))
      .sort();
    if (!svgs.length) continue;
    const frontmatter = readFrontmatter(specFile);
    index[id] = {
      summary: frontmatter.summary || id,
      canvas_format: frontmatter.canvas_format || "ppt169",
      page_count: svgs.length,
      page_types: svgs.map(derivePageType),
    };
    changed = true;
    console.log(`[build] 已为未注册模板注入索引: ${id}`);
  }
  if (changed) {
    fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
}

/**
 * 在构建期统计每个版式的结构化/{{}} 支持度，写入 layouts_index.json。
 * 运行时 catalog 只读索引，不再逐个扫描 SVG。
 */
function enrichLayoutSupport(stage) {
  const layoutsRoot = path.join(stage, "templates", "layouts");
  const indexFile = path.join(layoutsRoot, "layouts_index.json");
  if (!fs.existsSync(indexFile)) return;
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  let changed = false;
  for (const [id, meta] of Object.entries(index)) {
    if (!meta || typeof meta !== "object") continue;
    const dir = path.join(layoutsRoot, id);
    const templatesDir = fs.existsSync(path.join(dir, "templates"))
      ? path.join(dir, "templates")
      : dir;
    if (!fs.existsSync(templatesDir)) continue;
    const svgs = fs
      .readdirSync(templatesDir)
      .filter((name) => name.toLowerCase().endsWith(".svg"));
    let structured = 0;
    let legacy = 0;
    for (const name of svgs) {
      const text = fs.readFileSync(path.join(templatesDir, name), "utf8");
      if (text.includes("data-pptx-placeholder")) structured += 1;
      if (text.includes("{{")) legacy += 1;
    }
    meta.structured = structured;
    meta.legacy = legacy;
    meta.supportsStructured = structured > 0;
    meta.supportsLegacy = legacy > 0;
    if (!meta.page_count) meta.page_count = svgs.length;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
}

function readFrontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const result = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function derivePageType(fileName) {
  return fileName
    .replace(/\.svg$/i, "")
    .replace(/^\d+[a-z]?_/, "");
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === ".git") continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return;
  if (fs.statSync(from).isDirectory()) copyDir(from, to);
  else fs.copyFileSync(from, to);
}

function* listFiles(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* listFiles(full);
    else yield full;
  }
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}
