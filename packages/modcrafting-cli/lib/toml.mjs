/**
 * Surgical TOML editing for Codex' ~/.codex/config.toml.
 *
 * We never parse/serialise the whole document: only the
 * [mcp_servers.<name>] and [mcp_servers.<name>.env] blocks are replaced, so
 * comments, ordering and unrelated tables survive byte for byte.
 */
import { detectEol } from './fsx.mjs'

const MAX_BYTES = 1024 * 1024

function splitKeyPath(raw) {
  const parts = []
  let current = ''
  let quote = null
  for (const character of raw) {
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '.') { parts.push(current.trim()); current = ''; continue }
    current += character
  }
  parts.push(current.trim())
  return parts.filter((part) => part.length > 0)
}

function headerPath(line) {
  if (!/^\s*\[/.test(line)) return null
  if (/^\s*\[\[/.test(line)) return { arrayTable: true, path: null }
  const match = /^\s*\[([^\]]+)\]/.exec(line)
  if (!match) return null
  return { arrayTable: false, path: splitKeyPath(match[1]) }
}

function samePath(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((part, index) => part === b[index])
}

function startsWithPath(path, prefix) {
  return path.length > prefix.length && prefix.every((part, index) => part === path[index])
}

function bareKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

function tomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  throw new Error(`不支持的 TOML 值类型：${typeof value}`)
}

export function renderServerBlock(name, entry) {
  const table = `mcp_servers.${bareKey(name)}`
  const lines = [`[${table}]`]
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'env' || value === undefined) continue
    lines.push(`${bareKey(key)} = ${tomlValue(value)}`)
  }
  const env = Object.entries(entry.env ?? {})
  if (env.length) {
    lines.push('', `[${table}.env]`)
    for (const [key, value] of env) lines.push(`${bareKey(key)} = ${tomlValue(value)}`)
  }
  return lines.join('\n')
}

function conflict(reason, name) {
  return Object.assign(
    new Error(`${reason}\n安装器没有改动 ~/.codex/config.toml。请手动添加：\n\n${renderServerBlock(name, { command: 'node', args: ['<path>/dist/mcp-server.js'] })}\n或运行 codex mcp add。`),
    { code: 'CONFIG_CONFLICT' }
  )
}

function scan(body, name) {
  const lines = body.split(/\r?\n/)
  const headers = []
  lines.forEach((line, index) => {
    const parsed = headerPath(line)
    if (parsed) headers.push({ index, ...parsed })
  })
  const target = ['mcp_servers', name]
  const envTarget = [...target, 'env']
  const main = headers.filter((header) => header.path && samePath(header.path, target))
  const env = headers.filter((header) => header.path && samePath(header.path, envTarget))
  const children = headers.filter((header) => header.path && startsWithPath(header.path, target) && !samePath(header.path, envTarget))
  return { lines, headers, main, env, children }
}

function rangeOf(lines, headers, header) {
  const next = headers.find((candidate) => candidate.index > header.index)
  const end = next ? next.index - 1 : lines.length - 1
  return [header.index, end]
}

function removeRanges(lines, ranges) {
  const drop = new Set()
  for (const [start, end] of ranges) for (let index = start; index <= end; index += 1) drop.add(index)
  return lines.filter((_, index) => !drop.has(index))
}

function tidy(lines) {
  const output = []
  for (const line of lines) {
    if (line.trim() === '') {
      if (!output.length) continue
      if (output[output.length - 1].trim() === '') continue
    }
    output.push(line)
  }
  while (output.length && output[output.length - 1].trim() === '') output.pop()
  return output
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function upsertServerBlock(input, name, entry) {
  const text = stripBom(input)
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw conflict('config.toml 超过 1MB，拒绝自动编辑', name)
  const eol = detectEol(text)
  const body = text.replace(/\r\n/g, '\n')
  const block = renderServerBlock(name, entry)

  if (/^\s*mcp_servers\s*=/m.test(body)) throw conflict('config.toml 使用了 mcp_servers 内联表，无法安全自动编辑', name)
  if (/^\s*(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*\./m.test(body)) throw conflict('config.toml 使用了 mcp_servers 点号键，无法安全自动编辑', name)

  const scan1 = scan(body, name)
  if (scan1.main.length > 1) throw conflict('[mcp_servers.modcrafting-fabric] 出现了多次，无法判断以哪个为准', name)
  if (scan1.env.length > 1) throw conflict('[mcp_servers.modcrafting-fabric.env] 出现了多次，无法判断以哪个为准', name)
  if (scan1.main.length === 1 && scan1.env.length === 0 && scan1.children.length) {
    // Children such as .timeouts are fine; they stay untouched.
  }

  const existing = readServerBlock(body, name)
  if (existing && existing === block.trim()) return { text, changed: false, block }

  const ranges = [...scan1.main, ...scan1.env].map((header) => rangeOf(scan1.lines, scan1.headers, header))
  const insertAt = scan1.main.length ? Math.min(...ranges.map(([start]) => start)) : scan1.lines.length
  const kept = removeRanges(scan1.lines, ranges)
  const lines = [...kept]
  const insertion = block.split('\n')
  if (insertAt > 0 && lines[insertAt - 1] !== undefined && lines[insertAt - 1].trim() !== '') insertion.unshift('')
  if (lines[insertAt] !== undefined && lines[insertAt].trim() !== '') insertion.push('')
  lines.splice(insertAt, 0, ...insertion)
  const tidyLines = tidy(lines)
  const next = tidyLines.join('\n') + '\n'
  if (next === text) return { text, changed: false, block }
  return { text: eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next, changed: true, block }
}

export function removeServerBlock(input, name) {
  const text = stripBom(input)
  const eol = detectEol(text)
  const body = text.replace(/\r\n/g, '\n')
  const scan1 = scan(body, name)
  const targets = [...scan1.main, ...scan1.env, ...scan1.children]
  if (!targets.length) return { text, changed: false }
  const ranges = targets.map((header) => rangeOf(scan1.lines, scan1.headers, header))
  const lines = tidy(removeRanges(scan1.lines, ranges))
  const next = lines.length ? lines.join('\n') + '\n' : ''
  return { text: eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next, changed: true }
}

/** Extract the current block text (main table plus its env child), for `doctor`. */
export function readServerBlock(input, name) {
  const body = stripBom(input).replace(/\r\n/g, '\n')
  const scan1 = scan(body, name)
  const targets = [...scan1.main, ...scan1.env]
  if (!targets.length) return undefined
  const ranges = targets.map((header) => rangeOf(scan1.lines, scan1.headers, header)).sort((a, b) => a[0] - b[0])
  const start = ranges[0][0]
  const end = Math.max(...ranges.map(([, value]) => value))
  return scan1.lines.slice(start, end + 1).join('\n').trim()
}
