import { Store } from "@tauri-apps/plugin-store";

/** 与主 store 同口径：dev / prod 数据隔离 */
const STORE_FILE = import.meta.env.DEV ? "dev-settings.json" : "settings.json";
const EXPORT_DIR_KEY = "pptLastExportDir";

/** 读取最近一次选择的 PPT 导出目录。 */
export async function loadLastExportDir(): Promise<string | null> {
  try {
    const store = await Store.load(STORE_FILE);
    const saved = await store.get<string>(EXPORT_DIR_KEY);
    return typeof saved === "string" && saved.trim() ? saved : null;
  } catch {
    return null;
  }
}

/** 记住最近一次选择的 PPT 导出目录。 */
export async function saveLastExportDir(path: string): Promise<void> {
  try {
    const store = await Store.load(STORE_FILE);
    await store.set(EXPORT_DIR_KEY, path);
    await store.save();
  } catch {
    // 偏好保存失败不应阻塞导出流程
  }
}
