import { FABRIC_KNOWLEDGE_SOURCES, type FabricKnowledgeSource } from './fabric-agent-policy.ts'

export interface FabricDocsSearchInput {
  keyword: string
  mcVersion?: string
  lang?: 'zh_cn' | 'en_us'
  limit?: number
}

export interface ResolvedKnowledgeSource extends FabricKnowledgeSource {
  enabled: boolean
}

const URL_RE = /https?:\/\/[^\s`)>]+/g

function normalizeKeyword(keyword: string): string {
  return keyword.trim() || 'Fabric 模组开发'
}

function sourceScore(keyword: string, text: string): number {
  const lowerKeyword = keyword.toLowerCase()
  const lowerText = text.toLowerCase()
  let score = 0
  for (const token of lowerKeyword.split(/\s+/).filter(Boolean)) {
    if (lowerText.includes(token)) score += 2
  }
  if (/方块|block/i.test(keyword) && /方块|block/i.test(text)) score += 2
  if (/实体|entity/i.test(keyword) && /实体|entity/i.test(text)) score += 2
  if (/mixin|注入/i.test(keyword) && /mixin|注入/i.test(text)) score += 2
  if (/配方|recipe/i.test(keyword) && /配方|recipe/i.test(text)) score += 2
  if (/版本|version|loader|api/i.test(keyword) && /版本|Meta|API/i.test(text)) score += 2
  return score
}

export function mergeKnowledgeSources(
  overrides: Array<{ id: string; title?: string; url?: string; useFor?: string; enabled?: boolean }> = []
): ResolvedKnowledgeSource[] {
  const overrideMap = new Map(overrides.map((o) => [o.id, o]))
  return FABRIC_KNOWLEDGE_SOURCES.map((source) => {
    const override = overrideMap.get(source.id)
    return {
      ...source,
      title: override?.title || source.title,
      url: override?.url || source.url,
      useFor: override?.useFor || source.useFor,
      enabled: override?.enabled !== false
    }
  })
}

function extractUrlsFromMarkdown(content: string): string[] {
  const urls = content.match(URL_RE) || []
  return [...new Set(urls.map((u) => u.replace(/[.,;]+$/, '')))]
}

async function readLocalKnowledgeRoutes(): Promise<string[]> {
  if (typeof window === 'undefined' || !window.api?.knowledgeReadLocal) return []
  const files = ['fabric/sources.md', 'fabric/workflows.md', 'fabric/templates.md', 'fabric/policies.md']
  const urls: string[] = []
  for (const file of files) {
    try {
      const res = await window.api.knowledgeReadLocal(file)
      if (res.success && res.content) urls.push(...extractUrlsFromMarkdown(res.content))
    } catch {
      // ignore missing files in dev
    }
  }
  return urls
}

const LOCAL_SEARCH_FILES = [
  'fabric/yarn-reference.md',
  'fabric/docs/items-first-item.md',
  'fabric/docs/blocks-first-block.md',
  'fabric/docs/fluids-first-fluid.md',
  'fabric/docs/entities-first-entity.md',
  'fabric/docs/sounds-using-sounds.md',
  'fabric/docs/commands-basics.md',
  'fabric/docs/rendering-basic-concepts.md',
  'fabric/docs/data-generation-setup.md',
  'fabric/docs/serialization-codecs.md',
  'fabric/docs/loom.md',
  'fabric/docs/loader.md',
  'fabric/docs/mixins-bytecode.md',
  'fabric/docs/class-tweakers.md',
  'fabric/docs/automatic-testing.md',
  'fabric/docs/custom-recipe-types.md',
  'fabric/docs/debugging.md',
  'fabric/docs/events.md',
  'fabric/docs/game-rules.md',
  'fabric/docs/key-mappings.md',
  'fabric/docs/networking.md',
  'fabric/docs/resource-conditions.md',
  'fabric/docs/statistics.md',
  'fabric/docs/text-and-translations.md',
  'fabric/workflows.md',
  'fabric/templates.md'
]

async function searchLocalKnowledgeFiles(keyword: string): Promise<string> {
  if (typeof window === 'undefined' || !window.api?.knowledgeReadLocal) return ''
  const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  const minMatches = Math.max(1, Math.ceil(tokens.length / 2))

  const results: string[] = []
  for (const file of LOCAL_SEARCH_FILES) {
    try {
      const res = await window.api.knowledgeReadLocal(file)
      if (!res.success || !res.content) continue
      const lines = res.content.split('\n')
      const matchedBlocks: Array<{ start: number; end: number }> = []
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase()
        const matchCount = tokens.filter((t) => lineLower.includes(t)).length
        if (matchCount >= minMatches) {
          // Take 2 lines before and 5 lines after as context
          const start = Math.max(0, i - 2)
          const end = Math.min(lines.length, i + 6)
          // Merge overlapping blocks
          const last = matchedBlocks[matchedBlocks.length - 1]
          if (last && last.end >= start - 2) {
            last.end = Math.max(last.end, end)
          } else {
            matchedBlocks.push({ start, end })
          }
        }
      }
      if (matchedBlocks.length > 0) {
        const fileName = file.replace('fabric/', '')
        // Limit to top 2 context blocks, each max 8 lines
        const blocks = matchedBlocks.slice(0, 2).map((block) => {
          const snippet = lines.slice(block.start, block.end).join('\n').trim()
          return snippet
        })
        results.push(`[${fileName} — ${matchedBlocks.length} 处匹配]\n${blocks.join('\n...\n')}`)
      }
    } catch {
      // ignore missing files in dev
    }
  }
  return results.join('\n\n')
}

export async function buildFabricDocsSearchSummary(input: FabricDocsSearchInput): Promise<string> {
  const keyword = normalizeKeyword(input.keyword)
  const limit = Math.max(1, Math.min(4, Math.floor(input.limit ?? 3)))
  const mcVersion = input.mcVersion || '当前项目版本'

  let configOverrides: Array<{ id: string; title?: string; url?: string; useFor?: string; enabled?: boolean }> = []
  try {
    if (typeof window !== 'undefined' && window.api?.loadAgentConfig) {
      const cfg = await window.api.loadAgentConfig()
      configOverrides = cfg.knowledgeSourceOverrides || []
    }
  } catch {
    // ignore
  }

  const sources = mergeKnowledgeSources(configOverrides).filter((s) => s.enabled)
  const localUrls = await readLocalKnowledgeRoutes()

  // Search local knowledge files first (yarn-reference.md etc.)
  const localResult = await searchLocalKnowledgeFiles(keyword)

  // Search local Fabric API sources + Yarn mappings (extracted from seed)
  let localSourceResult = ''
  try {
    if (typeof window !== 'undefined' && window.api?.searchLocalSources) {
      localSourceResult = await window.api.searchLocalSources(keyword, 4)
    }
  } catch { /* ignore IPC errors */ }

  const ranked = sources
    .map((source) => ({
      source,
      score: sourceScore(keyword, `${source.title} ${source.useFor} ${source.kind}`)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const lines: string[] = [
    `查询：${keyword}`,
    `版本：${mcVersion}`,
    ''
  ]

  let summaryParts: string[] = []

  if (localSourceResult) {
    const yarnMatch = localSourceResult.match(/\[yarn-mappings\]/g)
    const srcMatch = localSourceResult.match(/\[fabric-/g)
    const parts: string[] = []
    if (yarnMatch) parts.push(`Yarn 映射 ${yarnMatch.length} 处命中`)
    if (srcMatch) parts.push(`Fabric 源码 ${srcMatch.length} 个文件`)
    summaryParts.push(...parts)
    lines.push(localSourceResult)
    lines.push('')
  }

  if (localResult) {
    summaryParts.push('本地参考命中')
    lines.push(localResult)
    lines.push('')
  }

  if (ranked.length > 0) {
    summaryParts.push(`联网源 ${ranked.length} 个`)
    lines.push('=== 联网补充 ===')
    for (const [index, { source }] of ranked.entries()) {
      const fetchResult = await (async () => {
        try {
          if (typeof window !== 'undefined' && window.api?.knowledgeFetchUrl) {
            const fetched = await window.api.knowledgeFetchUrl(source.url, 2500)
            if (fetched.success && fetched.text) {
              return fetched.text.slice(0, 300)
            }
          }
        } catch { /* ignore */ }
        return null
      })()
      if (fetchResult) {
        lines.push(`${source.title}: ${fetchResult}${fetchResult.length >= 300 ? '…' : ''}`)
      } else {
        lines.push(`${source.title}: （未获取到内容）`)
      }
    }
    lines.push('')
  }

  lines.push(`结果：${summaryParts.length > 0 ? summaryParts.join('，') : '无命中'}`)
  return lines.join('\n')
}

export function buildFabricJavadocLookupUrl(fabricApiVersion: string, keyword: string): string {
  const safeVersion = encodeURIComponent(fabricApiVersion.trim())
  const safeKeyword = encodeURIComponent(normalizeKeyword(keyword))
  return `https://maven.fabricmc.net/docs/fabric-api-${safeVersion}/search.html?q=${safeKeyword}`
}

export async function buildVanillaWikiQuerySummary(keyword: string, lang: 'zh_cn' | 'en_us' = 'zh_cn'): Promise<string> {
  const normalized = normalizeKeyword(keyword)
  const encoded = encodeURIComponent(normalized)
  const baseUrl = lang === 'zh_cn' ? 'https://zh.minecraft.wiki/' : 'https://minecraft.wiki/'
  const searchUrl = `${baseUrl}w/index.php?search=${encoded}`
  const lines = [
    `Minecraft 原版机制查询（只读）`,
    `关键词：${normalized}`,
    `推荐页面入口：${baseUrl}`,
    `搜索 URL：${searchUrl}`
  ]
  try {
    if (typeof window !== 'undefined' && window.api?.knowledgeFetchUrl) {
      const fetched = await window.api.knowledgeFetchUrl(searchUrl, 2000)
      if (fetched.success && fetched.text) {
        lines.push(`联网摘要: ${fetched.text.slice(0, 400)}${fetched.truncated ? '…' : ''}`)
      }
    }
  } catch {
    // ignore
  }
  lines.push('用途：查询原版方块、实体、物品、生成、战利品、NBT 与数据包行为。')
  return lines.join('\n')
}
