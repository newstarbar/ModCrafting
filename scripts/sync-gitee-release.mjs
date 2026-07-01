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
const root = path.join(__dirname, '..')

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
  const releases = await giteeApi('GET', `/repos/${owner}/${repo}/releases?per_page=100&page=1`)
  if (!Array.isArray(releases)) return null
  return releases.find((r) => r.tag_name === tagName) || null
}

/** 仅同步用户需要的发布附件，排除 builder-debug.yml / 内部 7z 等 */
function collectReleaseAssets(dir) {
  if (!existsSync(dir)) return []

  const candidates = [
    'latest.yml',
    `ModCrafting Setup ${ver}.exe.blockmap`,
    `ModCrafting Setup ${ver}.exe`,
    `ModCrafting ${ver} Portable.exe`
  ]

  const files = candidates
    .map((name) => path.join(dir, name))
    .filter((p) => existsSync(p) && statSync(p).isFile())

  if (files.length === 0) {
    console.warn('[gitee] expected filenames missing, listing release/:')
    for (const name of readdirSync(dir)) {
      console.warn(`  - ${name}`)
    }
  }

  return files
}

function readReleaseBody() {
  const bodyPath = path.join(root, 'build', 'release-body.md')
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
  const existing = await findReleaseByTag(tag)

  if (existing?.id) {
    await giteeApi('PATCH', `/repos/${owner}/${repo}/releases/${existing.id}`, {
      body,
      name: `ModCrafting ${tag}`
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
  const assets = collectReleaseAssets(releaseDir)
  if (assets.length === 0) {
    console.error(`[gitee] No release assets in ${releaseDir}`)
    process.exit(1)
  }

  console.log(`[gitee] Syncing ${assets.length} assets to ${owner}/${repo} ${tag} (from ${source})...`)
  assets.forEach((a) => console.log(`  - ${path.basename(a)} (${formatSize(statSync(a).size)})`))

  await verifyRepoAccess()
  const release = await ensureRelease()

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
