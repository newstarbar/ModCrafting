import { ipcMain, BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import * as os from 'os'
import * as path from 'path'

interface TerminalSession {
  pty: pty.IPty
  cwd: string
}

const sessions = new Map<string, TerminalSession>()
let sessionCounter = 0

export function setupTerminalHandlers(): void {
  // Create a new terminal session
  ipcMain.handle('terminal:create', async (_event, cwd?: string) => {
    const id = `term-${++sessionCounter}`
    const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
    const shellArgs = os.platform() === 'win32' ? [] : []

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      cwd: cwd || process.cwd(),
      env: { ...process.env } as { [key: string]: string }
    })

    // Forward data from the PTY to the renderer
    ptyProcess.onData((data) => {
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('terminal:data', id, data)
      })
    })

    ptyProcess.onExit(({ exitCode, signal }) => {
      const msg = `\r\n\x1b[33m[进程退出，代码: ${exitCode}, 信号: ${signal}]\x1b[0m\r\n`
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('terminal:data', id, msg)
      })
      sessions.delete(id)
    })

    sessions.set(id, { pty: ptyProcess, cwd: cwd || process.cwd() })

    return id
  })

  // Write data to a terminal session
  ipcMain.handle('terminal:write', async (_event, id: string, data: string) => {
    const session = sessions.get(id)
    if (session) {
      session.pty.write(data)
      return { success: true }
    }
    return { success: false, error: 'Session not found' }
  })

  // Resize a terminal session
  ipcMain.handle('terminal:resize', async (_event, id: string, cols: number, rows: number) => {
    const session = sessions.get(id)
    if (session) {
      session.pty.resize(cols, rows)
      return { success: true }
    }
    return { success: false, error: 'Session not found' }
  })

  // Kill a terminal session
  ipcMain.handle('terminal:kill', async (_event, id: string) => {
    const session = sessions.get(id)
    if (session) {
      session.pty.kill()
      sessions.delete(id)
      return { success: true }
    }
    return { success: false, error: 'Session not found' }
  })

  // Change terminal working directory
  ipcMain.handle('terminal:setCwd', async (_event, id: string, cwd: string) => {
    const session = sessions.get(id)
    if (session) {
      session.cwd = cwd
      // Write cd command to the terminal
      session.pty.write(`cd "${cwd}"\r`)
      return { success: true }
    }
    return { success: false, error: 'Session not found' }
  })
}
