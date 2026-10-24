# Win7 兼容报错及处理汇总

> **分支**: feature/win7-compat  
> **基础**: Tauri 2.10.3 + Rust 1.96 (edition 2021)  
> **汇总范围**: 2026-06-11 ~ 2026-06-17（31 个提交，28 个文件变更，+2380/-92 行）

---

## 概览：8 大类报错 × 31 次修复

```
报错类型          出现次数    严重度      最终状态
─────────────────────────────────────────────────
DLL 缺失              3       🔴 阻断      ✅ 已修复
API 缺失              2       🔴 阻断      ✅ 已修复
CSS 兼容              1       🟡 降级      ✅ 已修复
构建工具链            3       🟡 阻断构建   ✅ 已修复
NSIS 打包路径          5       🟡 阻断打包   ✅ 已修复
签名/产物             2       🟡 阻断打包   ✅ 已修复
依赖链污染            1       🟡 风险       ✅ 已修复
运行日志              1       🟢 调试       ✅ 已就绪
```

---

## 一、DLL 缺失类（🔴 阻断 — 启动即弹窗报错）

### 报错 1.1：api-ms-win-core-winrt-l1-1-0.dll 缺失

**症状**：Win7 启动弹窗 "无法启动此程序，因为计算机中丢失 api-ms-win-core-winrt-l1-1-0.dll"

**根因**：Tauri 依赖链通过 4 条路径引用 WinRT API Set：
- 链 A（通知）: `tauri-plugin-notification` → `tauri-winrt-notification` → `windows` crate
- 链 B（WebView2）: `tauri` → `webview2-com` → `windows` crate
- 链 C（窗口）: `tauri` → `tao` → `windows` crate
- 链 D（MCP）: `rmcp` → `process-wrap` → `windows` crate

关键约束：`windows-link` 使用 `#[link(kind = "raw-dylib")]`，C stub .lib 无法覆盖。

**处理方案**：
1. **Feature gate**: `#[cfg(not(feature = "win7-compat"))]` 跳过 `tauri-plugin-notification` 注册 → 消除链 A
2. **Shim DLL**: 自实现 `api-ms-win-core-winrt-l1-1-0.dll`（HSTRING 全套 18 函数 + WinRT 初始化桩 8 函数），放 EXE 同目录，Windows 搜索顺序优先于 System32
3. **DELAYLOAD**: build.rs 声明 `/DELAYLOAD:api-ms-win-core-winrt-l1-1-0.dll`，链接时不解析，运行时通过 Shim DLL 满足

**涉及提交**：`768266b`, `9bad27a`, `80d119f`, `b882cfb`, `4754af1`, `9722dda`, `ad29e1a`, `7c6cfad`

---

### 报错 1.2：api-ms-win-core-winrt-string-l1-1-0.dll 缺失

**症状**：同上（`windows` crate 的 HSTRING 操作内部链入了 string 子 DLL）

**根因**：与 1.1 同源，`windows` crate raw-dylib 导入

**处理方案**：PE 补丁中将 `api-ms-win-core-winrt-string-l1-1-0.dll` 导入重映射为 `api-ms-win-core-winrt-l1-1-0.dll`（统一由 WinRT Shim DLL 提供）

**涉及提交**：`3875506`

---

### 报错 1.3：api-ms-win-core-synch-l1-2-0.dll 缺失

**症状**：PE 导入表引用 `WaitOnAddress`、`WakeByAddressSingle`、`WakeByAddressAll`

**根因**：Rust std 的 `parking_lot_core` / Condvar 使用 Win8+ 同步原语

**处理方案**：
1. **C stub → Rust stub**: `win7_stubs.c` → `win7_stubs.rs`（`#[no_mangle] extern "system"`），将 synch 函数转发到 `kernel32!Sleep` / 空操作
2. **DELAYLOAD**: `/DELAYLOAD:api-ms-win-core-synch-l1-2-0.dll`
3. **PE 重映射**: DLL 名重映射为 `bcryptprimitives.dll`（统一 Shim DLL 提供）

**涉及提交**：`b164f9b`, `768266b`, `9722dda`, `3875506`, `910bc1a`

**演进**: 最初 remap 到 kernel32.dll → 发现 kernel32 也不导出 WaitOnAddress（Win8+ API）→ 改为统一 bcryptprimitives shim 提供

---

## 二、API 缺失类（🔴 阻断 — 启动后弹窗报错）

### 报错 2.1：GetSystemTimePreciseAsFileTime 缺失

**症状**：Win7 弹窗 "无法定位程序输入点 GetSystemTimePreciseAsFileTime 于动态链接库 kernel32.dll"

**根因**：Rust 1.78+ std 静态导入此 Win8+ API（通过 `windows-sys` 或直接 link）

**处理方案**：PE 二进制补丁 — `scripts/patch-win7-pe.mjs` 编译后扫描 PE 导入表，原地将 `GetSystemTimePreciseAsFileTime\0` 替换为 `GetSystemTimeAsFileTime\0\0\0\0\0\0\0\0`（两函数签名相同：`fn(*mut FILETIME)`）

**涉及提交**：`9fbc998`, `2e49d14`, `b164f9b`, `768266b`

---

### 报错 2.2：ProcessPrng (bcryptprimitives.dll) 缺失

**症状**：Win7 弹窗 "无法定位程序输入点 ProcessPrng 于动态链接库 bcryptprimitives.dll"

**根因**：`getrandom` crate 在 Windows 上默认调用 Win8+ 的 `bcryptprimitives.dll!ProcessPrng`；Win7 自带的 `bcryptprimitives.dll` 不含此导出

**处理方案**：
1. **RUSTFLAGS**: `--cfg getrandom_backend="rdrand"` — 让 getrandom 使用 rdrand CPU 指令（不依赖任何外部 DLL）
2. **C/Rust stub**: `ProcessPrng` 桩函数 → 转发到 `advapi32.dll!SystemFunction036`（RtlGenRandom，XP+ 可用）
3. **统一 bcryptprimitives Shim DLL**: 自制 `bcryptprimitives.dll` 放到 EXE 同目录，同时导出 ProcessPrng + WaitOnAddress/WakeByAddress（统一解决报错 2.2 + 1.3）

**涉及提交**：`392fd98`, `3eca154`, `254a63a`, `215629f`, `72d0245`

**演进**: 
- 最初仅用 rdrand backend → 但仍有间接依赖调用 ProcessPrng
- C stub 单独导出 ProcessPrng → 仍有路径未被拦截
- 最终方案：rdrand + C stub + 统一 bcryptprimitives shim DLL → 三管齐下

---

## 三、CSS 兼容类（🟡 降级）

### 报错 3.1：Tailwind oklch/color-mix 颜色渲染异常

**症状**：WebView2 109（Win7 最高支持版本）中颜色渲染不正确

**根因**：Chromium 109 不支持 `oklch()`、`color-mix()`、CSS Nesting 等新特性

**处理方案**：在 `src/styles/global.css` 中使用 `@supports not (color: oklch(0 0 0))` 检测不支持时回退到传统 `rgb()`/`hsl()` 写法

**涉及提交**：`8757301`

---

## 四、构建工具链类（🟡 阻断构建）

### 报错 4.1：MSVC CP936 编码编译失败

**症状**：`cl.exe` 编译 C stub 时报编码错误

**根因**：C 源文件含中文注释，MSVC 在中文系统默认 CP936 无法处理某些字符

**处理方案**：移除 C stub 文件中所有非 ASCII 字符（注释用英文）

**涉及提交**：`80d119f`

---

### 报错 4.2：DELAYLOAD 链接失败

**症状**：链接器报错 `unresolved external symbol __delayLoadHelper2`

**根因**：使用 `/DELAYLOAD` 但未链接 `delayimp.lib`

**处理方案**：build.rs 中添加 `println!("cargo:rustc-link-arg=delayimp.lib");`

**涉及提交**：`b882cfb`

---

### 报错 4.3：C 编译器依赖问题

**症状**：构建需要安装 MSVC C 编译器（`cc` crate 依赖），增加环境复杂度

**根因**：win7_stubs.c 通过 `cc::Build` 编译为 .obj 链接

**处理方案**：将 `win7_stubs.c` 重写为 `win7_stubs.rs`（纯 `#[no_mangle] extern "system"` Rust 函数），消除 `cc` build-dependency，添加 `/FORCE:MULTIPLE` 解决 Rust std 与自定义桩的符号冲突

**涉及提交**：`910bc1a`

---

## 五、NSIS 打包路径类（🟡 阻断打包）

### 报错 5.1~5.5：安装包不含已补丁 EXE / 路径错误

**症状序列**：
1. NSIS 打包的 EXE 未经 PE 补丁 → Win7 仍报缺失 DLL
2. `beforeBundleCommand` 路径计算错误 → PE 补丁未执行
3. `beforeBundleCommand` 工作目录错误 → PE 补丁脚本找不到文件
4. 用 `makensis` 直接重建 → 参数格式不一致
5. `renameOutput` 误删当前产物

**处理方案**：
- `beforeBundleCommand` 改为执行 PE patch 脚本（`.mjs`）
- 多次修正路径计算和工作目录
- 用第二次 `tauri build` 替代直接调用 `makensis`
- 修复 renameOutput 的文件名比较逻辑

**涉及提交**：`7c6cfad`, `bfe24db`, `ad29e1a`, `28c848c`, `bb02bab`, `fe2ae3e`, `3670f15`

---

## 六、签名 / 产物类（🟡 阻断打包）

### 报错 6.1：签名失败导致构建中断

**症状**：`tauri build` 因代码签名失败而终止，不执行后续 PE patch 和 NSIS 重建

**处理方案**：容忍签名错误 — `tauri build` 失败后仍继续执行 PE patch + NSIS 重建流程

**涉及提交**：`4754af1`

---

### 报错 6.2：combase.dll 依赖链污染

**症状**：PE 导入表出现 `CoTaskMemFree`、`CoCreateFreeThreadedMarshaler`、`CoIncrementMTAUsage`、`CoTaskMemAlloc`（均来自 combase.dll，Win8+）

**根因**：`chrono` → `iana-time-zone` → `windows-core` / `windows-sys`

**处理方案**：
1. C stub 将 combase 函数转发到 `ole32.dll`（Win7 自带）
2. DELAYLOAD: `/DELAYLOAD:combase.dll`
3. PE 扫描中将 combase/synch 从阻断降级为警告（有 DELAYLOAD + stub 兜底）

**涉及提交**：`e4cf137`, `9722dda`

---

## 七、依赖链污染类（🟡 风险）

### 报错 7.1：pdfium.dll 外部二进制风险

**症状**：pdfium.dll 作为外部二进制文件随安装包分发，PE 补丁需覆盖第三方 DLL

**处理方案**：`include_bytes!` 编译时嵌入 6.8MB pdfium.dll 到 EXE，运行时提取到 `%TEMP%` 加载。消除了外部 DLL 文件依赖和 PE 补丁的第三方二进制风险

**涉及提交**：`51a35ec`

---

## 八、运行日志（🟢 调试就绪）

### 报错 8.1：缺乏 Win7 运行日志

**症状**：Win7 上运行崩溃后无日志可查

**处理方案**：添加运行目录 `log.txt` 日志输出（`tauri-plugin-log`），记录数据目录、数据库版本、PDFium 状态等关键信息

**涉及提交**：`392fd98`

---

## 完整提交时间线

| 日期 | 提交 | 报错类型 |
|------|------|---------|
| 06-11 | `8757301` | CSS 兼容 — oklch/color-mix 回退 |
| 06-11 | `80a3b8e` | WebView2 109 Fixed Version 捆绑 |
| 06-11 | `88e4759` | 双分支构建体系搭建 |
| 06-12 | `9fbc998` | API 缺失 — PE 子系统 6.01 锁定 |
| 06-12 | `2e49d14` | API 缺失 — PE 子系统 6.01 锁定（重复提交） |
| 06-12 | `b164f9b` | DLL 缺失 — PE patch + C stub 消除 Win8+ DLL |
| 06-13 | `768266b` | DLL 缺失 — C stub + PE 后处理 |
| 06-13 | `9bad27a` | 构建工具链 — C stub 移除 windows.h |
| 06-13 | `80d119f` | 构建工具链 — 修复 CP936 编码 |
| 06-13 | `b882cfb` | 构建工具链 — DELAYLOAD 需 delayimp.lib |
| 06-13 | `e4cf137` | 签名/产物 — 降级 iana-time-zone 切断 combase |
| 06-13 | `4754af1` | 签名/产物 — 容忍签名错误 |
| 06-13 | `9722dda` | DLL 缺失 — combase DELAYLOAD |
| 06-13 | `7c6cfad` | NSIS 打包 — 修正 NSIS 重建路径 |
| 06-13 | `bfe24db` | NSIS 打包 — 第二次 tauri build 替代 makensis |
| 06-13 | `ad29e1a` | NSIS 打包 — beforeBundleCommand PE patch |
| 06-13 | `28c848c` | NSIS 打包 — 修正 beforeBundleCommand 路径 |
| 06-13 | `bb02bab` | NSIS 打包 — 修正工作目录 |
| 06-13 | `fe2ae3e` | NSIS 打包 — 去除桌面快捷方式 |
| 06-13 | `3670f15` | NSIS 打包 — 修复 renameOutput 误删 |
| 06-14 | `392fd98` | API 缺失 — rdrand backend + log.txt |
| 06-14 | `3eca154` | API 缺失 — RUSTFLAGS cfg 启用 rdrand |
| 06-14 | `254a63a` | API 缺失 — bcryptprimitives DELAYLOAD |
| 06-15 | `215629f` | DLL/API 缺失 — 统一 bcryptprimitives shim |
| 06-16 | `72d0245` | API 缺失 — ProcessPrng stub + win7-compat feature |
| 06-16 | `3875506` | DLL 缺失 — PE patch synch rename + 多目标 |
| 06-17 | `51a35ec` | 依赖链 — pdfium 嵌入 EXE |
| 06-17 | `e46f9c3` | 产物 — 重命名 知识库 → Intelligent NoteBook |
| 06-17 | `910bc1a` | 构建工具链 — win7_stubs.c → .rs 纯 Rust |

---

## 最终技术栈

```
┌──────────────────────────────────────────────────────────────┐
│                    Win7 兼容技术栈 (最终态)                     │
│                                                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │ Shim DLL 体系 │ │ Rust Stub    │ │ PE 二进制补丁         │  │
│  │              │ │ (win7_stubs  │ │ (patch-win7-pe.mjs)  │  │
│  │ winrt-l1-1-0 │ │  .rs)        │ │                      │  │
│  │ bcryptprimi- │ │              │ │ 子系统 → 6.1          │  │
│  │ tives.dll    │ │ #[no_mangle] │ │ GSTPAFT → GSTAFT     │  │
│  │              │ │ extern       │ │ synch → bcrypt       │  │
│  └──────────────┘ └──────────────┘ └──────────────────────┘  │
│                                                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │ DELAYLOAD    │ │ Feature Gate │ │ getrandom 后端        │  │
│  │ (6 个 DLL)   │ │              │ │                      │  │
│  │              │ │ win7-compat  │ │ RUSTFLAGS=           │  │
│  │ build.rs     │ │ feature 跳过 │ │ --cfg getrandom_     │  │
│  │ /DELAYLOAD:  │ │ notification │ │ backend="rdrand"     │  │
│  └──────────────┘ └──────────────┘ └──────────────────────┘  │
│                                                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │ CSS 回退      │ │ 嵌入二进制    │ │ WebView2             │  │
│  │              │ │              │ │                      │  │
│  │ @supports    │ │ include_bytes│ │ Fixed Version 109    │  │
│  │ not (oklch)  │ │ ! pdfium.dll │ │ 安装器检测+指引       │  │
│  └──────────────┘ └──────────────┘ └──────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 已知限制与待验证

| 项目 | 状态 |
|------|------|
| Win7 真机完整启动测试 | ⏳ 待验证 |
| HSTRING 内存布局与 windows crate 兼容性 | ⏳ 待 Win7 真机验证 |
| WebView2 109 下全功能测试 | ⏳ 待验证 |
| 系统通知不可用（已知限制） | ✅ 设计如此 |
| CSS 新特性已通过 @supports 回退 | ✅ 已实现 |
| 构建不再需要 CC 编译器 | ✅ 纯 Rust stub |
| pdfium.dll 不再作为外部文件分发 | ✅ 嵌入 EXE |
