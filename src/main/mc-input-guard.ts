import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFile } from 'child_process'

/**
 * MC 输入保护模块（焦点抢占方案）
 *
 * 核心原理：MC Java 版使用 GLFW/RawInput 读取鼠标视角，重叠窗口无法拦截。
 * 但 GLFW 在窗口失去焦点时停止读取 RawInput。因此锁定时 overlay 主动抢占焦点，
 * MC 失去焦点 → GLFW 停止 → 玩家无法转动视角。
 *
 * AI 输入通过 HTTP 桥（callMcBridge）发送，不依赖 MC 窗口焦点，因此不受影响。
 *
 * 每 250ms 轮询检测：
 * - MC 窗口是否最小化（rect 为 0x0）→ 隐藏 overlay
 * - 前台窗口是否为 MC 或 overlay → 若都不是（用户切换到其他程序）→ 隐藏 overlay
 * - MC 窗口位置/大小变化 → 同步 overlay 位置
 */

let overlayWindow: BrowserWindow | null = null
let trackingTimer: NodeJS.Timeout | null = null
let currentPid: number | null = null
let mcHwnd: number | null = null
let overlayHwnd: number | null = null
let isLocked = true
let isGuardActive = false

const TRACK_INTERVAL_MS = 250

function resolveOverlayHtmlPath(): string {
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
    resizable: true,
    focusable: false, // 默认不抢焦点；锁定时设为 true 并 focus()
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(resolveOverlayHtmlPath())

  // 缓存 overlay 窗口句柄用于前台检测
  try {
    const handle = win.getNativeWindowHandle()
    overlayHwnd = handle.readUInt32LE(0)
  } catch {
    overlayHwnd = null
  }

  // 接收恢复按钮点击 → 解锁
  ipcMain.on('mc-input-guard:restore', () => {
    setLocked(false)
  })

  // 接收状态指示器点击 → 重新锁定
  ipcMain.on('mc-input-guard:lock', () => {
    setLocked(true)
  })

  // 解锁状态下 hover-to-click：鼠标进入指示器区域时临时关闭穿透以接收点击
  ipcMain.on('mc-input-guard:hover-start', () => {
    if (overlayWindow && overlayWindow.isVisible() && !isLocked) {
      overlayWindow.setIgnoreMouseEvents(false)
    }
  })
  ipcMain.on('mc-input-guard:hover-end', () => {
    if (overlayWindow && overlayWindow.isVisible() && !isLocked) {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    }
  })

  return win
}

/**
 * 锁定/解锁切换。
 *
 * 锁定：overlay 可获取焦点并主动 focus()，MC 失去焦点 → GLFW 停止 RawInput。
 * 解锁：overlay 不可获取焦点且鼠标穿透，通过 SetForegroundWindow 恢复 MC 焦点。
 */
function setLocked(locked: boolean): void {
  isLocked = locked
  if (!overlayWindow || !overlayWindow.isVisible()) return

  if (locked) {
    // 锁定：overlay 抢占焦点
    overlayWindow.setIgnoreMouseEvents(false) // 接收点击（恢复按钮）
    overlayWindow.webContents.send('mc-input-guard:state', 'locked')
    // setFocusable + focus 必须在 send 之后，确保 UI 先切换到锁定态
    overlayWindow.setFocusable(true)
    // 延迟 focus 以确保 focusable 生效
    setTimeout(() => {
      if (overlayWindow && overlayWindow.isVisible() && isLocked) {
        overlayWindow.focus()
      }
    }, 50)
  } else {
    // 解锁：overlay 释放焦点，穿透鼠标
    overlayWindow.setFocusable(false)
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    overlayWindow.webContents.send('mc-input-guard:state', 'unlocked')
    // 主动将焦点还给 MC
    if (mcHwnd !== null) {
      restoreMcFocus().catch(() => {
        /* 焦点恢复失败不阻断主流程 */
      })
    }
  }
}

interface McWindowStatus {
  foregroundHwnd: number
  mcHwnd: number
  rect: { x: number; y: number; width: number; height: number } | null
}

/**
 * 单次 PowerShell 调用获取：前台窗口句柄 + MC 窗口句柄 + MC 客户区矩形。
 * 返回格式："foregroundHwnd,mcHwnd,x,y,w,h"（MC 最小化时 x,y,w,h 均为 0）。
 */
async function queryMcWindowStatus(pid: number): Promise<McWindowStatus | null> {
  return new Promise((resolve) => {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class McWin {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
}
"@
$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { return }
$mcHwnd = $proc.MainWindowHandle
$fgHwnd = [McWin]::GetForegroundWindow()
$isMin = [McWin]::IsIconic($mcHwnd)
if ($isMin) {
  "$($fgHwnd.ToInt64()),$($mcHwnd.ToInt64()),0,0,0,0"
  return
}
$rect = New-Object McWin+RECT
[McWin]::GetClientRect($mcHwnd, [ref]$rect) | Out-Null
$pt = New-Object McWin+POINT
$pt.X = $rect.L
$pt.Y = $rect.T
[McWin]::ClientToScreen($mcHwnd, [ref]$pt) | Out-Null
$w = $rect.R - $rect.L
$h = $rect.B - $rect.T
"$($fgHwnd.ToInt64()),$($mcHwnd.ToInt64()),$($pt.X),$($pt.Y),$w,$h"
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
        if (parts.length !== 6) {
          resolve(null)
          return
        }
        const [fg, mc, x, y, w, h] = parts.map((n) => parseInt(n, 10))
        if ([fg, mc, x, y, w, h].some((n) => !Number.isFinite(n))) {
          resolve(null)
          return
        }
        const rect = w > 0 && h > 0 ? { x, y, width: w, height: h } : null
        resolve({ foregroundHwnd: fg, mcHwnd: mc, rect })
      }
    )
  })
}

/**
 * 通过 SetForegroundWindow + AttachThreadInput 将焦点还给 MC 窗口。
 * Windows 限制：只有前台进程或被用户最近激活的进程才能调用 SetForegroundWindow。
 * AttachThreadInput 技巧绕过此限制：将当前前台线程的输入队列附加到目标线程。
 */
async function restoreMcFocus(): Promise<void> {
  if (mcHwnd === null) return
  return new Promise((resolve) => {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FwRestore {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr h, int nCmdShow);
}
"@
$mcHwnd = [IntPtr]${mcHwnd}
$fgHwnd = [FwRestore]::GetForegroundWindow()
if ($fgHwnd -eq $mcHwnd) { return }
$fgThread = [FwRestore]::GetWindowThreadProcessId($fgHwnd, [ref]([uint32]0))
$mcThread = [FwRestore]::GetWindowThreadProcessId($mcHwnd, [ref]([uint32]0))
[FwRestore]::AttachThreadInput($fgThread, $mcThread, $true) | Out-Null
[FwRestore]::SetForegroundWindow($mcHwnd) | Out-Null
[FwRestore]::ShowWindow($mcHwnd, 9) | Out-Null
[FwRestore]::AttachThreadInput($fgThread, $mcThread, $false) | Out-Null
`.trim()

    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 2000, windowsHide: true },
      () => resolve()
    )
  })
}

async function updateOverlayState(): Promise<void> {
  if (!overlayWindow || currentPid === null || !isGuardActive) return

  const status = await queryMcWindowStatus(currentPid)
  if (!status) return

  // 缓存 MC 窗口句柄
  mcHwnd = status.mcHwnd

  // MC 最小化 → 隐藏 overlay
  if (!status.rect) {
    if (overlayWindow.isVisible()) {
      overlayWindow.hide()
    }
    return
  }

  // 前台窗口检测：MC 或 overlay 在前台才显示 overlay
  const mcOrOverlayForeground =
    status.foregroundHwnd === status.mcHwnd ||
    (overlayHwnd !== null && status.foregroundHwnd === overlayHwnd)

  if (!mcOrOverlayForeground) {
    // 用户切换到其他程序 → 隐藏 overlay
    if (overlayWindow.isVisible()) {
      overlayWindow.hide()
    }
    return
  }

  // MC 或 overlay 在前台 → 确保 overlay 可见
  if (!overlayWindow.isVisible()) {
    overlayWindow.show()
    // 恢复可见后重新应用锁定/解锁状态
    if (isLocked) {
      overlayWindow.setIgnoreMouseEvents(false)
      overlayWindow.webContents.send('mc-input-guard:state', 'locked')
      overlayWindow.setFocusable(true)
      setTimeout(() => {
        if (overlayWindow && overlayWindow.isVisible() && isLocked) {
          overlayWindow.focus()
        }
      }, 50)
    } else {
      overlayWindow.setFocusable(false)
      overlayWindow.setIgnoreMouseEvents(true, { forward: true })
      overlayWindow.webContents.send('mc-input-guard:state', 'unlocked')
    }
  }

  // 同步 overlay 位置到 MC 客户区
  overlayWindow.setBounds({
    x: status.rect.x,
    y: status.rect.y,
    width: status.rect.width,
    height: status.rect.height
  })
  if (!overlayWindow.isAlwaysOnTop()) {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  }
}

function startTracking(pid: number): void {
  currentPid = pid
  if (trackingTimer) clearInterval(trackingTimer)
  trackingTimer = setInterval(() => {
    updateOverlayState().catch(() => {
      /* ignore tracking errors */
    })
  }, TRACK_INTERVAL_MS)
}

function stopTracking(): void {
  currentPid = null
  mcHwnd = null
  if (trackingTimer) {
    clearInterval(trackingTimer)
    trackingTimer = null
  }
}

export function showInputGuard(pid: number): void {
  if (!overlayWindow) {
    overlayWindow = createOverlayWindow()
  }
  isGuardActive = true
  isLocked = true
  overlayWindow.show()
  overlayWindow.setIgnoreMouseEvents(false)
  overlayWindow.webContents.send('mc-input-guard:state', 'locked')
  overlayWindow.setFocusable(true)
  setTimeout(() => {
    if (overlayWindow && overlayWindow.isVisible() && isLocked) {
      overlayWindow.focus()
    }
  }, 50)
  startTracking(pid)
  updateOverlayState().catch(() => {
    /* ignore */
  })
}

export function hideInputGuard(): void {
  isGuardActive = false
  stopTracking()
  if (overlayWindow) {
    overlayWindow.setFocusable(false)
    overlayWindow.hide()
    overlayWindow.setIgnoreMouseEvents(false)
  }
  isLocked = true
}

export function setInputGuardLocked(locked: boolean): void {
  setLocked(locked)
}

export function isInputGuardActive(): boolean {
  return isGuardActive
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
  overlayHwnd = null
  isGuardActive = false
  ipcMain.removeAllListeners('mc-input-guard:restore')
  ipcMain.removeAllListeners('mc-input-guard:lock')
  ipcMain.removeAllListeners('mc-input-guard:hover-start')
  ipcMain.removeAllListeners('mc-input-guard:hover-end')
}
