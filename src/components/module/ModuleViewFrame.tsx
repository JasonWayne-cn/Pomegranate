import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button, Result, Tag, Typography, theme as antdTheme } from "antd";
import { ArrowLeft, Puzzle } from "lucide-react";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import type { ModuleViewMeta } from "@/modules/viewContract";

const { Text } = Typography;

const SOURCE_LABELS: Record<ModuleViewMeta["source"], string> = {
  builtin: "内置",
  plugin: "插件",
  extension: "扩展包",
};

/** 自渲染视图（插件）的挂载宿主：负责 try/catch 与 cleanup。 */
function MountHost({
  mount,
  mountKey,
}: {
  mount: (el: HTMLElement) => void | (() => void);
  mountKey?: string | number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cleanup: void | (() => void);
    setError(null);
    el.innerHTML = "";
    try {
      cleanup = mount(el);
    } catch (e) {
      cleanup = undefined;
      setError(String(e));
      el.innerHTML = "";
    }
    return () => {
      try {
        if (typeof cleanup === "function") cleanup();
        else el.innerHTML = "";
      } catch (e) {
        console.warn("[ModuleViewFrame] 视图清理失败:", e);
      }
    };
    // retry 变化时强制重新挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mount, mountKey, retry]);

  if (error) {
    return (
      <div className="flex items-center justify-center" style={{ height: "100%" }}>
        <Result
          status="error"
          title="视图加载失败"
          subTitle={error}
          extra={
            <Button type="primary" onClick={() => setRetry((n) => n + 1)}>
              重新加载
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="module-view-body"
      style={{ flex: 1, minHeight: 0, height: "100%", overflow: "auto" }}
    />
  );
}

export interface ModuleViewFrameProps {
  meta: ModuleViewMeta;
  /** React 渲染内容（扩展页面） */
  children?: ReactNode;
  /** 自渲染挂载函数（插件） */
  mount?: (el: HTMLElement) => void | (() => void);
  /** 视图重挂载标识 */
  mountKey?: string | number;
  /** 是否显示统一标题栏，默认 true */
  chrome?: boolean;
  onBack?: () => void;
  actions?: ReactNode;
  /** 重置错误边界 */
  resetKey?: string | number;
  className?: string;
  style?: CSSProperties;
}

/**
 * 模块视图统一容器（方案 3）。
 *
 * - 插件视图：通过 `mount` 注入 DOM，容器负责错误隔离与清理。
 * - 扩展页面：通过 `children` 渲染宿主 React 页面。
 * - 两者共享来源标识、标题栏、布局与错误边界，不统一渲染技术。
 */
export function ModuleViewFrame({
  meta,
  children,
  mount,
  mountKey,
  chrome = true,
  onBack,
  actions,
  resetKey,
  className,
  style,
}: ModuleViewFrameProps) {
  const { token } = antdTheme.useToken();
  const layout = meta.layout ?? "standard";
  const showChrome = chrome && layout !== "fullscreen";
  const sourceLabel = meta.sourceLabel ?? SOURCE_LABELS[meta.source];

  const renderBody = useCallback(() => {
    if (mount) {
      return (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            padding: layout === "fullscreen" ? 0 : 16,
          }}
        >
          <MountHost
            mount={mount}
            mountKey={`${mountKey ?? "default"}:${resetKey ?? "default"}`}
          />
        </div>
      );
    }
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          height: "100%",
          overflow: layout === "fullscreen" ? "hidden" : "auto",
          padding: layout === "fullscreen" ? 0 : 16,
        }}
      >
        {children}
      </div>
    );
  }, [mount, mountKey, resetKey, children, layout]);

  return (
    <div
      className={className}
      data-module-view={meta.id}
      data-module-source={meta.source}
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
    >
      {showChrome && (
        <div
          style={{
            padding: "8px 16px",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: token.colorBgContainer,
            flexShrink: 0,
          }}
        >
          {onBack && (
            <Button
              type="text"
              size="small"
              icon={<ArrowLeft size={16} />}
              onClick={onBack}
              aria-label="返回"
            />
          )}
          <span style={{ display: "inline-flex", color: token.colorPrimary }}>
            {meta.icon ?? <Puzzle size={16} />}
          </span>
          <Text strong style={{ fontSize: 15 }}>
            {meta.title}
          </Text>
          <Tag color={meta.source === "plugin" ? "geekblue" : "blue"}>
            {sourceLabel}
          </Tag>
          <div style={{ flex: 1 }} />
          {meta.pluginId && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              插件: {meta.pluginId}
            </Text>
          )}
          {actions}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: layout === "fullscreen" ? "hidden" : "visible",
        }}
      >
        <ErrorBoundary key={`${meta.id}:${resetKey ?? "default"}`}>
          {renderBody()}
        </ErrorBoundary>
      </div>
    </div>
  );
}
