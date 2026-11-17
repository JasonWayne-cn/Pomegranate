# OCCT / occt-import-js 源码获取说明

本应用分发 occt-import-js 0.0.22 及其内置的 Open CASCADE Technology (OCCT) WASM，
两者均以 **LGPL-2.1** 分发。根据 LGPL 对应源码（Corresponding Source）要求：

## 对应源码

| 组件 | 版本/来源 |
| --- | --- |
| occt-import-js | 0.0.22，https://github.com/kovacsv/occt-import-js/tree/0.0.22 |
| occt-import-js npm 包 | https://registry.npmjs.org/occt-import-js/-/occt-import-js-0.0.22.tgz |
| OCCT | occt-import-js 0.0.22 的 WASM 构建所固定的 OCCT 版本，源码：https://github.com/Open-Cascade-SAS/OCCT |
| WASM 构建脚本 | https://github.com/kovacsv/occt-import-js/blob/master/.github/workflows/wasm_build.yml |

本应用对 occt-import-js / OCCT **未做源码修改**；仅改写了 Online 3D Viewer
引擎中的 CDN 基地址（见 `scripts/patch-viewer3d-occt.mjs`），该改写不涉及 OCCT 源码。

## 书面要约

如无法从上述地址获取对应源码，可通过项目仓库 Issue 联系维护者，
我们会在合理期限内提供 occt-import-js 0.0.22 及其 OCCT 构建对应的完整源码与构建说明。
该要约自本版本发布之日起三年内有效。

## 可替换性

`occt-import-js.js` 与 `occt-import-js.wasm` 以独立文件形式随应用分发，应用不做
哈希/签名校验；用户可以替换为本机构建的版本。替换说明见 `NOTICE.md`。

> 本文为工程合规材料，不构成法律意见；发布前请法务确认。
