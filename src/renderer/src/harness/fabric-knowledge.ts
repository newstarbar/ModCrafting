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
  'fabric/workflows.md',
  'fabric/templates.md'
]

async function searchLocalKnowledgeFiles(keyword: string): Promise<string> {
  if (typeof window === 'undefined' || !window.api?.knowledgeReadLocal) return ''
  const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''

  const results: string[] = []
  for (const file of LOCAL_SEARCH_FILES) {
    try {
      const res = await window.api.knowledgeReadLocal(file)
      if (!res.success || !res.content) continue
      const lines = res.content.split('\n')
      // Find lines matching any keyword token and extract surrounding context
      const matchedBlocks: Array<{ start: number; end: number }> = []
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase()
        if (tokens.some((t) => lineLower.includes(t))) {
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
        for (const block of matchedBlocks.slice(0, 3)) {
          const snippet = lines.slice(block.start, block.end).join('\n').trim()
          if (snippet) results.push(`[${fileName}]\n${snippet}`)
        }
      }
    } catch {
      // ignore missing files in dev
    }
  }
  return results.join('\n\n---\n\n')
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
    `Fabric 知识检索（只读，含本地源码与联网摘要）`,
    `关键词：${keyword}`,
    `MC 版本：${mcVersion}`,
    ''
  ]

  if (localSourceResult) {
    lines.push('=== 本地源码命中（Fabric API + Yarn 映射，最高优先级） ===')
    lines.push(localSourceResult)
    lines.push('')
  }

  if (localResult) {
    lines.push('=== 本地参考文件命中 ===')
    lines.push(localResult)
    lines.push('')
  }

  if (ranked.length > 0) {
    lines.push('=== 联网知识源 ===')
    lines.push('')
  }

  for (const [index, { source }] of ranked.entries()) {
    lines.push(`${index + 1}. ${source.title}（${source.trust}）`)
    lines.push(`   URL: ${source.url}`)
    lines.push(`   用途: ${source.useFor}`)
    try {
      if (typeof window !== 'undefined' && window.api?.knowledgeFetchUrl) {
        const fetched = await window.api.knowledgeFetchUrl(source.url, 2500)
        if (fetched.success && fetched.text) {
          lines.push(`   摘要: ${fetched.text.slice(0, 500)}${fetched.truncated ? '…' : ''}`)
        } else if (fetched.error) {
          lines.push(`   联网摘要失败: ${fetched.error}`)
        }
      }
    } catch (err) {
      lines.push(`   联网摘要失败: ${err}`)
    }
    lines.push('')
  }

  if (localUrls.length > 0) {
    lines.push('本地知识库路由命中：')
    for (const url of localUrls.slice(0, 3)) {
      lines.push(`- ${url}`)
    }
    lines.push('')
  }

  lines.push('提示：写配方/资源/代码前，请根据以上摘要确认当前 MC 版本的 JSON 路径与字段格式。')
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
