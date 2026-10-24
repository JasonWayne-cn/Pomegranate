# Win7 兼容阶段总结 V1

> **日期**: 2026-06-16  
> **分支**: feature/win7-compat  
> **基础**: Tauri 2.10.3 + Rust 1.96 (edition 2021)

---

## 一、背景

W-NoteBook（知识库桌面应用）基于 Tauri 2.x 构建，默认仅支持 Windows 10+。为满足 Windows 7 SP1 用户需求，需要在 **不降级 Rust 编译器版本（保持 1.96）** 的前提下，消除所有 Win8+ API/DLL 依赖。

参考项目：DeepSeek TUI（Rust 1.75 严格路线消除 Win8+ API），但因 Tauri 2.x 依赖链深度绑定 `windows` crate（raw-dylib），无法照搬 C stub 统一消除方案。

---

## 二、需要解决的问题（6 大核心问题）

### 问题 1：api-ms-win-core-winrt-l1-1-0.dll 缺失 🔴 阻断

**症状**：Win7 启动弹窗 "无法启动此程序，因为计算机中丢失 api-ms-win-core-winrt-l1-1-0.dll"

**根因**：Tauri 依赖链通过 4 条路径引用 WinRT API Set：
- **链 A**（通知）：`tauri-plugin-notification` → `notify-rust` → `tauri-winrt-notification` → `windows` crate
- **链 B**（WebView2 COM）：`tauri` → `webview2-com` → `windows` crate
- **链 C**（窗口管理）：`tauri` → `tao` → `windows` crate
- **链 D**（MCP 进程管理）：`rmcp` → `process-wrap` → `windows` crate

**关键技术约束**：`windows-link` crate 使用 `#[link(kind = "raw-dylib")]` 声明 DLL 导入，C stub (.lib) **无法覆盖**（优先级低于 raw-dylib）。只有 Shim DLL + DELAYLOAD 组合可以解决。

**需实现的函数**：
- HSTRING 全套（18 个函数）：`WindowsCreateString`、`WindowsDeleteString`、`WindowsGetStringLen` 等
- WinRT 初始化桩（5+ 个函数）：`RoInitialize`、`RoGetActivationFactory` 等

### 问题 2：api-ms-win-core-winrt-string-l1-1-0.dll 缺失 🔴 阻断

同上，`windows` crate 的 HSTRING 操作内部链入了 string 子 DLL。

### 问题 3：api-ms-win-core-synch-l1-2-0.dll 缺失 🔴 阻断

**症状**：PE 导入表引用 `WaitOnAddress`、`WakeByAddressSingle`、`WakeByAddressAll`

**根因**：Rust std 的 `parking_lot_core` / Condvar 使用 Win8+ 同步原语。

**解决方案**：C stub + DELAYLOAD，并在 PE 级别将 DLL 名重映射为 `kernel32.dll`（因为 Sleep/SleepEx 等回退函数实际在 kernel32 中）。

### 问题 4：combase.dll 缺失 🟡 风险

**症状**：PE 导入表引用 `CoTaskMemFree`、`CoCreateFreeThreadedMarshaler`、`CoIncrementMTAUsage`、`CoTaskMemAlloc`

**根因**：`chrono` → `iana-time-zone` → `windows-core` / `windows-sys`

**解决方案**：C stub 转发到 `ole32.dll`（Win7 自带）+ DELAYLOAD。

### 问题 5：GetSystemTimePreciseAsFileTime 缺失 🔴 阻断

**症状**：Win7 弹窗 "无法定位程序输入点 GetSystemTimePreciseAsFileTime 于 kernel32.dll"

**根因**：Rust 1.78+ std 静态导入此 Win8+ API。

**解决方案**：PE 二进制补丁 — 在编译后 EXE 中原地替换函数名为 `GetSystemTimeAsFileTime`（Win7 可用，签名相同）。

### 问题 6：ProcessPrng (bcryptprimitives.dll) 缺失 🔴 阻断

**症状**：Win7 弹窗 "无法定位程序输入点 ProcessPrng 于动态链接库 bcryptprimitives.dll"

**根因**：`getrandom` crate 在 Windows 上默认调用 Win8+ 的 `bcryptprimitives.dll!ProcessPrng`。Win7 自带的 `bcryptprimitives.dll` 不含此导出。

**解决方案**：
1. `RUSTFLAGS="--cfg getrandom_backend=\"rdrand\""` — 让 getrandom 0.3.x/0.4.x 使用 rdrand 后端（不依赖 bcryptprimitives）
2. C stub 提供 `ProcessPrng` 回退到 `advapi32.dll!SystemFunction036`（RtlGenRandom，XP+ 可用）
3. 统一 `bcryptprimitives.dll` shim DLL，放在 EXE 同目录，优先于 System32 加载

### 问题 7：WebView2 Runtime 兼容 🟡 降级

**现状**：Win7 最高支持 WebView2 109（Fixed Version），不支持 Evergreen 自动更新。

**解决方案**：
- 安装包**不捆绑** WebView2（`webviewInstallMode: "skip"`）
- 目标系统需预装 WebView2 109+
- 安装器检测 WebView2 注册表，未安装时显示非阻塞警告
- 安装包体积从 ~600MB 降至 ~25MB

### 问题 8：CSS 兼容性（Chromium 109）🟢 降级

**现状**：WebView2 109 基于 Chromium 109，不支持 `oklch()`、`color-mix()`、CSS Nesting 等新特性。

**解决方案**：`@supports not` 回退 — 检测到不支持新 CSS 属性时使用传统写法。

---

## 三、实现方案总览

### 3.1 技术架构

```
┌──────────────────────────────────────────────────────────────────┐
│                      Win7 兼容技术栈                              │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │  Shim DLL 体系   │  │  DELAYLOAD 体系   │  │  PE 二进制补丁   │  │
│  │                 │  │                  │  │                 │  │
│  │ api-ms-win-     │  │ build.rs 声明    │  │ 子系统→6.1      │  │
│  │ core-winrt-     │  │ 6 个 DELAYLOAD   │  │ GSTPAFT→GSTAFT  │  │
│  │ l1-1-0.dll      │  │ DLL:             │  │ synch→kernel32  │  │
│  │ (HSTRING+WinRT) │  │ - synch          │  │                 │  │
│  │                 │  │ - combase        │  │                 │  │
│  │ bcryptprimitives│  │ - bcryptprimitives│  │                 │  │
│  │ .dll            │  │ - winrt          │  │                 │  │
│  │ (ProcessPrng+   │  │ - winrt-string   │  │                 │  │
│  │  synch stubs)   │  │                  │  │                 │  │
│  └─────────────────┘  └──────────────────┘  └─────────────────┘  │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │  C Stub 体系     │  │  Feature Gate    │  │  CSS 回退        │  │
│  │                 │  │                  │  │                 │  │
│  │ win7_stubs.c    │  │ win7-compat      │  │ @supports not   │  │
│  │ - WaitOnAddress │  │ feature 跳过     │  │ oklch→rgb       │  │
│  │ - WakeByAddress │  │ notification     │  │ color-mix fallbk│  │
│  │ - CoTaskMem*    │  │ 插件注册         │  │                 │  │
│  │ - ProcessPrng   │  │ 消除 WinRT 链 A  │  │                 │  │
│  └─────────────────┘  └──────────────────┘  └─────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 各组件详解

#### 3.2.1 Shim DLL — `api-ms-win-core-winrt-l1-1-0.dll`

**位置**：`src-tauri/win7_winrt_shim/`

**构建**：MSVC (`cl.exe /LD`) 编译 → 输出到 `src-tauri/binaries/`

**原理**：Windows DLL 搜索顺序中，EXE 所在目录优先于 System32。安装器将该 DLL 放入安装目录，当 DELAYLOAD 触发时，`__delayLoadHelper2` 在 EXE 同目录找到此 DLL，优先加载。

**实现内容**：
| 模块 | 文件 | 函数数 |
|------|------|--------|
| HSTRING 实现 | `hstring.c` + `hstring.h` | 18 个（基于 HeapAlloc） |
| WinRT 初始化桩 | `winrt_stubs.c` | 8 个（RoInitialize 返回 S_OK 等） |
| DLL 入口 | `dllmain.c` | 空实现 |
| 导出列表 | `exports.def` | 26 个符号 |

**HSTRING 内存布局**：
```
[wchar_t* data] → [flags:4][length:4][pad1:4][pad2:4][wchar_t buffer[len+1]]
                     ←─────── HSTRING_HEADER ──────→  ←── data ──→
```

#### 3.2.2 Shim DLL — `bcryptprimitives.dll`

**位置**：`src-tauri/win7_winrt_shim/bcrypt_stubs.c` → 编译输出到 `src-tauri/binaries/bcryptprimitives.dll`

**导出**：`ProcessPrng`、`WaitOnAddress`、`WakeByAddressSingle`、`WakeByAddressAll`（`bcrypt_exports.def`）

**实现**：
- `ProcessPrng` → 转发到 `advapi32.dll!SystemFunction036`（RtlGenRandom，XP+ 可用）
- `WaitOnAddress` → Sleep 回退
- `WakeByAddressSingle` / `WakeByAddressAll` → 空操作

**安装**：通过 `tauri.win7.conf.json` 的 `externalBin` 放到 EXE 同目录，优先于 `C:\Windows\System32\bcryptprimitives.dll` 加载。

#### 3.2.3 C Stub 文件 — `win7_stubs.c`

**位置**：`src-tauri/win7_stubs.c`

**编译**：`build.rs` 通过 `cc::Build` 静态链接入主程序

**实现**：
| 函数 | 来源 DLL | 实现策略 |
|------|---------|---------|
| `WaitOnAddress` | synch-l1-2-0 | Sleep 回退 |
| `WakeByAddressSingle` | synch-l1-2-0 | 空操作 |
| `WakeByAddressAll` | synch-l1-2-0 | 空操作 |
| `CoTaskMemFree` | combase | 转发 ole32.dll |
| `CoTaskMemAlloc` | combase | 转发 ole32.dll |
| `CoCreateFreeThreadedMarshaler` | combase | 转发 ole32.dll |
| `CoIncrementMTAUsage` | combase | 返回 S_OK |
| `ProcessPrng` | bcryptprimitives | 转发 advapi32!RtlGenRandom |

#### 3.2.4 DELAYLOAD 配置

**位置**：`src-tauri/build.rs`

```rust
println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-synch-l1-2-0.dll");
println!("cargo:rustc-link-arg=/DELAYLOAD:combase.dll");
println!("cargo:rustc-link-arg=/DELAYLOAD:bcryptprimitives.dll");
println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-winrt-l1-1-0.dll");
println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-winrt-string-l1-1-0.dll");
println!("cargo:rustc-link-arg=delayimp.lib");
```

#### 3.2.5 Feature Gate — `win7-compat`

**位置**：`src-tauri/Cargo.toml` + `src-tauri/src/lib.rs`

```toml
[features]
win7-compat = []
```

**效果**：`#[cfg(not(feature = "win7-compat"))]` 跳过 `tauri-plugin-notification` 注册，消除 WinRT 依赖链 A。

#### 3.2.6 PE 二进制补丁

**位置**：`scripts/patch-win7-pe.mjs`（beforeBundleCommand 在 cargo build 后、NSIS 打包前执行）

**补丁列表**：
| 补丁 | 方式 | 目标 |
|------|------|------|
| PE 子系统版本 | 写入 Optional Header | 6.1 (Win7) |
| GetSystemTimePreciseAsFileTime | 原地替换 + \0 填充 | GetSystemTimeAsFileTime |
| delay-load DLL 重映射 | api-ms-win-core-synch-l1-2-0.dll → kernel32.dll | Sleep/SleepEx 回退路径 |
| 应用范围 | 主 EXE + kb-mcp sidecar + pdfium.dll | 全部二进制 |

#### 3.2.7 getrandom 后端配置

**RUSTFLAGS**：`--cfg getrandom_backend="rdrand"` — 强制 getrandom 0.3.x/0.4.x 使用 rdrand 后端（不调用 ProcessPrng）

**同时**：C stub `ProcessPrng` 作为兜底，回退到 `advapi32!RtlGenRandom`

#### 3.2.8 构建脚本

**位置**：`scripts/build-win7.mjs`

**命令**：`pnpm build:win7`

**流程**：
```
1. 验证工具链
2. 备份 tauri.conf.json → tauri.conf.json.bak
3. 替换为 tauri.win7.conf.json
4. Phase 0: 构建 WinRT Shim DLL (MSVC)
5. Phase 1: cargo build --release --features win7-compat
   RUSTFLAGS="--cfg getrandom_backend=\"rdrand\""
6. beforeBundleCommand: patch-win7-pe.mjs (PE 补丁)
7. Phase 2: tauri build --bundles nsis
8. 构建后导入扫描 (BLOCKING_IMPORTS 检查)
9. bcryptprimitives.dll shim 验证
10. 产物重命名: 知识库_Setup_x.x.x_win7_x64-setup.exe
11. 恢复 tauri.conf.json
```

**导入阻断检查清单** (`BLOCKING_IMPORTS`)：
- `GetSystemTimePreciseAsFileTime`
- `api-ms-win-crt-private-l1-1-0.dll`
- `ProcessPrng`
- `api-ms-win-core-winrt-l1-1-0.dll`
- `api-ms-win-core-winrt-string-l1-1-0.dll`

---

## 四、已完成的任务（按时间线）

### 阶段 1：基础适配 (2026-06-11 ~ 06-12)

| 提交 | 内容 |
|------|------|
| `8757301` | CSS 兼容：`oklch` / `color-mix` → `rgb` 回退（Chromium 109） |
| `80a3b8e` | WebView2 Fixed Version 109 捆绑 |
| `88e4759` | 双分支构建体系：Win7 专属配置 + 构建脚本 + NSIS OS 检测 |
| `9fbc998` | build.rs 锁定 PE 子系统 6.01 |

### 阶段 2：PE 补丁 + C Stub (2026-06-12 ~ 06-13)

| 提交 | 内容 |
|------|------|
| `b164f9b` | PE 子系统后处理补丁 + C stub 消除 Win8+ DLL 导入 |
| `768266b` | C stub 消除 Win8+ DLL 导入 + PE 后处理补丁 |
| `9bad27a` | C stub 移除 windows.h 依赖，纯前向声明 |
| `80d119f` | 修复 MSVC CP936 编码兼容 |
| `b882cfb` | DELAYLOAD 需链接 delayimp.lib |
| `e4cf137` | 降级 iana-time-zone 切断 combase.dll + PE patch NSIS 重建 |
| `4754af1` | 容忍签名错误，tauri build 失败后仍执行 PE patch + NSIS 重建 |
| `9722dda` | combase.dll 加入 DELAYLOAD + synch/combase 降级为警告 |

### 阶段 3：NSIS 打包修复 (2026-06-13)

| 提交 | 内容 |
|------|------|
| `7c6cfad` | 修正 NSIS 重建路径，确保安装包含已补丁 EXE |
| `bfe24db` | 用第二次 tauri build 替代 makensis 直接调用 |
| `ad29e1a` | beforeBundleCommand PE patch — 确保 NSIS 安装包含已补丁 EXE |
| `28c848c` | 修正 beforeBundleCommand 路径 |
| `bb02bab` | 修正 beforeBundleCommand 的工作目录 |
| `fe2ae3e` | 去除桌面快捷方式 + 清理旧安装包残留 |
| `3670f15` | 修复 renameOutput 误删当前产物 bug |

### 阶段 4：ProcessPrng + bcrypt 修复 (2026-06-14 ~ 06-16)

| 提交 | 内容 |
|------|------|
| `392fd98` | GETRANDOM_BACKEND=rdrand + 运行目录 log.txt 日志 |
| `3eca154` | RUSTFLAGS cfg 启用 getrandom rdrand backend |
| `254a63a` | bcryptprimitives.dll 加入 DELAYLOAD |
| `215629f` | 统一 bcryptprimitives.dll shim（导出 ProcessPrng + WaitOnAddress 等） |
| `72d0245` | ProcessPrng C stub + getrandom rdrand backend + win7-compat feature |

### 阶段 5：安装器 + 文档 (2026-06-14 ~ 06-15)

| 任务 | 内容 |
|------|------|
| WebView2 移除捆绑 | `webviewInstallMode: "skip"`，安装包 ~600MB → ~25MB |
| 安装器 WebView2 检测 | NSIS hook 检测 Evergreen 注册表，未安装时非阻塞警告 |
| 构建文档 | `docs/win7-build.md` — 完整构建流程与系统要求 |

---

## 五、关键文件清单

### 核心实现文件

| 文件 | 用途 | 行数 |
|------|------|------|
| `src-tauri/build.rs` | DELAYLOAD 声明 + C stub 编译 | ~18 |
| `src-tauri/win7_stubs.c` | C stub 函数实现（synch/combase/bcrypt） | ~108 |
| `src-tauri/src/lib.rs` | win7-compat feature gate（通知插件跳过） | ~5 |
| `src-tauri/Cargo.toml` | win7-compat feature 声明 | ~5 |

### Shim DLL 项目

| 文件 | 用途 | 行数 |
|------|------|------|
| `src-tauri/win7_winrt_shim/hstring.c` | HSTRING 全套实现 | ~370 |
| `src-tauri/win7_winrt_shim/hstring.h` | HSTRING 内存布局定义 | ~40 |
| `src-tauri/win7_winrt_shim/winrt_stubs.c` | WinRT 初始化桩 | ~80 |
| `src-tauri/win7_winrt_shim/dllmain.c` | DLL 入口 | ~15 |
| `src-tauri/win7_winrt_shim/exports.def` | WinRT DLL 导出符号 | ~34 |
| `src-tauri/win7_winrt_shim/bcrypt_stubs.c` | bcrypt stub 实现 | ~100 |
| `src-tauri/win7_winrt_shim/bcrypt_exports.def` | bcrypt DLL 导出符号 | ~7 |
| `src-tauri/win7_winrt_shim/build.ps1` | MSVC 构建脚本 | ~130 |

### 构建脚本

| 文件 | 用途 | 行数 |
|------|------|------|
| `scripts/build-win7.mjs` | Win7 构建主脚本 | ~381 |
| `scripts/patch-win7-pe.mjs` | PE 补丁脚本 | ~76 |

### 配置文件

| 文件 | 用途 |
|------|------|
| `src-tauri/tauri.win7.conf.json` | Win7 专属 Tauri 配置（skip WebView2 + externalBin） |
| `src-tauri/installer-hooks.nsi` | NSIS 安装器钩子（Win7 SP1 检测 + WebView2 检测） |
| `docs/win7-build.md` | Win7 兼容版构建文档 |

### 分析/任务文档

| 文件 | 用途 |
|------|------|
| `tasks/Win7兼容分析及任务.md` | 完整 Win7 兼容分析与任务规划（740 行） |
| `tasks/Win7后续开发任务B.md` | ProcessPrng/bcryptprimitives shim 方案（293 行） |
| `tasks/兼容win7分析.md` | 三方案对比分析（Rust 1.75 vs 1.77 vs C stub） |
| `tasks/win7-build.md` | 构建指南 |

---

## 六、待办事项 / 已知风险

### 待验证

| 项目 | 说明 |
|------|------|
| **Win7 真机验证** | 安装包在 Win7 SP1 上的完整启动、功能测试 |
| **HSTRING 内存布局** | 需在 Win7 真机上确认与 windows crate 预期完全兼容 |
| **WebView2 109 兼容** | 确认所有前端功能在 Chromium 109 内核下正常 |

### 已知限制

| 限制 | 影响 |
|------|------|
| 系统通知不可用 | Win7 构建跳过 tauri-plugin-notification |
| WebView2 109 内核陈旧 | 不支持新 CSS 特性（已通过 @supports 回退处理） |
| 安装包不捆绑 WebView2 | 用户需预装 WebView2 109+ |
| 构建需 MSVC 工具链 | Shim DLL 依赖 cl.exe 编译 |

### 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| HSTRING 布局与 windows crate 不兼容 | 中 | 高 — WebView2 初始化崩溃 | Win7 真机优先验证 |
| 上游 crate 更新引入新 WinRT 依赖 | 低 | 中 — 需追加修复 | PE 导入扫描作为门禁 |
| bcryptprimitives shim 未正确安装到 EXE 同目录 | 低 | 高 — 仍加载 System32 版本 | 构建后扫描验证 |
| WebView2 109 缺失导致窗口无法打开 | 中 | 高 — 安装后无法使用 | 安装器检测 + 下载指引 |

---

## 七、构建命令速查

```bash
# Win7 兼容版构建（一键）
pnpm build:win7

# Debug 构建
pnpm build:win7 --debug

# 强制重建 Shim DLL
pnpm build:win7 --force-shim

# 构建后产物
# → src-tauri/target/release/bundle/nsis/知识库_Setup_x.x.x_win7_x64-setup.exe
```

---

## 八、技术方案选型历史

在实施 Win7 兼容过程中，经历了多轮方案迭代：

| 方案 | 核心思路 | 结论 |
|------|---------|------|
| **Rust 1.75 严格路线** | 降级 Rust + 所有依赖以从编译器层面消除 Win8+ API | ❌ 不适用 — Tauri 2.x 依赖链 100+ 包不兼容 Rust 1.75 |
| **Rust 1.77.2 折中** | 适度降级消除 ProcessPrng + synch | ❌ 30+ 包需降级，且 synch 问题 1.77 仍存在 |
| **C stub 统一方案** | 靠 .lib 静态库覆盖 raw-dylib 导入 | ❌ 不可行 — raw-dylib 优先级高于 .lib |
| **最终方案（当前）** | Shim DLL + DELAYLOAD + C stub + PE patch + feature gate | ✅ 采用 |
