/**
 * 使用说明按需加载。
 *
 * 说明文件随应用打包（离线可用），但通过 import.meta.glob 懒加载，
 * 不进入首屏 bundle；只有用户点开「使用说明」时才加载对应 Markdown。
 */
const HELP_LOADERS = import.meta.glob("./help/*.md", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

export async function loadModuleHelp(fileName: string): Promise<string | null> {
  const loader = HELP_LOADERS[`./help/${fileName}`];
  if (!loader) return null;
  try {
    return await loader();
  } catch (e) {
    console.error(`[module-help] 加载 ${fileName} 失败:`, e);
    return null;
  }
}
