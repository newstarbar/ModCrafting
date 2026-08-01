#!/usr/bin/env node
/**
 * 单独的 Gitee 同步入口:推送 git + tag,并上传 Release 附件。
 *
 * 适用场景:
 *   - `npm run release:publish` 在 Gitee 阶段失败,需要单独重跑 Gitee 部分
 *   - 已手动删除 Gitee Release,需要重新创建并上传附件
 *   - 本地构建产物已就绪,只想同步到 Gitee 不触发 GitHub CI
 *
 * Usage:
 *   node scripts/release/sync-gitee-only.mjs [tag]
 *
 * 参数:
 *   tag  可选,默认从 package.json version 推导(自动加 v 前缀)
 *
 * 环境变量(从 .env 加载或系统环境变量):
 *   GITEE_TOKEN  (必填) Gitee 私人令牌
 */
import { readFileSync, existsSync } from 'fs'
import { spawnSync } from 'node:child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveGiteeRepo, giteeUrls } from './gitee-config.mjs'
import { loadEnv } from '../lib/load-env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')

// ─── 读取 package.json 版本(作为 tag 默认值)─────────────────────────────
function readPackageVersion() {
  const pkgPath = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  if (!pkg.version) {
    throw new Error('package.json 缺少 version 字段')
  }
  return pkg.version
}

// ─── 调用底层脚本 ──────────────────────────────────────────────────────
function runScript(scriptPath, tag) {
  const full = path.join(root, scriptPath)
  if (!existsSync(full)) {
    throw new Error(`脚本不存在: ${scriptPath}`)
  }
  console.log(`\n[gitee-only] 执行: node ${scriptPath} ${tag}`)
  const result = spawnSync('node', [full, tag], {
    stdio: 'inherit',
    cwd: root,
    env: process.env
  })
  if (result.status !== 0) {
    throw new Error(`${scriptPath} 执行失败(退出码 ${result.status})`)
  }
}

async function main() {
  // 1. 解析 tag(参数优先,否则从 package.json 推导)
  const argTag = process.argv[2]
  const version = readPackageVersion()
  const tag = argTag || (version.startsWith('v') ? version : `v${version}`)
  const ver = tag.replace(/^v/, '')

  console.log('[gitee-only] Gitee 单独同步启动')
  console.log(`[gitee-only] 目标 tag: ${tag}`)

  // 2. 加载 .env 并验证 token
  loadEnv()
  const token = process.env.GITEE_TOKEN
  if (!token) {
    console.error('')
    console.error('[gitee-only] 错误: GITEE_TOKEN 未设置')
    console.error('[gitee-only] 请复制 .env.example 为 .env 并填入 Gitee 私人令牌:')
    console.error('  cp .env.example .env')
    console.error('  # 然后编辑 .env,把 GITEE_TOKEN= 后面替换成真实令牌')
    console.error('[gitee-only] 令牌获取: https://gitee.com/profile/personal_access_tokens')
    console.error('[gitee-only] 若曾误设 $env:GITEE_TOKEN,请先清除: Remove-Item Env:GITEE_TOKEN')
    process.exit(1)
  }
  // 占位符检测
  if (/^<.*>$/.test(token) || token.includes('你的') || token.includes('令牌')) {
    console.error('')
    console.error('[gitee-only] 错误: GITEE_TOKEN 看起来是占位符而非真实令牌:')
    console.error(`[gitee-only]   实际值 = "${token}"`)
    console.error('[gitee-only] 请编辑 .env,把 GITEE_TOKEN= 后面替换成真实令牌')
    console.error('[gitee-only] 若为环境变量误设,请清除: Remove-Item Env:GITEE_TOKEN')
    process.exit(1)
  }

  // 3. 解析 owner/repo
  const { owner, repo, source } = resolveGiteeRepo()
  console.log(`[gitee-only] Gitee 仓库: ${owner}/${repo} (来源: ${source})`)

  // 4. 步骤 1/2:推送 git + tag 到 Gitee
  console.log('\n[gitee-only] 步骤 1/2: 推送 git + tag 到 Gitee')
  runScript('scripts/release/push-gitee-git.mjs', tag)

  // 5. 步骤 2/2:创建 Gitee Release 并上传附件
  console.log('\n[gitee-only] 步骤 2/2: 创建 Gitee Release 并上传附件')
  runScript('scripts/release/sync-gitee-release.mjs', tag)

  // 6. 完成
  const urls = giteeUrls(owner, repo, tag, ver)
  console.log('')
  console.log('[gitee-only] 同步完成:')
  console.log(`  - Gitee Release 页面: ${urls.releasesPage}`)
  console.log(`  - Gitee Setup 下载:   ${urls.setup}`)
  console.log(`  - Gitee Portable 下载: ${urls.portable}`)
}

main().catch((err) => {
  console.error('')
  console.error(`[gitee-only] 同步失败: ${err.message || err}`)
  process.exit(1)
})
