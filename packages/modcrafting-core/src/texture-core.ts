export type RGBAImage = { width: number; height: number; data: Uint8ClampedArray }
export type TextureSize = 16 | 32 | 64
export type BackgroundMode = 'auto' | 'keep' | 'chroma' | 'color'
export type DitherMode = 'none' | 'bayer2' | 'bayer4' | 'floyd'
export type RecolorPreset = 'wood' | 'stone' | 'iron' | 'gold' | 'diamond' | 'netherite' | 'amethyst'

export type RecolorOptions = { preset?: RecolorPreset; colors?: string[] }
export type TextureOptions = {
  size: TextureSize
  background: BackgroundMode
  backgroundTolerance: number
  chromaColor: string
  trim: boolean
  padding: number
  pixelize: boolean
  outlineExpansion: boolean
  paletteSize: number
  dither: DitherMode
  alphaThreshold: number
  outline: 0 | 1 | 2 | 3
  contrast: number
  saturation: number
  recolor?: RecolorOptions
  mirror: 'none' | 'x'
}

export type TextureWarning = { code: string; message: string; fix: string }
export type TextureMetrics = {
  width: number
  height: number
  visiblePixels: number
  occupancy: number
  uniqueColors: number
  partialAlphaPixels: number
  components: number
  largestComponentRatio: number
  borderVisibleRatio: number
  edgeLuminance: number | null
  interiorLuminance: number | null
  edgeMinusInteriorLuminance: number | null
  nearestUpscaleFactor: number
  macroUniformity2: number
  macroUniformity4: number
  macroUniformity8: number
  rareColorPixelRatio: number
}
export type TextureAnalysis = { metrics: TextureMetrics; failures: TextureWarning[]; warnings: TextureWarning[]; ok: boolean }
export type TextureProcessResult = TextureAnalysis & { image: RGBAImage; palette: string[] }

export type TextureBriefInput = {
  description: string
  itemId?: string
  modId?: string
  size?: TextureSize
  background?: 'magenta' | 'white' | 'transparent' | 'auto'
  palette?: string[]
  style?: 'vanilla' | 'detailed'
}
export type TextureBrief = {
  prompt: string
  negativePrompt: string
  size: TextureSize
  background: 'magenta' | 'white' | 'transparent'
  palette: string[]
  target: { textureId: string; filePath: string }
  standard: string
  checklist: string[]
  instructions: string[]
}

export const TEXTURE_SIZES: TextureSize[] = [16, 32, 64]
export const defaultTextureOptions: TextureOptions = {
  size: 16,
  background: 'auto',
  backgroundTolerance: 48,
  chromaColor: '#ff00ff',
  trim: true,
  padding: 1,
  pixelize: true,
  outlineExpansion: true,
  paletteSize: 16,
  dither: 'none',
  alphaThreshold: 128,
  outline: 1,
  contrast: 0,
  saturation: 0,
  mirror: 'none'
}

const MATERIAL_RAMPS: Record<RecolorPreset, string[]> = {
  wood: ['#2f1b0d', '#5a381c', '#8a5a2e', '#bd8750', '#e3c090'],
  stone: ['#303030', '#525252', '#737373', '#959595', '#bdbdbd'],
  iron: ['#3f4247', '#686d73', '#949aa1', '#c2c8ce', '#eef2f5'],
  gold: ['#4a2c00', '#7f4e00', '#b57b00', '#e5b825', '#fff3a8'],
  diamond: ['#073a3a', '#126565', '#1f9b9b', '#60d6d6', '#c9ffff'],
  netherite: ['#151010', '#332525', '#52403a', '#74594c', '#9b7867'],
  amethyst: ['#28103a', '#4b1c6a', '#7433a0', '#9d63cd', '#d4a9f5']
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round = Math.round

export function normalizeTextureOptions(input: Partial<TextureOptions> = {}): TextureOptions {
  const size = TEXTURE_SIZES.includes(input.size as TextureSize) ? input.size as TextureSize : defaultTextureOptions.size
  const background = ['auto', 'keep', 'chroma', 'color'].includes(String(input.background)) ? input.background as BackgroundMode : defaultTextureOptions.background
  const dither = ['none', 'bayer2', 'bayer4', 'floyd'].includes(String(input.dither)) ? input.dither as DitherMode : defaultTextureOptions.dither
  const outline = [0, 1, 2, 3].includes(Number(input.outline)) ? Number(input.outline) as TextureOptions['outline'] : defaultTextureOptions.outline
  const mirror = input.mirror === 'x' ? 'x' : 'none'
  const recolor = input.recolor && (input.recolor.preset || input.recolor.colors?.length) ? {
    ...(input.recolor.preset && MATERIAL_RAMPS[input.recolor.preset] ? { preset: input.recolor.preset } : {}),
    ...(input.recolor.colors?.length ? { colors: input.recolor.colors.slice(0, 16) } : {})
  } : undefined
  return {
    size,
    background,
    backgroundTolerance: clamp(Number(input.backgroundTolerance ?? defaultTextureOptions.backgroundTolerance), 0, 255),
    chromaColor: validHex(input.chromaColor) ? input.chromaColor!.toLowerCase() : defaultTextureOptions.chromaColor,
    trim: input.trim ?? defaultTextureOptions.trim,
    padding: clamp(Number(input.padding ?? defaultTextureOptions.padding), 0, 4),
    pixelize: input.pixelize ?? defaultTextureOptions.pixelize,
    outlineExpansion: input.outlineExpansion ?? defaultTextureOptions.outlineExpansion,
    paletteSize: clamp(Math.round(Number(input.paletteSize ?? defaultTextureOptions.paletteSize)), 4, 32),
    dither,
    alphaThreshold: clamp(Math.round(Number(input.alphaThreshold ?? defaultTextureOptions.alphaThreshold)), 1, 254),
    outline,
    contrast: clamp(Number(input.contrast ?? defaultTextureOptions.contrast), -50, 50),
    saturation: clamp(Number(input.saturation ?? defaultTextureOptions.saturation), -50, 50),
    recolor,
    mirror
  }
}

export function validHex(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

export function hexToRgb(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)]
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(value => clamp(round(value), 0, 255).toString(16).padStart(2, '0')).join('')
}

export function copyImage(image: RGBAImage): RGBAImage {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }
}

export function emptyImage(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2))
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function opaqueAt(image: RGBAImage, x: number, y: number, threshold = 1): boolean {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
  return image.data[(y * image.width + x) * 4 + 3] >= threshold
}

function trimBounds(image: RGBAImage): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = image.width, y0 = image.height, x1 = -1, y1 = -1
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.data[(y * image.width + x) * 4 + 3] === 0) continue
    if (x < x0) x0 = x; if (y < y0) y0 = y
    if (x > x1) x1 = x; if (y > y1) y1 = y
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

function cropImage(image: RGBAImage, x0: number, y0: number, width: number, height: number): RGBAImage {
  const out = emptyImage(width, height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = ((y + y0) * image.width + x + x0) * 4, target = (y * width + x) * 4
    out.data[target] = image.data[source]; out.data[target + 1] = image.data[source + 1]
    out.data[target + 2] = image.data[source + 2]; out.data[target + 3] = image.data[source + 3]
  }
  return out
}

function resizeArea(image: RGBAImage, width: number, height: number): RGBAImage {
  if (image.width === width && image.height === height) return copyImage(image)
  const out = emptyImage(width, height)
  const scaleX = image.width / width, scaleY = image.height / height
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx0 = x * scaleX, sx1 = (x + 1) * scaleX, sy0 = y * scaleY, sy1 = (y + 1) * scaleY
    let r = 0, g = 0, b = 0, a = 0, count = 0
    for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue
      const i = (sy * image.width + sx) * 4, alpha = image.data[i + 3] / 255
      r += image.data[i] * alpha; g += image.data[i + 1] * alpha; b += image.data[i + 2] * alpha
      a += alpha; count++
    }
    const target = (y * width + x) * 4
    if (a > 0) { out.data[target] = r / a; out.data[target + 1] = g / a; out.data[target + 2] = b / a; out.data[target + 3] = (a / Math.max(1, count)) * 255 }
  }
  return out
}

function resizeNearest(image: RGBAImage, width: number, height: number): RGBAImage {
  if (image.width === width && image.height === height) return copyImage(image)
  const out = emptyImage(width, height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = clamp(Math.floor((x + 0.5) * image.width / width), 0, image.width - 1)
    const sy = clamp(Math.floor((y + 0.5) * image.height / height), 0, image.height - 1)
    const source = (sy * image.width + sx) * 4, target = (y * width + x) * 4
    out.data[target] = image.data[source]; out.data[target + 1] = image.data[source + 1]
    out.data[target + 2] = image.data[source + 2]; out.data[target + 3] = image.data[source + 3]
  }
  return out
}

function removeBackground(image: RGBAImage, options: TextureOptions): RGBAImage {
  if (options.background === 'keep') return copyImage(image)
  const out = copyImage(image)
  if (options.background === 'auto') {
    let transparent = 0
    for (const [x, y] of [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]) if (out.data[(y * image.width + x) * 4 + 3] < 16) transparent++
    if (transparent >= 2) return out
  }
  const [kr, kg, kb] = hexToRgb(options.chromaColor)
  const tolerance = options.background === 'auto' ? Math.max(8, options.backgroundTolerance) : Math.max(8, options.backgroundTolerance)
  if (options.background === 'auto') {
    const sample = [0, image.width - 1].flatMap(x => [0, image.height - 1].map(y => {
      const i = (y * image.width + x) * 4
      return [out.data[i], out.data[i + 1], out.data[i + 2]] as [number, number, number]
    }))
    const key: [number, number, number] = [
      median(sample.map(value => value[0])), median(sample.map(value => value[1])), median(sample.map(value => value[2]))
    ]
    const queue: number[] = [], seen = new Uint8Array(image.width * image.height)
    const enqueue = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
      const index = y * image.width + x
      if (seen[index]) return
      const i = index * 4
      if (out.data[i + 3] === 0) return
      if (colorDistance(out.data[i], out.data[i + 1], out.data[i + 2], key[0], key[1], key[2]) > tolerance) return
      seen[index] = 1; queue.push(index)
    }
    for (let x = 0; x < image.width; x++) { enqueue(x, 0); enqueue(x, image.height - 1) }
    for (let y = 0; y < image.height; y++) { enqueue(0, y); enqueue(image.width - 1, y) }
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor], x = index % image.width, y = Math.floor(index / image.width)
      out.data[index * 4 + 3] = 0
      enqueue(x + 1, y); enqueue(x - 1, y); enqueue(x, y + 1); enqueue(x, y - 1)
    }
  } else {
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] === 0) continue
      if (colorDistance(out.data[i], out.data[i + 1], out.data[i + 2], kr, kg, kb) <= tolerance) out.data[i + 3] = 0
    }
  }
  return out
}

function fitSquare(image: RGBAImage, size: number, padding: number): RGBAImage {
  const bounds = trimBounds(image)
  if (!bounds) return emptyImage(size, size)
  const cropped = cropImage(image, bounds.x0, bounds.y0, bounds.x1 - bounds.x0 + 1, bounds.y1 - bounds.y0 + 1)
  const available = Math.max(1, size - padding * 2)
  const scale = Math.min(available / cropped.width, available / cropped.height)
  const width = Math.max(1, Math.min(available, round(cropped.width * scale)))
  const height = Math.max(1, Math.min(available, round(cropped.height * scale)))
  const scaled = scale < 1 ? resizeArea(cropped, width, height) : resizeNearest(cropped, width, height)
  const out = emptyImage(size, size)
  const offsetX = Math.floor((size - width) / 2), offsetY = Math.floor((size - height) / 2)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4, target = ((y + offsetY) * size + x + offsetX) * 4
    out.data[target] = scaled.data[source]; out.data[target + 1] = scaled.data[source + 1]
    out.data[target + 2] = scaled.data[source + 2]; out.data[target + 3] = scaled.data[source + 3]
  }
  return out
}

function adjustColors(image: RGBAImage, contrast: number, saturation: number): RGBAImage {
  if (!contrast && !saturation) return copyImage(image)
  const out = copyImage(image)
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast))
  const saturationFactor = 1 + saturation / 100
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue
    let r = out.data[i], g = out.data[i + 1], b = out.data[i + 2]
    r = contrastFactor * (r - 128) + 128; g = contrastFactor * (g - 128) + 128; b = contrastFactor * (b - 128) + 128
    const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b
    out.data[i] = grey + (r - grey) * saturationFactor
    out.data[i + 1] = grey + (g - grey) * saturationFactor
    out.data[i + 2] = grey + (b - grey) * saturationFactor
  }
  return out
}

function expandOutlines(image: RGBAImage): RGBAImage {
  const out = copyImage(image)
  const grey = new Float32Array(image.width * image.height)
  for (let i = 0, p = 0; i < image.data.length; i += 4, p++) grey[p] = luminance(image.data[i], image.data[i + 1], image.data[i + 2])
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const index = y * image.width + x
    if (image.data[index * 4 + 3] === 0) continue
    const values: number[] = []
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy
      if (nx >= 0 && ny >= 0 && nx < image.width && ny < image.height) values.push(grey[ny * image.width + nx])
    }
    if (!values.length) continue
    const low = Math.min(...values), high = Math.max(...values), middle = median(values)
    const range = high - low
    if (range < 8) continue
    const weight = clamp(2 * ((high - middle) / range) * ((middle - low) / range), 0, 1) * 0.5
    if (weight < 0.02) continue
    const target = grey[index] >= middle ? high : low
    const ratio = grey[index] < 1 ? 1 : target / grey[index]
    const i = index * 4
    out.data[i] = image.data[i] * ratio
    out.data[i + 1] = image.data[i + 1] * ratio
    out.data[i + 2] = image.data[i + 2] * ratio
  }
  return out
}

function contrastDownsample(image: RGBAImage, size: number): RGBAImage {
  const out = emptyImage(size, size)
  const scaleX = image.width / size, scaleY = image.height / size
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx0 = Math.floor(x * scaleX), sx1 = Math.max(sx0 + 1, Math.ceil((x + 1) * scaleX))
    const sy0 = Math.floor(y * scaleY), sy1 = Math.max(sy0 + 1, Math.ceil((y + 1) * scaleY))
    const candidates: Array<{ r: number; g: number; b: number; a: number; l: number }> = []
    let alphaSum = 0, count = 0
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const i = (sy * image.width + sx) * 4
      const alpha = image.data[i + 3]
      alphaSum += alpha; count++
      if (alpha > 0) candidates.push({ r: image.data[i], g: image.data[i + 1], b: image.data[i + 2], a: alpha, l: luminance(image.data[i], image.data[i + 1], image.data[i + 2]) })
    }
    if (!candidates.length) continue
    const levels = candidates.map(value => value.l)
    const mean = levels.reduce((sum, value) => sum + value, 0) / levels.length
    const middle = median(levels)
    let pick = candidates[0]
    if (mean - middle > 8) pick = candidates.reduce((best, value) => value.l > best.l ? value : best, candidates[0])
    else if (middle - mean > 8) pick = candidates.reduce((best, value) => value.l < best.l ? value : best, candidates[0])
    else pick = candidates.reduce((best, value) => Math.abs(value.l - middle) < Math.abs(best.l - middle) ? value : best, candidates[0])
    const target = (y * size + x) * 4
    out.data[target] = pick.r; out.data[target + 1] = pick.g; out.data[target + 2] = pick.b
    out.data[target + 3] = alphaSum / count >= 128 ? 255 : 0
  }
  return out
}

export function extractPalette(image: RGBAImage, limit = 64): string[] {
  const counts = new Map<string, { r: number; g: number; b: number; count: number }>()
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] === 0) continue
    const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2], key = rgbToHex(r, g, b)
    const entry = counts.get(key)
    if (entry) entry.count++
    else counts.set(key, { r, g, b, count: 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit).map(value => rgbToHex(value.r, value.g, value.b))
}

type PaletteColor = { r: number; g: number; b: number }
function quantize(image: RGBAImage, limit: number, dither: DitherMode): { image: RGBAImage; palette: string[] } {
  const histogram = new Map<string, { r: number; g: number; b: number; count: number }>()
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] === 0) continue
    const key = `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`
    const entry = histogram.get(key)
    if (entry) entry.count++
    else histogram.set(key, { r: image.data[i], g: image.data[i + 1], b: image.data[i + 2], count: 1 })
  }
  const colors = [...histogram.values()]
  if (colors.length <= limit) return { image: copyImage(image), palette: colors.map(value => rgbToHex(value.r, value.g, value.b)) }
  let centers: PaletteColor[] = colors.sort((a, b) => b.count - a.count).slice(0, limit).map(value => ({ r: value.r, g: value.g, b: value.b }))
  for (let iteration = 0; iteration < 12; iteration++) {
    const sums = centers.map(() => ({ r: 0, g: 0, b: 0, count: 0 }))
    for (const color of colors) {
      let best = 0, distance = Infinity
      for (let index = 0; index < centers.length; index++) {
        const dr = color.r - centers[index].r, dg = color.g - centers[index].g, db = color.b - centers[index].b
        const value = dr * dr + dg * dg + db * db
        if (value < distance) { distance = value; best = index }
      }
      sums[best].r += color.r * color.count; sums[best].g += color.g * color.count; sums[best].b += color.b * color.count; sums[best].count += color.count
    }
    centers = centers.map((center, index) => sums[index].count ? {
      r: sums[index].r / sums[index].count, g: sums[index].g / sums[index].count, b: sums[index].b / sums[index].count
    } : center)
  }
  const nearest = (r: number, g: number, b: number) => {
    let best = 0, distance = Infinity
    for (let index = 0; index < centers.length; index++) {
      const dr = r - centers[index].r, dg = g - centers[index].g, db = b - centers[index].b
      const value = dr * dr + dg * dg + db * db
      if (value < distance) { distance = value; best = index }
    }
    return best
  }
  const out = copyImage(image)
  if (dither === 'floyd') {
    const buffer = new Float32Array(image.width * image.height * 3)
    for (let i = 0, p = 0; i < image.data.length; i += 4, p += 3) { buffer[p] = image.data[i]; buffer[p + 1] = image.data[i + 1]; buffer[p + 2] = image.data[i + 2] }
    const spread = (x: number, y: number, er: number, eg: number, eb: number, factor: number) => {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
      const p = (y * image.width + x) * 3
      buffer[p] += er * factor; buffer[p + 1] += eg * factor; buffer[p + 2] += eb * factor
    }
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4
      if (image.data[i + 3] === 0) continue
      const p = (y * image.width + x) * 3
      const index = nearest(buffer[p], buffer[p + 1], buffer[p + 2]), center = centers[index]
      const er = buffer[p] - center.r, eg = buffer[p + 1] - center.g, eb = buffer[p + 2] - center.b
      out.data[i] = center.r; out.data[i + 1] = center.g; out.data[i + 2] = center.b
      spread(x + 1, y, er, eg, eb, 7 / 16); spread(x - 1, y + 1, er, eg, eb, 3 / 16)
      spread(x, y + 1, er, eg, eb, 5 / 16); spread(x + 1, y + 1, er, eg, eb, 1 / 16)
    }
  } else {
    const matrix = dither === 'bayer2' ? [[0, 2], [3, 1]] : dither === 'bayer4' ? [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]] : null
    const divisor = matrix ? matrix.length * matrix.length : 1
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4
      if (image.data[i + 3] === 0) continue
      const offset = matrix ? ((matrix[y % matrix.length][x % matrix.length] + 0.5) / divisor - 0.5) * 28 : 0
      const center = centers[nearest(image.data[i] + offset, image.data[i + 1] + offset, image.data[i + 2] + offset)]
      out.data[i] = center.r; out.data[i + 1] = center.g; out.data[i + 2] = center.b
    }
  }
  return { image: out, palette: centers.map(value => rgbToHex(value.r, value.g, value.b)) }
}

function binarizeAlpha(image: RGBAImage, threshold: number): RGBAImage {
  const out = copyImage(image)
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] < threshold) { out.data[i] = 0; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 0 }
    else out.data[i + 3] = 255
  }
  return out
}

function addOutline(image: RGBAImage, level: TextureOptions['outline']): RGBAImage {
  if (!level) return copyImage(image)
  const out = copyImage(image), factor = 1 - level * 0.18
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4
    if (image.data[i + 3] === 0) continue
    const edge = !opaqueAt(image, x - 1, y) || !opaqueAt(image, x + 1, y) || !opaqueAt(image, x, y - 1) || !opaqueAt(image, x, y + 1)
    if (!edge) continue
    if (luminance(image.data[i], image.data[i + 1], image.data[i + 2]) < 36) continue
    out.data[i] = image.data[i] * factor; out.data[i + 1] = image.data[i + 1] * factor; out.data[i + 2] = image.data[i + 2] * factor
  }
  return out
}

function mirrorX(image: RGBAImage): RGBAImage {
  const out = copyImage(image)
  for (let y = 0; y < image.height; y++) for (let x = 0; x < Math.floor(image.width / 2); x++) {
    const source = (y * image.width + x) * 4, target = (y * image.width + (image.width - 1 - x)) * 4
    out.data[target] = image.data[source]; out.data[target + 1] = image.data[source + 1]
    out.data[target + 2] = image.data[source + 2]; out.data[target + 3] = image.data[source + 3]
  }
  return out
}

function recolor(image: RGBAImage, options: RecolorOptions): { image: RGBAImage; palette: string[] } {
  const colors = options.colors?.filter(validHex) ?? (options.preset ? MATERIAL_RAMPS[options.preset] : undefined)
  if (!colors?.length) return { image: copyImage(image), palette: [] }
  const ramp = [...colors].sort((a, b) => luminance(...hexToRgb(a)) - luminance(...hexToRgb(b)))
  const out = copyImage(image)
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue
    const index = clamp(round(luminance(out.data[i], out.data[i + 1], out.data[i + 2]) / 255 * (ramp.length - 1)), 0, ramp.length - 1)
    const [r, g, b] = hexToRgb(ramp[index])
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b
  }
  return { image: out, palette: ramp }
}

export function processTexture(source: RGBAImage, input: Partial<TextureOptions> = {}): TextureProcessResult {
  const options = normalizeTextureOptions(input)
  let image = copyImage(source)
  image = removeBackground(image, options)
  image = options.trim ? fitSquare(image, options.size, options.padding) : resizeNearest(image, options.size, options.size)
  image = adjustColors(image, options.contrast, options.saturation)
  if (options.pixelize) {
    image = resizeArea(image, options.size * 8, options.size * 8)
    if (options.outlineExpansion) image = expandOutlines(image)
    image = contrastDownsample(image, options.size)
  }
  if (options.mirror === 'x') image = mirrorX(image)
  const quantized = quantize(image, options.paletteSize, options.dither)
  image = binarizeAlpha(quantized.image, options.alphaThreshold)
  image = addOutline(image, options.outline)
  let palette = quantized.palette
  if (options.recolor) {
    const recolored = recolor(image, options.recolor)
    image = recolored.image
    if (recolored.palette.length) palette = recolored.palette
  }
  return { image, palette, ...analyzeTexture(image, options) }
}

export function analyzeTexture(image: RGBAImage, input: Partial<TextureOptions> = {}): TextureAnalysis {
  const options = normalizeTextureOptions(input)
  const total = image.width * image.height
  const counts = new Map<string, number>()
  let visible = 0, partial = 0
  const mask = new Uint8Array(total)
  for (let p = 0; p < total; p++) {
    const i = p * 4, alpha = image.data[i + 3]
    if (alpha > 0) {
      visible++; mask[p] = 1
      if (alpha < 255) partial++
      const key = `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const components: number[] = [], seen = new Uint8Array(total)
  for (let p = 0; p < total; p++) {
    if (!mask[p] || seen[p]) continue
    let count = 0; const queue = [p]; seen[p] = 1
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor], x = index % image.width, y = Math.floor(index / image.width); count++
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue
        const next = ny * image.width + nx
        if (mask[next] && !seen[next]) { seen[next] = 1; queue.push(next) }
      }
    }
    components.push(count)
  }
  components.sort((a, b) => b - a)
  let borderTotal = 0, borderVisible = 0
  for (let x = 0; x < image.width; x++) for (const y of [0, image.height - 1]) { borderTotal++; if (mask[y * image.width + x]) borderVisible++ }
  for (let y = 1; y < image.height - 1; y++) for (const x of [0, image.width - 1]) { borderTotal++; if (mask[y * image.width + x]) borderVisible++ }
  const edgeLevels: number[] = [], interiorLevels: number[] = []
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const index = y * image.width + x
    if (!mask[index]) continue
    const edge = x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1 || !mask[index - 1] || !mask[index + 1] || !mask[index - image.width] || !mask[index + image.width]
    const i = index * 4, level = luminance(image.data[i], image.data[i + 1], image.data[i + 2])
    if (edge) edgeLevels.push(level); else interiorLevels.push(level)
  }
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const edgeLuminance = average(edgeLevels), interiorLuminance = average(interiorLevels)
  const nearestUpscaleFactor = detectUpscale(image)
  const macroUniformity = (factor: number) => {
    if (image.width % factor || image.height % factor) return 0
    let uniform = 0, blocks = 0
    for (let y = 0; y < image.height; y += factor) for (let x = 0; x < image.width; x += factor) {
      blocks++
      const i = (y * image.width + x) * 4
      let same = true
      for (let dy = 0; dy < factor && same; dy++) for (let dx = 0; dx < factor; dx++) {
        const j = ((y + dy) * image.width + x + dx) * 4
        if (image.data[j] !== image.data[i] || image.data[j + 1] !== image.data[i + 1] || image.data[j + 2] !== image.data[i + 2] || image.data[j + 3] !== image.data[i + 3]) { same = false; break }
      }
      if (same) uniform++
    }
    return blocks ? uniform / blocks : 0
  }
  let rare = 0
  for (const count of counts.values()) if (count <= 2) rare += count
  const metrics: TextureMetrics = {
    width: image.width, height: image.height, visiblePixels: visible, occupancy: total ? visible / total : 0,
    uniqueColors: counts.size, partialAlphaPixels: partial, components: components.length,
    largestComponentRatio: visible && components.length ? components[0] / visible : 0,
    borderVisibleRatio: borderTotal ? borderVisible / borderTotal : 0,
    edgeLuminance, interiorLuminance,
    edgeMinusInteriorLuminance: edgeLuminance !== null && interiorLuminance !== null ? (edgeLuminance - interiorLuminance) / 255 : null,
    nearestUpscaleFactor, macroUniformity2: macroUniformity(2), macroUniformity4: macroUniformity(4), macroUniformity8: macroUniformity(8),
    rareColorPixelRatio: visible ? rare / visible : 0
  }
  const failures: TextureWarning[] = [], warnings: TextureWarning[] = []
  if (image.width !== image.height) failures.push({ code: 'TEXTURE_NOT_SQUARE', message: '贴图必须是正方形。', fix: '把画布改为正方形后再保存。' })
  if (image.width !== options.size || image.height !== options.size) failures.push({ code: 'TEXTURE_SIZE_MISMATCH', message: `贴图尺寸应为 ${options.size}×${options.size}，当前是 ${image.width}×${image.height}。`, fix: '使用目标尺寸重新生成或缩放后再保存。' })
  if (!visible) failures.push({ code: 'TEXTURE_EMPTY', message: '贴图完全透明。', fix: '重新导入带主体的图片，或先画出一个可见轮廓。' })
  if (partial) failures.push({ code: 'TEXTURE_PARTIAL_ALPHA', message: `存在 ${partial} 个半透明像素；MC 物品图标应为二进制 Alpha。`, fix: '把 Alpha 阈值调高，或关闭抗锯齿后重新导出。' })
  if (image.width >= 64 && nearestUpscaleFactor > 1) failures.push({ code: 'TEXTURE_FAKE_DETAIL', message: `检测到 ${nearestUpscaleFactor}× 最近邻放大，画面不是原生像素细节。`, fix: '按目标尺寸重新绘制细节，不要放大小图。' })
  if (visible && metrics.occupancy < 0.10) warnings.push({ code: 'TEXTURE_TOO_SMALL', message: '主体占用画布过小，游戏内可能看不清。', fix: '裁掉多余留白或放大主体。' })
  if (metrics.occupancy > 0.75) warnings.push({ code: 'TEXTURE_TOO_FULL', message: '主体几乎填满画布，缺少物品图标留白。', fix: '缩小主体，四周至少留 1px 透明边。' })
  if (metrics.borderVisibleRatio > 0.25) warnings.push({ code: 'TEXTURE_BORDER', message: '主体大量贴边，物品图标可能被裁切。', fix: '缩小主体或增加留白。' })
  if (components.length > 12 && metrics.largestComponentRatio < 0.85) warnings.push({ code: 'TEXTURE_FRAGMENTED', message: '剪影由很多碎块组成，主体不够连贯。', fix: '连接主体或删除游离像素。' })
  if (counts.size > options.paletteSize + 8) warnings.push({ code: 'TEXTURE_PALETTE', message: `颜色数 ${counts.size} 超出目标调色板较多。`, fix: '降低调色板数量或重新量化。' })
  if (metrics.rareColorPixelRatio > 0.30 && counts.size > 12) warnings.push({ code: 'TEXTURE_NOISE', message: '大量颜色只出现 1-2 次，像抗锯齿或杂色残留。', fix: '关闭抖动、降低调色板或清理杂色。' })
  if (metrics.edgeMinusInteriorLuminance !== null && metrics.edgeMinusInteriorLuminance > 0.05) warnings.push({ code: 'TEXTURE_OUTLINE_INVERTED', message: '外轮廓比内部更亮，描边层级可能反了。', fix: '加深轮廓或降低边缘亮度。' })
  if (image.width >= 64 && metrics.macroUniformity4 > 0.90) warnings.push({ code: 'TEXTURE_MACROBLOCK', message: '4×4 宏块过于均匀，细节可能是小图放大。', fix: '在目标尺寸上补充真实像素细节。' })
  if (image.width >= 128 && metrics.macroUniformity8 > 0.90) warnings.push({ code: 'TEXTURE_MACROBLOCK8', message: '8×8 宏块过于均匀，像是低分辨率放大。', fix: '按目标尺寸重新绘制。' })
  return { metrics, failures, warnings, ok: failures.length === 0 }
}

function detectUpscale(image: RGBAImage): number {
  for (const factor of [16, 12, 10, 8, 6, 5, 4, 3, 2]) {
    if (image.width % factor || image.height % factor) continue
    let same = true
    for (let y = 0; y < image.height && same; y += factor) for (let x = 0; x < image.width && same; x += factor) {
      const i = (y * image.width + x) * 4
      for (let dy = 0; dy < factor && same; dy++) for (let dx = 0; dx < factor; dx++) {
        const j = ((y + dy) * image.width + x + dx) * 4
        if (image.data[j] !== image.data[i] || image.data[j + 1] !== image.data[i + 1] || image.data[j + 2] !== image.data[i + 2] || image.data[j + 3] !== image.data[i + 3]) { same = false; break }
      }
    }
    if (same) return factor
  }
  return 1
}

const ARCHETYPES: Array<{ standard: string; words: string[]; hint: string }> = [
  { standard: 'sword', words: ['sword', '剑', 'blade'], hint: 'diagonal blade pointing up-right, crossguard, short grip, pommel' },
  { standard: 'pickaxe', words: ['pickaxe', '镐'], hint: 'centered head with two pointed ends, straight handle, readable silhouette' },
  { standard: 'axe', words: ['axe', '斧'], hint: 'single broad blade, eye/socket, straight handle' },
  { standard: 'shovel', words: ['shovel', 'spade', '铲'], hint: 'flat scoop head, short neck, straight handle' },
  { standard: 'hoe', words: ['hoe', '锄'], hint: 'perpendicular blade, short neck, straight handle' },
  { standard: 'bow', words: ['bow', '弓'], hint: 'curved limbs, string, centered grip' },
  { standard: 'crossbow', words: ['crossbow', '弩'], hint: 'horizontal bow limbs, stock, trigger housing' },
  { standard: 'armor', words: ['helmet', 'chestplate', 'leggings', 'boots', 'armor', '头盔', '胸甲', '护腿', '靴'], hint: 'recognizable armor piece with clear plate/seam structure' },
  { standard: 'potion', words: ['potion', 'bottle', '药水'], hint: 'rounded bottle, neck, cork, liquid body' },
  { standard: 'book', words: ['book', 'tome', '书'], hint: 'cover, spine, page block, clasp if requested' },
  { standard: 'food', words: ['apple', 'bread', 'meat', 'carrot', 'food', '食物', '苹果', '面包'], hint: 'compact food silhouette with one clear bite or texture cue' }
]

export function detectStandard(text: string): { standard: string; hint?: string } {
  const lower = text.toLowerCase()
  const found = ARCHETYPES.find(value => value.words.some(word => lower.includes(word)))
  return found ? { standard: found.standard, hint: found.hint } : { standard: 'generic' }
}

export function textureFileFor(textureId: string): string {
  const [namespace, name] = textureId.split(':')
  return `src/main/resources/assets/${namespace}/textures/${name}.png`
}

export function buildTextureBrief(input: TextureBriefInput): TextureBrief {
  const size = TEXTURE_SIZES.includes(input.size as TextureSize) ? input.size as TextureSize : 16
  const modId = input.modId || 'modid'
  const rawName = input.itemId?.includes(':') ? input.itemId.split(':')[1] : input.itemId
  const textureName = rawName?.startsWith('item/') ? rawName : `item/${(rawName || input.description).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'texture'}`
  const textureId = `${modId}:${textureName}`
  const background = input.background === 'auto' || !input.background ? (size === 16 ? 'magenta' : 'magenta') : input.background
  const detected = detectStandard(`${input.description} ${input.itemId || ''}`)
  const palette = input.palette?.filter(validHex).slice(0, 16) ?? []
  const detail = input.style === 'detailed'
    ? 'Moderate detail within the native grid, still readable at the target size; do not imitate a smooth illustration.'
    : 'Vanilla-like readability first, with restrained material detail.'
  const prompt = [
    `A single Minecraft item icon of ${input.description}, centered and isolated.`,
    `Native ${size}x${size} pixel art drawn directly on the target grid; crisp integer pixels, no anti-aliasing, no smooth gradients.`,
    detected.hint ? `Preserve the recognizable ${detected.standard} macro silhouette: ${detected.hint}.` : 'Use a clear, readable object silhouette.',
    `Upper-left lighting, 3-5 value steps per material, limited palette (${palette.length || 16} colors).`,
    `${detail} One dominant material mass; avoid unnecessary runes, gems, halos, or decorative noise.`,
    background === 'transparent' ? 'Transparent background (or solid chroma background if transparency is unsupported).' : `Solid pure ${background === 'magenta' ? 'magenta (#FF00FF)' : 'white (#FFFFFF)'} background for clean background removal.`,
    'Square 1:1 composition with 1-2 pixels of transparent margin around the object.'
  ].join(' ')
  const negativePrompt = 'blurry, photo, photorealistic, 3D render, anti-aliasing, smooth gradient, soft shadow, drop shadow, text, letters, watermark, logo, frame, border, multiple objects, scene, perspective, background scenery, noisy texture, high resolution fake detail'
  return {
    prompt,
    negativePrompt,
    size,
    background,
    palette,
    target: { textureId, filePath: textureFileFor(textureId) },
    standard: detected.standard,
    checklist: [
      '主体在 16×16 下仍能被一眼认出',
      '背景干净且能自动抠除',
      '轮廓清晰，没有抗锯齿或渐变',
      '颜色数量受控，材质明暗层次可读',
      '没有文字、水印、边框和多余装饰'
    ],
    instructions: [
      '由 Agent 自动完成全流程，不要让用户手动执行每一步：拿到 brief 后立即用宿主图像工具按 prompt 生成正方形 PNG，接着连续调用 import（sourcePath 或 sourceBase64）→ save → bind（工程已有对应内容对象时），中途不要停下等用户确认。',
      '保存后一次性汇报：质检结果与警告、纹理路径、绑定情况，并提醒重新构建、重启客户端后查看。',
      '浏览器工作台的“贴图”模块只作为可选的逐像素润色入口，向用户提一句即可；用户不满意再引导打开，不要默认要求用户手工编辑。'
    ]
  }
}
