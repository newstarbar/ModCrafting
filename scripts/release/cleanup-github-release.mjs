#!/usr/bin/env node
/**
 * 发布前清理 GitHub Release：同 tag 下的 Release 全部删除。
 *
 * 为什么一律删除而不是"保留最新 published"？
 *  1. cleanup 在发布流程最开头执行，紧接其后 electron-builder --publish always
 *     一定会创建全新的 draft Release，删除的内容会被重建。
 *  2. 如果保留了旧 published Release（比如 force-push tag 到新 commit 后重发），
 *     会出现同 tag 下同时存在「旧 published + 新 draft」两个 Release 的场景，
 *     导致后续 `gh release upload <tag>` / `gh release edit <tag>` 产生歧义：
 *     gh 命令只会操作其中一个，另一个 draft 永远无人处理并残留。
 *  3. 本次发布的 Setup.exe / Portable.exe / extra-zips 等所有资产都会由后续步骤
 *     重新上传到新 Release 对象，旧 Release 上的旧资产不应当保留。
 *
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

  // 强制同 tag 下只有 0 个 Release：全删。
  // electron-builder --publish always 会创建唯一的新 draft，后续 gh 操作不会歧义。
  console.log(`[github] Found ${sameTag.length} existing release(s) for ${normalizedTag} — deleting all`)
  for (const r of sameTag) {
    const state = r.draft ? 'draft' : 'published'
    console.log(`[github]   Deleting ${state} release #${r.id} (${r.name || '<no name>'})`)
    await githubApi(`/repos/${repo}/releases/${r.id}`, 'DELETE')
  }
  console.log(`[github] Cleanup done — same-tag Release cleared, ready for fresh publish`)
}

main().catch((err) => {
  console.error('[github] Cleanup failed:', err.message || err)
  process.exit(1)
})
