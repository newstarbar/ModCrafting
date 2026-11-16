/**
 * Host config writers. One merge path for JSON hosts, one surgical patcher for
 * Codex TOML. Every write is idempotent, backed up and atomic; nothing else in
 * the file is touched.
 */
import path from 'node:path'
import { CliError, EXIT } from './args.mjs'
import { SERVER_NAME } from './hosts.mjs'
import {
  assertWritablePath, atomicWrite, backupFile, deepEqual, detectIndent, ensureDir,
  exists, readJson, readText, serializeJson, stripBom
} from './fsx.mjs'
import { readServerBlock, removeServerBlock, renderServerBlock, upsertServerBlock } from './toml.mjs'
import { appData, backupsDir, configHome, dataDir as defaultDataDir, userHome } from './paths.mjs'

/** GUI hosts are launched without a login shell, so `node` alone often is not on PATH. */
const ABSOLUTE_NODE = new Set(['cursor', 'trae', 'devin-desktop', 'workbuddy', 'codebuddy', 'qoder', 'pi'])
const EXTRA_FLAGS = new Map([
  ['workbuddy', ['--web', '--text=digest']],
  ['codebuddy', ['--web', '--text=digest']],
  ['qoder', ['--web']]
])

export function buildContext(host, { bundle, options }) {
  const nodeOverride = options.values?.get('node')
  const absolute = Boolean(nodeOverride) || ABSOLUTE_NODE.has(host.id)
  const node = nodeOverride ? path.resolve(nodeOverride) : absolute ? process.execPath : 'node'
  const dataOverride = options.values?.get('data-root')
  return {
    platform: process.platform,
    env: process.env,
    home: userHome(),
    appData: appData(),
    configHome: configHome(),
    node,
    nodeIsAbsolute: absolute,
    script: path.join(bundle.directory, bundle.manifest.entry),
    flags: EXTRA_FLAGS.get(host.id) ?? [],
    bundleDir: bundle.directory,
    dataDir: dataOverride ? path.resolve(dataOverride) : defaultDataDir(host.id)
  }
}

export function configCandidates(host, ctx, options) {
  if (host.id === 'generic') {
    const override = options.values?.get('config-path')
    if (!override) throw new CliError('generic 宿主必须提供 --config-path <文件>', { code: 'USAGE' })
    return [path.resolve(override)]
  }
  const candidates = host.config.paths(ctx)
  if (!candidates.length) throw new CliError(`${host.label} 不支持直接写 MCP 配置`, { code: 'UNSUPPORTED_HOST', exitCode: EXIT.UNSUPPORTED })
  return candidates
}

export function pickConfigFile(candidates) {
  return candidates.find((file) => exists(file)) ?? candidates[0]
}

function guardParent(file, host, { allowCreate, dryRun }) {
  const parent = path.dirname(file)
  if (exists(parent)) return
  if (!allowCreate) {
    throw new CliError(
      `目录不存在：${parent}\n${host.label} 可能没有安装，或安装路径不同。请确认后重试，或用 --config-path 指定文件。`,
      { code: 'UNSUPPORTED_HOST', exitCode: EXIT.UNSUPPORTED }
    )
  }
  if (!dryRun) ensureDir(parent)
}

function setPath(data, keys, value) {
  let cursor = data
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === undefined) cursor[key] = {}
    if (typeof cursor[key] !== 'object' || cursor[key] === null || Array.isArray(cursor[key])) {
      throw new CliError(`配置里的 ${keys.join('.')} 不是对象，无法安全合并`, { code: 'CONFIG_CONFLICT', exitCode: EXIT.CONFIG })
    }
    cursor = cursor[key]
  }
  cursor[keys.at(-1)] = value
}

function deletePath(data, keys) {
  const chain = []
  let cursor = data
  for (const key of keys.slice(0, -1)) {
    if (typeof cursor?.[key] !== 'object' || cursor[key] === null) return false
    chain.push([cursor, key])
    cursor = cursor[key]
  }
  const leaf = keys.at(-1)
  if (!(leaf in cursor)) return false
  delete cursor[leaf]
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const [parent, key] = chain[index]
    if (Object.keys(parent[key]).length === 0) delete parent[key]
  }
  return true
}

function entryAt(host, data) {
  let node = data
  for (const key of host.config.rootKey) {
    node = node?.[key]
    if (node === undefined) return undefined
  }
  return node?.[SERVER_NAME]
}

export function readEntry(host, ctx, options) {
  const file = pickConfigFile(configCandidates(host, ctx, options))
  if (!exists(file)) return { file, entry: undefined }
  if (host.config.kind === 'toml') return { file, block: readServerBlock(stripBom(readText(file).text), SERVER_NAME) }
  return { file, entry: entryAt(host, readJson(file).data) }
}

export function snippet(host, ctx) {
  const entry = host.config.entry(ctx)
  if (host.config.kind === 'toml') return renderServerBlock(SERVER_NAME, entry)
  const build = (keys, value) => (keys.length === 1 ? { [keys[0]]: value } : { [keys[0]]: build(keys.slice(1), value) })
  return JSON.stringify(build([...host.config.rootKey], { [SERVER_NAME]: entry }), null, 2)
}

export function applyMcp(host, ctx, options, state) {
  if (host.config.kind === 'cli') {
    throw new CliError(
      `${host.label} 必须通过官方命令安装：\n  ${host.plugin?.install ?? 'dsh plugin --profile web add github:newstarbar/ModCrafting'}\n然后重启宿主。`,
      { code: 'UNSUPPORTED_HOST', exitCode: EXIT.UNSUPPORTED }
    )
  }
  const file = pickConfigFile(configCandidates(host, ctx, options))
  const entry = host.config.entry(ctx)
  const dryRun = options.flags.has('dry-run')
  const explicitPath = host.id === 'generic' && Boolean(options.values?.get('config-path'))
  guardParent(file, host, { allowCreate: explicitPath || (host.config.createParents === true && host.verified === 'yes'), dryRun })
  assertWritablePath(file)

  if (host.config.kind === 'toml') {
    const document = exists(file) ? readText(file) : { exists: false, text: '' }
    const result = upsertServerBlock(stripBom(document.text), SERVER_NAME, entry)
    if (!result.changed) return { host: host.id, file, action: 'unchanged', entry }
    if (dryRun) return { host: host.id, file, action: document.exists ? 'update' : 'create', entry, preview: result.text }
    const backup = backupFile(file, path.join(backupsDir(), host.id))
    atomicWrite(file, result.text)
    return { host: host.id, file, action: document.exists ? 'updated' : 'created', backup, entry }
  }

  const document = readJson(file)
  const existing = entryAt(host, document.data)
  if (existing !== undefined && deepEqual(existing, entry)) return { host: host.id, file, action: 'unchanged', entry }
  const next = structuredClone(document.data)
  setPath(next, [...host.config.rootKey, SERVER_NAME], entry)
  const text = serializeJson(next, { eol: document.eol, indent: detectIndent(document.text) })
  if (document.exists && readText(file).text === text) return { host: host.id, file, action: 'unchanged', entry }
  const action = existing === undefined ? 'created' : 'updated'
  if (dryRun) return { host: host.id, file, action: document.exists ? action : 'created', entry, preview: text }
  const backup = document.exists ? backupFile(file, path.join(backupsDir(), host.id)) : undefined
  atomicWrite(file, text)
  return { host: host.id, file, action: document.exists ? action : 'created', backup, entry }
}

export function removeMcp(host, ctx, options) {
  if (host.config.kind === 'cli') return { host: host.id, action: 'manual' }
  const file = pickConfigFile(configCandidates(host, ctx, options))
  if (!exists(file)) return { host: host.id, file, action: 'absent' }
  assertWritablePath(file)
  const dryRun = options.flags.has('dry-run')

  if (host.config.kind === 'toml') {
    const result = removeServerBlock(stripBom(readText(file).text), SERVER_NAME)
    if (!result.changed) return { host: host.id, file, action: 'absent' }
    if (dryRun) return { host: host.id, file, action: 'remove' }
    const backup = backupFile(file, path.join(backupsDir(), host.id))
    atomicWrite(file, result.text)
    return { host: host.id, file, action: 'removed', backup }
  }

  const document = readJson(file)
  const next = structuredClone(document.data)
  if (!deletePath(next, [...host.config.rootKey, SERVER_NAME])) return { host: host.id, file, action: 'absent' }
  if (dryRun) return { host: host.id, file, action: 'remove' }
  const backup = backupFile(file, path.join(backupsDir(), host.id))
  atomicWrite(file, serializeJson(next, { eol: document.eol, indent: detectIndent(document.text) }))
  return { host: host.id, file, action: 'removed', backup }
}

export function configStatus(host, ctx, options) {
  const candidates = configCandidates(host, ctx, options)
  const file = pickConfigFile(candidates)
  if (!exists(file)) return { file, exists: false, readable: true }
  try {
    if (host.config.kind === 'toml') return { file, exists: true, readable: true, hasEntry: Boolean(readServerBlock(stripBom(readText(file).text), SERVER_NAME)) }
    return { file, exists: true, readable: true, hasEntry: entryAt(host, readJson(file).data) !== undefined }
  } catch (error) {
    return { file, exists: true, readable: false, error: error.message }
  }
}
