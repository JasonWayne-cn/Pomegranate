import { useEffect, useRef, useState } from "react";
import { moduleConfigApi } from "@/lib/api";
import { MODULE_CONFIG_CHANGED_EVENT } from "@/modules/types";
import type { ActiveView } from "@/store";

export interface ModuleConfigState<T> {
  values: T;
  /** 是否已完成首次读取；未完成前 values 为默认值 */
  loaded: boolean;
}

/**
 * 读取某个模块的轻量配置。
 *
 * - 默认存储键：`module.<view>.<field>`
 * - 需要复用已有 app_config 键时，通过 storageKeys 映射
 * - 数值/布尔值按默认值的类型自动还原
 * - 抽屉保存后广播 `module-config-changed`，此处自动重读
 *
 * 读取失败时保持默认值，不打断页面主流程。
 */
export function useModuleConfig<T extends Record<string, unknown>>(
  view: ActiveView,
  defaults: T,
  storageKeys?: Partial<Record<keyof T, string>>,
): ModuleConfigState<T> {
  const [values, setValues] = useState<T>(defaults);
  const [loaded, setLoaded] = useState(false);

  // 调用方可能内联传对象，用 ref 保证读取的是最新值且不触发重复请求
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const storageKeysRef = useRef(storageKeys);
  storageKeysRef.current = storageKeys;

  useEffect(() => {
    let alive = true;

    async function load() {
      const defs = defaultsRef.current;
      const keyMap = storageKeysRef.current;
      const fieldToStorageKey = new Map<string, string>();

      for (const field of Object.keys(defs)) {
        fieldToStorageKey.set(
          field,
          keyMap?.[field as keyof T] ?? `module.${view}.${field}`,
        );
      }

      try {
        const stored = await moduleConfigApi.getMany([
          ...fieldToStorageKey.values(),
        ]);
        if (!alive) return;

        const next: Record<string, unknown> = { ...defs };
        for (const [field, storageKey] of fieldToStorageKey) {
          const raw = stored[storageKey];
          if (raw !== undefined) {
            next[field] = coerceValue(raw, defs[field]);
          }
        }
        setValues(next as T);
      } catch {
        // 配置读取失败：保留默认值，页面照常工作
      } finally {
        if (alive) setLoaded(true);
      }
    }

    void load();

    const onConfigChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: string }>).detail;
      if (detail?.view === view) void load();
    };
    window.addEventListener(MODULE_CONFIG_CHANGED_EVENT, onConfigChanged);

    return () => {
      alive = false;
      window.removeEventListener(MODULE_CONFIG_CHANGED_EVENT, onConfigChanged);
    };
  }, [view]);

  return { values, loaded };
}

function coerceValue(raw: string, fallback: unknown): unknown {
  if (typeof fallback === "boolean") {
    return raw === "1" || raw === "true";
  }
  if (typeof fallback === "number") {
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  }
  return raw;
}
