import { ipcMain, type BrowserWindow } from 'electron'
import { detectOpenCode, openProjectInOpenCode } from './opencode-bridge.ts'
import {
  abortOpenCodeSession,
  createOpenCodeSession,
  getOpenCodeServerState,
  onOpenCodeBusEvent,
  promptOpenCodeSession,
  startOpenCodeServer,
  stopOpenCodeServer
} from './opencode-runtime.ts'

let eventUnsub: (() => void) | null = null
let eventWindow: BrowserWindow | null = null

function attachEventForward(win: BrowserWindow | null): void {
  eventUnsub?.()
  eventWindow = win
  eventUnsub = onOpenCodeBusEvent((payload) => {
    if (eventWindow && !eventWindow.isDestroyed()) {
      eventWindow.webContents.send('opencode:event', payload)
    }
  })
}

export function setupOpenCodeHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('opencode:detect', async () => detectOpenCode())

  ipcMain.handle('opencode:openProject', async (_event, projectPath: string) =>
    openProjectInOpenCode(projectPath)
  )

  ipcMain.handle('opencode:serverStart', async (_event, projectPath: string, config?: Record<string, unknown>) => {
    const win = getMainWindow()
    attachEventForward(win)
    return startOpenCodeServer(projectPath, config)
  })

  ipcMain.handle('opencode:serverStop', async () => {
    await stopOpenCodeServer()
    eventUnsub?.()
    eventUnsub = null
    return { success: true }
  })

  ipcMain.handle('opencode:serverState', async () => getOpenCodeServerState())

  ipcMain.handle('opencode:sessionCreate', async (_event, title?: string) => createOpenCodeSession(title))

  ipcMain.handle('opencode:sessionPrompt', async (_event, sessionId: string, text: string, agent?: string) =>
    promptOpenCodeSession(sessionId, text, { agent })
  )

  ipcMain.handle('opencode:sessionAbort', async (_event, sessionId: string) => {
    const ok = await abortOpenCodeSession(sessionId)
    return { success: ok }
  })
}

export async function shutdownOpenCode(): Promise<void> {
  eventUnsub?.()
  eventUnsub = null
  await stopOpenCodeServer()
}
