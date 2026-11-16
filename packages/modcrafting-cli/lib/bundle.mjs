/**
 * Bundle resolution: a directory, a ZIP, the local cache, or a GitHub Release.
 * All four paths end in the same verified `bundle.json` contract.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, exists, sha256, copyTree, readText, statSafe } from './fsx.mjs'
import { versionsDir, stagingDir, inside } from './paths.mjs'
import { readZip } from './zip.mjs'
import { CliError, EXIT } from './args.mjs'
import { download, releaseAssetUrl, releaseSumsUrl, parseSums } from './fetch.mjs'

export const BUNDLE_NAME = 'modcrafting-fabric'
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

function bundleError(message, details) {
  return new CliError(message, { code: 'BUNDLE_INVALID', exitCode: EXIT.BUNDLE, details })
}

export function readBundle(dir) {
  const file = path.join(dir, 'bundle.json')
  if (!exists(file)) throw bundleError(`缺少 bundle.json：${dir}`)
  let manifest
  try {
    manifest = JSON.parse(readText(file).text)
  } catch (cause) {
    throw bundleError(`bundle.json 无法解析：${cause.message}`)
  }
  if (manifest.bundleVersion !== 1) throw bundleError(`不支持的 bundle 版本：${manifest.bundleVersion}`)
  if (manifest.name !== BUNDLE_NAME) throw bundleError(`bundle 名称不符：${manifest.name}`)
  if (!VERSION_PATTERN.test(String(manifest.version ?? ''))) throw bundleError(`bundle 版本号非法：${manifest.version}`)
  if (!manifest.files || typeof manifest.files !== 'object') throw bundleError('bundle.json 缺少 files 清单')
  if (!manifest.files[manifest.entry]) throw bundleError(`bundle 入口不在清单内：${manifest.entry}`)
  return manifest
}

export function verifyBundle(dir, manifest = readBundle(dir)) {
  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (relative.startsWith('/') || relative.includes('..') || path.isAbsolute(relative)) throw bundleError(`非法文件路径：${relative}`)
    const file = path.join(dir, relative)
    if (!inside(dir, file)) throw bundleError(`文件越界：${relative}`)
    const stat = statSafe(file)
    if (!stat || !stat.isFile()) throw bundleError(`缺少文件：${relative}`)
    const actual = sha256(fs.readFileSync(file))
    if (actual !== expected) throw bundleError(`文件指纹不符：${relative}`)
  }
  return manifest
}

function pickRoot(files) {
  if (files.has('bundle.json')) return ''
  const candidates = [...files.keys()].filter((name) => name.endsWith('/bundle.json'))
  if (candidates.length !== 1) throw bundleError('ZIP 里找不到唯一的 bundle.json')
  return candidates[0].slice(0, -'bundle.json'.length)
}

function extractTo(files, root, target) {
  ensureDir(target)
  for (const [name, bytes] of files) {
    if (!name.startsWith(root)) continue
    const relative = name.slice(root.length)
    if (!relative) continue
    const file = path.join(target, relative)
    if (!inside(target, file)) throw bundleError(`文件越界：${relative}`)
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, bytes, { flag: 'wx' })
  }
}

function placeVersion(staged, version) {
  const target = path.join(versionsDir(), version)
  if (exists(target)) {
    try {
      verifyBundle(target)
      fs.rmSync(staged, { recursive: true, force: true })
      return target
    } catch {
      // A corrupted cache is replaced below.
      fs.rmSync(target, { recursive: true, force: true })
    }
  }
  ensureDir(versionsDir())
  try {
    fs.renameSync(staged, target)
  } catch {
    copyTree(staged, target)
    fs.rmSync(staged, { recursive: true, force: true })
  }
  return target
}

export function installFromZip(zipPath) {
  const file = path.resolve(zipPath)
  if (!exists(file)) throw bundleError(`找不到 ZIP：${file}`)
  const files = readZip(fs.readFileSync(file))
  const staged = stagingDir('bundle')
  try {
    extractTo(files, pickRoot(files), staged)
    const manifest = verifyBundle(staged)
    const directory = placeVersion(staged, manifest.version)
    return { directory, manifest, source: file }
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true })
    throw error
  }
}

export function cachedVersions() {
  const directory = versionsDir()
  if (!exists(directory)) return []
  return fs.readdirSync(directory)
    .filter((name) => VERSION_PATTERN.test(name))
    .map((name) => {
      const dir = path.join(directory, name)
      try {
        return { version: name, directory: dir, manifest: readBundle(dir) }
      } catch {
        return { version: name, directory: dir, manifest: undefined }
      }
    })
    .sort((a, b) => compareVersions(b.version, a.version))
}

export function compareVersions(a, b) {
  const parse = (value) => String(value).split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index] ?? 0
    const two = right[index] ?? 0
    if (one === two) continue
    if (typeof one === 'number' && typeof two === 'number') return one - two
    return String(one) < String(two) ? -1 : 1
  }
  return 0
}

export function useBundleDir(directory) {
  const dir = path.resolve(directory)
  const manifest = verifyBundle(dir)
  return { directory: dir, manifest, source: dir }
}

export async function downloadBundle(version, { noNetwork = false, timeout = 120000 } = {}) {
  if (!VERSION_PATTERN.test(String(version ?? ''))) throw bundleError(`版本号非法：${version}`)
  const tag = `v${version}`
  const asset = `ModCrafting-MCP-${tag}.zip`
  const url = releaseAssetUrl(tag, asset)
  const sumsUrl = releaseSumsUrl(tag)
  if (noNetwork) throw bundleError(`未联网模式（--no-network），本地没有 ${version} 版本缓存。请使用 --from-zip 或 --bundle-dir。`)
  let bytes
  try {
    bytes = await download(url, { timeout })
  } catch (cause) {
    throw bundleError(`下载 bundle 失败：${cause.message}\n如处于代理或内网环境，请改用 --from-zip 安装离线包（QQ 群下载的 ZIP）。`, { url })
  }
  try {
    const sums = parseSums((await download(sumsUrl, { timeout })).toString('utf8'))
    const expected = sums.get(asset)
    if (!expected) throw bundleError(`SHA256SUMS 里没有 ${asset}`)
    if (sha256(bytes) !== expected) throw bundleError(`${asset} 的 SHA-256 与发布清单不符`)
  } catch (error) {
    if (error instanceof CliError) throw error
    throw bundleError(`校验 ${asset} 失败：${error.message}；已中止安装。`)
  }
  const staged = stagingDir('download')
  try {
    const files = readZip(bytes)
    extractTo(files, pickRoot(files), staged)
    const manifest = verifyBundle(staged)
    if (manifest.version !== version) throw bundleError(`下载的 bundle 版本是 ${manifest.version}，与请求的 ${version} 不一致`)
    const directory = placeVersion(staged, manifest.version)
    return { directory, manifest, source: url }
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true })
    throw error
  }
}

export async function resolveBundle(options, { defaultVersion } = {}) {
  if (options.fromZip) return installFromZip(options.fromZip)
  if (options.bundleDir) return useBundleDir(options.bundleDir)

  const wanted = options.bundleVersion ?? defaultVersion
  const cached = cachedVersions()
  const noNetwork = options.flags?.has('no-network') || Boolean(process.env.MODCRAFTING_NO_NETWORK)

  if (wanted) {
    const hit = cached.find((item) => item.version === wanted)
    if (hit?.manifest) return { directory: hit.directory, manifest: hit.manifest, source: 'cache' }
    if (noNetwork) {
      const available = cached.filter((item) => item.manifest).map((item) => item.version)
      throw bundleError(`本地没有 ${wanted} 版本缓存（可用：${available.join('、') || '无'}）`)
    }
    return downloadBundle(wanted, { noNetwork, timeout: Number(options.values?.get('timeout') ?? 120000) })
  }

  const latestLocal = cached.find((item) => item.manifest)
  if (latestLocal) return { directory: latestLocal.directory, manifest: latestLocal.manifest, source: 'cache' }
  if (noNetwork) throw bundleError('本地没有已缓存的 bundle，且处于 --no-network 模式')
  throw bundleError('无法确定要安装的 bundle 版本；请用 --bundle-version、--from-zip 或 --bundle-dir')
}
