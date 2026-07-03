import { Menu, app, BrowserWindow, MenuItemConstructorOptions, dialog } from 'electron'
import { runUpdateCheckFlow } from './updater'
import { getAppEdition } from './edition'

export function setupMenu(): void {
  const isMac = process.platform === 'darwin'
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }
  const edition = getAppEdition()
  const editionLabel = edition === 'portable' ? '便携版' : edition === 'full' ? '完整版' : '开发版'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '新建项目...',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:new-project')
          }
        },
        {
          label: '打开项目...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:open-project')
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '工具',
      submenu: [
        {
          label: '构建项目',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('tool:build')
          }
        },
        {
          label: '运行客户端',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('tool:run-client')
          }
        },
        {
          label: '停止运行',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('tool:stop')
          }
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新…',
          click: () => {
            void runUpdateCheckFlow(true)
          }
        },
        {
          label: '关于 ModCrafting',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于 ModCrafting',
              message: `ModCrafting v${app.getVersion()}（${editionLabel}）`,
              detail: 'AI 驱动的 Minecraft 模组开发环境\n使用 Fabric + VibeCoding 方式开发模组\n\n完整版支持应用内更新（Gitee 优先 / GitHub 备用）'
            })
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
