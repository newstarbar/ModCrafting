/**
 * Sync Fabric official Chinese develop docs into resources/agent-knowledge.
 * Usage: node --experimental-strip-types scripts/sync-fabric-docs-knowledge.ts [fabric-docs-root]
 *
 * Defaults to temp/fabric-docs-main. Copies translated/zh_cn/develop, overlays
 * versions/1.21.4/translated/zh_cn/develop when present, and inlines reference snippets:
 *   <<< @/reference/...#region
 *   @[code transcludeWith=:::tag](@/reference/...)
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.join(import.meta.dirname || __dirname, '..')
const DEFAULT_DOCS_ROOT = path.join(ROOT, 'temp', 'fabric-docs-main')
const OUT_DIR = path.join(ROOT, 'resources', 'agent-knowledge', 'fabric', 'docs', 'develop')
const INDEX_PATH = path.join(ROOT, 'resources', 'agent-knowledge', 'fabric', 'docs', 'index.md')
const LEGACY_FLAT = [
  'items-first-item.md',
  'blocks-first-block.md',
  'data-generation-setup.md',
  'mixins-bytecode.md',
  'debugging.md',
  'events.md',
  'networking.md',
  'loom.md'
]

const INCLUDE_RE = /^<<<\s+@\/([^\s#]+)(?:#(\S+))?\s*$/gm
const CODE_INCLUDE_RE = /@\[code([^\]]*)\]\(@\/([^)\s]+)\)/g

function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) out.push(full)
    }
  }
  walk(dir)
  return out
}

function relativePosix(from: string, file: string): string {
  return path.relative(from, file).split(path.sep).join('/')
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractHashRegion(source: string, region: string): string | null {
  const lines = source.split(/\r?\n/)
  const chunks: string[] = []
  let collecting: string[] | null = null
  const startRe = new RegExp(`(?:^|\\s)#region\\s+${escapeReg(region)}\\b`)
  const endRe = new RegExp(`(?:^|\\s)#endregion\\s+${escapeReg(region)}\\b`)

  for (const line of lines) {
    const trimmed = line.trim()
    if (startRe.test(trimmed)) {
      collecting = []
      continue
    }
    if (collecting && endRe.test(trimmed)) {
      chunks.push(collecting.join('\n'))
      collecting = null
      continue
    }
    if (collecting) collecting.push(line)
  }
  return chunks.length > 0 ? chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() : null
}

/** 1.21.4 docs: // :::tag ... // :::tag */
function extractColonRegion(source: string, region: string): string | null {
  const lines = source.split(/\r?\n/)
  const chunks: string[] = []
  let collecting: string[] | null = null
  const markerRe = new RegExp(`^/{0,2}\\s*:::${escapeReg(region)}\\s*$`)

  for (const line of lines) {
    const trimmed = line.trim()
    if (markerRe.test(trimmed)) {
      if (collecting) {
        chunks.push(collecting.join('\n'))
        collecting = null
      } else {
        collecting = []
      }
      continue
    }
    if (collecting) collecting.push(line)
  }
  return chunks.length > 0 ? chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() : null
}

function extractRegion(source: string, region: string | undefined): string {
  if (!region) return source.trimEnd()
  return (
    extractHashRegion(source, region) ||
    extractColonRegion(source, region) ||
    `// region ${region} not found — showing file head\n${source.split(/\r?\n/).slice(0, 40).join('\n')}`
  )
}

function extractTranscludeAttr(attrBlock: string): string | undefined {
  const m = attrBlock.match(/transcludeWith=:::(\S+)/)
  return m?.[1]
}

function guessFenceLang(filePath: string): string {
  if (filePath.endsWith('.java')) return 'java'
  if (filePath.endsWith('.json')) return 'json'
  if (filePath.endsWith('.gradle') || filePath.endsWith('.kts')) return 'groovy'
  if (filePath.endsWith('.md')) return 'md'
  return ''
}

function resolveInclude(
  docsRoot: string,
  includePath: string,
  region: string | undefined
): string {
  const preferred = includePath.replace(/^reference\/(?:latest|[\d.]+)\//, '')
  const candidates = [
    path.join(docsRoot, 'reference', '1.21.4', preferred),
    path.join(docsRoot, includePath),
    path.join(docsRoot, 'reference', 'latest', preferred)
  ]
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const raw = fs.readFileSync(candidate, 'utf-8')
    const body = extractRegion(raw, region)
    const lang = guessFenceLang(candidate)
    return `\n\`\`\`${lang}\n${body}\n\`\`\`\n`
  }
  return `\n\`\`\`\n// missing reference: ${includePath}${region ? '#' + region : ''}\n\`\`\`\n`
}

function processMarkdown(docsRoot: string, content: string): string {
  let out = content.replace(INCLUDE_RE, (_full, includePath: string, region?: string) => {
    return resolveInclude(docsRoot, includePath, region)
  })
  out = out.replace(CODE_INCLUDE_RE, (_full, attrs: string, includePath: string) => {
    const region = extractTranscludeAttr(attrs || '')
    return resolveInclude(docsRoot, includePath, region)
  })
  return out
}

function copyTree(srcDir: string, destDir: string, docsRoot: string): number {
  const files = walkMarkdown(srcDir)
  let n = 0
  for (const file of files) {
    const rel = relativePosix(srcDir, file)
    const dest = path.join(destDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const raw = fs.readFileSync(file, 'utf-8')
    fs.writeFileSync(dest, processMarkdown(docsRoot, raw), 'utf-8')
    n++
  }
  return n
}

function writeIndex(developDir: string): void {
  const files = walkMarkdown(developDir)
    .map((f) => relativePosix(developDir, f))
    .sort()
  const byTop = new Map<string, string[]>()
  for (const rel of files) {
    const top = rel.includes('/') ? rel.split('/')[0] : '(root)'
    if (!byTop.has(top)) byTop.set(top, [])
    byTop.get(top)!.push(rel)
  }
  const sections: string[] = [
    '# Fabric 开发文档索引（本地）',
    '',
    '> 来源：FabricMC/fabric-docs `translated/zh_cn/develop`，并叠加 `versions/1.21.4` 中文页；代码片段已内联。运行时不联网。',
    '',
    `共 ${files.length} 篇。`,
    ''
  ]
  for (const [top, list] of [...byTop.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sections.push(`## ${top}`, '')
    for (const rel of list) {
      sections.push(`- [${rel.replace(/\.md$/, '')}](./develop/${rel})`)
    }
    sections.push('')
  }
  fs.writeFileSync(INDEX_PATH, sections.join('\n'), 'utf-8')
}

function removeLegacyFlat(): void {
  const docsDir = path.join(ROOT, 'resources', 'agent-knowledge', 'fabric', 'docs')
  for (const name of LEGACY_FLAT) {
    const p = path.join(docsDir, name)
    if (fs.existsSync(p)) {
      fs.unlinkSync(p)
      console.log(`Removed legacy ${name}`)
    }
  }
}

function main(): void {
  const docsRoot = path.resolve(process.argv[2] || DEFAULT_DOCS_ROOT)
  if (!fs.existsSync(docsRoot)) {
    console.error(`Fabric docs root not found: ${docsRoot}`)
    console.error('Place fabric-docs at temp/fabric-docs-main or pass the path as argv[2].')
    process.exit(1)
  }

  const primary = path.join(docsRoot, 'translated', 'zh_cn', 'develop')
  const overlay = path.join(docsRoot, 'versions', '1.21.4', 'translated', 'zh_cn', 'develop')
  if (!fs.existsSync(primary)) {
    console.error(`Missing ${primary}`)
    process.exit(1)
  }

  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log(`Primary: ${primary}`)
  console.log(`Copied ${copyTree(primary, OUT_DIR, docsRoot)} files from translated/zh_cn/develop`)

  if (fs.existsSync(overlay)) {
    console.log(`Overlay: ${overlay}`)
    console.log(`Overlaid ${copyTree(overlay, OUT_DIR, docsRoot)} files from versions/1.21.4 (zh_cn)`)
  } else {
    console.log('No versions/1.21.4 zh_cn overlay (skipped)')
  }

  writeIndex(OUT_DIR)
  removeLegacyFlat()
  console.log(`Wrote ${INDEX_PATH}`)
  console.log('Done.')
}

main()
