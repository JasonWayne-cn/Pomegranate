import { useEffect, useState } from "react";
import {
  Card,
  Typography,
  Table,
  message,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Select,
  Popconfirm,
  Switch,
  Radio,
  Tabs,
  ColorPicker,
  Slider,
} from "antd";
import { SyncOutlined, PlusOutlined, PictureOutlined } from "@ant-design/icons";
import { Trash2, Pencil, LayoutTemplate, Power, Palette, Cog, UserRound, Monitor, Rocket, Info, Layers } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLocation, useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import type { NoteTemplate, NoteTemplateInput } from "@/types";
import { systemApi, updaterApi, templateApi, autostartApi, configApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { UpdateModal } from "@/components/ui/UpdateModal";
import { SyncTabs } from "@/components/settings/SyncTabs";
import { DataDirSection } from "@/components/settings/DataDirSection";
import { FeatureModulesSection } from "@/components/settings/FeatureModulesSection";
import { ShortcutsSection } from "@/components/settings/ShortcutsSection";
import { AppLockSection } from "@/components/applock/AppLockSection";
import { McpHttpSection } from "@/components/settings/McpHttpSection";
import { TiptapEditor } from "@/components/editor";
import { AboutDetails } from "@/pages/about";

const { Title, Text } = Typography;

/**
 * 把回调推迟到浏览器空闲时段。
 * Why: 设置页 mount 时一次性发起 6+ 个 invoke 会跟路由 commit / 编辑器 destroy
 *      抢主线程，造成"点击设置时卡一下"。把这些非首屏关键的 IPC 推到 idle 阶段，
 *      用户先看到骨架 UI，数据陆续填充。
 * 兼容：Webview2 / WKWebView 都支持 requestIdleCallback；不支持时回退到 setTimeout(0)。
 */
type IdleHandle = { kind: "idle"; id: number } | { kind: "timeout"; id: ReturnType<typeof setTimeout> };
type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};
function scheduleIdle(fn: () => void): IdleHandle {
  const w = window as IdleWindow;
  if (typeof w.requestIdleCallback === "function") {
    return { kind: "idle", id: w.requestIdleCallback(fn, { timeout: 500 }) };
  }
  return { kind: "timeout", id: setTimeout(fn, 0) };
}
function cancelIdle(handle: IdleHandle): void {
  const w = window as IdleWindow;
  if (handle.kind === "idle" && typeof w.cancelIdleCallback === "function") {
    w.cancelIdleCallback(handle.id);
  } else if (handle.kind === "timeout") {
    clearTimeout(handle.id);
  }
}

// ─── 竖直 Tab 配置 ────────────────────────────────────

const TAB_KEYS = {
  about: "about",
  appConfig: "app-config",
  extras: "extras",
  personal: "personal",
  display: "display",
  startup: "startup",
} as const;

type TabKey = (typeof TAB_KEYS)[keyof typeof TAB_KEYS];

function sectionIdToTab(sectionId: string): TabKey | null {
  if (/^settings-(data-dir|data-migration|sync|auto-save)$/.test(sectionId)) return TAB_KEYS.appConfig;
  if (/^settings-(app-lock|mcp-http)$/.test(sectionId)) return TAB_KEYS.extras;
  if (/^settings-(templates|shortcuts)$/.test(sectionId)) return TAB_KEYS.personal;
  if (/^settings-appearance$/.test(sectionId)) return TAB_KEYS.display;
  if (/^settings-(update|startup|features)$/.test(sectionId)) return TAB_KEYS.startup;
  if (/^settings-/.test(sectionId)) return TAB_KEYS.about;
  return null;
}

/** ─── 外观自定义组件 ─────────────────────────────────── */

function AppearanceSection() {
  const themeOverridesEnabled = useAppStore((s) => s.themeOverridesEnabled);
  const customAccent = useAppStore((s) => s.customAccent);
  const customBgImage = useAppStore((s) => s.customBgImage);
  const customBgDim = useAppStore((s) => s.customBgDim);
  const customBgBlur = useAppStore((s) => s.customBgBlur);
  const customBgFit = useAppStore((s) => s.customBgFit);
  const setThemeOverridesEnabled = useAppStore((s) => s.setThemeOverridesEnabled);
  const setCustomAccent = useAppStore((s) => s.setCustomAccent);
  const setCustomBgImage = useAppStore((s) => s.setCustomBgImage);
  const setCustomBgDim = useAppStore((s) => s.setCustomBgDim);
  const setCustomBgBlur = useAppStore((s) => s.setCustomBgBlur);
  const setCustomBgFit = useAppStore((s) => s.setCustomBgFit);
  const resetThemeOverrides = useAppStore((s) => s.resetThemeOverrides);

  const [bgPicking, setBgPicking] = useState(false);

  async function pickThemeBg() {
    setBgPicking(true);
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      });
      if (typeof picked !== "string") return;
      try {
        const target = await invoke<string>("copy_theme_bg", { srcPath: picked });
        setCustomBgImage(target);
        if (!themeOverridesEnabled) setThemeOverridesEnabled(true);
      } catch {
        setCustomBgImage(picked);
        if (!themeOverridesEnabled) setThemeOverridesEnabled(true);
      }
    } catch (e) {
      message.error(`选择图片失败: ${e}`);
    } finally {
      setBgPicking(false);
    }
  }

  async function clearThemeBg() {
    setCustomBgImage(null);
    try { await invoke("clear_theme_bg"); } catch { /* Phase 1 */ }
  }

  const hasOverrides =
    themeOverridesEnabled || !!customAccent || !!customBgImage ||
    customBgDim !== 0 || customBgBlur !== 0 || customBgFit !== "cover";

  return (
    <Card
      id="settings-appearance"
      title={<span className="flex items-center gap-2"><Palette size={16} />外观自定义</span>}
      extra={<Button size="small" type="link" onClick={resetThemeOverrides} disabled={!hasOverrides}>重置</Button>}
    >
      <div className="flex items-center justify-between py-1">
        <div><div>启用自定义</div><Text type="secondary" style={{ fontSize: 12 }}>关闭后回到当前主题预设；下方调整不会丢失。</Text></div>
        <Switch checked={themeOverridesEnabled} onChange={setThemeOverridesEnabled} />
      </div>
      <div className="py-1 mt-2" style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div className="flex items-center justify-between">
          <div><div>强调色</div><Text type="secondary" style={{ fontSize: 12 }}>覆盖按钮/选中态/链接等主色。</Text></div>
          <Space>
            <ColorPicker value={customAccent ?? undefined} onChange={(c) => setCustomAccent(c.toHexString())} disabled={!themeOverridesEnabled} showText
              presets={[{ label: "推荐", colors: ["#6366f1","#8b5cf6","#ec4899","#f43f5e","#f97316","#f59e0b","#10b981","#14b8a6","#0ea5e9","#3b82f6"] }]} />
            <Button size="small" type="text" onClick={() => setCustomAccent(null)} disabled={!customAccent}>清除</Button>
          </Space>
        </div>
        <div className="flex items-center gap-2 mt-2" style={{ flexWrap: "wrap" }}>
          <Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>快速色板</Text>
          {["经典蓝#1677ff","玫瑰#ec4899","紫罗兰#8b5cf6","海洋#0ea5e9","森林#10b981","橙日#f97316","桃粉#fb7185","灰岩#64748b"].map((p) => {
            const [name, color] = p.split("#"); const hex = `#${color}`;
            const active = customAccent?.toLowerCase() === hex.toLowerCase();
            return (<button key={hex} type="button" title={name}
              onClick={() => { setCustomAccent(hex); if (!themeOverridesEnabled) setThemeOverridesEnabled(true); }}
              disabled={!themeOverridesEnabled}
              style={{ width: 22, height: 22, borderRadius: "50%", background: hex,
                border: active ? "2px solid var(--ant-color-text)" : "1px solid rgba(0,0,0,0.15)",
                cursor: themeOverridesEnabled ? "pointer" : "not-allowed", opacity: themeOverridesEnabled ? 1 : 0.4, padding: 0 }} />);
          })}
        </div>
      </div>
      <div className="py-1 mt-2" style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div className="flex items-center justify-between">
          <div><div className="flex items-center gap-2"><PictureOutlined style={{ fontSize: 14 }} />背景图</div><Text type="secondary" style={{ fontSize: 12 }}>选择本地图片作为应用背景。</Text></div>
          <Space>
            <Button size="small" onClick={pickThemeBg} loading={bgPicking} disabled={!themeOverridesEnabled}>{customBgImage ? "更换" : "选择图片"}</Button>
            <Button size="small" type="text" onClick={clearThemeBg} disabled={!customBgImage}>清除</Button>
          </Space>
        </div>
        {customBgImage && <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 6, wordBreak: "break-all" }}>当前：{customBgImage}</Text>}
      </div>
      <div className="py-1 mt-2" style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div className="flex items-center justify-between mb-1"><div><div>背景遮罩</div><Text type="secondary" style={{ fontSize: 12 }}>在背景图上叠半透明色，保证文字对比度。</Text></div><Text style={{ fontSize: 12 }}>{Math.round(customBgDim * 100)}%</Text></div>
        <Slider min={0} max={1} step={0.05} value={customBgDim} onChange={setCustomBgDim} disabled={!themeOverridesEnabled || !customBgImage} tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }} />
      </div>
      <div className="py-1 mt-2" style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div className="flex items-center justify-between"><div><div>背景适配</div><Text type="secondary" style={{ fontSize: 12 }}>控制背景图的缩放/排布方式。</Text></div>
          <Select value={customBgFit} onChange={setCustomBgFit} disabled={!themeOverridesEnabled || !customBgImage} style={{ width: 140 }}
            options={[{ label: "覆盖（裁切）", value: "cover" },{ label: "包含（留白）", value: "contain" },{ label: "原始大小", value: "center" },{ label: "平铺", value: "repeat" }]} /></div>
      </div>
      <div className="py-1 mt-2" style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div className="flex items-center justify-between mb-1"><div><div>背景模糊</div><Text type="secondary" style={{ fontSize: 12 }}>高斯模糊背景图（0=关闭）。</Text></div><Text style={{ fontSize: 12 }}>{customBgBlur}px</Text></div>
        <Slider min={0} max={30} step={1} value={customBgBlur} onChange={setCustomBgBlur} disabled={!themeOverridesEnabled || !customBgImage} tooltip={{ formatter: (v) => `${v ?? 0}px` }} />
      </div>
    </Card>
  );
}/** 插件设置 Tab 的 DOM 挂载器（参考 PluginPanelViewPage 模式） */
function DesktopSettingsPage() {
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("0.1.0");

  // 模板管理状态
  const [tplList, setTplList] = useState<NoteTemplate[]>([]);
  const [tplLoading, setTplLoading] = useState(false);
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [editingTpl, setEditingTpl] = useState<NoteTemplate | null>(null);
  const [tplForm] = Form.useForm<NoteTemplateInput>();

  // 启动设置
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const [startMinimizedLoading, setStartMinimizedLoading] = useState(false);
  const [multiInstanceEnabled, setMultiInstanceEnabled] = useState(false);
  const [multiInstanceLoading, setMultiInstanceLoading] = useState(false);
  // 关闭按钮行为：ask=每次询问 / minimize=最小化到托盘 / exit=直接退出
  const [closeAction, setCloseAction] = useState<"ask" | "minimize" | "exit">(
    "ask",
  );

  async function handleCheckUpdate() {
    setChecking(true);
    try {
      const result = await updaterApi.checkUpdate();
      if (result) {
        setUpdate(result);
        setUpdateModalOpen(true);
      } else {
        message.success("当前已是最新版本");
      }
    } catch (e) {
      message.warning(`检查更新失败: ${String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  async function loadTemplates() {
    setTplLoading(true);
    try {
      const list = await templateApi.list();
      setTplList(list);
    } catch (e) {
      message.error(`加载模板失败: ${e}`);
    } finally {
      setTplLoading(false);
    }
  }

  function openAddTemplate() {
    setEditingTpl(null);
    tplForm.resetFields();
    setTplModalOpen(true);
  }

  function openEditTemplate(tpl: NoteTemplate) {
    setEditingTpl(tpl);
    tplForm.setFieldsValue({
      name: tpl.name,
      description: tpl.description,
      content: tpl.content,
    });
    setTplModalOpen(true);
  }

  async function handleTemplateSave() {
    try {
      const values = await tplForm.validateFields();
      if (editingTpl) {
        await templateApi.update(editingTpl.id, values);
        message.success("模板已更新");
      } else {
        await templateApi.create(values);
        message.success("模板已创建");
      }
      setTplModalOpen(false);
      loadTemplates();
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`保存失败: ${e}`);
    }
  }

  async function handleDeleteTemplate(id: number) {
    try {
      await templateApi.delete(id);
      message.success("模板已删除");
      loadTemplates();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  // ─── 竖直 Tab 状态 ────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as TabKey | null) ?? TAB_KEYS.about;
  function setActiveTab(key: TabKey) {
    setSearchParams({ tab: key }, { replace: true });
  }

  // 从其他页面带 state.scrollTo 跳转过来时，切到对应 Tab
  const location = useLocation();
  useEffect(() => {
    const target = (location.state as { scrollTo?: string } | null)?.scrollTo;
    if (!target) return;
    const tab = sectionIdToTab(target);
    if (tab) {
      setActiveTab(tab);
      const raf = requestAnimationFrame(() => {
        const el = document.getElementById(target);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.add("settings-target-flash");
          const t = setTimeout(() => el.classList.remove("settings-target-flash"), 1800);
          return () => clearTimeout(t);
        }
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [location.state]);

  useEffect(() => {
    // 把 6 个并发 invoke 推迟到 idle：从笔记页切过来时主线程要先吃掉一帧的
    // 路由 commit + Tiptap destroy，立即并发 IPC 会让首屏明显卡顿。
    // idle 后再跑，用户视觉上"先看到 UI、再陆续填充数据"。
    const handle = scheduleIdle(() => {
      // loadFolders 已由 foldersRefreshTick useEffect 在首次挂载时触发
      loadTemplates();
      systemApi
        .getSystemInfo()
        .then((info) => setAppVersion(info.appVersion))
        .catch(() => {});
      // 读取启动设置：autostart 状态来自系统注册项，start_minimized 存在 app_config 表
      autostartApi.isEnabled().then(setAutostartEnabled).catch(() => {});
      configApi
        .get("start_minimized")
        .then((v) => setStartMinimized(v === "1"))
        .catch(() => {});
      // 多开开关存在 framework_app_data_dir 下的 flag 文件，启动早期就要读得到
      systemApi
        .getMultiInstanceEnabled()
        .then(setMultiInstanceEnabled)
        .catch(() => {});
      configApi
        .get("window.close_action")
        .then((v) => {
          if (v === "minimize" || v === "exit" || v === "ask") {
            setCloseAction(v);
          }
        })
        .catch(() => {});
    });
    return () => cancelIdle(handle);
  }, []);

  async function handleAutostartToggle(next: boolean) {
    setAutostartLoading(true);
    try {
      if (next) await autostartApi.enable();
      else await autostartApi.disable();
      setAutostartEnabled(next);
      message.success(next ? "已开启开机启动" : "已关闭开机启动");
    } catch (e) {
      message.error(`设置失败: ${e}`);
    } finally {
      setAutostartLoading(false);
    }
  }

  async function handleStartMinimizedToggle(next: boolean) {
    setStartMinimizedLoading(true);
    try {
      await configApi.set("start_minimized", next ? "1" : "0");
      setStartMinimized(next);
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setStartMinimizedLoading(false);
    }
  }

  async function handleMultiInstanceToggle(next: boolean) {
    setMultiInstanceLoading(true);
    try {
      await systemApi.setMultiInstanceEnabled(next);
      setMultiInstanceEnabled(next);
      message.info(
        next
          ? "已允许多开实例，下次启动生效"
          : "已禁止多开，下次再启动会唤起当前窗口",
      );
    } catch (e) {
      message.error(`设置失败: ${e}`);
    } finally {
      setMultiInstanceLoading(false);
    }
  }

  async function handleCloseActionChange(next: "ask" | "minimize" | "exit") {
    try {
      await configApi.set("window.close_action", next);
      setCloseAction(next);
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  /** 扁平化文件夹树为选项列表 */
  return (
    <div className="settings-tabs-page">
      <div style={{ marginBottom: 16 }}>
        <Title level={3}>设置</Title>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as TabKey)}
        tabPosition="left"
        destroyInactiveTabPane={false}
        className="settings-tabs-shell"
        items={[
          // ─── Tab 1: 应用信息（原「关于」，置于首位）──────────
          {
            key: TAB_KEYS.about,
            label: <span className="flex items-center gap-2"><Info size={16} />应用信息</span>,
            children: (
              <div className="settings-tabs-stack">
                <AboutDetails
                  showHeader={false}
                  showAnchorNav={false}
                  showSettingsButton={false}
                />
              </div>
            ),
          },
          // ─── Tab 2: 应用配置 ──────────────────────────
          {
            key: TAB_KEYS.appConfig,
            label: <span className="flex items-center gap-2"><Cog size={16} />应用配置</span>,
            children: (
              <div className="settings-tabs-stack">
                <div id="settings-data-dir">
                  <DataDirSection />
                </div>

                <div id="settings-sync">
                  <SyncTabs />
                </div>

                <AppLockSection />
              </div>
            ),
          },
            // ─── Tab 3: 功能扩展 ──────────────────────────
          {
            key: TAB_KEYS.extras,
            label: <span className="flex items-center gap-2"><Layers size={16} />功能扩展</span>,
            children: (
              <div className="settings-tabs-stack">
                <McpHttpSection />
                <FeatureModulesSection title="侧边栏" />
              </div>
            ),
          },
        // ─── Tab 4: 个性设置 ──────────────────────────
          {
            key: TAB_KEYS.personal,
            label: <span className="flex items-center gap-2"><UserRound size={16} />个性设置</span>,
            children: (
              <div className="settings-tabs-stack">
                <Card
                  id="settings-templates"
                  title={
                    <span className="flex items-center gap-2">
                      <LayoutTemplate size={16} />
                      笔记模板
                    </span>
                  }
                  extra={
                    <Button
                      type="primary"
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={openAddTemplate}
                    >
                      新建模板
                    </Button>
                  }
                >
                  <Table
                    columns={[
                      { title: "模板名称", dataIndex: "name", key: "name" },
                      {
                        title: "描述",
                        dataIndex: "description",
                        key: "description",
                        ellipsis: true,
                        render: (text: string) => (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {text || "—"}
                          </Text>
                        ),
                      },
                      {
                        title: "操作",
                        key: "action",
                        width: 100,
                        render: (_: unknown, record: NoteTemplate) => (
                          <Space size="small">
                            <Button type="text" size="small" icon={<Pencil size={14} />} onClick={() => openEditTemplate(record)} />
                            <Popconfirm title="确认删除此模板？" onConfirm={() => handleDeleteTemplate(record.id)}>
                              <Button type="text" size="small" danger icon={<Trash2 size={14} />} />
                            </Popconfirm>
                          </Space>
                        ),
                      },
                    ]}
                    dataSource={tplList}
                    rowKey="id"
                    loading={tplLoading}
                    pagination={false}
                    size="small"
                  />
                </Card>

                <div id="settings-shortcuts">
                  <ShortcutsSection />
                </div>
              </div>
            ),
          },
          // ─── Tab 5: 显示设置 ──────────────────────────
          {
            key: TAB_KEYS.display,
            label: <span className="flex items-center gap-2"><Monitor size={16} />显示设置</span>,
            children: (
              <div className="settings-tabs-stack">
                <AppearanceSection />
              </div>
            ),
          },
          // ─── Tab 6: 更新启动 ──────────────────────────
          {
            key: TAB_KEYS.startup,
            label: <span className="flex items-center gap-2"><Rocket size={16} />更新启动</span>,
            children: (
              <div className="settings-tabs-stack">
                <Card id="settings-update" title="软件更新">
                  <Space wrap>
                    <Button
                      icon={<SyncOutlined spin={checking} />}
                      onClick={handleCheckUpdate}
                      loading={checking}
                    >
                      检查更新
                    </Button>
                    <Text type="secondary">当前版本: {appVersion}</Text>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => openUrl("https://me.bit.edu.cn/")}
                    >
                      官网 https://me.bit.edu.cn/
                    </Button>
                  </Space>
                </Card>

                <Card
                  id="settings-startup"
                  title={
                    <span className="flex items-center gap-2">
                      <Power size={16} />
                      启动设置
                    </span>
                  }
                >
                  <div className="flex items-center justify-between py-1">
                    <div>
                      <div>开机自动启动</div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        登录系统后自动打开 Pomegranate，用于定时提醒等后台任务
                      </Text>
                    </div>
                    <Switch
                      checked={autostartEnabled}
                      loading={autostartLoading}
                      onChange={handleAutostartToggle}
                    />
                  </div>
                  <div
                    className="flex items-center justify-between py-1 mt-2"
                    style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
                  >
                    <div>
                      <div>启动时最小化到托盘</div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        仅在开机自动启动时生效；手动双击打开仍会正常显示窗口
                      </Text>
                    </div>
                    <Switch
                      checked={startMinimized}
                      loading={startMinimizedLoading}
                      disabled={!autostartEnabled}
                      onChange={handleStartMinimizedToggle}
                    />
                  </div>
                  <div
                    className="flex items-center justify-between py-1 mt-2"
                    style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
                  >
                    <div>
                      <div>允许多开实例</div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        关闭时再次启动会唤起已有窗口（默认）；开启后每次启动都开新窗口，
                        注意多个实例同时写同一份数据库可能导致冲突。下次启动生效。
                      </Text>
                    </div>
                    <Switch
                      checked={multiInstanceEnabled}
                      loading={multiInstanceLoading}
                      onChange={handleMultiInstanceToggle}
                    />
                  </div>
                  <div
                    className="py-1 mt-2"
                    style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div style={{ flex: 1 }}>
                        <div>关闭窗口时</div>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          点击右上角关闭按钮的行为。选"每次询问"会弹出三选一对话框。
                        </Text>
                      </div>
                      <Radio.Group
                        value={closeAction}
                        onChange={(e) => handleCloseActionChange(e.target.value)}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="ask">每次询问</Radio.Button>
                        <Radio.Button value="minimize">最小化到托盘</Radio.Button>
                        <Radio.Button value="exit">直接退出</Radio.Button>
                      </Radio.Group>
                    </div>
                  </div>
                </Card>
              </div>
            ),
          },
        ]}
      />

      {/* 模板编辑弹窗 */}
      <Modal
        title={editingTpl ? "编辑模板" : "新建模板"}
        open={tplModalOpen}
        onOk={handleTemplateSave}
        onCancel={() => setTplModalOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        width={820}
        styles={{ body: { maxHeight: "calc(100vh - 240px)", overflow: "auto" } }}
      >
        <Form form={tplForm} layout="vertical" className="mt-4">
          <Form.Item name="name" label="模板名称" rules={[{ required: true, message: "请输入模板名称" }]}>
            <Input placeholder="如：会议记录" />
          </Form.Item>
          <Form.Item name="description" label="描述" initialValue="">
            <Input placeholder="简要描述模板用途" />
          </Form.Item>
          <Form.Item
            name="content"
            label={
              <div className="flex items-center justify-between w-full">
                <span>模板内容</span>
                <span style={{ fontSize: 12, color: "var(--ant-color-text-tertiary)", fontWeight: "normal" }}>
                  可用变量：{"{{date}} / {{time}} / {{datetime}} / {{weekday}} / {{year}} / {{month}} / {{day}} / {{title}}"}
                </span>
              </div>
            }
            initialValue=""
            valuePropName="content"
          >
            <TiptapEditor content="" onChange={() => {}} placeholder="输入模板内容（支持富文本），创建笔记时将自动填充" />
          </Form.Item>
        </Form>
      </Modal>

      <UpdateModal
        open={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        update={update}
      />
    </div>
  );
}

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileMe } from "./MobileMe";

export default function SettingsPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileMe /> : <DesktopSettingsPage />;
}
