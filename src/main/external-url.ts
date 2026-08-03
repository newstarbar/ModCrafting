import { BrowserWindow, shell } from 'electron'

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

// 允许通过 shell.openExternal 打开的非 http 协议白名单
const ALLOWED_SCHEMES = ['tencent:', 'mailto:', 'tel:']

function isAllowedScheme(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ALLOWED_SCHEMES.includes(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * Open URL in the system default browser; fall back to an in-app window if that fails.
 * 支持 http/https 链接以及白名单协议（tencent/mailto/tel）。
 */
export async function openExternalWithFallback(
  url: string
): Promise<{ success: boolean; usedFallback?: boolean; error?: string }> {
  const trimmed = url.trim()
  if (!trimmed) {
    return { success: false, error: '链接为空' }
  }
  const isHttp = isHttpUrl(trimmed)
  const isAllowed = isAllowedScheme(trimmed)
  if (!isHttp && !isAllowed) {
    return { success: false, error: '不支持的链接协议' }
  }

  try {
    await shell.openExternal(trimmed)
    return { success: true }
  } catch (err) {
    // 非 http 协议无法用内置窗口回退，直接返回错误
    if (!isHttp) {
      return { success: false, error: String(err) }
    }
    try {
      const win = new BrowserWindow({
        width: 1100,
        height: 760,
        title: 'ModCrafting',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      })
      await win.loadURL(trimmed)
      return { success: true, usedFallback: true }
    } catch (fallbackErr) {
      return {
        success: false,
        error: `${String(err)}; 内置窗口也失败: ${String(fallbackErr)}`,
      }
    }
  }
}
