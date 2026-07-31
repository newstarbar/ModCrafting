#!/usr/bin/env node
/**
 * 本地 Gitee 同步编排脚本。
 *
 * 流程:
 *   1. 读取 package.json version → 构造 tag
 *   2. 校验 GITEE_TOKEN 环境变量
 *   3. 查询 Gitee 是否已存在该 tag 的 Release(存在则跳过,幂等)
 *   4. 查询 GitHub 最新 Release tag 作为信息对比(不阻断)
 *   5. 检查本地构建产物是否齐全(缺失则报错并给出构建命令提示)
 *   6. 调用 push-gitee-git.mjs 推送 git + tag
 *   7. 调用 sync-gitee-release.mjs 创建 Release + 上传附件
 *
 * Usage: node scripts/release/local-gitee-sync.mjs
 *
 * 环境变量:
 *   GITEE_TOKEN   (必填) Gitee 私人令牌
 *   GITEE_OWNER   (可选) 覆盖 packaging/gitee-config.json 中的 owner
 *   GITEE_REPO    (可选) 覆盖 packaging/gitee-config.json 中的 repo
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'fs'
import { spawnSync } from 'node:child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveGiteeRepo, giteeUrls } from './gitee-config.mjs'

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

// ─── Gitee API 调用(参照 sync-gitee-release.mjs)─────────────────────────
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

// ─── GitHub Release 查询(信息展示,不阻断)─────────────────────────────
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

  // release/ 目录下的安装包与 portable
  const releaseDir = path.join(root, 'release')
  const setupName = `ModCrafting Setup ${ver}.exe`
  const portableName = `ModCrafting ${ver} Portable.exe`
  if (!existsSync(path.join(releaseDir, setupName))) missing.push(`release/${setupName}`)
  if (!existsSync(path.join(releaseDir, portableName))) missing.push(`release/${portableName}`)
  if (!existsSync(path.join(releaseDir, 'latest.yml'))) missing.push('release/latest.yml')

  // packaging/release-body.md(由 release:notes 生成)
  if (!existsSync(path.join(root, 'packaging', 'release-body.md'))) {
    missing.push('packaging/release-body.md')
  }

  // resources/seed-shards/(manifest.json + 至少 1 个 seed.part.NNN)
  const seedDir = path.join(root, 'resources', 'seed-shards')
  if (!existsSync(seedDir)) {
    missing.push('resources/seed-shards/ (目录不存在)')
  } else {
    const files = readdirSync(seedDir)
    if (!files.includes('manifest.json') || !files.some((f) => /^seed\.part\.\d{3}$/.test(f))) {
      missing.push('resources/seed-shards/ (缺少 manifest.json 或 seed.part.NNN)')
    }
  }

  // resources/jre-shards/(jre-manifest.json + 至少 1 个 jre.part.NNN)
  const jreDir = path.join(root, 'resources', 'jre-shards')
  if (!existsSync(jreDir)) {
    missing.push('resources/jre-shards/ (目录不存在)')
  } else {
    const files = readdirSync(jreDir)
    if (!files.includes('jre-manifest.json') || !files.some((f) => /^jre\.part\.\d{3}$/.test(f))) {
      missing.push('resources/jre-shards/ (缺少 jre-manifest.json 或 jre.part.NNN)')
    }
  }

  // resources/extra-zips/(至少 1 个 zip 或 tar.xz)
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

function printBuildHints(ver, tag) {
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
  console.error('')
  console.error(`产物齐备后重新运行: npm run release:gitee-local`)
}

// ─── 调用底层脚本(继承 stdio 与 env)──────────────────────────────────
function runScript(scriptPath, tag) {
  const full = path.join(root, scriptPath)
  if (!existsSync(full)) {
    throw new Error(`脚本不存在: ${scriptPath}`)
  }
  console.log(`\n[gitee] 执行: node ${scriptPath} ${tag}`)
  const result = spawnSync('node', [full, tag], {
    stdio: 'inherit',
    cwd: root,
    env: process.env
  })
  if (result.status !== 0) {
    throw new Error(`${scriptPath} 执行失败(退出码 ${result.status})`)
  }
}

// ─── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  const version = readPackageVersion()
  const tag = version.startsWith('v') ? version : `v${version}`
  const ver = tag.replace(/^v/, '')

  console.log(`[gitee] 本地 Gitee 同步启动`)
  console.log(`[gitee] package.json version: ${version}`)
  console.log(`[gitee] 目标 tag: ${tag}`)

  // 1. 校验 GITEE_TOKEN
  const token = process.env.GITEE_TOKEN
  if (!token) {
    console.error('')
    console.error('[gitee] 错误: 环境变量 GITEE_TOKEN 未设置')
    console.error('[gitee] 请先设置 Gitee 私人令牌(PowerShell):')
    console.error('  $env:GITEE_TOKEN = "<你的 Gitee 私人令牌>"')
    console.error('[gitee] 令牌获取: https://gitee.com/profile/personal_access_tokens')
    process.exit(1)
  }

  // 2. 解析 owner/repo
  const { owner, repo, source } = resolveGiteeRepo()
  console.log(`[gitee] 目标仓库: ${owner}/${repo} (来源: ${source})`)

  // 3. 查询 GitHub 最新 Release(信息展示)
  const ghTag = await githubLatestTag()
  if (ghTag) {
    console.log(`[gitee] GitHub 最新 Release: ${ghTag}`)
    if (ghTag !== tag) {
      console.warn(`[gitee] 警告: GitHub 最新 Release (${ghTag}) 与本地 version (${tag}) 不一致`)
      console.warn('[gitee] 如需对齐,请先在 GitHub 发布该版本')
    }
  } else {
    console.warn('[gitee] 警告: 无法查询 GitHub 最新 Release(可能未发布或网络问题)')
  }

  // 4. 查询 Gitee 是否已存在该版本
  console.log(`[gitee] 查询 Gitee 是否已存在 ${tag} ...`)
  const exists = await giteeReleaseExists(owner, repo, tag, token)
  if (exists) {
    console.log(`[gitee] Gitee 已存在 ${tag},跳过同步(幂等)`)
    const urls = giteeUrls(owner, repo, tag, ver)
    console.log(`[gitee] Release 页面: ${urls.releasesPage}`)
    process.exit(0)
  }
  console.log(`[gitee] Gitee 不存在 ${tag},继续同步`)

  // 5. 检查本地构建产物
  const missing = checkLocalAssets(ver)
  if (missing.length > 0) {
    console.error('')
    console.error('[gitee] 错误: 缺少本地构建产物:')
    missing.forEach((m) => console.error(`  - ${m}`))
    printBuildHints(ver, tag)
    process.exit(1)
  }
  console.log('[gitee] 本地构建产物检查通过')

  // 6. 推送 git + tag 到 Gitee
  console.log('\n[gitee] 步骤 1/2: 推送 git + tag 到 Gitee')
  runScript('scripts/release/push-gitee-git.mjs', tag)

  // 7. 同步 Gitee Release(创建 + 上传附件)
  console.log('\n[gitee] 步骤 2/2: 创建 Gitee Release 并上传附件')
  runScript('scripts/release/sync-gitee-release.mjs', tag)

  // 8. 完成
  const urls = giteeUrls(owner, repo, tag, ver)
  console.log('')
  console.log(`[gitee] 同步完成: ${tag}`)
  console.log(`[gitee] Release 页面: ${urls.releasesPage}`)
  console.log(`[gitee] Setup 下载:   ${urls.setup}`)
  console.log(`[gitee] Portable 下载: ${urls.portable}`)
}

main().catch((err) => {
  console.error('')
  console.error(`[gitee] 同步失败: ${err.message || err}`)
  process.exit(1)
})
