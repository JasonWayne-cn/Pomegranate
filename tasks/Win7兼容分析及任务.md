# Win7 兼容分析及任务：`api-ms-win-core-winrt-l1-1-0.dll` 缺失修复

> **日期**: 2026-06-14  
> **分支**: feature/win7-compat  
> **Bug**: Win7 启动报错 "无法启动此程序，因为计算机中丢失 api-ms-win-core-winrt-l1-1-0.dll"  
> **根因**: Tauri 2.x 依赖链引入 WinRT API Set 导入，Win7 不包含 WinRT 运行时

---

## 一、根因分析

### 1.1 依赖链追踪

通过 `cargo tree` 追踪，共 **4 条依赖链** 引入 `api-ms-win-core-winrt-l1-1-0.dll`：

```
链 A（通知 - 显式 WinRT）：
  intelligent_notebook
    → tauri-plugin-notification 2.3.3
      → notify-rust 4.16.0
        → tauri-winrt-notification 0.7.2   ← "winrt" 在名字里
          → windows 0.61.3
            → windows-core 0.61.2
              → windows-link 0.1.3
                → #[link(kind="raw-dylib")] api-ms-win-core-winrt-l1-1-0.dll

链 B（WebView2 COM 互操作）：
  tauri 2.10.3 → tauri-runtime-wry → webview2-com 0.38.2
    → windows 0.61.3 → windows-core → windows-link → 同上

链 C（窗口管理）：
  tauri 2.10.3 → tao 0.34.6 → windows 0.61.3 → 同上

链 D（MCP 进程管理）：
  rmcp 1.5.0 → process-wrap 9.1.0 → windows 0.62.2 → 同上
```

### 1.2 为什么现有修复无效

当前 `build.rs` 只覆盖了：

| 已处理 | 方式 | 未处理 |
|--------|------|--------|
| `api-ms-win-core-synch-l1-2-0.dll` | DELAYLOAD + C stubs | — |
| `combase.dll` | DELAYLOAD + C stubs | — |
| `GetSystemTimePreciseAsFileTime` | PE 二进制替换 | — |
| **`api-ms-win-core-winrt-l1-1-0.dll`** | ❌ 未处理 | **本次 Bug** |
| **`api-ms-win-core-winrt-string-l1-1-0.dll`** | ❌ 未处理 | 可能随之上线 |

### 1.3 关键约束：`raw-dylib` 不可被 C stub 覆盖

`windows-link` crate 使用 `#[link(kind = "raw-dylib")]` 声明 DLL 导入，这与常规 `#[link]` 有本质区别：

| 对比项 | 常规 `#[link]` | `raw-dylib` |
|--------|---------------|-------------|
| 导入方式 | 通过 .lib 导入库 | 直接在 .o 中嵌 DLL 引用 |
| C stub 可覆盖? | ✅ 可以（链接器优先静态库） | ❌ **不可以**（DeepSeek TUI Phase 13 已验证） |
| DELAYLOAD 可用? | ✅ 可以 | ✅ 可以（链接器级） |
| 函数运行时会被调用? | 取决于代码路径 | 取决于代码路径 |

**结论**: 无法照搬 DeepSeek TUI 的 Phase 11 "C stub 统一消除" 方案。

---

## 二、方案组合：DELAYLOAD + Shim DLL + 条件禁用通知

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────┐
│              方案 1: Shim DLL（兜底）                  │
│                                                     │
│  build.rs 追加:                                      │
│    /DELAYLOAD:api-ms-win-core-winrt-l1-1-0.dll       │
│    /DELAYLOAD:api-ms-win-core-winrt-string-l1-1-0.dll│
│                                                     │
│  新建: win7_winrt_shim/ (C 项目)                      │
│    输出: api-ms-win-core-winrt-l1-1-0.dll             │
│    实现: HSTRING 全套 + RoInitialize 等                │
│                                                     │
│  NSIS 打包: 将 shim DLL 装入安装目录（与 EXE 同目录）   │
│            Windows 加载器优先从 EXE 目录搜索 DLL        │
├─────────────────────────────────────────────────────┤
│              方案 2: 条件禁用通知（切断链 A）            │
│                                                     │
│  Cargo feature: win7-compat                          │
│  lib.rs: cfg(not(feature = "win7-compat")) 守卫通知   │
│  效果: 消除最大的显式 WinRT 调用源                     │
└─────────────────────────────────────────────────────┘
```

### 2.2 原理说明

**为何 Shim DLL 可行（C stub 不可行）**：

- C stub (.lib) 与 `raw-dylib` 在**链接器层面**竞争，`raw-dylib` 优先级更高 → C stub 被忽略
- Shim DLL 在 **OS 加载器层面** 起作用：Windows DLL 搜索顺序中，EXE 所在目录优先于系统目录
- 当延迟加载触发时，`__delayLoadHelper2` 在 EXE 目录找到同名 DLL → 加载成功 → 函数解析成功
- `raw-dylib` 只管"从哪个 DLL 导入"，不管"加载器从哪里找 DLL"

**为何 DELAYLOAD 必须配合 Shim DLL**：

- 仅 DELAYLOAD 无 Shim → 延迟加载触发时找不到 DLL → `__delayLoadHelper2` 抛异常 → 崩溃
- 仅 Shim 无 DELAYLOAD → 加载器在进程启动时就尝试加载 → 依然要等 Shim DLL
- 两者配合 → 启动时跳过 WinRT DLL 解析，运行时通过 Shim 提供实现

### 2.3 Shim DLL 需实现的函数

#### HSTRING 函数（核心 — `windows` crate 内部使用）

| 函数 | 实现策略 |
|------|---------|
| `WindowsCreateString` | HeapAlloc + HSTRING header 写入 |
| `WindowsCreateStringReference` | 包装已有 buffer |
| `WindowsDeleteString` | HeapFree |
| `WindowsDuplicateString` | 新建拷贝 |
| `WindowsGetStringLen` | 读 header → length |
| `WindowsGetStringRawBuffer` | 读 header → 计算 buffer 指针 |
| `WindowsIsStringEmpty` | 读 header → length == 0 |
| `WindowsStringHasEmbeddedNull` | 扫描 buffer |
| `WindowsCompareStringOrdinal` | wcsncmp |
| `WindowsConcatString` | 拼接 |
| `WindowsSubstring` | 取子串 |
| `WindowsPreallocateStringBuffer` | 预分配 |
| `WindowsPromoteStringBuffer` | 更新 header length |
| `WindowsDeleteStringBuffer` | 释放预分配 buffer |

#### WinRT 初始化函数（通知插件使用，Option 2 禁用后不再调用）

| 函数 | 实现 |
|------|------|
| `RoInitialize` | 返回 S_OK（COM 已初始化） |
| `RoUninitialize` | 空操作 |
| `RoGetActivationFactory` | 返回 REGDB_E_CLASSNOTREG |
| `RoActivateInstance` | 返回 REGDB_E_CLASSNOTREG |
| `RoGetApartmentIdentifier` | 返回 MTA |

#### HSTRING 内存布局

```
HSTRING 是一个指向字符串缓冲区的指针，缓冲区前 4 字节是长度。
与 BSTR 布局兼容（长度前缀在数据前）。

struct HSTRING_HEADER {
    uint32_t flags;    // 0 或引用标志
    uint32_t length;   // 字符数（不含 null terminator）
    uint32_t padding1;
    uint32_t padding2;
    wchar_t  buffer[length + 1];  // null-terminated
};
```

### 2.4 条件禁用通知插件（方案 2）

```rust
// lib.rs 修改

// 移除直接导入（全局依赖声明不变，只是不注册插件）
// tauri-plugin-notification 仍保留在 Cargo.toml 中
// 但 builder 注册条件化：

#[cfg(not(feature = "win7-compat"))]
builder = builder.plugin(tauri_plugin_notification::init());
```

```toml
# Cargo.toml 新增 feature
[features]
win7-compat = []
```

构建命令变为：
```bash
cargo build --release --features win7-compat
```

**效果**：
- 链 A 的 WinRT 调用路径被完全切断（通知插件未注册，相关代码不会被链接）
- 链 B/C/D 的 WinRT 依赖由 Shim DLL 兜底（HSTRING 函数）
- Win7 用户失去系统通知能力（可接受降级，非核心功能）

---

## 三、详细实现设计

### 3.1 win7_winrt_shim/ 项目结构

```
src-tauri/
├── win7_stubs.c              ← 已有（synch/combase 桩）
├── win7_winrt_shim/          ← 新建
│   ├── CMakeLists.txt         （或 Makefile / build.rs）
│   ├── main.c                 DLL 入口 + HSTRING 实现
│   ├── hstring.h              HSTRING 头文件
│   ├── winrt_stubs.h          WinRT API 桩声明
│   └── build.ps1              Windows 构建脚本
├── build.rs                  ← 修改：追加 DELAYLOAD
└── Cargo.toml                ← 修改：新增 feature
```

### 3.2 build.rs 修改

```rust
fn main() {
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-arg=/SUBSYSTEM:WINDOWS,6.01");
        println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-synch-l1-2-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:combase.dll");
        // 新增 WinRT DLL
        println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-winrt-l1-1-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-winrt-string-l1-1-0.dll");
        println!("cargo:rustc-link-arg=delayimp.lib");

        cc::Build::new()
            .file("win7_stubs.c")
            .compile("win7_stubs");
    }

    tauri_build::build()
}
```

### 3.3 NSIS 打包改造

在 `tauri.win7.conf.json` 的 `bundle.resources` 中添加 shim DLL：

```json
{
  "bundle": {
    "resources": [
      "resources/pdfium/*",
      "win7_winrt_shim/api-ms-win-core-winrt-l1-1-0.dll",
      "win7_winrt_shim/api-ms-win-core-winrt-string-l1-1-0.dll"
    ]
  }
}
```

Tauri 的 `resources` 机制会将文件拷贝到安装目录的 `resources/` 子目录，但 **DLL 搜索路径不包括子目录**。

需要改用 `externalBin` 或通过 `beforeBundleCommand` 脚本手动拷贝 DLL 到 EXE 同级目录：

```js
// 在 patch-win7-pe.mjs 中追加
import { copyFileSync } from "node:fs";

const exeDir = join("src-tauri", "target", "release");
const shimDir = join("src-tauri", "win7_winrt_shim");

copyFileSync(
  join(shimDir, "api-ms-win-core-winrt-l1-1-0.dll"),
  join(exeDir, "api-ms-win-core-winrt-l1-1-0.dll")
);
```

或修改 NSIS 配置 (`tauri.win7.conf.json`)：

```json
{
  "bundle": {
    "externalBin": [
      "binaries/kb-mcp",
      "win7_winrt_shim/api-ms-win-core-winrt-l1-1-0.dll"
    ]
  }
}
```

`externalBin` 会将文件放到 EXE 同级目录。

### 3.4 构建流程变更

```
pnpm build:win7
  ├── 验证 Rust 工具链
  ├── 备份 tauri.conf.json → tauri.conf.json.bak
  ├── 替换为 tauri.win7.conf.json
  ├── [新增] 构建 Shim DLL（cl.exe / MSVC）
  ├── Phase 1: cargo build --release --features win7-compat
  ├── PE 补丁：
  │   ├── SubsystemVersion → 6.1
  │   ├── GetSystemTimePreciseAsFileTime 替换
  │   └── [新增] 拷贝 Shim DLL 到 EXE 目录
  ├── Phase 2: tauri build --bundles nsis
  ├── 构建后 Win8+ 导入扫描（追加 WinRT DLL）
  ├── 产物重命名
  └── 恢复 tauri.conf.json
```

### 3.5 PE 扫描验证增强

在 `build-win7.mjs` 的 `BLOCKING_IMPORTS` 中追加：

```js
const BLOCKING_IMPORTS = [
  "GetSystemTimePreciseAsFileTime",
  "api-ms-win-crt-private-l1-1-0.dll",
  // 新增 — WinRT DLL 不应出现在直接导入表（应由 DELAYLOAD 处理）
  "api-ms-win-core-winrt-l1-1-0.dll",
  "api-ms-win-core-winrt-string-l1-1-0.dll",
];
```

DELAYLOAD 的 DLL 在 PE 导入表中会有 `IMAGE_SCN_MEM_NOT_CACHED` 标记的 Delay-Load Descriptor，但仍可能出现在字符串表中。扫描需区分"直接导入"和"延迟加载引用"。

---

## 四、开发任务列表

### 任务概览

| 序号 | 任务 | 预估工时 | 依赖 | 风险 |
|------|------|---------|------|------|
| T1 | 新建 win7_winrt_shim DLL 项目 | 4h | — | 低 |
| T2 | 追加 DELAYLOAD + 构建集成 | 1h | T1 | 低 |
| T3 | 条件禁用通知插件 (feature gate) | 1h | — | 低 |
| T4 | NSIS 打包集成 Shim DLL | 1h | T1 | 中 |
| T5 | PE 扫描验证增强 | 0.5h | T2 | 低 |
| T6 | 构建脚本全流程联调 | 2h | T1-T5 | 中 |
| T7 | Win7 真机验证 | 2h | T6 | 中 |
| T8 | macOS/Linux 交叉构建验证 | 0.5h | T6 | 低 |

---

### T1: 新建 win7_winrt_shim DLL 项目

**目标**: 创建一个小型 C 项目，编译出 `api-ms-win-core-winrt-l1-1-0.dll`，实现 HSTRING 全套函数 + WinRT 初始化桩。

**文件清单**:

```
src-tauri/win7_winrt_shim/
├── hstring.h           # HSTRING 内存布局定义 + HSTRING_HEADER
├── hstring.c           # HSTRING 函数实现（12+ 函数）
├── winrt_stubs.c       # RoInitialize/RoGetActivationFactory 等桩
├── dllmain.c           # DllMain（空实现）
├── exports.def         # 导出符号列表
└── build.ps1           # 构建脚本
```

**关键实现要点**:

1. `hstring.h` — 定义 HSTRING 内存布局：
   ```c
   // HSTRING 就是 wchar_t*，指向数据区开头
   // 数据区前有 header:
   //   [flags:4] [length:4] [pad1:4] [pad2:4] [data: wchar_t[]]
   // 与 BSTR 兼容（长度前缀偏移）
   
   typedef wchar_t* HSTRING;
   
   typedef struct {
       UINT32 flags;
       UINT32 length;
       UINT32 padding1;
       UINT32 padding2;
   } HSTRING_HEADER;
   
   static HSTRING_HEADER* get_header(HSTRING h) {
       return ((HSTRING_HEADER*)h) - 1;
   }
   ```

2. `hstring.c` — 实现：
   - `WindowsCreateString(source, length, *out)` → HeapAlloc header+data, 拷贝
   - `WindowsDeleteString(h)` → HeapFree
   - `WindowsGetStringLen(h)` → get_header(h)->length
   - `WindowsGetStringRawBuffer(h, *length)` → 返回 h 指针
   - `WindowsIsStringEmpty(h)` → length == 0
   - `WindowsCreateStringReference(source, length, *header, *out)` → 就地包装
   - `WindowsDuplicateString(h, *out)` → CreateString(h, len, out)
   - `WindowsConcatString(h1, h2, *out)` → 拼接
   - `WindowsCompareStringOrdinal(h1, h2, *result)` → wcsncmp
   - `WindowsStringHasEmbeddedNull(h, *has)` → 扫描

3. `winrt_stubs.c` — 实现：
   ```c
   HRESULT RoInitialize(RO_INIT_TYPE type) {
       // COM 已由 Tauri 初始化，返回 S_OK
       // 如果 type == RO_INIT_MULTITHREADED，返回 S_OK
       // 实际应用中这足够安全
       return S_OK;
   }
   
   void RoUninitialize(void) { /* no-op */ }
   
   HRESULT RoGetActivationFactory(HSTRING, REFIID, void**) {
       return REGDB_E_CLASSNOTREG;  // 0x80040154
   }
   ```

4. `exports.def`:
   ```
   EXPORTS
     WindowsCreateString
     WindowsCreateStringReference
     WindowsDeleteString
     WindowsDuplicateString
     WindowsGetStringLen
     WindowsGetStringRawBuffer
     WindowsIsStringEmpty
     WindowsStringHasEmbeddedNull
     WindowsCompareStringOrdinal
     WindowsConcatString
     WindowsSubstring
     WindowsSubstringWithSpecifiedLength
     WindowsReplaceString
     WindowsTrimStringStart
     WindowsTrimStringEnd
     WindowsPreallocateStringBuffer
     WindowsPromoteStringBuffer
     WindowsDeleteStringBuffer
     RoInitialize
     RoUninitialize
     RoGetActivationFactory
     RoActivateInstance
     RoGetApartmentIdentifier
   ```

5. `build.ps1` — 使用 MSVC 编译器：
   ```powershell
   # 定位 MSVC 工具链
   # cl.exe /LD /O2 *.c /Fe:api-ms-win-core-winrt-l1-1-0.dll /DEF:exports.def
   ```

**验证标准**:
- [ ] DLL 编译成功（0 errors）
- [ ] `dumpbin /exports` 确认所有函数已导出
- [ ] DLL 不依赖任何其他 Win8+ DLL

---

### T2: 追加 DELAYLOAD + 构建集成

**目标**: 在 build.rs 中追加 WinRT DLL 的 DELAYLOAD 声明。

**修改文件**:
- `src-tauri/build.rs` — 追加两行 `println!("cargo:rustc-link-arg=/DELAYLOAD:...")`

**注意**: 
- `DELAYLOAD` 的 DLL 名必须与 `windows-link` 中声明的完全一致
- 顺序不重要（链接器按 DLL 名匹配）
- 需要在现有的 `delayimp.lib` 之前已经链接（已满足）

**验证标准**:
- [ ] `cargo build --release --features win7-compat` 编译成功
- [ ] `dumpbin /imports` 确认 WinRT DLL 不在直接导入表中
- [ ] `dumpbin /delayload` 确认 DLL 在延迟加载表中

---

### T3: 条件禁用通知插件 (feature gate)

**目标**: Win7 构建时跳过 `tauri-plugin-notification` 注册。

**修改文件**:

1. `src-tauri/Cargo.toml` — 新增 feature：
   ```toml
   [features]
   win7-compat = []
   ```

2. `src-tauri/src/lib.rs` — 条件注册：
   ```rust
   // 找到 builder = builder.plugin(tauri_plugin_notification::init()); 这行
   // 改为条件编译：
   #[cfg(not(feature = "win7-compat"))]
   builder = builder.plugin(tauri_plugin_notification::init());
   ```
   
   ⚠️ **注意**：`tauri-plugin-notification` 依赖**保留**在 Cargo.toml 中（非 `cfg` 删除），因为 macOS/Linux 构建仍需要。仅在 Win7 Windows 构建时通过 feature 跳过 `.plugin()` 注册。这会导致：
   - Rust 编译器仍会编译该 crate（但不会链接其初始化代码）
   - 实际上由于该 crate 未被任何代码路径引用，LTO 会将其优化掉
   
   更彻底的方案（可选）：
   ```toml
   # Cargo.toml
   [target.'cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))'.dependencies]
   tauri-plugin-notification = "2"   # 保持不变
   ```
   然后 `win7-compat` feature 下用 `cfg` 跳过注册即可。

**验证标准**:
- [ ] `cargo check --features win7-compat` 成功
- [ ] `cargo check`（无 feature）仍成功，通知功能不受影响
- [ ] 标准构建 (master) 的通知功能正常

---

### T4: NSIS 打包集成 Shim DLL

**目标**: Shim DLL 正确装入安装目录，与 EXE 同目录。

**方案 A — externalBin** (推荐)：

在 `tauri.win7.conf.json` 中：
```json
{
  "bundle": {
    "externalBin": [
      "binaries/kb-mcp",
      "target/release/api-ms-win-core-winrt-l1-1-0.dll"
    ]
  }
}
```

`externalBin` 自动将文件拷贝到 EXE 同级目录。

**方案 B — beforeBundleCommand** (备选)：

在 `patch-win7-pe.mjs` 末尾追加：
```js
const shimSrc = join("src-tauri", "win7_winrt_shim", "api-ms-win-core-winrt-l1-1-0.dll");
const shimDst = join("src-tauri", "target", "release", "api-ms-win-core-winrt-l1-1-0.dll");
if (existsSync(shimSrc)) {
  copyFileSync(shimSrc, shimDst);
  console.log("[patch-win7-pe] shim DLL copied to release dir");
}
```

**推荐方案 A**，因为 externalBin 是 Tauri 官方机制，更可靠。

**需要注意**：
- 方案 A 要求 Shim DLL 在 `cargo build` 之前就存在于目标目录
- 构建流程需调整为：先构建 Shim → 拷贝到 target/release/ → 再 cargo build
- 实际上 `externalBin` 在 `tauri build`（打包阶段）才拷贝，`cargo build` 阶段不需要

**验证标准**:
- [ ] `pnpm build:win7` 完成后，安装包内包含 shim DLL
- [ ] 安装到 Win7 后，DLL 在 EXE 同级目录
- [ ] Win7 上启动不弹 DLL 缺失错误

---

### T5: PE 扫描验证增强

**目标**: 构建后自动检查 EXE 是否仍直接导入 WinRT DLL（非 DELAYLOAD）。

**修改文件**: `scripts/build-win7.mjs`

```js
const BLOCKING_IMPORTS = [
  "GetSystemTimePreciseAsFileTime",
  "api-ms-win-crt-private-l1-1-0.dll",
  // 新增
  "api-ms-win-core-winrt-l1-1-0.dll",
  "api-ms-win-core-winrt-string-l1-1-0.dll",
];
```

**注意**: DELAYLOAD 的 DLL 仍会在 PE 字符串表中出现（作为 Delay-Load Descriptor 的一部分），但不会在 IMAGE_IMPORT_DESCRIPTOR 数组中出现。`verifyWin7Imports` 目前的实现是简单字符串扫描，可能会误报 DELAYLOAD 的 DLL。需要改进检测逻辑：

```js
function verifyWin7Imports(exePath) {
  const text = readFileSync(exePath).toString("latin1");
  
  // 区分直接导入 vs 延迟加载
  // 简单方案：检查 DLL 名是否出现在 import 表区域（不含 delay-load 段）
  // 更精确方案：解析 PE 结构
  // 当前方案：如果 DLL 名在文件中只出现 1-2 次（仅在 delay-load 描述符中），
  //           则不算阻断。如果出现多次（在 import 表中），则报警。
  
  for (const name of BLOCKING_IMPORTS) {
    const count = text.split(name).length - 1;
    if (count > 2) {
      // 出现 > 2 次说明可能同时在 import 表和 delay-load 表中
      throw new Error(`...`);
    } else if (count > 0) {
      console.log(`[build-win7] ${name} 仅在 delay-load 表中 (${count}次)，安全`);
    }
  }
}
```

**验证标准**:
- [ ] 构建后扫描不再报 WinRT DLL 误报
- [ ] 如果某 DLL 意外出现在直接导入表中（非 DELAYLOAD），构建失败

---

### T6: 构建脚本全流程联调

**目标**: 确保 `pnpm build:win7` 全流程跑通。

**联调步骤**:

1. 清理环境：
   ```bash
   cd src-tauri && cargo clean
   ```

2. 构建 Shim DLL：
   ```powershell
   cd src-tauri/win7_winrt_shim && .\build.ps1
   ```

3. 运行完整构建：
   ```bash
   pnpm build:win7
   ```

4. 检查产物：
   ```bash
   # 确认 EXE 存在
   ls src-tauri/target/release/IntelligentNoteBook.exe
   
   # 确认 Shim DLL 在 EXE 同目录
   ls src-tauri/target/release/api-ms-win-core-winrt-l1-1-0.dll
   
   # 检查 PE 导入表
   dumpbin /imports src-tauri/target/release/IntelligentNoteBook.exe
   dumpbin /delayload src-tauri/target/release/IntelligentNoteBook.exe
   
   # 确认安装包存在
   ls src-tauri/target/release/bundle/nsis/知识库_Setup_*_win7_x64-setup.exe
   ```

**预期结果**:
- `dumpbin /imports` 不含 `api-ms-win-core-winrt-*`
- `dumpbin /delayload` 包含 `api-ms-win-core-winrt-l1-1-0.dll`
- 安装包正常生成

**验证标准**:
- [ ] `pnpm build:win7` 全流程无报错
- [ ] 安装包生成成功
- [ ] PE 导入表干净

---

### T7: Win7 真机验证

**目标**: 在 Windows 7 SP1 真机上验证修复效果。

**验证清单**:

| 测试项 | 预期结果 | 实际结果 |
|--------|---------|---------|
| 安装包正常安装 | ✅ | ⬜ |
| 启动不报 DLL 缺失 | ✅ | ⬜ |
| 主窗口正常显示 | ✅ | ⬜ |
| 笔记创建/编辑 | ✅ | ⬜ |
| Markdown 渲染 | ✅ (通过 @supports 降级) | ⬜ |
| 文件导入 (.md) | ✅ | ⬜ |
| AI 对话（如有配置） | ✅ | ⬜ |
| 系统通知 | ❌ 不弹（预期降级） | ⬜ |
| 长时间运行稳定性 | 无崩溃 | ⬜ |

**如果验证失败**：

| 症状 | 排查方向 |
|------|---------|
| 仍报 DLL 缺失 | 检查 Shim DLL 是否在 EXE 同目录；检查 DELAYLOAD 是否生效 |
| HSTRING 相关崩溃 | 检查内存布局是否与 `windows` crate 预期一致；加日志 |
| 通知功能异常 | 确认 feature 正确编译；检查应用日志 |
| WebView2 加载失败 | 检查 WebView2 109+ 预装状态；非 WinRT 问题 |

---

### T8: macOS/Linux 交叉构建验证

**目标**: 确保 `win7-compat` feature 不影响其他平台构建。

```bash
# macOS 编译检查
cargo check --target x86_64-apple-darwin

# Linux 编译检查  
cargo check --target x86_64-unknown-linux-gnu

# Windows 标准构建检查（无 feature）
cargo check --target x86_64-pc-windows-msvc

# Windows Win7 构建检查
cargo check --target x86_64-pc-windows-msvc --features win7-compat
```

**验证标准**:
- [ ] 所有目标 `cargo check` 成功
- [ ] macOS/Linux 构建不受 Shim DLL 影响（Shim DLL 仅 Windows 使用）
- [ ] 标准 Windows 构建（无 feature）不受影响

---

## 五、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| HSTRING 内存布局与 windows crate 不兼容 | 中 | 高 — WebView2 初始化崩溃 | 参考 windows crate 源码确认布局；Win7 真机优先验证 |
| DELAYLOAD 后仍有函数在 DllMain 期间调用 | 低 | 高 — 启动崩溃 | 添加 DllMain 钩子日志 |
| `windows-link` 声明了更多未发现的 WinRT DLL | 中 | 中 — 追加修复 | PE 导入扫描增强 |
| Shim DLL 签名问题（杀软拦截） | 低 | 低 — 无签名 DLL 可能被标记 | 如需签名，在构建流程中加入 |
| 上游 crate 更新引入新 WinRT 依赖 | 低 | 中 — 需持续监控 | PE 扫描作为门禁 |

---

## 六、与 DeepSeek TUI 方案的对比

| 维度 | DeepSeek TUI | W-NoteBook (本项目) |
|------|-------------|---------------------|
| 框架 | ratatui + crossterm (纯 CLI) | Tauri 2.x (WebView2 + 窗口) |
| `windows` crate | 已彻底移除（Phase 3，手写 raw FFI） | **深度依赖**（无法移除） |
| C stub 覆盖 | ✅ 有效（非 raw-dylib） | ❌ 无效（全部 raw-dylib） |
| PE 后处理 | 简单（2 个 API 替换） | 复杂（数十个 WinRT 函数） |
| 通知 | 无此需求 | 需条件禁用 |
| 最终方案 | C stubs + DELAYLOAD + PE patch | Shim DLL + DELAYLOAD + feature gate |

---

## 七、文件变更总览

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src-tauri/win7_winrt_shim/` | WinRT Shim DLL 项目（~500 行 C） |
| 修改 | `src-tauri/build.rs` | 追加 2 行 DELAYLOAD |
| 修改 | `src-tauri/Cargo.toml` | 新增 `win7-compat` feature |
| 修改 | `src-tauri/src/lib.rs` | 条件注册通知插件 |
| 修改 | `src-tauri/tauri.win7.conf.json` | 新增 `externalBin` 条目 |
| 修改 | `scripts/build-win7.mjs` | PE 扫描追加 WinRT DLL；集成 Shim DLL 构建步骤 |
| 修改 | `scripts/patch-win7-pe.mjs` | 拷贝 Shim DLL 到 target/release/ |
| 修改 | `docs/win7-build.md` | 更新构建文档 |

---

## 八、构建命令（最终目标）

```bash
# Win7 兼容版构建（一键）
pnpm build:win7

# 内部流程：
# 1. cd src-tauri/win7_winrt_shim && .\build.ps1      # 构建 Shim DLL
# 2. cargo build --release --features win7-compat       # Rust 编译
# 3. node scripts/patch-win7-pe.mjs                     # PE 补丁 + DLL 拷贝
# 4. tauri build --bundles nsis                         # NSIS 打包
# 5. node scripts/build-win7.mjs 后续步骤                # 扫描 + 重命名
```
