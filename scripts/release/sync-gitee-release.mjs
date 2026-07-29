#!/usr/bin/env node
/**
 * Sync release assets to Gitee Releases.
 * Requires env GITEE_TOKEN. Usage: node scripts/sync-gitee-release.mjs <version> [release_dir]
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'fs'
import { spawn } from 'node:child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveGiteeRepo } from './gitee-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')

const version = process.argv[2]
const releaseDir = process.argv[3] || path.join(root, 'release')

if (!version) {
  console.error('Usage: node scripts/sync-gitee-release.mjs <version> [release_dir]')
  process.exit(1)
}

const token = process.env.GITEE_TOKEN
if (!token) {
  console.warn('[gitee] GITEE_TOKEN not set — skip Gitee Release sync')
  process.exit(0)
}

const { owner, repo, source } = resolveGiteeRepo()
const tag = version.startsWith('v') ? version : `v${version}`
const ver = tag.replace(/^v/, '')
const apiBase = 'https://gitee.com/api/v5'
const UPLOAD_TIMEOUT_MS = 45 * 60 * 1000

async function giteeApi(method, endpoint, body) {
  const sep = endpoint.includes('?') ? '&' : '?'
  const url = `${apiBase}${endpoint}${sep}access_token=${token}`
  const res = await fetch(url, {
    method,
    headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new Error(`Gitee API ${method} ${endpoint}: ${res.status} ${text}`)
  }
  return data
}

async function verifyRepoAccess() {
  await giteeApi('GET', `/repos/${owner}/${repo}`)
}

async function getDefaultBranch() {
  const info = await giteeApi('GET', `/repos/${owner}/${repo}`)
  return info?.default_branch || 'main'
}

async function tagExistsOnGitee(tagName) {
  try {
    await giteeApi('GET', `/repos/${owner}/${repo}/tags/${tagName}`)
    return true
  } catch {
    return false
  }
}

async function findReleaseByTag(tagName) {
  try {
    const byTag = await giteeApi('GET', `/repos/${owner}/${repo}/releases/tags/${tagName}`)
    if (byTag?.id) return byTag
  } catch {
    /* list fallback */
  }
  const releases = await listAllReleases()
  return releases.find((r) => r.tag_name === tagName) || null
}

async function listAllReleases() {
  const all = []
  for (let page = 1; page <= 10; page++) {
    const batch = await giteeApi('GET', `/repos/${owner}/${repo}/releases?per_page=100&page=${page}`)
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all
}

/** 同 tag 多条 Release 时删除旧的，只保留最新一条 */
async function cleanupDuplicateReleasesForTag(tagName) {
  const matches = (await listAllReleases()).filter((r) => r.tag_name === tagName)
  if (matches.length <= 1) return matches[0] || null

  matches.sort((a, b) => b.id - a.id)
  const keep = matches[0]
  for (const dup of matches.slice(1)) {
    console.log(`[gitee] Deleting duplicate release #${dup.id} for ${tagName}`)
    await giteeApi('DELETE', `/repos/${owner}/${repo}/releases/${dup.id}`)
  }
  console.log(`[gitee] Kept release #${keep.id} for ${tagName}`)
  return keep
}

async function listAttachFiles(releaseId) {
  try {
    const data = await giteeApi('GET', `/repos/${owner}/${repo}/releases/${releaseId}/attach_files`)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/** 删除旧附件：builder-debug.yml、以及即将重新上传的同名文件 */
async function cleanupStaleAttachments(releaseId, expectedBasenames) {
  const expected = new Set(expectedBasenames.map((n) => n.toLowerCase()))
  const files = await listAttachFiles(releaseId)
  if (files.length === 0) return

  for (const file of files) {
    const name = file.name || file.file_name || ''
    const id = file.id
    if (!id || !name) continue

    const stale =
      /^builder-debug\.yml$/i.test(name) ||
      expected.has(name.toLowerCase())

    if (!stale) continue

    console.log(`[gitee] Removing stale attachment: ${name} (#${id})`)
    await giteeApi('DELETE', `/repos/${owner}/${repo}/releases/${releaseId}/attach_files/${id}`)
  }
}

/** 仅同步用户需要的发布附件，排除 builder-debug.yml / 内部 7z 等 */
function resolveAsset(dir, exactNames, fallbackMatch) {
  for (const name of exactNames) {
    const full = path.join(dir, name)
    if (existsSync(full) && statSync(full).isFile()) return full
  }
  if (fallbackMatch) {
    const hit = readdirSync(dir).find(fallbackMatch)
    if (hit) return path.join(dir, hit)
  }
  return null
}

/** Gitee 免费用户单文件上传限制 100MB */
const GITEE_MAX_FILE_SIZE = 100 * 1024 * 1024

function collectReleaseAssets(dir) {
  if (!existsSync(dir)) return []

  const setup = resolveAsset(
    dir,
    [`ModCrafting Setup ${ver}.exe`, `ModCrafting-Setup-${ver}.exe`],
    (n) => /^ModCrafting[- ]Setup[- ].*\.exe$/i.test(n)
  )
  const portable = resolveAsset(
    dir,
    [`ModCrafting ${ver} Portable.exe`, `ModCrafting-${ver}-Portable.exe`],
    (n) => /^ModCrafting[- ].*Portable\.exe$/i.test(n)
  )
  const latest = resolveAsset(dir, ['latest.yml'], (n) => n === 'latest.yml')
  const blockmap = resolveAsset(
    dir,
    [`ModCrafting Setup ${ver}.exe.blockmap`, `ModCrafting-Setup-${ver}.exe.blockmap`],
    (n) => /^ModCrafting[- ]Setup[- ].*\.blockmap$/i.test(n)
  )

  const allFiles = [latest, blockmap, setup, portable].filter(Boolean)

  // Gitee 单文件限制 100MB，跳过超限文件（如 Setup 完整版）
  const files = []
  for (const f of allFiles) {
    const size = statSync(f).size
    if (size > GITEE_MAX_FILE_SIZE) {
      console.log(`[gitee] 跳过 ${path.basename(f)} (${formatSize(size)})：超过 Gitee 100MB 限制，请从 GitHub Release 下载`)
      continue
    }
    files.push(f)
  }

  if (files.length === 0 && allFiles.length === 0) {
    console.warn('[gitee] expected filenames missing, listing release/:')
    for (const name of readdirSync(dir)) {
      console.warn(`  - ${name}`)
    }
  }

  return files
}

/**
 * 收集 seed 分片文件（manifest.json + seed.part.001 ~ seed.part.00N）。
 * NSIS 瘦包首次启动时从 Gitee 下载这些分片来恢复 Fabric 依赖种子。
 */
function collectSeedShards() {
  const shardsDir = path.join(root, 'resources', 'seed-shards')
  if (!existsSync(shardsDir)) {
    console.warn(`[gitee] seed shards dir not found: ${shardsDir}`)
    return []
  }

  const files = []
  for (const name of readdirSync(shardsDir)) {
    const full = path.join(shardsDir, name)
    if (!statSync(full).isFile()) continue
    // manifest.json + seed.part.NNN
    if (name === 'manifest.json' || /^seed\.part\.\d{3}$/.test(name)) {
      files.push(full)
    }
  }

  if (files.length === 0) {
    console.warn('[gitee] no seed shards found in resources/seed-shards/')
  }

  return files
}

/**
 * 收集 JRE 分片文件（jre-manifest.json + jre.part.001 ~ jre.part.00N）。
 * NSIS 瘦包首次启动时从 Gitee 下载这些分片来恢复 JRE 21。
 */
function collectJreShards() {
  const shardsDir = path.join(root, 'resources', 'jre-shards')
  if (!existsSync(shardsDir)) {
    console.warn(`[gitee] jre shards dir not found: ${shardsDir}`)
    return []
  }

  const files = []
  for (const name of readdirSync(shardsDir)) {
    const full = path.join(shardsDir, name)
    if (!statSync(full).isFile()) continue
    // jre-manifest.json + jre.part.NNN
    if (name === 'jre-manifest.json' || /^jre\.part\.\d{3}$/.test(name)) {
      files.push(full)
    }
  }

  if (files.length === 0) {
    console.warn('[gitee] no jre shards found in resources/jre-shards/')
  }

  return files
}

/**
 * 收集瘦包二期按需下载的辅助资源 zip（agent-knowledge / fabric-symbol-index / base-mods）。
 * NSIS 瘦包首次启动时从 Gitee 下载这些 zip 解压到 runtime/knowledge/。
 */
function collectExtraResources() {
  const extraDir = path.join(root, 'resources', 'extra-zips')
  if (!existsSync(extraDir)) {
    console.warn(`[gitee] extra-zips dir not found: ${extraDir}`)
    return []
  }

  const files = []
  for (const name of readdirSync(extraDir)) {
    const full = path.join(extraDir, name)
    if (!statSync(full).isFile()) continue
    if (name.endsWith('.zip')) {
      files.push(full)
    }
  }

  if (files.length === 0) {
    console.warn('[gitee] no extra resource zips found in resources/extra-zips/')
  }

  return files
}

function readReleaseBody() {
  const bodyPath = path.join(root, 'packaging', 'release-body.md')
  if (!existsSync(bodyPath)) {
    throw new Error(`[gitee] ${bodyPath} not found — run render-release-notes.mjs first`)
  }
  const body = readFileSync(bodyPath, 'utf-8')
  console.log(`[gitee] release body: ${body.split(/\r?\n/)[0]} (${body.length} chars)`)
  return body
}

async function createRelease(body) {
  const hasTag = await tagExistsOnGitee(tag)
  const defaultBranch = await getDefaultBranch()
  const target = process.env.GITHUB_SHA || defaultBranch

  const basePayload = {
    tag_name: tag,
    name: `ModCrafting ${tag}`,
    body,
    prerelease: false
  }

  if (!hasTag) {
    basePayload.target_commitish = target.length === 40 ? target : defaultBranch
  }

  try {
    return await giteeApi('POST', `/repos/${owner}/${repo}/releases`, basePayload)
  } catch (err) {
    if (String(err.message).includes('创建标签失败') || String(err.message).includes('400')) {
      console.warn('[gitee] create release retry without target_commitish')
      return giteeApi('POST', `/repos/${owner}/${repo}/releases`, {
        tag_name: tag,
        name: `ModCrafting ${tag}`,
        body,
        prerelease: false
      })
    }
    throw err
  }
}

async function ensureRelease() {
  const body = readReleaseBody()
  await cleanupDuplicateReleasesForTag(tag)
  const existing = await findReleaseByTag(tag)

  if (existing?.id) {
    await giteeApi('PATCH', `/repos/${owner}/${repo}/releases/${existing.id}`, {
      tag_name: tag,
      name: `ModCrafting ${tag}`,
      body,
      prerelease: false
    })
    console.log(`[gitee] Updated release body #${existing.id}`)
    return existing
  }

  const created = await createRelease(body)
  console.log(`[gitee] Created release #${created.id}`)
  return created
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function uploadWithCurl(releaseId, filePath) {
  const fileName = path.basename(filePath)
  const size = statSync(filePath).size
  const url = `${apiBase}/repos/${owner}/${repo}/releases/${releaseId}/attach_files?access_token=${token}`

  return new Promise((resolve, reject) => {
    const args = [
      '-fS',
      '--retry', '3',
      '--retry-delay', '10',
      '--connect-timeout', '60',
      '-m', String(Math.ceil(UPLOAD_TIMEOUT_MS / 1000)),
      '-X', 'POST',
      '-F', `file=@${filePath}`,
      url
    ]
    console.log(`[gitee] Uploading ${fileName} (${formatSize(size)})...`)
    const child = spawn('curl.exe', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[gitee] Uploaded: ${fileName}`)
        resolve()
      } else {
        reject(new Error(`curl upload ${fileName} failed (${code}): ${stderr.trim()}`))
      }
    })
  })
}

async function uploadAsset(releaseId, filePath) {
  const size = statSync(filePath).size
  // 大文件用 curl 流式上传，避免 Node fetch 读入 1GB 内存超时
  if (size > 8 * 1024 * 1024) {
    return uploadWithCurl(releaseId, filePath)
  }

  const fileName = path.basename(filePath)
  const buffer = readFileSync(filePath)
  const form = new FormData()
  form.append('file', new Blob([buffer]), fileName)
  const url = `${apiBase}/repos/${owner}/${repo}/releases/${releaseId}/attach_files?access_token=${token}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000)
  try {
    const res = await fetch(url, { method: 'POST', body: form, signal: controller.signal })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Upload ${fileName} failed: ${res.status} ${text}`)
    }
    console.log(`[gitee] Uploaded: ${fileName}`)
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const releaseAssets = collectReleaseAssets(releaseDir)
  const seedShards = collectSeedShards()
  const jreShards = collectJreShards()
  const extraResources = collectExtraResources()
  const assets = [...releaseAssets, ...seedShards, ...jreShards, ...extraResources]

  if (assets.length === 0) {
    console.error(`[gitee] No release assets in ${releaseDir}`)
    process.exit(1)
  }

  console.log(`[gitee] Syncing ${assets.length} assets to ${owner}/${repo} ${tag} (from ${source})...`)
  assets.forEach((a) => console.log(`  - ${path.basename(a)} (${formatSize(statSync(a).size)})`))

  await verifyRepoAccess()
  const release = await ensureRelease()
  const expectedNames = assets.map((a) => path.basename(a))
  await cleanupStaleAttachments(release.id, expectedNames)

  const failed = []
  for (const asset of assets) {
    try {
      await uploadAsset(release.id, asset)
    } catch (err) {
      failed.push({ asset, err })
      console.error(`[gitee] FAILED: ${path.basename(asset)} — ${err.message || err}`)
    }
  }

  if (failed.length > 0) {
    const names = failed.map((f) => path.basename(f.asset)).join(', ')
    throw new Error(`${failed.length} asset(s) failed: ${names}`)
  }

  console.log('[gitee] Release sync complete.')
}

main().catch((err) => {
  console.error('[gitee] Sync failed:', err.message || err)
  process.exit(1)
})
