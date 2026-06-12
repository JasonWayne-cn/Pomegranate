/**
 * Deepseek-TUI 插件 (单文件)
 *
 * 通过 ctx.app.invoke / ctx.app.onTauriEvent 桥接调用现有 AI Command，
 * 零 Rust 改动。终端 UI 纯 DOM 渲染，参考 DeepSeek TUI 暗色配色。
 */

/* ================================================================
 * DeepseekAPI — AI API 封装层
 * ================================================================ */
var DeepseekAPI = (function () {
  var _app = null;
  var _conversationId = null;
  var _listeners = [];  // 所有事件监听器清理句柄

  function init(app) { _app = app; }

  async function ensureConversation() {
    if (_conversationId) return _conversationId;
    var conv = await _app.invoke("create_ai_conversation", {
      title: "Deepseek 终端对话",
    });
    _conversationId = conv.id;
    return _conversationId;
  }

  async function send(message, callbacks) {
    var cid = await ensureConversation();
    cleanup();  // 清理上一次的全部监听器
    var fullText = "";

    _listeners.push(await _app.onTauriEvent("ai:token", function (payload) {
      // Rust emit("ai:token", content) — content 是纯字符串
      var token = typeof payload === "string" ? payload : (payload && payload.token);
      if (token) {
        fullText += token;
        if (callbacks && callbacks.onToken) {
          callbacks.onToken(token, fullText);
        }
      }
    }));
    _listeners.push(await _app.onTauriEvent("ai:done", function () {
      cleanup();
      if (callbacks && callbacks.onDone) callbacks.onDone(fullText);
    }));
    _listeners.push(await _app.onTauriEvent("ai:error", function (payload) {
      cleanup();
      var err = typeof payload === "string" ? payload : (payload && payload.error) || "未知错误";
      if (callbacks && callbacks.onError) callbacks.onError(err);
    }));

    await _app.invoke("send_ai_message", { conversationId: cid, message: message });
    return function cancel() {
      cleanup();
      _app.invoke("cancel_ai_generation", { conversationId: cid }).catch(function () {});
    };
  }

  async function newSession(title) {
    _conversationId = null;
    cleanup();
    var conv = await _app.invoke("create_ai_conversation", {
      title: title || "Deepseek 终端对话",
    });
    _conversationId = conv.id;
    return conv;
  }

  async function getHistory() {
    var cid = await ensureConversation();
    return _app.invoke("list_ai_messages", { conversationId: cid });
  }

  async function listConversations() {
    return _app.invoke("list_ai_conversations");
  }

  function switchConversation(id) {
    cleanup();
    _conversationId = id;
  }

  function getConversationId() { return _conversationId; }

  function cleanup() {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](); } catch (e) {}
    }
    _listeners = [];
  }

  function destroy() {
    cleanup();
    _conversationId = null;
    _app = null;
  }

  return { init: init, send: send, newSession: newSession, getHistory: getHistory,
    listConversations: listConversations, switchConversation: switchConversation,
    getConversationId: getConversationId, cleanup: cleanup, destroy: destroy };
})();

/* ================================================================
 * DeepseekTerminal — 终端 UI 渲染引擎 (纯 DOM)
 * ================================================================ */
var DeepseekTerminal = (function () {
  var PROMPT_SYMBOL = "\u25B6";
  var USER_PREFIX = "$ ";
  var AI_PREFIX = "\u2500\u2500 ";

  function create(container, app) {
    var el = {};
    var state = { streaming: false, streamingBlock: null, conversations: [] };

    // ─── 根容器 flex row ───
    el.root = document.createElement("div");
    el.root.className = "dt-root";

    // ─── 左侧会话列表面板 ───
    var sidebar = document.createElement("div");
    sidebar.className = "dt-sidebar";

    var sidebarHeader = document.createElement("div");
    sidebarHeader.className = "dt-sidebar-header";
    sidebarHeader.innerHTML = '<span class="dt-sidebar-title">会话</span>';

    var newBtn = document.createElement("button");
    newBtn.className = "dt-sidebar-new-btn";
    newBtn.textContent = "+";
    newBtn.title = "新建会话";
    newBtn.addEventListener("click", function () { handleNewSession(); });
    sidebarHeader.appendChild(newBtn);
    sidebar.appendChild(sidebarHeader);

    var sidebarList = document.createElement("div");
    sidebarList.className = "dt-sidebar-list";
    sidebar.appendChild(sidebarList);

    el.root.appendChild(sidebar);

    // ─── 右侧主区域 ───
    var mainArea = document.createElement("div");
    mainArea.className = "dt-main";

    el.output = document.createElement("div");
    el.output.className = "dt-output";
    mainArea.appendChild(el.output);

    el.inputWrapper = document.createElement("div");
    el.inputWrapper.className = "dt-input-wrapper";
    el.promptSpan = document.createElement("span");
    el.promptSpan.className = "dt-prompt";
    el.promptSpan.textContent = PROMPT_SYMBOL + " ";
    el.input = document.createElement("textarea");
    el.input.className = "dt-input";
    el.input.rows = 1;
    el.input.placeholder = "输入消息，Enter 发送，Shift+Enter 换行...";
    el.inputWrapper.appendChild(el.promptSpan);
    el.inputWrapper.appendChild(el.input);
    mainArea.appendChild(el.inputWrapper);

    el.statusBar = document.createElement("div");
    el.statusBar.className = "dt-statusbar";
    el.statusBar.textContent = "Ctrl+N 新会话 | Ctrl+L 清屏 | Enter 发送 | Escape 取消";
    mainArea.appendChild(el.statusBar);

    el.root.appendChild(mainArea);
    container.appendChild(el.root);

    // ─── 输入事件 ───
    el.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
      else if (e.ctrlKey && e.key === "l") { e.preventDefault(); clearOutput(); }
      else if (e.ctrlKey && e.key === "n") { e.preventDefault(); handleNewSession(); }
      else if (e.key === "Escape") { e.preventDefault(); handleCancel(); }
    });
    el.input.addEventListener("input", function () {
      el.input.style.height = "auto";
      el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
    });

    function scrollBottom() { el.output.scrollTop = el.output.scrollHeight; }
    function handleCancel() { if (state.streaming) api.cancel(); }

    // ─── 会话列表渲染 ───
    function renderConversationList() {
      sidebarList.innerHTML = "";
      var activeId = DeepseekAPI.getConversationId();
      for (var i = 0; i < state.conversations.length; i++) {
        var conv = state.conversations[parseInt(i,10)];
        var item = document.createElement("div");
        item.className = "dt-conv-item" + (conv.id === activeId ? " dt-conv-active" : "");
        item.title = conv.title || ("对话 #" + conv.id);
        item.textContent = conv.title || ("对话 #" + conv.id);
        item.addEventListener("click", (function (c) {
          return function () {
            DeepseekAPI.switchConversation(c.id);
            clearOutput();
            loadHistory();
            renderConversationList();
          };
        })(conv));
        sidebarList.appendChild(item);
      }
    }

    async function loadConversations() {
      try {
        var list = await DeepseekAPI.listConversations();
        state.conversations = list || [];
        renderConversationList();
      } catch (e) { console.warn("[deepseek-tui] 加载会话列表失败:", e); }
    }

    async function loadHistory() {
      try {
        var msgs = await DeepseekAPI.getHistory();
        if (!msgs || !msgs.length) return;
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[parseInt(i,10)];
          if (m.role === "user") {
            var block = document.createElement("div");
            block.className = "dt-msg dt-msg-user";
            block.innerHTML = '<span class="dt-user-prefix">' + USER_PREFIX + '</span><span class="dt-user-text"></span>';
            block.querySelector(".dt-user-text").textContent = m.content || "";
            el.output.appendChild(block);
          } else if (m.role === "assistant") {
            var ablock = document.createElement("div");
            ablock.className = "dt-msg dt-msg-ai";
            ablock.innerHTML = '<div class="dt-ai-prefix">' + AI_PREFIX + 'Deepseek</div><div class="dt-ai-text"></div>';
            var textDiv = ablock.querySelector(".dt-ai-text");
            textDiv.textContent = m.content || "";
            renderMarkdownBlocks(textDiv, m.content || "");
            el.output.appendChild(ablock);
          }
        }
        scrollBottom();
      } catch (e) { console.warn("[deepseek-tui] 加载历史失败:", e); }
    }

    var api = {
      addUserMessage: function (text) {
        var block = document.createElement("div");
        block.className = "dt-msg dt-msg-user";
        var prefix = document.createElement("span");
        prefix.className = "dt-user-prefix";
        prefix.textContent = USER_PREFIX;
        var content = document.createElement("span");
        content.className = "dt-user-text";
        content.textContent = text;
        block.appendChild(prefix);
        block.appendChild(content);
        el.output.appendChild(block);
        scrollBottom();
      },
      startAiMessage: function () {
        state.streaming = true;
        var block = document.createElement("div");
        block.className = "dt-msg dt-msg-ai";
        var prefix = document.createElement("div");
        prefix.className = "dt-ai-prefix";
        prefix.textContent = AI_PREFIX + "Deepseek";
        var content = document.createElement("div");
        content.className = "dt-ai-text";
        content.innerHTML = '<span class="dt-cursor">\u258B</span>';
        block.appendChild(prefix);
        block.appendChild(content);
        el.output.appendChild(block);
        state.streamingBlock = block;
        state.streamingContent = content;
        scrollBottom();
      },
      appendAiToken: function (token) {
        if (!state || !state.streamingContent) return;
        var cursor = state.streamingContent.querySelector(".dt-cursor");
        if (cursor) cursor.remove();
        var span = document.createElement("span");
        span.textContent = token;
        state.streamingContent.appendChild(span);
        var newCursor = document.createElement("span");
        newCursor.className = "dt-cursor";
        newCursor.textContent = "\u258B";
        state.streamingContent.appendChild(newCursor);
        scrollBottom();
      },
      finishAiMessage: function (fullText) {
        if (!state) return;
        state.streaming = false;
        if (state.streamingContent) {
          var cursor = state.streamingContent.querySelector(".dt-cursor");
          if (cursor) cursor.remove();
          renderMarkdownBlocks(state.streamingContent, fullText);
        }
        state.streamingBlock = null;
        state.streamingContent = null;
        loadConversations();
      },
      showAiError: function (error) {
        if (!state) return;
        state.streaming = false;
        if (state.streamingContent) {
          var cursor = state.streamingContent.querySelector(".dt-cursor");
          if (cursor) cursor.remove();
          var errSpan = document.createElement("span");
          errSpan.className = "dt-error";
          errSpan.textContent = " [错误: " + (error || "未知") + "]";
          state.streamingContent.appendChild(errSpan);
        }
        state.streamingBlock = null;
        state.streamingContent = null;
      },
      getInput: function () {
        var text = el.input.value.trim();
        el.input.value = "";
        el.input.style.height = "auto";
        return text;
      },
      focus: function () { el.input.focus(); },
      clear: function () { clearOutput(); },
      newSession: function () { handleNewSession(); },
      destroy: function () {
        if (el.root && el.root.parentNode) el.root.parentNode.removeChild(el.root);
        state = null; el = {};
      },
    };

    async function handleSend() {
      var text = api.getInput();
      if (!text || state.streaming) return;
      api.addUserMessage(text);
      api.startAiMessage();
      try {
        await DeepseekAPI.send(text, {
          onToken: function (token) { api.appendAiToken(token); },
          onDone: function (fullText) { api.finishAiMessage(fullText); },
          onError: function (err) { api.showAiError(err); },
        });
      } catch (e) { api.showAiError(String(e)); }
    }

    async function handleNewSession() {
      try {
        await DeepseekAPI.newSession();
        clearOutput();
        loadConversations();
        var msg = document.createElement("div");
        msg.className = "dt-system-msg";
        msg.textContent = "\u2500\u2500 新会话已创建 \u2500\u2500";
        el.output.appendChild(msg);
        scrollBottom();
      } catch (e) { app.notices.error("新建会话失败: " + e); }
    }

    function clearOutput() { el.output.innerHTML = ""; }

    function renderMarkdownBlocks(container) {
      var html = container.innerHTML;
      html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
        var langLabel = lang ? '<span class="dt-code-lang">' + lang + '</span>' : '';
        return '<div class="dt-code-block">' + langLabel + '<pre><code>' + escapeHtml(code) + '</code></pre></div>';
      });
      html = html.replace(/`([^`]+)`/g, '<code class="dt-inline-code">$1</code>');
      container.innerHTML = html;
    }

    function escapeHtml(text) {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    DeepseekAPI.init(app);
    loadConversations();
    api.focus();
    return api;
  }

  return { create: create };
})();

/* ================================================================
 * 插件入口 — onLoad / onUnload
 * ================================================================ */
var terminalInstance = null;

module.exports = {
  onLoad: function (ctx) {
    var app = ctx.app;

    app.panelViews.register({
      id: "deepseek-terminal",
      title: "Deepseek 终端",
      icon: "Terminal",
      render: function (container) {
        if (terminalInstance) terminalInstance.destroy();
        terminalInstance = DeepseekTerminal.create(container, app);
        return function cleanup() {
          if (terminalInstance) { terminalInstance.destroy(); DeepseekAPI.destroy(); terminalInstance = null; }
        };
      },
    });

    if (app.sidebar && typeof app.sidebar.addItem === "function") {
      app.sidebar.addItem({ id: "deepseek-terminal-sidebar", icon: "Terminal", label: "Deepseek", viewId: "deepseek-terminal" });
    }

    if (app.ribbon && typeof app.ribbon.addItem === "function") {
      app.ribbon.addItem({ id: "deepseek-toggle", icon: "BrainCircuit", tooltip: "Deepseek 终端",
        onClick: function () { app.notices.show("请通过侧边栏打开 Deepseek 终端"); } });
    }

    app.commands.addCommand({ id: "deepseek.open", name: "Deepseek: 打开终端", group: "AI",
      callback: function () { app.notices.show("请通过侧边栏打开 Deepseek 终端"); } });

    app.commands.addCommand({ id: "deepseek.new-session", name: "Deepseek: 新建会话", group: "AI",
      callback: function () {
        DeepseekAPI.newSession().then(function () {
          if (terminalInstance) terminalInstance.focus();
          app.notices.show("Deepseek 新会话已创建");
        }).catch(function (e) { app.notices.error("新建会话失败: " + e); });
      } });

    console.log("[deepseek-tui] 激活完成");
  },

  onUnload: function () {
    if (terminalInstance) { terminalInstance.destroy(); terminalInstance = null; }
    DeepseekAPI.destroy();
  },
};
