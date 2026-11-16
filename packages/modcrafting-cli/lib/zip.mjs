/**
 * Minimal, dependency-free ZIP reader (and a store-only writer for tests).
 *
 * Node 22 ships zlib.inflateRawSync and (since 22.2) zlib.crc32, but no ZIP
 * container API, so the central directory is parsed by hand. Every entry is
 * validated before anything is written; one unsafe entry rejects the archive.
 */
import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

const MAX_ENTRY = 100 * 1024 * 1024
const MAX_TOTAL = 250 * 1024 * 1024
const MAX_RATIO = 200
const MAX_DEPTH = 12
const MAX_NAME = 255

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

function crc32(bytes) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(bytes) >>> 0
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      table[index] = value
    }
  }
  let crc = -1
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  return (crc ^ -1) >>> 0
}

function corrupt(message) {
  return Object.assign(new Error(`ZIP 校验失败：${message}`), { code: 'BUNDLE_INVALID' })
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset
  }
  throw corrupt('找不到中央目录结尾（文件不是有效 ZIP 或被截断）')
}

function readZip64(buffer, eocd) {
  const locator = eocd - 20
  if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) throw corrupt('需要 ZIP64 但缺少定位记录')
  const record = Number(buffer.readBigUInt64LE(locator + 8))
  if (record + 56 > buffer.length || buffer.readUInt32LE(record) !== ZIP64_EOCD_SIG) throw corrupt('ZIP64 结构损坏')
  return {
    entries: Number(buffer.readBigUInt64LE(record + 32)),
    cdSize: Number(buffer.readBigUInt64LE(record + 40)),
    cdOffset: Number(buffer.readBigUInt64LE(record + 48))
  }
}

function readZip64Extra(buffer, start, length, entry) {
  let offset = start
  const end = start + length
  while (offset + 4 <= end) {
    const id = buffer.readUInt16LE(offset)
    const size = buffer.readUInt16LE(offset + 2)
    const body = offset + 4
    if (id === 0x0001) {
      let cursor = body
      if (entry.uncompressed === 0xffffffff && cursor + 8 <= body + size) { entry.uncompressed = Number(buffer.readBigUInt64LE(cursor)); cursor += 8 }
      if (entry.compressed === 0xffffffff && cursor + 8 <= body + size) { entry.compressed = Number(buffer.readBigUInt64LE(cursor)); cursor += 8 }
      if (entry.localOffset === 0xffffffff && cursor + 8 <= body + size) { entry.localOffset = Number(buffer.readBigUInt64LE(cursor)) }
    }
    offset = body + size
  }
}

export function assertSafeEntryName(name) {
  if (typeof name !== 'string' || !name) throw corrupt('条目名为空')
  if (name.length > MAX_NAME) throw corrupt(`条目名过长：${name.slice(0, 40)}…`)
  if (name.includes('\0')) throw corrupt('条目名包含 NUL')
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw corrupt(`条目使用绝对路径：${name}`)
  const parts = normalized.split('/').filter((part) => part !== '')
  if (parts.some((part) => part === '..' || part === '.')) throw corrupt(`条目包含路径穿越：${name}`)
  if (parts.length > MAX_DEPTH) throw corrupt(`条目层级过深：${name}`)
  for (const part of parts) {
    if (WINDOWS_RESERVED.test(part)) throw corrupt(`条目使用 Windows 保留名：${name}`)
    if (/[. ]$/.test(part)) throw corrupt(`条目名以点或空格结尾：${name}`)
  }
  return parts.join('/')
}

export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw corrupt('文件太小')
  const eocd = findEocd(buffer)
  let { entries, cdOffset } = {
    entries: buffer.readUInt16LE(eocd + 10),
    cdSize: buffer.readUInt32LE(eocd + 12),
    cdOffset: buffer.readUInt32LE(eocd + 16)
  }
  if (entries === 0xffff || cdOffset === 0xffffffff) ({ entries, cdOffset } = readZip64(buffer, eocd))
  if (entries > 5000) throw corrupt(`条目过多：${entries}`)

  const files = new Map()
  let total = 0
  let offset = cdOffset
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) throw corrupt(`中央目录第 ${index + 1} 条损坏`)
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const expectedCrc = buffer.readUInt32LE(offset + 16)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const external = buffer.readUInt32LE(offset + 38)
    const entry = {
      uncompressed: buffer.readUInt32LE(offset + 24),
      compressed: buffer.readUInt32LE(offset + 20),
      localOffset: buffer.readUInt32LE(offset + 42)
    }
    const rawName = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8')
    readZip64Extra(buffer, offset + 46 + nameLength, extraLength, entry)
    offset += 46 + nameLength + extraLength + commentLength

    if (flags & 0x1) throw corrupt(`条目已加密：${rawName}`)
    if (method !== 0 && method !== 8) throw corrupt(`不支持的压缩方式 ${method}：${rawName}`)
    if ((external >>> 16) === 0xa000) throw corrupt(`条目是符号链接：${rawName}`)
    if (entry.uncompressed > MAX_ENTRY) throw corrupt(`条目超过 100MB：${rawName}`)
    total += entry.uncompressed
    if (total > MAX_TOTAL) throw corrupt('解压后总大小超过 250MB')
    if (entry.compressed > 0 && entry.uncompressed / entry.compressed > MAX_RATIO) throw corrupt(`压缩比异常：${rawName}`)

    const name = assertSafeEntryName(rawName)
    if (name.endsWith('/')) continue
    if (files.has(name)) throw corrupt(`重复条目：${name}`)

    const local = entry.localOffset
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIG) throw corrupt(`本地头损坏：${name}`)
    const localName = buffer.readUInt16LE(local + 26)
    const localExtra = buffer.readUInt16LE(local + 28)
    const start = local + 30 + localName + localExtra
    const data = buffer.slice(start, start + entry.compressed)
    if (data.length !== entry.compressed) throw corrupt(`数据被截断：${name}`)
    let bytes
    if (method === 0) bytes = Buffer.from(data)
    else {
      try { bytes = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }) } catch { throw corrupt(`解压失败：${name}`) }
    }
    if (bytes.length !== entry.uncompressed) throw corrupt(`解压长度不符：${name}`)
    if (crc32(bytes) !== expectedCrc) throw corrupt(`CRC 校验失败：${name}`)
    files.set(name, bytes)
  }
  return files
}

/** Store-only writer used by the test suite and the offline packager. */
export function createZip(entries) {
  const list = [...entries].map(([name, value]) => {
    const safe = assertSafeEntryName(name)
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    return { name: safe, bytes }
  })
  if (!list.length) throw new Error('ZIP 不能为空')
  const locals = []
  const centrals = []
  let offset = 0
  for (const item of list) {
    const nameBytes = Buffer.from(item.name, 'utf8')
    const crc = crc32(item.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(item.bytes.length, 18)
    local.writeUInt32LE(item.bytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, item.bytes)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(item.bytes.length, 20)
    central.writeUInt32LE(item.bytes.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + item.bytes.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(list.length, 8)
  eocd.writeUInt16LE(list.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuffer, eocd])
}
