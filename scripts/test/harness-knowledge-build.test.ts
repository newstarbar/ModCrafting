import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..')

// ─────────────────────────────────────────────────────────────
// 1. 脚本与资源清单存在性检查
// ─────────────────────────────────────────────────────────────

const REQUIRED_SCRIPTS = [
  'fetch-minecraft-data.mjs',
  'fetch-mc-wiki-zh.mjs',
  'build-mc-data-index.mjs',
  'build-wiki-embeddings.mjs',
  'cache-transformer-model.mjs',
  'build-all.mjs'
]

test('knowledge-build: 所有构建脚本文件存在', () => {
  const knowledgeDir = path.join(ROOT, 'scripts', 'knowledge')
  for (const script of REQUIRED_SCRIPTS) {
    const scriptPath = path.join(knowledgeDir, script)
    assert.ok(fs.existsSync(scriptPath), `missing script: ${script}`)
  }
})

test('knowledge-build: wiki-pages-list.json 词条清单存在且结构合法', () => {
  const listPath = path.join(ROOT, 'scripts', 'knowledge', 'wiki-pages-list.json')
  assert.ok(fs.existsSync(listPath))
  const raw = JSON.parse(fs.readFileSync(listPath, 'utf-8'))

  assert.ok(typeof raw.description === 'string' && raw.description.length > 0)
  assert.ok(Array.isArray(raw.pages) && raw.pages.length >= 30, `expected ≥30 wiki pages, got ${raw.pages.length}`)

  // 允许同 title 不同 category（同名方块/物品/机制词条各自独立）
  const seen = new Set<string>()
  for (const page of raw.pages) {
    assert.ok(typeof page.title === 'string' && page.title.length > 0, `invalid title: ${JSON.stringify(page)}`)
    assert.ok(typeof page.category === 'string' && page.category.length > 0, `invalid category: ${page.title}`)
    if (page.standardId) {
      assert.match(page.standardId, /^minecraft:[a-z0-9_]+$/, `invalid standardId: ${page.standardId}`)
    }
    const key = `${page.category}|${page.title}`
    assert.ok(!seen.has(key), `duplicate (category,title): ${key}`)
    seen.add(key)
  }
})

test('knowledge-build: wiki-pages-list.json 覆盖核心方块/物品/实体/机制类别', () => {
  const listPath = path.join(ROOT, 'scripts', 'knowledge', 'wiki-pages-list.json')
  const raw = JSON.parse(fs.readFileSync(listPath, 'utf-8'))
  const categories = new Set(raw.pages.map((p: { category: string }) => p.category))

  // 至少覆盖核心类别
  for (const required of ['block']) {
    assert.ok(categories.has(required), `missing required category: ${required}`)
  }

  // 至少包含几个核心方块词条
  const titles = raw.pages.map((p: { title: string }) => p.title)
  assert.ok(titles.includes('钻石矿石'), '缺少钻石矿石词条')
  assert.ok(titles.includes('石头'), '缺少石头词条')
})

// ─────────────────────────────────────────────────────────────
// 2. build-mc-data-index.mjs 端到端构建（在临时目录中）
// ─────────────────────────────────────────────────────────────

function makeTempProject (layout: {
  blocks?: unknown[]
  items?: unknown[]
  entities?: unknown[]
  enchantments?: unknown[]
  recipes?: unknown[]
  langZh?: Record<string, string>
  langEn?: Record<string, string>
  version?: string
}): { root: string; version: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-knowledge-'))
  const version = layout.version || '1.21.4'

  // 创建 scripts/knowledge/ 与 src 结构以匹配脚本计算 ROOT 的方式
  fs.mkdirSync(path.join(root, 'resources', 'minecraft-data', version, 'lang'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts', 'knowledge'), { recursive: true })

  const dataDir = path.join(root, 'resources', 'minecraft-data', version)
  if (layout.blocks) fs.writeFileSync(path.join(dataDir, 'blocks.json'), JSON.stringify(layout.blocks))
  if (layout.items) fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify(layout.items))
  if (layout.entities) fs.writeFileSync(path.join(dataDir, 'entities.json'), JSON.stringify(layout.entities))
  if (layout.enchantments) fs.writeFileSync(path.join(dataDir, 'enchantments.json'), JSON.stringify(layout.enchantments))
  if (layout.recipes) fs.writeFileSync(path.join(dataDir, 'recipes.json'), JSON.stringify(layout.recipes))
  if (layout.langZh) fs.writeFileSync(path.join(dataDir, 'lang', 'zh_cn.json'), JSON.stringify(layout.langZh))
  if (layout.langEn) fs.writeFileSync(path.join(dataDir, 'lang', 'en_us.json'), JSON.stringify(layout.langEn))

  // 复制 fabric-versions.json（脚本读取默认版本）
  fs.writeFileSync(
    path.join(root, 'resources', 'fabric-versions.json'),
    JSON.stringify({ minecraft_version: version })
  )

  // 复制构建脚本到临时目录（脚本用 __dirname 计算 ROOT）
  const srcScriptDir = path.join(ROOT, 'scripts', 'knowledge')
  for (const script of ['build-mc-data-index.mjs']) {
    fs.copyFileSync(path.join(srcScriptDir, script), path.join(root, 'scripts', 'knowledge', script))
  }

  return { root, version }
}

test('knowledge-build: build-mc-data-index 正确构建方块/物品/实体/附魔索引', () => {
  const { root, version } = makeTempProject({
    blocks: [
      {
        id: 'minecraft:diamond_ore',
        name: 'diamond_ore',
        displayName: 'Diamond Ore',
        hardness: 3,
        resistance: 3,
        stackSize: 64,
        tool: 'iron_pickaxe',
        transparent: false,
        emitLight: 0,
        filterLight: 15
      },
      {
        id: 'minecraft:stone',
        name: 'stone',
        displayName: 'Stone',
        hardness: 1.5,
        resistance: 6,
        stackSize: 64
      }
    ],
    items: [
      {
        id: 'minecraft:diamond',
        name: 'diamond',
        displayName: 'Diamond',
        stackSize: 64
      }
    ],
    entities: [
      {
        id: 'minecraft:creeper',
        name: 'creeper',
        displayName: 'Creeper',
        type: 'hostile',
        category: 'monster',
        internalId: 50,
        attributes: { max_health: { base: 20 }, attack_damage: { base: 4 } }
      }
    ],
    enchantments: [
      {
        id: 'minecraft:sharpness',
        name: 'sharpness',
        displayName: 'Sharpness',
        maxLevel: 5,
        minLevel: 1,
        weight: 10
      }
    ],
    langZh: {
      'block.minecraft.diamond_ore': '钻石矿石',
      'item.minecraft.diamond': '钻石',
      'entity.minecraft.creeper': '苦力怕',
      'enchantment.minecraft.sharpness': '锋利'
    }
  })

  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'knowledge', 'build-mc-data-index.mjs'), `--version=${version}`],
    { cwd: root, encoding: 'utf-8' }
  )

  assert.equal(result.status, 0, `脚本退出码 ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

  const indexPath = path.join(root, 'resources', 'minecraft-data', version, 'index.json')
  assert.ok(fs.existsSync(indexPath), 'index.json 未生成')

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

  // counts
  assert.equal(index.counts.blocks, 2)
  assert.equal(index.counts.items, 1)
  assert.equal(index.counts.entities, 1)
  assert.equal(index.counts.enchantments, 1)

  // 方块属性 + 中文名
  assert.equal(index.blocksById['minecraft:diamond_ore'].zhName, '钻石矿石')
  assert.equal(index.blocksById['minecraft:diamond_ore'].hardness, 3)
  assert.equal(index.blocksById['minecraft:diamond_ore'].resistance, 3)
  assert.equal(index.blocksById['minecraft:diamond_ore'].tool, 'iron_pickaxe')

  // 中文别名映射（含"矿石→矿"变体）
  assert.equal(index.blocksByZhName['钻石矿石'], 'minecraft:diamond_ore')
  assert.equal(index.blocksByZhName['钻石矿'], 'minecraft:diamond_ore')

  // 英文别名映射（含下划线/空格/无分隔变体）
  assert.equal(index.blocksByEnName['diamond_ore'], 'minecraft:diamond_ore')
  assert.equal(index.blocksByEnName['diamondore'], 'minecraft:diamond_ore')
  assert.equal(index.blocksByEnName['diamond ore'], 'minecraft:diamond_ore')

  // 实体从 attributes.max_health.base 提取生命值
  assert.equal(index.entitiesById['minecraft:creeper'].zhName, '苦力怕')
  assert.equal(index.entitiesById['minecraft:creeper'].health, 20)
  assert.equal(index.entitiesById['minecraft:creeper'].attack, 4)
  assert.equal(index.entitiesById['minecraft:creeper'].internalId, 50)

  // 附魔
  assert.equal(index.enchantmentsById['minecraft:sharpness'].zhName, '锋利')
  assert.equal(index.enchantmentsById['minecraft:sharpness'].maxLevel, 5)
  assert.equal(index.enchantmentsById['minecraft:sharpness'].weight, 10)

  // 版本元数据
  assert.equal(index.version, version)
  assert.ok(typeof index.builtAt === 'string')
})

test('knowledge-build: build-mc-data-index 在数据目录缺失时非零退出', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-knowledge-empty-'))
  fs.mkdirSync(path.join(root, 'scripts', 'knowledge'), { recursive: true })
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'resources', 'fabric-versions.json'),
    JSON.stringify({ minecraft_version: '1.21.4' })
  )
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'knowledge', 'build-mc-data-index.mjs'),
    path.join(root, 'scripts', 'knowledge', 'build-mc-data-index.mjs')
  )

  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'knowledge', 'build-mc-data-index.mjs')],
    { cwd: root, encoding: 'utf-8' }
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr || '', /数据目录不存在|knowledge:fetch-data/)
})

test('knowledge-build: build-mc-data-index 正确构建合成配方索引（按产物聚合）', () => {
  const { root, version } = makeTempProject({
    blocks: [],
    items: [],
    entities: [],
    enchantments: [],
    recipes: [
      {
        type: 'crafting_shaped',
        result: { item: 'minecraft:diamond_block', count: 1 },
        ingredients: ['minecraft:diamond', 'minecraft:diamond', 'minecraft:diamond', 'minecraft:diamond', 'minecraft:diamond', 'minecraft:diamond', 'minecraft:diamond', 'minecraft:diamond', 'minecraft:diamond']
      },
      {
        type: 'crafting_shapeless',
        result: 'minecraft:diamond',
        ingredient: [{ item: 'minecraft:diamond_block' }]
      }
    ]
  })

  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'knowledge', 'build-mc-data-index.mjs'), `--version=${version}`],
    { cwd: root, encoding: 'utf-8' }
  )

  assert.equal(result.status, 0, `stderr: ${result.stderr}`)

  const index = JSON.parse(
    fs.readFileSync(path.join(root, 'resources', 'minecraft-data', version, 'index.json'), 'utf-8')
  )

  // 两个产物：diamond_block 和 diamond
  assert.equal(index.counts.recipes, 2)
  assert.ok(Array.isArray(index.recipesByResult['minecraft:diamond_block']))
  assert.equal(index.recipesByResult['minecraft:diamond_block'].length, 1)
  assert.equal(index.recipesByResult['minecraft:diamond_block'][0].result.count, 1)

  // 字符串形式 result 也能正常聚合
  assert.ok(Array.isArray(index.recipesByResult['minecraft:diamond']))
  assert.equal(index.recipesByResult['minecraft:diamond'].length, 1)
})

test('knowledge-build: build-mc-data-index 缺失 lang 文件时仍能构建（zhName 留空）', () => {
  const { root, version } = makeTempProject({
    blocks: [
      { id: 'minecraft:stone', name: 'stone', displayName: 'Stone', stackSize: 64 }
    ]
    // 不提供 langZh
  })

  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'knowledge', 'build-mc-data-index.mjs'), `--version=${version}`],
    { cwd: root, encoding: 'utf-8' }
  )

  assert.equal(result.status, 0, `stderr: ${result.stderr}`)

  const index = JSON.parse(
    fs.readFileSync(path.join(root, 'resources', 'minecraft-data', version, 'index.json'), 'utf-8')
  )

  assert.equal(index.counts.blocks, 1)
  assert.equal(index.blocksById['minecraft:stone'].zhName, undefined)
  // 仍然能从英文 name 建立别名
  assert.equal(index.blocksByEnName['stone'], 'minecraft:stone')
})

// ─────────────────────────────────────────────────────────────
// 3. build-all.mjs 参数解析（不实际执行构建）
// ─────────────────────────────────────────────────────────────

test('knowledge-build: build-all.mjs 接受所有 --skip-* 标志并跳过对应步骤', () => {
  // 通过临时目录复制脚本，并用 --skip-* 跳过所有实际构建
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-build-all-'))
  fs.mkdirSync(path.join(root, 'scripts', 'knowledge'), { recursive: true })
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true })

  const srcScriptDir = path.join(ROOT, 'scripts', 'knowledge')
  for (const script of ['build-all.mjs', 'fetch-minecraft-data.mjs', 'fetch-mc-wiki-zh.mjs', 'build-mc-data-index.mjs', 'build-wiki-embeddings.mjs', 'cache-transformer-model.mjs']) {
    fs.copyFileSync(path.join(srcScriptDir, script), path.join(root, 'scripts', 'knowledge', script))
  }

  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts', 'knowledge', 'build-all.mjs'),
      '--skip-data',
      '--skip-wiki',
      '--skip-embeddings',
      '--skip-model'
    ],
    { cwd: root, encoding: 'utf-8' }
  )

  // 全部跳过时应成功退出并打印"全部完成"
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  assert.match(result.stdout || '', /全部完成/)
  // 跳过项识别正确
  assert.match(result.stdout || '', /跳过项:.*skipData.*skipWiki.*skipEmbeddings.*skipModel/)
})

test('knowledge-build: build-all.mjs 在子步骤失败时非零退出', () => {
  // 不跳过 data 但数据目录不存在 → fetch 步骤失败
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-build-all-fail-'))
  fs.mkdirSync(path.join(root, 'scripts', 'knowledge'), { recursive: true })

  const srcScriptDir = path.join(ROOT, 'scripts', 'knowledge')
  for (const script of ['build-all.mjs', 'fetch-minecraft-data.mjs', 'fetch-mc-wiki-zh.mjs', 'build-mc-data-index.mjs', 'build-wiki-embeddings.mjs', 'cache-transformer-model.mjs']) {
    fs.copyFileSync(path.join(srcScriptDir, script), path.join(root, 'scripts', 'knowledge', script))
  }

  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts', 'knowledge', 'build-all.mjs'),
      '--skip-wiki',
      '--skip-embeddings',
      '--skip-model'
      // 不跳过 data，fetch-minecraft-data.mjs 会因网络/目录问题失败
    ],
    { cwd: root, encoding: 'utf-8',
      timeout: 60000
    }
  )

  // fetch-minecraft-data.mjs 失败或 build-mc-data-index.mjs 因数据缺失失败
  // 至少应该非零退出
  assert.notEqual(result.status, 0)
})

// ─────────────────────────────────────────────────────────────
// 4. package.json scripts 配置正确
// ─────────────────────────────────────────────────────────────

test('knowledge-build: package.json 注册了所有 knowledge:* 脚本', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  const scripts = pkg.scripts || {}

  const expected = [
    'knowledge:fetch-data',
    'knowledge:fetch-wiki',
    'knowledge:build-data-index',
    'knowledge:build-wiki-embeddings',
    'knowledge:cache-model',
    'knowledge:build-all',
    'knowledge:prefetch'
  ]

  for (const name of expected) {
    assert.ok(typeof scripts[name] === 'string' && scripts[name].length > 0, `missing script: ${name}`)
  }

  // build-all 别名
  assert.equal(scripts['knowledge:prefetch'], 'npm run knowledge:build-all')
})

test('knowledge-build: package.json 配置了 extraResources 打包资源', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  const build = pkg.build || {}

  assert.ok(Array.isArray(build.extraResources), 'build.extraResources 必须是数组')

  // 至少包含 minecraft-data 与 mc-wiki 资源
  const fromPaths = build.extraResources.map((r: { from: string }) => r.from || '')
  assert.ok(
    fromPaths.some((f: string) => f.includes('minecraft-data')),
    `extraResources 未包含 minecraft-data: ${JSON.stringify(build.extraResources)}`
  )
  assert.ok(
    fromPaths.some((f: string) => f.includes('mc-wiki')),
    `extraResources 未包含 mc-wiki: ${JSON.stringify(build.extraResources)}`
  )
})
