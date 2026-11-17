#!/usr/bin/env node
/**
 * 把 Online 3D Viewer 内置引擎里的 OCCT CDN 地址改写成本地 vendor 路径。
 *
 * 上游 `CreateOcctWorker` 硬编码：
 *   https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/
 *
 * 注意：OCCT Worker 是从 Blob URL 创建的，Blob Worker 的基址是 `blob:`，
 * 根相对路径（/viewer3d/...）在 `importScripts` 中会被判定为非法 URL。
 * 因此必须改写为绝对 URL：`new URL(..., location.href).href`。
 *
 * 幂等：已改写过则直接跳过。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const enginePath = path.resolve(__dirname, "../public/viewer3d/o3dv.min.js");

const CDN_QUOTED = '"https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/"';
const LOCAL_QUOTED = '"/viewer3d/vendor/occt/"';
const LOCAL_EXPR =
  '(new URL("/viewer3d/vendor/occt/",location.href).href)';

const source = readFileSync(enginePath, "utf8");

if (source.includes(LOCAL_EXPR)) {
  console.log("[viewer3d] OCCT 已是绝对本地路径，跳过补丁");
  process.exit(0);
}

let patched = null;
if (source.includes(CDN_QUOTED)) {
  patched = source.split(CDN_QUOTED).join(LOCAL_EXPR);
} else if (source.includes(LOCAL_QUOTED)) {
  // 兼容旧版补丁写入的根相对路径
  patched = source.split(LOCAL_QUOTED).join(LOCAL_EXPR);
}

if (patched === null) {
  console.error(
    "[viewer3d] 未找到 OCCT CDN 地址，上游引擎版本可能变化，请检查 importerutils 的 CreateOcctWorker",
  );
  process.exit(1);
}

writeFileSync(enginePath, patched, "utf8");
console.log("[viewer3d] OCCT 路径已改为绝对 URL: new URL('/viewer3d/vendor/occt/', location.href)");
