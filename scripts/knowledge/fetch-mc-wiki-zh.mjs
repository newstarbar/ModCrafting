#!/usr/bin/env node
/**
 * 抓取 zh.minecraft.wiki 核心词条，转为 MD 文件输出到 resources/mc-wiki-zh/
 *
 * 用法：node scripts/knowledge/fetch-mc-wiki-zh.mjs [--category=block] [--limit=100]
 *
 * 词条清单：scripts/knowledge/wiki-pages-list.json
 * 抓取 API：https://zh.minecraft.wiki/api.php?action=parse&page=<title>&format=json&prop=wikitext&formatversion=2
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..')

const WIKI_API = 'https://zh.minecraft.wiki/api.php'
const RATE_LIMIT_MS = 1100 // 限速 ~1 req/s
const MAX_RETRIES = 3
const MAX_CONTENT_CHARS = 5000

function parseArgs () {
  const args = { category: null, limit: null }
  for (const arg of process.argv.slice(2)) {
    const m1 = arg.match(/^--category=(.+)$/)
    if (m1) args.category = m1[1]
    const m2 = arg.match(/^--limit=(\d+)$/)
    if (m2) args.limit = parseInt(m2[1], 10)
  }
  return args
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWikitext (title) {
  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    format: 'json',
    prop: 'wikitext',
    formatversion: '2',
    redirects: '1'
  })
  const url = `${WIKI_API}?${params.toString()}`

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ModCrafting/1.0 (+https://github.com/newstarbar/ModCrafting)' } })
      if (res.status === 429) {
        console.warn(`  [rate-limited] 等待 5s 后重试 (${attempt}/${MAX_RETRIES})`)
        await sleep(5000)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (json.error) {
        if (json.error.code === 'missingtitle') return null
        throw new Error(`API error: ${json.error.info || json.error.code}`)
      }
      return json.parse
    } catch (err) {
      console.warn(`  [retry ${attempt}/${MAX_RETRIES}] ${err.message}`)
      if (attempt === MAX_RETRIES) throw err
      await sleep(2000 * attempt)
    }
  }
  return null
}

/** 极简 wikitext → markdown 转换：保留信息框关键属性 + 标题 + 表格 + 链接 */
function wikitextToMarkdown (wikitext, title) {
  if (!wikitext) return ''
  let md = wikitext

  // 提取信息框（{{Block}}/{{Item}}/{{Entity}}/{{Food}}/{{BlockEntity}}）的关键属性
  const infoboxLines = []
  const infoboxMatch = md.match(/\{\{(Block|Item|Entity|Food|BlockEntity|Object|Enchantment|Biome|Effect|StatusEffect)\s*\n([\s\S]*?)\n\}\}/)
  if (infoboxMatch) {
    infoboxLines.push(`> 信息框 (${infoboxMatch[1]}):`)
    const fields = infoboxMatch[2].split('\n')
    for (const line of fields) {
      const m = line.match(/^\s*\|\s*([^=]+?)\s*=\s*(.+?)\s*$/)
      if (m) {
        const key = m[1].trim()
        const val = m[2].trim().replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/'''/g, '').replace(/''/g, '')
        infoboxLines.push(`> - ${key}: ${val}`)
      }
    }
  }

  // 移除所有其他模板 {{...}}（多行）
  md = md.replace(/\{\{(?!\s*(?:!\s*=|Block|Item|Entity|Food|BlockEntity|Object|Enchantment|Biome|Effect|StatusEffect)\b)[^{}]*?\}\}/gs, '')
  md = md.replace(/\{\{[^{}]*?\}\}/g, '')

  // 转换标题
  md = md.replace(/^======\s*(.+?)\s*======\s*$/gm, '###### $1')
  md = md.replace(/^=====\s*(.+?)\s*=====\s*$/gm, '##### $1')
  md = md.replace(/^====\s*(.+?)\s*====\s*$/gm, '#### $1')
  md = md.replace(/^===\s*(.+?)\s*===\s*$/gm, '### $1')
  md = md.replace(/^==\s*(.+?)\s*==\s*$/gm, '## $1')
  md = md.replace(/^=\s*(.+?)\s*=\s*$/gm, '# $1')

  // 转换链接 [[Article|text]] → [text](#article)，[[Article]] → [Article](#article)
  md = md.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '[$2](#$1)')
  md = md.replace(/\[\[([^\]]+)\]\]/g, '[$1](#$1)')

  // 转换粗体/斜体
  md = md.replace(/'''(.+?)'''/g, '**$1**')
  md = md.replace(/''(.+?)''/g, '*$1*')

  // 转换表格 {| ... |}（简化版）
  md = md.replace(/^\{\|[^\n]*\n([\s\S]*?)\|\}\s*$/gm, (match, body) => {
    const rows = body.split(/^\|-/m).filter((r) => r.trim())
    const mdRows = rows.map((row) => {
      const cells = row.split(/\n\|/).map((c) => c.replace(/^\|/, '').trim()).filter(Boolean)
      if (cells.length === 0) return ''
      // 第一行作为表头
      return `| ${cells.join(' | ')} |`
    }).filter(Boolean)
    if (mdRows.length === 0) return ''
    const headerSep = `| ${mdRows[0].split('|').slice(1, -1).map(() => '---').join(' | ')} |`
    return `${mdRows[0]}\n${headerSep}\n${mdRows.slice(1).join('\n')}`
  })

  // 移除 HTML 注释
  md = md.replace(/<!--[\s\S]*?-->/g, '')
  // 移除 <ref>...</ref>
  md = md.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
  md = md.replace(/<ref[^>]*\/>/g, '')
  // 移除 __TOC__ __NOTOC__ 等
  md = md.replace(/__[A-Z]+__/g, '')
  // 移除分类链接
  md = md.replace(/\[\[(?:Category|分类):[^\]]+\]\]/g, '')

  // 多余空行压缩
  md = md.replace(/\n{3,}/g, '\n\n').trim()

  // 截断超长内容
  if (md.length > MAX_CONTENT_CHARS) {
    md = md.slice(0, MAX_CONTENT_CHARS) + '\n\n<!-- truncated -->'
  }

  const header = infoboxLines.length > 0 ? `${infoboxLines.join('\n')}\n\n` : ''
  return header + md
}

function extractStandardId (wikitext) {
  if (!wikitext) return null
  // 信息框中常见 |id= 或 |legacyid=
  const m = wikitext.match(/\|\s*(?:id|legacyid|identifier)\s*=\s*([a-z0-9_:]+)/i)
  if (m) return m[1].startsWith('minecraft:') ? m[1] : `minecraft:${m[1]}`
  return null
}

async function fetchPage (entry) {
  const parse = await fetchWikitext(entry.title)
  if (!parse) return null
  const wikitext = parse.wikitext || ''
  const md = wikitextToMarkdown(wikitext, entry.title)
  if (!md.trim()) return null
  return {
    title: parse.title || entry.title,
    pageId: parse.pageid || null,
    category: entry.category,
    standardId: entry.standardId || extractStandardId(wikitext),
    markdown: md
  }
}

function writePage (outDir, page) {
  const safeTitle = page.title.replace(/[\\/:*?"<>|]/g, '_')
  const fileName = `${page.pageId || safeTitle}.md`
  const filePath = path.join(outDir, page.category, fileName)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(page.title)}`,
    `category: ${page.category}`,
    page.pageId ? `page_id: ${page.pageId}` : null,
    page.standardId ? `standard_id: ${page.standardId}` : null,
    `fetched_at: ${new Date().toISOString()}`,
    '---',
    ''
  ].filter(Boolean).join('\n')

  fs.writeFileSync(filePath, frontmatter + page.markdown + '\n', 'utf-8')
  return filePath
}

async function main () {
  const args = parseArgs()
  const listPath = path.join(__dirname, 'wiki-pages-list.json')
  const list = JSON.parse(fs.readFileSync(listPath, 'utf-8'))
  const entries = (Array.isArray(list) ? list : list.pages || [])
    .filter((e) => !args.category || e.category === args.category)
    .slice(0, args.limit || Infinity)

  console.log(`待抓取词条: ${entries.length} 条`)

  const outDir = path.join(ROOT, 'resources', 'mc-wiki-zh')
  fs.mkdirSync(outDir, { recursive: true })

  const failures = []
  let okCount = 0
  let skipCount = 0

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    process.stdout.write(`[${i + 1}/${entries.length}] ${entry.title} ... `)
    try {
      const page = await fetchPage(entry)
      if (!page) {
        console.log('MISSING')
        failures.push({ title: entry.title, category: entry.category, reason: 'missing' })
        skipCount++
      } else {
        const filePath = writePage(outDir, page)
        console.log(`OK → ${path.relative(ROOT, filePath)}`)
        okCount++
      }
    } catch (err) {
      console.log(`FAIL: ${err.message}`)
      failures.push({ title: entry.title, category: entry.category, reason: err.message })
      skipCount++
    }
    if (i < entries.length - 1) await sleep(RATE_LIMIT_MS)
  }

  // 写入失败清单
  fs.writeFileSync(
    path.join(outDir, '.failures.json'),
    JSON.stringify({ failedAt: new Date().toISOString(), failures }, null, 2),
    'utf-8'
  )

  console.log(`\n[done] 成功 ${okCount} 条，跳过/失败 ${skipCount} 条`)
  if (failures.length > 0) {
    console.log(`失败清单：${path.relative(ROOT, path.join(outDir, '.failures.json'))}`)
  }
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
