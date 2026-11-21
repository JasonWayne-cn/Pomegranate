import { lazy, Suspense, useMemo } from "react";
import { Drawer, Skeleton, Tabs, theme as antdTheme } from "antd";
import { BookOpen, Settings2 } from "lucide-react";
import { moduleHasConfig } from "@/modules/registry";
import type { ModuleFeatureTab, ModuleMeta } from "@/modules/types";
import { ModuleConfigPanel } from "./ModuleConfigPanel";
import { ModuleHelpPanel } from "./ModuleHelpPanel";

/**
 * 抽屉页签 key：内置 config / help，其余来自 ModuleMeta.featureTabs。
 * 用 string 保持开放，模块新增功能页签无需改此处。
 */
export type ModuleDrawerTab = string;

interface Props {
  meta: ModuleMeta | null;
  tab: ModuleDrawerTab | null;
  /** URL 深链定位到的面板 id（如 models / asr） */
  focusPanelId?: string | null;
  onTabChange: (tab: ModuleDrawerTab) => void;
  onClose: () => void;
}

/**
 * 模块设置中心抽屉：配置 / 使用说明两个页签。
 *
 * 两个入口按钮只是把初始页签定位到 config 或 help，
 * 用户可以在抽屉内自由切换。
 */
export function ModuleDrawer({
  meta,
  tab,
  focusPanelId,
  onTabChange,
  onClose,
}: Props) {
  const { token } = antdTheme.useToken();

  if (!meta) return null;
  const Icon = meta.icon;

  // 没有配置面板的模块（如首页）不再显示「配置」页签
  const hasConfigTab = moduleHasConfig(meta);
  const featureTabs = meta.featureTabs ?? [];
  const activeTabKey =
    tab === "config" && !hasConfigTab ? "help" : tab ?? (hasConfigTab ? "config" : "help");
  const activeTabLabel =
    activeTabKey === "help"
      ? "使用说明"
      : activeTabKey === "config"
        ? "配置"
        : featureTabs.find((t) => t.key === activeTabKey)?.label ?? "";

  return (
    <Drawer
      open={!!tab}
      onClose={onClose}
      width={720}
      rootClassName="module-drawer"
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon size={16} style={{ color: token.colorPrimary }} />
          {meta.label}
          <span style={{ color: token.colorTextSecondary, fontWeight: 400 }}>
            · {activeTabLabel}
          </span>
        </span>
      }
      destroyOnHidden
      styles={{
        body: {
          padding: 0,
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
        },
        content: {
          display: "flex",
          flexDirection: "column",
        },
      }}
    >
      <Tabs
        className="module-drawer-tabs"
        activeKey={activeTabKey}
        onChange={(key) => onTabChange(key as ModuleDrawerTab)}
        items={[
          ...(hasConfigTab
            ? [
                {
                  key: "config",
                  label: (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <Settings2 size={15} />
                      配置
                    </span>
                  ),
                  children: (
                    <ModuleConfigPanel meta={meta} focusPanelId={focusPanelId} />
                  ),
                },
              ]
            : []),
          {
            key: "help",
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <BookOpen size={15} />
                使用说明
              </span>
            ),
            children: <ModuleHelpPanel meta={meta} />,
          },
          ...featureTabs.map((feature) => {
            const FeatureIcon = feature.icon;
            return {
              key: feature.key,
              label: (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <FeatureIcon size={15} />
                  {feature.label}
                </span>
              ),
              children: <FeatureTabPanel feature={feature} />,
            };
          }),
        ]}
        style={{ flex: 1, minHeight: 0 }}
      />
    </Drawer>
  );
}

/** 功能页签：懒加载完整功能页（卡片复习 / 定时推送等） */
function FeatureTabPanel({ feature }: { feature: ModuleFeatureTab }) {
  const LazyPage = useMemo(() => lazy(feature.load), [feature.load]);

  return (
    <Suspense
      fallback={
        <div style={{ padding: 20 }}>
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      }
    >
      <div style={{ padding: "12px 20px", height: "100%", overflow: "auto" }}>
        <LazyPage />
      </div>
    </Suspense>
  );
}
