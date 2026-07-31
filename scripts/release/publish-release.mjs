#!/usr/bin/env node
/**
 * 本地一键发布脚本:同时更新 GitHub 与 Gitee。
 *
 * 流程:
 *   1. 读取 package.json version → 构造 tag
 *   2. 加载 .env(GITEE_TOKEN)
 *   3. 生成 release-body.md(render-release-notes.mjs)
 *   4. 归档 docs/releases/vX.Y.Z.md
 *   5. 检查本地构建产物(用于 Gitee Release 上传)
 *   6. 创建 git tag(若不存在)并推送到 GitHub origin → 触发 CI 发布 GitHub Release
 *   7. 查询 Gitee 是否已存在该版本 Release(幂等,存在则跳过 Gitee 部分)
 *   8. 推送 git + tag 到 Gitee(push-gitee-git.mjs)
 *   9. 上传 Gitee Release 附件(sync-gitee-release.mjs)
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
  const setupName = `ModCrafting Setup ${ver}.exe`
  const portableName = `ModCrafting ${ver} Portable.exe`
  if (!existsSync(path.join(releaseDir, setupName))) missing.push(`release/${setupName}`)
  if (!existsSync(path.join(releaseDir, portableName))) missing.push(`release/${portableName}`)
  if (!existsSync(path.join(releaseDir, 'latest.yml'))) missing.push('release/latest.yml')

  const seedDir = path.join(root, 'resources', 'seed-shards')
  if (!existsSync(seedDir)) {
    missing.push('resources/seed-shards/ (目录不存在)')
  } else {
    const files = readdirSync(seedDir)
    if (!files.includes('manifest.json') || !files.some((f) => /^seed\.part\.\d{3}$/.test(f))) {
      missing.push('resources/seed-shards/ (缺少 manifest.json 或 seed.part.NNN)')
    }
  }

  const jreDir = path.join(root, 'resources', 'jre-shards')
  if (!existsSync(jreDir)) {
    missing.push('resources/jre-shards/ (目录不存在)')
  } else {
    const files = readdirSync(jreDir)
    if (!files.includes('jre-manifest.json') || !files.some((f) => /^jre\.part\.\d{3}$/.test(f))) {
      missing.push('resources/jre-shards/ (缺少 jre-manifest.json 或 jre.part.NNN)')
    }
  }

  const extraDir = path.join(root, 'resources', 'extra-zips')
  if (!existsSync(extraDir)) {
    missing.push('resources/extra-zips/ (目录不存在)')
  } else {
    const files = readdirSync(extraDir).filter(
      (f) => f.endsWith('.zip') || f.endsWith('.tar.xz') || f.endsWith('.xz')
    )
    if (files.length === 0) {
      missing.push('resources/extra-zips/ (缺少 *.zip 或 *.tar.xz)')
    }
  }

  return missing
}

function printBuildHints(tag) {
  console.error('')
  console.error('请先依次运行以下命令生成本地产物:')
  console.error(`  npm run release:notes -- ${tag}`)
  console.error('  npm run toolchain:setup')
  console.error('  npm run toolchain:strip-gradle')
  console.error('  npm run toolchain:build-jre')
  console.error('  npm run toolchain:prefetch')
  console.error('  npm run toolchain:symbol-index')
  console.error('  npm run knowledge:download')
  console.error('  npm run build:win')
  console.error('  npm run release:split-seed')
  console.error('  npm run release:split-jre')
  console.error('  npm run release:archive-extra')
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

// ─── Git tag 创建与推送 ────────────────────────────────────────────────
function ensureAndPushTag(tag) {
  // 检查本地是否已有该 tag
  const localTag = gitText(['tag', '-l', tag])
  if (!localTag) {
    console.log(`\n[publish] 创建 git tag: ${tag}`)
    gitInherit(['tag', tag])
  } else {
    console.log(`[publish] 本地已存在 tag: ${tag}`)
  }

  // 推送到 GitHub origin(触发 CI)
  console.log(`[publish] 推送 tag 到 GitHub origin(将触发 CI 发布 GitHub Release)...`)
  const pushResult = git(['push', 'origin', tag], { stdio: 'inherit' })
  if (pushResult.status !== 0) {
    console.warn(`[publish] 警告: 推送 tag 到 origin 失败(可能远程已存在),CI 可能已被触发`)
    console.warn('[publish] 如需强制重推,请手动执行: git push origin --force ' + tag)
  } else {
    console.log('[publish] tag 已推送,GitHub Actions CI 将自动构建并发布 GitHub Release')
  }
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
    console.error('  # 然后编辑 .env 填入 GITEE_TOKEN')
    console.error('[publish] 或通过环境变量设置(PowerShell):')
    console.error('  $env:GITEE_TOKEN = "<你的 Gitee 私人令牌>"')
    console.error('[publish] 令牌获取: https://gitee.com/profile/personal_access_tokens')
    process.exit(1)
  }
  console.log(`[publish] .env 加载完成(读取 ${Object.keys(envLoaded).length} 个变量)`)

  // 2. 解析 owner/repo
  const { owner, repo, source } = resolveGiteeRepo()
  console.log(`[publish] Gitee 仓库: ${owner}/${repo} (来源: ${source})`)

  // 3. 生成 release notes 并归档
  generateReleaseNotes(tag)

  // 4. 检查本地构建产物
  const missing = checkLocalAssets(ver)
  if (missing.length > 0) {
    console.error('')
    console.error('[publish] 错误: 缺少本地构建产物:')
    missing.forEach((m) => console.error(`  - ${m}`))
    printBuildHints(tag)
    process.exit(1)
  }
  console.log('[publish] 本地构建产物检查通过')

  // 5. 创建并推送 tag 到 GitHub(触发 CI)
  ensureAndPushTag(tag)

  // 6. 查询 Gitee 是否已存在该版本
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

  // 7. GitHub 信息展示
  const ghTag = await githubLatestTag()
  if (ghTag) {
    console.log(`[publish] GitHub 当前最新 Release: ${ghTag}`)
  }

  // 8. 推送 git + tag 到 Gitee
  console.log('\n[publish] 步骤 1/2: 推送 git + tag 到 Gitee')
  runScript('scripts/release/push-gitee-git.mjs', tag)

  // 9. 上传 Gitee Release 附件
  console.log('\n[publish] 步骤 2/2: 创建 Gitee Release 并上传附件')
  runScript('scripts/release/sync-gitee-release.mjs', tag)

  // 10. 完成
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
