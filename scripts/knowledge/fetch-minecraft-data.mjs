#!/usr/bin/env node
/**
 * 从 PrismarineJS/minecraft-data GitHub 仓库拉取指定版本的结构化数据。
 * 输出到 resources/minecraft-data/<version>/
 *
 * 用法：node scripts/knowledge/fetch-minecraft-data.mjs [--version=1.21.4]
 *
 * 数据来源：https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/<version>/
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..')

const REPO_BASE = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc'

// 锁定 commit 以避免上游结构变更导致构建失败（可手动升级）
const REPO_COMMIT = 'master'

const VERSION_FILES = [
  'blocks.json',
  'items.json',
  'materials.json',
  'recipes.json',
  'entities.json',
  'enchantments.json',
  'biomes.json',
  'effects.json',
  'foods.json',
  'instruments.json',
  'tints.json',
  'particles.json',
  'paintings.json',
  'banner_pattern.json'
]

const COMMON_DIRS = [
  'recipes',
  'lootTables',
  'blockLoot',
  'entityLoot',
  'chestLoot',
  'fishingLoot',
  'giftLoot'
]

const LANG_FILES = [
  { src: 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.21.4/assets/minecraft/lang/zh_cn.json', dest: 'lang/zh_cn.json' },
  { src: 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.21.4/assets/minecraft/lang/en_us.json', dest: 'lang/en_us.json' }
]

function parseArgs () {
  const args = { version: null }
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--version=(.+)$/)
    if (m) args.version = m[1]
  }
  return args
}

function readDefaultVersion () {
  try {
    const versions = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'fabric-versions.json'), 'utf-8'))
    return versions.minecraft_version || '1.21.4'
  } catch {
    return '1.21.4'
  }
}

async function fetchJson (url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ModCrafting/1.0 (+https://github.com/newstarbar/ModCrafting)' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function fetchText (url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ModCrafting/1.0 (+https://github.com/newstarbar/ModCrafting)' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

async function fetchRawGithubList (url) {
  // GitHub raw 没有目录列表 API；用 github.com API 列目录
  // url 形如 https://raw.githubusercontent.com/.../master/data/pc/common/recipes
  const m = url.match(/githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
  if (!m) return []
  const [, owner, repo, ref, repoPath] = m
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}?ref=${ref}`
  try {
    const list = await fetchJson(api)
    if (!Array.isArray(list)) return []
    return list.filter((e) => e.type === 'file' && e.download_url).map((e) => ({ name: e.name, url: e.download_url }))
  } catch (err) {
    console.warn(`[warn] 列目录失败 ${repoPath}: ${err.message}`)
    return []
  }
}

async function ensureDir (filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

async function writeIfChanged (filePath, content) {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8')
    if (existing === content) {
      console.log(`[skip] ${path.relative(ROOT, filePath)} (unchanged)`)
      return false
    }
  }
  await ensureDir(filePath)
  fs.writeFileSync(filePath, content, 'utf-8')
  console.log(`[ok] ${path.relative(ROOT, filePath)} (${content.length} bytes)`)
  return true
}

async function fetchVersionFiles (version, outDir) {
  console.log(`\n=== 拉取 minecraft-data ${version} ===`)
  for (const file of VERSION_FILES) {
    const url = `${REPO_BASE}/${version}/${file}`
    const dest = path.join(outDir, file)
    try {
      const text = await fetchText(url)
      await writeIfChanged(dest, text)
    } catch (err) {
      console.warn(`[warn] 跳过 ${file}: ${err.message}`)
    }
  }
}

async function fetchCommonDirs (version, outDir) {
  console.log(`\n=== 拉取 common 目录 ===`)
  for (const dir of COMMON_DIRS) {
    const listUrl = `${REPO_BASE}/common/${dir}`
    const files = await fetchRawGithubList(listUrl)
    if (files.length === 0) continue
    const destDir = path.join(outDir, 'common', dir)
    for (const entry of files) {
      const dest = path.join(destDir, entry.name)
      try {
        const text = await fetchText(entry.url)
        await writeIfChanged(dest, text)
      } catch (err) {
        console.warn(`[warn] 跳过 ${dir}/${entry.name}: ${err.message}`)
      }
    }
  }
}

async function fetchLangFiles (outDir) {
  console.log(`\n=== 拉取中文语言包 ===`)
  for (const lang of LANG_FILES) {
    const dest = path.join(outDir, lang.dest)
    try {
      const text = await fetchText(lang.src)
      await writeIfChanged(dest, text)
    } catch (err) {
      console.warn(`[warn] 跳过 ${lang.dest}: ${err.message}`)
    }
  }
}

async function main () {
  const args = parseArgs()
  const version = args.version || readDefaultVersion()
  const outDir = path.join(ROOT, 'resources', 'minecraft-data', version)

  console.log(`MC 版本: ${version}`)
  console.log(`输出目录: ${path.relative(ROOT, outDir)}`)

  await fetchVersionFiles(version, outDir)
  await fetchCommonDirs(version, outDir)
  await fetchLangFiles(outDir)

  // 写入 manifest
  const manifest = {
    version,
    source: `https://github.com/PrismarineJS/minecraft-data@${REPO_COMMIT}`,
    fetchedAt: new Date().toISOString()
  }
  await writeIfChanged(path.join(outDir, '.manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`\n[done] minecraft-data ${version} 拉取完成`)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
