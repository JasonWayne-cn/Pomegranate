# Windows 7 兼容版构建指南

## 概述

本项目通过 `feature/win7-compat` 分支提供 Windows 7 SP1 兼容支持。

**技术方案**：捆绑 WebView2 109 Fixed Version（最后一个支持 Win7 的版本），配合 CSS `@supports` 回退机制处理 `oklch()` 和 `color-mix()` 兼容性问题。

## 系统要求

### 开发环境（构建用）

| 要求 | 版本 |
|------|------|
| 操作系统 | **Windows 10+** / macOS / Linux |
| Node.js | ≥ 20 |
| pnpm | ≥ 9 |
| Rust | stable (MSVC on Windows) |
| 磁盘空间 | ≥ 5GB（含 WebView2 Runtime 444MB） |

> **注意**：构建工具链（Node 20+、pnpm）不兼容 Windows 7，必须在 Win10+ 或 macOS/Linux 上构建。

### 目标运行环境（安装用）

| 要求 | 版本 |
|------|------|
| 操作系统 | **Windows 7 SP1**（8/8.1/10/11 亦可运行但不推荐） |
| 必备更新 | [KB4474419](https://support.microsoft.com/kb/4474419) (SHA-2 签名) |
| 必备更新 | [KB4490628](https://support.microsoft.com/kb/4490628) (服务堆栈) |
| 磁盘空间 | ≥ 1GB（安装后） |

## 前置准备

### 1. 下载 WebView2 109 Fixed Runtime

从以下任一地址下载 WebView2 109.0.1518.78：

- [NuGet](https://www.nuget.org/packages/Microsoft.Web.WebView2/109.0.1518.78)
- [GitHub Releases (archived)](https://github.com/thecosmicfrog/WebView2Samples/releases)

### 2. 解压到项目目录

```bash
# 解压 NuGet 包或 CAB 文件后，将内容放置到：
# src-tauri/WebView2-FixedRuntime-109/

# 确认 msedgewebview2.exe 存在：
ls src-tauri/WebView2-FixedRuntime-109/msedgewebview2.exe
```

> 该目录已加入 `.gitignore`，不会提交到 Git 仓库。

## 构建命令

```bash
# 1. 安装依赖
pnpm install

# 2. 构建 MCP sidecar（如需要）
pnpm build:mcp

# 3. 构建 Windows 7 兼容版
pnpm build:win7

# 或 Debug 构建
pnpm build:win7:debug
```

### 构建流程

```
pnpm build:win7
  ├── 验证 WebView2 109 Runtime 存在
  ├── 备份 tauri.conf.json → tauri.conf.json.bak
  ├── 替换为 tauri.win7.conf.json（fixedRuntime 配置）
  ├── 运行 tauri build --bundles nsis
  ├── 产物重命名：知识库_Setup_x.x.x_win7_x64-setup.exe
  └── 恢复 tauri.conf.json
```

## 产物说明

| 文件 | 大小 | 说明 |
|------|------|------|
| `知识库_Setup_x.x.x_win7_x64-setup.exe` | ~600MB | Windows 7 兼容安装包（含 WebView2 109） |
| `知识库_Setup_x.x.x_x64-setup.exe` | ~150MB | 标准安装包（Evergreen WebView2，`master` 分支构建） |

## 安装包行为

安装程序（NSIS）会在安装前检测操作系统版本：

| 检测结果 | 行为 |
|----------|------|
| Windows 7（无 SP1） | 拒绝安装，提示升级到 SP1 |
| Windows 7 SP1 / 8 / 8.1 | 正常安装（WebView2 109 已捆绑） |
| Windows 10+ | 警告提示（建议使用标准版），用户可选择继续或退出 |

## 已知限制

| 限制 | 说明 | 影响 |
|------|------|------|
| Chromium 109 内核 | 不支持 `oklch()`、`color-mix()`、CSS Nesting 等新特性 | 已通过 `@supports` 回退处理，视觉基本一致 |
| WebView2 109 安全更新 | 2023 年起不再接收安全补丁 | 建议仅在受控内网环境使用 |
| 自动更新 | 更新包 ~600MB（包含 WebView2 副本） | 建议手动更新，或关闭自动更新 |
| 安装包体积 | 标准版 4x（444MB WebView2 Runtime） | 不可避免 |

## 分支策略

```
master                 ← 标准版（Evergreen WebView2，Win10+）
  │
  ├── 源码完全共享 ──────
  │
  └── feature/win7-compat ← Windows 7 兼容版（Fixed WebView2 109）
```

- `master` 的所有功能改进会定期合并到 `feature/win7-compat`
- 仅打包配置不同：`tauri.conf.json` vs `tauri.win7.conf.json`
