/**
 * Plugin-Sample 插件 —— AI 智能问答示例。
 *
 * 通过宿主提供的 ctx.ai 受控能力复用应用内 AI 模型、会话与流式事件，
 * 插件本身不保存 API Key，也不直接访问外部网络。
 */

var TOPICS = [
  { id: "general", name: "智能问答", color: "#1677ff", desc: "通用 AI 对话，支持连续追问" },
  { id: "notes", name: "知识库问答", color: "#52c41a", desc: "开启智能模式，优先检索你的笔记" },
  { id: "writing", name: "写作助手", color: "#722ed1", desc: "润色、扩写、总结和改写" },
];

var state = {
  activeTopicId: "general",
  conversations: {},
  messages: {},
  streaming: false,
  streamingConversationId: null,
  streamingText: "",
  useSkills: true,
  ctx: null,
  els: {},
};

module.exports = {
  onLoad: function (ctx) {
    ctx.registerPanelView({
      id: "cc-sidebar-btn",
      pluginId: "cc",
      title: "Plugin-Sample",
      render: function (container) {
        state.ctx = ctx;
        renderChatLayout(container);
      },
      unmount: function (container) {
        container.innerHTML = "";
      },
    });
  },
  onUnload: function () {},
};

function renderChatLayout(container) {
  container.innerHTML = "";
  container.style.cssText = "height:100%;display:flex;overflow:hidden;background:#f5f5f5;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

  if (!state.ctx || !state.ctx.ai) {
    container.appendChild(emptyBox("宿主未提供 AI 能力，请更新应用后重试。"));
    return;
  }

  var cp = "#1677ff";
  var bc = "#e8e8e8";

  var sidebar = ce("div", { style: "width:248px;height:100%;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid " + bc + ";background:#fff" });
  container.appendChild(sidebar);

  var sideHeader = ce("div", { style: "padding:14px 14px 10px;border-bottom:1px solid " + bc });
  sideHeader.appendChild(ce("div", { textContent: "Plugin-Sample", style: "font-size:16px;font-weight:700;color:#1f1f1f;margin-bottom:4px" }));
  sideHeader.appendChild(ce("div", { textContent: "AI 智能问答插件示例", style: "font-size:12px;color:#888" }));
  sidebar.appendChild(sideHeader);

  var topicList = ce("div", { style: "flex:1;overflow:auto;padding:8px" });
  sidebar.appendChild(topicList);

  var sideFooter = ce("div", { style: "padding:10px 12px;border-top:1px solid " + bc + ";font-size:12px;color:#888;display:flex;align-items:center;justify-content:space-between;gap:8px" });
  var skillLabel = ce("label", { style: "display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none" });
  var skillSwitch = ce("input", {
    type: "checkbox",
    checked: state.useSkills,
    onchange: function () { state.useSkills = !!this.checked; },
  });
  skillLabel.appendChild(skillSwitch);
  skillLabel.appendChild(ce("span", { textContent: "智能模式" }));
  sideFooter.appendChild(skillLabel);
  sidebar.appendChild(sideFooter);

  var main = ce("div", { style: "flex:1;display:flex;flex-direction:column;height:100%;min-width:0;background:#fff" });
  container.appendChild(main);

  var header = ce("div", { style: "height:52px;padding:8px 16px;border-bottom:1px solid " + bc + ";display:flex;align-items:center;justify-content:space-between;gap:12px" });
  main.appendChild(header);

  var msgList = ce("div", { style: "flex:1;overflow:auto;padding:18px;background:linear-gradient(180deg,#fafafa 0%,#fff 100%)" });
  main.appendChild(msgList);

  var inputBar = ce("div", { style: "padding:12px 16px;border-top:1px solid " + bc + ";display:flex;gap:8px;align-items:flex-end;background:#fff" });
  main.appendChild(inputBar);

  var textarea = ce("textarea", {
    placeholder: "输入问题，Enter 发送，Shift+Enter 换行…",
    rows: 1,
    style: "flex:1;resize:none;border:1px solid #d9d9d9;border-radius:10px;padding:9px 12px;font-size:13px;font-family:inherit;outline:none;min-height:38px;max-height:140px;line-height:1.5;background:#fff",
    oninput: function () {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 140) + "px";
      sendBtn.disabled = !this.value.trim() || state.streaming;
    },
    onkeydown: function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    },
  });
  inputBar.appendChild(textarea);

  var sendBtn = ce("button", {
    textContent: "发送",
    disabled: true,
    style: buttonStyle(cp, "#fff") + ";width:72px;height:38px",
    onclick: function () { sendCurrentMessage(textarea, sendBtn, msgList); },
  });
  inputBar.appendChild(sendBtn);

  state.els = { topicList: topicList, header: header, msgList: msgList, textarea: textarea, sendBtn: sendBtn };

  state.ctx.ai.on("ai:token", function (token) {
    if (!state.streaming) return;
    state.streamingText += String(token || "");
    renderMessages(msgList);
  });
  state.ctx.ai.on("ai:done", function () {
    if (!state.streaming) return;
    var convId = state.streamingConversationId;
    state.streaming = false;
    state.streamingConversationId = null;
    state.streamingText = "";
    sendBtn.disabled = !textarea.value.trim();
    if (convId) {
      state.ctx.ai.listMessages(convId).then(function (messages) {
        var topicId = topicIdByConversation(convId) || state.activeTopicId;
        state.messages[topicId] = normalizeMessages(messages);
        renderTopics();
        renderMessages(msgList);
      }).catch(function () { renderMessages(msgList); });
    } else {
      renderMessages(msgList);
    }
  });
  state.ctx.ai.on("ai:error", function (error) {
    state.streaming = false;
    state.streamingConversationId = null;
    state.streamingText = "";
    sendBtn.disabled = !textarea.value.trim();
    var topicId = state.activeTopicId;
    if (!state.messages[topicId]) state.messages[topicId] = [];
    state.messages[topicId].push({ role: "assistant", content: "AI 请求失败：" + String(error || "未知错误"), error: true });
    renderMessages(msgList);
  });

  renderTopics();
  selectTopic("general");

  function renderTopics() {
    topicList.innerHTML = "";
    TOPICS.forEach(function (topic) {
      var active = topic.id === state.activeTopicId;
      var count = (state.messages[topic.id] || []).filter(function (m) { return m.role !== "system"; }).length;
      var item = ce("div", {
        style: "padding:10px 12px;margin-bottom:4px;border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:10px;font-size:13px;" + (active ? "background:" + cp + "14;color:" + cp + ";font-weight:600" : "color:#333"),
        onmouseenter: function () { if (!active) this.style.background = "#f5f5f5"; },
        onmouseleave: function () { if (!active) this.style.background = ""; },
        onclick: function () { selectTopic(topic.id); },
      });
      item.appendChild(ce("span", { style: "width:9px;height:9px;border-radius:50%;flex-shrink:0;background:" + topic.color }));
      var info = ce("div", { style: "min-width:0;flex:1" });
      info.appendChild(ce("div", { textContent: topic.name, style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }));
      info.appendChild(ce("div", { textContent: count ? count + " 条消息" : topic.desc, style: "font-size:11px;color:#999;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }));
      item.appendChild(info);
      topicList.appendChild(item);
    });
  }

  function selectTopic(topicId) {
    state.activeTopicId = topicId;
    var topic = currentTopic();
    header.innerHTML = "";
    var left = ce("div", { style: "min-width:0;display:flex;align-items:center;gap:10px" });
    left.appendChild(ce("span", { style: "width:10px;height:10px;border-radius:50%;background:" + topic.color }));
    var title = ce("div", { style: "min-width:0" });
    title.appendChild(ce("div", { textContent: topic.name, style: "font-size:15px;font-weight:700;color:#1f1f1f" }));
    title.appendChild(ce("div", { textContent: topic.desc, style: "font-size:12px;color:#999;margin-top:1px" }));
    left.appendChild(title);
    header.appendChild(left);

    var newBtn = ce("button", {
      textContent: "新对话",
      style: buttonStyle("#fff", "#1677ff") + ";border:1px solid #91caff;height:32px",
      onclick: function () {
        state.conversations[topicId] = null;
        state.messages[topicId] = [];
        renderTopics();
        renderMessages(msgList);
      },
    });
    header.appendChild(newBtn);

    renderTopics();
    ensureConversation(topicId).then(function () {
      renderTopics();
      renderMessages(msgList);
    }).catch(function (error) {
      state.messages[topicId] = [{ role: "assistant", content: "无法创建 AI 对话：" + String(error), error: true }];
      renderMessages(msgList);
    });
    renderMessages(msgList);
  }
}

function ensureConversation(topicId) {
  if (state.conversations[topicId]) return Promise.resolve(state.conversations[topicId]);
  var topic = topicById(topicId);
  return state.ctx.ai.createConversation("Plugin-Sample · " + topic.name).then(function (conv) {
    state.conversations[topicId] = conv.id;
    return state.ctx.ai.listMessages(conv.id).then(function (messages) {
      state.messages[topicId] = normalizeMessages(messages);
      return conv.id;
    }).catch(function () { return conv.id; });
  });
}

function sendCurrentMessage(textarea, sendBtn, msgList) {
  if (state.streaming) return;
  var text = textarea.value.trim();
  if (!text) return;
  var topicId = state.activeTopicId;
  var topic = topicById(topicId);
  ensureConversation(topicId).then(function (convId) {
    var finalText = buildPrompt(topic, text);
    textarea.value = "";
    textarea.style.height = "auto";
    sendBtn.disabled = true;
    if (!state.messages[topicId]) state.messages[topicId] = [];
    state.messages[topicId].push({ role: "user", content: text, createdAt: new Date().toISOString() });
    state.streaming = true;
    state.streamingConversationId = convId;
    state.streamingText = "";
    renderMessages(msgList);
    return state.ctx.ai.sendMessage(convId, finalText, { useRag: true, useSkills: state.useSkills });
  }).catch(function (error) {
    state.streaming = false;
    state.streamingConversationId = null;
    sendBtn.disabled = !textarea.value.trim();
    if (!state.messages[topicId]) state.messages[topicId] = [];
    state.messages[topicId].push({ role: "assistant", content: "发送失败：" + String(error), error: true });
    renderMessages(msgList);
  });
}

function buildPrompt(topic, text) {
  if (topic.id === "notes") {
    return "请优先结合我的知识库笔记回答。如果需要，请用要点列出依据。\n\n问题：" + text;
  }
  if (topic.id === "writing") {
    return "你是写作助手，请根据用户目标提供清晰、可直接使用的文本建议。\n\n需求：" + text;
  }
  return text;
}

function renderMessages(msgList) {
  var topicId = state.activeTopicId;
  var messages = state.messages[topicId] || [];
  msgList.innerHTML = "";
  if (messages.length === 0 && !state.streaming) {
    msgList.appendChild(emptyBox("选择一个分类，然后输入问题开始 AI 智能问答。"));
    return;
  }
  messages.forEach(function (msg) {
    msgList.appendChild(bubble(msg));
  });
  if (state.streaming) {
    msgList.appendChild(bubble({ role: "assistant", content: state.streamingText || "正在思考…", streaming: true }));
  }
  msgList.scrollTop = msgList.scrollHeight;
}

function bubble(msg) {
  var isUser = msg.role === "user";
  var wrap = ce("div", { style: "display:flex;gap:10px;margin-bottom:16px;" + (isUser ? "flex-direction:row-reverse" : "") });
  wrap.appendChild(ce("div", {
    textContent: isUser ? "我" : "AI",
    style: "width:30px;height:30px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;" + (isUser ? "background:#1677ff;color:#fff" : "background:#e6f4ff;color:#1677ff"),
  }));
  var content = ce("div", {
    style: "max-width:78%;min-width:0;padding:9px 14px;border-radius:12px;font-size:13px;line-height:1.65;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.03);" + (isUser ? "background:#1677ff;color:#fff;border-bottom-right-radius:4px" : (msg.error ? "background:#fff2f0;color:#a8071a;border:1px solid #ffccc7" : "background:#fff;color:#333;border:1px solid #e8e8e8;border-bottom-left-radius:4px")),
  });
  if (isUser) content.textContent = msg.content || "";
  else content.innerHTML = md(msg.content || "");
  if (msg.streaming) {
    var cursor = ce("span", { textContent: "▍", style: "color:#1677ff;animation:cc-blink 1s infinite" });
    content.appendChild(cursor);
  }
  wrap.appendChild(content);
  return wrap;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(function (m) {
    return {
      role: m.role,
      content: stripPluginPrefix(m.content || ""),
      createdAt: m.created_at || m.createdAt,
    };
  });
}

function stripPluginPrefix(content) {
  return String(content)
    .replace(/^请优先结合我的知识库笔记回答。如果需要，请用要点列出依据。\n\n问题：/, "")
    .replace(/^你是写作助手，请根据用户目标提供清晰、可直接使用的文本建议。\n\n需求：/, "");
}

function topicById(id) {
  return TOPICS.find(function (t) { return t.id === id; }) || TOPICS[0];
}

function currentTopic() {
  return topicById(state.activeTopicId);
}

function topicIdByConversation(convId) {
  var keys = Object.keys(state.conversations);
  for (var i = 0; i < keys.length; i++) {
    if (state.conversations[keys[i]] === convId) return keys[i];
  }
  return null;
}

function emptyBox(text) {
  return ce("div", {
    style: "height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:#999;font-size:13px;padding:24px",
    textContent: text,
  });
}

function md(text) {
  var h = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
    return '<pre style="background:#f5f5f5;border-radius:8px;padding:10px;overflow:auto;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;margin:8px 0">' + code.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>";
  });
  h = h.replace(/`([^`]+)`/g, '<code style="background:#f0f0f0;padding:1px 4px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px">$1</code>');
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/^### (.+)$/gm, '<h4 style="margin:12px 0 4px;font-size:14px">$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3 style="margin:14px 0 6px;font-size:15px">$1</h3>');
  h = h.replace(/\n/g, "<br>");
  return h;
}

function ce(tag, opts) {
  var el = document.createElement(tag);
  if (!opts) return el;
  Object.keys(opts).forEach(function (key) {
    if (key === "style") el.style.cssText = opts[key];
    else if (key === "textContent") el.textContent = opts[key];
    else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), opts[key]);
    else el[key] = opts[key];
  });
  return el;
}

function buttonStyle(bg, color) {
  return "padding:6px 14px;border:none;border-radius:9px;font-size:13px;cursor:pointer;background:" + bg + ";color:" + color + ";font-weight:600;white-space:nowrap";
}

if (!document.getElementById("cc-plugin-style")) {
  var style = document.createElement("style");
  style.id = "cc-plugin-style";
  style.textContent = "@keyframes cc-blink{0%,60%,100%{opacity:.25}30%{opacity:1}} button:disabled{opacity:.55;cursor:not-allowed}";
  document.head.appendChild(style);
}
