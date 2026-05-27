/**
 * CC 插件 —— 复刻 AI 问答界面布局（左侧列表 + 右侧详情 + 底部输入）。
 *
 * 安装方式：
 *   1. 侧边栏「插件」→ 点击「安装本地插件」
 *   2. 选择 dev-plugins/cc/ 目录
 *   3. 启用开关，侧边栏会出现 CC 按钮
 */

var DEMO_CATEGORIES = [
  { id: "1", name: "工作项目", color: "#1677ff", count: 12 },
  { id: "2", name: "学习笔记", color: "#52c41a", count: 8 },
  { id: "3", name: "个人日记", color: "#fa8c16", count: 5 },
  { id: "4", name: "技术文档", color: "#722ed1", count: 15 },
  { id: "5", name: "灵感碎片", color: "#eb2f96", count: 3 },
  { id: "6", name: "阅读摘录", color: "#13c2c2", count: 7 },
];

var DEMO_MESSAGES = {
  "1": [
    { id: 1, role: "user", text: "今天要完成哪些工作？" },
    { id: 2, role: "ai", text: "根据你的任务列表，今天有 **3 项紧急任务**：\n\n1. 完成 Q2 报告终稿\n2. 审核前端代码 PR\n3. 回复客户邮件\n\n建议先从 Q2 报告开始。" },
    { id: 3, role: "user", text: "帮我整理一下项目进度的要点" },
    { id: 4, role: "ai", text: "| 模块 | 进度 | 状态 |\n|------|------|------|\n| 用户管理 | 100% | ✅ 完成 |\n| 数据导入 | 85% | 🔄 进行中 |\n| 报表导出 | 60% | 🔄 进行中 |\n\n**阻塞项**：报表导出等待后端 API 对接。" },
  ],
  "2": [
    { id: 1, role: "user", text: "今天学了什么新知识？" },
    { id: 2, role: "ai", text: "你今天的笔记记录了 **React 19 的 3 个新特性**：\n1. **Actions** — 替代 useEffect 处理异步\n2. **useOptimistic** — 乐观更新 UI\n3. **useFormStatus** — 表单状态管理" },
  ],
  "3": [
    { id: 1, role: "user", text: "写一篇今日日记" },
    { id: 2, role: "ai", text: "📅 **2026 年 5 月 24 日**\n\n今天天气不错，上午完成了项目报告的主要部分，中午和同事一起吃了顿饭，下午读了一本关于时间管理的书。\n\n晚间计划：整理一下下周的工作安排。" },
  ],
  "4": [
    { id: 1, role: "user", text: "解释一下 Tauri IPC 的原理" },
    { id: 2, role: "ai", text: "## Tauri IPC 通信原理\n\nTauri 的 IPC 是前端（WebView）和后端（Rust）之间的桥梁：\n\n```\ninvoke(\"command_name\", { args })\n  → JSON 序列化\n  → 通过 WebView IPC 传至 Rust\n  → Rust Command 处理\n  → JSON 返回前端\n```\n\n关键点：\n- 所有通信经过 JSON 序列化\n- Rust Command 返回 `Result<T, String>`\n- 前端用 `try-catch` 处理错误" },
  ],
};

module.exports = {
  onLoad: function (ctx) {
    ctx.registerPanelView({
      id: "cc-chat",
      pluginId: "cc",
      title: "CC 问答",
      render: function (container) { renderChatLayout(container); },
      unmount: function (container) { container.innerHTML = ""; },
    });
    ctx.registerSidebarItem({
      id: "cc-open-chat", label: "CC", icon: "puzzle", group: "ai",
      onClick: function () { window.location.hash = "#/plugin-view/cc-chat"; },
    });
  },
  onUnload: function () {},
};

function renderChatLayout(container) {
  container.innerHTML = "";
  container.style.cssText = "height:100%;display:flex;overflow:hidden;background:#f5f5f5;font-family:system-ui,sans-serif";
  var cp = "#1677ff", bc = "#e8e8e8";

  var sidebar = ce("div", {style:"width:240px;height:100%;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid "+bc+";background:#fff"});
  container.appendChild(sidebar);
  var stb = ce("div", {style:"padding:12px;border-bottom:1px solid "+bc});
  stb.appendChild(ce("button",{textContent:"+ 新建标签",style:bs(cp,"#fff",true)+";flex:1",
    onclick:function(){var n=prompt("标签名称：");if(n&&n.trim()){DEMO_CATEGORIES.push({id:String(Date.now()),name:n.trim(),color:rc(),count:0});refresh();}}}));
  sidebar.appendChild(stb);
  var catList=ce("div",{style:"flex:1;overflow:auto;padding:4px"});
  sidebar.appendChild(catList);

  var main=ce("div",{style:"flex:1;display:flex;flex-direction:column;height:100%;min-width:0;background:#fff"});
  container.appendChild(main);
  var hdr=ce("div",{id:"cc-header",style:"padding:8px 16px;border-bottom:1px solid "+bc+";display:flex;align-items:center;gap:8px;height:44px"});
  main.appendChild(hdr);
  var msgList=ce("div",{id:"cc-msg-list",style:"flex:1;overflow:auto;padding:16px"});
  main.appendChild(msgList);
  var inp=ce("div",{style:"padding:12px 16px;border-top:1px solid "+bc+";display:flex;gap:8px;align-items:flex-end"});
  main.appendChild(inp);
  var ta=ce("textarea",{placeholder:"输入消息… (Ctrl+Enter 发送)",style:"flex:1;resize:none;border:1px solid #d9d9d9;border-radius:8px;padding:8px 12px;font-size:13px;font-family:inherit;outline:none;min-height:36px;max-height:120px;line-height:1.5",rows:1,
    oninput:function(){this.style.height="auto";this.style.height=Math.min(this.scrollHeight,120)+"px";s.disabled=!this.value.trim();},
    onkeydown:function(e){if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();s.click();}}});
  inp.appendChild(ta);
  var s=ce("button",{textContent:"发送",disabled:true,style:bs(cp,"#fff",false)+";width:64px;height:36px",
    onclick:function(){var t=ta.value.trim();if(!t)return;var id=ta.__aid;if(!id)return;addMsg(id,"user",t);ta.value="";ta.style.height="auto";s.disabled=true;simulate(id,msgList,s,ta);}});
  inp.appendChild(s);

  function refresh(){catList.innerHTML="";var aid=ta.__aid;DEMO_CATEGORIES.forEach(function(c){var a=c.id===aid;var it=ce("div",{style:"padding:10px 12px;margin-bottom:2px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:10px;font-size:13px"+(a?";background:"+cp+"14;color:"+cp+";font-weight:500":""),
    onmouseenter:function(){if(!a)this.style.background="#f0f0f0"},onmouseleave:function(){if(!a)this.style.background=""},
    onclick:function(){select(c.id)}});
    it.appendChild(ce("span",{style:"width:8px;height:8px;border-radius:50%;flex-shrink:0;background:"+c.color}));
    var inf=ce("div",{style:"min-width:0;flex:1"});
    inf.appendChild(ce("div",{textContent:c.name,style:"overflow:hidden;text-overflow:ellipsis;white-space:nowrap"}));
    inf.appendChild(ce("div",{textContent:c.count+" 条对话",style:"font-size:11px;color:#999;margin-top:1px"}));
    it.appendChild(inf);catList.appendChild(it);});
    hdr.innerHTML="";var cat=aid?DEMO_CATEGORIES.find(function(c){return c.id===aid}):null;
    if(cat){hdr.appendChild(ce("span",{style:"width:10px;height:10px;border-radius:50%;background:"+cat.color}));hdr.appendChild(ce("span",{textContent:cat.name,style:"font-size:15px;font-weight:600"}));hdr.appendChild(ce("span",{textContent:cat.count+" 条对话",style:"font-size:12px;color:#999"}));}
    else{hdr.appendChild(ce("span",{textContent:"选择左侧标签开始对话",style:"font-size:13px;color:#999"}));}
    renderMsgs(msgList,aid);}

  function select(id){ta.__aid=id;refresh();}
  select("1");
}

function renderMsgs(el,catId){el.innerHTML="";var msgs=DEMO_MESSAGES[catId]||[];if(msgs.length===0){el.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%"><div style="text-align:center;color:#999;font-size:13px">💬 选择左侧标签开始对话</div></div>';return;}
  msgs.forEach(function(m){el.appendChild(bubble(m));});el.scrollTop=el.scrollHeight;}

function bubble(msg){var u=msg.role==="user";var w=ce("div",{style:"display:flex;gap:10px;margin-bottom:16px;"+(u?"flex-direction:row-reverse":"")});
  w.appendChild(ce("div",{textContent:u?"我":"AI",style:"width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;"+(u?"background:#1677ff;color:#fff":"background:#e6f4ff;color:#1677ff")}));
  var b=ce("div",{style:"max-width:75%;min-width:0;padding:8px 14px;border-radius:10px;font-size:13px;line-height:1.6;word-break:break-word;"+(u?"background:#1677ff;color:#fff;border-bottom-right-radius:3px":"background:#fff;color:#333;border:1px solid #e8e8e8;border-bottom-left-radius:3px")});
  if(u)b.textContent=msg.text;else b.innerHTML=md(msg.text);w.appendChild(b);return w;}

function md(t){var h=t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  h=h.replace(/```(\w*)\n([\s\S]*?)```/g,function(_,l,c){return'<pre style="background:#f5f5f5;border-radius:6px;padding:10px;overflow:auto;font-size:12px;font-family:monospace;margin:8px 0">'+c.replace(/&/g,"&amp;").replace(/</g,"&lt;")+"</pre>";});
  h=h.replace(/`([^`]+)`/g,'<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:12px">$1</code>');
  h=h.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");h=h.replace(/^### (.+)$/gm,'<h4 style="margin:12px 0 4px;font-size:14px">$1</h4>');
  h=h.replace(/\[(.+?)\]\((.+?)\)/g,'<a href="$2" target="_blank" style="color:#1677ff">$1</a>');h=h.replace(/\n/g,"<br>");return h;}

function simulate(catId,msgList,s,ta){var td=ce("div",{style:"display:flex;gap:10px;margin-bottom:16px"});
  td.appendChild(ce("div",{textContent:"AI",style:"width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:#e6f4ff;color:#1677ff"}));
  td.appendChild(ce("div",{style:"max-width:75%;padding:8px 14px;border-radius:10px;font-size:13px;background:#fff;border:1px solid #e8e8e8;border-bottom-left-radius:3px"}));
  if(!document.getElementById("cc-blink-style")){var st=document.createElement("style");st.id="cc-blink-style";st.textContent="@keyframes cc-blink{0%,80%,100%{opacity:0.2}40%{opacity:1}}";document.head.appendChild(st);}
  td.lastChild.innerHTML='<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#1677ff;animation:cc-blink 1.4s infinite"></span>&nbsp;<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#1677ff;animation:cc-blink 1.4s 0.2s infinite"></span>&nbsp;<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#1677ff;animation:cc-blink 1.4s 0.4s infinite"></span>';
  msgList.appendChild(td);msgList.scrollTop=msgList.scrollHeight;s.disabled=true;
  setTimeout(function(){td.remove();var r=["好的，我理解了你的需求。\n\n根据当前标签分类下的内容，这里有几个关键点需要注意：\n\n- 保持信息结构清晰\n- 使用 **分类标签** 组织内容\n- 定期回顾和整理","这是一个好问题！\n\n让我帮你梳理一下：\n\n### 要点\n1. 先明确目标\n2. 再拆解步骤\n3. 最后执行并反馈","收到！我已经记录了你的信息。当前分类共有 "+(DEMO_CATEGORIES.find(function(c){return c.id===catId}).count)+" 条相关对话，你可以继续追问细节。"];
    var reply=r[Math.floor(Math.random()*r.length)];addMsg(catId,"ai",reply);renderMsgs(msgList,catId);msgList.scrollTop=msgList.scrollHeight;s.disabled=!ta.value.trim();
    var ct=DEMO_CATEGORIES.find(function(c){return c.id===catId});if(ct)ct.count+=1;},1500+Math.random()*1500);}

function addMsg(catId,role,text){if(!DEMO_MESSAGES[catId])DEMO_MESSAGES[catId]=[];DEMO_MESSAGES[catId].push({id:DEMO_MESSAGES[catId].length+1,role:role,text:text});}
function ce(tag,opts){var e=document.createElement(tag);if(!opts)return e;Object.keys(opts).forEach(function(k){if(k==="style")e.style.cssText=opts.style;else if(k.startsWith("on"))e.addEventListener(k.slice(2).toLowerCase(),opts[k]);else e[k]=opts[k];});return e;}
function bs(bg,color,full){return "padding:6px 16px;border:none;border-radius:8px;font-size:13px;cursor:pointer;background:"+bg+";color:"+color+";font-weight:500;transition:opacity .15s;white-space:nowrap;"+(full?"flex:1":"");}
function rc(){var c=["#1677ff","#52c41a","#fa8c16","#722ed1","#eb2f96","#13c2c2","#faad14","#f5222d"];return c[Math.floor(Math.random()*c.length)];}
