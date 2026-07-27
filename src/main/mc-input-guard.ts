import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFile } from 'child_process'

/**
 * MC 输入保护模块
 *
 * AI 操控 MC 窗口测试期间，默认切断玩家的鼠标输入。
 * 通过创建透明置顶覆盖窗口覆盖在 MC 窗口上方，拦截鼠标事件。
 * 玩家鼠标悬停时显示遮罩 + 提示 + 恢复按钮。
 * 点击恢复按钮后覆盖窗口变为穿透模式，玩家可手动操作，AI 继续自测。
 */

let overlayWindow: BrowserWindow | null = null
let trackingTimer: NodeJS.Timeout | null = null
let currentPid: number | null = null
let isLocked = true

const TRACK_INTERVAL_MS = 250

function resolveOverlayHtmlPath(): string {
  // 开发环境：resources/overlay/mc-input-guard.html
  // 打包环境：process.resourcesPath/overlay/mc-input-guard.html
  const devPath = join(__dirname, '../../resources/overlay/mc-input-guard.html')
  if (existsSync(devPath)) return devPath
  const prodPath = join(process.resourcesPath, 'overlay', 'mc-input-guard.html')
  if (existsSync(prodPath)) return prodPath
  return devPath
}

function createOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true, // 允许调整大小，以便跟随 MC 窗口尺寸变化（全屏切换等）
    focusable: false, // 不获取焦点，MC 窗口保持焦点
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(resolveOverlayHtmlPath())

  // 接收恢复按钮点击 → 解锁
  ipcMain.on('mc-input-guard:restore', () => {
    setLocked(false)
  })

  // 接收状态指示器点击 → 重新锁定
  ipcMain.on('mc-input-guard:lock', () => {
    setLocked(true)
  })

  return win
}

function setLocked(locked: boolean): void {
  isLocked = locked
  if (!overlayWindow || !overlayWindow.isVisible()) return

  if (locked) {
    // 锁定：拦截鼠标事件
    overlayWindow.setIgnoreMouseEvents(false)
    overlayWindow.webContents.send('mc-input-guard:state', 'locked')
  } else {
    // 解锁：穿透鼠标事件，但仍然转发鼠标移动事件（用于显示状态指示器）
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    overlayWindow.webContents.send('mc-input-guard:state', 'unlocked')
  }
}

interface McWindowRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 通过 PowerShell + PID 查找 MC 窗口客户区位置和大小
 * 使用 GetClientRect + ClientToScreen 获取客户区矩形（不含标题栏/边框），
 * 这样 overlay 窗口精确覆盖 MC 渲染区域。
 */
async function findMcWindowRect(pid: number): Promise<McWindowRect | null> {
  return new Promise((resolve) => {
    // PowerShell 脚本：通过 PID 查找窗口句柄，获取客户区矩形并转换为屏幕坐标
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$proc = Get-Process -Id ${pid}
if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { return }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class McClientRect {
  [DllImport("user32.dll")]
  public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
}
"@
$rect = New-Object McClientRect+RECT
[McClientRect]::GetClientRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
$pt = New-Object McClientRect+POINT
$pt.X = $rect.L
$pt.Y = $rect.T
[McClientRect]::ClientToScreen($proc.MainWindowHandle, [ref]$pt) | Out-Null
"$($pt.X),$($pt.Y),$($rect.R - $rect.L),$($rect.B - $rect.T)"
`.trim()

    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const output = stdout.trim()
        const parts = output.split(',')
        if (parts.length !== 4) {
          resolve(null)
          return
        }
        const [x, y, w, h] = parts.map((n) => parseInt(n, 10))
        if ([x, y, w, h].some((n) => !Number.isFinite(n))) {
          resolve(null)
          return
        }
        if (w <= 0 || h <= 0) {
          resolve(null)
          return
        }
        resolve({ x, y, width: w, height: h })
      }
    )
  })
}

async function updateOverlayPosition(): Promise<void> {
  if (!overlayWindow || !overlayWindow.isVisible() || currentPid === null) return
  const rect = await findMcWindowRect(currentPid)
  if (!rect || rect.width <= 0 || rect.height <= 0) return

  // 确保覆盖窗口位置在屏幕内
  const display = screen.getDisplayMatching({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  overlayWindow.setBounds({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  })
  // 确保 overlay 在最上层
  if (!overlayWindow.isAlwaysOnTop()) {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  }
}

function startTracking(pid: number): void {
  currentPid = pid
  if (trackingTimer) clearInterval(trackingTimer)
  trackingTimer = setInterval(() => {
    updateOverlayPosition().catch(() => {
      /* ignore tracking errors */
    })
  }, TRACK_INTERVAL_MS)
}

function stopTracking(): void {
  currentPid = null
  if (trackingTimer) {
    clearInterval(trackingTimer)
    trackingTimer = null
  }
}

export function showInputGuard(pid: number): void {
  if (!overlayWindow) {
    overlayWindow = createOverlayWindow()
  }
  overlayWindow.show()
  overlayWindow.setIgnoreMouseEvents(false)
  isLocked = true
  overlayWindow.webContents.send('mc-input-guard:state', 'locked')
  startTracking(pid)
  // 立即更新一次位置
  updateOverlayPosition().catch(() => {
    /* ignore */
  })
}

export function hideInputGuard(): void {
  stopTracking()
  if (overlayWindow) {
    overlayWindow.hide()
    overlayWindow.setIgnoreMouseEvents(false)
  }
  isLocked = true
}

export function setInputGuardLocked(locked: boolean): void {
  setLocked(locked)
}

export function isInputGuardActive(): boolean {
  return overlayWindow !== null && overlayWindow.isVisible()
}

export function setupInputGuardHandlers(): void {
  ipcMain.handle('mc-input-guard:show', (_event, pid: number) => {
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
      return { ok: false, error: 'Invalid PID' }
    }
    showInputGuard(pid)
    return { ok: true }
  })

  ipcMain.handle('mc-input-guard:hide', () => {
    hideInputGuard()
    return { ok: true }
  })

  ipcMain.handle('mc-input-guard:setLocked', (_event, locked: boolean) => {
    setLocked(Boolean(locked))
    return { ok: true }
  })

  ipcMain.handle('mc-input-guard:isActive', () => {
    return { active: isInputGuardActive(), locked: isLocked }
  })
}

export function destroyInputGuard(): void {
  stopTracking()
  if (overlayWindow) {
    overlayWindow.destroy()
    overlayWindow = null
  }
  // 移除 IPC 监听器
  ipcMain.removeAllListeners('mc-input-guard:restore')
  ipcMain.removeAllListeners('mc-input-guard:lock')
}
