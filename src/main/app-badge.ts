import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { clampBadgeLabel, encodePngRGBA } from './app-badge-utils'

export type GetMainWindow = () => BrowserWindow | null
export { clampBadgeLabel, encodePngRGBA } from './app-badge-utils'

let getMainWindow: GetMainWindow = () => null
let unreadCount = 0

export function initAppBadge(getter: GetMainWindow): void {
  getMainWindow = getter
}

export function getUnreadBadgeCount(): number {
  return unreadCount
}

export function notifyTaskComplete(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (win.isFocused()) return

  unreadCount += 1
  applyBadge(unreadCount)
  try {
    win.flashFrame(true)
  } catch {
    // ignore
  }
}

export function clearBadge(): void {
  unreadCount = 0
  applyBadge(0)
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    try {
      win.flashFrame(false)
    } catch {
      // ignore
    }
  }
}

export function setBadgeCount(n: number): void {
  unreadCount = Math.max(0, Math.floor(n))
  applyBadge(unreadCount)
}

function applyBadge(count: number): void {
  const win = getMainWindow()
  const label = clampBadgeLabel(count)

  if (process.platform === 'darwin') {
    try {
      app.setBadgeCount(count)
    } catch {
      // ignore
    }
  }

  if (!win || win.isDestroyed()) return

  if (!label) {
    try {
      win.setOverlayIcon(null, '')
    } catch {
      // ignore
    }
    return
  }

  try {
    const overlay = createBadgeOverlay(label)
    win.setOverlayIcon(overlay, `有 ${count} 个已完成任务`)
  } catch {
    // Overlay unsupported on some hosts; macOS badge still applied above.
  }
}

/** 3×5 digit glyphs for 0–9 and a compact "+" for 9+. */
const GLYPHS: Record<string, number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b010, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000]
}

const SIZE = 16
const RED = { r: 220, g: 38, b: 38, a: 255 }
const WHITE = { r: 255, g: 255, b: 255, a: 255 }

function createBadgeOverlay(label: string): NativeImage {
  const pixels = Buffer.alloc(SIZE * SIZE * 4, 0)
  const cx = (SIZE - 1) / 2
  const cy = (SIZE - 1) / 2
  const radius = SIZE / 2 - 0.5

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(pixels, x, y, RED)
      }
    }
  }

  drawLabel(pixels, label)
  const png = encodePngRGBA(SIZE, SIZE, pixels)
  return nativeImage.createFromBuffer(png)
}

function setPixel(
  pixels: Buffer,
  x: number,
  y: number,
  color: { r: number; g: number; b: number; a: number }
): void {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  pixels[i] = color.r
  pixels[i + 1] = color.g
  pixels[i + 2] = color.b
  pixels[i + 3] = color.a
}

function drawLabel(pixels: Buffer, label: string): void {
  const chars = label.split('')
  const glyphW = 3
  const glyphH = 5
  const gap = 1
  const totalW = chars.length * glyphW + (chars.length - 1) * gap
  let startX = Math.floor((SIZE - totalW) / 2)
  const startY = Math.floor((SIZE - glyphH) / 2)

  for (const ch of chars) {
    const rows = GLYPHS[ch]
    if (!rows) {
      startX += glyphW + gap
      continue
    }
    for (let row = 0; row < glyphH; row++) {
      const bits = rows[row]
      for (let col = 0; col < glyphW; col++) {
        if (bits & (1 << (glyphW - 1 - col))) {
          setPixel(pixels, startX + col, startY + row, WHITE)
        }
      }
    }
    startX += glyphW + gap
  }
}
