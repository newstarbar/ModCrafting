#!/usr/bin/env node
/**
 * Idempotent GitHub Release publisher.
 *
 * `gh release create` fails with 422 when the tag or an asset already exists,
 * which makes a re-run of a release workflow unrecoverable. This script always
 * lands in the same state: create when missing, otherwise upload with
 * --clobber and re-assert title/notes/Latest/prerelease, then read the remote
 * back and fail if it does not match.
 *
 * Input is the directory produced by `release:package`: exactly seven assets
 * (six products + the SHA256SUMS file) plus `release-notes.md`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ASSET_PREFIXES = [
  'ModCrafting-Fabric-Qoder-Plugin-',
  'ModCrafting-Fabric-Multi-Host-',
  'ModCrafting-MCP-',
  'ModCrafting-Skills-',
  'ModCrafting-Offline-',
  'ModCrafting-Fabric-Release-Info-',
  'ModCrafting-Fabric-SHA256SUMS-'
]
const NOTES_FILE = 'release-notes.md'

const EXIT = { OK: 0, USAGE: 1, GH: 2, REMOTE: 3 }

class PublishError extends Error {
  constructor(message, exitCode) {
    super(message)
    this.exitCode = exitCode
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function fail(message, exitCode = EXIT.USAGE) {
  throw new PublishError(message, exitCode)
}

function gh(args, { dryRun = false } = {}) {
  if (dryRun) return { dryRun: true, argv: ['gh', ...args] }
  try {
    return { output: execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (error) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    fail(`gh ${args.join(' ')} 失败：${detail || error.message}`, EXIT.GH)
  }
}

function parseSums(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match) map.set(match[2].trim(), match[1].toLowerCase())
  }
  return map
}

function collect({ directory, tag }) {
  const dir = path.resolve(directory)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`--directory 不是目录：${dir}`)
  const names = readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile())
  const notes = names.find((name) => name === NOTES_FILE)
  if (!notes) fail(`缺少 ${NOTES_FILE}`)
  const assets = names.filter((name) => name !== NOTES_FILE).sort()
  if (assets.length !== ASSET_PREFIXES.length) fail(`应有 ${ASSET_PREFIXES.length} 个资产，实际 ${assets.length}：${assets.join('、')}`)
  for (const prefix of ASSET_PREFIXES) {
    const hits = assets.filter((name) => name.startsWith(prefix))
    if (hits.length !== 1) fail(`资产前缀 ${prefix} 命中 ${hits.length} 个（应为 1）`)
  }
  const sumsName = `ModCrafting-Fabric-SHA256SUMS-${tag}.txt`
  if (!assets.includes(sumsName)) fail(`缺少 ${sumsName}`)
  const sums = parseSums(readFileSync(path.join(dir, sumsName), 'utf8'))
  if (sums.size !== ASSET_PREFIXES.length - 1) fail(`${sumsName} 应包含 ${ASSET_PREFIXES.length - 1} 条记录，实际 ${sums.size}`)
  const records = []
  for (const [name, expected] of sums) {
    const file = path.join(dir, name)
    if (!existsSync(file)) fail(`清单里的 ${name} 不存在`)
    const actual = sha256(readFileSync(file))
    if (actual !== expected) fail(`${name} 的 SHA-256 与清单不符（${actual} != ${expected}）`)
    records.push({ name, file, sha256: actual, bytes: statSync(file).size })
  }
  // The checksum file goes last: a consumer must never see a fresh list with stale assets.
  records.sort((a, b) => Number(a.name === sumsName) - Number(b.name === sumsName))
  records.push({ name: sumsName, file: path.join(dir, sumsName), sha256: sha256(readFileSync(path.join(dir, sumsName))), bytes: statSync(path.join(dir, sumsName)).size })
  if (records.length !== ASSET_PREFIXES.length) fail(`资产数量不一致：${records.length}`)
  return { directory: dir, assets: records, notes: path.join(dir, NOTES_FILE) }
}

function resolveRepo(explicit) {
  if (explicit) return explicit
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', cwd: root }).trim()
    const match = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)
    if (match) return match[1]
  } catch { /* fall through */ }
  fail('无法确定仓库，请用 --repo owner/name 或设置 GITHUB_REPOSITORY')
}

function releaseExists(tag, options) {
  if (options.dryRun) return false
  try {
    execFileSync('gh', ['release', 'view', tag, '--json', 'tagName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

function publish({ directory, tag, repo, latest, prerelease, dryRun }) {
  const { assets, notes } = collect({ directory, tag })
  const files = assets.map((asset) => asset.file)
  const title = `ModCrafting Fabric ${tag}`
  const exists = releaseExists(tag, { dryRun })
  const calls = []

  if (!exists) {
    const args = ['release', 'create', tag, ...files, '--verify-tag', '--title', title, '--notes-file', notes, '--repo', repo]
    if (prerelease) args.push('--prerelease', '--latest=false')
    else if (latest) args.push('--latest')
    calls.push(gh(args, { dryRun }))
  } else {
    calls.push(gh(['release', 'upload', tag, ...files, '--clobber', '--repo', repo], { dryRun }))
    const edit = ['release', 'edit', tag, '--title', title, '--notes-file', notes, '--repo', repo]
    if (prerelease) edit.push('--prerelease', '--latest=false')
    else edit.push('--prerelease=false', latest ? '--latest' : '--latest=false')
    calls.push(gh(edit, { dryRun }))
  }

  let remote
  if (!dryRun) {
    const view = JSON.parse(gh(['release', 'view', tag, '--json', 'assets,isPrerelease', '--repo', repo]).output)
    const names = view.assets.map((asset) => asset.name).sort()
    const expected = assets.map((asset) => asset.name).sort()
    if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`远端资产与本地不一致：\n本地 ${expected.join('、')}\n远端 ${names.join('、')}`, EXIT.REMOTE)
    if (Boolean(view.isPrerelease) !== Boolean(prerelease)) fail(`远端 prerelease=${view.isPrerelease}，期望 ${prerelease}`, EXIT.REMOTE)
    const latestTag = gh(['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name']).output
    if (latest && latestTag !== tag) fail(`Latest 是 ${latestTag}，期望 ${tag}`, EXIT.REMOTE)
    remote = { assetCount: names.length, latestTag, prerelease: view.isPrerelease }
  }

  return {
    ok: true,
    tag,
    action: exists ? 'updated' : 'created',
    latest,
    prerelease,
    dryRun,
    assets: assets.map(({ name, sha256: digest, bytes }) => ({ name, sha256: digest, bytes })),
    ...(remote ? { remote } : { calls })
  }
}

export function uploadRelease(options) {
  return publish(options)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      tag: { type: 'string' },
      repo: { type: 'string' },
      latest: { type: 'boolean' },
      'no-latest': { type: 'boolean' },
      prerelease: { type: 'boolean' },
      'no-prerelease': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' }
    }
  })
  if (values.help) {
    console.log('Usage: release:upload --directory ABSOLUTE [--tag vX.Y.Z] [--repo owner/name] [--latest|--no-latest] [--prerelease|--no-prerelease] [--dry-run]')
    console.log('Creates the GitHub Release when missing, otherwise uploads with --clobber and re-asserts Latest/prerelease. Validates all seven assets against SHA256SUMS first.')
    process.exit(EXIT.OK)
  }
  try {
    if (!values.directory || !path.isAbsolute(values.directory)) fail('--directory 必须是绝对路径')
    const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
    const tag = values.tag ?? `v${packageVersion}`
    if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) fail(`--tag 必须形如 vX.Y.Z：${tag}`)
    if (tag !== `v${packageVersion}`) fail(`tag ${tag} 与 package.json v${packageVersion} 不一致`)
    const prerelease = values['no-prerelease'] ? false : values.prerelease === true ? true : tag.includes('-')
    const latest = values['no-latest'] ? false : values.latest === true ? true : !prerelease
    if (prerelease && latest) fail('预发布不能标记 Latest')
    const result = publish({
      directory: values.directory,
      tag,
      repo: resolveRepo(values.repo),
      latest,
      prerelease,
      dryRun: Boolean(values['dry-run'])
    })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, message: error.message }, null, 2))
    process.exit(error.exitCode ?? EXIT.USAGE)
  }
}
