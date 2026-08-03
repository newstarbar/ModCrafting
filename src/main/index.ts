import { app, BrowserWindow, ipcMain, Menu, dialog, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { setupMenu } from './menu'
import { setupIpcHandlers } from './ipc-handlers'
import { setupOpenCodeHandlers, shutdownOpenCode } from './opencode-handlers'
import { openExternalWithFallback } from './external-url'
import { setupTerminalHandlers, stopAllTerminalSessions } from './terminal-handler'
import { setupMcRuntimeHandlers, stopAllMcInstances } from './mc-runtime'
import { initUpdater, isUpdateInstallRequested } from './updater'
import { stopGradleDaemonsOnExit } from './build-env'
import { clearBadge, initAppBadge } from './app-badge'
import { enableElectronNetFetch } from './download-shared'
import { setProbeListener } from './download-probe'
import { writeDiagnostic } from './environment-diagnostics'
import {
  setupContextIngressHandlers,
  startContextIngressServer,
  stopContextIngressServer
} from './context-ingress-server'

if (is.dev) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
}

let mainWindow: BrowserWindow | null = null
let shutdownStarted = false
const smokeTest = process.argv.includes('--smoke-test')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

process.on('uncaughtException', (error) => writeDiagnostic('uncaughtException', error instanceof Error ? error.stack || error.message : String(error)))
process.on('unhandledRejection', (reason) => writeDiagnostic('unhandledRejection', String(reason)))

initAppBadge(() => mainWindow)

async function runShutdownCleanup(): Promise<void> {
  stopAllTerminalSessions()
  stopAllMcInstances()
  stopContextIngressServer()
  await shutdownOpenCode()
  await stopGradleDaemonsOnExit()
}

app.on('before-quit', (event) => {
  // electron-updater owns this shutdown sequence; preventing it can leave a
  // downloaded NSIS installer never launched.
  if (isUpdateInstallRequested()) return
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
    join(__dirname, '../../packaging/appIcon.png'),
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

function setupWindowKeyboardShortcuts(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    // 拦截 F12：默认不打开 DevTools
    if (input.key === 'F12') {
      event.preventDefault()
      return
    }

    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen())
      event.preventDefault()
      return
    }

    if (input.key === 'Escape' && win.isFullScreen()) {
      win.setFullScreen(false)
      event.preventDefault()
    }
  })
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

  setupWindowKeyboardShortcuts(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })

  mainWindow.on('focus', () => {
    clearBadge()
  })
  mainWindow.on('show', () => {
    clearBadge()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`Failed to load: ${errorDescription} (${errorCode})`)
    writeDiagnostic('renderer-did-fail-load', { errorCode, errorDescription })
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => writeDiagnostic('render-process-gone', details))

  if (smokeTest) {
    const timeout = setTimeout(() => {
      console.error('[smoke-test] timed out before renderer load')
      writeDiagnostic('smoke-test-failed', 'renderer load timed out')
      app.exit(1)
    }, 10_000)
    mainWindow.webContents.once('did-finish-load', () => {
      void mainWindow?.webContents.executeJavaScript("Boolean(window.api && window.api.getEdition && window.api.runGradleTask)")
        .then((ipcAvailable) => {
          clearTimeout(timeout)
          if (!ipcAvailable) throw new Error('Preload IPC bridge is unavailable')
          console.log('[smoke-test] renderer, preload IPC and packaged resources are ready')
          app.exit(0)
        })
        .catch((error) => {
          clearTimeout(timeout)
          console.error('[smoke-test] failed:', error)
          writeDiagnostic('smoke-test-failed', String(error))
          app.exit(1)
        })
    })
  }

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
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  if (smokeTest) {
    // Keep packaged smoke checks independent from network setup, updater and
    // optional services while using the actual preload bridge and IPC layer.
    setupIpcHandlers()
    createWindow()
    return
  }
  // Gitee 等下载源按客户端 TLS/请求指纹限速（undici 60KB/s vs Chromium 44MB/s），
  // 应用内所有下载（JRE/Gradle/Fabric 种子/知识库/opencode）切换到 Chromium 网络栈
  await enableElectronNetFetch()

  // 测速选优结构化事件 → 渲染层专门测速面板（env:sourceProbe）
  setProbeListener((event) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('env:sourceProbe', event)
    })
  })

  setupMenu()
  setupIpcHandlers()
  setupContextIngressHandlers()
  startContextIngressServer()
  setupOpenCodeHandlers(() => mainWindow)
  setupTerminalHandlers()
  setupMcRuntimeHandlers()
  createWindow()
  if (!smokeTest) initUpdater()

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
