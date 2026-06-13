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
  ; 本安装包捆绑 WebView2 109 Fixed Runtime，专为 Windows 7 SP1 构建。
  ; Win8/Win10+ 用户建议使用标准版（Evergreen WebView2，体积更小）。
  ${If} ${AtLeastWin10}
    MessageBox MB_YESNO|MB_ICONINFORMATION \
      "检测到您的系统为 Windows 10 或更高版本。$\n$\n\
       本安装包为 Windows 7 兼容版，捆绑了旧版 WebView2 运行时（约 250MB 额外体积）。$\n$\n\
       建议使用标准版安装包以获得更小的下载体积和最新的浏览器内核。$\n$\n\
       是否继续安装？" \
      IDYES win10_continue
    Quit
    win10_continue:
  ${EndIf}

  ${If} ${IsWin7}
  ${AndIfNot} ${AtLeastServicePack} 1
    MessageBox MB_OK|MB_ICONSTOP \
      "检测到您的系统为 Windows 7，但未安装 Service Pack 1。$\n$\n\
       本应用要求 Windows 7 SP1 或更高版本。$\n$\n\
       请先安装 Windows 7 Service Pack 1 后再运行本安装程序。"
    Quit
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 删除 Tauri 默认创建的英文快捷方式
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"

  ; 创建中文快捷方式（指向同一个 exe）
  CreateShortcut "$DESKTOP\知识库.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\知识库.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; 覆盖 Tauri fileAssociations 默认生成的右键菜单文字
  ; Tauri 默认写入 "Open with ${PRODUCTNAME}"（=Open with Knowledge Base），
  ; 这里改为中文"使用知识库打开"。FILECLASS 取自 tauri.conf.json 的 name 字段。
  WriteRegStr SHCTX "Software\Classes\Markdown 文件\shell\open" "" "使用知识库打开"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载时清理中文快捷方式
  Delete "$DESKTOP\知识库.lnk"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\知识库.lnk"
!macroend