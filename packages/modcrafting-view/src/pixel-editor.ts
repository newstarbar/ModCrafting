export type PixelImage = { width: number; height: number; data: Uint8ClampedArray }
export type RGBA = [number, number, number, number]
export type PixelTool = 'pencil' | 'eraser' | 'fill' | 'eyedropper' | 'line' | 'rect'

export function cloneImage(image: PixelImage): PixelImage {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }
}

export function blankImage(width: number, height: number): PixelImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

export function hexToRgba(hex: string, alpha = 255): RGBA {
  const value = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#000000'
  return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16), alpha]
}

export function rgbaToHex(color: RGBA): string {
  return '#' + color.slice(0, 3).map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')
}

export function rgbaAt(image: PixelImage, x: number, y: number): RGBA {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return [0, 0, 0, 0]
  const index = (y * image.width + x) * 4
  return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]]
}

export function putPixel(image: PixelImage, x: number, y: number, color: RGBA): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  const index = (y * image.width + x) * 4
  image.data[index] = color[0]; image.data[index + 1] = color[1]; image.data[index + 2] = color[2]; image.data[index + 3] = color[3]
}

export function drawLine(image: PixelImage, x0: number, y0: number, x1: number, y1: number, color: RGBA): void {
  let x = x0, y = y0
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let error = dx + dy
  for (;;) {
    putPixel(image, x, y, color)
    if (x === x1 && y === y1) break
    const twice = 2 * error
    if (twice >= dy) { error += dy; x += sx }
    if (twice <= dx) { error += dx; y += sy }
  }
}

export function drawRect(image: PixelImage, x0: number, y0: number, x1: number, y1: number, color: RGBA, filled = false): void {
  const left = Math.min(x0, x1), right = Math.max(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1)
  if (filled) {
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) putPixel(image, x, y, color)
    return
  }
  for (let x = left; x <= right; x++) { putPixel(image, x, top, color); putPixel(image, x, bottom, color) }
  for (let y = top; y <= bottom; y++) { putPixel(image, left, y, color); putPixel(image, right, y, color) }
}

export function floodFill(image: PixelImage, x: number, y: number, color: RGBA): void {
  const start = rgbaAt(image, x, y)
  if (start[0] === color[0] && start[1] === color[1] && start[2] === color[2] && start[3] === color[3]) return
  const matches = (index: number) => image.data[index] === start[0] && image.data[index + 1] === start[1] && image.data[index + 2] === start[2] && image.data[index + 3] === start[3]
  const queue: Array<[number, number]> = [[x, y]], seen = new Uint8Array(image.width * image.height)
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [cx, cy] = queue[cursor], index = cy * image.width + cx
    if (cx < 0 || cy < 0 || cx >= image.width || cy >= image.height || seen[index]) continue
    seen[index] = 1
    if (!matches(index * 4)) continue
    putPixel(image, cx, cy, color)
    queue.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
  }
}

export function mirrorX(image: PixelImage): void {
  for (let y = 0; y < image.height; y++) for (let x = 0; x < Math.floor(image.width / 2); x++) {
    const source = (y * image.width + x) * 4, target = (y * image.width + (image.width - 1 - x)) * 4
    image.data[target] = image.data[source]; image.data[target + 1] = image.data[source + 1]
    image.data[target + 2] = image.data[source + 2]; image.data[target + 3] = image.data[source + 3]
  }
}

export function extractColors(image: PixelImage, limit = 32): string[] {
  const counts = new Map<string, { color: RGBA; count: number }>()
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3] < 128) continue
    const color: RGBA = [image.data[index], image.data[index + 1], image.data[index + 2], 255]
    const key = rgbaToHex(color)
    const entry = counts.get(key)
    if (entry) entry.count++
    else counts.set(key, { color, count: 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit).map(value => rgbaToHex(value.color))
}

export function replaceColor(image: PixelImage, from: string, to: string): void {
  const source = hexToRgba(from), target = hexToRgba(to)
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index] === source[0] && image.data[index + 1] === source[1] && image.data[index + 2] === source[2] && image.data[index + 3] > 0) {
      image.data[index] = target[0]; image.data[index + 1] = target[1]; image.data[index + 2] = target[2]
    }
  }
}

export function toBase64(image: PixelImage): string {
  const bytes = new Uint8Array(image.data)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

export function fromBase64(base64: string, width: number, height: number): PixelImage {
  const binary = atob(base64)
  const data = new Uint8ClampedArray(binary.length)
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index)
  return { width, height, data }
}
