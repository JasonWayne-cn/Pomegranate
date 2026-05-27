import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Alert, Empty, Spin, Typography, theme as antdTheme } from "antd";
import { Plug } from "lucide-react";
import { aiChatApi, pluginApi } from "@/lib/api";
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
      var requestSeq = 1;
      var pendingRequests = {};
      var hostListeners = {};

      function requestHost(type, payload) {
        return new Promise(function (resolve, reject) {
          var requestId = pluginId + ":" + Date.now() + ":" + requestSeq++;
          pendingRequests[requestId] = { resolve: resolve, reject: reject };
          window.parent && window.parent.postMessage({
            source: "inb-plugin",
            pluginId: pluginId,
            requestId: requestId,
            type: type,
            payload: payload
          }, "*");
        });
      }

      function onHostEvent(type, handler) {
        if (!hostListeners[type]) hostListeners[type] = [];
        hostListeners[type].push(handler);
        return function () {
          hostListeners[type] = (hostListeners[type] || []).filter(function (fn) { return fn !== handler; });
        };
      }

      function emitHostEvent(type, payload) {
        (hostListeners[type] || []).slice().forEach(function (handler) {
          try { handler(payload); } catch (error) { console.warn("[plugin-runtime] host event handler failed", error); }
        });
      }

      window.addEventListener("message", function (event) {
        var data = event.data || {};
        if (data.source !== "inb-host") return;
        if (data.requestId && pendingRequests[data.requestId]) {
          var pending = pendingRequests[data.requestId];
          delete pendingRequests[data.requestId];
          if (data.ok) pending.resolve(data.payload);
          else pending.reject(new Error(data.error || "宿主调用失败"));
          return;
        }
        if (data.type) emitHostEvent(data.type, data.payload);
      });

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
        requestHost: requestHost,
        onHostEvent: onHostEvent,
        ai: {
          createConversation: function (title) {
            return requestHost("ai:createConversation", { title: title });
          },
          listMessages: function (conversationId) {
            return requestHost("ai:listMessages", { conversationId: conversationId });
          },
          sendMessage: function (conversationId, message, options) {
            options = options || {};
            return requestHost("ai:sendMessage", {
              conversationId: conversationId,
              message: message,
              useRag: options.useRag !== false,
              useSkills: options.useSkills !== false
            });
          },
          cancelGeneration: function (conversationId) {
            return requestHost("ai:cancelGeneration", { conversationId: conversationId });
          },
          on: onHostEvent
        },
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
  const { token } = antdTheme.useToken();
  const [plugin, setPlugin] = useState<PluginInfo | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  function postToFrame(type: string, payload: unknown) {
    frameRef.current?.contentWindow?.postMessage({
      source: "inb-host",
      type,
      payload,
    }, "*");
  }

  async function handlePluginRequest(type: string, payload: Record<string, unknown>) {
    switch (type) {
      case "ai:createConversation":
        return aiChatApi.createConversation(
          typeof payload.title === "string" && payload.title.trim()
            ? payload.title.trim()
            : "Plugin-Sample 问答",
        );
      case "ai:listMessages":
        return aiChatApi.listMessages(Number(payload.conversationId));
      case "ai:sendMessage":
        await aiChatApi.sendMessage(
          Number(payload.conversationId),
          String(payload.message ?? ""),
          payload.useRag !== false,
          payload.useSkills !== false,
        );
        return true;
      case "ai:cancelGeneration":
        await aiChatApi.cancelGeneration(Number(payload.conversationId));
        return true;
      default:
        throw new Error(`未知插件宿主请求: ${type}`);
    }
  }

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

  useEffect(() => {
    if (!frameSrc) return;

    function respond(source: MessageEventSource | null, requestId: string, ok: boolean, payload?: unknown, error?: string) {
      source?.postMessage({
        source: "inb-host",
        requestId,
        ok,
        payload,
        error,
      }, { targetOrigin: "*" });
    }

    function onMessage(event: MessageEvent) {
      const data = event.data || {};
      if (data.source !== "inb-plugin") return;
      if (pluginId && data.pluginId !== pluginId) return;
      if (!data.requestId || typeof data.type !== "string") return;

      void (async () => {
        try {
          const result = await handlePluginRequest(data.type, data.payload || {});
          respond(event.source, data.requestId, true, result);
        } catch (e) {
          respond(event.source, data.requestId, false, null, String(e));
        }
      })();
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameSrc, pluginId]);

  useEffect(() => {
    if (!frameSrc) return;
    let cancelled = false;
    let unlistens: UnlistenFn[] = [];

    (async () => {
      const tokenUnlisten = await listen<string>("ai:token", (event) => {
        postToFrame("ai:token", event.payload);
      });
      const doneUnlisten = await listen<number | string>("ai:done", (event) => {
        postToFrame("ai:done", event.payload);
      });
      const errorUnlisten = await listen<string>("ai:error", (event) => {
        postToFrame("ai:error", event.payload);
      });
      const toolUnlisten = await listen("ai:tool_call", (event) => {
        postToFrame("ai:tool_call", event.payload);
      });
      if (cancelled) {
        tokenUnlisten();
        doneUnlisten();
        errorUnlisten();
        toolUnlisten();
        return;
      }
      unlistens = [tokenUnlisten, doneUnlisten, errorUnlisten, toolUnlisten];
    })();

    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
    };
  }, [frameSrc]);

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
      <div className="flex items-center gap-2 min-w-0">
        <Plug size={18} />
        <Text strong ellipsis>
          {plugin ? view?.title || plugin.name : "插件界面"}
        </Text>
      </div>

      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Spin size="large" />
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-1 items-center justify-center">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="danger">{error}</Text>} />
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
          ref={frameRef}
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
