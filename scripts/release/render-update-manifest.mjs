#!/usr/bin/env node
/**
 * Render packaging/update-manifest.json for a release version.
 * Usage: node scripts/render-update-manifest.mjs 1.0.1 "Release notes"
 *
 * 2026-08 重构：feeds.github 的 manifest/setup/portable 资产 URL 用
 * gh.xmly.dev 代理包裹（与 src/main/github-mirror.ts wrapGithubProxy 一致），
 * releasesPage 保持 GitHub 直链（浏览器页面无需代理）。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { giteeUrls, resolveGiteeRepo } from './gitee-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')
const manifestPath = path.join(root, 'packaging', 'update-manifest.json')

const GITHUB_PROXY_PREFIX = 'https://gh.xmly.dev/'

/** 仅包裹 github.com / raw.githubusercontent.com 的 URL，其余原样返回 */
function wrapGithubProxy(url) {
  if (!url) return url
  if (url.startsWith('https://github.com/') || url.startsWith('https://raw.githubusercontent.com/')) {
    return `${GITHUB_PROXY_PREFIX}${url}`
  }
  return url
}

const rawVersion = process.argv[2]
const notesArg = process.argv[3]

if (!rawVersion) {
  console.error('Usage: node scripts/render-update-manifest.mjs <version> [notes]')
  process.exit(1)
}

const ver = rawVersion.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+/.test(ver)) {
  console.error('Usage: node scripts/render-update-manifest.mjs <version> [notes]')
  console.error(`Invalid version: ${rawVersion}`)
  process.exit(1)
}

const tag = rawVersion.startsWith('v') ? rawVersion : `v${ver}`
const { owner, repo } = resolveGiteeRepo()
const gitee = giteeUrls(owner, repo, tag, ver)

const releaseBodyPath = path.join(root, 'packaging', 'release-body.md')
let notes = notesArg
if (!notes && existsSync(releaseBodyPath)) {
  const firstLine = readFileSync(releaseBodyPath, 'utf-8').split(/\r?\n/).find((l) => l.trim())
  notes = firstLine?.replace(/^#\s*/, '') || `ModCrafting ${tag}`
} else if (!notes) {
  notes = `ModCrafting ${tag}`
}

const githubManifest = `https://github.com/newstarbar/ModCrafting/releases/download/${tag}/latest.yml`
const githubSetup = `https://github.com/newstarbar/ModCrafting/releases/download/${tag}/ModCrafting%20Setup%20${ver}.exe`
const githubPortable = `https://github.com/newstarbar/ModCrafting/releases/download/${tag}/ModCrafting-${ver}-Portable.exe`

const manifest = {
  version: ver,
  releaseDate: new Date().toISOString().slice(0, 10),
  notes,
  feeds: {
    gitee: {
      manifest: gitee.manifest,
      setup: gitee.setup,
      portable: gitee.portable,
      releasesPage: gitee.releasesPage
    },
    github: {
      // 资产 URL 走 gh.xmly.dev 代理加速；releasesPage 为浏览器页面保持直链
      manifest: wrapGithubProxy(githubManifest),
      setup: wrapGithubProxy(githubSetup),
      portable: wrapGithubProxy(githubPortable),
      releasesPage: 'https://github.com/newstarbar/ModCrafting/releases'
    }
  },
  channels: { latest: ver }
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
console.log(`Wrote ${manifestPath} for v${ver}`)
