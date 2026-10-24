## 结论

是的，**现在应进入 B 方案**。

原因很明确：

1. 已尝试 `rdrand`
2. 已尝试 `windows_legacy`
3. 主程序里仍然扫描到：

```text
ProcessPrng FOUND
bcryptprimitives.dll FOUND
```

说明 `ProcessPrng` 不是单纯由 `getrandom_backend` 主路径控制，或者至少有其他依赖链/系统库导入仍然硬引用了：

```text
bcryptprimitives.dll!ProcessPrng
```

Win7 系统自带的 `bcryptprimitives.dll` 没有这个导出，所以只要 EXE 导入表里有它，就会在加载阶段失败。

---

# B 方案目标

让 Win7 加载器不要去调用系统自带的：

```text
C:\Windows\System32\bcryptprimitives.dll
```

而是优先加载应用目录下的 shim：

```text
安装目录\bcryptprimitives.dll
```

该 shim 导出：

```text
ProcessPrng
```

内部转发到 Win7 可用的：

```text
advapi32.dll!SystemFunction036
```

也就是 `RtlGenRandom`。

---

# B 方案开发任务

## 任务 1：确认当前 shim 是否有效

### 目标

确认当前已有文件是否真的可用：

```text
src-tauri/binaries/bcryptprimitives.dll
src-tauri/win7_winrt_shim/bcrypt_stubs.c
src-tauri/win7_winrt_shim/bcrypt_exports.def
```

### 检查项

- `bcryptprimitives.dll` 是否真实存在
- 是否导出 `ProcessPrng`
- 是否依赖 Win8+ DLL
- 是否为 x64
- 是否使用正确调用约定

### 验收标准

```text
bcryptprimitives.dll 存在
导出 ProcessPrng
不导入 api-ms-win-* / Win8+ DLL
```

---

## 任务 2：停止把 DLL 当 externalBin 处理

### 当前问题

`externalBin` 适合 sidecar `.exe`，不适合系统 DLL 替换。

如果把：

```json
"binaries/bcryptprimitives.dll"
```

作为 `externalBin`，Tauri 可能会查找或打包成类似：

```text
bcryptprimitives.dll-x86_64-pc-windows-msvc.exe
```

这对 Windows DLL 加载器无效。

### 修改方向

不要依赖 `externalBin` 安装 DLL。

应改为：

```json
"resources": [
  "resources/pdfium/*",
  "binaries/bcryptprimitives.dll"
]
```

或者通过 NSIS hook 明确复制到：

```text
$INSTDIR\bcryptprimitives.dll
```

### 推荐

使用 **NSIS hook 明确复制**，最可靠。

---

## 任务 3：让安装包把 shim 放到 EXE 同目录

### 目标路径

安装后必须有：

```text
安装目录\
├── IntelligentNoteBook.exe
├── bcryptprimitives.dll   ← 必须在这里
└── ...
```

Windows DLL 搜索顺序中，应用目录优先于 System32。

### 实现方式

在 `installer-hooks.nsi` 中增加：

```nsi
File "/oname=$INSTDIR\bcryptprimitives.dll" "路径\to\bcryptprimitives.dll"
```

但 NSIS 中源文件路径需要与 Tauri 生成的 `.nsi` 相对路径匹配。

更稳妥做法：

1. 在 `tauri.win7.conf.json` 的 `resources` 中包含 DLL
2. 构建后确认资源是否进入 `$INSTDIR`
3. 如未进入，再用 NSIS hook 手动复制

### 验收标准

安装后 Win7 机器安装目录中存在：

```text
bcryptprimitives.dll
```

---

## 任务 4：扩展构建脚本扫描安装包内容

### 当前问题

我们只扫描了：

```text
target/release/IntelligentNoteBook.exe
```

但 Win7 实际运行的是安装包解压后的文件。

### 修改方向

`build-win7.mjs` 增加最终产物检查：

- 检查 `bundle/nsis/*.exe` 是否为最新 Win7 包
- 检查 `target/release/IntelligentNoteBook.exe` 不含：
  - `GetSystemTimePreciseAsFileTime`
- 检查 shim 存在：
  - `src-tauri/binaries/bcryptprimitives.dll`
- 输出明确提示：

```text
[build-win7] bcryptprimitives.dll shim: OK
[build-win7] 安装后应位于 EXE 同目录
```

---

## 任务 5：保留 `windows_legacy`，但不再视为最终解决方案

### 原因

虽然 `windows_legacy` 没有清除 `ProcessPrng`，但它仍然可能减少一部分新依赖路径。

建议保留：

```text
getrandom_backend="windows_legacy"
```

同时用 B 方案 shim 解决最终加载问题。

---

## 任务 6：Win7 实机验证

### 验证步骤

1. 卸载旧版本
2. 删除旧安装目录
3. 删除旧桌面快捷方式
4. 安装新包
5. 检查安装目录：

```text
bcryptprimitives.dll
log.txt
IntelligentNoteBook.exe
```

6. 启动应用
7. 如果仍失败，记录：
   - 弹窗错误
   - 安装目录文件列表
   - `log.txt`

### 验收标准

- 不再出现：

```text
无法定位程序输入点 ProcessPrng 于动态链接库 bcryptprimitives.dll 上
```

- 应用窗口能打开
- 运行目录生成：

```text
log.txt
```

---

# 推荐执行顺序

```text
1. 检查 bcryptprimitives.dll 是否正确导出 ProcessPrng
2. 修改 tauri.win7.conf.json / installer-hooks.nsi，确保 DLL 安装到 EXE 同目录
3. 修改 build-win7.mjs，增加 shim 检查
4. 重新构建 Win7 包
5. 手动检查安装包 / 安装目录
6. Win7 实机验证
```

---

# 风险点

| 风险 | 说明 |
|---|---|
| shim 没有被放到 EXE 同目录 | Win7 仍加载 System32 的 bcryptprimitives.dll，继续失败 |
| shim 导出签名不一致 | 可能启动后崩溃 |
| EXE 还有其它 Win8+ API | 会进入下一个入口点缺失错误 |
| WebView2 109 缺失 | EXE 可启动但窗口打不开 |

---

## 最终判断

不是继续调 `getrandom_backend` 的问题了。

现在真正要做的是：

```text
确保应用目录存在可用的 bcryptprimitives.dll shim
```

这就是 B 方案。