/**
 * A minimal, deterministic ZIP writer/reader.
 *
 * Packs need exactly one archive format and exactly two operations: write a set
 * of files, read them back to verify. Pulling in a general-purpose archiver
 * would add an install dependency for a job that fits in one file, and would
 * leave the output dependent on the dependency's version. Entries are written
 * sorted, uncompressed metadata is fixed to 1980-01-01, and deflate is fixed at
 * level 9, so exporting the same pack twice produces identical bytes.
 *
 * Deliberately unsupported: ZIP64, encryption, data descriptors, directories as
 * entries. Anything else is rejected instead of being half-read.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

export interface ZipInputEntry {
  /** Forward-slash path inside the archive. No leading slash, no `.`/`..` segments. */
  path: string
  data: string | Uint8Array
}

export interface ZipEntry {
  path: string
  data: Buffer
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const FLAG_UTF8 = 0x0800
const METHOD_DEFLATE = 8
const METHOD_STORE = 0
const MAX_ENTRIES = 4096
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_PATH_LENGTH = 512
const DOS_TIME = 0
const DOS_DATE = 0x21 // 1980-01-01

/**
 * Code-unit order, not `localeCompare`: a locale-sensitive sort would make the
 * archive bytes depend on the machine that produced them.
 */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

let crcTable: Uint32Array | undefined

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index++) {
      let value = index
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
      crcTable[index] = value >>> 0
    }
  }
  let crc = 0xFFFFFFFF
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function unsafePath(value: string): boolean {
  if (!value || value.length > MAX_PATH_LENGTH) return true
  if (value.includes('\\') || value.includes('\u0000')) return true
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return true
  return value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

export function createZip(entries: readonly ZipInputEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) fail('ZIP_TOO_LARGE', `压缩包条目超过 ${MAX_ENTRIES} 个，请拆分导出。`)
  const seen = new Set<string>()
  const prepared = entries
    .map((entry) => {
      if (unsafePath(entry.path)) fail('ZIP_PATH_UNSAFE', `压缩包路径不安全：${entry.path}。只允许包内相对路径。`)
      if (seen.has(entry.path)) fail('ZIP_DUPLICATE_PATH', `压缩包里有重复路径：${entry.path}。`)
      seen.add(entry.path)
      const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
      return { path: entry.path, name: Buffer.from(entry.path, 'utf8'), data }
    })
    .sort((left, right) => compareCodeUnits(left.path, right.path))

  const total = prepared.reduce((sum, entry) => sum + entry.data.length, 0)
  if (total > MAX_TOTAL_BYTES) fail('ZIP_TOO_LARGE', `压缩包解压后超过 ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)}MB，请精简配置覆盖层。`)

  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of prepared) {
    const compressed = deflateRawSync(entry.data, { level: 9 })
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(METHOD_DEFLATE, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(entry.name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, entry.name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(METHOD_DEFLATE, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(entry.name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, entry.name)

    offset += local.length + entry.name.length + compressed.length
  }

  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...centrals, eocd])
}

export function readZip(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) fail('ZIP_INVALID', '文件太小，不是有效的 ZIP。')
  const minimum = Math.max(0, buffer.length - 22 - 0xFFFF)
  let eocd = -1
  for (let index = buffer.length - 22; index >= minimum; index--) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) { eocd = index; break }
  }
  if (eocd < 0) fail('ZIP_INVALID', '找不到 ZIP 目录结尾，文件可能已损坏。')

  const count = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (count > MAX_ENTRIES) fail('ZIP_TOO_LARGE', `压缩包条目超过 ${MAX_ENTRIES} 个。`)
  if (centralOffset + centralSize > buffer.length || centralOffset >= buffer.length) {
    fail('ZIP_INVALID', 'ZIP 目录位置越界，文件可能已损坏。')
  }

  const entries: ZipEntry[] = []
  const seen = new Set<string>()
  let total = 0
  let cursor = centralOffset
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      fail('ZIP_INVALID', 'ZIP 目录条目损坏。')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compression = buffer.readUInt32LE(cursor + 20)
    const uncompressed = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if (flags & 0x0001) fail('ZIP_INVALID', '不支持加密 ZIP。')
    if (compression === 0xFFFFFFFF || uncompressed === 0xFFFFFFFF) fail('ZIP_INVALID', '不支持 ZIP64。')
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) fail('ZIP_INVALID', 'ZIP 条目名越界。')
    const name = buffer.subarray(nameStart, nameEnd).toString('utf8')
    if (unsafePath(name)) fail('ZIP_PATH_UNSAFE', `压缩包路径不安全：${name}。`)
    if (seen.has(name)) fail('ZIP_DUPLICATE_PATH', `压缩包里有重复路径：${name}。`)
    seen.add(name)

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      fail('ZIP_INVALID', `ZIP 条目 ${name} 的本地头损坏。`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compression
    if (dataEnd > buffer.length) fail('ZIP_INVALID', `ZIP 条目 ${name} 的数据越界。`)
    const raw = buffer.subarray(dataStart, dataEnd)
    let data: Buffer
    if (method === METHOD_STORE) data = Buffer.from(raw)
    else if (method === METHOD_DEFLATE) {
      try {
        data = inflateRawSync(raw)
      } catch (cause) {
        fail('ZIP_INVALID', `ZIP 条目 ${name} 解压失败：${(cause as Error).message}`)
      }
    } else {
      fail('ZIP_INVALID', `ZIP 条目 ${name} 使用了不支持的压缩方式 ${method}。`)
    }
    if (data.length !== uncompressed) fail('ZIP_INVALID', `ZIP 条目 ${name} 的长度与目录记录不一致。`)
    total += data.length
    if (total > MAX_TOTAL_BYTES) fail('ZIP_TOO_LARGE', '解压后体积超过限制。')
    cursor = nameEnd + extraLength + commentLength
    entries.push({ path: name, data })
  }

  return entries.sort((left, right) => compareCodeUnits(left.path, right.path))
}
