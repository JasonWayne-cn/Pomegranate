// @ts-nocheck -- vendored 上游源码：上游使用自己的 tsconfig（未开 noUnusedLocals）。
/** Vite-style raw text import (the op guides ship as markdown); bundlers outside Vite need a matching loader */
declare module '*.md?raw' {
  const text: string
  export default text
}
