#!/usr/bin/env node
/**
 * 下载预构建的 Minecraft 知识库产物到 resources/ 目录
 *
 * 用法：
 *   node scripts/knowledge/download-knowledge-base.mjs [--force] [--repo=owner/repo]
 *
 * 数据源（2026-08 重构后移除 Gitee 依赖）：
 *   仅查询 GitHub API；每个 asset 提供「gh.xmly.dev 代理」与「GitHub 直连」两个 URL，
 *   下载时优先代理（国内加速），失败自动回退直连。SHA256 校验保证中转完整性。
 *
 * 版本管理：
 *   - resources/.knowledge-version 记录当前已下载版本
 *   - 已是最新版本时跳过下载（除非 --force）
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..')

const DEFAULT_REPO = 'newstarbar/ModCrafting-knowledge-base'

// GitHub 代理前缀（与 src/main/github-mirror.ts 保持一致）
const GITHUB_PROXY_PREFIX = 'https://gh.xmly.dev/'

const RESOURCES_DIR = path.join(ROOT, 'resources')
const VERSION_FILE = path.join(RESOURCES_DIR, '.knowledge-version')
const TMP_DIR = path.join(ROOT, 'temp', 'knowledge-download')

// 知识库产物映射：(zip文件名 → 解压目标目录名)
const ARTIFACTS = [
  { zip: 'minecraft-data.zip', dir: 'minecraft-data' },
  { zip: 'mc-wiki-zh.zip', dir: 'mc-wiki-zh' },
  { zip: 'mc-wiki-zh-index.zip', dir: 'mc-wiki-zh-index' },
  { zip: 'mc-wiki-model.zip', dir: 'mc-wiki-model' }
]

function parseArgs () {
  const args = { force: false, repo: DEFAULT_REPO }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--force') args.force = true
    else if (arg.startsWith('--repo=')) args.repo = arg.slice(7)
  }
  return args
}

function getMcVersion () {
  const versionsPath = path.join(RESOURCES_DIR, 'fabric-versions.json')
  if (!existsSync(versionsPath)) {
    throw new Error(`缺少 ${versionsPath}，无法确定 MC 版本`)
  }
  const versions = JSON.parse(readFileSync(versionsPath, 'utf-8'))
  return versions.minecraft_version
}

function getLocalVersion () {
  if (!existsSync(VERSION_FILE)) return null
  try {
    const data = JSON.parse(readFileSync(VERSION_FILE, 'utf-8'))
    return data.tag || null
  } catch {
    return null
  }
}

/**
 * 查询 GitHub API 获取最新知识库 Release
 */
async function queryGitHubRelease (repo, mcVersion) {
  const url = `https://api.github.com/repos/${repo}/releases`
  console.log(`[knowledge] 查询 GitHub Release: ${url}`)

  const res = await fetch(url, {
    headers: { 'User-Agent': 'ModCrafting/1.0', Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) {
    throw new Error(`GitHub API 返回 ${res.status}: ${await res.text()}`)
  }
  const releases = await res.json()

  // 查找匹配 MC 版本的最新 Release（标签格式：knowledge-<mcVersion>-<date>）
  const prefix = `knowledge-${mcVersion}-`
  const matched = releases
    .filter((r) => r.tag_name && r.tag_name.startsWith(prefix))
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name))

  if (matched.length === 0) {
    throw new Error(`未找到匹配 MC ${mcVersion} 的知识库 Release（标签前缀: ${prefix}）`)
  }
  return matched[0]
}

/**
 * 包裹 GitHub URL：仅对 github.com / raw.githubusercontent.com 加 gh.xmly.dev 代理前缀
 */
function wrapGithubProxy (url) {
  if (!url) return url
  if (url.startsWith('https://github.com/') || url.startsWith('https://raw.githubusercontent.com/')) {
    return `${GITHUB_PROXY_PREFIX}${url}`
  }
  return url
}

/**
 * 下载单个 URL 到 destPath（带进度显示）
 */
async function downloadFromUrl (url, destPath, label) {
  console.log(`[knowledge]   下载 ${label} ...`)
  console.log(`[knowledge]   URL: ${url}`)
  const res = await fetch(url, { headers: { 'User-Agent': 'ModCrafting/1.0' } })
  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status} - ${url}`)
  }
  const totalBytes = parseInt(res.headers.get('content-length') || '0', 10)
  let downloadedBytes = 0

  mkdirSync(path.dirname(destPath), { recursive: true })
  await pipeline(
    res.body,
    async function* (source) {
      const fileStream = createWriteStream(destPath)
      try {
        for await (const chunk of source) {
          downloadedBytes += chunk.length
          fileStream.write(chunk)
          if (totalBytes > 0) {
            const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1)
            process.stdout.write(`\r[knowledge]   ${label}: ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`)
          }
        }
        process.stdout.write('\n')
      } finally {
        fileStream.end()
      }
      // 等待文件写入完成
      await new Promise((resolve) => fileStream.on('finish', resolve))
    }
  )
}

/**
 * 下载文件到指定路径：先试 gh.xmly.dev 代理，失败回退 GitHub 直连
 */
async function downloadFile (proxiedUrl, directUrl, destPath, label) {
  try {
    await downloadFromUrl(proxiedUrl, destPath, label)
  } catch (err) {
    console.log(`[knowledge]   代理下载失败: ${err.message}，回退 GitHub 直连 ...`)
    if (existsSync(destPath)) rmSync(destPath, { force: true })
    await downloadFromUrl(directUrl, destPath, label)
  }
}

function sha256 (filePath) {
  const h = createHash('sha256')
  h.update(readFileSync(filePath))
  return h.digest('hex')
}

/**
 * 解压 zip 文件到目标目录（跨平台，使用 PowerShell/tar）
 */
function extractZip (zipPath, destDir) {
  mkdirSync(destDir, { recursive: true })
  // Windows 使用 PowerShell 的 Expand-Archive
  // Linux/Mac 使用 tar（支持 zip）
  if (process.platform === 'win32') {
    const result = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
    ], { stdio: 'pipe', shell: false })
    if (result.status !== 0) {
      throw new Error(`Expand-Archive 失败: ${result.stderr?.toString() || result.status}`)
    }
  } else {
    const result = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'pipe', shell: false })
    if (result.status !== 0) {
      throw new Error(`tar 解压失败: ${result.status}`)
    }
  }
}

async function main () {
  const args = parseArgs()
  const mcVersion = getMcVersion()

  console.log(`[knowledge] MC 版本: ${mcVersion}`)
  console.log(`[knowledge] 仓库: ${args.repo}`)

  // 检查本地版本
  const localVersion = getLocalVersion()
  if (!args.force && localVersion) {
    console.log(`[knowledge] 本地版本: ${localVersion}`)
  }

  // 查询最新 Release（仅 GitHub API；assets 走 gh.xmly.dev 代理 + GitHub 直连双源）
  let release
  try {
    release = await queryGitHubRelease(args.repo, mcVersion)
    console.log(`[knowledge] 找到 GitHub Release: ${release.tag_name}`)
  } catch (err) {
    console.error(`[knowledge][fatal] GitHub 查询失败: ${err.message}`)
    console.error('')
    console.error('[knowledge] 无法下载知识库。请检查网络连接或手动构建：')
    console.error('  https://github.com/newstarbar/ModCrafting-knowledge-base')
    process.exit(1)
  }

  // 版本对比
  const remoteTag = release.tag_name
  if (!args.force && localVersion === remoteTag) {
    console.log(`[knowledge] 已是最新版本（${remoteTag}），跳过下载。使用 --force 强制重新下载。`)
    return
  }

  console.log(`[knowledge] 远程版本: ${remoteTag}`)

  // 准备临时目录
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true })
  }
  mkdirSync(TMP_DIR, { recursive: true })

  // 获取资产下载链接（每项提供 proxied + direct 两版本，downloadFile 自动选优）
  const assets = (release.assets || []).map((a) => ({
    name: a.name,
    proxied: wrapGithubProxy(a.browser_download_url),
    direct: a.browser_download_url
  }))

  // 下载 manifest.json
  const manifestAsset = assets.find((a) => a.name === 'manifest.json')
  let manifest = null
  if (manifestAsset) {
    const manifestPath = path.join(TMP_DIR, 'manifest.json')
    await downloadFile(manifestAsset.proxied, manifestAsset.direct, manifestPath, 'manifest.json')
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    console.log(`[knowledge] manifest.json 已下载，包含 ${manifest.files?.length || 0} 个文件`)
  }

  // 下载并解压各产物
  for (const artifact of ARTIFACTS) {
    const asset = assets.find((a) => a.name === artifact.zip)
    if (!asset) {
      console.warn(`[knowledge] 警告: Release 中缺少 ${artifact.zip}，跳过`)
      continue
    }

    const zipPath = path.join(TMP_DIR, artifact.zip)
    await downloadFile(asset.proxied, asset.direct, zipPath, artifact.zip)

    // SHA256 验证
    if (manifest) {
      const expected = manifest.files?.find((f) => f.name === artifact.zip)
      if (expected) {
        const actual = sha256(zipPath)
        if (actual !== expected.sha256) {
          throw new Error(`${artifact.zip} SHA256 校验失败: 期望 ${expected.sha256.slice(0, 12)}...，实际 ${actual.slice(0, 12)}...`)
        }
        console.log(`[knowledge]   SHA256 验证通过`)
      }
    }

    // 解压到 resources/ 目录
    const destDir = path.join(RESOURCES_DIR, artifact.dir)
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true })
    }
    console.log(`[knowledge]   解压到 resources/${artifact.dir}/ ...`)
    extractZip(zipPath, destDir)
  }

  // 写入版本文件
  const versionData = {
    tag: remoteTag,
    mcVersion,
    source: 'github',
    downloadedAt: new Date().toISOString()
  }
  writeFileSync(VERSION_FILE, JSON.stringify(versionData, null, 2), 'utf-8')

  // 清理临时目录
  rmSync(TMP_DIR, { recursive: true, force: true })

  console.log('')
  console.log(`[knowledge] 知识库下载完成: ${remoteTag}`)
  console.log(`[knowledge] 版本记录: ${path.relative(ROOT, VERSION_FILE)}`)
  console.log('[knowledge] 产物目录:')
  for (const artifact of ARTIFACTS) {
    const dir = path.join(RESOURCES_DIR, artifact.dir)
    if (existsSync(dir)) {
      const size = dirSizeMb(dir)
      console.log(`  resources/${artifact.dir}/ (${size} MB)`)
    }
  }
}

function dirSizeMb (p) {
  let total = 0
  const walk = (d) => {
    const entries = readdirSync(d, { withFileTypes: true })
    for (const ent of entries) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  if (existsSync(p)) walk(p)
  return (total / 1024 / 1024).toFixed(1)
}

main().catch((err) => {
  console.error(`[knowledge][fatal] ${err.message || err}`)
  // 清理临时目录
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true })
  }
  process.exit(1)
})
