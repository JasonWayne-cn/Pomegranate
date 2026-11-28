# 模块视图统一方案（方案 3）开发计划

> 目标：插件与扩展包共用同一套「视图容器 + 安装流程」，但保留各自的渲染方式。
> 插件继续在宿主 WebView 内自渲染 DOM；扩展继续由宿主 React 页面渲染。不引入 iframe / 新沙箱，不合并运行时与权限模型。

## 1. 背景与结论

当前两套体系：

| 维度 | JS 插件 | 扩展包 |
|---|---|---|
| 运行位置 | 宿主 WebView（`new Function`） | Python / 可执行子进程 |
| UI 归属 | 插件自己渲染 DOM | 宿主 React 页面 |
| 安装包 | zip（`plugin.json`） | zip（`extension.json`） |
| 管理入口 | 关于页「插件」Tab | 关于页「扩展包」Tab |

方案 3 的落地范围：

1. **统一视图契约**：`ModuleViewMeta` + `ModuleViewFrame`，统一标题栏、来源标识、错误边界、全屏/标准布局。
2. **统一安装流程**：zip 选择 → 预检 → 信息确认 → 安装，插件与扩展复用同一 React 组件；后端补齐插件 zip 预检。
3. **不统一的部分**：渲染技术、权限模型、运行时协议、数据存储。

## 2. 架构

```text
src/modules/viewContract.ts          # 视图元数据契约（source: builtin/plugin/extension）
src/components/module/
  ModuleViewFrame.tsx                # 统一容器：chrome、错误边界、挂载宿主
src/components/package/
  PackageInstallButton.tsx           # 统一 zip 安装按钮与确认弹窗

插件:  PluginPanelViewPage ──mount(container)──► ModuleViewFrame
扩展:  /ppt 路由 PptPage ─────React children───► ModuleViewFrame(chrome=false)
```

### 2.1 视图契约

```ts
export type ModuleViewSource = "builtin" | "plugin" | "extension";
export type ModuleViewLayout = "standard" | "fullscreen";

export interface ModuleViewMeta {
  id: string;
  title: string;
  source: ModuleViewSource;
  sourceLabel?: string;
  icon?: ReactNode;
  layout?: ModuleViewLayout;
  pluginId?: string;
}
```

### 2.2 容器接口

```ts
interface ModuleViewFrameProps {
  meta: ModuleViewMeta;
  children?: ReactNode;                 // React 渲染（扩展页面）
  mount?: (el: HTMLElement) => void | (() => void); // 自渲染（插件）
  mountKey?: string | number;           // 视图重挂载
  chrome?: boolean;                     // 是否显示统一标题栏，默认 true
  onBack?: () => void;
  actions?: ReactNode;
  resetKey?: string | number;           // 重置错误边界
}
```

约束：

- 容器必须撑满父级：`height: 100%; min-height: 0; display: flex; flex-direction: column`。
- `chrome=false` 时只提供高度、错误边界和来源标记，不额外加标题栏，避免与扩展页面自带头部冲突。
- 插件 `mount` 返回的 cleanup 必须在卸载时执行；初始化抛错显示容器内错误态，不拖垮宿主。

### 2.3 统一安装接口

```ts
interface PackageInstallButtonProps<I, T> {
  label: string;
  filterName: string;                   // 文件对话框过滤器名称
  inspect: (path: string) => Promise<I>;
  install: (path: string) => Promise<T>;
  onInstalled: (result: T) => void | Promise<void>;
  renderInspection?: (i: I) => ReactNode; // 扩展兼容性等额外信息
  canInstall?: (i: I) => boolean;         // 例如扩展不兼容时禁用确认
  blockedReason?: (i: I) => ReactNode;
}
```

## 3. 阶段计划

### P0 计划落盘

- [x] 新增本文档
- [x] 明确契约、边界与非目标

### P1 统一视图容器

- [x] 新增 `src/modules/viewContract.ts`
- [x] 新增 `src/components/module/ModuleViewFrame.tsx`
  - [x] 统一 header（图标 / 标题 / 来源标签 / 操作区 / 返回）
  - [x] 标准 / 全屏布局
  - [x] React `ErrorBoundary` + 重置
  - [x] 插件 `mount` 宿主（try/catch + cleanup）
- [x] `PluginPanelViewPage` 改用 `ModuleViewFrame`
- [x] `/ppt` 路由套用 `ModuleViewFrame`（`chrome=false`）

### P2 统一安装流程

- [x] 后端新增 `PluginInspection`（`src-tauri/src/models/mod.rs`）
- [x] `PluginService::inspect_zip`：安全解压 → 定位 `plugin.json` → 校验入口/样式 → 统计文件数与体积
- [x] 新增 Command `inspect_plugin_zip` 并在 `lib.rs` 注册
- [x] 前端新增 `PluginInspection` 类型与 `pluginApi.inspectZip`
- [x] 新增 `src/components/package/PackageInstallButton.tsx`
- [x] 插件页接入统一安装组件（替换原“选择 zip 直接安装”）
- [x] 扩展页接入统一安装组件（保留兼容性与权限展示）

### P3 验证

- [x] `cargo check`
- [x] `npx tsc --noEmit`
- [x] 新增 5 个 Rust 单元测试（清单根定位 / 多候选拒绝 / 预检统计 / 嵌套目录 / 缺清单拒绝）
- [x] GUI 验收（`pnpm tauri dev`）
- [x] 回填本文档状态

### 实施记录（2026-11-25）

| 项 | 结果 |
|---|---|
| `cargo check` | 通过（仅既有警告） |
| `cargo test --lib services::plugins::tests` | 5 passed |
| `npx tsc --noEmit` | 通过 |
| 新增命令 | `inspect_plugin_zip`（已在 `lib.rs` 注册） |
| 新增组件 | `ModuleViewFrame`、`PackageInstallButton` |
| 新增契约 | `src/modules/viewContract.ts` |

GUI 验收（开发模式，`Pomegranate [DEV]`）：

| 场景 | 结果 |
|---|---|
| 首页 / 侧边栏 | 正常，PPT 生成与 AI 助研入口在列 |
| `/ppt` 扩展页面 | 铺满内容区，无重复标题栏，原有页面头部正常 |
| 插件 Tab「安装插件包」 | 选择 `research-assistant-1.0.0.zip` 后弹窗显示 ID、4 个文件、203.3 KB、作者、最低版本与权限声明；预检成功 |
| 扩展包 Tab「安装扩展包」 | 选择 `ppt-master-extension-1.2.6-win7-x64.zip` 后弹窗显示 ID、533 个文件、11.4 MB、类型、兼容性（兼容）与权限；预检成功 |
| AI 助研面板 | 全屏布局正常渲染；该视图声明 `layout: "fullscreen"`，按设计不显示统一标题栏 |
| 确认安装 | 未执行（现有包已安装，避免重复安装报错）；仅验证到预检确认弹窗 |

## 4. 验证清单

| 场景 | 预期 |
|---|---|
| 插件 zip 根目录含 `plugin.json` | 预检成功，确认后可安装 |
| 插件 zip 仅一层文件夹含 `plugin.json` | 预检成功 |
| 插件 zip 无清单 / 多候选目录 | 预检失败并提示 |
| 插件缺 `main` 或 `styles` | 预检失败并提示 |
| 扩展包不兼容 | 确认按钮禁用，仍展示原因 |
| 插件视图渲染抛错 | 容器内显示错误，宿主其余页面可用 |
| PPT 页面 | 保持原有布局，不出现双标题栏 |

## 5. 回滚

- P1 仅涉及新增文件与两个页面外壳，回滚时恢复 `PluginPanelViewPage` 与 `/ppt` 路由的原始 JSX 即可。
- P2 的后端 `inspect_plugin_zip` 为纯新增命令，保留不影响旧路径；前端若回滚，恢复插件页原 `handleInstall`。

## 6. 设置页安装入口合并（方案 C）

设置页合并为**单一「扩展」管理页**，安装与列表都不向用户区分内部类型：

- 只保留一个「扩展」Tab，原先的「插件」Tab 已移除；`tab=plugins` 与 `/plugins` 旧链接自动落到扩展页。
- 列表统一渲染插件与扩展包：名称、版本、状态、启用、详情、卸载；不提供类型列。
- 插件行额外保留「重载」；扩展的校验 / 版本 / 复制路径收进「详情」弹窗。
- 安装入口只有一个「安装」按钮，选择一个 zip 后由 `detect_package_kind` 自动识别内部类型：
  - 根目录或唯一一层文件夹内存在 `plugin.json` → 插件；
  - 存在 `extension.json` → 扩展包；
  - 同时存在或都不存在 → 明确报错。
- 确认弹窗不展示「插件 / 扩展包」类型，只显示 ID、文件数、解压体积与权限声明；成功提示统一为「已安装」。
- 安装成功后广播 `app:plugins-changed` / `app:extensions-changed`，统一列表刷新。
- 安全边界不变：插件仍走权限授权，扩展仍校验兼容性。

新增文件：

| 文件 | 作用 |
|---|---|
| `src-tauri/src/services/package.rs` | 包类型识别（zip 条目扫描） |
| `src-tauri/src/commands/package.rs` | `detect_package_kind` Command |
| `src/components/package/PackageInstallButton.tsx` | 自动识别 + 统一确认 + 分类安装 |
| `src/components/plugins/PluginDetailModal.tsx` | 插件详情、权限授权与审计日志 |
| `src/components/plugins/PluginErrorLog.tsx` | 插件运行时错误日志 |

验证：

- `services::package::tests` 4 项通过（插件根目录 / 扩展嵌套目录 / 双清单拒绝 / 缺清单拒绝）。
- `npx tsc --noEmit` 通过。
- GUI：设置页只剩一个「扩展」Tab，同一张表同时显示 PPT Master 与 AI 助研；单一「安装」按钮，行操作为 详情 / 卸载（插件额外有重载）。
- 选择 `research-assistant-1.0.0.zip` 后可按插件类型完成安装，插件恢复为 AI 助研 v1.0.0、启用状态与已授权权限保留。
- 安装弹窗不显示类型字段，避免用户感知插件 / 扩展包差异；类型识别由 `services::package::tests` 覆盖。

## 7. 非目标

- 不把插件改为宿主 React 渲染。
- 不把扩展改为自带 HTML/JS 渲染。
- 不统一插件与扩展的权限、令牌、数据表或进程协议。
- 不合并插件/扩展的管理页面路由。
