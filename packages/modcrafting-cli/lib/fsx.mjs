/** Filesystem primitives shared by every command: no dependency, no surprises. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function exists(file) {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function statSafe(file) {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Refuse to write through a junction/symlink and refuse to clobber a hard link.
 * Mirrors the guard already used by scripts/plugin/host-config.mjs.
 */
export function assertWritablePath(file) {
  let current = path.resolve(file)
  while (true) {
    const stat = statSafe(current)
    if (stat) {
      if (stat.isSymbolicLink()) throw Object.assign(new Error(`拒绝写入符号链接/junction：${current}`), { code: 'UNSAFE_PATH' })
      if (stat.isFile() && stat.nlink > 1) throw Object.assign(new Error(`拒绝写入硬链接文件：${current}`), { code: 'UNSAFE_PATH' })
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

export function readText(file) {
  const stat = statSafe(file)
  if (!stat) return { exists: false, text: '', stat: undefined }
  if (stat.isSymbolicLink()) throw Object.assign(new Error(`拒绝读取符号链接：${file}`), { code: 'UNSAFE_PATH' })
  if (!stat.isFile()) throw Object.assign(new Error(`不是普通文件：${file}`), { code: 'UNSAFE_PATH' })
  return { exists: true, text: fs.readFileSync(file, 'utf8'), stat }
}

export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function atomicWrite(file, text) {
  const directory = path.dirname(file)
  ensureDir(directory)
  const temporary = path.join(directory, `.${path.basename(file)}.modcrafting-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx' })
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

/** Copy `file` into `directory` with a timestamped name, keeping the newest `keep`. */
export function backupFile(file, directory, keep = 5) {
  if (!exists(file)) return undefined
  ensureDir(directory)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(directory, `${path.basename(file)}.${stamp}.bak`)
  fs.copyFileSync(file, target)
  const prefix = `${path.basename(file)}.`
  const backups = fs.readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith('.bak')).sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) fs.rmSync(path.join(directory, name), { force: true })
  return target
}

export function readJson(file, { allowEmpty = true } = {}) {
  const { exists: present, text } = readText(file)
  if (!present) return { exists: false, data: {}, text: '', eol: '\n', bom: false }
  const bom = text.charCodeAt(0) === 0xfeff
  const body = stripBom(text)
  if (!body.trim()) {
    if (!allowEmpty) throw Object.assign(new Error(`配置文件为空：${file}`), { code: 'CONFIG_INVALID' })
    return { exists: true, data: {}, text, eol: detectEol(body), bom }
  }
  let data
  try {
    data = JSON.parse(body)
  } catch (cause) {
    throw Object.assign(new Error(`无法解析 JSON 配置 ${file}：${cause.message}。请先修好该文件，安装器不会覆盖它。`), { code: 'CONFIG_INVALID', file })
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw Object.assign(new Error(`JSON 配置的顶层必须是对象：${file}`), { code: 'CONFIG_INVALID', file })
  }
  return { exists: true, data, text, eol: detectEol(body), bom }
}

/** Detect the indentation used by an existing JSON document. */
export function detectIndent(text) {
  const match = /\n([ \t]+)"/.exec(text)
  if (!match) return '  '
  return match[1].includes('\t') ? '\t' : match[1]
}

export function serializeJson(data, { eol, indent }) {
  return JSON.stringify(data, null, indent).replace(/\n/g, eol) + eol
}

export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function removeIfEmpty(directory) {
  try {
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
  } catch { /* not empty or missing */ }
}

export function copyTree(from, to) {
  ensureDir(to)
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isSymbolicLink()) throw Object.assign(new Error(`bundle 内含符号链接：${source}`), { code: 'BUNDLE_INVALID' })
    if (entry.isDirectory()) copyTree(source, target)
    else if (entry.isFile()) fs.copyFileSync(source, target)
    else throw Object.assign(new Error(`bundle 内含特殊文件：${source}`), { code: 'BUNDLE_INVALID' })
  }
}
