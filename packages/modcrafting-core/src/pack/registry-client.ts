/**
 * HTTP, caching and throttling for the two mod catalogues.
 *
 * The rest of the pack pipeline never calls `fetch`. It depends on the small
 * `RegistryReader` interface below, which is why every discovery and solver test
 * can run offline against recorded fixtures.
 *
 * Cache policy: the *raw* response is cached, not the normalized model, so a
 * normalization fix does not require invalidating everyone's cache. A cache hit
 * is keyed by the exact route plus parameters; a 5xx or a dropped connection
 * falls back to a cached response rather than turning a transient outage into
 * "no mods exist".
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { LoaderId } from '../version/schema.ts'
import type { RegistryId } from '../workspace-model.ts'
import { curseforgeFiles, curseforgeMod, curseforgeSearch } from './adapters/curseforge.ts'
import { modrinthProject, modrinthSearch, modrinthVersions } from './adapters/modrinth.ts'
import type { RegistryProject, RegistryVersion } from './registry-model.ts'

const MODRINTH_API = 'https://api.modrinth.com/v2'
const CURSEFORGE_API = 'https://api.curseforge.com/v1'
const LOADER_TYPES: Readonly<Record<LoaderId, number>> = { fabric: 4, neoforge: 6, forge: 1 }
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_MIN_INTERVAL_MS = 250
const REQUEST_TIMEOUT_MS = 20_000

export interface RegistrySearchInput {
  registry: RegistryId
  query: string
  loader?: LoaderId
  gameVersion?: string
  limit?: number
  offset?: number
}

export interface RegistryVersionsInput {
  registry: RegistryId
  projectId: string
  loader?: LoaderId
  gameVersion?: string
}

export interface RegistryReader {
  search(input: RegistrySearchInput): Promise<RegistryProject[]>
  versions(input: RegistryVersionsInput): Promise<RegistryVersion[]>
  project(input: { registry: RegistryId; projectId: string }): Promise<RegistryProject>
}

export interface RegistryClientOptions {
  /** Directory for the raw-response cache. Created on first write. */
  cacheRoot: string
  fetchImpl?: typeof fetch
  ttlMs?: number
  /** Minimum spacing between requests to the same registry. */
  minIntervalMs?: number
  curseforgeApiKey?: string
  userAgent?: string
  now?: () => number
  /** Never touch the network; a cache miss is an error, not a request. */
  offline?: boolean
}

export class RegistryError extends Error {
  readonly code: string
  readonly remediation: string
  constructor(code: string, message: string, remediation: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
    this.remediation = remediation
  }
}

interface CacheEntry {
  fetchedAt: number
  value: unknown
}

function readCache(file: string): CacheEntry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheEntry>
    return typeof parsed.fetchedAt === 'number' && 'value' in parsed ? parsed as CacheEntry : undefined
  } catch {
    return undefined
  }
}

function writeCache(file: string, entry: CacheEntry): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(entry), 'utf8')
  renameSync(temporary, file)
}

function cacheKey(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function clampLimit(value: number | undefined): number {
  const limit = value ?? 10
  return Math.min(50, Math.max(1, Math.trunc(limit)))
}

function clampOffset(value: number | undefined): number {
  return Math.max(0, Math.trunc(value ?? 0))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createRegistryClient(options: RegistryClientOptions): RegistryReader {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const offline = options.offline === true
  const userAgent = options.userAgent ?? 'ModCrafting Fabric plugin'
  const apiKey = options.curseforgeApiKey?.trim() ?? ''
  const lastCall = new Map<RegistryId, number>()

  async function fetchJson(registry: RegistryId, url: string, keyParts: readonly unknown[]): Promise<unknown> {
    const file = path.join(options.cacheRoot, registry, `${cacheKey([registry, ...keyParts])}.json`)
    const cached = readCache(file)
    if (cached && (offline || now() - cached.fetchedAt < ttlMs)) return cached.value
    if (offline) {
      throw new RegistryError('REGISTRY_OFFLINE', `${registry} 没有可用的离线缓存。`, `联网后再检索一次；缓存目录：${path.dirname(file)}`)
    }
    if (registry === 'curseforge' && !apiKey) {
      throw new RegistryError(
        'REGISTRY_MISSING_KEY',
        'CurseForge 检索需要 API Key。',
        '设置环境变量 MODCRAFTING_CURSEFORGE_API_KEY（或 CURSEFORGE_API_KEY）后重启插件；也可以先把 registries 设为 ["modrinth"]。'
      )
    }

    const wait = minIntervalMs - (now() - (lastCall.get(registry) ?? 0))
    if (wait > 0) await sleep(wait)
    lastCall.set(registry, now())

    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: {
          'user-agent': userAgent,
          accept: 'application/json',
          ...(registry === 'curseforge' ? { 'x-api-key': apiKey } : {})
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (cause) {
      if (cached) return cached.value
      throw new RegistryError(
        'REGISTRY_OFFLINE',
        `无法连接 ${registry}：${cause instanceof Error ? cause.message : String(cause)}`,
        '检查网络或代理后重试；已经缓存过的检索仍可离线使用。'
      )
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new RegistryError(
          'REGISTRY_UNAUTHORIZED',
          `${registry} 拒绝了请求（HTTP ${response.status}）。`,
          registry === 'curseforge' ? '检查 CurseForge API Key 是否有效，或先只用 Modrinth。' : '稍后重试。'
        )
      }
      if (response.status === 429) {
        throw new RegistryError(
          'REGISTRY_RATE_LIMITED',
          `${registry} 触发限流（HTTP 429）。`,
          '等待一分钟再试，或减少检索关键词；限流不是“没有结果”。'
        )
      }
      if (cached && response.status >= 500) return cached.value
      throw new RegistryError('REGISTRY_HTTP', `${registry} 返回 HTTP ${response.status}。`, '稍后重试；如果持续失败，查看插件日志中的响应摘要。')
    }

    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new RegistryError('REGISTRY_INVALID_RESPONSE', `${registry} 返回的不是 JSON。`, '稍后重试；如果持续失败，可能是接口变更。')
    }
    writeCache(file, { fetchedAt: now(), value })
    return value
  }

  async function project(input: { registry: RegistryId; projectId: string }): Promise<RegistryProject> {
    if (input.registry === 'modrinth') {
      const raw = await fetchJson('modrinth', `${MODRINTH_API}/project/${encodeURIComponent(input.projectId)}`, ['project', input.projectId])
      return modrinthProject(raw)
    }
    const raw = await fetchJson('curseforge', `${CURSEFORGE_API}/mods/${encodeURIComponent(input.projectId)}`, ['project', input.projectId])
    return curseforgeMod(raw)
  }

  async function search(input: RegistrySearchInput): Promise<RegistryProject[]> {
    const limit = clampLimit(input.limit)
    const offset = clampOffset(input.offset)
    if (input.registry === 'modrinth') {
      const facets: string[][] = [['project_type:mod']]
      if (input.loader) facets.push([`categories:${input.loader}`])
      if (input.gameVersion) facets.push([`versions:${input.gameVersion}`])
      const parameters = new URLSearchParams({
        query: input.query,
        limit: String(limit),
        offset: String(offset),
        facets: JSON.stringify(facets)
      })
      const raw = await fetchJson('modrinth', `${MODRINTH_API}/search?${parameters}`, ['search', input.query, input.loader ?? '', input.gameVersion ?? '', limit, offset])
      return modrinthSearch(raw)
    }

    const parameters = new URLSearchParams({
      gameId: '432',
      classId: '6',
      searchFilter: input.query,
      sortField: '2',
      sortOrder: 'desc',
      pageSize: String(limit),
      index: String(offset)
    })
    if (input.gameVersion) parameters.set('gameVersion', input.gameVersion)
    if (input.loader) parameters.set('modLoaderType', String(LOADER_TYPES[input.loader]))
    const raw = await fetchJson('curseforge', `${CURSEFORGE_API}/mods/search?${parameters}`, ['search', input.query, input.loader ?? '', input.gameVersion ?? '', limit, offset])
    return curseforgeSearch(raw)
  }

  async function versions(input: RegistryVersionsInput): Promise<RegistryVersion[]> {
    if (input.registry === 'modrinth') {
      const parameters = new URLSearchParams()
      if (input.loader) parameters.set('loaders', JSON.stringify([input.loader]))
      if (input.gameVersion) parameters.set('game_versions', JSON.stringify([input.gameVersion]))
      const raw = await fetchJson(
        'modrinth',
        `${MODRINTH_API}/project/${encodeURIComponent(input.projectId)}/version?${parameters}`,
        ['versions', input.projectId, input.loader ?? '', input.gameVersion ?? '']
      )
      const owner = await project({ registry: 'modrinth', projectId: input.projectId })
      return modrinthVersions(raw, owner)
    }

    const owner = await project({ registry: 'curseforge', projectId: input.projectId })
    const parameters = new URLSearchParams({ pageSize: '50' })
    if (input.gameVersion) parameters.set('gameVersion', input.gameVersion)
    if (input.loader) parameters.set('modLoaderType', String(LOADER_TYPES[input.loader]))
    const raw = await fetchJson(
      'curseforge',
      `${CURSEFORGE_API}/mods/${encodeURIComponent(input.projectId)}/files?${parameters}`,
      ['files', input.projectId, input.loader ?? '', input.gameVersion ?? '']
    )
    return curseforgeFiles(raw, owner)
  }

  return { search, versions, project }
}
