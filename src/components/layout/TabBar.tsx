import { useNavigate, useLocation } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { theme as antdTheme, Dropdown, Tooltip, Modal, Button, App as AntdApp, type MenuProps } from "antd";
import { X, ListTree } from "lucide-react";
import { useTabsStore, type NoteTab } from "@/store/tabs";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { noteApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { useOfficeStore, type OfficeSessionMeta } from "@/store/office";
import { officePathForFile } from "@/lib/office/formats";

/** 与 Office 页面保持一致的文件路径归一化（Windows 盘符/UNC 用反斜杠）。 */
function normalizePath(path: string | null): string {
  if (!path) return "";
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
    ? path.replace(/\//g, "\\")
    : path;
}

export function TabBar() {
  const {
    tabs,
    activeId,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    getDraft,
    clearDraft,
  } = useTabsStore();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();

  // Office 文档会话与文档标签共用这一条标签栏
  const officeSessions = useOfficeStore((s) => s.sessions);
  const removeOfficeSession = useOfficeStore((s) => s.removeSession);
  const onOfficeRoute = location.pathname === "/office";
  const currentOfficePath = onOfficeRoute
    ? normalizePath(new URLSearchParams(location.search).get("path"))
    : "";

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // dirty tab 关闭确认 Modal 的目标 tab；null 表示未弹出
  const [confirmTab, setConfirmTab] = useState<NoteTab | null>(null);
  const [closing, setClosing] = useState(false);

  /** 按 tab 类型决定落点：白板进画布页，普通文档进 Markdown 编辑器 */
  const routeForTab = useCallback((id: number) => {
    const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
    return tab?.noteType === "whiteboard" ? `/whiteboard/${id}` : `/notes/${id}`;
  }, []);

  const handleSelect = useCallback(
    (id: number) => {
      navigate(routeForTab(id));
    },
    [navigate, routeForTab],
  );

  /** 真正执行关闭（含路由跳转），调用方需先处理好 dirty */
  const doClose = useCallback(
    (id: number) => {
      const wasActive = activeId === id;
      const isViewing =
        wasActive &&
        (location.pathname === `/notes/${id}` ||
          location.pathname === `/whiteboard/${id}`);
      const nextActive = closeTab(id);
      tabRefs.current.delete(id);
      if (isViewing) {
        if (nextActive !== null) navigate(routeForTab(nextActive));
        else navigate("/notes");
      }
    },
    [activeId, closeTab, navigate, location.pathname, routeForTab],
  );

  const handleClose = useCallback(
    (id: number, e?: React.MouseEvent) => {
      e?.stopPropagation();
      const tab = tabs.find((t) => t.id === id);
      if (tab?.dirty) {
        // 有未保存内容：弹三选一 Modal
        setConfirmTab(tab);
        return;
      }
      doClose(id);
    },
    [tabs, doClose],
  );

  /** 关闭 Office 标签：优先交给 Office 页面处理（含未保存确认），页面未挂载时直接移除。 */
  const handleOfficeClose = useCallback(
    (session: OfficeSessionMeta, e?: React.MouseEvent) => {
      e?.stopPropagation();
      const evt = new CustomEvent<{ id: string }>("office:request-close", {
        detail: { id: session.id },
        cancelable: true,
      });
      // 监听器调用 preventDefault 表示页面已接管（可能弹保存确认）
      if (!window.dispatchEvent(evt)) return;

      const wasViewing =
        onOfficeRoute && currentOfficePath === normalizePath(session.path);
      removeOfficeSession(session.id);
      if (wasViewing) {
        const next = useOfficeStore
          .getState()
          .sessions.find((item) => item.id === useOfficeStore.getState().activeId);
        if (next) navigate(officePathForFile(next.path, !!next.readOnly));
        else navigate("/notes");
      }
    },
    [currentOfficePath, navigate, onOfficeRoute, removeOfficeSession],
  );

  /** 用户选择"保存并关闭" */
  async function handleSaveAndClose() {
    if (!confirmTab) return;
    const draft = getDraft(confirmTab.id);
    if (!draft || !draft.title.trim()) {
      message.warning("无可保存的草稿（标题为空）");
      return;
    }
    setClosing(true);
    try {
      await noteApi.update(confirmTab.id, { title: draft.title.trim(), content: draft.content });
      // 标题可能被改过，让左侧 NotesPanel / 文档列表重拉同步新标题
      useAppStore.getState().bumpNotesRefresh();
      clearDraft(confirmTab.id);
      doClose(confirmTab.id);
      setConfirmTab(null);
    } catch (e) {
      message.error(`保存失败：${e}`);
    } finally {
      setClosing(false);
    }
  }

  /** 用户选择"放弃修改并关闭" */
  function handleDiscardAndClose() {
    if (!confirmTab) return;
    clearDraft(confirmTab.id);
    doClose(confirmTab.id);
    setConfirmTab(null);
  }

  // Ctrl+W 关闭当前活跃 tab
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "w" && activeId !== null) {
        e.preventDefault();
        handleClose(activeId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, handleClose]);

  // 激活的 tab 超出可视区时自动滚入视界
  useEffect(() => {
    if (activeId === null) return;
    const el = tabRefs.current.get(activeId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [activeId, tabs.length]);

  /** 关闭全部：清空所有 tab；若正在看某文档则跳回列表。有未保存草稿时先确认。
   *  🔴 必须放在下方 `if (tabs.length === 0) return null` 这个 early return **之前**——
   *  否则无 tab 时提前 return 会跳过这个 useCallback，导致两次渲染 hook 数量不一致
   *  （"Rendered more hooks than during the previous render" 崩溃）。 */
  const handleCloseAll = useCallback(() => {
    const doIt = () => {
      const viewingNote =
        location.pathname.startsWith("/notes/") ||
        location.pathname.startsWith("/whiteboard/");
      closeAllTabs();
      tabRefs.current.clear();
      if (viewingNote) navigate("/notes");
    };
    const hasDirty = tabs.some((t) => t.dirty);
    if (hasDirty) {
      Modal.confirm({
        title: "关闭全部标签页",
        content: "有标签页存在未保存的修改，关闭全部会丢弃这些草稿。是否继续？",
        okText: "全部关闭",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: doIt,
      });
    } else {
      doIt();
    }
  }, [tabs, closeAllTabs, navigate, location.pathname]);

  if (tabs.length === 0 && officeSessions.length === 0) return null;

  const menuFor = (id: number): MenuProps["items"] => [
    { key: "close", label: "关闭" },
    { key: "close-others", label: "关闭其他", disabled: tabs.length === 1 },
    {
      key: "close-right",
      label: "关闭右侧",
      disabled: tabs.findIndex((t) => t.id === id) >= tabs.length - 1,
    },
    { type: "divider" },
    { key: "close-all", label: "关闭全部", disabled: tabs.length === 0 },
  ];

  function onMenuClick(id: number, key: string) {
    if (key === "close") handleClose(id);
    else if (key === "close-others") closeOtherTabs(id);
    else if (key === "close-right") closeTabsToRight(id);
    else if (key === "close-all") handleCloseAll();
  }

  return (
    <div
      className="kb-surface"
      style={{
        display: "flex",
        alignItems: "flex-end",
        height: 38,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgLayout,
        flexShrink: 0,
        paddingLeft: 4,
      }}
    >
      {/* 左侧固定：回到文档列表 */}
      <Tooltip title="文档列表">
        <button
          type="button"
          onClick={() => navigate("/notes")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 28,
            marginBottom: 4,
            marginRight: 4,
            border: "none",
            background: "transparent",
            borderRadius: 6,
            cursor: "pointer",
            color: token.colorTextSecondary,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = token.colorFillSecondary;
            e.currentTarget.style.color = token.colorText;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = token.colorTextSecondary;
          }}
        >
          <ListTree size={16} />
        </button>
      </Tooltip>

      {/* dirty tab 关闭确认 */}
      <Modal
        open={confirmTab !== null}
        title={confirmTab ? `「${confirmTab.title || "未命名"}」尚未保存` : ""}
        onCancel={() => !closing && setConfirmTab(null)}
        mask={{ closable: !closing }}
        closable={!closing}
        footer={[
          <Button key="discard" danger disabled={closing} onClick={handleDiscardAndClose}>
            放弃修改并关闭
          </Button>,
          <Button key="cancel" disabled={closing} onClick={() => setConfirmTab(null)}>
            取消
          </Button>,
          <Button key="save" type="primary" loading={closing} onClick={handleSaveAndClose}>
            保存并关闭
          </Button>,
        ]}
      >
        <p>关闭此文档会丢失尚未持久化的修改。请选择操作。</p>
      </Modal>

      {/* 中间可滚动 tab 容器 */}
      <div
        ref={scrollerRef}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "flex-end",
          gap: 2,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none", // Firefox
          minWidth: 0,
        }}
        className="tabbar-scroller"
      >
        {tabs.map((tab) => {
          // 在 Office 页面时，文档标签不再高亮，避免与 Office 标签同时激活
          const isActive = tab.id === activeId && !onOfficeRoute;
          return (
            <Dropdown
              key={tab.id}
              menu={{
                items: menuFor(tab.id),
                onClick: ({ key }) => onMenuClick(tab.id, key),
              }}
              trigger={["contextMenu"]}
            >
              <div
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                onClick={() => handleSelect(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    handleClose(tab.id);
                  }
                }}
                title={tab.title}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 8px 0 12px",
                  height: 28,
                  marginBottom: 4,
                  cursor: "pointer",
                  background: "transparent",
                  color: isActive ? token.colorPrimary : token.colorTextSecondary,
                  fontSize: 13,
                  whiteSpace: "nowrap",
                  // tab 在 flex 容器里默认可收缩，标签一多就被压到 minWidth，
                  // 中文只剩一两个字看不出是哪篇。改成禁止收缩 + 抬高下限：
                  // 宽度只由标题内容在 [160, 240] 之间决定，超出总宽由外层横向滚动
                  // （容器已是 overflowX:auto，且切换 tab 会 scrollIntoView）。
                  flexShrink: 0,
                  maxWidth: 240,
                  minWidth: 160,
                  borderRadius: 8,
                  border: `1px solid ${isActive ? token.colorPrimary : "transparent"}`,
                  userSelect: "none",
                  transition: "background 0.15s ease, color 0.15s ease, border-color 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = token.colorFillQuaternary;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = "transparent";
                  }
                }}
              >
                <FileTypeIcon type={tab.sourceFileType} size={14} />
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  {tab.title || "未命名"}
                  {tab.dirty ? " •" : ""}
                </span>
                <button
                  type="button"
                  onClick={(e) => handleClose(tab.id, e)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 18,
                    height: 18,
                    border: "none",
                    background: "transparent",
                    borderRadius: 4,
                    cursor: "pointer",
                    color: token.colorTextTertiary,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = token.colorFillSecondary;
                    e.stopPropagation();
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            </Dropdown>
          );
        })}

        {/* Office 文档标签：与文档标签同一视觉体系 */}
        {officeSessions.map((session) => {
          const isActive =
            onOfficeRoute && currentOfficePath === normalizePath(session.path);
          return (
            <div
              key={`office-${session.id}`}
              onClick={() =>
                navigate(officePathForFile(session.path, !!session.readOnly))
              }
              title={session.path}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 8px 0 12px",
                height: 28,
                marginBottom: 4,
                cursor: "pointer",
                background: "transparent",
                color: isActive ? token.colorPrimary : token.colorTextSecondary,
                fontSize: 13,
                whiteSpace: "nowrap",
                flexShrink: 0,
                maxWidth: 240,
                minWidth: 160,
                borderRadius: 8,
                border: `1px solid ${isActive ? token.colorPrimary : "transparent"}`,
                userSelect: "none",
                transition: "background 0.15s ease, color 0.15s ease, border-color 0.15s ease",
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = token.colorFillQuaternary;
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              <FileTypeIcon type={session.format} size={14} />
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontWeight: isActive ? 500 : 400,
                }}
              >
                {session.name || "未命名"}
                {session.dirty ? " •" : ""}
              </span>
              <button
                type="button"
                onClick={(e) => handleOfficeClose(session, e)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  border: "none",
                  background: "transparent",
                  borderRadius: 4,
                  cursor: "pointer",
                  color: token.colorTextTertiary,
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = token.colorFillSecondary;
                  e.stopPropagation();
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
