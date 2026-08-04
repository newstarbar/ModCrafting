#!/usr/bin/env node
/**
 * 本地一键发布脚本:同时更新 GitHub 与 Gitee。
 *
 * 2026-08 重构：Gitee 仅上传 Setup/Portable/latest.yml/blockmap 等发布二进制。
 * 环境产物（seed/jre shards、extra-zips）全部由 GitHub Release 承载，
 * 应用内下载器走 gh.xmly.dev 代理加速，不再上传 Gitee。
 *
 * 流程:
 *   1. 读取 package.json version → 构造 tag
 *   2. 加载 .env(GITEE_TOKEN)
 *   3. 生成 release-body.md(render-release-notes.mjs)
 *   4. 归档 docs/releases/vX.Y.Z.md
 *   5. 检查本地构建产物(用于 Gitee Release 上传 Setup/Portable)
 *   6. 创建 git tag(若不存在)并推送到 GitHub origin → 触发 CI 发布 GitHub Release
 *   7. 查询 Gitee 是否已存在该版本 Release(幂等,存在则跳过 Gitee 部分)
 *   8. 推送 git + tag 到 Gitee(push-gitee-git.mjs)
 *   9. 上传 Gitee Release 附件(sync-gitee-release.mjs,仅 Setup/Portable)
 *
 * Usage: node scripts/release/publish-release.mjs
 *
 * 环境变量(从 .env 加载或系统环境变量):
 *   GITEE_TOKEN   (必填) Gitee 私人令牌
 *   GITEE_OWNER   (可选) 覆盖 packaging/gitee-config.json 中的 owner
 *   GITEE_REPO    (可选) 覆盖 packaging/gitee-config.json 中的 repo
 */
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, copyFileSync } from 'fs'
import { spawnSync } from 'node:child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveGiteeRepo, giteeUrls } from './gitee-config.mjs'
import { loadEnv } from '../lib/load-env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')

// ─── 读取 package.json 版本 ───────────────────────────────────────────────
function readPackageVersion() {
  const pkgPath = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  if (!pkg.version) {
    throw new Error('package.json 缺少 version 字段')
  }
  return pkg.version
}

// ─── Git 命令封装 ────────────────────────────────────────────────────────
function git(args, opts = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  })
  return result
}

function gitText(args) {
  const r = git(args)
  if (r.status !== 0) return ''
  return r.stdout.trim()
}

function gitInherit(args) {
  const r = git(args, { stdio: 'inherit' })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败(退出码 ${r.status})`)
  }
}

// ─── Gitee API 调用 ──────────────────────────────────────────────────────
async function giteeApi(method, endpoint, token) {
  const apiBase = 'https://gitee.com/api/v5'
  const sep = endpoint.includes('?') ? '&' : '?'
  const url = `${apiBase}${endpoint}${sep}access_token=${token}`
  const res = await fetch(url, { method })
  if (res.status === 404) return null
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

/** 查询 Gitee 上是否已存在某 tag 对应的 Release */
async function giteeReleaseExists(owner, repo, tag, token) {
  try {
    const r = await giteeApi('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`, token)
    return !!r?.id
  } catch {
    return false
  }
}

// ─── GitHub 最新 Release 查询(信息展示)─────────────────────────────────
async function githubLatestTag() {
  try {
    const res = await fetch('https://api.github.com/repos/newstarbar/ModCrafting/releases/latest')
    if (!res.ok) return null
    const data = await res.json()
    return data?.tag_name || null
  } catch {
    return null
  }
}

// ─── 本地产物检查 ──────────────────────────────────────────────────────
function checkLocalAssets(ver) {
  const missing = []
  const releaseDir = path.join(root, 'release')
  const setupName = `ModCrafting-Setup-${ver}.exe`
  const portableName = `ModCrafting-${ver}-Portable.exe`
  if (!existsSync(path.join(releaseDir, setupName))) missing.push(`release/${setupName}`)
  if (!existsSync(path.join(releaseDir, portableName))) missing.push(`release/${portableName}`)
  if (!existsSync(path.join(releaseDir, 'latest.yml'))) missing.push('release/latest.yml')
  const setupPath = path.join(releaseDir, setupName)
  if (existsSync(setupPath) && statSync(setupPath).size >= 100_000_000) {
    missing.push(`release/${setupName}（${statSync(setupPath).size} bytes，超过 100,000,000 bytes 发布上限）`)
  }

  return missing
}

function printBuildHints(tag) {
  console.error('')
  console.error('请先依次运行以下命令生成本地产物:')
  console.error(`  npm run release:notes -- ${tag}`)
  console.error('  npm run build:win')
}

// ─── 调用底层脚本 ──────────────────────────────────────────────────────
function runScript(scriptPath, tag) {
  const full = path.join(root, scriptPath)
  if (!existsSync(full)) {
    throw new Error(`脚本不存在: ${scriptPath}`)
  }
  console.log(`\n[publish] 执行: node ${scriptPath} ${tag}`)
  const result = spawnSync('node', [full, tag], {
    stdio: 'inherit',
    cwd: root,
    env: process.env
  })
  if (result.status !== 0) {
    throw new Error(`${scriptPath} 执行失败(退出码 ${result.status})`)
  }
}

// ─── 生成 release notes 并归档 ──────────────────────────────────────────
function generateReleaseNotes(tag) {
  console.log(`\n[publish] 生成 release notes: ${tag}`)
  runScript('scripts/release/render-release-notes.mjs', tag)

  // 归档到 docs/releases/vX.Y.Z.md
  const releaseBody = path.join(root, 'packaging', 'release-body.md')
  const releasesDir = path.join(root, 'docs', 'releases')
  if (!existsSync(releasesDir)) {
    mkdirSync(releasesDir, { recursive: true })
  }
  const archivePath = path.join(releasesDir, `${tag}.md`)
  copyFileSync(releaseBody, archivePath)
  console.log(`[publish] 已归档: docs/releases/${tag}.md`)
}

// ─── Git tag 本地强制创建与远端推送（分两步） ─────────────────────────────

/** 本地强制 tag 指向当前 HEAD。必须在生成 release notes 之前执行，
 *  避免 (a) tag 不存在时 previousTag 无法定位，(b) 旧 tag 指向过期 commit。
 *  若已有同名 tag 则覆盖（-f），保证本轮发布的是最新工作树。 */
function ensureLocalTag(tag) {
  const before = gitText(['rev-parse', '--verify', tag]).slice(0, 7)
  const head = gitText(['rev-parse', '--verify', 'HEAD']).slice(0, 7)
  gitInherit(['tag', '-f', tag])
  if (before) {
    console.log(`\n[publish] 已移动本地 tag: ${tag} (${before} → ${head})`)
  } else {
    console.log(`\n[publish] 已创建本地 tag: ${tag} (${head})`)
  }
}

/** 推送 tag 到 GitHub origin。验证本地构建产物通过后再调用，
 *  避免无效触发 CI。使用 --force 覆盖远端已有的同名 tag。 */
function pushTagToOrigin(tag) {
  console.log(`[publish] 推送 tag 到 GitHub origin(将触发 CI 发布 GitHub Release)...`)
  const pushResult = git(['push', '--force', 'origin', tag], { stdio: 'inherit' })
  if (pushResult.status !== 0) {
    throw new Error(`推送 tag ${tag} 到 origin 失败(退出码 ${pushResult.status})`)
  }
  console.log('[publish] tag 已推送,GitHub Actions CI 将自动构建并发布 GitHub Release')
}

// ─── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  const version = readPackageVersion()
  const tag = version.startsWith('v') ? version : `v${version}`
  const ver = tag.replace(/^v/, '')

  console.log('[publish] 本地一键发布启动')
  console.log(`[publish] package.json version: ${version}`)
  console.log(`[publish] 目标 tag: ${tag}`)

  // 1. 加载 .env
  const envLoaded = loadEnv()
  const token = process.env.GITEE_TOKEN
  if (!token) {
    console.error('')
    console.error('[publish] 错误: GITEE_TOKEN 未设置')
    console.error('[publish] 请复制 .env.example 为 .env 并填入 Gitee 私人令牌:')
    console.error('  cp .env.example .env')
    console.error('  # 然后编辑 .env,把 GITEE_TOKEN= 后面替换成真实令牌')
    console.error('[publish] 令牌获取: https://gitee.com/profile/personal_access_tokens')
    console.error('')
    console.error('[publish] 注意:load-env.mjs 遵循"系统环境变量优先",若曾误设 $env:GITEE_TOKEN,')
    console.error('[publish]       请先清除: Remove-Item Env:GITEE_TOKEN  (PowerShell)')
    process.exit(1)
  }
  // 占位符检测:防止 .env.example 中的字面量或 PowerShell 提示中的占位符被当令牌
  if (/^<.*>$/.test(token) || token.includes('你的') || token.includes('令牌')) {
    console.error('')
    console.error('[publish] 错误: GITEE_TOKEN 看起来是占位符而非真实令牌:')
    console.error(`[publish]   实际值 = "${token}"`)
    console.error('[publish] 请编辑 .env,把 GITEE_TOKEN= 后面替换成真实令牌')
    console.error('[publish] 令牌获取: https://gitee.com/profile/personal_access_tokens')
    console.error('[publish] 若为环境变量误设,请清除: Remove-Item Env:GITEE_TOKEN  (PowerShell)')
    process.exit(1)
  }
  console.log(`[publish] .env 加载完成(读取 ${Object.keys(envLoaded).length} 个变量)`)

  // 2. 解析 owner/repo
  const { owner, repo, source } = resolveGiteeRepo()
  console.log(`[publish] Gitee 仓库: ${owner}/${repo} (来源: ${source})`)

  // 3. 先强制移动本地 tag 指向当前 HEAD
  //    必须在生成 release notes 之前完成：(a) previousTag 能在 tag 列表中定位，
  //    (b) changelog 区间虽然改用 HEAD，但 tag 指向 HEAD 保证 compare 链接一致
  ensureLocalTag(tag)

  // 4. 生成 release notes 并归档
  generateReleaseNotes(tag)

  // 5. 检查本地构建产物
  const missing = checkLocalAssets(ver)
  if (missing.length > 0) {
    console.error('')
    console.error('[publish] 错误: 缺少本地构建产物:')
    missing.forEach((m) => console.error(`  - ${m}`))
    printBuildHints(tag)
    process.exit(1)
  }
  console.log('[publish] 本地构建产物检查通过')

  // 6. 验证通过后再推送 tag 到 GitHub(触发 CI)
  pushTagToOrigin(tag)

  // 7. 查询 Gitee 是否已存在该版本
  console.log(`\n[publish] 查询 Gitee 是否已存在 ${tag} ...`)
  const exists = await giteeReleaseExists(owner, repo, tag, token)
  if (exists) {
    console.log(`[publish] Gitee 已存在 ${tag},跳过 Gitee 同步(幂等)`)
    const urls = giteeUrls(owner, repo, tag, ver)
    console.log(`[publish] Gitee Release 页面: ${urls.releasesPage}`)
    console.log('\n[publish] 发布完成:')
    console.log('  - GitHub: CI 已触发,等待自动构建发布')
    console.log('  - Gitee: 已存在,跳过')
    process.exit(0)
  }
  console.log(`[publish] Gitee 不存在 ${tag},继续发布 Gitee`)

  // 8. GitHub 信息展示
  const ghTag = await githubLatestTag()
  if (ghTag) {
    console.log(`[publish] GitHub 当前最新 Release: ${ghTag}`)
  }

  // 9. 推送 git + tag 到 Gitee
  console.log('\n[publish] 步骤 1/2: 推送 git + tag 到 Gitee')
  runScript('scripts/release/push-gitee-git.mjs', tag)

  // 10. 上传 Gitee Release 附件
  console.log('\n[publish] 步骤 2/2: 创建 Gitee Release 并上传附件')
  runScript('scripts/release/sync-gitee-release.mjs', tag)

  // 11. 完成
  const urls = giteeUrls(owner, repo, tag, ver)
  console.log('')
  console.log('[publish] 发布完成:')
  console.log('  - GitHub: CI 已触发,等待自动构建发布 GitHub Release')
  console.log(`  - Gitee:  已发布 ${tag}`)
  console.log(`  - Gitee Release 页面: ${urls.releasesPage}`)
  console.log(`  - Gitee Setup 下载:   ${urls.setup}`)
  console.log(`  - Gitee Portable 下载: ${urls.portable}`)
  console.log(`  - 版本文档归档: docs/releases/${tag}.md`)
}

main().catch((err) => {
  console.error('')
  console.error(`[publish] 发布失败: ${err.message || err}`)
  process.exit(1)
})
