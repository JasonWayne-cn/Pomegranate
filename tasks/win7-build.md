# Windows 7 兼容版构建指南

## 概述

本项目通过 `feature/win7-compat` 分支提供 Windows 7 SP1 兼容支持。

**技术方案**：PE 子系统锁定 6.1 + C 桩函数消除 Win8+ DLL 导入 + CSS `@supports` 回退。安装包不捆绑 WebView2，需目标系统预装 WebView2 109+。

## 系统要求

### 开发环境（构建用）

| 要求 | 版本 |
|------|------|
| 操作系统 | **Windows 10+** / macOS / Linux |
| Node.js | ≥ 20 |
| pnpm | ≥ 9 |
| Rust | stable (MSVC on Windows) |
| 磁盘空间 | ≥ 2GB |

> **注意**：构建工具链（Node 20+、pnpm）不兼容 Windows 7，必须在 Win10+ 或 macOS/Linux 上构建。

### 目标运行环境（安装用）

| 要求 | 版本 |
|------|------|
| 操作系统 | **Windows 7 SP1**（8/8.1/10/11 亦可运行） |
| 必备更新 | [KB4474419](https://support.microsoft.com/kb/4474419) (SHA-2 签名) |
| 必备更新 | [KB4490628](https://support.microsoft.com/kb/4490628) (服务堆栈) |
| WebView2 | **需预装 WebView2 109+**（[下载](https://www.nuget.org/packages/Microsoft.Web.WebView2/109.0.1518.78)） |
| 磁盘空间 | ≥ 500MB（安装后） |

> **注意**：本安装包不捆绑 WebView2 运行时。Win7 用户需预先安装 WebView2 109+（固定版本），
> Win10+ 用户系统自带或可通过 Evergreen 自动更新获取 WebView2。

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
  ├── 验证 Rust 工具链
  ├── 备份 tauri.conf.json → tauri.conf.json.bak
  ├── 替换为 tauri.win7.conf.json（WebView2: skip）
  ├── Phase 0: 构建 WinRT Shim DLL（消除 api-ms-win-core-winrt-l1-1-0.dll 依赖）
  │   └── src-tauri/win7_winrt_shim/build.ps1 → binaries/api-ms-win-core-winrt-l1-1-0.dll
  ├── Phase 1: cargo build --release --features win7-compat
  │   ├── 跳过 tauri-plugin-notification 注册（消除 WinRT 依赖链 A）
  │   ├── DELAYLOAD api-ms-win-core-winrt-l1-1-0.dll（延迟加载）
  │   └── DELAYLOAD api-ms-win-core-winrt-string-l1-1-0.dll
  ├── PE 补丁：
  │   ├── SubsystemVersion → 6.1 (Windows 7)
  │   └── GetSystemTimePreciseAsFileTime → GetSystemTimeAsFileTime
  ├── Phase 2: tauri build --bundles nsis
  │   ├── externalBin 打包 Shim DLL 到安装目录
  │   └── makensis 生成安装包
  ├── 构建后 Win8+ 导入扫描（含 WinRT DLL）
  ├── 产物重命名：知识库_Setup_x.x.x_win7_x64-setup.exe
  └── 恢复 tauri.conf.json
```

## 产物说明

| 文件 | 大小 | 说明 |
|------|------|------|
| `知识库_Setup_x.x.x_win7_x64-setup.exe` | ~25MB | Windows 7 兼容安装包（不含 WebView2 Runtime） |
| `知识库_Setup_x.x.x_x64-setup.exe` | ~150MB | 标准安装包（Evergreen WebView2，`master` 分支构建） |

## 安装包行为

安装程序（NSIS）会在安装前检测：

| 检测项 | 行为 |
|--------|------|
| Windows 7（无 SP1） | 拒绝安装，提示升级到 SP1 |
| 无 WebView2 Evergreen 注册表 | 非阻塞警告，提示安装 WebView2 109+ |
| 已装 WebView2 | 正常安装 |

## PE 导入表兼容补丁

Win7 版构建脚本会对主程序和 sidecar 执行二进制级补丁：

| 项 | 修复前 | 修复后 | 原因 |
|----|--------|--------|------|
| PE 子系统版本 | 通常为 6.0 或默认值 | 6.1 | 明确标记为 Windows 7 目标 |
| 时间 API | `GetSystemTimePreciseAsFileTime` | `GetSystemTimeAsFileTime` | 前者 Win8+ 才存在，后者 Win7 可用且签名相同 |
| WinRT API | `api-ms-win-core-winrt-l1-1-0.dll` | 延迟加载 + Shim DLL | WinRT 运行时不存在于 Win7，通过自实现 Shim DLL 提供 |
| WinRT 通知 | `tauri-winrt-notification` | 条件禁用 (win7-compat feature) | 通知插件使用 WinRT API，Win7 构建时跳过注册 |

### WinRT Shim DLL

构建前会先生成 `api-ms-win-core-winrt-l1-1-0.dll`（放置于 `src-tauri/binaries/`），
实现 HSTRING 全套函数（基于 HeapAlloc）和 WinRT 初始化桩（RoInitialize 等）。
此 DLL 通过 `externalBin` 随安装包分发到 EXE 同级目录，
Windows 加载器按搜索顺序优先找到本地 DLL，避免系统缺失报错。

补丁后脚本会扫描最终 EXE，若仍包含以下 Win8+ 直接导入则构建失败：

- `GetSystemTimePreciseAsFileTime`
- `api-ms-win-core-winrt-l1-1-0.dll`
- `api-ms-win-core-winrt-string-l1-1-0.dll`
- `api-ms-win-crt-private-l1-1-0.dll`
- `api-ms-win-core-synch-l1-2-0.dll`（延迟加载，风险提示）
- `combase.dll`（延迟加载，风险提示）

## 已知限制

| 限制 | 说明 | 影响 |
|------|------|------|
| Chromium 109 内核 | 不支持 `oklch()`、`color-mix()`、CSS Nesting 等新特性 | 已通过 `@supports` 回退处理，视觉基本一致 |
| WebView2 109 安全更新 | 2023 年起不再接收安全补丁 | 建议仅在受控内网环境使用 |
| 不捆绑 WebView2 | 需用户预先安装 WebView2 109+ | 安装器会检测并给出下载指引 |
| 安装包体积 | ~25MB | 标准版约 6x |

## 分支策略

```
master                 ← 标准版（Evergreen WebView2，Win10+）
  │
  ├── 源码完全共享 ──────
  │
  └── feature/win7-compat ← Windows 7 兼容版（Fixed WebView2 109）
```

- `master` 的所有功能改进会定期合并到 `feature/win7-compat`
- 打包配置不同：`tauri.conf.json`（Evergreen WebView2） vs `tauri.win7.conf.json`（Win7 PE 补丁 + skip WebView2）
