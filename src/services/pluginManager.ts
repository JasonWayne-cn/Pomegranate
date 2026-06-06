/**
 * PluginManager — 插件运行时核心 v1.0.0
 *
 * 职责：
 * 1. 启动时从后端拉取所有已启用插件列表
 * 2. 读取每个插件的 main.js / styles.css 并执行
 * 3. 管理插件生命周期（activate / deactivate / reload）
 * 4. 单插件崩溃不影响其他插件和主应用
 *
 * 安全模型（R1 修订后）：
 * - 激活时通过 plugin_acquire_token 向 Rust 申领令牌
 * - 停用时通过 plugin_revoke_token 作废令牌
 * - 令牌闭包注入 createAppAPI，插件 JS 无法直接获取
 *
 * 注册表（R4 修订后）：
 * - 内部 Map 存储，key = "<pluginId>:<id>"
 * - 不再使用 window.__plugin* 全局键
 * - PluginManager extends EventTarget 发送 registry 变化事件
 */

import { invoke } from "@tauri-apps/api/core";
import { pluginApi } from "@/lib/api";
import { createAppAPI } from "@/services/pluginApi";
import type {
  PluginInfo,
  PluginContext,
  PluginModule,
  PluginCommandDef,
  PluginSidebarItemDef,
  PluginPanelViewDef,
} from "@/types";

// ───────── 类型 ─────────

interface ActivePlugin {
  info: PluginInfo;
  module: PluginModule;
  /** 插件运行时令牌（Rust 侧签发） */
  token: string;
  /** 注入到 <head> 的样式标签 */
  styleEl: HTMLStyleElement | null;
}

type EventHandler = (...args: unknown[]) => void;

// ───────── 内部工具 ─────────

function executePluginJS(code: string, pluginId: string): PluginModule {
  const wrapped = `
return (function() {
  const module = { exports: {} };
  const exports = module.exports;
  try {
    ${code}
  } catch (e) {
    module.exports = { onLoad: function() { throw e; } };
  }
  return module.exports;
})();
`;

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(wrapped);
    const exports = fn() as PluginModule;
    if (typeof exports !== "object" || exports === null) {
      console.warn(`[PluginManager] 插件 ${pluginId}: main.js 未导出 module.exports 对象，跳过`);
      return {};
    }
    return exports;
  } catch (e) {
    console.error(`[PluginManager] 插件 ${pluginId} 脚本解析失败:`, e);
    return {
      onLoad: () => {
        throw new Error(`插件 ${pluginId} 脚本解析失败: ${e}`);
      },
    };
  }
}

function injectStyle(pluginId: string, css: string): HTMLStyleElement {
  const el = document.createElement("style");
  el.setAttribute("data-plugin-id", pluginId);
  el.textContent = css;
  document.head.appendChild(el);
  return el;
}

function removeStyle(pluginId: string) {
  const el = document.querySelector(`style[data-plugin-id="${pluginId}"]`);
  if (el) el.remove();
}

// ───────── PluginManager ─────────

/** 注册表变化事件类型 */
type RegistryEvent = "commands" | "sidebar" | "views";

export class PluginManager {
  // ─── 注册表（key = "<pluginId>:<id>"）───
  private registry = {
    commands: new Map<string, PluginCommandDef & { pluginId: string }>(),
    sidebar: new Map<string, PluginSidebarItemDef & { pluginId: string }>(),
    panelViews: new Map<string, PluginPanelViewDef>(),
  };

  // ─── 注册表订阅者（简单回调列表，不用 EventTarget）───
  // EventTarget 在 Vite HMR + Tauri WebView 下有时不可靠：旧实例的 listener
  // 注册到了同一个单例上但 React 没重渲染。改用纯回调数组，每次 emit 都遍历调用。
  private subscribers: Record<RegistryEvent, Set<() => void>> = {
    commands: new Set(),
    sidebar: new Set(),
    views: new Set(),
  };

  /** 订阅注册表变化；返回取消订阅函数 */
  subscribe(event: RegistryEvent, handler: () => void): () => void {
    this.subscribers[event].add(handler);
    return () => {
      this.subscribers[event].delete(handler);
    };
  }

  private emit(event: RegistryEvent) {
    for (const fn of this.subscribers[event]) {
      try {
        fn();
      } catch (e) {
        console.error(`[PluginManager] subscriber for ${event} threw:`, e);
      }
    }
  }

  // ─── 事件监听器订阅 ───
  private eventSubscriptions = new Map<string, Map<string, Set<EventHandler>>>();

  /** 当前已激活的插件 */
  private active = new Map<string, ActivePlugin>();

  /** 初始化是否完成 */
  private initialized = false;

  /** 启动时初始化：加载所有已启用插件 */
  async init(): Promise<void> {
    if (this.initialized) {
      console.warn("[PluginManager] 已初始化，跳过重复 init");
      return;
    }

    console.log("[PluginManager] 开始初始化插件运行时...");

    try {
      await pluginApi.scan();
    } catch (e) {
      console.warn("[PluginManager] 扫描插件目录失败（非致命）:", e);
    }

    let plugins: PluginInfo[];
    try {
      plugins = await pluginApi.list();
    } catch (e) {
      console.error("[PluginManager] 获取插件列表失败:", e);
      return;
    }

    const enabled = plugins.filter((p) => p.enabled && p.status === "installed");
    console.log(`[PluginManager] 发现 ${enabled.length} 个已启用插件`);

    for (const plugin of enabled) {
      try {
        await this.activatePlugin(plugin);
      } catch (e) {
        console.error(`[PluginManager] 插件 ${plugin.id} 启动失败:`, e);
      }
    }

    this.initialized = true;
    console.log(`[PluginManager] 初始化完成，${this.active.size} 个插件已激活`);
  }

  /** 激活单个插件 */
  async activatePlugin(info: PluginInfo): Promise<void> {
    if (this.active.has(info.id)) {
      console.warn(`[PluginManager] 插件 ${info.id} 已激活，先停用再重新激活`);
      await this.deactivatePlugin(info.id);
    }

    console.log(`[PluginManager] 激活插件: ${info.id} v${info.version}`);

    // T4: 1. 向 Rust 申领令牌
    let token: string;
    try {
      token = await invoke<string>("plugin_acquire_token", { pluginId: info.id });
    } catch (e) {
      throw new Error(`申领令牌失败: ${e}`);
    }

    // 2. 读取 main.js
    let mainJS: string;
    try {
      mainJS = await pluginApi.readAsset(info.id, info.main);
    } catch (e) {
      // 令牌回滚
      await invoke("plugin_revoke_token", { pluginId: info.id }).catch(() => {});
      throw new Error(`读取 main.js (${info.main}) 失败: ${e}`);
    }

    // 3. 执行 JS 代码
    const pluginModule = executePluginJS(mainJS, info.id);

    // 4. 构造 PluginContext（无 register* 顶层方法）
    const appAPI = createAppAPI(info.id, token, this);

    const ctx: PluginContext = {
      app: appAPI,
      meta: Object.freeze({
        id: info.id,
        name: info.name,
        version: info.version,
        dir: info.path,
      }),
    };

    // 5. 调用 onLoad
    if (typeof pluginModule.onLoad === "function") {
      try {
        await pluginModule.onLoad(ctx);
      } catch (e) {
        // 令牌回滚 + 注册表回滚：onLoad 可能已注册了 sidebar/views/commands
        await invoke("plugin_revoke_token", { pluginId: info.id }).catch(() => {});
        this.cleanupPluginRegistry(info.id);
        throw new Error(`onLoad() 执行失败: ${e}`);
      }
    }

    // 6. 注入 CSS
    let styleEl: HTMLStyleElement | null = null;
    if (info.styles) {
      try {
        const css = await pluginApi.readAsset(info.id, info.styles);
        styleEl = injectStyle(info.id, css);
        console.log(`[PluginManager] 插件 ${info.id} 样式已注入`);
      } catch (e) {
        console.warn(`[PluginManager] 插件 ${info.id} 读取样式失败（非致命）:`, e);
      }
    }

    // 7. 记录激活状态
    this.active.set(info.id, {
      info,
      module: pluginModule,
      token,
      styleEl,
    });

    console.log(`[PluginManager] 插件 ${info.id} 激活成功`);
  }

  /** 停用单个插件
   *
   * 关键顺序：先同步清理注册表 + 派发事件（UI 立即刷新），再异步走 onUnload / 令牌作废。
   * 这样即便 onUnload / Rust 端令牌作废抛错或卡住，左侧侧边栏图标也已经消失，
   * 用户不会看到"已停用但图标还在"的脏状态。
   *
   * 同时无论 active 表里是否有记录都强制清理，覆盖 activatePlugin 半失败留下的
   * "幽灵注册"（onLoad 抛错前已经 addItem，但 this.active.set 未执行）。
   */
  async deactivatePlugin(pluginId: string): Promise<void> {
    const active = this.active.get(pluginId);
    console.log(`[PluginManager] 停用插件: ${pluginId} (active=${!!active})`);

    // 1. ★ 优先同步清理注册表 + 派发事件 —— UI 立即刷新，不依赖后续 await
    this.cleanupPluginRegistry(pluginId);
    removeStyle(pluginId);
    this.active.delete(pluginId);

    // 2. 异步调用 onUnload（仅 active 有记录时；用 active 快照避免上面 delete 后丢失）
    if (active && typeof active.module.onUnload === "function") {
      const appAPI = createAppAPI(pluginId, active.token, this);
      const ctx: PluginContext = {
        app: appAPI,
        meta: Object.freeze({
          id: active.info.id,
          name: active.info.name,
          version: active.info.version,
          dir: active.info.path,
        }),
      };
      try {
        await active.module.onUnload(ctx);
      } catch (e) {
        console.warn(`[PluginManager] 插件 ${pluginId} onUnload 失败（忽略）:`, e);
      }
    }

    // 3. 异步作废令牌（即使失败也不阻塞 UI；Rust 侧无令牌引用最终会过期）
    await invoke("plugin_revoke_token", { pluginId }).catch((e) => {
      console.warn(`[PluginManager] 作废令牌失败（忽略）:`, e);
    });

    console.log(`[PluginManager] 插件 ${pluginId} 已停用`);
  }

  /** 重载插件 */
  async reloadPlugin(pluginId: string): Promise<void> {
    const active = this.active.get(pluginId);
    if (!active) {
      console.warn(`[PluginManager] 插件 ${pluginId} 未激活，无法重载`);
      return;
    }
    await this.deactivatePlugin(pluginId);
    try {
      const updated = await pluginApi.list();
      const info = updated.find((p) => p.id === pluginId);
      if (info && info.enabled) {
        await this.activatePlugin(info);
      } else {
        console.warn(`[PluginManager] 插件 ${pluginId} 已卸载或被禁用，取消重载`);
      }
    } catch (e) {
      console.error(`[PluginManager] 重载插件 ${pluginId} 失败:`, e);
    }
  }

  /** 停用所有已激活插件 */
  async deactivateAll(): Promise<void> {
    const ids = Array.from(this.active.keys());
    for (const id of ids) {
      try {
        await this.deactivatePlugin(id);
      } catch (e) {
        console.error(`[PluginManager] 停用插件 ${id} 失败:`, e);
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // 公共查询方法
  // ═══════════════════════════════════════════════════

  getActiveIds(): string[] {
    return Array.from(this.active.keys());
  }

  isActive(pluginId: string): boolean {
    return this.active.has(pluginId);
  }

  getRegisteredCommands(): PluginCommandDef[] {
    return Array.from(this.registry.commands.values());
  }

  getRegisteredSidebarItems(): PluginSidebarItemDef[] {
    return Array.from(this.registry.sidebar.values());
  }

  getRegisteredPanelViews(): PluginPanelViewDef[] {
    return Array.from(this.registry.panelViews.values());
  }

  getPanelView(viewId: string): PluginPanelViewDef | null {
    // viewId 可能是裸 id（如 "cc-main-view"）或 "<pluginId>:<id>" 全 key。
    // 内部 Map 用全 key 存储，所以先尝试全 key，再按裸 id 在 values 里查找。
    const direct = this.registry.panelViews.get(viewId);
    if (direct) return direct;
    for (const def of this.registry.panelViews.values()) {
      if (def.id === viewId) return def;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════
  // 内部方法（给 createAppAPI 的子 API 调用）
  // ═══════════════════════════════════════════════════

  _addCommand(pluginId: string, def: PluginCommandDef) {
    const key = `${pluginId}:${def.id}`;
    this.registry.commands.set(key, { ...def, pluginId });
    this.emit("commands");
  }

  _removeCommand(pluginId: string, id: string) {
    this.registry.commands.delete(`${pluginId}:${id}`);
    this.emit("commands");
  }

  _executeCommand(fullId: string): void | Promise<void> {
    const cmd = this.registry.commands.get(fullId);
    if (!cmd) throw new Error(`命令 ${fullId} 未注册`);
    return cmd.callback();
  }

  _addSidebarItem(pluginId: string, def: PluginSidebarItemDef) {
    const key = `${pluginId}:${def.id}`;
    this.registry.sidebar.set(key, { ...def, pluginId });
    this.emit("sidebar");
  }

  _removeSidebarItem(pluginId: string, id: string) {
    this.registry.sidebar.delete(`${pluginId}:${id}`);
    this.emit("sidebar");
  }

  _registerPanelView(pluginId: string, def: PluginPanelViewDef) {
    const key = `${pluginId}:${def.id}`;
    this.registry.panelViews.set(key, { ...def, pluginId });
    this.emit("views");
  }

  _unregisterPanelView(pluginId: string, id: string) {
    this.registry.panelViews.delete(`${pluginId}:${id}`);
    this.emit("views");
  }

  _addEventListener<K extends string>(
    pluginId: string,
    event: K,
    handler: (data: unknown) => void,
  ): () => void {
    if (!this.eventSubscriptions.has(pluginId)) {
      this.eventSubscriptions.set(pluginId, new Map());
    }
    const pluginEvents = this.eventSubscriptions.get(pluginId)!;
    if (!pluginEvents.has(event)) {
      pluginEvents.set(event, new Set());
    }
    pluginEvents.get(event)!.add(handler as EventHandler);
    return () => {
      pluginEvents.get(event)?.delete(handler as EventHandler);
    };
  }

  // ═══════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════

  /** 按插件前缀批量清理注册表 */
  private cleanupPluginRegistry(pluginId: string) {
    const prefix = `${pluginId}:`;
    for (const key of [...this.registry.commands.keys()]) {
      if (key.startsWith(prefix)) this.registry.commands.delete(key);
    }
    for (const key of [...this.registry.sidebar.keys()]) {
      if (key.startsWith(prefix)) this.registry.sidebar.delete(key);
    }
    for (const key of [...this.registry.panelViews.keys()]) {
      if (key.startsWith(prefix)) this.registry.panelViews.delete(key);
    }
    // 清理事件订阅
    this.eventSubscriptions.delete(pluginId);

    this.emit("commands");
    this.emit("sidebar");
    this.emit("views");
  }
}

/** 全局单例 */
export const pluginManager = new PluginManager();
