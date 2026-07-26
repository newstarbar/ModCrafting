#!/usr/bin/env node
/**
 * 基于 minecraft-data JSON 构建快速查询索引（含中英文别名映射）。
 * 输出 resources/minecraft-data/<version>/index.json
 *
 * 用法：node scripts/knowledge/build-mc-data-index.mjs [--version=1.21.4]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..')

function parseArgs () {
  const args = { version: null }
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--version=(.+)$/)
    if (m) args.version = m[1]
  }
  return args
}

function readDefaultVersion () {
  try {
    const versions = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'fabric-versions.json'), 'utf-8'))
    return versions.minecraft_version || '1.21.4'
  } catch {
    return '1.21.4'
  }
}

function readJsonOrNull (filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function normalizeName (name) {
  if (!name) return ''
  return String(name).trim().toLowerCase().replace(/\s+/g, '_')
}

function buildBlockEntry (raw, langZh) {
  if (!raw) return null
  const id = raw.id || raw.name
  if (!id) return null
  const fullId = id.startsWith('minecraft:') ? id : `minecraft:${id}`
  const displayName = raw.displayName || raw.name || ''
  const zhName = langZh ? langZh[`block.${fullId.replace('minecraft:', '')}`] || langZh[`block.minecraft.${fullId.replace('minecraft:', '')}`] : undefined
  return {
    id: fullId,
    name: displayName,
    zhName: zhName || undefined,
    hardness: typeof raw.hardness === 'number' ? raw.hardness : (raw.resistance ? 0 : undefined),
    resistance: typeof raw.resistance === 'number' ? raw.resistance : undefined,
    stackSize: typeof raw.stackSize === 'number' ? raw.stackSize : 64,
    tool: raw.tool || undefined,
    transparent: Boolean(raw.transparent),
    emitLight: typeof raw.emitLight === 'number' ? raw.emitLight : undefined,
    filterLight: typeof raw.filterLight === 'number' ? raw.filterLight : undefined,
    defaultState: raw.defaultState || undefined,
    states: raw.states || undefined,
    drops: raw.drops || undefined
  }
}

function buildItemEntry (raw, langZh) {
  if (!raw) return null
  const id = raw.id || raw.name
  if (!id) return null
  const fullId = id.startsWith('minecraft:') ? id : `minecraft:${id}`
  const displayName = raw.displayName || raw.name || ''
  const zhName = langZh ? langZh[`item.${fullId.replace('minecraft:', '')}`] || langZh[`item.minecraft.${fullId.replace('minecraft:', '')}`] : undefined
  return {
    id: fullId,
    name: displayName,
    zhName: zhName || undefined,
    stackSize: typeof raw.stackSize === 'number' ? raw.stackSize : 64,
    maxDurability: typeof raw.maxDurability === 'number' ? raw.maxDurability : undefined,
    enchantCategory: raw.enchantCategories || undefined
  }
}

function buildEntityEntry (raw, langZh) {
  if (!raw) return null
  const id = raw.id || raw.name
  if (!id) return null
  const internalId = typeof raw.internalId === 'number' ? raw.internalId : undefined
  const displayName = raw.displayName || raw.name || ''
  const entityKey = raw.name ? `entity.minecraft.${raw.name}` : null
  const zhName = (langZh && entityKey) ? langZh[entityKey] : undefined
  return {
    id: typeof id === 'string' ? (id.startsWith('minecraft:') ? id : `minecraft:${id}`) : `minecraft:${displayName.toLowerCase().replace(/\s+/g, '_')}`,
    internalId,
    name: displayName,
    zhName: zhName || undefined,
    type: raw.type || undefined,
    category: raw.category || undefined,
    width: typeof raw.width === 'number' ? raw.width : undefined,
    height: typeof raw.height === 'number' ? raw.height : undefined,
    health: typeof raw.health === 'number' ? raw.health : (raw.attributes?.max_health?.base ?? undefined),
    attack: typeof raw.attack === 'number' ? raw.attack : (raw.attributes?.attack_damage?.base ?? undefined),
    passive: Boolean(raw.passive)
  }
}

function buildEnchantmentEntry (raw, langZh) {
  if (!raw) return null
  const id = raw.id || raw.name
  if (!id) return null
  const fullId = id.startsWith('minecraft:') ? id : `minecraft:${id}`
  const displayName = raw.displayName || raw.name || ''
  const enchKey = raw.name ? `enchantment.minecraft.${raw.name}` : null
  const zhName = (langZh && enchKey) ? langZh[enchKey] : undefined
  return {
    id: fullId,
    name: displayName,
    zhName: zhName || undefined,
    maxLevel: typeof raw.maxLevel === 'number' ? raw.maxLevel : 1,
    minLevel: typeof raw.minLevel === 'number' ? raw.minLevel : 1,
    applicableTo: raw.applicableTo || raw.items || undefined,
    weight: typeof raw.weight === 'number' ? raw.weight : undefined
  }
}

function buildByAliasMap (entries, valueExtractor) {
  // entries: [{ id, name, zhName, ... }]
  const byEnName = {}
  const byZhName = {}
  for (const entry of entries) {
    if (!entry) continue
    // 英文名变体
    if (entry.name) {
      const normalized = normalizeName(entry.name)
      byEnName[normalized] = entry.id
      byEnName[entry.name] = entry.id
      // 去掉下划线变体
      byEnName[normalized.replace(/_/g, '')] = entry.id
      byEnName[normalized.replace(/_/g, ' ')] = entry.id
    }
    // 简短 ID（不含 minecraft: 前缀）
    const shortId = entry.id.replace(/^minecraft:/, '')
    byEnName[shortId] = entry.id
    byEnName[shortId.toLowerCase()] = entry.id

    // 中文名
    if (entry.zhName) {
      byZhName[entry.zhName] = entry.id
      // 容错：去除"矿石"等后缀的变体（钻石矿石 → 钻石矿）
      const variants = [
        entry.zhName.replace(/矿石$/, '矿'),
        entry.zhName.replace(/方块$/, ''),
        entry.zhName.replace(/块$/, '')
      ]
      for (const v of variants) {
        if (v && v !== entry.zhName) byZhName[v] = entry.id
      }
    }
  }
  return { byEnName, byZhName }
}

function buildRecipesIndex (recipesRaw) {
  if (!Array.isArray(recipesRaw)) return { byResult: {} }
  const byResult = {}
  for (const recipe of recipesRaw) {
    const result = recipe.result || recipe.output
    const resultId = typeof result === 'string' ? result : result?.item || result?.id
    if (!resultId) continue
    const fullId = resultId.startsWith('minecraft:') ? resultId : `minecraft:${resultId}`
    if (!byResult[fullId]) byResult[fullId] = []
    byResult[fullId].push({
      type: recipe.type || 'shapeless',
      ingredients: recipe.ingredients || recipe.ingredient || recipe.inShape,
      result: { item: fullId, count: typeof result === 'object' ? (result.count || 1) : 1 }
    })
  }
  return { byResult }
}

async function main () {
  const args = parseArgs()
  const version = args.version || readDefaultVersion()
  const dataDir = path.join(ROOT, 'resources', 'minecraft-data', version)

  console.log(`构建索引：MC ${version}`)
  console.log(`数据目录：${path.relative(ROOT, dataDir)}`)

  if (!fs.existsSync(dataDir)) {
    console.error(`[fatal] 数据目录不存在，请先运行 npm run knowledge:fetch-data`)
    process.exit(1)
  }

  const blocksRaw = readJsonOrNull(path.join(dataDir, 'blocks.json')) || []
  const itemsRaw = readJsonOrNull(path.join(dataDir, 'items.json')) || []
  const entitiesRaw = readJsonOrNull(path.join(dataDir, 'entities.json')) || []
  const enchantmentsRaw = readJsonOrNull(path.join(dataDir, 'enchantments.json')) || []
  const recipesRaw = readJsonOrNull(path.join(dataDir, 'recipes.json')) || []
  const langZh = readJsonOrNull(path.join(dataDir, 'lang', 'zh_cn.json')) || {}
  const langEn = readJsonOrNull(path.join(dataDir, 'lang', 'en_us.json')) || {}

  console.log(`原始数据：blocks=${blocksRaw.length}, items=${itemsRaw.length}, entities=${entitiesRaw.length}, ench=${enchantmentsRaw.length}, recipes=${Array.isArray(recipesRaw) ? recipesRaw.length : 'n/a'}`)

  const blocks = blocksRaw.map((b) => buildBlockEntry(b, langZh)).filter(Boolean)
  const items = itemsRaw.map((i) => buildItemEntry(i, langZh)).filter(Boolean)
  const entities = entitiesRaw.map((e) => buildEntityEntry(e, langZh)).filter(Boolean)
  const enchantments = enchantmentsRaw.map((e) => buildEnchantmentEntry(e, langZh)).filter(Boolean)

  const blocksById = {}
  for (const b of blocks) blocksById[b.id] = b
  const itemsById = {}
  for (const i of items) itemsById[i.id] = i
  const entitiesById = {}
  for (const e of entities) entitiesById[e.id] = e
  const enchantmentsById = {}
  for (const e of enchantments) enchantmentsById[e.id] = e

  const blockAliases = buildByAliasMap(blocks)
  const itemAliases = buildByAliasMap(items)
  const entityAliases = buildByAliasMap(entities)
  const enchAliases = buildByAliasMap(enchantments)

  const recipesIndex = buildRecipesIndex(recipesRaw)

  const index = {
    version,
    builtAt: new Date().toISOString(),
    counts: {
      blocks: blocks.length,
      items: items.length,
      entities: entities.length,
      enchantments: enchantments.length,
      recipes: Object.keys(recipesIndex.byResult).length
    },
    blocksById,
    blocksByEnName: blockAliases.byEnName,
    blocksByZhName: blockAliases.byZhName,
    itemsById,
    itemsByEnName: itemAliases.byEnName,
    itemsByZhName: itemAliases.byZhName,
    entitiesById,
    entitiesByEnName: entityAliases.byEnName,
    entitiesByZhName: entityAliases.byZhName,
    enchantmentsById,
    enchantmentsByEnName: enchAliases.byEnName,
    enchantmentsByZhName: enchAliases.byZhName,
    recipesByResult: recipesIndex.byResult
  }

  const outPath = path.join(dataDir, 'index.json')
  fs.writeFileSync(outPath, JSON.stringify(index, null, 2), 'utf-8')
  console.log(`\n[done] 索引已生成: ${path.relative(ROOT, outPath)}`)
  console.log(`  方块: ${index.counts.blocks} 条，别名映射 ${Object.keys(index.blocksByZhName).length} 中文 / ${Object.keys(index.blocksByEnName).length} 英文`)
  console.log(`  物品: ${index.counts.items} 条`)
  console.log(`  实体: ${index.counts.entities} 条`)
  console.log(`  附魔: ${index.counts.enchantments} 条`)
  console.log(`  配方: ${index.counts.recipes} 个产物`)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
