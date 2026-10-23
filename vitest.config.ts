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
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
