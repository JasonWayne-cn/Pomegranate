import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { ActiveView } from "@/store";

/**
 * 模块设置中心的类型定义。
 *
 * 设计目标：模块的新增只需补一份 ModuleMeta，不再改 Header / Drawer。
 * 面板分三类：
 *   · schema    —— 扁平配置字段，由抽屉统一表单读写
 *   · component —— 复杂设置组件（模型表格、同步等），组件内部自行保存
 *   · link      —— 跨模块/全局配置，只做跳转
 */

export type ModuleFieldType =
  | "switch"
  | "select"
  | "number"
  | "slider"
  | "text"
  | "textarea"
  | "time";

export interface ModuleConfigField {
  /** registry 内唯一键 */
  key: string;
  /**
   * app_config 中的实际存储键。
   * 不填时使用 `module.<view>.<key>`，便于模块独占配置与后续迁移。
   */
  storageKey?: string;
  label: string;
  type: ModuleFieldType;
  defaultValue: string | number | boolean;
  description?: string;
  options?: Array<{ label: string; value: string | number }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  /** 标记为 true 时，保存后提示需要重启或重新进入页面 */
  requiresRestart?: boolean;
  /**
   * 表单列宽：1 = 半宽（与相邻半宽字段并排一行），缺省 = 整行。
   * 只有在同一 schema 面板里**相邻**的两个 span:1 字段才会排在同行。
   */
  span?: 1 | 2;
  /**
   * 改动立即生效并持久化（不等底部「保存」）。
   * 用于纯展示类开关：用户切换后应当马上看到界面变化。
   */
  instantApply?: boolean;
}

export interface ModulePanelComponentProps {
  compact?: boolean;
}

export interface ModulePanelGroup {
  id: string;
  label: string;
}

export interface ModulePanelDef {
  id: string;
  title: string;
  kind: "schema" | "component" | "link";
  /** 所属分组；模块未定义 groups 时忽略 */
  group?: string;
  description?: string;
  /** kind=schema */
  fields?: ModuleConfigField[];
  /** kind=component：懒加载，避免首屏加载重型设置组件 */
  load?: () => Promise<{ default: ComponentType<ModulePanelComponentProps> }>;
  /** kind=link */
  link?: { to: string; label: string };
}

/**
 * 模块抽屉里的「功能页签」。
 *
 * 用于把完整功能页（如卡片复习 / 定时推送）收进模块设置抽屉，
 * 侧边栏不再单独占一个入口。组件与配置面板同级的懒加载处理。
 */
export interface ModuleFeatureTab {
  /** 页签 key，在模块内唯一 */
  key: string;
  label: string;
  icon: LucideIcon;
  /** 懒加载完整功能页组件 */
  load: () => Promise<{ default: ComponentType }>;
}

export interface ModuleShortcut {
  keys: string;
  desc: string;
}

/**
 * 模块配置保存后广播的 window 事件。
 * 页面可以监听它来即时应用配置（例如重新读取自动保存间隔）。
 */
export const MODULE_CONFIG_CHANGED_EVENT = "module-config-changed";

export interface ModuleMeta {
  view: ActiveView;
  label: string;
  icon: LucideIcon;
  description: string;
  /** 配置面板分组；不填则保持扁平列表 */
  groups?: ModulePanelGroup[];
  panels: ModulePanelDef[];
  /** 额外功能页签（完整功能页），排在「配置 / 使用说明」之后 */
  featureTabs?: ModuleFeatureTab[];
  /** src/modules/help 下的文件名，例如 "notes.md" */
  helpFile: string;
  shortcuts?: ModuleShortcut[];
}

/** 解析字段的实际存储键 */
export function resolveStorageKey(meta: ModuleMeta, field: ModuleConfigField): string {
  return field.storageKey ?? `module.${meta.view}.${field.key}`;
}

/** 把表单值序列化为 app_config 的 TEXT 值 */
export function serializeFieldValue(field: ModuleConfigField, value: unknown): string {
  switch (field.type) {
    case "switch":
      return value ? "1" : "0";
    case "number":
    case "slider": {
      const num = typeof value === "number" ? value : Number(value);
      return Number.isFinite(num) ? String(num) : String(field.defaultValue);
    }
    default:
      return value == null ? "" : String(value);
  }
}

/** 把 app_config 的 TEXT 值还原为表单值 */
export function parseFieldValue(field: ModuleConfigField, raw: string | undefined): unknown {
  if (raw === undefined) return field.defaultValue;
  switch (field.type) {
    case "switch":
      return raw === "1" || raw === "true";
    case "number":
    case "slider": {
      const num = Number(raw);
      return Number.isFinite(num) ? num : field.defaultValue;
    }
    default:
      return raw;
  }
}
