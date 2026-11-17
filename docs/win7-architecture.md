# Windows 7 兼容技术架构

> 状态：已实施
> 适用范围：Tauri 2.x 桌面端 + kb-mcp sidecar
> 参考实现：`D:\Agent\dsh-win7`（Electron 版验证过的导入表改写 / 全量转发 shim / 基线门禁方法论）

## 1. 目标

- **一套源码**，同时产出 Win7 与 Win10/11 安装包
- **现代系统零影响**：兼容层仅在 `win7-compat` feature 下参与编译与链接
- **可验证**：每一层都有对应的构建门禁，而不是"理论上应该能跑"
- **可维护**：shim、stub 与补丁逻辑单一来源，新增 Win8+ 依赖时构建会失败而不是静默损坏

## 2. 产物矩阵

| 产物 | WebView2 | 典型体积 | 适用场景 |
|------|----------|---------|---------|
| `Pomegranate_Setup_<ver>_win7_lite_x64-setup.exe` | 系统预装 109+ | ~63 MB（实测） | 已部署运行时的 Win7 机房/企业环境 |
| `Pomegranate_Setup_<ver>_win7_full_x64-setup.exe` | 内置 Fixed Runtime 109 | ~210 MB（实测） | 干净 Win7 SP1，开箱即用 |
| Win10/11 安装包 | Evergreen 自动下载 | ~6 MB | 现代系统，行为与兼容层完全隔离 |

lite/full 使用同一份二进制，仅 WebView2 分发方式不同。

## 3. 分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│ L5 门禁      check-win7-imports.mjs                              │
│              静态/延迟导入黑名单 + shim 导出覆盖 + 可选 Win7 基线   │
├──────────────────────────────────────────────────────────────────┤
│ L4 后处理    patch-win7-pe.mjs（结构化 PE 解析）                   │
│              导入描述符改名 / raw-dylib 函数替换 / bound import 清理│
├──────────────────────────────────────────────────────────────────┤
│ L3 加载期    win7rt.dll / win7synch.dll / api-ms-win-core-winrt-* │
│              非 KnownDLL 命名 + 完整转发 + 本地实现                │
├──────────────────────────────────────────────────────────────────┤
│ L2 链接期    win7-shims crate（主应用与 kb-mcp 共用）              │
│              stub + __imp_ ALTERNATENAME + FORCE:MULTIPLE + DELAYLOAD│
├──────────────────────────────────────────────────────────────────┤
│ L1 编译期    win7-compat feature + getrandom windows_legacy        │
│              notification 插件条件注册 + Vite es2020               │
└──────────────────────────────────────────────────────────────────┘
```

### L1 编译期

- `[features] win7-compat`：主应用与 `kb-mcp` 各自定义，启用共享 stub crate
- `build.rs` 的 DELAYLOAD / `__imp_` ALTERNATENAME / `/FORCE:MULTIPLE` / 子系统 6.01 **仅在 feature 启用时**生效；Win10/11 构建保持 Tauri 默认链接行为
- `getrandom` 0.3/0.4 通过 `--cfg getrandom_backend="windows_legacy"` 固定使用 `RtlGenRandom`（advapi32，XP+），不使用 RDRAND（老 CPU 风险）
- `tauri-plugin-notification` 在 Win7 构建中跳过注册（消除 WinRT 依赖链）
- 前端 `vite target = es2020`，CSS 使用 `@supports` 回退 oklch/color-mix

### L2 链接期

`src-tauri/win7-shims/` 是共享源码，通过 `#[path = "..."]` **内联编译进 bin 目标**
（`src/main.rs` 与 `mcp/src/main.rs`）：

- `src/lib.rs`：stub 函数实现
- `src/imp.rs`：`__imp_<func>` IAT 覆盖符号（仅 bin）
- `link_args.rs`：DELAYLOAD / FORCE:MULTIPLE / EventSetInformation 直接调用映射

`__imp_` 是保留名，**不能**编译进 lib/cdylib（否则 `.exp` 生成器报 LNK1106）；
放在 bin 中由 `/FORCE:MULTIPLE` 覆盖系统导入库定义，导入表项才会真正消失。

| 类别 | stub |
|------|------|
| 同步 | `WaitOnAddress`、`WakeByAddressSingle/All`、`RtlWaitOnAddress`、`RtlWakeAddressSingle/All` |
| COM | `CoIncrementMTAUsage`、`CoTaskMemAlloc/Free`、`CoCreateFreeThreadedMarshaler`、`RoGetAgileReference` |
| 随机数 | `ProcessPrng` → `SystemFunction036` |
| 时间/内存/线程 | `GetSystemTimePreciseAsFileTime`、`DiscardVirtualMemory`、`GetCurrentThreadStackLimits`、`Get/SetThreadDescription` |
| ETW | `EventSetInformation` |

运行时策略：**Win8+ 转发真实实现，Win7 安全回退**（Sleep 轮询 / RtlGenRandom / no-op）。

Rust x64 通过 `__imp_<func>` IAT 槽位间接调用导入函数，仅定义同名函数不足以消除导入。
因此 `win7-shims/link_args.rs` 用 `/ALTERNATENAME:__imp_<func>=win7_imp_<func>`
把 IAT 引用重定向到 crate 内导出的函数指针静态变量；`force_link()` 引用全部符号，
防止 LTO/GC 丢弃；`/FORCE:MULTIPLE` 解决其余 rlib 符号冲突。主应用与 kb-mcp 共用该文件。

### L3 加载期（shim DLL）

| 文件 | 替代 | 关键导出 |
|------|------|---------|
| `win7rt.dll` | `bcryptprimitives.dll` | `ProcessPrng`、`WaitOnAddress`、`WakeByAddress*` |
| `win7synch.dll` | `api-ms-win-core-synch-l1-2-0.dll` | 本地 `WaitOnAddress`/`Wake*`/`Sleep*`，其余 `InitOnce*`/SRWLock/ConditionVariable 转发 `kernel32` |
| `api-ms-win-core-winrt-l1-1-0.dll` | WinRT API Set（含 string/error 子集） | HSTRING 全套、`RoInitialize`、`RoGetActivationFactory`、`RoOriginateErrorW` 等 |

**命名原则**：绝不使用系统已知 DLL 名（`bcryptprimitives.dll`、`kernel32.dll` 等）。`win7rt.dll` / `win7synch.dll` 由 PE 补丁把导入表重映射过去，Windows 加载器按应用目录优先加载。

### L4 后处理（PE 补丁）

`scripts/patch-win7-pe.mjs` 按 PE 结构工作（`scripts/lib/pe.mjs` 共享解析器）：

1. 子系统版本 → 6.1；release 主程序 CONSOLE → GUI
2. 静态 + 延迟导入描述符：DLL 名原地重映射（NUL 填充，长度不得增加）
3. 导入名表：函数名原地替换（`GetSystemTimePreciseAsFileTime`、`CoIncrementMTAUsage`、`RoGetAgileReference`）
4. 清空 Bound Import 目录
5. 自动发现 release/debug 主程序与 `binaries/*.exe`（包括 kb-mcp sidecar）
6. 幂等；失败非零退出

重映射表：

| 原 DLL | 目标 |
|--------|------|
| `api-ms-win-core-synch-l1-2-0.dll` | `win7synch.dll` |
| `bcryptprimitives.dll` | `win7rt.dll` |
| `api-ms-win-core-winrt-string-l1-1-0.dll` | `api-ms-win-core-winrt-l1-1-0.dll` |
| `api-ms-win-core-winrt-error-l1-1-0.dll` | `api-ms-win-core-winrt-l1-1-0.dll` |
| `combase.dll` | `ole32.dll` |

### L5 门禁

`scripts/check-win7-imports.mjs` 在 NSIS 打包前运行，失败即中止：

- 未重映射的 Win8+ DLL（synch / bcryptprimitives / combase / winrt-string / winrt-error / crt-private）
- Win8+ 函数仍以导入形式存在（GST、ProcessPrng、WaitOnAddress、EventSetInformation 等）
- 本地 shim 缺失、名字撞 KnownDLLs、未导出被引用函数
- 可选 `--baseline <Win7 System32>`：对照 Win7 SP1 导出表校验其余静态导入

## 4. 关键决策

### ADR-1：shim 使用非系统名（替代 KnownDLLs 规避）

- **背景**：自制 `bcryptprimitives.dll` 放在 EXE 同目录时，加载器可能因 KnownDLLs / 系统解析规则忽略它
- **决策**：输出 `win7rt.dll` / `win7synch.dll`，由 PE 重映射连接
- **影响**：安装器、resources、NSIS、门禁需同步

### ADR-2：stub 以源码内联共享

- **背景**：主应用与 kb-mcp 都是 Rust 进程，都会静态导入 GST / WaitOnAddress / ProcessPrng；
  独立 rlib 在 debug 的 CGU 分区下可能不被链接器拉入
- **决策**：stub 与 `__imp_*` 覆盖符号通过 `#[path]` 内联到两个 **bin** crate；
  lib/cdylib 不包含 `__imp_` 定义
- **影响**：避免双份维护；kb-mcp 子系统保持 CONSOLE；`__imp_` 不进 cdylib 以规避 LNK1106

### ADR-3：结构化 PE 补丁，不做全文件字符串替换

- **背景**：字符串替换会误改调试符号/资源，且无法清理 bound import
- **决策**：解析 DOS/NT/section/data directory，只改导入表字符串
- **影响**：补丁可幂等、可报告、可门禁

### ADR-4：双产物（lite + full）

- **背景**：Win7 用户环境差异大：一部分已装 WebView2 109，一部分是干净系统
- **决策**：lite 保持 `webviewInstallMode: skip`；full 使用 `fixedRuntime`
- **影响**：构建时间与分发体积增加；`build:win7 --variant lite|full|both`

### ADR-5：sidecar 纳入同一构建与补丁链

- **背景**：`externalBin` 的 kb-mcp 不经过主应用 build.rs
- **决策**：`cargo build -p kb-mcp --features win7-compat` → 复制到 binaries → 同一 PE 补丁与门禁
- **影响**：sidecar 的 CONSOLE 子系统保持 6.01

## 5. 构建流程

```
pnpm build:win7 [--variant lite|full|both] [--debug] [--force-shim]
  1. 构建/校验 shim DLL（按源文件 mtime 增量）
  2. 构建 kb-mcp sidecar（win7-compat）
  3. 逐 variant：
     切换 tauri.win7[.full].conf.json → tauri.conf.json
     tauri build --bundles nsis --features win7-compat
       beforeBundleCommand:
         patch-win7-pe.mjs → check-win7-imports.mjs
     校验新产物 mtime → 重命名
  4. finally 恢复 tauri.conf.json
```

产物命名：

```
src-tauri/target/release/bundle/nsis/
  Pomegranate_Setup_2.1.0_win7_lite_x64-setup.exe
  Pomegranate_Setup_2.1.0_win7_full_x64-setup.exe
```

## 6. 平台先决条件

**Win7 SP1 x64**：

- KB2533623（`SetDefaultDllDirectories` 等，部分依赖）
- KB4474419（SHA-2 签名支持，部分系统 DLL 更新依赖）
- KB2999226 / VC++ 2015-2022 Redistributable（UCRT：`api-ms-win-crt-*`）
- lite 安装包另需 WebView2 Fixed Runtime 109+

## 7. 验证清单

构建期自动：

- [x] `cargo check --features win7-compat`（主应用 + kb-mcp）
- [x] PE 补丁报告：DLL/函数重映射计数
- [x] 导入门禁：黑名单 + shim 覆盖
- [x] lite / full NSIS 产物生成（63 MB / 210 MB），打包前门禁 PASS
- [ ] CI 可选：`check-win7-imports.mjs --baseline <win7-system32>`

Win7 实机/虚拟机：

- [ ] 双击启动无 DLL 缺失弹窗
- [ ] 主窗口渲染（标题栏、拖拽区、最小化/最大化/关闭）
- [ ] 新建/保存笔记，SQLite 读写
- [ ] 全文搜索、PDF 导入（pdfium）
- [ ] AI 对话（HTTP + rustls）
- [ ] kb-mcp sidecar 启动（设置页 MCP 状态）
- [ ] 安装/卸载，shim DLL 清理
- [ ] lite 无 WebView2 时给出明确提示；full 开箱可用

## 8. 故障排查

| 现象 | 根因 | 处理 |
|------|------|------|
| "无法定位程序输入点 GetSystemTimePreciseAsFileTime" | 补丁未执行/目标发现失败 | 检查 `patch-win7-pe.mjs` 报告与 beforeBundleCommand |
| "无法定位程序输入点 EventSetInformation" | stub 未链接 | 确认 `--features win7-compat` 且 `__imp_` ALTERNATENAME 生效 |
| "计算机中丢失 win7synch.dll" | shim 未随包/未复制到 EXE 目录 | 检查 resources、NSIS POSTINSTALL |
| "计算机中丢失 bcryptprimitives.dll" | 旧安装包残留 | 重新构建，确认导入已重映射到 win7rt.dll |
| shim 存在但不生效 | 撞 KnownDLLs / 未重映射 | 门禁应阻断；检查 shim 文件名与导入表 |
| 多线程死锁/CPU 偏高 | WaitOnAddress 轮询回退 | 预期现象；Win8+ 自动转发真实实现 |
| 安装包 >500MB | 未跳过 Evergreen WebView2 | lite 使用 `skip`，full 使用 fixedRuntime |
| kb-mcp 启动失败 | sidecar 未打补丁 | 检查 `binaries/kb-mcp-*.exe` 的门禁结果 |

## 9. 与 dsh-win7 的对应关系

| dsh-win7 | 本项目 |
|----------|--------|
| `patch-imports.ps1`（导入描述符原地改名 + 清 bound import） | `patch-win7-pe.mjs` + `lib/pe.mjs` |
| `gen-forward-def.ps1`（按 dumpbin 导入生成全量转发 def） | shim `.def` 静态维护 + 门禁校验导出覆盖 |
| `check-win7-rtm-imports.ps1`（Win7 SP1 wim 基线） | `check-win7-imports.mjs --baseline`（可选） |
| 短名 shim（dshw7/dshlo/dsho）规避 KnownDLLs | `win7rt.dll` / `win7synch.dll` |
| overlay SHA-256 锁定 | 暂未引入（sidecar 由同一 cargo 构建） |

## 10. 文件索引

| 文件 | 作用 |
|------|------|
| `src-tauri/win7-shims/` | 共享 Rust stub 源码、链接参数与 `.def` |
| `src-tauri/win7_winrt_shim/` | WinRT shim（HSTRING / Ro* / win7rt.dll） |
| `src-tauri/win7_synch_shim/` | win7synch.dll |
| `src-tauri/build.rs` | feature gate + DELAYLOAD + ALTERNATENAME |
| `src-tauri/mcp/build.rs` | sidecar 链接参数 |
| `src-tauri/tauri.win7.conf.json` | lite 配置 |
| `src-tauri/tauri.win7.full.conf.json` | full 配置（fixedRuntime） |
| `src-tauri/installer-hooks.nsi` | OS/WebView2 检测、shim 部署与清理 |
| `scripts/build-win7.mjs` | 双产物构建流水线 |
| `scripts/patch-win7-pe.mjs` | 结构化 PE 补丁 |
| `scripts/check-win7-imports.mjs` | 导入门禁 |
| `scripts/win7-before-bundle.mjs` | beforeBundleCommand 统一入口 |
| `scripts/lib/pe.mjs` | PE 解析共享库 |
| `scripts/win7-smoke.mjs` | Win7 冒烟测试（实机运行） |
