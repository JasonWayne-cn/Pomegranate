import { useEffect, useRef, useState } from "react";
import { Card, Empty } from "antd";
import { pluginManager } from "@/services/pluginManager";
import type { PluginSettingsTabDef } from "@/types";

type SettingsTabEntry = PluginSettingsTabDef & { pluginId: string };

interface Props {
  compact?: boolean;
}

/**
 * 插件注册的设置页 Tab。
 *
 * 插件通过 manifest 贡献设置 UI，render 回调把 DOM 挂到容器里。
 * 抽离后设置页与插件模块抽屉共用同一注册表。
 */
function PluginSettingsTabRenderer({ tab }: { tab: SettingsTabEntry }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = "";
    const cleanup = tab.render(container);
    return () => {
      if (typeof cleanup === "function") cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.pluginId, tab.id]);

  return <div ref={containerRef} />;
}

export function PluginSettingsTabs({ compact }: Props) {
  const [tabs, setTabs] = useState<SettingsTabEntry[]>([]);

  useEffect(() => {
    const refresh = () => setTabs(pluginManager.getRegisteredSettingsTabs());
    refresh();
    return pluginManager.subscribe("settings-tabs", refresh);
  }, []);

  if (tabs.length === 0) {
    return compact ? <Empty description="暂无插件注册设置" /> : null;
  }

  return (
    <>
      {tabs.map((tab) => {
        const sectionId = `settings-plugin-${tab.pluginId}:${tab.id}`;
        const pluginName =
          pluginManager.getPluginName(tab.pluginId) ?? tab.pluginId;
        return (
          <Card
            key={sectionId}
            id={sectionId}
            size="small"
            title={
              <span className="flex items-center gap-2">
                <span style={{ fontSize: 12, opacity: 0.6 }}>🔌</span>
                {tab.title}
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--ant-color-text-quaternary)",
                    fontWeight: "normal",
                  }}
                >
                  ({pluginName})
                </span>
              </span>
            }
          >
            <PluginSettingsTabRenderer tab={tab} />
          </Card>
        );
      })}
    </>
  );
}

export default PluginSettingsTabs;
