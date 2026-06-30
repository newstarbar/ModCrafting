#!/usr/bin/env node
/**
 * Sync release assets to Gitee Releases.
 * Requires env GITEE_TOKEN. Usage: node scripts/sync-gitee-release.mjs <version> [release_dir]
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

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
  console.warn('[gitee] Add repository Secret GITEE_TOKEN to enable automatic sync')
  process.exit(0)
}

const owner = process.env.GITEE_OWNER || 'newstarbar'
const repo = process.env.GITEE_REPO || 'ModCrafting'
const tag = version.startsWith('v') ? version : `v${version}`
const apiBase = 'https://gitee.com/api/v5'

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

function collectAssets(dir) {
  if (!existsSync(dir)) return []
  const exts = ['.exe', '.yml', '.blockmap', '.7z']
  return readdirSync(dir)
    .filter((name) => exts.some((ext) => name.endsWith(ext)))
    .map((name) => path.join(dir, name))
    .filter((p) => statSync(p).isFile())
}

async function ensureRelease() {
  try {
    const existing = await giteeApi('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`)
    if (existing?.id) return existing
  } catch {
    /* create */
  }

  return giteeApi('POST', `/repos/${owner}/${repo}/releases`, {
    tag_name: tag,
    name: `ModCrafting ${tag}`,
    body: `ModCrafting ${tag} — synced from GitHub Actions.`,
    target_commitish: 'main',
    prerelease: false
  })
}

async function uploadAsset(releaseId, filePath) {
  const fileName = path.basename(filePath)
  const buffer = readFileSync(filePath)
  const form = new FormData()
  form.append('file', new Blob([buffer]), fileName)

  const url = `${apiBase}/repos/${owner}/${repo}/releases/${releaseId}/attach_files?access_token=${token}`
  const res = await fetch(url, { method: 'POST', body: form })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Upload ${fileName} failed: ${res.status} ${text}`)
  }
  console.log(`Uploaded: ${fileName}`)
}

async function main() {
  const assets = collectAssets(releaseDir)
  if (assets.length === 0) {
    console.error(`[gitee] No release assets in ${releaseDir}`)
    process.exit(1)
  }

  console.log(`[gitee] Syncing ${assets.length} assets to ${owner}/${repo} ${tag}...`)
  const release = await ensureRelease()
  for (const asset of assets) {
    await uploadAsset(release.id, asset)
  }
  console.log('[gitee] Release sync complete.')
}

main().catch((err) => {
  console.error('[gitee] Sync failed:', err.message || err)
  process.exit(1)
})
