/**
 * PluginPanelViewPage —— 插件面板视图渲染页面
 *
 * 路由 /plugin-view/:viewId
 * 从 PluginManager 查找已注册的插件面板视图，交给统一的 ModuleViewFrame 挂载。
 *
 * 使用模式：插件侧边栏按钮点击 → navigate(`#/plugin-view/${viewId}`)
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button, Result } from "antd";
import { ArrowLeft, Puzzle } from "lucide-react";
import { pluginManager } from "@/services/pluginManager";
import { ModuleViewFrame } from "@/components/module/ModuleViewFrame";
import type { PluginPanelViewDef } from "@/types";

export default function PluginPanelViewPage() {
  const { viewId } = useParams<{ viewId: string }>();
  const navigate = useNavigate();
  const [viewDef, setViewDef] = useState<PluginPanelViewDef | null>(null);
  const [renderKey, setRenderKey] = useState(0);

  // 查询视图定义并触发重渲染（每次 viewId 变化或注册表变化都重新查询）
  useEffect(() => {
    if (!viewId) return;
    const lookup = () => {
      const def = pluginManager.getPanelView(viewId);
      if (def) {
        setViewDef(def);
        setRenderKey((k) => k + 1); // 强制 DOM 重新挂载
      } else {
        const allIds = pluginManager
          .getRegisteredPanelViews()
          .map((v) => `${v.pluginId ?? "?"}:${v.id}`);
        console.warn(
          `[PluginPanelViewPage] viewId="${viewId}" 未命中。当前已注册视图:`,
          allIds,
          " 已激活插件:",
          pluginManager.getActiveIds(),
        );
        setViewDef(null);
      }
    };
    lookup();
    // 订阅注册表变化：插件后注册视图（异步 onLoad）时自动重试
    const unsubscribe = pluginManager.subscribe("views", lookup);
    return unsubscribe;
  }, [viewId]);

  const mountView = useCallback(
    (container: HTMLElement) => {
      if (!viewDef) return;
      container.innerHTML = "";
      return viewDef.render(container);
    },
    [viewDef],
  );

  if (!viewId || !viewDef) {
    const activeIds = pluginManager.getActiveIds();
    const subTitle = !viewId
      ? "未指定视图 ID"
      : activeIds.length === 0
      ? "当前没有任何插件运行时被激活。请到插件页启用插件后重试。"
      : `已激活的插件 (${activeIds.join(", ")}) 中均未注册名为 "${viewId}" 的视图。`;
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{ height: "100%", padding: 32 }}
      >
        <Result
          icon={<Puzzle size={48} style={{ opacity: 0.3 }} />}
          title="视图未找到"
          subTitle={subTitle}
          extra={
            <Button
              type="primary"
              icon={<ArrowLeft size={14} />}
              onClick={() => navigate("/notes")}
            >
              返回文档
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <ModuleViewFrame
      meta={{
        id: viewDef.id,
        title: viewDef.title,
        source: "plugin",
        sourceLabel: "插件",
        icon: <Puzzle size={16} />,
        layout: viewDef.layout === "fullscreen" ? "fullscreen" : "standard",
        pluginId: viewDef.pluginId,
      }}
      mount={mountView}
      mountKey={viewDef.id}
      resetKey={renderKey}
      onBack={() => navigate("/notes")}
    />
  );
}
