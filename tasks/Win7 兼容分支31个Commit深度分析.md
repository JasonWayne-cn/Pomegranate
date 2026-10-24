## Win7 兼容分支 31 个 Commit 深度分析

### 一、按影响域分类

#### 1. 第三方组件相关（5 个 commit）

| commit | 第三方 | 问题 | 解法 |
|--------|--------|------|------|
| `e4cf137` | **iana-time-zone** 0.1.65→0.1.45 | v0.1.53+ 通过 windows-core 间接引入 combase.dll 导入 | 降级版本切断依赖链 |
| `72d0245` | **getrandom** 0.2/0.3/0.4 | 默认调用 ProcessPrng (bcryptprimitives.dll, Win8+) | Cargo.toml feature `rdrand` + RUSTFLAGS cfg |
| `768266b` | **ring** crate | ProcessPrng 依赖 | C stub 转发到 RtlGenRandom (advapi32, XP+) |
| `215629f` | **parking_lot / Rust std** | WaitOnAddress 系列 (Win8+ futex) | bcryptprimitives shim DLL 提供 poll 版实现 |
| `72d0245` | **tauri-plugin-notification** | 依赖 WinRT API | win7-compat feature 跳过注册 |

**结论：所有第三方组件问题都已通过版本降级 / feature flag / stub 函数解决。**

#### 2. 编译/链接层（8 个 commit）

| commit | 文件 | 改动 |
|--------|------|------|
| `9fbc998` `2e49d14` | `.cargo/config.toml`, `build.rs` | PE 子系统版本 6.1 |
| `b882cfb` | `build.rs` | `/DELAYLOAD` + `/DELAYLOAD:delayimp.lib` |
| `254a63a` `9722dda` `3875506` | `build.rs` | bcryptprimitives/combase/synch/winrt DELAYLOAD |
| `910bc1a` | `build.rs` | `/FORCE:MULTIPLE` 解决符号冲突 |

**结论：纯编译参数，已全部集中在 `build.rs` 中，`#[cfg(target_os = "windows")]` 包裹。**

#### 3. Stub 函数（7 个 commit）

| commit | 文件 | 说明 |
|--------|------|------|
| `768266b` `9bad27a` `80d119f` `3875506` | `win7_stubs.c` (旧) | C 语言 stub，已被删除 |
| `910bc1a` | `win7_stubs.rs` (新) | Rust 重写，消除 cc 依赖 |
| `2bc11a7` | `win7_stubs.rs` | 补回缺失的 3 个 ole32 转发桩 |

**结论：已全部收敛到单个 `src/win7_stubs.rs`，通过 `#[cfg(target_os = "windows")]` 条件编译。**

#### 4. Shim DLL（3 个 commit）

| commit | 文件 | 说明 |
|--------|------|------|
| `215629f` | `win7_winrt_shim/` 全部源文件 | WinRT shim: api-ms-win-core-winrt-l1-1-0.dll |
| `215629f` | `win7_winrt_shim/bcrypt_stubs.c` | bcryptprimitives.dll shim |
| `929672a` | `win7_synch_shim/` 源文件 | synch shim: api-ms-win-core-synch-l1-2-0.dll |

**结论：需要 MSVC cl.exe 编译的独立 DLL，不能纯条件编译替代。但源码已入库。**

#### 5. PE 后处理补丁（3 个 commit）

| commit | 文件 | 说明 |
|--------|------|------|
| `ad29e1a` `bb02bab` | `scripts/patch-win7-pe.mjs` | PE 二进制补丁脚本 |
| `3875506` | patch-win7-pe.mjs | DLL 名重映射 synch→bcryptprimitives |
| `215629f` | patch-win7-pe.mjs | 多目标补丁 |

**结论：操作已编译的二进制文件，必须在 cargo build 后运行，不能用条件编译替代。**

#### 6. 构建流程（12 个 commit，大量迭代修复）

| commit | 影响 | 说明 |
|--------|------|------|
| `88e4759` `b164f9b` | build-win7.mjs | 双分支构建体系初始化 |
| `4754af1` `7c6cfad` `bfe24db` `28c848c` `bb02bab` | build-win7.mjs | NSIS 重建路径修正 |
| `fe2ae3e` `3670f15` `392fd98` `e46f9c3` | build-win7.mjs | 产物重命名/清理/log 路径 |

**结论：12 个 commit 中有 8 个是对同一个构建脚本的 bug 修复迭代，可 squash。**

#### 7. 配置/前端（3 个 commit）

| commit | 文件 | 改动 |
|--------|------|------|
| `80a3b8e` | `tauri.conf.json` | WebView2 Fixed Version 109 |
| `8757301` | `global.css` | Tailwind oklch→rgb（Chromium 109 不支持 oklch） |
| `51a35ec` | `lib.rs` `pdf.rs` | pdfium.dll 嵌入 EXE |

---

### 二、能否纳入条件编译？

```
┌─────────────────────────────────────────────────────────────┐
│  ✅ 已纳入 / 可纳入                                         │
├─────────────────────────────────────────────────────────────┤
│  win7_stubs.rs          #[cfg(target_os = "windows")]       │
│  build.rs DELAYLOAD     #[cfg(target_os = "windows")]       │
│  notification 注册       #[cfg(not(feature = "win7-compat"))]│
│  pdfium 嵌入            #[cfg(target_os = "windows")]       │
│  CSS oklch→rgb          已是无条件回退（Chromium 109 安全）  │
│  getrandom backend      Cargo.toml feature "rdrand"         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  ❌ 不可纳入条件编译（需要外部工具链/二进制操作）             │
├─────────────────────────────────────────────────────────────┤
│  PE 后处理补丁          cargo build 后修改 .exe 二进制       │
│  Shim DLL 编译          需要 MSVC cl.exe + link.exe         │
│  NSIS 安装器配置        需要 tauri.win7.conf.json           │
│  WebView2 FixedRuntime  安装器级资源捆绑                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  🔶 当前重复/可合并                                         │
├─────────────────────────────────────────────────────────────┤
│  tauri.conf.json       与 win7 版仅 3 处差异，可合并为模板    │
│  12 个构建脚本迭代      可 squash 为 2-3 个核心 commit       │
│  .cargo/config.toml    两处 RUSTFLAGS 目标可统一             │
└─────────────────────────────────────────────────────────────┘
```

### 三、建议的精简方案

**可 squash 的 commit（12 个构建迭代）**：`88e4759` 到 `3670f15` 的构建脚本修复可合并为 1-2 个 commit，它们都是对 `scripts/build-win7.mjs` 的 bug 修复和路径修正，没有独立价值。

**可合并的配置文件**：`tauri.conf.json` 和 `tauri.win7.conf.json` 差异仅 3 处（`beforeBundleCommand`、`resources`、`productName`），可用环境变量或构建参数替代。

**必须保留的独立 commit**：
- Stub 函数核心实现（`win7_stubs.rs`）
- Shim DLL 源码（`win7_winrt_shim/`、`win7_synch_shim/`）
- PE 补丁脚本（`patch-win7-pe.mjs`）
- 第三方依赖调整（iana-time-zone 降级、getrandom backend）
- CSS 兼容修复



---
关键结论是：**CSS 改动用 `@supports` 特征检测，现代浏览器零开销，安全合并到 master。**
## 推荐方案：将 win7-compat 直接合并到 master

### 为什么可行

Win7 兼容代码全部是 **基础设施层叠加**，不影响 Win10+ 正常构建：

```
master 上的 Win7 兼容代码分布：
┌──────────────────────────────────────────────────┐
│ 编译期（条件编译，Win10+ 无影响）                  │
├──────────────────────────────────────────────────┤
│ src/win7_stubs.rs   #[cfg(target_os="windows")]   │
│ build.rs DELAYLOAD  #[cfg(target_os="windows")]   │
│ notification 跳过   #[cfg(not(win7-compat))]      │
│ pdfium 嵌入         #[cfg(target_os="windows")]   │
│ getrandom rdrand    Cargo feature "rdrand"        │
├──────────────────────────────────────────────────┤
│ 运行时（特征检测，Win10+ 无开销）                   │
├──────────────────────────────────────────────────┤
│ global.css          @supports not ((oklch)...)    │
│ win7_stubs.rs       运行时 LoadLibrary 转发        │
├──────────────────────────────────────────────────┤
│ 构建时（仅显式调用 pnpm build:win7 时激活）         │
├──────────────────────────────────────────────────┤
│ patch-win7-pe.mjs   beforeBundleCommand 钩子      │
│ build-win7.mjs      专属构建脚本                   │
│ shim DLL 编译       需要 MSVC cl.exe              │
│ tauri.win7.conf.json 自动切换→恢复                 │
└──────────────────────────────────────────────────┘
```

### 合并后的工作流

```
master
  │
  ├─ 日常开发功能 ──────────→ 正常 pnpm tauri dev / build
  │
  ├─ 需要 Win7 安装包时 ───→ pnpm build:win7
  │                            (自动切换配置 → 构建 → PE补丁 → 恢复配置)
  │
  └─ 发布版本 ─────────────→ /release（CI 构建三平台）
                              + pnpm build:win7（手动 Win7 包）
```

### 合并操作

```bash
git checkout master
git merge feature/win7-compat
# 31 个 commit 作为独立历史进入 master
```

合并后 `feature/win7-compat` 分支可删除。后续所有开发（功能/Win7）都在 master 上进行。
合并完成。

```
master: d4513e8  merge commit
       ├── 来自 feature/win7-compat 的 31 个 Win7 兼容 commit
       └── 1936c52  移除废弃 win7_stubs.c
```

已推送到 Gitee（`origin/master`）。后续 workflow：

```
master 分支
  ├─ 开发功能          → 正常开发，Win7 基础设施已内置
  ├─ 打包 Win7 安装包  → pnpm build:win7
  └─ 发布版本          → /release（CI 三平台）+ 手动 Win7 包
```