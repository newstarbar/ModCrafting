import { deflateSync } from 'node:zlib'

// Minimal deterministic PNG encoder (RGBA, filter 0, fixed deflate level). No timestamps.
const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let current = value
    for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
    table[value] = current >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let current = 0xffffffff
  for (const byte of data) current = crcTable[(current ^ byte) & 0xff] ^ (current >>> 8)
  return (current ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  out.writeUInt32BE(crc32(crcInput), 8 + data.length)
  return out
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error(`PNG_PIXEL_SIZE_MISMATCH: expected ${width * height * 4}, got ${rgba.length}`)
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8   // bit depth
  header[9] = 6   // color type RGBA
  header[10] = 0  // compression
  header[11] = 0  // filter
  header[12] = 0  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0))
  ])
}
