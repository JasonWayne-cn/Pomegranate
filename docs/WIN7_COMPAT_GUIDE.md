# Windows 7 兼容构建指南

> 完整架构与决策记录见 [win7-architecture.md](./win7-architecture.md)。

## 快速开始

```bash
# lite + full 双产物（默认）
pnpm build:win7

# 仅轻量版（不捆绑 WebView2，需目标机预装 109+）
pnpm build:win7 --variant lite

# 仅完整版（内置 WebView2 109 Fixed Runtime）
pnpm build:win7 --variant full

# debug 构建 / 强制重建 shim
pnpm build:win7:debug
pnpm build:win7 --force-shim
```

产物：

```
src-tauri/target/release/bundle/nsis/
  Pomegranate_Setup_<ver>_win7_lite_x64-setup.exe
  Pomegranate_Setup_<ver>_win7_full_x64-setup.exe
```

## 构建流程

```
shim DLL（win7rt / win7synch / WinRT）
  → kb-mcp sidecar（win7-compat）
  → tauri build --features win7-compat
      beforeBundleCommand:
        patch-win7-pe.mjs      # 结构化 PE 补丁
        check-win7-imports.mjs # 导入门禁（失败即中止）
  → NSIS 产物重命名
```

## 适用系统

**Windows 7 SP1 x64**，另需：

- KB2533623、KB4474419
- KB2999226 / VC++ 2015-2022 Redistributable（UCRT）
- lite 版：WebView2 Fixed Runtime 109+

## 验证

构建期自动：

```bash
# 只跑补丁（干跑）
node scripts/patch-win7-pe.mjs --dry-run --verbose

# 只跑门禁
node scripts/check-win7-imports.mjs --verbose

# 可选：对照 Win7 SP1 System32 导出表
node scripts/check-win7-imports.mjs --baseline "D:\win7-sp1\System32"
```

Win7 实机冒烟：

```bash
node scripts/win7-smoke.mjs --app "C:\Program Files\Pomegranate\Pomegranate.exe" ^
  --sidecar "C:\Program Files\Pomegranate\kb-mcp.exe"
```

## 常见启动错误

| 错误 | 原因 | 处理 |
|------|------|------|
| 无法定位程序输入点 `GetSystemTimePreciseAsFileTime` | PE 补丁未执行 | 检查 beforeBundleCommand 与补丁输出 |
| 无法定位程序输入点 `EventSetInformation` | 旧包或 stub 未链接 | 用 `--features win7-compat` 重新构建 |
| 计算机中丢失 `win7synch.dll` / `win7rt.dll` | shim 未随包或未复制到 EXE 目录 | 检查 resources 与 NSIS POSTINSTALL |
| 计算机中丢失 `bcryptprimitives.dll` | 旧安装包残留 | 重新构建；新架构已重映射到 `win7rt.dll` |
| 启动即退出、无提示 | 缺少 WebView2（lite） | 安装 WebView2 109+ 或改用 full |
| 提示缺少 `api-ms-win-crt-*` | 未安装 UCRT/VC++ Redist | 安装 KB2999226 / VC++ 2015-2022 |

## 关键文件

| 文件 | 作用 |
|------|------|
| `src-tauri/win7-shims/` | 主应用与 kb-mcp 共享的 Rust stub |
| `src-tauri/win7_winrt_shim/` | WinRT shim + `win7rt.dll` |
| `src-tauri/win7_synch_shim/` | `win7synch.dll` |
| `scripts/build-win7.mjs` | 双产物构建流水线 |
| `scripts/patch-win7-pe.mjs` | 结构化 PE 补丁 |
| `scripts/check-win7-imports.mjs` | 导入门禁 |
| `src-tauri/tauri.win7.conf.json` | lite 构建配置 |
| `src-tauri/tauri.win7.full.conf.json` | full 构建配置 |
