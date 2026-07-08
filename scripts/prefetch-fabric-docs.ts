// Download Fabric development documentation from docs.fabricmc.net
// Usage: node --experimental-strip-types scripts/prefetch-fabric-docs.ts

import * as fs from 'fs'
import * as path from 'path'

const DOCS_DIR = path.join(import.meta.dirname || __dirname, '..', 'resources', 'agent-knowledge', 'fabric', 'docs')

/** Core bundled docs only; other topics are indexed for online fetch. */
const PAGES: Array<{ url: string; name: string }> = [
  { url: 'https://docs.fabricmc.net/zh_cn/develop/items/first-item', name: 'items-first-item' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/blocks/first-block', name: 'blocks-first-block' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/data-generation/setup', name: 'data-generation-setup' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/mixins/bytecode', name: 'mixins-bytecode' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/debugging', name: 'debugging' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/events', name: 'events' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/networking', name: 'networking' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/loom/', name: 'loom' }
]

const ONLINE_ONLY_PAGES: Array<{ url: string; name: string }> = [
  { url: 'https://docs.fabricmc.net/zh_cn/develop/fluids/first-fluid', name: 'fluids-first-fluid' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/entities/first-entity', name: 'entities-first-entity' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/sounds/using-sounds', name: 'sounds-using-sounds' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/commands/basics', name: 'commands-basics' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/rendering/basic-concepts', name: 'rendering-basic-concepts' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/serialization/codecs', name: 'serialization-codecs' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/loader/', name: 'loader' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/class-tweakers/', name: 'class-tweakers' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/automatic-testing', name: 'automatic-testing' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/custom-recipe-types', name: 'custom-recipe-types' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/game-rules', name: 'game-rules' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/key-mappings', name: 'key-mappings' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/resource-conditions', name: 'resource-conditions' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/statistics', name: 'statistics' },
  { url: 'https://docs.fabricmc.net/zh_cn/develop/text-and-translations', name: 'text-and-translations' }
]

/**
 * Convert Fabric Wiki HTML to clean markdown.
 *
 * Handles: headings, paragraphs, code blocks (with line-number stripping),
 * lists, links, and inline code. Strips navigation/sidebar/footer noise.
 */
function htmlToMarkdown(html: string): string {
  // 1. Extract main content area
  let main = html
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*(?:content|page|wiki-content|dw-content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  if (mainMatch) main = mainMatch[1]

  // 2. Remove nav, footer, header, script, style, sidebar elements
  main = main.replace(/<(?:nav|footer|header|script|style|aside|noscript)[\s\S]*?<\/(?:nav|footer|header|script|style|aside|noscript)>/gi, '')
  main = main.replace(/<div[^>]*class="[^"]*(?:sidebar|nav|toc|breadcrumb|pagination|footer|header)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')

  // 3. Extract code blocks BEFORE stripping other tags.
  // Shiki syntax-highlighted code: <pre class="shiki ..."><code><span class="line">...</span></code></pre>
  const codeBlocks: string[] = []
  main = main.replace(/<pre class="shiki[^"]*"[^>]*><code>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => {
    // Strip ALL HTML tags — newlines between <span class="line"> elements are preserved
    let cleaned = code.replace(/<[^>]+>/g, '')
    cleaned = decodeEntities(cleaned)
    cleaned = cleaned.split('\n').map((l: string) => l.trimEnd()).join('\n').trim()
    codeBlocks.push(cleaned)
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`
  })

  // Remove the now-empty code block wrappers (line-numbers, copy buttons, etc.)
  main = main.replace(/<div class="language-\w+[^"]*"[^>]*>[\s\S]*?%%CODEBLOCK_\d+%%[\s\S]*?<\/div>/gi,
    (_, idx) => { const m = _.match(/%%CODEBLOCK_(\d+)%%/); return m ? `%%CODEBLOCK_${m[1]}%%` : _ })
  // Clean up any remaining line-number artifacts
  main = main.replace(/<div[^>]*line-number[^>]*>[\s\S]*?<\/div>/gi, '')
  // Remove orphaned consecutive numbers (line number residue)
  main = main.replace(/\n\s*(\d+\s+){3,}\d+\s*\n/g, '\n')

  // 4. Handle inline <code> tags
  const inlineCodes: string[] = []
  main = main.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    const cleaned = decodeEntities(code.replace(/<[^>]+>/g, ''))
    const placeholder = `%%INLINECODE_${inlineCodes.length}%%`
    inlineCodes.push(cleaned)
    return placeholder
  })

  // 5. Convert structural HTML to markdown
  main = main.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n\n# ${decodeEntities(stripTags(t))}\n\n`)
  main = main.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n\n## ${decodeEntities(stripTags(t))}\n\n`)
  main = main.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n\n### ${decodeEntities(stripTags(t))}\n\n`)
  main = main.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n\n#### ${decodeEntities(stripTags(t))}\n\n`)
  main = main.replace(/<p[^>]*>/gi, '\n\n')
  main = main.replace(/<\/p>/gi, '')
  main = main.replace(/<br\s*\/?>/gi, '\n')
  main = main.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${decodeEntities(stripTags(t))}`)
  main = main.replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n')
  main = main.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `**${decodeEntities(stripTags(t))}**`)
  main = main.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, t) => `*${decodeEntities(stripTags(t))}*`)
  main = main.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = decodeEntities(stripTags(text))
    return href.startsWith('#') ? t : `[${t}](${href})`
  })

  // 6. Strip remaining tags
  main = main.replace(/<[^>]+>/g, ' ')

  // 7. Restore inline code (code blocks restored AFTER spacing cleanup, see step 10)
  inlineCodes.forEach((code, i) => {
    main = main.replace(`%%INLINECODE_${i}%%`, `\`${code}\``)
  })

  // 8. Aggressive whitespace normalization for proper markdown structure
  // Step A: Ensure every heading starts on its own line with blank line before
  main = main.replace(/([^\n])(#{1,4}\s[^\n]+)/g, '$1\n\n$2')
  main = main.replace(/^#{1,4}\s/gm, '\n$&')  // headings at start of line need leading blank
  // Step B: Ensure blank lines between paragraphs (but not around code placeholders)
  main = main.replace(/([^\n])(%%CODEBLOCK_\d+%%)/g, '$1\n\n$2')
  main = main.replace(/(%%CODEBLOCK_\d+%%)([^\n])/g, '$1\n\n$2')
  // Step C: Collapse all whitespace runs
  main = main.replace(/\n{3,}/g, '\n\n')
  main = main.replace(/[ \t]{2,}/g, ' ')
  main = main.replace(/^[ \t]+|[ \t]+$/gm, '')
  // Step D: Remove blank lines inside code blocks (keep code compact)
  // (skip — handled by code block boundaries)
  // Step E: Join multiple blank lines into one
  main = main.replace(/\n{2,}/g, '\n\n')
  main = main.trim()

  // 9. Remove noise lines (navigation crumbs, version numbers, etc.)
  main = main.split('\n').filter((l) => {
    const t = l.trim()
    if (!t) return true  // keep blank lines for spacing
    if (/^(Skip to|Toggle|Cookie|Privacy|Edit this|Last modified|Navigation|Footer|Menu|Table of Contents)$/i.test(t)) return false
    if (/^\d+\.\d+\.\d+$/.test(t)) return false
    if (/^[0-9\s]{10,}$/.test(t)) return false
    return true
  }).join('\n')

  // Step F: Final collapse — no triple newlines
  main = main.replace(/\n{3,}/g, '\n\n').trim()

  // 10. Restore code blocks — after ALL spacing cleanup so fences stay intact
  codeBlocks.forEach((block, i) => {
    const lang = block.includes('{') || block.includes('class ') || block.includes('@') ? 'java' : ''
    main = main.replace(`%%CODEBLOCK_${i}%%`, `\n\n\`\`\`${lang}\n${block}\n\`\`\`\n\n`)
  })

  // 11. Final pass — fix any remaining inline code block markers that got split
  main = main.replace(/```\n\n(\w+)\n/g, '```$1\n')  // Rejoin language tag with fence
  main = main.replace(/\n{3,}/g, '\n\n').trim()

  return main
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/g, "'")
    .replace(/&apos;/g, "'")
}

async function fetchPage(url: string): Promise<string | null> {
  console.log(`  Fetching ${url}...`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ModCrafting/1.0 (+https://github.com/modcrafting)' }
    })
    if (!response.ok) {
      console.log(`    HTTP ${response.status}`)
      return null
    }
    const html = await response.text()
    const content = htmlToMarkdown(html)
    const title = url.split('/').pop()?.replace(/-/g, ' ') || 'index'
    const pageContent = `# ${title}\n> 来源: ${url}\n\n${content}`
    return pageContent
  } catch (err) {
    console.log(`    Error: ${String(err)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(DOCS_DIR, { recursive: true })

  let success = 0
  let fail = 0

  for (const page of PAGES) {
    const content = await fetchPage(page.url)
    const filePath = path.join(DOCS_DIR, `${page.name}.md`)
    if (content) {
      // Add 2s delay between requests to be polite
      await new Promise((r) => setTimeout(r, 2000))
      fs.writeFileSync(filePath, content, 'utf-8')
      const size = Buffer.byteLength(content, 'utf-8')
      console.log(`  Saved ${page.name}.md (${(size / 1024).toFixed(1)} KB)`)
      success++
    } else {
      console.log(`  FAILED: ${page.name}`)
      fail++
    }
  }

  // Write index (bundled + online-only URL list)
  const bundledSection = PAGES
    .map((p) => `- [${p.name}](./${p.name}.md): ${p.url}`)
    .join('\n')
  const onlineSection = ONLINE_ONLY_PAGES
    .map((p) => `- ${p.name}: ${p.url}`)
    .join('\n')
  const indexContent = `# Fabric 开发文档索引

## 本地 bundled（可离线搜索）

${bundledSection}

## 联网-only（未 bundled，搜索时可 fetch）

${onlineSection}
`
  fs.writeFileSync(path.join(DOCS_DIR, 'index.md'), `${indexContent}\n`, 'utf-8')

  console.log(`\nDone: ${success} downloaded, ${fail} failed.`)
  console.log(`Docs saved to: ${DOCS_DIR}`)
}

main()
