/**
 * 设置配置备份（.kbconfig）：收集可移植设置、预览、筛选、导入。
 *
 * 复用 `configShare` 的 envelope：
 *   - `kind = "bundle"`
 *   - 新增 `uiPrefs`（界面/编辑器偏好快照）、`appConfig`（白名单 app_config）
 *   - 模型 / 同步源 / ASR 复用现有序列化
 *
 * 安全约定：
 *   - 含密钥（API Key、WebDAV 密码、S3 Secret、Jina Key、ASR Key）时，
 *     导出端必须用 PIN 加密；导入端拒绝明文含密钥的包。
 *   - 只读白名单键；未知 / 损坏数据在导入前整体校验，校验失败不写入任何设置。
 */

import {
  aiModelApi,
  asrApi,
  configApi,
  moduleConfigApi,
  syncV1Api,
} from "@/lib/api";
import {
  applyEnvelope,
  exportAiModel,
  exportBundle,
  exportSyncBackend,
  BACKUP_VERSION,
  ENVELOPE_VERSION,
  type AiModelData,
  type BundleData,
  type Envelope,
  type SyncBackendData,
} from "@/lib/configShare";
import {
  applyPortableUiPrefs,
  getPortableUiPrefs,
  useAppStore,
} from "@/store";
import { MODULE_CONFIG_CHANGED_EVENT } from "@/modules/types";
import type { AppConfig, SyncBackend } from "@/types";

// ──────────────────────────────────────────────────────────
// 白名单
// ──────────────────────────────────────────────────────────

/** 可移植的精确 app_config 键 */
export const PORTABLE_CONFIG_KEYS = [
  // 启动 / 关闭
  "start_minimized",
  "window.close_action",
  // 自动更新（安装时机可选；一次性标记不导出）
  "update.auto_check",
  "update.install_timing",
  // 提醒音
  "reminder_sound_enabled",
  "reminder_sound_normal",
  "reminder_sound_urgent",
  "reminder_sound_volume",
  "reminder_sound_repeat",
  // 待办 / 视图
  "all_day_reminder_time",
  "task_recognize_mode",
  "enabled_views",
  "mobile_dashboard_items",
  "mobile_tab_keys",
  // MCP 权限
  "ai_writable",
  "mcp_tool_whitelist",
] as const;

/** 模块设置中心统一键前缀（`module.<view>.<field>`） */
export const PORTABLE_CONFIG_PREFIXES = ["module."] as const;

/** 密钥类配置：仅在「包含密钥」时导出 */
export const SECRET_CONFIG_KEYS = new Set(["web_clip_jina_key"]);

/**
 * 显式排除的键（防未来白名单 / 前缀误收）。
 *
 * 多数本来就不在白名单里，列出是为了让「为什么它没被备份」有据可查：
 * 本地 id、本机路径、PIN 哈希、MCP token、同步时间戳 / 速率状态。
 */
export const EXCLUDED_CONFIG_KEYS = new Set([
  "default_folder_id",
  "default_tag_ids",
  "daily.default_template_id",
  "daily_note.md_storage_path",
  // 旧版 WebDAV 配置：v1 同步源已覆盖，单独导出会得到半套配置
  "sync.webdav_url",
  "sync.webdav_username",
  "sync.auto_enabled",
  "sync.auto_interval_min",
  // 会话 / 隐私
  "research.currentProjectId",
  "quick_capture_draft",
  // 一次性更新标记
  "update.install_next_launch_version",
  "update.banner_dismissed_version",
  // 应用锁（PIN 哈希 / 盐）
  "app_lock_hash",
  "app_lock_salt",
  "app_lock_fail_count",
  "app_lock_locked_until",
  "app_lock_hint",
  "app_lock_auto_minutes",
  // 文件夹监听（本机路径 + 本地文件夹 id）
  "folder_watch_enabled",
  "folder_watch_dir",
  "folder_watch_target_folder_id",
  "folder_watch_delete_source",
]);

/** 同步源配置里的敏感字段（按同步源类型） */
const SYNC_SECRET_FIELDS: Record<string, readonly string[]> = {
  webdav: ["password"],
  s3: ["secretKey", "accessKey"],
};

export type BackupCategory =
  | "uiPrefs"
  | "appConfig"
  | "aiModels"
  | "syncBackends"
  | "asrConfig";

export const BACKUP_CATEGORY_LABELS: Record<BackupCategory, string> = {
  uiPrefs: "界面与编辑器偏好",
  appConfig: "应用行为设置",
  aiModels: "模型服务",
  syncBackends: "同步源",
  asrConfig: "语音识别",
};

export const ALL_BACKUP_CATEGORIES: BackupCategory[] = [
  "uiPrefs",
  "appConfig",
  "aiModels",
  "syncBackends",
  "asrConfig",
];

export interface BackupPreviewItem {
  category: BackupCategory;
  label: string;
  /** 该分类包含的条目数（uiPrefs/appConfig 为键数） */
  count: number;
  detail: string;
  hasSecrets: boolean;
  /** 导入后需要用户注意的事项 */
  warnings: string[];
}

export interface BackupApplySummary {
  uiPrefs: number;
  appConfig: number;
  aiModels: number;
  syncBackends: number;
  asrConfig: boolean;
  skipped: string[];
  errors: string[];
  warnings: string[];
}

// ──────────────────────────────────────────────────────────
// 纯函数
// ──────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPortableConfigKey(key: string): boolean {
  if (EXCLUDED_CONFIG_KEYS.has(key)) return false;
  if ((PORTABLE_CONFIG_KEYS as readonly string[]).includes(key)) return true;
  return PORTABLE_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * 过滤 app_config：只留白名单键；密钥键按开关处理。
 *
 * 保留原始字符串值（app_config 本身存的就是字符串），写入端用批量事务。
 */
export function filterPortableConfig(
  entries: AppConfig[],
  includeSecrets: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of entries) {
    const isSecret = SECRET_CONFIG_KEYS.has(key);
    // 密钥键不在普通白名单里，单独放行（是否导出由 includeSecrets 决定）
    if (!isPortableConfigKey(key) && !isSecret) continue;
    if (isSecret && !includeSecrets) continue;
    out[key] = value;
  }
  return out;
}

function syncConfigHasSecret(
  kind: string,
  config: Record<string, unknown>,
): boolean {
  const fields = SYNC_SECRET_FIELDS[kind] ?? [];
  return fields.some((field) => {
    const v = config[field];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/** 去掉同步源配置里的敏感字段（不改原对象） */
export function redactSyncSecrets(data: SyncBackendData): SyncBackendData {
  const fields = SYNC_SECRET_FIELDS[data.kind] ?? [];
  if (fields.length === 0) return data;
  const config = { ...data.config };
  for (const field of fields) delete config[field];
  return { ...data, config };
}

/** 判断备份内容里是否含有任何敏感凭据 */
export function backupHasSecrets(data: BundleData): boolean {
  if (data.appConfig) {
    for (const [key, value] of Object.entries(data.appConfig)) {
      if (SECRET_CONFIG_KEYS.has(key) && value.trim()) return true;
    }
  }
  if (data.webdavBackends?.some((b) => !!b.config.password)) return true;
  if (
    data.syncBackends?.some((b) => syncConfigHasSecret(b.kind, b.config))
  ) {
    return true;
  }
  if (data.aiModels?.some((m) => !!m.api_key)) return true;
  if (data.asrConfig?.apiKey) return true;
  return false;
}

/**
 * 导入前的结构校验：任何一项损坏都返回原因，调用方据此**不写入**。
 *
 * 只校验结构与基本类型；字段语义（地址是否可用等）由后端导入时处理。
 */
export function validateBackupData(data: BundleData): string | null {
  if (!isPlainObject(data)) return "备份内容不是对象";

  if (data.uiPrefs !== undefined) {
    if (!isPlainObject(data.uiPrefs)) return "界面偏好数据损坏";
    if (typeof data.uiPrefs.version !== "number") return "界面偏好缺少版本号";
    if (!isPlainObject(data.uiPrefs.values)) return "界面偏好内容损坏";
  }

  if (data.appConfig !== undefined) {
    if (!isPlainObject(data.appConfig)) return "应用设置数据损坏";
    for (const [key, value] of Object.entries(data.appConfig)) {
      if (typeof value !== "string") return `应用设置项 ${key} 的值不是字符串`;
    }
  }

  if (data.aiModels !== undefined && !Array.isArray(data.aiModels)) {
    return "模型服务列表损坏";
  }
  if (data.syncBackends !== undefined && !Array.isArray(data.syncBackends)) {
    return "同步源列表损坏";
  }
  if (data.webdavBackends !== undefined && !Array.isArray(data.webdavBackends)) {
    return "旧版同步源列表损坏";
  }
  if (data.asrConfig !== undefined && !isPlainObject(data.asrConfig)) {
    return "语音识别配置损坏";
  }
  if (data.featureToggles !== undefined && !isPlainObject(data.featureToggles)) {
    return "旧版功能开关数据损坏";
  }

  return null;
}

/** 生成导入预览（不写任何数据） */
export function describeBackup(data: BundleData): BackupPreviewItem[] {
  const items: BackupPreviewItem[] = [];

  if (data.uiPrefs) {
    const count = Object.keys(data.uiPrefs.values ?? {}).length;
    items.push({
      category: "uiPrefs",
      label: BACKUP_CATEGORY_LABELS.uiPrefs,
      count,
      detail: `${count} 项界面 / 编辑器偏好`,
      hasSecrets: false,
      warnings:
        data.uiPrefs.version > BACKUP_VERSION
          ? ["备份版本较新，未知偏好项将被忽略"]
          : [],
    });
  }

  const appConfigCount = data.appConfig
    ? Object.keys(data.appConfig).length
    : 0;
  if (appConfigCount > 0 || data.featureToggles) {
    const secretCount = data.appConfig
      ? Object.entries(data.appConfig).filter(
          ([key, value]) => SECRET_CONFIG_KEYS.has(key) && value.trim(),
        ).length
      : 0;
    items.push({
      category: "appConfig",
      label: BACKUP_CATEGORY_LABELS.appConfig,
      count: appConfigCount + (data.featureToggles ? 1 : 0),
      detail:
        `${appConfigCount} 项应用设置` +
        (data.featureToggles ? " + 旧版功能开关" : "") +
        (secretCount > 0 ? `（含 ${secretCount} 个密钥）` : ""),
      hasSecrets: secretCount > 0,
      warnings: data.featureToggles
        ? ["包含旧版功能开关，将与应用设置一并导入"]
        : [],
    });
  }

  if (data.aiModels?.length) {
    const secretCount = data.aiModels.filter((m) => !!m.api_key).length;
    items.push({
      category: "aiModels",
      label: BACKUP_CATEGORY_LABELS.aiModels,
      count: data.aiModels.length,
      detail:
        `${data.aiModels.length} 个模型` +
        (secretCount > 0 ? `（含密钥 ${secretCount} 个）` : "（不含密钥）"),
      hasSecrets: secretCount > 0,
      warnings: [],
    });
  }

  const syncCount =
    (data.syncBackends?.length ?? 0) + (data.webdavBackends?.length ?? 0);
  if (syncCount > 0) {
    const secrets =
      (data.syncBackends ?? []).filter((b) =>
        syncConfigHasSecret(b.kind, b.config),
      ).length + (data.webdavBackends ?? []).filter((b) => !!b.config.password).length;
    const localCount =
      (data.syncBackends ?? []).filter((b) => b.kind === "local").length;
    const warnings: string[] = [];
    if (localCount > 0) {
      warnings.push(`${localCount} 个本地同步源的路径可能不适用于本机`);
    }
    if (data.webdavBackends?.length) {
      warnings.push("包含旧版 WebDAV 同步源");
    }
    items.push({
      category: "syncBackends",
      label: BACKUP_CATEGORY_LABELS.syncBackends,
      count: syncCount,
      detail:
        `${syncCount} 个同步源` +
        (secrets > 0 ? `（含凭据 ${secrets} 个）` : "（不含凭据）"),
      hasSecrets: secrets > 0,
      warnings,
    });
  }

  if (data.asrConfig) {
    items.push({
      category: "asrConfig",
      label: BACKUP_CATEGORY_LABELS.asrConfig,
      count: 1,
      detail: data.asrConfig.apiKey
        ? "语音识别配置（含密钥）"
        : "语音识别配置（不含密钥）",
      hasSecrets: !!data.asrConfig.apiKey,
      warnings: data.asrConfig.apiKey
        ? []
        : ["不含密钥时会以关闭状态导入，补填 Key 后可手动启用"],
    });
  }

  return items;
}

/** 按分类筛出要导入的子集（不改原对象） */
export function pickBackup(
  data: BundleData,
  categories: BackupCategory[],
): BundleData {
  const selected = new Set(categories);
  const out: BundleData = {};
  if (data.backupVersion !== undefined) out.backupVersion = data.backupVersion;

  if (selected.has("uiPrefs") && data.uiPrefs) out.uiPrefs = data.uiPrefs;

  if (selected.has("appConfig")) {
    if (data.appConfig) out.appConfig = data.appConfig;
    // 旧版功能开关并入「应用行为」分类
    if (data.featureToggles) out.featureToggles = data.featureToggles;
  }

  if (selected.has("aiModels") && data.aiModels) out.aiModels = data.aiModels;

  if (selected.has("syncBackends")) {
    if (data.syncBackends) out.syncBackends = data.syncBackends;
    if (data.webdavBackends) out.webdavBackends = data.webdavBackends;
  }

  if (selected.has("asrConfig") && data.asrConfig) out.asrConfig = data.asrConfig;

  return out;
}

// ──────────────────────────────────────────────────────────
// 收集（导出）
// ──────────────────────────────────────────────────────────

/**
 * 收集一份完整备份并组装 envelope。
 *
 * `hasSecrets` 供 UI 强制 PIN：为 true 时调用方必须用 `stringifyEncrypted`。
 */
export async function collectSettingsBackup(
  categories: BackupCategory[],
  includeSecrets: boolean,
): Promise<{ envelope: Envelope; hasSecrets: boolean }> {
  const selected = new Set(categories);
  const data: BundleData = { backupVersion: BACKUP_VERSION };

  if (selected.has("uiPrefs")) {
    data.uiPrefs = {
      version: BACKUP_VERSION,
      values: getPortableUiPrefs(),
    };
  }

  if (selected.has("appConfig")) {
    const all = await configApi.getAll();
    data.appConfig = filterPortableConfig(all, includeSecrets);
  }

  if (selected.has("aiModels")) {
    const models = await aiModelApi.list();
    const exported: AiModelData[] = [];
    for (const model of models) {
      // P0-1b 起列表里的 api_key 恒为 null，明文只能显式取
      let apiKey: string | null = null;
      if (includeSecrets) {
        apiKey = await aiModelApi.getApiKey(model.id).catch(() => null);
      }
      const env = exportAiModel(model, apiKey);
      if (env.kind === "ai-model") exported.push(env.data);
    }
    data.aiModels = exported;
  }

  if (selected.has("syncBackends")) {
    const backends: SyncBackend[] = await syncV1Api.listBackends();
    const exported: SyncBackendData[] = [];
    for (const backend of backends) {
      const env = exportSyncBackend(backend);
      if (env.kind !== "sync-backend") continue;
      const item = includeSecrets ? env.data : redactSyncSecrets(env.data);
      exported.push(item);
    }
    data.syncBackends = exported;
  }

  if (selected.has("asrConfig")) {
    const cfg = await asrApi.getConfig();
    // 后端保存时「启用」会强校验 Key 非空：不带密钥的包里先置为关闭，
    // 对方补填 Key 后再启用，避免整个分类导入失败。
    data.asrConfig = includeSecrets
      ? cfg
      : { ...cfg, apiKey: "", enabled: false };
  }

  return { envelope: exportBundle(data), hasSecrets: backupHasSecrets(data) };
}

// ──────────────────────────────────────────────────────────
// 导入（写入）
// ──────────────────────────────────────────────────────────

/** 把 app_config 写入后，把 store 里缓存的同名配置重新拉一遍 */
async function refreshStoreBackedConfig(keys: string[]): Promise<void> {
  const state = useAppStore.getState();
  const jobs: Promise<void>[] = [];
  if (keys.includes("enabled_views")) jobs.push(state.loadEnabledViews());
  if (keys.includes("mobile_dashboard_items")) {
    jobs.push(state.loadMobileDashboardItems());
  }
  if (keys.includes("mobile_tab_keys")) jobs.push(state.loadMobileTabKeys());
  if (keys.includes("ai_writable")) jobs.push(state.loadAiWritable());
  await Promise.all(jobs);

  // 通知已打开的模块配置面板重读（抽屉 / 页面各自订阅自己的 view）
  const views = new Set(
    keys
      .filter((key) => key.startsWith("module."))
      .map((key) => key.split(".")[1])
      .filter(Boolean),
  );
  for (const view of views) {
    window.dispatchEvent(
      new CustomEvent(MODULE_CONFIG_CHANGED_EVENT, { detail: { view } }),
    );
  }
}

/**
 * 执行导入。
 *
 * 前置：`validateBackupData` 通过。校验失败直接抛错，不写入任何设置。
 * 分类之间不做回滚（与现有 `applyEnvelope` 一致），单类失败计入 errors。
 */
export async function applySettingsBackup(
  data: BundleData,
  categories: BackupCategory[],
): Promise<BackupApplySummary> {
  const invalid = validateBackupData(data);
  if (invalid) throw new Error(invalid);

  const picked = pickBackup(data, categories);
  const summary: BackupApplySummary = {
    uiPrefs: 0,
    appConfig: 0,
    aiModels: 0,
    syncBackends: 0,
    asrConfig: false,
    skipped: [],
    errors: [],
    warnings: [],
  };

  // 1. app_config：再过滤一次白名单（防手工构造的备份往数据库塞任意键）
  if (picked.appConfig) {
    const rawEntries: AppConfig[] = Object.entries(picked.appConfig).map(
      ([key, value]) => ({ key, value }),
    );
    const safe = filterPortableConfig(rawEntries, true);
    const entries: AppConfig[] = Object.entries(safe).map(([key, value]) => ({
      key,
      value,
    }));
    const dropped = rawEntries.filter((e) => !(e.key in safe));
    if (dropped.length > 0) {
      summary.skipped.push(...dropped.map((e) => `appConfig.${e.key}`));
    }
    if (entries.length > 0) {
      try {
        await moduleConfigApi.setMany(entries);
        summary.appConfig = entries.length;
        await refreshStoreBackedConfig(entries.map((e) => e.key));
      } catch (e) {
        summary.errors.push(`应用设置写入失败：${e}`);
      }
    }
  }

  // 2. 界面偏好：逐键校验后批量 setState + 落盘
  if (picked.uiPrefs) {
    try {
      const result = await applyPortableUiPrefs(picked.uiPrefs.values);
      summary.uiPrefs = result.applied;
      summary.skipped.push(...result.skipped.map((key) => `uiPrefs.${key}`));
    } catch (e) {
      summary.errors.push(`界面偏好恢复失败：${e}`);
    }
  }

  // 3. 模型 / 同步源 / ASR / 旧版功能开关：复用现有导入流程
  const rest: BundleData = {
    ...picked,
    uiPrefs: undefined,
    appConfig: undefined,
  };
  const hasRest =
    !!rest.aiModels ||
    !!rest.syncBackends ||
    !!rest.webdavBackends ||
    !!rest.asrConfig ||
    !!rest.featureToggles;

  if (hasRest) {
    try {
      const sub = await applyEnvelope({
        kbConfig: ENVELOPE_VERSION,
        kind: "bundle",
        exportedAt: new Date().toISOString(),
        data: rest,
      });
      summary.aiModels = sub.aiModels;
      summary.syncBackends = sub.syncBackends;
      summary.asrConfig = sub.asrConfig;
      summary.errors.push(...sub.errors);
      summary.warnings.push(...sub.warnings);
    } catch (e) {
      summary.errors.push(`配置导入失败：${e}`);
    }
  }

  return summary;
}
