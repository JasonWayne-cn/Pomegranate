# Windows 7 兼容性构建指南

## 问题描述

应用在 Windows 7 上启动失败，错误信息：
```
无法定位程序输入点 GetSystemTimePreciseAsFileTime 于动态链接库 kernel32.dll 上。
```

## 已实现的解决方案

### 1. `win7_stubs.rs` - Win7 兼容性存根函数

提供以下 Win8+ API 的存根实现：
- `GetSystemTimePreciseAsFileTime` → 转发到 `GetSystemTimeAsFileTime`
- `WakeByAddressSingle` / `WakeByAddressAll` / `WaitOnAddress`
- `CoIncrementMTAUsage` / `CoTaskMemAlloc` / `CoTaskMemFree` / `CoCreateFreeThreadedMarshaler`
- `ProcessPrng` → 转发到 `SystemFunction036` (advapi32.dll)

### 2. `build.rs` - 链接器配置

- 添加 `kernel32.dll` 的延迟加载
- 使用 `.def` 文件强制导出存根函数
- 使用 `/FORCE:MULTIPLE` 解决符号冲突

### 3. `win7_stubs.def` - 模块定义文件

显式导出所有存根函数

## 如何构建 Win7 兼容版本

### 使用 cargo 命令

```bash
# 进入 src-tauri 目录
cd src-tauri

# 使用 win7-compat feature 构建
cargo build --release --features win7-compat

# 或者使用 pnpm 构建整个应用
cd ..
pnpm tauri build -- --features win7-compat
```

### 构建产物

构建完成后，可执行文件位于：
`src-tauri/target/release/intelligent_notebook.exe`

## 验证兼容性

### 使用 Dependency Walker 检查

1. 下载 Dependency Walker (depends.exe)
2. 打开生成的 .exe 文件
3. 检查导入表中是否还有 `GetSystemTimePreciseAsFileTime`
4. 确认所有 Win8+ DLL 都是延迟加载

### 在 Win7 实机/虚拟机测试

1. 将可执行文件复制到 Win7 系统
2. 双击运行
3. 确认应用正常启动

## 技术细节

### GetSystemTimePreciseAsFileTime 的问题

这个 API 在 Win8+ 的 kernel32.dll 中提供，但 Win7 没有。

我们的解决方案：
1. 延迟加载 kernel32.dll
2. 提供我们自己的 `GetSystemTimePreciseAsFileTime` 实现
3. 运行时检查：
   - Win8+：转发到真实的 API
   - Win7：回退到 `GetSystemTimeAsFileTime`

### 延迟加载机制

`/DELAYLOAD` 链接器标志告诉 Windows：
- 启动时不立即加载 DLL
- 第一次调用 DLL 中的函数时才加载
- 这样我们的 stub 可以有机会介入

### 符号冲突解决

windows crate 会自动导入这些函数。我们用 `/FORCE:MULTIPLE` 和 `.def` 文件确保我们的 stub 覆盖默认导入。
