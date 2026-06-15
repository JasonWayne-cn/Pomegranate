; ============================================================================
; 自定义 NSIS 安装钩子
; 目的：保留 productName="Knowledge Base"（让 CI 产物名/updater URL 全英文，
;       避免 GitHub Release Asset 中文字符 URL 编码导致更新失败），
;       同时让用户桌面/开始菜单的快捷方式显示中文"知识库"。
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
  ; 本安装包不捆绑 WebView2，需系统已预装 WebView2 109+ (Win7) 或 Evergreen (Win10+)。
  ; 检测 Evergreen 注册表键（固定版 WebView2 无此键，仅做参考提示）。
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "未检测到 WebView2 Evergreen 运行时。$\n$\n\
       如果您使用的是 Windows 7，请确保已安装 WebView2 109 或更高版本，$\n\
       否则应用将无法启动。$\n$\n\
       WebView2 109 下载地址：$\n\
       https://www.nuget.org/packages/Microsoft.Web.WebView2/109.0.1518.78"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 删除 Tauri 默认创建的英文快捷方式
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"

  ; 仅在开始菜单创建中文快捷方式（桌面不创建）
  CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\知识库.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; 覆盖 Tauri fileAssociations 默认生成的右键菜单文字
  ; Tauri 默认写入 "Open with ${PRODUCTNAME}"（=Open with Knowledge Base），
  ; 这里改为中文"使用知识库打开"。FILECLASS 取自 tauri.conf.json 的 name 字段。
  WriteRegStr SHCTX "Software\Classes\Markdown 文件\shell\open" "" "使用知识库打开"

  ; ─── bcryptprimitives.dll (统一 Win7 shim) ───
  ; 提供 ProcessPrng / WaitOnAddress / WakeByAddressSingle / WakeByAddressAll
  ; PE delay-load 表已在构建期将 api-ms-win-core-synch-l1-2-0.dll 重映射到 bcryptprimitives.dll
  IfFileExists "$INSTDIR\bcryptprimitives.dll" bcrypt_shim_ok
    IfFileExists "$INSTDIR\binaries\bcryptprimitives.dll" 0 bcrypt_shim_ok
    CopyFiles /SILENT "$INSTDIR\binaries\bcryptprimitives.dll" "$INSTDIR\bcryptprimitives.dll"
  bcrypt_shim_ok:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载时清理开始菜单中文快捷方式
  Delete "$SMPROGRAMS\$AppStartMenuFolder\知识库.lnk"
!macroend