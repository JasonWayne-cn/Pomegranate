#!/usr/bin/env node
/**
 * 同步内置插件：dev-plugins/<id> → src-tauri/resources/plugins/<id>
 *
 * 这些副本会随安装包分发，主程序首次启动时自动安装到用户插件目录。
 * 修改 dev-plugins 下的插件后需重新运行本脚本并提交资源副本。
 *
 * 用法：
 *   node scripts/sync-bundled-plugins.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// 需要随安装包内置的插件 ID（与 Rust 端 BUNDLED_PLUGINS 保持一致）
const BUNDLED_PLUGINS = ["research-assistant"];

// 不同步的开发产物
const SKIP_NAMES = new Set(["test", "node_modules", ".git", ".DS_Store"]);

function copyDir(source, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

for (const id of BUNDLED_PLUGINS) {
  const source = path.join(projectRoot, "dev-plugins", id);
  const dest = path.join(projectRoot, "src-tauri", "resources", "plugins", id);
  if (!fs.existsSync(source)) {
    console.warn(`[sync-bundled-plugins] 跳过 ${id}：源目录不存在 ${source}`);
    continue;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  copyDir(source, dest);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, "plugin.json"), "utf8"),
  );
  console.log(
    `[sync-bundled-plugins] ${id} v${manifest.version} → ${path.relative(projectRoot, dest)}`,
  );
}
