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

const SEARCH_STOPWORDS = new Set([
  'fabric', 'api', 'minecraft', 'packet', 'packets', 'yarn', 'mapping', 'mappings',
  'mc', 'mod', 'java', 'the', 'and', 'for', 'with', 'from', 'example', 'docs'
])

const TOPIC_ROUTES: Array<{ pattern: RegExp; files: string[]; docsPath?: string }> = [
  {
    pattern: /custompayload|custompacketpayload|serverplaynetworking|clientplaynetworking|c2s|s2c|payload|networking/i,
    files: ['fabric/docs/networking.md', 'fabric/networking-snippets.md', 'fabric/api-aliases.md'],
    docsPath: 'networking'
  },
  {
    pattern: /useblockcallback|useentitycallback|useitemcallback|player.*interact|右键|空手|interact/i,
    files: ['fabric/docs/events.md', 'fabric/api-aliases.md'],
    docsPath: 'events'
  },
  {
    pattern: /first.?item|register.*item|moditems|item\.settings|物品/i,
    files: ['fabric/docs/items-first-item.md', 'fabric/api-aliases.md'],
    docsPath: 'items/first-item'
  },
  {
    pattern: /first.?block|register.*block|modblocks|方块/i,
    files: ['fabric/docs/blocks-first-block.md'],
    docsPath: 'blocks/first-block'
  },
  {
    pattern: /mixin|@inject|@accessor|spongepowered|注入/i,
    files: ['fabric/reliability-1.21.4.md', 'fabric/docs/mixins-bytecode.md', 'fabric/yarn-gotchas.md'],
    docsPath: 'mixins/bytecode'
  },
  {
    pattern: /配方|recipe|crafting|smelting|blasting|stonecutting/i,
    files: ['fabric/reliability-1.21.4.md', 'fabric/docs/items-first-item.md'],
    docsPath: 'items/first-item'
  },
  {
    pattern: /datagen|data.?gen|provider|数据生成/i,
    files: ['fabric/docs/data-generation-setup.md'],
    docsPath: 'data-generation/setup'
  },
  {
    pattern: /debug|crash|构建失败|build.?fail/i,
    files: ['fabric/docs/debugging.md'],
    docsPath: 'debugging'
  },
  {
    pattern: /loom|gradle|gradlew/i,
    files: ['fabric/docs/loom.md'],
    docsPath: 'loom'
  },
  { pattern: /fluid|流体/i, files: [], docsPath: 'fluids/first-fluid' },
  { pattern: /custom.?entity|spawn.*entity|实体注册/i, files: [], docsPath: 'entities/first-entity' },
  { pattern: /sound|音效/i, files: [], docsPath: 'sounds/using-sounds' },
  { pattern: /command|命令| brigadier/i, files: [], docsPath: 'commands/basics' },
  { pattern: /render|渲染|hud|model/i, files: [], docsPath: 'rendering/basic-concepts' },
  { pattern: /codec|serialization|序列化/i, files: [], docsPath: 'serialization/codecs' },
  { pattern: /fabricloader|loader|入口点|entrypoint/i, files: [], docsPath: 'loader/' },
  { pattern: /class.?tweak|tweak/i, files: [], docsPath: 'class-tweakers/' },
  { pattern: /automatic.?test|gametest/i, files: [], docsPath: 'automatic-testing' },
  { pattern: /custom.?recipe|recipe.?type/i, files: [], docsPath: 'custom-recipe-types' },
  { pattern: /game.?rule|gamerule/i, files: [], docsPath: 'game-rules' },
  { pattern: /key.?bind|keymapping|按键/i, files: [], docsPath: 'key-mappings' },
  { pattern: /resource.?condition|load.?condition/i, files: [], docsPath: 'resource-conditions' },
  { pattern: /statistic|统计/i, files: [], docsPath: 'statistics' },
  { pattern: /lang|translation|翻译|i18n/i, files: [], docsPath: 'text-and-translations' }
]

function normalizeKeyword(keyword: string): string {
  return keyword.trim() || 'Fabric 模组开发'
}

function tokenizeKeyword(keyword: string): string[] {
  return keyword.toLowerCase().split(/[\s.,()#]+/).filter(Boolean)
}

function isHighValueToken(token: string): boolean {
  return token.length >= 4
    && !SEARCH_STOPWORDS.has(token)
    && !/^\d+\.\d+(\.\d+)?([+][\w.+-]+)?$/.test(token)
}

export function resolveTopicRouteFiles(keyword: string): string[] {
  const routed = new Set<string>()
  for (const route of TOPIC_ROUTES) {
    if (route.pattern.test(keyword)) {
      for (const file of route.files) routed.add(file)
    }
  }
  return [...routed]
}

export function resolveTopicDocsUrl(keyword: string, lang: 'zh_cn' | 'en_us' = 'zh_cn'): string | null {
  for (const route of TOPIC_ROUTES) {
    if (route.docsPath && route.pattern.test(keyword)) {
      return `https://docs.fabricmc.net/${lang}/develop/${route.docsPath}`
    }
  }
  return null
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
  try {
    const res = await window.api.knowledgeReadLocal('fabric/docs/index.md')
    if (res.success && res.content) return extractUrlsFromMarkdown(res.content)
  } catch {
    // ignore missing files in dev
  }
  return []
}

const LOCAL_SEARCH_FILES = [
  'fabric/reliability-1.21.4.md',
  'fabric/networking-snippets.md',
  'fabric/api-aliases.md',
  'fabric/yarn-gotchas.md',
  'fabric/docs/items-first-item.md',
  'fabric/docs/blocks-first-block.md',
  'fabric/docs/data-generation-setup.md',
  'fabric/docs/mixins-bytecode.md',
  'fabric/docs/debugging.md',
  'fabric/docs/events.md',
  'fabric/docs/networking.md',
  'fabric/docs/loom.md'
]

function extractRelevantCodeBlocks(content: string, tokens: string[], maxBlocks = 1): string[] {
  const highValue = tokens.filter(isHighValueToken)
  const matchTokens = highValue.length > 0 ? highValue : tokens
  const lines = content.split('\n')
  const blocks: Array<{ score: number; text: string }> = []
  const fenceRe = /```(\w*)/

  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = lines[i].match(fenceRe)
    if (!fenceMatch || !fenceMatch[1]) continue
    const lang = fenceMatch[1]
    const blockLines: string[] = [lines[i]]
    let j = i + 1
    while (j < lines.length && !lines[j].startsWith('```')) {
      blockLines.push(lines[j])
      j++
    }
    if (j < lines.length) blockLines.push(lines[j])
    const blockText = blockLines.join('\n')
    const blockLower = blockText.toLowerCase()
    const score = matchTokens.filter((t) => blockLower.includes(t)).length
    if (score === 0) continue
    const contextStart = Math.max(0, i - 2)
    const context = lines.slice(contextStart, i).join('\n').trim()
    blocks.push({
      score,
      text: `${context ? `${context}\n\n` : ''}\`\`\`${lang}\n${blockLines.slice(1, -1).join('\n')}\n\`\`\``.trim()
    })
    i = j
  }

  return blocks
    .sort((a, b) => b.score - a.score)
    .slice(0, maxBlocks)
    .map((b) => b.text)
}

async function searchRoutedKnowledgeFiles(keyword: string): Promise<string> {
  if (typeof window === 'undefined' || !window.api?.knowledgeReadLocal) return ''
  const routedFiles = resolveTopicRouteFiles(keyword)
  if (routedFiles.length === 0) return ''

  const tokens = tokenizeKeyword(keyword)
  const results: string[] = []

  for (const file of routedFiles) {
    try {
      const res = await window.api.knowledgeReadLocal(file)
      if (!res.success || !res.content) continue
      const blocks = extractRelevantCodeBlocks(res.content, tokens, 1)
      if (blocks.length > 0) {
        const fileName = file.replace('fabric/', '')
        results.push(`[主题路由 · ${fileName}]\n${blocks[0]}`)
        continue
      }
      const lines = res.content.split('\n')
      const highValue = tokens.filter(isHighValueToken)
      const matchTokens = highValue.length > 0 ? highValue : tokens
      const minMatches = Math.max(1, Math.ceil(matchTokens.length / 2))
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase()
        const matchCount = matchTokens.filter((t) => lineLower.includes(t)).length
        if (matchCount >= minMatches) {
          const start = Math.max(0, i - 2)
          const end = Math.min(lines.length, i + 8)
          const fileName = file.replace('fabric/', '')
          results.push(`[主题路由 · ${fileName}]\n${lines.slice(start, end).join('\n').trim()}`)
          break
        }
      }
    } catch {
      // ignore missing files in dev
    }
  }

  return results.join('\n\n')
}

async function searchLocalKnowledgeFiles(keyword: string, excludeFiles: Set<string> = new Set()): Promise<string> {
  if (typeof window === 'undefined' || !window.api?.knowledgeReadLocal) return ''
  const tokens = tokenizeKeyword(keyword)
  if (tokens.length === 0) return ''
  const highValue = tokens.filter(isHighValueToken)
  const matchTokens = highValue.length > 0 ? highValue : tokens
  const minMatches = Math.max(1, Math.ceil(matchTokens.length / 2))

  const results: string[] = []
  for (const file of LOCAL_SEARCH_FILES) {
    if (excludeFiles.has(file)) continue
    try {
      const res = await window.api.knowledgeReadLocal(file)
      if (!res.success || !res.content) continue
      const blocks = extractRelevantCodeBlocks(res.content, tokens, 1)
      if (blocks.length > 0) {
        const fileName = file.replace('fabric/', '')
        results.push(`[${fileName} — 代码示例]\n${blocks[0]}`)
        if (results.length >= 2) break
        continue
      }
      const lines = res.content.split('\n')
      const matchedBlocks: Array<{ start: number; end: number }> = []
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase()
        const matchCount = matchTokens.filter((t) => lineLower.includes(t)).length
        if (matchCount >= minMatches) {
          const start = Math.max(0, i - 2)
          const end = Math.min(lines.length, i + 6)
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
        const blocks = matchedBlocks.slice(0, 1).map((block) => {
          return lines.slice(block.start, block.end).join('\n').trim()
        })
        results.push(`[${fileName} — ${matchedBlocks.length} 处匹配]\n${blocks.join('\n...\n')}`)
        if (results.length >= 2) break
      }
    } catch {
      // ignore missing files in dev
    }
  }
  return results.join('\n\n')
}

export function isNoisyYarnResult(localSourceResult: string): boolean {
  return /(\d{3,})\s*个类命中/.test(localSourceResult)
}

export function hasHighConfidenceLocalHit(
  routedResult: string,
  localResult: string,
  localSourceResult: string
): boolean {
  if (routedResult.includes('[主题路由')) return true
  if (localResult.includes('代码示例') || localResult.includes('networking-snippets') || localResult.includes('yarn-gotchas')) return true
  if (localSourceResult.includes('[Yarn 精确匹配]') && !localSourceResult.includes('无额外字段/方法记录')) return true
  if (localSourceResult.includes('高相关类')) return true
  if (localSourceResult.includes('Fabric API 源码')) return true
  if (localSourceResult.includes('未找到高相关 Yarn 类') && (routedResult || localResult)) return true
  if (isNoisyYarnResult(localSourceResult)) return Boolean(routedResult || localResult)
  return false
}

function isDeepDocsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'docs.fabricmc.net'
      && parsed.pathname.replace(/\/+$/, '').split('/').length >= 4
  } catch {
    return false
  }
}

export async function buildFabricDocsSearchSummary(input: FabricDocsSearchInput): Promise<string> {
  const keyword = normalizeKeyword(input.keyword)
  const limit = Math.max(1, Math.min(4, Math.floor(input.limit ?? 3)))
  const mcVersion = input.mcVersion || '当前项目版本'
  const lang = input.lang || 'zh_cn'

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
  await readLocalKnowledgeRoutes()

  const routedResult = await searchRoutedKnowledgeFiles(keyword)
  const routedFiles = new Set(resolveTopicRouteFiles(keyword))
  const localResult = await searchLocalKnowledgeFiles(keyword, routedFiles)

  let localSourceResult = ''
  try {
    if (typeof window !== 'undefined' && window.api?.searchLocalSources) {
      localSourceResult = await window.api.searchLocalSources(keyword, 4)
    }
  } catch { /* ignore IPC errors */ }

  if (isNoisyYarnResult(localSourceResult) && (routedResult || localResult)) {
    localSourceResult = localSourceResult.replace(
      /\[Yarn 映射[^\]]*\][^\n]*\n(?:[\s\S]*?(?=\n\n\[|$))?/,
      '[Yarn 映射] 泛词命中过多，已优先展示本地文档检索结果\n'
    ).trim()
  }

  const highConfidence = hasHighConfidenceLocalHit(routedResult, localResult, localSourceResult)

  const lines: string[] = [
    `查询：${keyword}`,
    `版本：${mcVersion}`,
    ''
  ]

  const summaryParts: string[] = []

  if (routedResult) {
    summaryParts.push('主题路由命中')
    lines.push(routedResult)
    lines.push('')
  }

  if (localSourceResult && !isNoisyYarnResult(localSourceResult)) {
    lines.push(localSourceResult)
    lines.push('')
    if (localSourceResult.includes('Yarn') || localSourceResult.includes('Fabric API')) {
      summaryParts.push('本地源码/Yarn 命中')
    }
  } else if (localSourceResult && !routedResult && !localResult) {
    lines.push(localSourceResult)
    lines.push('')
  }

  if (localResult) {
    summaryParts.push('本地参考命中')
    lines.push(localResult)
    lines.push('')
  }

  if (!highConfidence) {
    const topicDocsUrl = resolveTopicDocsUrl(keyword, lang)
    const webSources = sources
      .map((source) => ({
        source,
        score: sourceScore(keyword, `${source.title} ${source.useFor} ${source.kind}`),
        url: topicDocsUrl && source.id === 'fabric-docs-zh' ? topicDocsUrl : source.url
      }))
      .filter(({ url }) => isDeepDocsUrl(url))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    if (webSources.length > 0) {
      summaryParts.push(`联网源 ${webSources.length} 个`)
      lines.push('=== 联网补充 ===')
      for (const { source, url } of webSources) {
        const fetchResult = await (async () => {
          try {
            if (typeof window !== 'undefined' && window.api?.knowledgeFetchUrl) {
              const fetched = await window.api.knowledgeFetchUrl(url, 2500)
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
          lines.push(`${source.title}: ${url}`)
        }
      }
      lines.push('')
    }
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
