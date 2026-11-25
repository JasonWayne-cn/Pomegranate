import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { Button, Tooltip, theme as antdTheme } from "antd";
import { QuestionCircleOutlined, SettingOutlined } from "@ant-design/icons";
import { deriveActiveViewFromPath } from "@/components/layout/ActivityBar";
import { MODULE_REGISTRY, moduleHasConfig } from "@/modules/registry";
import { ModuleDrawer, type ModuleDrawerTab } from "./ModuleDrawer";

/**
 * 高频模块的标题栏只保留「使用说明」入口，不再显示「配置」按钮；
 * 配置页签仍保留在抽屉内，打开使用说明后可切换。
 */
const HIDE_CONFIG_BUTTON_VIEWS = new Set(["notes", "daily", "tasks", "ai"]);

/**
 * Header 左侧的模块操作组。
 *
 * 模块名与入口都跟随当前路由变化：
 *   ⚙ 打开「配置」页签（仅部分模块）
 *   ? 打开「使用说明」页签（Shift + F1 等效）
 *
 * 独立页（设置/关于/插件视图）不显示，避免与全局设置语义重复。
 */
export function ModuleActions() {
  const { token } = antdTheme.useToken();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<ModuleDrawerTab | null>(null);
  const [focusPanelId, setFocusPanelId] = useState<string | null>(null);

  const pathname = location.pathname;
  const isStandalone =
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/about" ||
    pathname.startsWith("/about/") ||
    pathname.startsWith("/plugin-view/");

  const view = deriveActiveViewFromPath(pathname);
  const meta = !isStandalone && view ? MODULE_REGISTRY[view] : null;

  // 切换模块时关闭抽屉，避免把上一个模块的配置带过来
  useEffect(() => {
    setTab(null);
    setFocusPanelId(null);
  }, [view]);

  /**
   * URL 深链：/ai?config=models 或 /ai?config=asr
   *
   * 用于替代旧的「跳设置页并滚动到锚点」入口。
   * 读取后立即从 URL 移除 config 参数，避免刷新/返回时重复打开。
   */
  useEffect(() => {
    if (!meta) return;
    const config = searchParams.get("config");
    if (!config) return;

    setTab("config");
    setFocusPanelId(config === "1" ? null : config);

    const next = new URLSearchParams(searchParams);
    next.delete("config");
    setSearchParams(next, { replace: true });
  }, [meta, searchParams, setSearchParams]);

  useEffect(() => {
    if (!meta) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "F1") {
        e.preventDefault();
        setTab("help");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [meta]);

  if (!meta) return null;

  const Icon = meta.icon;
  const activeStyle = (active: boolean) => ({
    color: active ? token.colorPrimary : token.colorTextSecondary,
    background: active ? `${token.colorPrimary}14` : "transparent",
  });

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          marginLeft: 8,
          flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 1,
            height: 20,
            background: token.colorBorderSecondary,
            margin: "0 8px",
          }}
        />
        <Icon size={16} style={{ color: token.colorTextSecondary }} />
        <span
          style={{
            fontSize: 13,
            color: token.colorTextSecondary,
            margin: "0 6px",
            maxWidth: 96,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {meta.label}
        </span>

        {moduleHasConfig(meta) && !HIDE_CONFIG_BUTTON_VIEWS.has(meta.view) && (
          <Tooltip title={`${meta.label}配置`} mouseEnterDelay={0.15}>
            <Button
              type="text"
              size="small"
              aria-label={`${meta.label}配置`}
              aria-expanded={tab === "config"}
              icon={<SettingOutlined />}
              onClick={() => setTab(tab === "config" ? null : "config")}
              style={activeStyle(tab === "config")}
            />
          </Tooltip>
        )}

        <Tooltip title={`${meta.label}使用说明 (Shift+F1)`} mouseEnterDelay={0.15}>
          <Button
            type="text"
            size="small"
            aria-label={`${meta.label}使用说明`}
            aria-expanded={tab === "help"}
            icon={<QuestionCircleOutlined />}
            onClick={() => setTab(tab === "help" ? null : "help")}
            style={activeStyle(tab === "help")}
          />
        </Tooltip>
      </div>

      <ModuleDrawer
        meta={meta}
        tab={tab}
        focusPanelId={focusPanelId}
        onTabChange={setTab}
        onClose={() => {
          setTab(null);
          setFocusPanelId(null);
        }}
      />
    </>
  );
}
