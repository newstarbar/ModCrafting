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

  // 按创建时间降序排序（最新在前）
  sameTag.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  // 策略：删除所有 draft Release（无论单个还是多个），保留已发布的 Release。
  // 背景：electron-builder --publish always 每次都会创建新的 draft Release，
  // 如果 CI 在 gh release edit --draft=false 之前失败，draft 会残留。
  // 旧逻辑只删除"重复"的 Release（同 tag 多个），保留单个 draft，
  // 导致每次重试 CI 都会多一个草稿（cleanup 保留单个 draft → electron-builder
  // 又创建新的 draft → 下次 cleanup 发现 2 个删除 1 个 → 又创建新的 → 循环）。
  const published = sameTag.filter((r) => !r.draft)
  const drafts = sameTag.filter((r) => r.draft)

  if (published.length > 0) {
    // 有已发布的 Release：保留最新的已发布 Release，删除其余所有（包括 draft 和重复的 published）
    const keep = published[0]
    for (const r of sameTag) {
      if (r.id === keep.id) continue
      const state = r.draft ? 'draft' : 'published'
      console.log(`[github] Deleting ${state} release #${r.id} (${normalizedTag})`)
      await githubApi(`/repos/${repo}/releases/${r.id}`, 'DELETE')
    }
    console.log(`[github] Kept published release #${keep.id}`)
  } else {
    // 没有已发布的 Release，全部是 draft：删除所有，让 electron-builder 创建全新的
    for (const r of drafts) {
      console.log(`[github] Deleting draft release #${r.id} (${normalizedTag})`)
      await githubApi(`/repos/${repo}/releases/${r.id}`, 'DELETE')
    }
    console.log(`[github] Deleted all ${drafts.length} draft release(s) for ${normalizedTag}`)
  }
}

main().catch((err) => {
  console.error('[github] Cleanup failed:', err.message || err)
  process.exit(1)
})
