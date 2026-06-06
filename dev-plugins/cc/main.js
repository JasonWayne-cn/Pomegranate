/**
 * cc 示例插件 v2 —— 适配 AppAPI 1.0.0
 *
 * 演示新 API 的全部域：
 *   - commands  注册命令面板项
 *   - sidebar   注册侧边栏图标
 *   - panelViews 注册面板视图
 *   - notes     调用受控笔记 API
 *   - settings  读写插件自身设置
 */
module.exports = {
  async onLoad(ctx) {
    const { app, meta } = ctx;

    console.log(`[cc] 激活中... API version=${app.version}, plugin=${meta.id}`);

    // ===== 1. 注册命令 =====
    app.commands.addCommand({
      id: "say-hello",
      name: "CC: 打招呼",
      group: "示例",
      callback: () => {
        app.notices.show(`Hello from ${meta.name}!`);
      },
    });

    app.commands.addCommand({
      id: "count-notes",
      name: "CC: 统计笔记数量",
      group: "示例",
      callback: async () => {
        try {
          const notes = await app.notes.list();
          app.notices.show(`当前共有 ${notes.length} 篇笔记`);
        } catch (e) {
          app.notices.error(`查询失败: ${e}`);
        }
      },
    });

    // ===== 2. 注册侧边栏图标 =====
    app.sidebar.addItem({
      id: "cc-panel",
      icon: "Sparkles",
      label: "CC 示例",
      viewId: "cc-main-view",
    });

    // ===== 3. 注册面板视图 =====
    app.panelViews.register({
      id: "cc-main-view",
      title: "CC 控制面板",
      render: (container) => {
        container.innerHTML = `
          <div style="padding: 16px; font-family: system-ui, sans-serif;">
            <h3>CC 示例插件 v2.0.0</h3>
            <p>这是一个演示 AppAPI 1.0.0 的示例插件</p>
            <button id="cc-btn-stat" style="padding: 8px 16px; cursor: pointer;">统计笔记</button>
            <pre id="cc-output" style="margin-top: 16px; background: #f0f0f0; padding: 8px; border-radius: 4px;"></pre>
          </div>
        `;
        const btn = container.querySelector("#cc-btn-stat");
        const out = container.querySelector("#cc-output");
        const handler = async () => {
          try {
            const notes = await app.notes.list();
            out.textContent = `笔记数量: ${notes.length}\n最近一篇: ${notes[0]?.title ?? "无"}`;
          } catch (e) {
            out.textContent = `错误: ${e}`;
          }
        };
        btn.addEventListener("click", handler);

        // 返回 cleanup
        return () => {
          btn.removeEventListener("click", handler);
        };
      },
    });

    // ===== 4. 读写插件自身设置 =====
    const lastRun = await app.settings.get("lastRun");
    console.log(`[cc] 上次激活: ${lastRun ?? "首次"}`);
    await app.settings.set("lastRun", new Date().toISOString());

    // ===== 5. 监听事件（存在性检查）=====
    if (app.events && typeof app.events.on === "function") {
      const off = app.events.on("workspace:active-note-changed", ({ noteId }) => {
        console.log(`[cc] 当前笔记切换到: ${noteId}`);
      });
      ctx._ccUnsubscribe = off;
    }

    console.log(`[cc] 激活完成`);
  },

  async onUnload(ctx) {
    console.log(`[cc] 停用中...`);
    if (ctx._ccUnsubscribe) ctx._ccUnsubscribe();
    // commands / sidebar / panelViews 由 PluginManager 自动按 pluginId 前缀清理
  },
};
