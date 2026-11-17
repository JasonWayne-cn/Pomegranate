; ============================================================================
; 自定义 NSIS 安装钩子
; 目的：productName="Pomegranate" 保持英文避免 GitHub Release Asset URL 编码问题，
;       同时让用户桌面/开始菜单的快捷方式保持一致名称。
;
; 编码必须为 UTF-8 with BOM，否则 NSIS 编译器无法正确识别中文字面量。
; ============================================================================

!include "WinVer.nsh"

!macro NSIS_HOOK_PREINSTALL
  ; ─── 操作系统版本检测 ─────────────────────
  ${If} ${IsWin7}
  ${AndIfNot} ${AtLeastServicePack} 1
    MessageBox MB_OK|MB_ICONSTOP \
      "检测到您的系统为 Windows 7，但未安装 Service Pack 1。$\n$\n\
       本应用要求 Windows 7 SP1 或更高版本。$\n$\n\
       请先安装 Windows 7 Service Pack 1 后再运行本安装程序。"
    Quit
  ${EndIf}

  ; ─── WebView2 运行时检测 ──────────────────
  ; lite：需系统预装 WebView2 109+（Win7）或 Evergreen（Win10+）；
  ; full：安装包内置 Fixed Runtime，跳过提示。
  StrCpy $1 "0"
  IfFileExists "$INSTDIR\WebView2\msedgewebview2.exe" 0 +2
    StrCpy $1 "1"
  IfFileExists "$INSTDIR\WebView2-FixedRuntime-109\msedgewebview2.exe" 0 +2
    StrCpy $1 "1"
  ${If} $1 == "0"
    ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
    ${If} $0 == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "未检测到 WebView2 Evergreen 运行时。$\n$\n\
         如果您使用的是 Windows 7，请确保已安装 WebView2 109 或更高版本，$\n\
         或改用内置运行时的完整版安装包。$\n$\n\
         WebView2 109 下载地址：$\n\
         https://www.nuget.org/packages/Microsoft.Web.WebView2/109.0.1518.78"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 删除 Tauri 默认创建的英文快捷方式
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"

  ; 仅在开始菜单创建快捷方式（桌面不创建）
  CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\Pomegranate.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; 覆盖 Tauri fileAssociations 默认生成的右键菜单文字
  ; Tauri 默认写入 "Open with ${PRODUCTNAME}"，这里改为中文"使用 Pomegranate 打开"。
  ; FILECLASS 取自 tauri.conf.json 的 name 字段。
  WriteRegStr SHCTX "Software\Classes\Markdown 文件\shell\open" "" "使用 Pomegranate 打开"

  ; ─── Win7 shim DLL 部署到 EXE 同目录 ───
  ; 三个 shim 都由 resources 安装到 $INSTDIR\binaries\，
  ; Windows DLL 搜索要求它们与 EXE 同目录，统一复制到 $INSTDIR。
  ;
  ; win7rt.dll：替代 bcryptprimitives.dll，提供 ProcessPrng + WaitOnAddress/Wake*
  IfFileExists "$INSTDIR\win7rt.dll" win7rt_ok
    IfFileExists "$INSTDIR\binaries\win7rt.dll" 0 win7rt_ok
    CopyFiles /SILENT "$INSTDIR\binaries\win7rt.dll" "$INSTDIR\win7rt.dll"
  win7rt_ok:

  ; win7synch.dll：替代 api-ms-win-core-synch-l1-2-0.dll，
  ; 提供 WaitOnAddress/Wake* 并转发 InitOnce*/SRWLock 到 kernel32
  IfFileExists "$INSTDIR\win7synch.dll" win7synch_ok
    IfFileExists "$INSTDIR\binaries\win7synch.dll" 0 win7synch_ok
    CopyFiles /SILENT "$INSTDIR\binaries\win7synch.dll" "$INSTDIR\win7synch.dll"
  win7synch_ok:

  ; api-ms-win-core-winrt-l1-1-0.dll：WinRT 桩（HSTRING + RoInitialize）
  ; winrt-string API Set 已在构建期重映射到此 DLL
  IfFileExists "$INSTDIR\api-ms-win-core-winrt-l1-1-0.dll" winrt_shim_ok
    IfFileExists "$INSTDIR\binaries\api-ms-win-core-winrt-l1-1-0.dll" 0 winrt_shim_ok
    CopyFiles /SILENT "$INSTDIR\binaries\api-ms-win-core-winrt-l1-1-0.dll" "$INSTDIR\api-ms-win-core-winrt-l1-1-0.dll"
  winrt_shim_ok:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载时清理开始菜单快捷方式
  Delete "$SMPROGRAMS\$AppStartMenuFolder\Pomegranate.lnk"

  ; 清理部署到 EXE 同目录的 Win7 shim（legacy 旧名一并删除）
  Delete "$INSTDIR\win7rt.dll"
  Delete "$INSTDIR\win7synch.dll"
  Delete "$INSTDIR\api-ms-win-core-winrt-l1-1-0.dll"
  Delete "$INSTDIR\bcryptprimitives.dll"
  Delete "$INSTDIR\api-ms-win-core-synch-l1-2-0.dll"
!macroend