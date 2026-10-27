import { convertIndexedToRgb, decode, encode } from 'fast-png'
import type { RGBAImage } from './texture-core.ts'
import { CoreError } from './runtime.ts'

export const MAX_TEXTURE_SOURCE_BYTES = 16 * 1024 * 1024
export const MAX_TEXTURE_PIXELS = 4096 * 4096
const PNG_SIGNATURE = '89504e470d0a1a0a'

function fail(code: string, message: string): never {
  throw new CoreError(code, message)
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).toString('hex') === PNG_SIGNATURE
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (!isPng(bytes) || bytes.length < 24) fail('TEXTURE_SOURCE_INVALID', '源文件不是有效的 PNG。请让 Agent 导出 PNG 后再导入。')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16), height = view.getUint32(20)
  if (!width || !height) fail('TEXTURE_SOURCE_INVALID', 'PNG 尺寸无效。')
  return { width, height }
}

export function decodePng(bytes: Uint8Array): RGBAImage {
  if (bytes.length > MAX_TEXTURE_SOURCE_BYTES) fail('TEXTURE_SOURCE_TOO_LARGE', `源图超过 ${MAX_TEXTURE_SOURCE_BYTES / 1024 / 1024}MB；请让 Agent 缩小或压缩后重试。`)
  const dimensions = pngDimensions(bytes)
  if (dimensions.width * dimensions.height > MAX_TEXTURE_PIXELS) fail('TEXTURE_SOURCE_TOO_LARGE', `源图像素超过 ${MAX_TEXTURE_PIXELS}；请先缩小到 4096×4096 以内。`)
  let png: ReturnType<typeof decode>
  try { png = decode(bytes, { checkCrc: true }) }
  catch (cause) { fail('TEXTURE_SOURCE_INVALID', '无法解码 PNG：' + String(cause)) }
  let data: Uint8Array | Uint16Array = png.data instanceof Uint16Array ? png.data : png.data instanceof Uint8Array ? png.data : new Uint8Array(png.data)
  let channels = png.channels, depth = png.depth
  if (png.palette) {
    try { data = convertIndexedToRgb(png); channels = png.palette[0]?.length ?? 4; depth = 8 }
    catch (cause) { fail('TEXTURE_SOURCE_INVALID', '无法展开 PNG 调色板：' + String(cause)) }
  }
  const sample = (index: number): number => {
    const value = data[index]
    return depth === 16 ? value >> 8 : depth < 8 ? value * (255 / ((1 << depth) - 1)) : value
  }
  const rgba = new Uint8ClampedArray(png.width * png.height * 4)
  for (let pixel = 0; pixel < png.width * png.height; pixel++) {
    const source = pixel * channels, target = pixel * 4
    if (channels === 1) { const grey = sample(source); rgba[target] = grey; rgba[target + 1] = grey; rgba[target + 2] = grey; rgba[target + 3] = 255 }
    else if (channels === 2) { const grey = sample(source); rgba[target] = grey; rgba[target + 1] = grey; rgba[target + 2] = grey; rgba[target + 3] = sample(source + 1) }
    else if (channels === 3) { rgba[target] = sample(source); rgba[target + 1] = sample(source + 1); rgba[target + 2] = sample(source + 2); rgba[target + 3] = 255 }
    else { rgba[target] = sample(source); rgba[target + 1] = sample(source + 1); rgba[target + 2] = sample(source + 2); rgba[target + 3] = sample(source + 3) }
  }
  return { width: png.width, height: png.height, data: rgba }
}

export function encodePng(image: RGBAImage, maxPixels = MAX_TEXTURE_PIXELS): Uint8Array {
  if (image.width * image.height > maxPixels) fail('TEXTURE_LIMIT', '贴图像素超过限制。')
  if (image.data.length !== image.width * image.height * 4) fail('TEXTURE_INVALID', 'RGBA 数据长度与尺寸不一致。')
  return encode({ width: image.width, height: image.height, data: image.data, channels: 4 }, { interlace: 'null' })
}

export function decodeRgbaBase64(value: string, width: number, height: number): RGBAImage {
  const base64 = value.replace(/^data:image\/[a-z+]+;base64,/i, '').replace(/\s+/g, '')
  let bytes: Buffer
  try { bytes = Buffer.from(base64, 'base64') }
  catch { fail('TEXTURE_INVALID', '像素数据不是有效的 base64。') }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256) fail('TEXTURE_INVALID', '像素尺寸无效。')
  if (bytes.length !== width * height * 4) fail('TEXTURE_INVALID', `像素数据长度应为 ${width * height * 4}，实际 ${bytes.length}。`)
  return { width, height, data: new Uint8ClampedArray(bytes) }
}

export function encodeRgbaBase64(image: RGBAImage): string {
  return Buffer.from(image.data).toString('base64')
}

export function pngDataUrl(bytes: Uint8Array): string {
  return 'data:image/png;base64,' + Buffer.from(bytes).toString('base64')
}
