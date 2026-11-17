import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** 把 Excalidraw 字体同步到 public/excalidraw/fonts，供白板离线使用。 */
function excalidrawAssetsPlugin() {
  const srcDir = path.resolve(
    __dirname,
    "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
  );
  const destDir = path.resolve(__dirname, "public/excalidraw/fonts");

  const copyDir = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name);
      const d = path.join(to, entry.name);
      if (entry.isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  };

  return {
    name: "kb-excalidraw-assets",
    buildStart() {
      if (!fs.existsSync(srcDir)) {
        console.warn("[excalidraw] 未找到字体源目录，跳过同步:", srcDir);
        return;
      }
      if (
        fs.existsSync(destDir) &&
        fs.readdirSync(destDir).length === fs.readdirSync(srcDir).length
      ) {
        return;
      }
      fs.rmSync(destDir, { recursive: true, force: true });
      copyDir(srcDir, destDir);
      console.log("[excalidraw] 字体已同步到 public/excalidraw/fonts");
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), excalidrawAssetsPlugin()],

  // Office 引擎 Worker 内部使用 dynamic import（docx-engine 按需加载），
  // IIFE 不支持 code-splitting，必须用 ES module worker。
  worker: { format: "es" },

  resolve: {
    alias: [
      // GenOffice 引擎：用正则区分包根与子路径，避免
      // `@genoffice/pptx-engine/table-grid` 被包根规则吞掉。
      {
        find: /^@genoffice\/agent-core\/redact-range$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/agent-core/redact-range.ts"),
      },
      {
        find: /^@genoffice\/zip-gate$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/zip-gate/index.ts"),
      },
      {
        find: /^@genoffice\/zip-gate\/(.*)$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/zip-gate/$1"),
      },
      {
        find: /^@genoffice\/pptx-engine$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/pptx-engine/index.ts"),
      },
      {
        find: /^@genoffice\/pptx-engine\/(.*)$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/pptx-engine/$1"),
      },
      {
        find: /^@genoffice\/pptx-render$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/pptx-render/index.ts"),
      },
      {
        find: /^@genoffice\/pptx-render\/(.*)$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/pptx-render/$1"),
      },
      {
        find: /^@genoffice\/docx-engine$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/docx-engine/index.ts"),
      },
      {
        find: /^@genoffice\/docx-engine\/(.*)$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/docx-engine/$1"),
      },
      {
        find: /^@genoffice\/pptx-ops$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/pptx-ops/index.ts"),
      },
      {
        find: /^@genoffice\/pptx-ops\/(.*)$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/pptx-ops/$1"),
      },
      // WebView 没有 Node 内置模块；只替换引擎实际用到的两个。
      { find: /^node:crypto$/, replacement: path.resolve(__dirname, "src/vendor/genoffice/shims/crypto.ts") },
      { find: /^node:zlib$/, replacement: path.resolve(__dirname, "src/vendor/genoffice/shims/zlib.ts") },
      { find: /^node:fs$/, replacement: path.resolve(__dirname, "src/vendor/genoffice/shims/fs.ts") },
      {
        find: /^node:stream\/promises$/,
        replacement: path.resolve(__dirname, "src/vendor/genoffice/shims/stream-promises.ts"),
      },
      { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, "src/$1") },
    ],
  },

  build: {
    // 生产构建优化
    // ⚠️ macOS 12 Monterey 自带 WKWebView = Safari 15.6，不支持 ES2023
    // (Array.findLast / toSorted / toReversed 等)。esnext 不做任何转译，
    // 一旦项目依赖（tiptap 3 / antd 6 / lucide 等）输出 ES2023 语法就会
    // 抛 SyntaxError 让整个 chunk 加载失败 → 白屏。
    // 把 target 限到 safari15 让 esbuild 把 ES2023 降级到 ES2020 兼容代码。
    // chrome88/edge88/firefox88 是 antd 6 官方最低门槛，对齐避免漏网。
    target: ["es2020", "safari15", "chrome88", "edge88", "firefox88"],
    minify: "terser",
    terserOptions: {
      compress: { drop_console: true, drop_debugger: true },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-antd": ["antd", "@ant-design/icons"],
          "vendor-editor": ["@tiptap/react", "@tiptap/starter-kit"],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },

  clearScreen: false,
  server: {
    port: 2010,
    strictPort: true,
    // 显式绑定 IPv4：Node 17+ 下 host=false 会按 localhost 解析，可能只监听 [::1]，
    // 而 WebView2 子资源走 127.0.0.1 → 模块加载 ERR_CONNECTION_REFUSED，界面卡骨架屏。
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 2020,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
