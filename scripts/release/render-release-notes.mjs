#!/usr/bin/env node
/**
 * Render Chinese GitHub/Gitee release body (no manual MD edits per version).
 * Usage: node scripts/render-release-notes.mjs <tag> [outputPath]
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'
import { giteeUrls, resolveGiteeRepo } from './gitee-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')

const GITHUB_OWNER = 'newstarbar'
const GITHUB_REPO = 'ModCrafting'

const rawTag = process.argv[2]
const outputPath = process.argv[3] || path.join(root, 'packaging', 'release-body.md')

if (!rawTag) {
  console.error('Usage: node scripts/render-release-notes.mjs <tag> [outputPath]')
  process.exit(1)
}

const tag = rawTag.startsWith('v') ? rawTag : `v${rawTag}`
const ver = tag.replace(/^v/, '')

function git(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function listVersionTags() {
  const out = git('git tag -l "v*" --sort=-v:refname')
  return out ? out.split(/\r?\n/).filter(Boolean) : []
}

function previousTag(current) {
  const tags = listVersionTags()
  const idx = tags.indexOf(current)
  if (idx >= 0 && idx < tags.length - 1) return tags[idx + 1]
  return null
}

function shortenSubject(text, max = 88) {
  let s = text.split(/\s+-\s+/)[0].trim()
  if (s.length > max) s = `${s.slice(0, max - 1)}…`
  return s
}

function categorizeSubject(subject) {
  const s = subject.trim()
  const lower = s.toLowerCase()
  if (/^merge /i.test(s)) return 'skip'
  if (/^(fix|修复|bug|hotfix|patch)(\(|:|：|\s)/i.test(s) || /^fix:/i.test(lower) || /修复/.test(s)) return 'fix'
  if (/^(feat|新增|add|feature)(\(|:|：|\s)/i.test(s) || /^feat:/i.test(s) || /新增/.test(s)) return 'feat'
  if (/^(perf|优化|improve|refactor|enhance)(\(|:|：|\s)/i.test(s) || /^(perf|refactor):/i.test(lower) || /优化|重构/.test(s)) return 'perf'
  if (/^(docs|doc|文档)(\(|:|：|\s)/i.test(s)) return 'skip'
  if (/^(chore|ci|build|style|test)(\(|:|：|\s)/i.test(s) || /^(chore|ci|build|test):/i.test(lower)) return 'skip'
  return 'other'
}

function cleanSubject(subject) {
  return shortenSubject(
    subject
      .replace(/^(feat|fix|perf|docs|chore|ci|build|test|refactor)(\([^)]*\))?:\s*/i, '')
      .replace(/^(新增|修复|优化|文档)[:：]\s*/, '')
      .trim()
  )
}

function collectChangelog(prev, current) {
  const range = prev ? `${prev}..${current}` : current
  const log = git(`git log ${range} --pretty=format:%h|%s`)
  if (!log) return { feat: [], fix: [], perf: [], other: [] }

  const groups = { feat: [], fix: [], perf: [], other: [] }
  const seen = new Set()

  for (const line of log.split(/\r?\n/)) {
    const pipe = line.indexOf('|')
    if (pipe === -1) continue
    const hash = line.slice(0, pipe)
    const subject = line.slice(pipe + 1).trim()
    if (!subject || seen.has(subject)) continue
    seen.add(subject)

    const cat = categorizeSubject(subject)
    if (cat === 'skip') continue

    const text = cleanSubject(subject)
    if (!text) continue
    const entry = `${text} (${hash})`
    groups[cat === 'other' ? 'other' : cat].push(entry)
  }

  return groups
}

function bulletSection(title, items, limit = 12) {
  if (!items.length) return ''
  const lines = items.slice(0, limit).map((item, i) => `${i + 1}. ${item}`)
  return `### ${title}\n\n${lines.join('\n')}\n`
}

function buildChangelogSection(prev, current) {
  const groups = collectChangelog(prev, current)
  const parts = [
    bulletSection('✨ 新增', groups.feat),
    bulletSection('🐛 修复', groups.fix),
    bulletSection('🔧 优化', groups.perf)
  ].filter(Boolean)

  // 仅展示前 8 条「其他」，避免首版 Release 刷屏
  if (groups.other.length) {
    parts.push(bulletSection('📦 其他', groups.other.slice(0, 8)))
  }

  if (!parts.length) {
    return '### 更新\n\n- 维护性更新与构建流程改进\n'
  }

  const compareUrl =
    prev
      ? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/compare/${prev}...${current}`
      : `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${current}`

  return `## 更新\n\n${parts.join('\n')}\n---\n\n**完整更新日志**: [${prev || '首个版本'}...${current}](${compareUrl})\n`
}

function buildBody() {
  const { owner, repo } = resolveGiteeRepo()
  const gitee = giteeUrls(owner, repo, tag, ver)
  const githubBase = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}`
  const prev = previousTag(tag)

  const downloadTable = `| 版本 | 说明 | Gitee | GitHub |
|------|------|-------|--------|
| **完整版 Setup** | 内置 JDK / Gradle / Fabric 离线依赖；支持应用内更新 | [Gitee 下载](${gitee.setup}) | [GitHub 下载](${githubBase}/ModCrafting%20Setup%20${ver}.exe) |
| **便携版 Portable** | 体积小；**首次需联网**下载工具链（约 1 GB） | [Gitee 下载](${gitee.portable}) | [GitHub 下载](${githubBase}/ModCrafting%20${ver}%20Portable.exe) |`

  const changelog = buildChangelogSection(prev, tag)

  return `# ModCrafting ${tag}

[使用文档](https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}#快速开始用户) · [Gitee 发布页](${gitee.releasesPage}) · [GitHub Releases](https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases)

## 下载

${downloadTable}

### 如何选择

- **日常开发 / 网络不稳定**：选 **Setup 完整版**
- **U 盘 / 临时机器 / 可接受首启下载**：选 **Portable 便携版**

## 提示

- ModCrafting 与 Mojang / Microsoft **无官方关联**，使用本软件须遵守 [Minecraft EULA](https://www.minecraft.net/zh-hans/eula)，并自备合法游戏副本
- **完整版**：首次启动会初始化 \`runtime/\` 离线环境（约数分钟），完成后可离线构建模组
- **便携版**：工具链下载至系统临时目录的 \`runtime/\`，设置保存在 \`%AppData%\\modcrafting\`

## 升级说明

- **Setup 用户**：应用内 **帮助 → 检查更新**（优先 Gitee，失败自动切换 GitHub）
- **更新失败时**：从 [Gitee](${gitee.releasesPage}) 或 [GitHub](https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases) 手动下载安装包覆盖安装
- **便携版用户**：下载新版 Portable，替换旧 exe 即可（不支持应用内自动升级）

${changelog}`
}

const body = buildBody()
mkdirSync(path.dirname(outputPath), { recursive: true })
writeFileSync(outputPath, body, 'utf-8')
console.log(`Wrote ${outputPath} (${body.length} chars)`)
