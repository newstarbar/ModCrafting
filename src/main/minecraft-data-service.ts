import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getRuntimeRoot } from './build-env'

/**
 * Minecraft 结构化数据查询服务。
 * 加载 resources/minecraft-data/<version>/index.json，提供按 ID / 口语名称查询方块、物品、实体、附魔属性。
 *
 * 路径优先级：runtime/knowledge/minecraft-data（按需下载） → process.resourcesPath → 开发态 resources/
 */

export interface McBlockProperties {
  id: string
  name: string
  zhName?: string
  hardness?: number
  resistance?: number
  stackSize: number
  tool?: string
  transparent?: boolean
  emitLight?: number
  filterLight?: number
  defaultState?: unknown
  states?: unknown
  drops?: unknown
}

export interface McItemProperties {
  id: string
  name: string
  zhName?: string
  stackSize: number
  maxDurability?: number
  enchantCategory?: unknown
}

export interface McEntityProperties {
  id: string
  internalId?: number
  name: string
  zhName?: string
  type?: string
  category?: string
  width?: number
  height?: number
  health?: number
  attack?: number
  passive?: boolean
}

export interface McEnchantmentProperties {
  id: string
  name: string
  zhName?: string
  maxLevel: number
  minLevel?: number
  applicableTo?: unknown
  weight?: number
}

interface McDataIndex {
  version: string
  builtAt: string
  counts: Record<string, number>
  blocksById: Record<string, McBlockProperties>
  blocksByEnName: Record<string, string>
  blocksByZhName: Record<string, string>
  itemsById: Record<string, McItemProperties>
  itemsByEnName: Record<string, string>
  itemsByZhName: Record<string, string>
  entitiesById: Record<string, McEntityProperties>
  entitiesByEnName: Record<string, string>
  entitiesByZhName: Record<string, string>
  enchantmentsById: Record<string, McEnchantmentProperties>
  enchantmentsByEnName: Record<string, string>
  enchantmentsByZhName: Record<string, string>
  recipesByResult: Record<string, unknown[]>
}

function bundledMinecraftDataRoot (): string {
  // 优先：runtime/knowledge/minecraft-data（瘦包二期按需下载目录）
  const runtimePath = path.join(getRuntimeRoot(), 'knowledge', 'minecraft-data')
  if (fs.existsSync(runtimePath)) return runtimePath
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'minecraft-data')
  }
  return path.join(app.getAppPath(), 'resources', 'minecraft-data')
}

function readDefaultVersion (): string {
  try {
    const versionsPath = path.join(
      app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'),
      'fabric-versions.json'
    )
    const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf-8'))
    return versions.minecraft_version || '1.21.4'
  } catch {
    return '1.21.4'
  }
}

const indexCache = new Map<string, McDataIndex | null>()

function loadIndex (version: string): McDataIndex | null {
  if (indexCache.has(version)) return indexCache.get(version) ?? null
  const indexPath = path.join(bundledMinecraftDataRoot(), version, 'index.json')
  try {
    if (!fs.existsSync(indexPath)) {
      indexCache.set(version, null)
      return null
    }
    const raw = fs.readFileSync(indexPath, 'utf-8')
    const parsed = JSON.parse(raw) as McDataIndex
    indexCache.set(version, parsed)
    return parsed
  } catch (err) {
    console.warn(`[minecraft-data] 加载索引失败 ${version}:`, err)
    indexCache.set(version, null)
    return null
  }
}

function resolveVersion (version?: string): string {
  return (version && version.trim()) || readDefaultVersion()
}

function normalizeQuery (query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

function lookupById<T> (byIdMap: Record<string, T>, query: string): T | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  const fullId = trimmed.startsWith('minecraft:') ? trimmed : `minecraft:${trimmed}`
  return byIdMap[fullId] || byIdMap[trimmed] || null
}

function lookupByAlias (
  byEnName: Record<string, string>,
  byZhName: Record<string, string>,
  byIdMap: Record<string, unknown>,
  query: string
): unknown | null {
  const normalized = normalizeQuery(query)
  if (!normalized) return null

  // 直接中文名命中
  const zhHit = byZhName[query] || byZhName[normalized]
  if (zhHit && byIdMap[zhHit]) return byIdMap[zhHit]

  // 英文名 / 简短 ID 命中
  const enHit = byEnName[normalized] || byEnName[query] || byEnName[normalized.replace(/ /g, '_')]
  if (enHit && byIdMap[enHit]) return byIdMap[enHit]

  // 去除后缀变体（钻石矿 → 钻石矿石）
  const variants = [
    query.replace(/矿石$/, '矿石'),
    query.replace(/矿$/, '矿石'),
    query.replace(/方块$/, ''),
    query.replace(/块$/, '')
  ]
  for (const v of variants) {
    if (v && v !== query) {
      const vHit = byZhName[v] || byZhName[v.toLowerCase()]
      if (vHit && byIdMap[vHit]) return byIdMap[vHit]
    }
  }

  // 模糊匹配：包含字符串
  for (const [zhName, id] of Object.entries(byZhName)) {
    if (zhName.includes(normalized) || normalized.includes(zhName.toLowerCase())) {
      if (byIdMap[id]) return byIdMap[id]
    }
  }
  return null
}

export function lookupBlockById (id: string, version?: string): McBlockProperties | null {
  const idx = loadIndex(resolveVersion(version))
  if (!idx) return null
  return lookupById(idx.blocksById, id)
}

export function lookupBlockByName (query: string, version?: string): McBlockProperties | null {
  const idx = loadIndex(resolveVersion(version))
  if (!idx) return null
  // 先试 ID
  const byId = lookupById(idx.blocksById, query)
  if (byId) return byId
  return lookupByAlias(idx.blocksByEnName, idx.blocksByZhName, idx.blocksById, query) as McBlockProperties | null
}

export function lookupItemById (id: string, version?: string): McItemProperties | null {
  const idx = loadIndex(resolveVersion(version))
  if (!idx) return null
  return lookupById(idx.itemsById, id)
}

export function lookupItemByName (query: string, version?: string): McItemProperties | null {
  const idx = loadIndex(resolveVersion(version))
  if (!idx) return null
  const byId = lookupById(idx.itemsById, query)
  if (byId) return byId
  return lookupByAlias(idx.itemsByEnName, idx.itemsByZhName, idx.itemsById, query) as McItemProperties | null
}

export function lookupEntityById (id: string, version?: string): McEntityProperties | null {
  const idx = loadIndex(resolveVersion(version))
  if (!idx) return null
  return lookupById(idx.entitiesById, id)
}

export function lookupEntityByName (query: string, version?: string): McEntityProperties | null {
  const idx = loadIndex(resolveVersion(version))
  if (!idx) return null
  const byId = lookupById(idx.entitiesById, query)
  if (byId) return byId
  return lookupByAlias(idx.entitiesByEnName, idx.entitiesByZhName, idx.entitiesById, query) as McEntityProperties | null
}

export function lookupEnchantment (query: string, version?: string): McEnchantmentProperties | null {
  const idx = loadIndex(resolveVersion(version))
  if (!idx) return null
  const byId = lookupById(idx.enchantmentsById, query)
  if (byId) return byId
  return lookupByAlias(idx.enchantmentsByEnName, idx.enchantmentsByZhName, idx.enchantmentsById, query) as McEnchantmentProperties | null
}

export function searchRecipes (itemId: string, version?: string): unknown[] {
  const idx = loadIndex(resolveVersion(version))
  if (!idx) return []
  const trimmed = itemId.trim()
  const fullId = trimmed.startsWith('minecraft:') ? trimmed : `minecraft:${trimmed}`
  return idx.recipesByResult[fullId] || idx.recipesByResult[trimmed] || []
}

export function getLoadedVersionInfo (): { version: string | null; counts: Record<string, number> | null } {
  const v = readDefaultVersion()
  const idx = loadIndex(v)
  if (!idx) return { version: null, counts: null }
  return { version: idx.version, counts: idx.counts }
}
