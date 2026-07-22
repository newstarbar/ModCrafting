#!/usr/bin/env node
/**
 * 发布前清理 GitHub Release：删除同 tag 的重复 Release（保留最新一条）。
 * Draft 状态保留，由 electron-builder / gh release edit 覆盖。
 * Usage: node scripts/cleanup-github-release.mjs <tag>
 */
const tag = process.argv[2]
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY

if (!tag) {
  console.error('Usage: node scripts/cleanup-github-release.mjs <tag>')
  process.exit(1)
}

if (!token || !repo) {
  console.warn('[github] GH_TOKEN or GITHUB_REPOSITORY missing — skip release cleanup')
  process.exit(0)
}

const normalizedTag = tag.startsWith('v') ? tag : `v${tag}`

async function githubApi(path, method = 'GET') {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (method === 'DELETE' && res.status === 204) return null
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${path}: ${res.status} ${text}`)
  }
  return data
}

async function listReleases() {
  const all = []
  for (let page = 1; page <= 5; page++) {
    const batch = await githubApi(`/repos/${repo}/releases?per_page=100&page=${page}`)
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all
}

async function main() {
  const releases = await listReleases()
  const sameTag = releases.filter((r) => r.tag_name === normalizedTag)

  if (sameTag.length === 0) {
    console.log(`[github] No existing release for ${normalizedTag}`)
    return
  }

  if (sameTag.length > 1) {
    sameTag.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    const keep = sameTag[0]
    for (const dup of sameTag.slice(1)) {
      console.log(`[github] Deleting duplicate release #${dup.id} (${normalizedTag})`)
      await githubApi(`/repos/${repo}/releases/${dup.id}`, 'DELETE')
    }
    console.log(`[github] Kept release #${keep.id}`)
  } else {
    const only = sameTag[0]
    const state = only.draft ? 'draft' : 'published'
    console.log(`[github] Existing release #${only.id} (${state}) for ${normalizedTag}`)
  }
}

main().catch((err) => {
  console.error('[github] Cleanup failed:', err.message || err)
  process.exit(1)
})
