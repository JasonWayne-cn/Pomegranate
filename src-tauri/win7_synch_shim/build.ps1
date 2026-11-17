#!/usr/bin/env powershell
# Build win7synch.dll — api-ms-win-core-synch-l1-2-0.dll shim for Windows 7.
#
# 命名为 win7synch.dll 而非系统 API Set 名：
#   - 避免与 KnownDLLs / API Set 解析规则冲突；
#   - PE 补丁在构建期把导入表中的 api-ms-win-core-synch-l1-2-0.dll 重映射到此文件名。
# Requires MSVC cl.exe in PATH (from vcvars64.bat or similar)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutputDir = Join-Path $ScriptDir "..\binaries"
$SrcFile = Join-Path $ScriptDir "api-ms-win-core-synch-l1-2-0.c"
$DefFile = Join-Path $ScriptDir "exports.def"
$OutDll = Join-Path $OutputDir "win7synch.dll"

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

Write-Host "[synch-shim] Building win7synch.dll..."

# Compile: /LD = DLL, /O2 = optimize, /GS- = no security cookie (smaller), /MT = static CRT
# kernel32.lib 用于解析 .def 中的导出转发（InitOnce*/SRWLock/ConditionVariable）
# 不用 /NODEFAULTLIB:libcmt.lib：需要 CRT 提供 _DllMainCRTStartup 入口
$cmd = "cl /nologo /LD /O2 /GS- /MT /Fe:`"$OutDll`" `"$SrcFile`" /link /DEF:`"$DefFile`" kernel32.lib"
Write-Host "[synch-shim] $cmd"
Invoke-Expression $cmd

if ($LASTEXITCODE -ne 0) {
    Write-Error "[synch-shim] Build FAILED"
    exit 1
}

if (Test-Path $OutDll) {
    $size = (Get-Item $OutDll).Length
    Write-Host "[synch-shim] Built: $OutDll ($($size) bytes)"
} else {
    Write-Error "[synch-shim] DLL not found at expected path"
    exit 1
}
