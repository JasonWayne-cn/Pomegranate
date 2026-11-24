import { createHashRouter, Navigate, RouterProvider } from "react-router-dom";
import { Suspense, lazy } from "react";
import { Spin } from "antd";
import { LayoutSwitch } from "@/components/layout/LayoutSwitch";
import { OnboardingProvider } from "@/components/onboarding/OnboardingProvider";
import { RouteErrorFallback } from "@/components/ui/ErrorBoundary";
// 首屏常用页面 — 同步加载，不拆 chunk
import HomePage from "@/pages/home";
import NoteListPage from "@/pages/notes";
import NoteEditorPage from "@/pages/notes/editor";
import OpeningNotePage from "@/pages/notes/opening";
import SearchPage from "@/pages/search";
import TagsPage from "@/pages/tags";
import TrashPage from "@/pages/trash";
import DailyPage from "@/pages/daily";
import SettingsPage from "@/pages/settings";
import AboutPage from "@/pages/about";
import { useIsMobile } from "@/hooks/useIsMobile";
// 非首屏页面 — React.lazy 动态加载，减少主 bundle 体积
const GraphPage = lazy(() => import("@/pages/graph"));
const AiChatPage = lazy(() => import("@/pages/ai"));
const MobileAiChat = lazy(() => import("@/pages/ai/MobileAiChat").then(m => ({ default: m.MobileAiChat })));
const MobileTaskDetail = lazy(() => import("@/pages/tasks/MobileTaskDetail").then(m => ({ default: m.MobileTaskDetail })));
const MobileSync = lazy(() => import("@/pages/sync/MobileSync").then(m => ({ default: m.MobileSync })));
const TasksPage = lazy(() => import("@/pages/tasks"));
const MountsPage = lazy(() => import("@/pages/mounts"));
const CardsPage = lazy(() => import("@/pages/cards"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const PluginPanelViewPage = lazy(() => import("@/pages/plugins/PluginPanelViewPage"));
const PptPage = lazy(() => import("@/pages/ppt"));
const ResearchPage = lazy(() => import("@/pages/research"));
const HiddenPage = lazy(() => import("@/pages/hidden"));
const QuickCreatePage = lazy(() => import("@/pages/quick-create"));
const QuickCapturePage = lazy(() => import("@/pages/quick-capture"));
const FeatureTogglePage = lazy(() => import("@/pages/feature-toggle"));
const MigrationSplash = lazy(() => import("@/pages/migration-splash"));
const EmergencyReminderPage = lazy(() => import("@/pages/emergency-reminder"));
const TaskSessionPage = lazy(() => import("@/pages/task-session"));
const PushPage = lazy(() => import("@/pages/push"));
const PptxSpikePage = lazy(() => import("@/pages/pptx-spike"));
const OfficeWorkspacePage = lazy(() => import("@/pages/office"));
const WhiteboardPage = lazy(() => import("@/pages/whiteboard"));
const PushPopupPage = lazy(() => import("@/pages/push-popup"));
const MindMapPopoutPage = lazy(() => import("@/pages/mindmap-popout"));
const QuickAddPage = lazy(() => import("@/pages/quick-add"));
const PrintPage = lazy(() => import("@/pages/print"));

/**
 * /about 入口分流：
 * - 桌面端：设置内容已整体移到关于页，直接渲染设置 Tab 页面
 * - 移动端：设置/关于是两套页面，保留原「关于」信息页
 */
function AboutRoute() {
  const isMobile = useIsMobile();
  return isMobile ? <AboutPage /> : <SettingsPage />;
}

/** 懒加载页面统一 Suspense fallback */
function LazyPage({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full min-h-[200px]">
          <Spin />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

// 路由级 errorElement：路由内任何同步渲染异常（如 TipTap 在老 WebView 上
// 的 lookbehind 正则解析失败）都会被 RouteErrorFallback 接管，给用户友好
// 提示而非 react-router v7 默认的"Hey developer"开发警告页。
const router = createHashRouter([
  // T-013 完整版：迁移 splash 独立 URL，不走 AppLayout（启动期 db 还没初始化）
  {
    path: "/migration-splash",
    element: <LazyPage><MigrationSplash /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  // 紧急待办接管窗口：独立 URL，不挂 AppLayout，避免 Sider/Header 跑出来
  {
    path: "/emergency-reminder/:id",
    element: <LazyPage><EmergencyReminderPage /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  // 定时推送居中弹窗：独立 URL，不挂 AppLayout
  {
    path: "/push-popup/:logId",
    element: <LazyPage><PushPopupPage /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  // 思维导图独立弹窗：纯导图视图，不挂 AppLayout
  {
    path: "/mindmap-popout/:noteId",
    element: <LazyPage><MindMapPopoutPage /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  // 快速记一笔：独立悬浮窗，不挂 AppLayout
  {
    path: "/quick-add",
    element: <LazyPage><QuickAddPage /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  // R-005b 专用打印窗口：独立 URL，不挂 AppLayout
  {
    path: "/print",
    element: <LazyPage><PrintPage /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  // 移动端 AI 聊天页：独立全屏路由（不走 MobileLayout / AppLayout）
  {
    path: "/ai-chat/:id",
    element: <LazyPage><MobileAiChat /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  // 闪念捕获：沉浸式橙色全屏，独立路由（不显示底栏）
  {
    path: "/quick-capture",
    element: <LazyPage><QuickCapturePage /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  // 任务详情：沉浸式全屏，独立路由
  {
    path: "/task-detail/:id",
    element: <LazyPage><MobileTaskDetail /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  // 移动端云端同步：沉浸式全屏（独立顶层路由）
  {
    path: "/sync",
    element: <LazyPage><MobileSync /></LazyPage>,
    errorElement: <RouteErrorFallback />,
  },
  {
    path: "/",
    element: (
      <OnboardingProvider>
        <LayoutSwitch />
      </OnboardingProvider>
    ),
    errorElement: <RouteErrorFallback />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "notes", element: <NoteListPage /> },
      { path: "mounts", element: <LazyPage><MountsPage /></LazyPage> },
      // 外部 .md shell-first 打开页：必须排在 notes/:id 之前
      { path: "notes/opening", element: <OpeningNotePage /> },
      { path: "notes/:id", element: <NoteEditorPage /> },
      // 白板本质是 note_type='whiteboard' 的文档
      { path: "whiteboard/:id", element: <LazyPage><WhiteboardPage /></LazyPage> },
      { path: "search", element: <SearchPage /> },
      { path: "tags", element: <TagsPage /> },
      { path: "trash", element: <TrashPage /> },
      { path: "hidden", element: <LazyPage><HiddenPage /></LazyPage> },
      { path: "daily", element: <DailyPage /> },
      { path: "graph", element: <LazyPage><GraphPage /></LazyPage> },
      { path: "ai", element: <LazyPage><AiChatPage /></LazyPage> },
      { path: "prompts", element: <LazyPage><PromptsPage /></LazyPage> },
      { path: "push", element: <LazyPage><PushPage /></LazyPage> },
      // 插件 / 扩展包管理已并入「关于」页（设置 Tab），旧地址重定向保持深链可用
      { path: "plugins", element: <Navigate to="/about?tab=plugins" replace /> },
      { path: "plugin-view/:viewId", element: <LazyPage><PluginPanelViewPage /></LazyPage> },
      { path: "extensions", element: <Navigate to="/about?tab=extensions" replace /> },
      { path: "ppt", element: <LazyPage><PptPage /></LazyPage> },
      { path: "research", element: <LazyPage><ResearchPage /></LazyPage> },
      { path: "tasks", element: <LazyPage><TasksPage /></LazyPage> },
      { path: "task-session", element: <LazyPage><TaskSessionPage /></LazyPage> },
      { path: "cards", element: <LazyPage><CardsPage /></LazyPage> },
      // 设置内容已并入「关于」页：桌面端两个入口共用同一套 Tab 页面
      // （/settings 保留给移动端「我的」与旧深链，/about 为桌面关于入口的规范地址）
      { path: "settings", element: <SettingsPage /> },
      { path: "about", element: <AboutRoute /> },
      { path: "quick-create", element: <LazyPage><QuickCreatePage /></LazyPage> },
      { path: "feature-toggle", element: <LazyPage><FeatureTogglePage /></LazyPage> },
      // P0 Spike：WebView 内 PPTX 引擎验证页（不进入侧边栏）
      { path: "pptx-spike", element: <LazyPage><PptxSpikePage /></LazyPage> },
      // Office 工作台（开发模式入口，后续正式化）
      { path: "office", element: <LazyPage><OfficeWorkspacePage /></LazyPage> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
