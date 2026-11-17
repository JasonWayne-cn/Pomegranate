/**
 * `node:fs` 的浏览器替身。
 *
 * GenOffice 引擎只在 `savePptxToFile()` 里动态引用它；WebView 不会调用该函数。
 * 这里显式抛错，避免 Vite 把 Node 内置模块外置成不可用桩后静默失败。
 */
export function createWriteStream(): never {
  throw new Error("node:fs.createWriteStream 在浏览器环境不可用");
}
