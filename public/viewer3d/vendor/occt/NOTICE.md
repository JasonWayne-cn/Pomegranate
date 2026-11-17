# OCCT 组件声明

本目录包含：

| 文件 | 说明 | 许可证 |
| --- | --- | --- |
| `occt-import-js.js` | occt-import-js 0.0.22 的 Emscripten 加载层 | LGPL-2.1 |
| `occt-import-js.wasm` | 包含 Open CASCADE Technology (OCCT) 的 WASM 构建 | LGPL-2.1 |
| `occt-import-js-worker.js` | Web Worker 入口 | LGPL-2.1 |
| `LICENSE-OCCT-LGPL-2.1.txt` | OCCT 许可证全文 | LGPL-2.1 |
| `LICENSE-occt-import-js-LGPL-2.1.txt` | occt-import-js 许可证全文 | LGPL-2.1 |

## 来源

- occt-import-js：https://github.com/kovacsv/occt-import-js （0.0.22）
- Open CASCADE Technology：https://github.com/Open-Cascade-SAS/OCCT
- WASM 构建工作流：https://github.com/kovacsv/occt-import-js/blob/master/.github/workflows/wasm_build.yml

## 修改说明

本应用未修改 occt-import-js 或 OCCT 源码。仅将 Online 3D Viewer 引擎中
`CreateOcctWorker` 的 CDN 基地址改写为本目录（`scripts/patch-viewer3d-occt.mjs`）。

## 替换方式（LGPL 可替换性）

本目录的 `.js` / `.wasm` 是独立运行时文件，应用不会对其做哈希或签名校验。
你可以用自行构建的 occt-import-js / OCCT 版本替换同名文件，应用会直接加载替换后的版本。
替换时请保留文件名与目录结构，并自行确认构建结果可用。

## 源码获取

见同目录 `SOURCE_OFFER.md`。

> 上述内容为工程合规说明，不构成法律意见；正式发布前请法务确认。
