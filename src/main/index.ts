import { app, BrowserWindow, ipcMain, Menu, dialog, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { setupMenu } from './menu'
import { setupIpcHandlers } from './ipc-handlers'
import { openExternalWithFallback } from './external-url'
import { setupTerminalHandlers, stopAllTerminalSessions } from './terminal-handler'
import { setupMcRuntimeHandlers, stopAllMcInstances } from './mc-runtime'
import { initUpdater } from './updater'
import { stopGradleDaemonsOnExit } from './build-env'

if (is.dev) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
}

let mainWindow: BrowserWindow | null = null
let shutdownStarted = false

async function runShutdownCleanup(): Promise<void> {
  stopAllTerminalSessions()
  stopAllMcInstances()
  await stopGradleDaemonsOnExit()
}

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  shutdownStarted = true
  event.preventDefault()
  void runShutdownCleanup().finally(() => {
    app.exit(0)
  })
})

function resolveAppIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icon.png'),
    join(__dirname, '../../build/appIcon.png'),
    join(app.getAppPath(), 'build', 'appIcon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

function resolvePreloadScript(): string {
  const base = join(__dirname, '../preload/index')
  const mjs = `${base}.mjs`
  const js = `${base}.js`
  if (existsSync(mjs)) return mjs
  if (existsSync(js)) return js
  return mjs
}

function createWindow(): void {
  const iconPath = resolveAppIcon()
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    show: false,
    title: 'ModCrafting',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: resolvePreloadScript(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`Failed to load: ${errorDescription} (${errorCode})`)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalWithFallback(url)
    return { action: 'deny' }
  })

  // Load the renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // Open DevTools in dev mode for debugging
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  setupMenu()
  setupIpcHandlers()
  setupTerminalHandlers()
  setupMcRuntimeHandlers()
  createWindow()
  initUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
