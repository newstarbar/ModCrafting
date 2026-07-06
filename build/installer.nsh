; ModCrafting NSIS 自定义脚本（electron-builder include）
; 文档: https://www.electron.build/nsis
; 注意：此文件由 installSection.nsh include，只能使用 !macro；Function/Var 须在 customHeader 等顶层宏中定义。

!macro customHeader
  !ifndef MODCRAFTING_HEADER_DONE
    !define MODCRAFTING_HEADER_DONE

    !ifndef BUILD_UNINSTALLER
      !define MODCRAFTING_SETUP_PROGRESS

      Var ModCraftingCreateDesktopShortcut
      Var ModCraftingCreateStartMenuShortcut
      Var ModCraftingOptionsHwnd
      Var ModCraftingChkDesktop
      Var ModCraftingChkStartMenu

      Function ModCrafting_7zExtractCallback
        Pop $R8
        Pop $R9
        IntCmp $R9 0 mc7z_done
        IntOp $R7 $R8 * 100
        IntOp $R7 $R7 / $R9
        FindWindow $0 "#32770" "" $HWNDPARENT
        StrCmp $0 "" mc7z_details
        GetDlgItem $0 $0 1004
        StrCmp $0 "" mc7z_details
        SendMessage $0 0x0402 $R7 0
        mc7z_details:
        SetDetailsPrint textonly
        DetailPrint "正在解压组件… $R7%"
        SetDetailsPrint listonly
        mc7z_done:
      FunctionEnd

      Function ModCraftingOptionsCreate
        ${StrContains} $R9 "updated" $CMDLINE
        StrCmp $R9 "" 0 mc_options_skip_upgrade
        !insertmacro MUI_HEADER_TEXT "可选任务" "选择要创建的快捷方式"

        nsDialogs::Create 1018
        Pop $ModCraftingOptionsHwnd
        StrCmp $ModCraftingOptionsHwnd error mc_options_skip_upgrade

        ${NSD_CreateLabel} 0 0 100% 24u "请选择附加任务（可随时在系统中删除）："
        Pop $0

        ${NSD_CreateCheckbox} 0 28u 100% 12u "创建桌面快捷方式(&D)"
        Pop $ModCraftingChkDesktop
        ${NSD_Check} $ModCraftingChkDesktop

        ${NSD_CreateCheckbox} 0 48u 100% 12u "创建开始菜单快捷方式(&S)"
        Pop $ModCraftingChkStartMenu
        ${NSD_Check} $ModCraftingChkStartMenu

        nsDialogs::Show
        Return
        mc_options_skip_upgrade:
        Abort
      FunctionEnd

      Function ModCraftingOptionsLeave
        ${NSD_GetState} $ModCraftingChkDesktop $0
        StrCmp $0 ${BST_CHECKED} 0 +3
        StrCpy $ModCraftingCreateDesktopShortcut "1"
        Goto +2
        StrCpy $ModCraftingCreateDesktopShortcut "0"

        ${NSD_GetState} $ModCraftingChkStartMenu $0
        StrCmp $0 ${BST_CHECKED} 0 +3
        StrCpy $ModCraftingCreateStartMenuShortcut "1"
        Goto +2
        StrCpy $ModCraftingCreateStartMenuShortcut "0"
      FunctionEnd
    !endif
  !endif

  ShowInstDetails show
  ShowUninstDetails show
  !ifndef MUI_INSTFILESPAGE_SHOWDETAILS
    !define MUI_INSTFILESPAGE_SHOWDETAILS
  !endif

  !ifndef MUI_BGCOLOR
    !define MUI_BGCOLOR F5F5F7
    !define MUI_TEXTCOLOR 1D1D1F
    !define MUI_INSTFILESPAGE_COLORS "F5F5F7 1D1D1F"
  !endif

  !ifndef BUILD_UNINSTALLER
  !ifndef MUI_LICENSEPAGE_CHECKBOX
    !define MUI_LICENSEPAGE_TEXT_TOP "请阅读下列许可协议。您必须接受协议条款才能继续安装。"
    !define MUI_LICENSEPAGE_BUTTON "我接受(&A)"
    !define MUI_LICENSEPAGE_CHECKBOX
  !endif

  !ifndef MUI_WELCOMEPAGE_TITLE
    !define MUI_WELCOMEPAGE_TITLE "安装 ModCrafting ${VERSION}"
    !define MUI_WELCOMEPAGE_TEXT \
      "此向导将引导您完成 ModCrafting 的安装。$\r$\n$\r$\n\
      主要组件：$\r$\n\
      • ModCrafting 主程序与 AI 开发界面$\r$\n\
      • JDK 21（内置 Java 运行环境）$\r$\n\
      • Gradle 9.5 构建工具$\r$\n\
      • 离线 Fabric / Minecraft 依赖（约 1 GB）$\r$\n$\r$\n\
      建议安装到可写目录（默认当前用户目录），$\r$\n\
      所需磁盘空间约 2 GB。$\r$\n$\r$\n\
      单击「下一步」继续。"

    !define MUI_FINISHPAGE_TITLE "安装完成"
    !define MUI_FINISHPAGE_TEXT \
      "ModCrafting 已成功安装。$\r$\n$\r$\n\
      首次启动会初始化离线构建环境（约数分钟），$\r$\n\
      请等待进度完成后再开始开发。$\r$\n$\r$\n\
      单击「完成」退出向导。"

    !define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "正在安装 ModCrafting"
    !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "正在准备安装环境，请稍候…"
  !endif
  !endif

  !ifndef MUI_UNWELCOMEPAGE_TITLE
    !define MUI_UNWELCOMEPAGE_TITLE "卸载 ModCrafting"
    !define MUI_UNWELCOMEPAGE_TEXT \
      "此向导将从您的计算机中卸载 ModCrafting。$\r$\n$\r$\n\
      卸载不会删除您的工作区项目；$\r$\n\
      用户数据与 runtime 缓存可能需要手动清理。$\r$\n$\r$\n\
      单击「下一步」继续。"
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom ModCraftingOptionsCreate ModCraftingOptionsLeave
!macroend

!macro customInit
  StrCpy $ModCraftingCreateDesktopShortcut "1"
  StrCpy $ModCraftingCreateStartMenuShortcut "1"

  ${If} ${isUpdated}
    DetailPrint "正在将 ModCrafting 更新至 ${VERSION}…"
  ${Else}
    ${GetRoot} $INSTDIR $R0
    System::Call 'kernel32::GetDiskFreeSpaceEx(t r0, p r1, p r2, p r3)'
    System::Int64Op $3 / 1024 / 1024
    Pop $R1
    IntCmp $R1 2048 disk_ok disk_ok disk_warn
    disk_warn:
      MessageBox MB_ICONINFORMATION|MB_OK \
        "目标磁盘可用空间约 $R1 MB，建议至少保留 2 GB。$\r$\n\
        空间不足可能导致安装失败。" /SD IDOK
    disk_ok:
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  StrCpy $R5 0
  mc_app_wait_loop:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      Goto mc_app_wait_done
    ${EndIf}

    IntOp $R5 $R5 + 1
    ${If} $R5 > 20
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "检测到 ModCrafting 仍在运行，或安装目录中的文件被占用。$\r$\n$\r$\n\
        请关闭 ModCrafting 及相关终端/游戏实例后点击「重试」。" \
        /SD IDCANCEL IDRETRY mc_app_wait_reset IDCANCEL mc_app_wait_abort
      mc_app_wait_abort:
        Quit
      mc_app_wait_reset:
        StrCpy $R5 0
    ${EndIf}

    ${If} $R5 > 1
      DetailPrint "等待 ModCrafting 退出… ($R5/20)"
    ${EndIf}

    ${If} $R5 > 4
      !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
    ${EndIf}
    Sleep 1000
    Goto mc_app_wait_loop
  mc_app_wait_done:
!macroend

!macro customInstall
  ${If} $ModCraftingCreateStartMenuShortcut == "1"
    !insertmacro cleanupOldMenuDirectory
    !insertmacro createMenuDirectory
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${EndIf}

  ${If} $ModCraftingCreateDesktopShortcut == "1"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

!macro customUnInstallCheck
  ${if} $R0 == 0
    Return
  ${endIf}

  DetailPrint "旧版卸载程序返回代码 $R0，正在清理安装目录…"

  StrCpy $R5 0
  mc_uninstall_cleanup_loop:
    IntOp $R5 $R5 + 1
    Sleep 2000
    RMDir /r "$INSTDIR"
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" mc_uninstall_still_there mc_uninstall_cleanup_ok
    mc_uninstall_still_there:
    ${If} $R5 < 8
      DetailPrint "安装目录仍被占用，正在重试… ($R5/8)"
      Goto mc_uninstall_cleanup_loop
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "无法完全卸载旧版本文件。$\r$\n$\r$\n请确认 ModCrafting 已关闭后点击「重试」。" \
      /SD IDCANCEL IDRETRY mc_uninstall_cleanup_reset IDCANCEL mc_uninstall_cleanup_abort
    mc_uninstall_cleanup_abort:
      SetErrorLevel 2
      Quit
    mc_uninstall_cleanup_reset:
      StrCpy $R5 0
      Goto mc_uninstall_cleanup_loop
  mc_uninstall_cleanup_ok:
  ClearErrors
!macroend

!macro preInit
  DetailPrint "正在准备安装…"
!macroend
!endif

!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "部分文件暂时被占用，正在重试移动旧文件…"
      Sleep 2000
      RMDir /r "$PLUGINSDIR\old-install"
      CreateDirectory "$PLUGINSDIR\old-install"
      Push ""
      Call un.atomicRMDir
      Pop $R0
    ${endif}
  ${endif}

  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend
