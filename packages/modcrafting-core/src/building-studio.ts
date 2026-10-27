import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import path from 'node:path'

export const STUDIO_PROTOCOL = 1
export const STUDIO_DISCOVERY = 'modcrafting-builder.json'
const ID = /^[a-z0-9_]{1,64}$/
const MAX_STRUCTURE_BYTES = 64 * 1024 * 1024
const STUDIO_API = /^\/v1\/studio\/(status|open|commit|apply|undo|exit|clear|teleport)$/

export class StudioError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'StudioError'; this.code = code }
}

export type StudioDiscovery = { port: number; token?: string; protocol?: number; modVersion?: string; dimension?: string }
export type StudioResult = { ok: boolean; status: number; data: Record<string, unknown>; error?: string }
export type StudioOutbox = { directory: string; structurePath: string; manifest: Record<string, unknown> }

export function studioRoot(gameDirectory: string): string {
  return path.join(gameDirectory, 'modcrafting-studio')
}

export function assertBuildId(value: string): string {
  if (!ID.test(value)) throw new StudioError('INVALID_BUILD_ID', 'buildId 必须是小写字母、数字或下划线（1-64 位）。')
  return value
}

export function readStudioDiscovery(gameDirectory: string): StudioDiscovery | null {
  try {
    const value = JSON.parse(readFileSync(path.join(gameDirectory, STUDIO_DISCOVERY), 'utf8')) as StudioDiscovery
    return typeof value.port === 'number' ? value : null
  } catch {
    return null
  }
}

export function isAllowedStudioApiPath(apiPath: string): boolean {
  return STUDIO_API.test(apiPath)
}

export async function studioRequest(discovery: StudioDiscovery, method: 'GET' | 'POST', apiPath: string, body?: Record<string, unknown>, timeoutMs = 120_000): Promise<StudioResult> {
  if (!isAllowedStudioApiPath(apiPath)) return { ok: false, status: 0, data: {}, error: 'studio path is not allowed' }
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : undefined
    const request = httpRequest({
      host: '127.0.0.1', port: discovery.port, path: apiPath, method, timeout: timeoutMs,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(discovery.token ? { authorization: `Bearer ${discovery.token}` } : {}) }
    }, (response) => {
      let text = ''
      response.on('data', (part) => { text += String(part) })
      response.on('end', () => {
        let data: Record<string, unknown> = {}
        try { data = JSON.parse(text) } catch { data = { text } }
        resolve({ ok: (response.statusCode || 500) < 400 && data.ok !== false, status: response.statusCode || 0, data, error: typeof data.error === 'string' ? data.error : undefined })
      })
    })
    request.on('error', (error) => resolve({ ok: false, status: 0, data: {}, error: String(error) }))
    request.on('timeout', () => request.destroy(new Error('studio request timed out')))
    if (payload) request.write(payload)
    request.end()
  })
}

export function prepareStudioInbox(gameDirectory: string, buildId: string, structurePath: string): { directory: string; structurePath: string; manifestPath: string; sha256: string; size: number } {
  assertBuildId(buildId)
  if (!path.isAbsolute(structurePath)) throw new StudioError('INVALID_STRUCTURE_PATH', '结构文件必须使用绝对路径。')
  const source = path.resolve(structurePath)
  if (!existsSync(source)) throw new StudioError('STRUCTURE_MISSING', '结构文件不存在：' + source)
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new StudioError('STRUCTURE_INVALID', '结构文件必须是普通文件，不能是链接。')
  if (sourceStat.size <= 0 || sourceStat.size > MAX_STRUCTURE_BYTES) throw new StudioError('STRUCTURE_INVALID', '结构文件大小必须在 1 字节到 64MB 之间。')
  const bytes = readFileSync(source)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const root = studioRoot(gameDirectory)
  const directory = path.join(root, 'inbox', buildId)
  ensureDirectory(root)
  ensureDirectory(path.join(root, 'inbox'))
  ensureDirectory(directory)
  const target = path.join(directory, 'structure.nbt')
  const manifest = path.join(directory, 'manifest.json')
  refuseLink(target)
  refuseLink(manifest)
  writeAtomic(target, bytes)
  writeAtomic(manifest, Buffer.from(JSON.stringify({ version: 1, buildId, sha256, size: bytes.length, createdAt: new Date().toISOString() }, null, 2) + '\n', 'utf8'))
  return { directory, structurePath: target, manifestPath: manifest, sha256, size: bytes.length }
}

export function readStudioOutbox(gameDirectory: string, buildId: string): StudioOutbox | null {
  assertBuildId(buildId)
  const directory = path.join(studioRoot(gameDirectory), 'outbox', buildId)
  const structurePath = path.join(directory, 'structure.nbt')
  const manifestPath = path.join(directory, 'manifest.json')
  if (!existsSync(structurePath) || !existsSync(manifestPath)) return null
  if (lstatSync(structurePath).isSymbolicLink() || lstatSync(manifestPath).isSymbolicLink()) throw new StudioError('STUDIO_PATH_UNSAFE', 'outbox 包含链接，已拒绝读取。')
  if (!statSync(structurePath).isFile() || statSync(structurePath).size > MAX_STRUCTURE_BYTES) throw new StudioError('STUDIO_OUTBOX_INVALID', 'outbox 结构文件无效或过大。')
  let manifest: Record<string, unknown> = {}
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> } catch { /* manifest is advisory; the structure file is authoritative */ }
  return { directory, structurePath, manifest }
}

function ensureDirectory(directory: string): void {
  if (existsSync(directory)) {
    const value = lstatSync(directory)
    if (value.isSymbolicLink() || !value.isDirectory()) throw new StudioError('STUDIO_PATH_UNSAFE', 'studio 目录不是普通目录。')
    return
  }
  mkdirSync(directory, { recursive: true })
}

function refuseLink(file: string): void {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new StudioError('STUDIO_PATH_UNSAFE', 'studio 文件是链接，已拒绝写入。')
}

function writeAtomic(target: string, bytes: Buffer): void {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' })
    renameSync(temporary, target)
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* best-effort cleanup */ }
  }
}
