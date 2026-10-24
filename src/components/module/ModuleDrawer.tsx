import { Drawer, Tabs, theme as antdTheme } from "antd";
import { BookOpen, Settings2 } from "lucide-react";
import type { ModuleMeta } from "@/modules/types";
import { ModuleConfigPanel } from "./ModuleConfigPanel";
import { ModuleHelpPanel } from "./ModuleHelpPanel";

export type ModuleDrawerTab = "config" | "help";

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
            · {tab === "help" ? "使用说明" : "配置"}
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
        activeKey={tab ?? "config"}
        onChange={(key) => onTabChange(key as ModuleDrawerTab)}
        items={[
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
        ]}
        style={{ flex: 1, minHeight: 0 }}
      />
    </Drawer>
  );
}
