# 窗口位置记忆方案

> 创建：2026-11-24
> 参照：knowledge-base `f39cb99`（不再内置 tauri-kit，窗口记忆改本仓）、`40191c6`（显示器切换/最小化恢复）、`355f192`（显示器切换后变小）
> 本仓：`src-tauri/src/` 无 `window_memory`，主窗使用 `tauri-plugin-window-state`（只记尺寸/位置/最大化）
> 关联：`remaining-improvements-plan.md` §2.C

## 1. 目标

解决以下窗口问题：

1. 多显示器切换（合盖、插拔副屏）后窗口跑到屏幕外或变得很小。
2. 系统最小化后恢复，窗口不在原显示器 / 尺寸异常。
3. 不同显示器组合分别记忆位置，不互相覆盖。
4. 保存的位置在当前屏幕不存在时，钳制到工作区内。

## 2. 设计

移植 KB 的三文件模块：

```
src-tauri/src/window_memory/
├── mod.rs    // 导出与初始化
├── logic.rs  // 纯函数：拓扑签名、目标显示器、放置计划、最小化判断
└── glue.rs   // Tauri 接入：init / capture_now / correct_before_show / show_main / on_window_event
```

**核心数据**

- `MonitorKey`：显示器 id/名称/工作区/缩放。
- `Placement`：相对显示器位置 + 尺寸。
- `Memory`：`layout_key -> Placement`（不同显示器组合分别记）。
- `Options { legacy }`：兼容旧 `tauri-plugin-window-state` 的记录。

**关键逻辑**

- `layout_key(list)`：当前显示器组合签名。
- `plan(saved, keys, primary, current, actual, size_on_primary)`：决定目标位置/尺寸。
- `minimized_around_topology(minimized_ago, topology_ago)`：拓扑刚变化且窗口刚最小化 → 恢复时重新放置。
- `big_enough(logical, min)` / `place_in` / `centered_rel`：越界与过小兜底。

**接入点（lib.rs）**

- 主窗创建后 `window_memory::init(app, will_show, Options { legacy })`。
- 投递 md / 双开唤回时 `show_main(app, reason)`。
- 窗口事件转发 `on_window_event(app, event)`。
- 启动显示后 `capture_now("启动显示后")`。

**与现有插件的关系**

- 主窗：以 `window_memory` 为准，避免与 `tauri-plugin-window-state` 双写。
- pop-out / 弹窗：继续用现有插件或窗口自管理，不纳入本模块。
- 旧记录：读取一次 `window-state` 文件作为 `legacy`，成功后不再写。

## 3. 文件清单

| 文件 | 改动 |
|------|------|
| `src-tauri/src/window_memory/{mod,logic,glue}.rs` | 新增（移植） |
| `src-tauri/src/lib.rs` | 模块注册、init/show/capture/event 接入 |
| `src-tauri/Cargo.toml` | 如需显示器/序列化依赖 |
| `tauri.conf.json` / 插件注册 | 主窗关闭 window-state 写回 |
| 测试 | `logic` 纯函数单测 |

## 4. 测试

**单测（logic.rs）**

- `find_target`：同型号/不同 id、主屏回退。
- `plan`：保存位置在副屏、副屏拔掉后回主屏且尺寸合理。
- `minimized_around_topology`：拓扑变化 + 最小化场景。
- `big_enough`：过小窗口放大到最小可用尺寸。
- `same_screen` / `legacy_usable`。

**手工**

- 双屏 → 单屏 → 双屏，窗口回到上次所在屏。
- 合盖休眠唤醒、系统最小化恢复。
- 100%/125%/150% 缩放切换。
- 多实例启动（若支持）不互相覆盖。

## 5. 风险

| 风险 | 应对 |
|------|------|
| 与 window-state 双写 | 主窗只保留一个写入者；迁移后移除插件注册 |
| DPI 缩放换算 | 统一用逻辑坐标；实测 125%/150% |
| 显示器 id 不稳定 | 以拓扑签名 + 相近匹配回退 |
| 多窗口干扰 | 只处理 main 窗口 |
