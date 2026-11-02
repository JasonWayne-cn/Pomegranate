#!/usr/bin/env node
/**
 * 准备 PPT 模板测试包：
 * - aviation_training_blue → 用户自定义模板包（可导入）
 * - 其余 6 套           → 系统默认模板包（用于重建扩展）
 *
 * 用法：
 *   node scripts/prepare-ppt-template-test-packs.mjs
 *   node scripts/prepare-ppt-template-test-packs.mjs --ppt-master-root "D:/AI/ALL-PPT/ppt-master-main"
 *   node scripts/prepare-ppt-template-test-packs.mjs --out "test-data/ppt-templates"
 */

import fs from "node:fs";
import path from "node:path";
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
const pptMasterRoot = path.resolve(
  args["ppt-master-root"] ??
    process.env.PPT_MASTER_ROOT ??
    "D:/AI/ALL-PPT/ppt-master-main",
);
const outDir = path.resolve(
  args.out ?? path.join(projectRoot, "test-data", "ppt-templates"),
);
const layoutsRoot = path.join(
  pptMasterRoot,
  "skills",
  "ppt-master",
  "templates",
  "layouts",
);

const USER_LAYOUT = "aviation_training_blue";
const SYSTEM_LAYOUTS = [
  "insight_explainer",
  "kpi_report_core",
  "mbb_dense_report",
  "oriental_classic_research",
  "premium_strategy_dark",
  "tech_compare_dark",
];

if (!fs.existsSync(layoutsRoot)) {
  throw new Error(`未找到上游模板目录: ${layoutsRoot}`);
}
for (const id of [USER_LAYOUT, ...SYSTEM_LAYOUTS]) {
  if (!fs.existsSync(path.join(layoutsRoot, id))) {
    throw new Error(`缺少模板: ${id}`);
  }
}

// 只清理本脚本管理的产物，保留 extension-build/ 等测试构建目录。
fs.mkdirSync(outDir, { recursive: true });
for (const name of ["user", "system", "system-templates-6.zip", "README.md"]) {
  fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
}
const userRoot = path.join(outDir, "user");
const systemRoot = path.join(outDir, "system");
const systemLayouts = path.join(systemRoot, "layouts");
fs.mkdirSync(userRoot, { recursive: true });
fs.mkdirSync(systemLayouts, { recursive: true });

copyDir(path.join(layoutsRoot, USER_LAYOUT), path.join(userRoot, USER_LAYOUT));
for (const id of SYSTEM_LAYOUTS) {
  copyDir(path.join(layoutsRoot, id), path.join(systemLayouts, id));
}

const index = JSON.parse(
  fs.readFileSync(path.join(layoutsRoot, "layouts_index.json"), "utf8"),
);
const systemIndex = {};
for (const id of SYSTEM_LAYOUTS) {
  if (index[id]) systemIndex[id] = index[id];
}
fs.writeFileSync(
  path.join(systemLayouts, "layouts_index.json"),
  `${JSON.stringify(systemIndex, null, 2)}\n`,
  "utf8",
);
fs.writeFileSync(
  path.join(userRoot, "layouts_index.json"),
  `${JSON.stringify({ [USER_LAYOUT]: index[USER_LAYOUT] ?? {} }, null, 2)}\n`,
  "utf8",
);

writeReadme();

const userZip = path.join(userRoot, `${USER_LAYOUT}-user.zip`);
zipDir(path.join(userRoot, USER_LAYOUT), userZip);
const systemZip = path.join(outDir, "system-templates-6.zip");
zipDir(systemRoot, systemZip);

console.log(`[packs] 输出目录: ${outDir}`);
console.log(`[packs] 用户模板包: ${path.join(userRoot, USER_LAYOUT)}`);
console.log(`[packs] 用户 zip:   ${userZip}`);
console.log(`[packs] 系统模板包: ${systemLayouts}（6 套）`);
console.log(`[packs] 系统 zip:   ${systemZip}`);

function writeReadme() {
  const content = `# PPT 模板测试包

由 \`scripts/prepare-ppt-template-test-packs.mjs\` 生成。

## user/aviation_training_blue

- 用途：测试「用户自定义模板」导入。
- 方式一：打开 **扩展包 → 模板库 → 导入文件夹**，选择 \`user/aviation_training_blue\`。
- 方式二：**导入 zip**，选择 \`user/aviation_training_blue-user.zip\`。
- 也可以直接把文件夹或 zip 拖进模板库页面。

## system/layouts

- 用途：作为「系统默认模板包」（6 套）。
- 测试时需要重建扩展包，并指定：

\`\`\`bash
node scripts/build-ppt-extension.mjs \\
  --ppt-master-root "${pptMasterRoot.replace(/\\/g, "/")}" \\
  --layouts-dir "${systemLayouts.replace(/\\/g, "/")}" \\
  --out "${path.join(outDir, "extension-build").replace(/\\/g, "/")}" \\
  --version "1.2.6-system6"
\`\`\`

- 输出：\`extension-build/ppt-master-extension-1.2.6-system6-win7-x64.zip\`
- 使用独立版本号，避免与已安装的 1.2.5 冲突；安装后可在扩展页回滚到 1.2.5。
- 说明：只有测试「系统默认模板」才需要重建扩展；普通用户模板导入不需要。
- \`system-templates-6.zip\` 只是同一份系统包的压缩存档，便于分发。

## 关于 exports/

- 两套测试包都保留了各模板 \`exports/*_template_preview.pptx\`，方便对照母版/版式。
- 这些 preview PPTX 只用于人工审阅，**不会被应用导入或安装**；应用只读取 \`templates/\`、\`images/\`、\`icons/\`。
`;
  fs.writeFileSync(path.join(outDir, "README.md"), content, "utf8");
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // 保留 exports/：其中的 *_template_preview.pptx 是模板审阅证据，
    // 便于测试时对照母版调整；应用导入时会忽略 exports/。
    if (["__pycache__", ".git"].includes(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function zipDir(srcDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  if (process.platform === "win32") {
    const quote = (value) => value.replace(/'/g, "''");
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -Path '${quote(path.join(srcDir, "*"))}' -DestinationPath '${quote(zipPath)}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("zip", ["-r", zipPath, "."], { cwd: srcDir, stdio: "inherit" });
  }
}
