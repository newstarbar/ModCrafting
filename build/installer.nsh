; ModCrafting NSIS 自定义脚本（electron-builder 自动 include）
; 文档: https://www.electron.build/nsis

!macro customHeader
  ; 欢迎页 / 完成页文案（中文）
  !define MUI_WELCOMEPAGE_TITLE "安装 ModCrafting ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT \
    "此向导将在您的计算机上安装或升级 ModCrafting。$\r$\n$\r$\n\
    将安装的主要组件：$\r$\n\
    • ModCrafting 主程序与 AI 开发界面$\r$\n\
    • JDK 21（内置 Java 运行环境）$\r$\n\
    • Gradle 9.5 构建工具$\r$\n\
    • 离线 Fabric / Minecraft 依赖包（约 1 GB）$\r$\n$\r$\n\
    升级说明：若检测到已安装的旧版本，将自动覆盖程序文件；$\r$\n\
    您的项目文件与运行时缓存（runtime 目录）通常会被保留。$\r$\n$\r$\n\
    建议：安装到可写目录（如 D:\Programs\ModCrafting），$\r$\n\
    请勿安装到 Program Files 以免首次环境初始化失败。$\r$\n$\r$\n\
    单击「下一步」继续。"

  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT \
    "ModCrafting 已成功安装到您的计算机。$\r$\n$\r$\n\
    首次启动时，程序会初始化离线构建环境（复制缓存，约数分钟），$\r$\n\
    请耐心等待进度条完成后再开始开发。$\r$\n$\r$\n\
    单击「完成」退出安装向导。"

  !define MUI_UNWELCOMEPAGE_TITLE "卸载 ModCrafting"
  !define MUI_UNWELCOMEPAGE_TEXT \
    "此向导将从您的计算机中卸载 ModCrafting。$\r$\n$\r$\n\
    卸载不会自动删除您的工作区项目；$\r$\n\
    安装目录下的 runtime 缓存可能需要手动删除。$\r$\n$\r$\n\
    单击「下一步」继续。"

  ; 安装详情页：显示正在释放的文件（辅助安装器默认行为）
  !define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "正在安装 ModCrafting"
  !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "请稍候，正在复制程序文件与离线构建资源…"
!macroend

; 升级安装：在复制文件前提示
!macro customInit
  ${If} ${isUpdated}
    MessageBox MB_ICONINFORMATION|MB_OK \
      "检测到本机已安装 ModCrafting。$\r$\n$\r$\n\
      即将升级至版本 ${VERSION}。$\r$\n\
      安装程序将先卸载旧版程序文件，再安装新版本；$\r$\n\
      您的用户数据与项目文件一般不会受影响。$\r$\n$\r$\n\
      单击「确定」开始升级。" /SD IDOK
  ${EndIf}
!macroend
