#!/usr/bin/env node
/**
 * Push current commit + tag to Gitee so Release API can attach assets.
 * Requires GITEE_TOKEN. Usage: node scripts/push-gitee-git.mjs <tag>
 */
import { execSync } from 'node:child_process'
import { resolveGiteeRepo } from './gitee-config.mjs'

const tag = process.argv[2]
const token = process.env.GITEE_TOKEN

if (!tag) {
  console.error('Usage: node scripts/push-gitee-git.mjs <tag>')
  process.exit(1)
}

if (!token) {
  console.warn('[gitee] GITEE_TOKEN not set — skip git push to Gitee')
  process.exit(0)
}

const { owner, repo } = resolveGiteeRepo()
const remoteUrl = `https://oauth2:${token}@gitee.com/${owner}/${repo}.git`

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function runQuiet(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const sha = process.env.GITHUB_SHA || execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
const normalizedTag = tag.startsWith('v') ? tag : `v${tag}`

console.log(`[gitee] Pushing ${sha.slice(0, 7)} and tag ${normalizedTag} to ${owner}/${repo}...`)

runQuiet('git remote remove gitee')
run(`git remote add gitee "${remoteUrl}"`)

run('git config user.name "github-actions[bot]"')
run('git config user.email "github-actions[bot]@users.noreply.github.com"')

// Gitee Release 需要远程仓库存在对应 commit；同步 main 到当前 tag 提交
run(`git push gitee ${sha}:refs/heads/main`)
run(`git push gitee refs/tags/${normalizedTag}:refs/tags/${normalizedTag} --force`)

// 避免后续 git checkout main 歧义（origin/main vs gitee/main）
runQuiet('git remote remove gitee')

console.log('[gitee] Git mirror push complete.')
