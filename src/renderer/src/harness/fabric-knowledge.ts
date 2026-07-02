import { FABRIC_KNOWLEDGE_SOURCES } from './fabric-agent-policy.ts'

export interface FabricDocsSearchInput {
  keyword: string
  mcVersion?: string
  lang?: 'zh_cn' | 'en_us'
  limit?: number
}

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

export function buildFabricDocsSearchSummary(input: FabricDocsSearchInput): string {
  const keyword = normalizeKeyword(input.keyword)
  const limit = Math.max(1, Math.min(8, Math.floor(input.limit ?? 5)))
  const mcVersion = input.mcVersion || '当前项目版本'
  const matches = FABRIC_KNOWLEDGE_SOURCES
    .map((source) => ({
      source,
      score: sourceScore(keyword, `${source.title} ${source.useFor} ${source.kind}`)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const lines = matches.map(({ source }, index) =>
    `${index + 1}. ${source.title}（${source.trust}，只读）\n` +
    `   URL: ${source.url}\n` +
    `   用途: ${source.useFor}`
  )

  return `Fabric 文档检索建议（只读）
关键词：${keyword}
MC 版本：${mcVersion}

${lines.join('\n')}`
}

export function buildFabricJavadocLookupUrl(fabricApiVersion: string, keyword: string): string {
  const safeVersion = encodeURIComponent(fabricApiVersion.trim())
  const safeKeyword = encodeURIComponent(normalizeKeyword(keyword))
  return `https://maven.fabricmc.net/docs/fabric-api-${safeVersion}/search.html?q=${safeKeyword}`
}

export function buildVanillaWikiQuerySummary(keyword: string, lang: 'zh_cn' | 'en_us' = 'zh_cn'): string {
  const normalized = normalizeKeyword(keyword)
  const encoded = encodeURIComponent(normalized)
  const baseUrl = lang === 'zh_cn' ? 'https://zh.minecraft.wiki/' : 'https://minecraft.wiki/'
  return `Minecraft 原版机制查询（只读）
关键词：${normalized}
推荐页面入口：${baseUrl}
MediaWiki API：https://minecraft.wiki/api.php
搜索 URL：${baseUrl}w/index.php?search=${encoded}
用途：查询原版方块、实体、物品、生成、战利品、NBT 与数据包行为。`
}
