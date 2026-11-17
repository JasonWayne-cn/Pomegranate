import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 前端单元测试配置（独立于 vite.config.ts，避免污染打包配置）。
 * 当前只覆盖纯函数，environment 用 node 即可。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
  resolve: {
    alias: [
      // 测试跑在 Node 环境：node:crypto / node:zlib 使用原生实现，
      // 只把 @genoffice/* 指到 vendored 源码。
      {
        find: /^@genoffice\/agent-core\/redact-range$/,
        replacement: fileURLToPath(
          new URL("./src/vendor/genoffice/agent-core/redact-range.ts", import.meta.url),
        ),
      },
      {
        find: /^@genoffice\/zip-gate$/,
        replacement: fileURLToPath(
          new URL("./src/vendor/genoffice/zip-gate/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@genoffice\/zip-gate\/(.*)$/,
        replacement: fileURLToPath(
          new URL("./src/vendor/genoffice/zip-gate/$1", import.meta.url),
        ),
      },
      {
        find: /^@genoffice\/pptx-engine$/,
        replacement: fileURLToPath(
          new URL("./src/vendor/genoffice/pptx-engine/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@genoffice\/pptx-engine\/(.*)$/,
        replacement: fileURLToPath(
          new URL("./src/vendor/genoffice/pptx-engine/$1", import.meta.url),
        ),
      },
      {
        find: /^@genoffice\/pptx-render$/,
        replacement: fileURLToPath(
          new URL("./src/vendor/genoffice/pptx-render/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@genoffice\/pptx-render\/(.*)$/,
        replacement: fileURLToPath(
          new URL("./src/vendor/genoffice/pptx-render/$1", import.meta.url),
        ),
      },
      {
        find: /^@genoffice\/docx-engine$/,
        replacement: fileURLToPath(
          new URL("./src/vendor/genoffice/docx-engine/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@genoffice\/docx-engine\/(.*)$/,
        replacement: fileURLToPath(
          new URL("./src/vendor/genoffice/docx-engine/$1", import.meta.url),
        ),
      },
      { find: /^@\/(.*)$/, replacement: fileURLToPath(new URL("./src/$1", import.meta.url)) },
    ],
  },
});
