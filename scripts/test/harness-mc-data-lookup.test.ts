import test from 'node:test'
import assert from 'node:assert/strict'
import { minecraftDataLookupTool } from '../../src/renderer/src/harness/mc-data-tool.ts'
import type { ToolContext } from '../../src/renderer/src/harness/tools.ts'

// ── window.api mock 辅助 ──
interface MockApi {
  mcDataLookupBlock?: (query: string, version?: string) => Promise<unknown>
  mcDataLookupItem?: (query: string, version?: string) => Promise<unknown>
  mcDataLookupEntity?: (query: string, version?: string) => Promise<unknown>
  mcDataLookupEnchantment?: (query: string, version?: string) => Promise<unknown>
  mcDataSearchRecipes?: (itemId: string, version?: string) => Promise<unknown>
}

function installWindow(api: MockApi): () => void {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { api }
  return () => {
    ;(globalThis as { window?: unknown }).window = prior
  }
}

const ctx: ToolContext = { projectPath: null, callId: 'test-call' }

test('minecraft_data_lookup: 空 query 返回错误信息', async () => {
  const restore = installWindow({})
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: '' })
    assert.equal(typeof result, 'string')
    assert.match(result as string, /query 不能为空/)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: window.api 不可用时返回服务未就绪错误', async () => {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = undefined
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: 'diamond_ore' })
    assert.match(result as string, /minecraft_data_lookup 服务不可用/)
    assert.match(result as string, /knowledge:build-data-index/)
  } finally {
    ;(globalThis as { window?: unknown }).window = prior
  }
})

test('minecraft_data_lookup: window.api 缺少 mcDataLookupBlock 时也返回不可用', async () => {
  const restore = installWindow({})
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: 'diamond_ore' })
    assert.match(result as string, /minecraft_data_lookup 服务不可用/)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: 按标准 ID 命中方块并返回完整属性', async () => {
  const restore = installWindow({
    mcDataLookupBlock: async (query) => {
      if (query === 'minecraft:diamond_ore') {
        return {
          found: true,
          source: 'block',
          data: {
            id: 'minecraft:diamond_ore',
            name: 'diamond_ore',
            zhName: '钻石矿石',
            hardness: 3,
            resistance: 3,
            stackSize: 64,
            tool: 'iron_pickaxe',
            transparent: false,
            emitLight: 0,
            filterLight: 15
          }
        }
      }
      return { found: false, source: 'block', data: null }
    }
  })
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: 'minecraft:diamond_ore' })
    const text = result as string
    assert.match(text, /查询：minecraft:diamond_ore/)
    assert.match(text, /类型：自动/)
    assert.match(text, /【方块 · 命中】/)
    assert.match(text, /标准ID：minecraft:diamond_ore/)
    assert.match(text, /中文名：钻石矿石/)
    assert.match(text, /硬度：3/)
    assert.match(text, /爆炸抗性：3/)
    assert.match(text, /推荐工具：iron_pickaxe/)
    assert.match(text, /::kh::结构化数据/)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: 中文口语名命中并返回中文名', async () => {
  const restore = installWindow({
    mcDataLookupBlock: async (query) => {
      if (query === '钻石矿') {
        return {
          found: true,
          source: 'block',
          data: {
            id: 'minecraft:diamond_ore',
            name: 'diamond_ore',
            zhName: '钻石矿石',
            hardness: 3,
            resistance: 3,
            stackSize: 64
          }
        }
      }
      return { found: false, source: 'block', data: null }
    }
  })
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: '钻石矿', kind: 'block' })
    const text = result as string
    assert.match(text, /【方块 · 命中】/)
    assert.match(text, /标准ID：minecraft:diamond_ore/)
    assert.match(text, /类型：方块/)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: auto 模式下方块未命中后尝试物品', async () => {
  let blockQueried = false
  let itemQueried = false
  const restore = installWindow({
    mcDataLookupBlock: async () => {
      blockQueried = true
      return { found: false, source: 'block', data: null }
    },
    mcDataLookupItem: async (query) => {
      itemQueried = true
      if (query === 'diamond') {
        return {
          found: true,
          source: 'item',
          data: {
            id: 'minecraft:diamond',
            name: 'diamond',
            zhName: '钻石',
            stackSize: 64
          }
        }
      }
      return { found: false, source: 'item', data: null }
    }
  })
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: 'diamond' })
    const text = result as string
    assert.equal(blockQueried, true)
    assert.equal(itemQueried, true)
    assert.match(text, /【物品 · 命中】/)
    assert.match(text, /标准ID：minecraft:diamond/)
    assert.doesNotMatch(text, /【方块 · 命中】/)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: auto 模式按 block→item→entity→enchantment 顺序短路', async () => {
  const calls: string[] = []
  const restore = installWindow({
    mcDataLookupBlock: async (q) => {
      calls.push(`block:${q}`)
      return { found: true, source: 'block', data: { id: 'minecraft:stone', name: 'stone', stackSize: 64 } }
    },
    mcDataLookupItem: async (q) => {
      calls.push(`item:${q}`)
      return { found: false, source: 'item', data: null }
    }
  })
  try {
    await minecraftDataLookupTool.execute(ctx, { query: 'stone' })
    assert.deepEqual(calls, ['block:stone'])
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: 指定 kind=entity 时不查询方块和物品', async () => {
  let blockCalled = false
  let itemCalled = false
  let entityCalled = false
  const restore = installWindow({
    mcDataLookupBlock: async () => { blockCalled = true; return { found: false, source: 'block', data: null } },
    mcDataLookupItem: async () => { itemCalled = true; return { found: false, source: 'item', data: null } },
    mcDataLookupEntity: async (query) => {
      entityCalled = true
      if (query === 'creeper') {
        return {
          found: true,
          source: 'entity',
          data: {
            id: 'minecraft:creeper',
            name: 'creeper',
            zhName: '苦力怕',
            type: 'hostile',
            category: 'monster',
            health: 20,
            attack: 4,
            passive: false
          }
        }
      }
      return { found: false, source: 'entity', data: null }
    }
  })
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: 'creeper', kind: 'entity' })
    const text = result as string
    assert.equal(blockCalled, false)
    assert.equal(itemCalled, false)
    assert.equal(entityCalled, true)
    assert.match(text, /类型：实体/)
    assert.match(text, /【实体 · 命中】/)
    assert.match(text, /标准ID：minecraft:creeper/)
    assert.match(text, /中文名：苦力怕/)
    assert.match(text, /生命值：20/)
    assert.match(text, /攻击力：4/)
    assert.match(text, /被动生物：否/)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: kind=enchantment 命中附魔属性', async () => {
  const restore = installWindow({
    // 必须提供 mcDataLookupBlock 以通过早期的 window.api?.mcDataLookupBlock 检查
    mcDataLookupBlock: async () => ({ found: false, source: 'block', data: null }),
    mcDataLookupEnchantment: async (query) => {
      if (query === 'sharpness') {
        return {
          found: true,
          source: 'enchantment',
          data: {
            id: 'minecraft:sharpness',
            name: 'sharpness',
            zhName: '锋利',
            maxLevel: 5,
            minLevel: 1,
            weight: 10
          }
        }
      }
      return { found: false, source: 'enchantment', data: null }
    }
  })
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: 'sharpness', kind: 'enchantment' })
    const text = result as string
    assert.match(text, /【附魔 · 命中】/)
    assert.match(text, /标准ID：minecraft:sharpness/)
    assert.match(text, /中文名：锋利/)
    assert.match(text, /最大等级：5/)
    assert.match(text, /最小等级：1/)
    assert.match(text, /权重：10/)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: 全部未命中时返回未命中提示与 miss trail', async () => {
  const restore = installWindow({
    mcDataLookupBlock: async () => ({ found: false, source: 'block', data: null }),
    mcDataLookupItem: async () => ({ found: false, source: 'item', data: null }),
    mcDataLookupEntity: async () => ({ found: false, source: 'entity', data: null }),
    mcDataLookupEnchantment: async () => ({ found: false, source: 'enchantment', data: null })
  })
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: '不存在的物品xyz' })
    const text = result as string
    assert.match(text, /未命中结构化数据集/)
    assert.match(text, /knowledge:build-all/)
    assert.match(text, /::kh::未命中/)
    assert.match(text, /摘要：查「不存在的物品xyz」→ 无命中/)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: includeRecipes=true 时附加合成配方', async () => {
  let recipeQueried = false
  const restore = installWindow({
    mcDataLookupBlock: async (query) => {
      if (query === 'minecraft:diamond_block') {
        return {
          found: true,
          source: 'block',
          data: {
            id: 'minecraft:diamond_block',
            name: 'diamond_block',
            zhName: '钻石块',
            stackSize: 64
          }
        }
      }
      return { found: false, source: 'block', data: null }
    },
    mcDataSearchRecipes: async (itemId) => {
      recipeQueried = true
      assert.equal(itemId, 'minecraft:diamond_block')
      return {
        found: true,
        recipes: [
          { type: 'minecraft:crafting_shaped', result: { id: 'minecraft:diamond_block' } }
        ]
      }
    }
  })
  try {
    const result = await minecraftDataLookupTool.execute(ctx, {
      query: 'minecraft:diamond_block',
      includeRecipes: true
    })
    const text = result as string
    assert.equal(recipeQueried, true)
    assert.match(text, /【合成配方】/)
    assert.match(text, /crafting_shaped/)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: includeRecipes=false 时不查询配方', async () => {
  let recipeQueried = false
  const restore = installWindow({
    mcDataLookupBlock: async () => ({
      found: true,
      source: 'block',
      data: { id: 'minecraft:stone', name: 'stone', stackSize: 64 }
    }),
    mcDataSearchRecipes: async () => {
      recipeQueried = true
      return { found: false, recipes: [] }
    }
  })
  try {
    await minecraftDataLookupTool.execute(ctx, { query: 'minecraft:stone', includeRecipes: false })
    assert.equal(recipeQueried, false)
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: mcVersion 透传到下层 API', async () => {
  let receivedVersion: string | undefined
  const restore = installWindow({
    mcDataLookupBlock: async (query, version) => {
      receivedVersion = version
      return {
        found: true,
        source: 'block',
        data: { id: query, name: query, stackSize: 64 }
      }
    }
  })
  try {
    await minecraftDataLookupTool.execute(ctx, { query: 'minecraft:stone', mcVersion: '1.20.1' })
    assert.equal(receivedVersion, '1.20.1')
  } finally {
    restore()
  }
})

test('minecraft_data_lookup: 工具元数据 - 只读且名称正确', () => {
  assert.equal(minecraftDataLookupTool.name, 'minecraft_data_lookup')
  assert.equal(minecraftDataLookupTool.readOnly(), true)
  assert.ok(minecraftDataLookupTool.description.includes('minecraft-data'))
  assert.ok(minecraftDataLookupTool.description.includes('标准 ID'))
  assert.deepEqual(minecraftDataLookupTool.schema.required, ['query'])
})

test('minecraft_data_lookup: 输出摘要行包含查询关键字与命中类别', async () => {
  const restore = installWindow({
    mcDataLookupBlock: async () => ({
      found: true,
      source: 'block',
      data: { id: 'minecraft:diamond_ore', name: 'diamond_ore', zhName: '钻石矿石', stackSize: 64 }
    })
  })
  try {
    const result = await minecraftDataLookupTool.execute(ctx, { query: 'diamond_ore' })
    const text = result as string
    assert.match(text, /摘要：查「diamond_ore」→ 方块:minecraft:diamond_ore/)
  } finally {
    restore()
  }
})
