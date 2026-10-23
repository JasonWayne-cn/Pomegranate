import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { Button, Space, Tooltip, App as AntdApp, theme as antdTheme } from "antd";
import { ZoomIn, ZoomOut, Maximize2, Download, X } from "lucide-react";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { systemApi } from "@/lib/api";
import { KB_ASSET_SCHEME, parseKbAsset } from "@/lib/assetUrl";

interface Props {
  /** 是否显示——父级控制；隐藏时不挂载 svg、销毁 markmap 实例 */
  open: boolean;
  onClose: () => void;
  /** 笔记 markdown 原文（编辑时实时刷新视图） */
  markdown: string;
  /** 笔记标题（用作根节点 fallback / 导出文件名） */
  title: string;
  /** standalone = 独立窗口模式（当前仅作兼容） */
  variant?: string;
}

/**
 * 思维导图视图（只读，编辑器右侧嵌入式分栏）
 *
 * 设计要点（v3，从 Drawer 改为编辑器内嵌 flex 子节点）：
 * - **真分屏**：编辑器和导图是 sibling，共享主区宽度，互不覆盖
 *   （v2 用 antd Drawer 是错的——Drawer 是 fixed 浮层不会推开 sibling）
 * - **maxWidth=300**：限制 markmap 节点宽度，长代码块自动折行不溢出
 * - **markdown 实时跟随**：父级 content 变化（每次 onChange）→ 重新 setData
 * - **fit 只做一次**：首次打开 fit 自适应；后续 markdown 变化只 setData
 * - **不渲染 chrome**：宽度 / 关闭由父级 splitter 控制；本组件只画工具栏 + svg
 */
const transformer = new Transformer();

export function MindMapView({ open, onClose, markdown, title, variant: _variant }: Props) {
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const mmRef = useRef<Markmap | null>(null);

  // open 切到 true 时初始化；切到 false 时销毁 markmap 实例（svg 由父级 unmount）
  useEffect(() => {
    if (!open) {
      if (mmRef.current) {
        mmRef.current.destroy();
        mmRef.current = null;
      }
      return;
    }

    const raf = requestAnimationFrame(() => {
      if (!svgRef.current) return;

      const md = markdown.trim()
        ? markdown
        : `# ${title || "未命名文档"}\n`;
      const { root } = transformer.transform(md);

      if (mmRef.current) {
        // 后续更新：只 setData，不 fit（避免敲键时画布跳动）
        void mmRef.current.setData(root);
      } else {
        // 首次创建：限制节点最大宽度防止 foreignObject 溢出
        mmRef.current = Markmap.create(
          svgRef.current,
          { maxWidth: 300 },
          root,
        );
      }
    });

    return () => cancelAnimationFrame(raf);
  }, [open, markdown, title]);

  /**
   * 拦截导图里的链接点击。
   *
   * markmap 会把 Markdown 链接渲染成原生 <a href>，在 Tauri WebView 里点击会直接
   * 触发整页导航；target 是 file: / 相对路径时会被 CSP 拦下并回退到
   * http://tauri.localhost/（上游 bug #9725），表现就是整个界面闪一下启动时的黑屏，
   * 未保存状态也随之丢失。这里统一 preventDefault，改由系统默认程序打开。
   */
  function handleLinkClick(e: ReactMouseEvent<HTMLDivElement>) {
    // 中键（auxclick）走同一套处理；左键之外的辅助键不拦
    if (e.type === "auxclick" && e.button !== 1) return;
    const target = e.target as Element | null;
    const anchor = target?.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href || href === "javascript:void(0)") return;

    e.preventDefault();
    e.stopPropagation();

    // 页面内锚点：不让 WebView 改 location.hash（HashRouter 的当前路由会被冲掉）
    if (href.startsWith("#")) {
      const el = document.getElementById(decodeURIComponent(href.slice(1)));
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    if (href.startsWith(KB_ASSET_SCHEME)) {
      const rel = parseKbAsset(href) ?? "";
      void systemApi
        .resolveAssetAbsolute(rel)
        .then((abs) => openPath(abs))
        .catch((err) => message.error(`打开附件失败：${err}`));
      return;
    }
    if (/^https?:\/\//i.test(href) || /^(mailto|tel):/i.test(href)) {
      void openUrl(href).catch((err) => message.error(`打开链接失败：${err}`));
      return;
    }
    if (href.startsWith("file://")) {
      let path = href.replace(/^file:\/{2,3}/, "");
      try {
        path = decodeURIComponent(path);
      } catch {
        /* 保留原样，让 opener 报具体错误 */
      }
      void openPath(path).catch((err) => message.error(`打开文件失败：${err}`));
      return;
    }
    // 相对路径在导图组件里没有笔记目录上下文，既不解析也不让 WebView 导航
    message.info("思维导图中暂不支持打开相对路径链接");
  }

  function handleZoom(factor: number) {
    void mmRef.current?.rescale(factor);
  }

  function handleFit() {
    void mmRef.current?.fit();
  }

  async function handleExportSvg() {
    const svg = svgRef.current;
    if (!svg) return;
    try {
      const targetPath = await save({
        title: "导出思维导图为 SVG",
        defaultPath: `${title || "mindmap"}.svg`,
        filters: [{ name: "SVG 矢量图", extensions: ["svg"] }],
      });
      if (!targetPath) return;
      const xml = new XMLSerializer().serializeToString(svg);
      const content = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
      await systemApi.writeTextFile(targetPath, content);
      message.success("已导出 SVG");
    } catch (e) {
      message.error(`导出失败：${e}`);
    }
  }

  if (!open) return null;

  return (
    <div
      className="flex flex-col"
      style={{
        width: "100%",
        height: "100%",
        background: token.colorBgContainer,
        borderLeft: `1px solid ${token.colorBorderSecondary}`,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      {/* 工具栏：标题 + 缩放/适应/导出/关闭 */}
      <div
        className="flex items-center justify-between gap-2"
        style={{
          padding: "6px 10px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}
      >
        <span
          className="truncate"
          style={{ fontSize: 12, color: token.colorTextSecondary }}
          title={`思维导图 · ${title || "未命名"}`}
        >
          🧠 {title || "未命名"}
        </span>
        <Space size={2}>
          <Tooltip title="放大">
            <Button
              size="small"
              type="text"
              icon={<ZoomIn size={13} />}
              onClick={() => handleZoom(1.25)}
            />
          </Tooltip>
          <Tooltip title="缩小">
            <Button
              size="small"
              type="text"
              icon={<ZoomOut size={13} />}
              onClick={() => handleZoom(0.8)}
            />
          </Tooltip>
          <Tooltip title="自适应">
            <Button
              size="small"
              type="text"
              icon={<Maximize2 size={13} />}
              onClick={handleFit}
            />
          </Tooltip>
          <Tooltip title="导出 SVG">
            <Button
              size="small"
              type="text"
              icon={<Download size={13} />}
              onClick={() => void handleExportSvg()}
            />
          </Tooltip>
          <Tooltip title="关闭">
            <Button
              size="small"
              type="text"
              icon={<X size={13} />}
              onClick={onClose}
            />
          </Tooltip>
        </Space>
      </div>

      {/* SVG 容器：占满剩余空间（链接点击统一拦截，见 handleLinkClick） */}
      <div
        style={{ flex: 1, minHeight: 0, position: "relative" }}
        onClick={handleLinkClick}
        onAuxClick={handleLinkClick}
      >
        <svg
          ref={svgRef}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
          }}
        />
      </div>
    </div>
  );
}
