# Vendored GenOffice engines

这些目录是从 GenOffice 仓库 vendored 的纯 TypeScript 文档引擎，用于在 WebView 内做
PPTX 解析 / RenderTree 渲染 / 原字节保存的 P0 Spike。

- 上游：genoffice（Apache-2.0）
- 版本：commit `19a389b3`（2026-11-17）
- 复制范围：
  - `packages/zip-gate/src` → `zip-gate/`
  - `packages/pptx-engine/src` → `pptx-engine/`
  - `packages/pptx-render/src` → `pptx-render/`
  - `packages/docx-engine/src` → `docx-engine/`
  - `packages/agent-core/src/redact-range.ts` → `agent-core/redact-range.ts`

## 本地适配（未修改上游源码）

- `node:crypto` / `node:zlib` 通过 Vite alias 指向 `shims/` 下的浏览器实现
- `Buffer` 由 `src/lib/office/polyfills.ts` 注入 `globalThis`
- 上游源码保持原样，便于后续按 commit 对比升级

## 升级流程

```bash
# 1. 查看上游是否有新提交（不复制）
node scripts/sync-genoffice-vendor.mjs --source D:/AI/ALL-PPT/genoffice --check

# 2. 同步源码并自动重新应用本地 @ts-nocheck 补丁
pnpm vendor:genoffice -- --source D:/AI/ALL-PPT/genoffice

# 3. 回归
npx tsc --noEmit
npx vitest run src/lib/office
npx vite build
```

升级前先看上游 `packages/{pptx,docx}-engine` 的导出变化；本项目只依赖
`openPptx/savePptx`、`parseDocx/saveDocx`、`buildRenderSlide` 等公共入口。

## 许可

- `LICENSE`、`NOTICE` 来自上游根目录，必须随分发保留
- 本项目整体为 AGPL-3.0；Apache-2.0 → AGPL-3.0 为单向兼容
