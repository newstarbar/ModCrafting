import { FABRIC_KNOWLEDGE_SOURCES, type FabricKnowledgeSource } from './fabric-agent-policy.ts'
import { formatKnowledgeHitLine, type KnowledgeHitTrail } from '../utils/knowledge-hit-tags.ts'

export interface FabricDocsSearchInput {
  keyword: string
  mcVersion?: string
  lang?: 'zh_cn' | 'en_us'
  limit?: number
}

export interface ResolvedKnowledgeSource extends FabricKnowledgeSource {
  enabled: boolean
}

const SEARCH_STOPWORDS = new Set([
  'fabric', 'api', 'minecraft', 'packet', 'packets', 'yarn', 'mapping', 'mappings',
  'mc', 'mod', 'java', 'the', 'and', 'for', 'with', 'from', 'example', 'docs'
])

const CATEGORY_LABELS: Record<string, string> = {
  items: '物品',
  blocks: '方块',
  entities: '实体',
  networking: '网络',
  mixins: 'Mixin',
  commands: '命令',
  rendering: '渲染',
  'data-generation': '数据生成',
  loom: 'Loom',
  loader: 'Loader',
  sounds: '音效',
  fluids: '流体',
  serialization: '序列化',
  'class-tweakers': 'ClassTweaker',
  'getting-started': '入门',
  porting: '迁移',
  'migrating-mappings': '映射迁移',
  debugging: '调试',
  'automatic-testing': '自动化测试',
  'game-rules': '游戏规则',
  'key-mappings': '按键',
  'resource-conditions': '资源条件',
  statistics: '统计',
  'text-and-translations': '翻译',
  'custom-recipe-types': '自定义配方',
  codecs: 'Codec',
  events: '事件'
}

/** Topic → local develop paths (synced from fabric-docs). */
const TOPIC_ROUTES: Array<{ pattern: RegExp; files: string[] }> = [
  {
    pattern: /custompayload|custompacketpayload|serverplaynetworking|clientplaynetworking|c2s|s2c|payload|networking/i,
    files: ['fabric/docs/develop/networking.md']
  },
  {
    pattern: /useblockcallback|useentitycallback|useitemcallback|player.*interact|右键|空手|interact/i,
    files: ['fabric/docs/develop/events.md']
  },
  {
    pattern: /first.?item|register.*item|moditems|item\.settings|物品|盔甲|armor|工具|food|食物/i,
    files: [
      'fabric/docs/develop/items/first-item.md',
      'fabric/docs/develop/items/custom-armor.md',
      'fabric/docs/develop/items/custom-tools.md'
    ]
  },
  {
    pattern: /first.?block|register.*block|modblocks|方块实体|block.?entity|container/i,
    files: [
      'fabric/docs/develop/blocks/first-block.md',
      'fabric/docs/develop/blocks/block-entities.md',
      'fabric/docs/develop/blocks/block-containers.md'
    ]
  },
  {
    pattern: /mixin|@inject|@accessor|spongepowered|注入/i,
    files: [
      'fabric/docs/develop/mixins/bytecode.md',
      'fabric/docs/develop/mixins/accessors.md'
    ]
  },
  {
    pattern: /配方|recipe|crafting|smelting|blasting|stonecutting|custom.?recipe/i,
    files: [
      'fabric/docs/develop/data-generation/recipes.md',
      'fabric/docs/develop/custom-recipe-types.md',
      'fabric/docs/develop/items/first-item.md'
    ]
  },
  {
    pattern: /datagen|data.?gen|provider|数据生成|loot.?table|advancement|tag/i,
    files: [
      'fabric/docs/develop/data-generation/setup.md',
      'fabric/docs/develop/data-generation/recipes.md',
      'fabric/docs/develop/data-generation/loot-tables.md',
      'fabric/docs/develop/data-generation/tags.md'
    ]
  },
  {
    pattern: /debug|crash|构建失败|build.?fail|cannot find symbol|compilation/i,
    files: ['fabric/docs/develop/debugging.md']
  },
  {
    pattern: /loom|gradle|gradlew/i,
    files: [
      'fabric/docs/develop/loom/index.md',
      'fabric/docs/develop/loom/options.md',
      'fabric/docs/develop/loom/fabric-api.md'
    ]
  },
  {
    pattern: /fluid|流体/i,
    files: ['fabric/docs/develop/fluids/first-fluid.md']
  },
  {
    pattern: /custom.?entity|spawn.*entity|实体注册|damage.?type|effect|attribute/i,
    files: [
      'fabric/docs/develop/entities/first-entity.md',
      'fabric/docs/develop/entities/attributes.md',
      'fabric/docs/develop/entities/damage-types.md',
      'fabric/docs/develop/entities/effects.md'
    ]
  },
  {
    pattern: /sound|音效/i,
    files: [
      'fabric/docs/develop/sounds/using-sounds.md',
      'fabric/docs/develop/sounds/custom.md',
      'fabric/docs/develop/sounds/dynamic-sounds.md'
    ]
  },
  {
    pattern: /command|命令|brigadier/i,
    files: [
      'fabric/docs/develop/commands/basics.md',
      'fabric/docs/develop/commands/arguments.md',
      'fabric/docs/develop/commands/suggestions.md'
    ]
  },
  {
    pattern: /render|渲染|hud|gui|particle|draw.?context/i,
    files: [
      'fabric/docs/develop/rendering/basic-concepts.md',
      'fabric/docs/develop/rendering/hud.md',
      'fabric/docs/develop/rendering/draw-context.md',
      'fabric/docs/develop/rendering/gui/custom-screens.md'
    ]
  },
  {
    pattern: /codec|serialization|序列化|data.?attachment|saved.?data/i,
    files: [
      'fabric/docs/develop/serialization/codecs.md',
      'fabric/docs/develop/codecs.md',
      'fabric/docs/develop/serialization/data-attachments.md',
      'fabric/docs/develop/serialization/saved-data.md'
    ]
  },
  {
    pattern: /fabricloader|loader|入口点|entrypoint|fabric\.mod\.json/i,
    files: [
      'fabric/docs/develop/loader/index.md',
      'fabric/docs/develop/loader/fabric-mod-json.md'
    ]
  },
  {
    pattern: /class.?tweak|access.?widen|interface.?injection|enum.?extension|tweak/i,
    files: [
      'fabric/docs/develop/class-tweakers/index.md',
      'fabric/docs/develop/class-tweakers/access-widening.md',
      'fabric/docs/develop/class-tweakers/interface-injection.md',
      'fabric/docs/develop/class-tweakers/enum-extension.md'
    ]
  },
  {
    pattern: /automatic.?test|gametest/i,
    files: ['fabric/docs/develop/automatic-testing.md']
  },
  {
    pattern: /game.?rule|gamerule/i,
    files: ['fabric/docs/develop/game-rules.md']
  },
  {
    pattern: /key.?bind|keymapping|按键/i,
    files: ['fabric/docs/develop/key-mappings.md']
  },
  {
    pattern: /resource.?condition|load.?condition/i,
    files: ['fabric/docs/develop/resource-conditions.md']
  },
  {
    pattern: /statistic|统计/i,
    files: ['fabric/docs/develop/statistics.md']
  },
  {
    pattern: /lang|translation|翻译|i18n/i,
    files: [
      'fabric/docs/develop/text-and-translations.md',
      'fabric/docs/develop/data-generation/translations.md'
    ]
  },
  {
    pattern: /porting|迁移|migrat/i,
    files: [
      'fabric/docs/develop/porting/index.md',
      'fabric/docs/develop/porting/fabric-api.md',
      'fabric/docs/develop/migrating-mappings/index.md'
    ]
  },
  {
    pattern: /registry|duplicate key|already registered|registrykey|cannot find symbol|client.?in.?main|splitEnvironment/i,
    files: [
      'fabric/docs/develop/items/first-item.md',
      'fabric/docs/develop/blocks/first-block.md',
      'fabric/docs/develop/debugging.md'
    ]
  }
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

/** @deprecated Kept for tests that still assert URL shape; runtime search is local-only. */
export function resolveTopicDocsUrl(keyword: string, lang: 'zh_cn' | 'en_us' = 'zh_cn'): string | null {
  const route = TOPIC_ROUTES.find((r) => r.pattern.test(keyword))
  if (!route) return null
  const develop = route.files.find((f) => f.includes('/docs/develop/'))
  if (!develop) return `https://docs.fabricmc.net/${lang}/develop/`
  const rel = develop.replace(/^fabric\/docs\/develop\//, '').replace(/\.md$/, '')
  return `https://docs.fabricmc.net/${lang}/develop/${rel}`
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

function shortFileLabel(file: string): string {
  return file
    .replace(/^fabric\//, '')
    .replace(/^docs\/develop\//, 'develop/')
    .replace(/\.md$/, '')
}

function classifyDocPath(file: string): { category: string; doc: string } {
  const label = shortFileLabel(file).replace(/^develop\//, '')
  const parts = label.split('/')
  if (parts.length === 1) {
    const key = parts[0]
    return { category: CATEGORY_LABELS[key] || key, doc: key }
  }
  const top = parts[0]
  const doc = parts.slice(1).join('/')
  return { category: CATEGORY_LABELS[top] || top, doc }
}

function extractTitleHint(content: string): string {
  const fm = content.match(/^---\s*\n[\s\S]*?\ntitle:\s*(.+)\n/)
  if (fm) return fm[1].replace(/^["']|["']$/g, '').trim()
  const h1 = content.match(/^#\s+(.+)$/m)
  return h1?.[1]?.replace(/\s*\{#.*\}$/, '').trim() || ''
}

function headingAtOrAbove(lines: string[], index: number): string {
  for (let i = index; i >= 0; i--) {
    const m = lines[i].match(/^(#{1,4})\s+(.+?)(?:\s*\{#.*\})?\s*$/)
    if (m) return m[2].trim()
  }
  return ''
}

function extractRelevantCodeBlocks(
  content: string,
  tokens: string[],
  maxBlocks = 1
): Array<{ score: number; text: string; lineIndex: number }> {
  const highValue = tokens.filter(isHighValueToken)
  const matchTokens = highValue.length > 0 ? highValue : tokens
  const lines = content.split('\n')
  const blocks: Array<{ score: number; text: string; lineIndex: number }> = []
  const fenceRe = /```(\w*)/

  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = lines[i].match(fenceRe)
    if (!fenceMatch || fenceMatch[1] === undefined) continue
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
      lineIndex: i,
      text: `${context ? `${context}\n\n` : ''}\`\`\`${lang}\n${blockLines.slice(1, -1).join('\n')}\n\`\`\``.trim()
    })
    i = j
  }

  return blocks
    .sort((a, b) => b.score - a.score)
    .slice(0, maxBlocks)
}

function scoreFileContent(content: string, matchTokens: string[], minMatches: number): {
  score: number
  snippet: string
  kind: 'code' | 'text'
  section: string
} | null {
  const lines = content.split('\n')
  const blocks = extractRelevantCodeBlocks(content, matchTokens, 1)
  if (blocks.length > 0) {
    const block = blocks[0]
    return {
      score: 10 + matchTokens.filter((t) => block.text.toLowerCase().includes(t)).length,
      snippet: block.text,
      kind: 'code',
      section: headingAtOrAbove(lines, block.lineIndex) || '代码示例'
    }
  }
  let best: { start: number; end: number; score: number; hitLine: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase()
    const matchCount = matchTokens.filter((t) => lineLower.includes(t)).length
    if (matchCount >= minMatches) {
      const start = Math.max(0, i - 2)
      const end = Math.min(lines.length, i + 8)
      if (!best || matchCount > best.score) best = { start, end, score: matchCount, hitLine: i }
    }
  }
  if (!best) return null
  return {
    score: best.score,
    snippet: lines.slice(best.start, best.end).join('\n').trim(),
    kind: 'text',
    section: headingAtOrAbove(lines, best.hitLine) || extractTitleHint(content) || '正文'
  }
}

function trailForDocFile(file: string, section: string): KnowledgeHitTrail {
  const { category, doc } = classifyDocPath(file)
  return {
    kind: '文档',
    category,
    doc,
    section: section.replace(/^#+\s*/, '').slice(0, 40)
  }
}

async function readKnowledge(file: string): Promise<string | null> {
  if (typeof window === 'undefined' || !window.api?.knowledgeReadLocal) return null
  try {
    const res = await window.api.knowledgeReadLocal(file)
    if (res.success && res.content) return res.content
  } catch {
    // ignore
  }
  return null
}

async function listSearchableKnowledgeFiles(): Promise<string[]> {
  const files = new Set<string>()
  if (typeof window !== 'undefined' && window.api?.listKnowledgeFiles) {
    try {
      const listed = await window.api.listKnowledgeFiles()
      for (const entry of listed) {
        const p = entry.path.replace(/\\/g, '/')
        if (p.startsWith('fabric/docs/develop/') && p.endsWith('.md')) files.add(p)
      }
    } catch {
      // ignore
    }
  }
  return [...files]
}

async function searchRoutedKnowledgeFiles(keyword: string): Promise<{
  text: string
  trails: KnowledgeHitTrail[]
}> {
  const routedFiles = resolveTopicRouteFiles(keyword)
  if (routedFiles.length === 0) return { text: '', trails: [] }

  const tokens = tokenizeKeyword(keyword)
  const highValue = tokens.filter(isHighValueToken)
  const matchTokens = highValue.length > 0 ? highValue : tokens
  const minMatches = Math.max(1, Math.ceil(matchTokens.length / 2))

  const results: string[] = []
  const trails: KnowledgeHitTrail[] = []

  for (const file of routedFiles) {
    const content = await readKnowledge(file)
    if (!content) continue
    const scored = scoreFileContent(content, matchTokens, minMatches)
    if (scored || content.length > 80) {
      const label = shortFileLabel(file)
      const section = scored?.section || extractTitleHint(content) || '概览'
      trails.push(trailForDocFile(file, section))
      if (scored) {
        results.push(`[主题路由 · ${label} · ${section}]\n${scored.snippet}`)
      } else {
        const preview = content.split('\n').filter((l) => l.trim() && !l.startsWith('---') && !l.startsWith('title:')).slice(0, 6).join('\n')
        results.push(`[主题路由 · ${label} · ${section}]\n${preview}`)
      }
      if (results.length >= 3) break
    }
  }

  return { text: results.join('\n\n'), trails }
}

async function searchLocalKnowledgeFiles(
  keyword: string,
  excludeFiles: Set<string> = new Set()
): Promise<{ text: string; trails: KnowledgeHitTrail[] }> {
  const tokens = tokenizeKeyword(keyword)
  if (tokens.length === 0) return { text: '', trails: [] }
  const highValue = tokens.filter(isHighValueToken)
  const matchTokens = highValue.length > 0 ? highValue : tokens
  const minMatches = Math.max(1, Math.ceil(matchTokens.length / 2))

  const allFiles = await listSearchableKnowledgeFiles()
  const scoredFiles: Array<{ file: string; score: number; snippet: string; section: string }> = []

  for (const file of allFiles) {
    if (excludeFiles.has(file)) continue
    const content = await readKnowledge(file)
    if (!content) continue
    const scored = scoreFileContent(content, matchTokens, minMatches)
    if (!scored) continue
    scoredFiles.push({
      file,
      score: scored.score,
      snippet: scored.snippet,
      section: scored.section
    })
  }

  scoredFiles.sort((a, b) => b.score - a.score)
  const top = scoredFiles.slice(0, 3)
  const trails = top.map((item) => trailForDocFile(item.file, item.section))
  const results = top.map((item) => {
    const label = shortFileLabel(item.file)
    return item.snippet.includes('```')
      ? `[${label} · ${item.section} — 代码示例]\n${item.snippet}`
      : `[${label} · ${item.section} — 匹配]\n${item.snippet}`
  })

  return { text: results.join('\n\n'), trails }
}

function yarnTrailFromResult(localSourceResult: string): KnowledgeHitTrail | null {
  if (!localSourceResult || isNoisyYarnResult(localSourceResult)) return null
  const exact = localSourceResult.match(/\[Yarn 精确匹配[^\]]*\]\s*([^\n]+)/)
  const high = localSourceResult.match(/高相关类[：:]\s*([^\n]+)/)
  const api = localSourceResult.includes('Fabric API 源码')
  if (exact) {
    return { kind: '源码', category: 'Yarn', doc: exact[1].trim().slice(0, 48), section: '精确匹配' }
  }
  if (high) {
    return { kind: '源码', category: 'Yarn', doc: high[1].trim().slice(0, 48), section: '高相关类' }
  }
  if (api) {
    return { kind: '源码', category: 'Fabric API', doc: '源码命中', section: '检索' }
  }
  if (localSourceResult.includes('Yarn') || localSourceResult.includes('Fabric API')) {
    return { kind: '源码', category: 'Yarn', doc: '映射命中', section: '检索' }
  }
  return null
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
  if (localResult.includes('代码示例') || localResult.includes('匹配]')) return true
  if (localSourceResult.includes('[Yarn 精确匹配]') && !localSourceResult.includes('无额外字段/方法记录')) return true
  if (localSourceResult.includes('高相关类')) return true
  if (localSourceResult.includes('Fabric API 源码')) return true
  if (localSourceResult.includes('未找到高相关 Yarn 类') && (routedResult || localResult)) return true
  if (isNoisyYarnResult(localSourceResult)) return Boolean(routedResult || localResult)
  return false
}

function buildHumanSummaryLine(trails: KnowledgeHitTrail[], keyword: string, noHit: boolean): string {
  if (noHit || trails.length === 0) {
    return `摘要：查「${keyword}」→ 本地文档与源码均未命中`
  }
  const parts = trails.slice(0, 3).map((t) =>
    [t.kind, t.category, t.doc, t.section].filter(Boolean).join(' › ')
  )
  return `摘要：查「${keyword}」→ ${parts.join('；')}`
}

export async function buildFabricDocsSearchSummary(input: FabricDocsSearchInput): Promise<string> {
  const keyword = normalizeKeyword(input.keyword)
  const mcVersion = input.mcVersion || '当前项目版本'

  const routed = await searchRoutedKnowledgeFiles(keyword)
  const routedFiles = new Set(resolveTopicRouteFiles(keyword))
  const local = await searchLocalKnowledgeFiles(keyword, routedFiles)

  let localSourceResult = ''
  try {
    if (typeof window !== 'undefined' && window.api?.searchLocalSources) {
      localSourceResult = await window.api.searchLocalSources(keyword, 4)
    }
  } catch { /* ignore IPC errors */ }

  if (isNoisyYarnResult(localSourceResult) && (routed.text || local.text)) {
    localSourceResult = localSourceResult.replace(
      /\[Yarn 映射[^\]]*\][^\n]*\n(?:[\s\S]*?(?=\n\n\[|$))?/,
      '[Yarn 映射] 泛词命中过多，已优先展示本地文档检索结果\n'
    ).trim()
  }

  const yarnTrail = yarnTrailFromResult(localSourceResult)
  const trails: KnowledgeHitTrail[] = [...routed.trails, ...local.trails]
  if (yarnTrail) trails.push(yarnTrail)

  const lines: string[] = [
    `查询：${keyword}`,
    `版本：${mcVersion}`,
    ''
  ]

  const summaryParts: string[] = []

  if (routed.text) {
    summaryParts.push('主题路由命中')
    lines.push(routed.text)
    lines.push('')
  }

  if (localSourceResult && !isNoisyYarnResult(localSourceResult)) {
    lines.push(localSourceResult)
    lines.push('')
    if (yarnTrail) summaryParts.push('本地源码/Yarn 命中')
  } else if (localSourceResult && !routed.text && !local.text) {
    lines.push(localSourceResult)
    lines.push('')
  }

  if (local.text) {
    summaryParts.push('本地参考命中')
    lines.push(local.text)
    lines.push('')
  }

  const noHit = trails.length === 0
  if (noHit) {
    trails.push({ kind: '未命中', category: '本地知识库', doc: keyword.slice(0, 32), section: '' })
  }

  lines.push(`结果：${summaryParts.length > 0 ? summaryParts.join('，') : '无命中'}`)
  lines.push(buildHumanSummaryLine(trails.filter((t) => t.kind !== '未命中'), keyword, noHit))
  for (const trail of trails.slice(0, 4)) {
    lines.push(formatKnowledgeHitLine(trail))
  }
  return lines.join('\n')
}

export function buildFabricJavadocLookupUrl(fabricApiVersion: string, keyword: string): string {
  const safeVersion = encodeURIComponent(fabricApiVersion.trim())
  const safeKeyword = encodeURIComponent(normalizeKeyword(keyword))
  return `https://maven.fabricmc.net/docs/fabric-api-${safeVersion}/search.html?q=${safeKeyword}`
}

export async function buildVanillaWikiQuerySummary(keyword: string, _lang: 'zh_cn' | 'en_us' = 'zh_cn'): Promise<string> {
  const normalized = normalizeKeyword(keyword)
  return [
    `Minecraft 原版机制查询（只读）`,
    `关键词：${normalized}`,
    `说明：本产品知识库不捆绑 Minecraft Wiki；运行时不联网抓取。`,
    `建议：模组 API / 注册 / 事件请改用 fabric_docs_search（本地官方文档 + Yarn/源码）。`,
    `摘要：查「${normalized}」→ 本地无 Wiki 正文（未抓取）`,
    formatKnowledgeHitLine({ kind: 'Wiki', category: '未捆绑', doc: normalized.slice(0, 32), section: '无正文' })
  ].join('\n')
}
