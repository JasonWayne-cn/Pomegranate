/** 上次会话快照：只记录路径，恢复时重新打开。 */
export const SESSION_STORAGE_KEY = "office.session.v1";

export interface OfficeSessionSnapshot {
  paths: string[];
  activePath: string | null;
}

export function parseSessionSnapshot(raw: string | null): OfficeSessionSnapshot | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const paths = (value as { paths?: unknown }).paths;
    if (!Array.isArray(paths)) return null;
    const clean = paths.filter((item): item is string => typeof item === "string" && !!item);
    if (clean.length === 0) return null;
    const activePath = (value as { activePath?: unknown }).activePath;
    return {
      paths: clean,
      activePath: typeof activePath === "string" ? activePath : null,
    };
  } catch {
    return null;
  }
}
