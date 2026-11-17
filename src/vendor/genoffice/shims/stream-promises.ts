/**
 * `node:stream/promises` 的浏览器替身。
 *
 * 仅 `savePptxToFile()` 动态引用；WebView 不调用该函数。
 */
export function pipeline(): never {
  throw new Error("node:stream/promises.pipeline 在浏览器环境不可用");
}
