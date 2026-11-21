import { useEffect, useRef } from "react";
import { ConfigProvider, theme, App as AntdApp, message } from "antd";
import GlobalNativeTooltip from "@/components/GlobalNativeTooltip";
import zhCN from "antd/locale/zh_CN";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useAppStore } from "@/store";
import { AppRouter } from "@/Router";
import { getAntdTokens } from "@/theme/tokens";
import { TaskReminderListener } from "@/components/tasks/TaskReminderListener";
import { MigrationCrashNotice } from "@/components/datadir/MigrationCrashNotice";
import { ExitConfirmListener } from "@/components/ui/ExitConfirmListener";
import { CloseRequestedListener } from "@/components/ui/CloseRequestedListener";
import { UpdaterProvider } from "@/components/updater/UpdaterProvider";
import { AppLockGate } from "@/components/applock/AppLockGate";
import { pluginManager } from "@/services/pluginManager";
import { EditorRegistryProvider, initEditorRegistry } from "@/components/editor";
import { pptTemplateApi } from "@/lib/api/pptTemplate";

// 紧急提醒窗口 / 迁移 splash 等子窗口共用同一个 React bundle，
// 但只有 main 窗口才需要挂全局提醒监听器，否则子窗口也会响应 task:reminder
// 重复弹 Modal，且子窗口没有 antd App context 会异常
const IS_MAIN_WINDOW = (() => {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
})();

function App() {
  const themeCategory = useAppStore((s) => s.themeCategory);
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const uiScale = useAppStore((s) => s.uiScale);
  // 主题覆盖：开关启用 + customAccent 时，把 antd 的 colorPrimary 同步到自定义色，
  // 让 Button/Switch/Tabs 等内置组件的主色与 CSS 变量一致（仅靠 --kb-primary 不够，
  // antd 组件用的是 ConfigProvider token，不读 CSS 变量）。
  const themeOverridesEnabled = useAppStore((s) => s.themeOverridesEnabled);
  const customAccent = useAppStore((s) => s.customAccent);
  const activeTheme = themeCategory === "light" ? lightTheme : darkTheme;
  const baseTokens = {
    ...getAntdTokens(activeTheme),
    ...(themeOverridesEnabled && customAccent
      ? { colorPrimary: customAccent }
      : {}),
  };
  // 全局界面缩放：把 antd 的 fontSize / controlHeight / padding 等关键 token
  // 按 uiScale 倍率联动。1.0 时与 antd 默认完全一致；< 1 紧凑、> 1 放大。
  // 自定义 CSS 通过 :root --ui-scale 由 store 同步（见 applyUiScale）。
  const scaledTokens = {
    ...baseTokens,
    fontSize: Math.round(14 * uiScale),
    fontSizeSM: Math.round(12 * uiScale),
    fontSizeLG: Math.round(16 * uiScale),
    fontSizeXL: Math.round(20 * uiScale),
    fontSizeHeading1: Math.round(38 * uiScale),
    fontSizeHeading2: Math.round(30 * uiScale),
    fontSizeHeading3: Math.round(24 * uiScale),
    fontSizeHeading4: Math.round(20 * uiScale),
    fontSizeHeading5: Math.round(16 * uiScale),
    controlHeight: Math.round(32 * uiScale),
    controlHeightSM: Math.round(24 * uiScale),
    controlHeightLG: Math.round(40 * uiScale),
    paddingXS: Math.round(8 * uiScale),
    paddingSM: Math.round(12 * uiScale),
    padding: Math.round(16 * uiScale),
    paddingLG: Math.round(24 * uiScale),
  };

  // 同步主题到 DOM，供 CSS 选择器使用
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", activeTheme);
    document.documentElement.setAttribute("data-theme-category", themeCategory);
  }, [activeTheme, themeCategory]);

  // 监听 db:reloaded：从 zip 导入快照后 Rust 侧会热重载 Connection 并 emit 此事件，
  // 前端收到后批量 bump 各 refresh tick，让所有视图（文档列表 / 文件夹 / 标签 / 任务）
  // 自动重拉数据。无需重启应用。
  useEffect(() => {
    if (!IS_MAIN_WINDOW) return;
    // listen() 返回 Promise，async cleanup 必须用"取消标志 + then 内判断"模式，
    // 否则 React 严格模式 / 快速 remount 时第一次的 listener 永远不被 unlisten
    // （cleanup 跑时 unlisten 还没 resolve），导致重复注册 → 事件触发两次。
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen("db:reloaded", () => {
      const s = useAppStore.getState();
      s.bumpNotesRefresh();
      s.bumpFoldersRefresh();
      s.bumpTagsRefresh();
      s.bumpTasksListRefresh();
      s.refreshTaskStats();
      message.success("数据已重载");
    }).then((fn) => {
      if (cancelled) {
        fn(); // 已 unmount，立即解绑避免泄漏
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 监听 db:external-changed：外部 agent（kb-mcp 独立进程）或内置 AI 的 in-memory MCP
  // 写入文档/任务后，Rust 侧后台 watcher 轮询 PRAGMA data_version 侦测到变化并 emit 此事件。
  // 前端据此静默重拉各列表（不弹 message，避免外部频繁写入时刷屏）。
  useEffect(() => {
    if (!IS_MAIN_WINDOW) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    // trailing 节流：AI 连续调写工具时事件会在一两秒内连发多次，每次都全量重拉
    // 文档 / 文件夹 / 标签 / 任务会让界面反复刷新、滚动跳动。合并成静默期结束后的一次刷新。
    let timer: number | undefined;
    const flush = () => {
      timer = undefined;
      const s = useAppStore.getState();
      s.bumpNotesRefresh();
      s.bumpFoldersRefresh();
      s.bumpTagsRefresh();
      s.bumpTasksListRefresh();
      void s.refreshTaskStats();
    };
    listen("db:external-changed", () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(flush, 600);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  // 紧急窗口（独立 webview）改完任务后通过 Tauri 事件通知主窗刷新列表/角标。
  // Zustand store 是 per-webview 的，子窗口 set state 主窗拿不到，所以必须走事件桥。
  useEffect(() => {
    if (!IS_MAIN_WINDOW) return;
    // 同上方两个监听的取消标志：严格模式 / 快速 remount 时 cleanup 早于 listen resolve，
    // 不加标志第一次注册的监听永远解不掉，事件触发两次 → 任务列表重复重拉
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen("tasks:list-refresh", () => {
      const s = useAppStore.getState();
      s.bumpTasksListRefresh();
      void s.refreshTaskStats();
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 启动时重扫用户模板目录：手动拷贝进 ppt-templates/ 的模板无需重启即可注册。
  useEffect(() => {
    if (!IS_MAIN_WINDOW) return;
    void pptTemplateApi
      .reconcile()
      .then((report) => {
        if (
          report.added.length ||
          report.updated.length ||
          report.removed.length
        ) {
          window.dispatchEvent(new Event("app:ppt-templates-changed"));
        }
      })
      .catch(() => undefined);
  }, []);

  // 插件运行时初始化（仅主窗口，非阻塞）
  const pluginInitStarted = useRef(false);
  const editorInitStarted = useRef(false);
  useEffect(() => {
    if (!IS_MAIN_WINDOW || pluginInitStarted.current) return;
    pluginInitStarted.current = true;

    void pluginManager.init();
    if (!editorInitStarted.current) {
      editorInitStarted.current = true;
      initEditorRegistry();
    }

    const handleBeforeUnload = () => {
      void pluginManager.deactivateAll();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm:
          themeCategory === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: scaledTokens,
      }}
    >
      <AntdApp style={{ height: "100%" }}>
        <EditorRegistryProvider>
        <ErrorBoundary>
          <UpdaterProvider enabled={IS_MAIN_WINDOW}>
            {/* 应用启动锁仅作用于主窗口：子窗口（quick-add/紧急提醒/pop-out）从已解锁会话派生，不再拦截 */}
            {IS_MAIN_WINDOW ? (
              <AppLockGate>
                <AppRouter />
              </AppLockGate>
            ) : (
              <AppRouter />
            )}
          </UpdaterProvider>
          {IS_MAIN_WINDOW && <TaskReminderListener />}
          {/* 🔴 两个退出监听器必须挂在 AppLockGate **外面**：锁屏时 AppLockGate 会整页替换
              children，挂在 AppLayout 里的话它们会随之卸载 —— 那样锁屏状态下点窗口关闭按钮
              没有任何组件接管（Rust 侧已 prevent_close），窗口就彻底关不掉了。
              且两者必须同进同出：CloseRequestedListener 选「退出程序」是靠 emit
              `tray:request-exit` 转交给 ExitConfirmListener 的，少挂一个就是一条死路。
              它们只监听事件、平时不渲染任何东西，放在这里零成本。 */}
          {IS_MAIN_WINDOW && <ExitConfirmListener />}
          {IS_MAIN_WINDOW && <CloseRequestedListener />}
          {/* 上次数据目录迁移失败时给用户重试 / 放弃的出口（marker.status=crashed 才渲染） */}
          {IS_MAIN_WINDOW && <MigrationCrashNotice />}
        </ErrorBoundary>
        </EditorRegistryProvider>
      </AntdApp>
      <GlobalNativeTooltip />
    </ConfigProvider>
  );
}

export default App;
