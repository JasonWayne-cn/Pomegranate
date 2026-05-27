import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Empty, Spin, Typography, theme as antdTheme } from "antd";
import { ArrowLeft, Plug } from "lucide-react";
import { pluginApi } from "@/lib/api";
import type { PluginInfo } from "@/types";

const { Text } = Typography;

function escapeStyleContent(value: string) {
  return value.replace(/<\/style/gi, "<\\/style");
}

function sourceLabel(plugin: PluginInfo) {
  return `${plugin.id}-${plugin.main}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function jsonForInlineScript(value: unknown) {
  const json = JSON.stringify(value);
  return (json ?? "null").replace(/</g, "\\u003c");
}

function buildPluginFrameHtml(
  plugin: PluginInfo,
  viewId: string,
  script: string,
  styles: string,
) {
  const css = escapeStyleContent(styles);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body, #plugin-root {
      width: 100%;
      height: 100%;
      margin: 0;
    }
    body {
      overflow: hidden;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f1f1f;
      background: #fff;
    }
    * { box-sizing: border-box; }
    ${css}
  </style>
</head>
<body>
  <div id="plugin-root"></div>
  <script>
    (function () {
      var pluginId = ${jsonForInlineScript(plugin.id)};
      var pluginName = ${jsonForInlineScript(plugin.name)};
      var targetViewId = ${jsonForInlineScript(viewId)};
      var source = ${jsonForInlineScript(script)};
      var sourceLabel = ${jsonForInlineScript(sourceLabel(plugin))};
      var root = document.getElementById("plugin-root");
      var panels = [];
      var pluginApi = null;
      var mountedPanel = null;

      function renderError(error) {
        var message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
        root.innerHTML = "";
        var wrapper = document.createElement("div");
        wrapper.style.cssText = "height:100%;display:flex;align-items:center;justify-content:center;padding:24px;background:#fff";
        var box = document.createElement("div");
        box.style.cssText = "max-width:720px;width:100%;border:1px solid #ffccc7;background:#fff2f0;border-radius:8px;padding:16px;color:#a8071a;font-size:13px;line-height:1.6";
        var title = document.createElement("div");
        title.textContent = "插件界面渲染失败";
        title.style.cssText = "font-weight:600;margin-bottom:8px";
        var pre = document.createElement("pre");
        pre.textContent = message;
        pre.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace";
        box.appendChild(title);
        box.appendChild(pre);
        wrapper.appendChild(box);
        root.appendChild(wrapper);
      }

      function pickPanel() {
        return panels.find(function (panel) {
          return panel && panel.pluginId === pluginId && panel.id === targetViewId;
        }) || panels.find(function (panel) {
          return panel && panel.id === targetViewId;
        }) || panels.find(function (panel) {
          return panel && panel.pluginId === pluginId;
        }) || panels[0] || null;
      }

      var ctx = {
        pluginId: pluginId,
        viewId: targetViewId,
        registerPanelView: function (panel) {
          if (panel && typeof panel.render === "function") panels.push(panel);
        },
        registerSidebarItem: function () {},
        registerCommand: function () {},
        getSettings: function () { return {}; },
        setSettings: function () {},
        postMessage: function (type, payload) {
          window.parent && window.parent.postMessage({
            source: "inb-plugin",
            pluginId: pluginId,
            type: type,
            payload: payload
          }, "*");
        }
      };

      function requireStub(name) {
        throw new Error("插件运行时暂不支持 require: " + name);
      }

      try {
        var module = { exports: {} };
        var exports = module.exports;
        var run = new Function("module", "exports", "require", "ctx", source + "\\n//# sourceURL=inb-plugin-" + sourceLabel);
        run(module, exports, requireStub, ctx);

        pluginApi = module.exports && (module.exports.default || module.exports);
        if (typeof pluginApi === "function") {
          pluginApi(ctx);
        } else if (pluginApi && typeof pluginApi.onLoad === "function") {
          pluginApi.onLoad(ctx);
        }

        mountedPanel = pickPanel();
        if (!mountedPanel && pluginApi && typeof pluginApi.render === "function") {
          mountedPanel = { id: targetViewId, title: pluginName, render: pluginApi.render, unmount: pluginApi.unmount };
        }
        if (!mountedPanel) {
          throw new Error("插件没有注册可渲染的主界面");
        }

        document.title = mountedPanel.title || pluginName;
        mountedPanel.render(root, ctx);
      } catch (error) {
        console.error("[plugin-runtime] render failed", error);
        renderError(error);
      }

      window.addEventListener("pagehide", function () {
        try {
          if (mountedPanel && typeof mountedPanel.unmount === "function") mountedPanel.unmount(root, ctx);
          if (pluginApi && typeof pluginApi.onUnload === "function") pluginApi.onUnload(ctx);
        } catch (error) {
          console.warn("[plugin-runtime] unload failed", error);
        }
      });
    })();
  </script>
</body>
</html>`;
}

export default function PluginViewPage() {
  const { pluginId, viewId } = useParams<{ pluginId: string; viewId: string }>();
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const [plugin, setPlugin] = useState<PluginInfo | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pluginId || !viewId) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    (async () => {
      setLoading(true);
      setError(null);
      setPlugin(null);
      setFrameSrc(null);

      try {
        const plugins = await pluginApi.list();
        const found = plugins.find((p) => p.id === pluginId);
        if (!found) {
          setError(`插件「${pluginId}」未找到`);
          return;
        }
        if (!found.enabled) {
          setPlugin(found);
          setError(`插件「${found.name}」未启用，请先在插件管理中启用。`);
          return;
        }

        const [script, styles] = await Promise.all([
          pluginApi.readAsset(found.id, found.main),
          found.styles
            ? pluginApi.readAsset(found.id, found.styles).catch(() => "")
            : Promise.resolve(""),
        ]);
        const html = buildPluginFrameHtml(found, viewId, script, styles);
        objectUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));

        if (!cancelled) {
          setPlugin(found);
          setFrameSrc(objectUrl);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pluginId, viewId]);

  const view = plugin?.manifest.contributes.sidebarViews.find((v) => v.id === viewId);

  return (
    <div
      style={{
        height: "calc(100vh - 134px)",
        minHeight: 520,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Plug size={18} />
          <Text strong ellipsis>
            {plugin ? view?.title || plugin.name : "插件界面"}
          </Text>
        </div>
        <Button icon={<ArrowLeft size={14} />} onClick={() => navigate("/plugins")}>
          返回插件管理
        </Button>
      </div>

      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Spin size="large" />
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-1 items-center justify-center">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="danger">{error}</Text>}>
            <Button onClick={() => navigate("/plugins")}>返回插件管理</Button>
          </Empty>
        </div>
      )}

      {!loading && !error && !view && (
        <Alert
          type="warning"
          showIcon
          message={`视图「${viewId}」未在插件「${pluginId}」的 manifest 中声明，已尝试加载插件主界面。`}
        />
      )}

      {!loading && !error && frameSrc && (
        <iframe
          title={plugin ? `${plugin.name} - ${view?.title || viewId}` : "插件界面"}
          src={frameSrc}
          sandbox="allow-scripts allow-modals"
          style={{
            flex: 1,
            width: "100%",
            minHeight: 0,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 8,
            background: token.colorBgContainer,
          }}
        />
      )}
    </div>
  );
}
