import test from 'node:test'
import assert from 'node:assert/strict'
import { mcWikiSearchTool } from '../../src/renderer/src/harness/mc-data-tool.ts'
import type { ToolContext } from '../../src/renderer/src/harness/tools.ts'

// ── window.api mock 辅助 ──
interface MockWikiApi {
  mcWikiSearch?: (query: string, topK?: number) => Promise<unknown>
  mcWikiInfo?: () => Promise<unknown>
  mcWikiInit?: () => Promise<unknown>
}

function installWindow(api: MockWikiApi): () => void {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { api }
  return () => {
    ;(globalThis as { window?: unknown }).window = prior
  }
}

const ctx: ToolContext = { projectPath: null, callId: 'test-call' }

test('mc_wiki_search: 空 query 返回错误信息', async () => {
  const restore = installWindow({})
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '' })
    assert.match(result as string, /query 不能为空/)
  } finally {
    restore()
  }
})

test('mc_wiki_search: window.api 不可用时返回服务未就绪错误', async () => {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = undefined
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '红石电路' })
    assert.match(result as string, /mc_wiki_search 服务不可用/)
    assert.match(result as string, /knowledge:download/)
  } finally {
    ;(globalThis as { window?: unknown }).window = prior
  }
})

test('mc_wiki_search: window.api 缺少 mcWikiSearch 时也返回不可用', async () => {
  const restore = installWindow({})
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '红石电路' })
    assert.match(result as string, /mc_wiki_search 服务不可用/)
  } finally {
    restore()
  }
})

test('mc_wiki_search: info 显示未就绪且有错误时返回错误信息', async () => {
  const restore = installWindow({
    mcWikiInfo: async () => ({
      ready: false,
      chunkCount: 0,
      dimension: 384,
      model: 'Xenova/all-MiniLM-L6-v2',
      error: '索引缺失：resources/mc-wiki-zh-index/'
    }),
    mcWikiInit: async () => ({ ok: false, error: 'init failed' }),
    // 必须提供 mcWikiSearch 以通过早期的 window.api?.mcWikiSearch 检查
    mcWikiSearch: async () => ({ ok: true, results: [] })
  })
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '苦力怕' })
    const text = result as string
    assert.match(text, /中文 MC 百科向量知识库不可用/)
    assert.match(text, /索引缺失：resources\/mc-wiki-zh-index\//)
    assert.match(text, /knowledge:download/)
    assert.match(text, /当前切片数：0/)
  } finally {
    restore()
  }
})

test('mc_wiki_search: info 未就绪但无错误时尝试懒加载初始化', async () => {
  let initCalled = false
  const restore = installWindow({
    mcWikiInfo: async () => ({
      ready: false,
      chunkCount: 0,
      dimension: 384,
      model: 'Xenova/all-MiniLM-L6-v2'
    }),
    mcWikiInit: async () => {
      initCalled = true
      return { ok: true }
    },
    mcWikiSearch: async () => ({
      ok: true,
      results: []
    })
  })
  try {
    await mcWikiSearchTool.execute(ctx, { query: '苦力怕' })
    assert.equal(initCalled, true)
  } finally {
    restore()
  }
})

test('mc_wiki_search: 懒加载初始化失败时返回提示', async () => {
  const restore = installWindow({
    mcWikiInfo: async () => ({
      ready: false,
      chunkCount: 0,
      dimension: 384,
      model: 'Xenova/all-MiniLM-L6-v2'
    }),
    mcWikiInit: async () => ({ ok: false, error: 'transformers.js 未安装' }),
    // 必须提供 mcWikiSearch 以通过早期的 window.api?.mcWikiSearch 检查
    mcWikiSearch: async () => ({ ok: true, results: [] })
  })
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '苦力怕' })
    const text = result as string
    assert.match(text, /尚未就绪，已尝试初始化但失败/)
    assert.match(text, /transformers\.js 未安装/)
  } finally {
    restore()
  }
})

test('mc_wiki_search: 检索失败时返回失败提示', async () => {
  const restore = installWindow({
    mcWikiInfo: async () => ({ ready: true, chunkCount: 100, dimension: 384, model: 'Xenova/all-MiniLM-L6-v2' }),
    mcWikiSearch: async () => ({ ok: false, results: [], error: 'vector dim mismatch' })
  })
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '红石电路' })
    const text = result as string
    assert.match(text, /检索失败：vector dim mismatch/)
    assert.match(text, /建议改用 minecraft_data_lookup/)
  } finally {
    restore()
  }
})

test('mc_wiki_search: 命中 0 条时返回空提示', async () => {
  const restore = installWindow({
    mcWikiInfo: async () => ({ ready: true, chunkCount: 100, dimension: 384, model: 'Xenova/all-MiniLM-L6-v2' }),
    mcWikiSearch: async () => ({ ok: true, results: [] })
  })
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '不存在的术语xyz' })
    const text = result as string
    assert.match(text, /未命中百科词条/)
    assert.match(text, /切片库可能为空/)
    assert.match(text, /knowledge:download/)
  } finally {
    restore()
  }
})

test('mc_wiki_search: 命中多条时按相似度排序并格式化输出', async () => {
  const restore = installWindow({
    mcWikiInfo: async () => ({ ready: true, chunkCount: 100, dimension: 384, model: 'Xenova/all-MiniLM-L6-v2' }),
    mcWikiSearch: async (query, topK) => {
      assert.equal(query, '苦力怕')
      assert.equal(topK, 5)
      return {
        ok: true,
        results: [
          {
            title: '苦力怕',
            category: '生物',
            standardId: 'minecraft:creeper',
            heading: '苦力怕',
            snippet: '苦力怕（Creeper）是 Minecraft 中常见的敌对生物，会悄悄靠近玩家并爆炸。',
            score: 0.8123,
            sourceFile: 'creeper.md'
          },
          {
            title: '爆炸',
            category: '机制',
            standardId: undefined,
            heading: '爆炸伤害',
            snippet: '爆炸会对周围方块和生物造成伤害。',
            score: 0.6543,
            sourceFile: 'explosion.md'
          }
        ]
      }
    }
  })
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '苦力怕' })
    const text = result as string
    assert.match(text, /查询：苦力怕/)
    assert.match(text, /命中：2 条（topK=5）/)
    assert.match(text, /【#1 · 生物 · 苦力怕 \(minecraft:creeper\)】/)
    assert.match(text, /段落：苦力怕/)
    assert.match(text, /相似度：0\.8123/)
    assert.match(text, /苦力怕（Creeper）是 Minecraft/)
    assert.match(text, /【#2 · 机制 · 爆炸】/)
    assert.match(text, /::kh::百科/)
    assert.match(text, /摘要：查「苦力怕」→ 生物:苦力怕；机制:爆炸/)
  } finally {
    restore()
  }
})

test('mc_wiki_search: topK 参数被裁剪到 [1, 10] 范围', async () => {
  let receivedTopK: number | undefined
  const restore = installWindow({
    mcWikiInfo: async () => ({ ready: true, chunkCount: 100, dimension: 384, model: 'Xenova/all-MiniLM-L6-v2' }),
    mcWikiSearch: async (_q, topK) => {
      receivedTopK = topK
      return { ok: true, results: [] }
    }
  })
  try {
    // 超过上限被裁剪到 10
    await mcWikiSearchTool.execute(ctx, { query: '红石', topK: 100 })
    assert.equal(receivedTopK, 10)

    // 负数被 Math.max(1, ...) 裁剪到 1
    await mcWikiSearchTool.execute(ctx, { query: '红石', topK: -5 })
    assert.equal(receivedTopK, 1)

    // 1 保持不变
    await mcWikiSearchTool.execute(ctx, { query: '红石', topK: 1 })
    assert.equal(receivedTopK, 1)

    // 10 保持不变
    await mcWikiSearchTool.execute(ctx, { query: '红石', topK: 10 })
    assert.equal(receivedTopK, 10)
  } finally {
    restore()
  }
})

test('mc_wiki_search: topK=0 视为未提供，使用默认值 5', async () => {
  let receivedTopK: number | undefined
  const restore = installWindow({
    mcWikiInfo: async () => ({ ready: true, chunkCount: 100, dimension: 384, model: 'Xenova/all-MiniLM-L6-v2' }),
    mcWikiSearch: async (_q, topK) => {
      receivedTopK = topK
      return { ok: true, results: [] }
    }
  })
  try {
    // 源代码用 `Number(args.topK) || 5`，0 被视为 falsy，使用默认值 5
    await mcWikiSearchTool.execute(ctx, { query: '红石', topK: 0 })
    assert.equal(receivedTopK, 5)
  } finally {
    restore()
  }
})

test('mc_wiki_search: 默认 topK=5', async () => {
  let receivedTopK: number | undefined
  const restore = installWindow({
    mcWikiInfo: async () => ({ ready: true, chunkCount: 100, dimension: 384, model: 'Xenova/all-MiniLM-L6-v2' }),
    mcWikiSearch: async (_q, topK) => {
      receivedTopK = topK
      return { ok: true, results: [] }
    }
  })
  try {
    await mcWikiSearchTool.execute(ctx, { query: '红石' })
    assert.equal(receivedTopK, 5)
  } finally {
    restore()
  }
})

test('mc_wiki_search: 工具元数据 - 只读且名称正确', () => {
  assert.equal(mcWikiSearchTool.name, 'mc_wiki_search')
  assert.equal(mcWikiSearchTool.readOnly(), true)
  assert.ok(mcWikiSearchTool.description.includes('中文 MC 百科'))
  assert.ok(mcWikiSearchTool.description.includes('向量'))
  assert.deepEqual(mcWikiSearchTool.schema.required, ['query'])
})

test('mc_wiki_search: 命中结果附带 KnowledgeHit 标签便于追溯', async () => {
  const restore = installWindow({
    mcWikiInfo: async () => ({ ready: true, chunkCount: 100, dimension: 384, model: 'Xenova/all-MiniLM-L6-v2' }),
    mcWikiSearch: async () => ({
      ok: true,
      results: [
        {
          title: '红石电路',
          category: '红石',
          standardId: 'minecraft:redstone',
          heading: '基础电路',
          snippet: '红石电路是 Minecraft 中的一种机制。',
          score: 0.78,
          sourceFile: 'redstone.md'
        }
      ]
    })
  })
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '红石电路' })
    const text = result as string
    // 至少包含一条 ::kh::百科|红石|红石电路|基础电路 形式的标签
    assert.match(text, /::kh::百科\|红石\|红石电路/)
  } finally {
    restore()
  }
})

test('mc_wiki_search: 缺失 standardId 时仍能正常输出', async () => {
  const restore = installWindow({
    mcWikiInfo: async () => ({ ready: true, chunkCount: 100, dimension: 384, model: 'Xenova/all-MiniLM-L6-v2' }),
    mcWikiSearch: async () => ({
      ok: true,
      results: [
        {
          title: '红石电路',
          category: '红石',
          snippet: '红石电路是 Minecraft 中的一种机制。',
          score: 0.78
        }
      ]
    })
  })
  try {
    const result = await mcWikiSearchTool.execute(ctx, { query: '红石电路' })
    const text = result as string
    assert.match(text, /【#1 · 红石 · 红石电路】/)
    // 不应出现 "undefined"
    assert.doesNotMatch(text, /undefined/)
  } finally {
    restore()
  }
})
