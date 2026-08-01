#!/usr/bin/env node
/**
 * Push current commit + tag to Gitee so Release API can attach assets.
 * Requires GITEE_TOKEN. Usage: node scripts/release/push-gitee-git.mjs <tag>
 *
 * 设计说明:
 *   - 使用 `git remote set-url` 幂等更新 remote URL,避免 remove+add 模式下
 *     因 remove 失败被吞掉而导致 add 失败、push 用到旧脏 URL 的问题。
 *   - 对 token 进行占位符检测,防止 .env.example 中的字面量 `<...>` 被当作
 *     真实令牌写入 git remote URL(曾导致 "URL using bad/illegal format" 报错)。
 */
import { execSync } from 'node:child_process'
import { resolveGiteeRepo } from './gitee-config.mjs'

const tag = process.argv[2]
const token = process.env.GITEE_TOKEN

if (!tag) {
  console.error('Usage: node scripts/release/push-gitee-git.mjs <tag>')
  process.exit(1)
}

if (!token) {
  console.warn('[gitee] GITEE_TOKEN not set — skip git push to Gitee')
  process.exit(0)
}

// 占位符检测:防止 .env.example 中的字面量或 PowerShell 提示中的占位符被当令牌
if (/^<.*>$/.test(token) || token.includes('你的') || token.includes('令牌')) {
  console.error('[gitee] GITEE_TOKEN 看起来是占位符而非真实令牌:')
  console.error(`[gitee]   实际值 = "${token}"`)
  console.error('[gitee] 请编辑 .env 填入 Gitee 私人令牌(https://gitee.com/profile/personal_access_tokens)')
  console.error('[gitee] 若已设置错误的环境变量,请在新终端运行或执行: Remove-Item Env:GITEE_TOKEN')
  process.exit(1)
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

// 幂等设置 remote URL:不存在则 add,存在则 set-url 覆盖脏 URL
const remoteExists = runQuiet('git remote get-url gitee')
if (remoteExists) {
  // 强制覆盖(可能含旧占位符 URL)
  run(`git remote set-url gitee "${remoteUrl}"`)
} else {
  run(`git remote add gitee "${remoteUrl}"`)
}

run('git config user.name "github-actions[bot]"')
run('git config user.email "github-actions[bot]@users.noreply.github.com"')

// Gitee 为 GitHub 镜像仓:远端 main 可能与 GitHub 分叉(手动提交、旧 CI 等),强制对齐到当前发布提交
console.log('[gitee] Force-pushing main (mirror sync — overwrites remote main)')
run(`git push gitee ${sha}:refs/heads/main --force`)
run(`git push gitee refs/tags/${normalizedTag}:refs/tags/${normalizedTag} --force`)

// 避免后续 git checkout main 歧义(origin/main vs gitee/main)
// 注意:remote URL 含 token,删除后避免泄漏到 .git/config;下次脚本运行时会重新 add
runQuiet('git remote remove gitee')

console.log('[gitee] Git mirror push complete.')
