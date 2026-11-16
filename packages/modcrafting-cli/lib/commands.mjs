/** Command orchestration: every command returns plain data; bin/ prints it. */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { CliError, EXIT, cliVersion } from './args.mjs'
import { HOSTS, resolveHost } from './hosts.mjs'
import { detectHosts, selectHosts } from './detect.mjs'
import { applyMcp, buildContext, configStatus, removeMcp, snippet } from './configs.mjs'
import { installSkills, removeSkills, skillsStatus } from './skills.mjs'
import { cachedVersions, resolveBundle, verifyBundle } from './bundle.mjs'
import { readState, writeState, recordHost, forgetHost, installedHosts } from './state.mjs'
import { appData, configHome, rootDir, stateFile, userHome } from './paths.mjs'
import { exists } from './fsx.mjs'

function baseContext() {
  return { platform: process.platform, env: process.env, home: userHome(), appData: appData(), configHome: configHome() }
}

function selection(options) {
  const selectionResult = selectHosts(options, baseContext())
  if (selectionResult.hosts.some((host) => host.id === 'generic') && !options.values?.get('config-path')) {
    throw new CliError('generic 宿主必须提供 --config-path <文件>', { code: 'USAGE' })
  }
  return selectionResult
}

function delegateCommand(host, ctx, options) {
  const executable = host.id
  const args = []
  if (host.id === 'claude') args.push('mcp', 'add', '-s', 'user', '-e', `MODCRAFTING_DATA=${ctx.dataDir}`, 'modcrafting-fabric', '--', ctx.node, ctx.script, ...ctx.flags)
  else if (host.id === 'codex') args.push('mcp', 'add', 'modcrafting-fabric', '--env', `MODCRAFTING_DATA=${ctx.dataDir}`, '--', ctx.node, ctx.script, ...ctx.flags)
  else if (host.id === 'copilot') args.push('mcp', 'add', 'modcrafting-fabric', '--', ctx.node, ctx.script, ...ctx.flags)
  else if (host.id === 'kimi') args.push('mcp', 'add', '--transport', 'stdio', 'modcrafting-fabric', '--', ctx.node, ctx.script, ...ctx.flags)
  else if (host.id === 'dsh') {
    const profile = options.values?.get('profile')
    if (profile) args.push('--profile', profile)
    args.push('mcp', 'add', 'modcrafting-fabric', '--', ctx.node, ctx.script, ...ctx.flags)
  } else return undefined
  return { executable, args }
}

function tryDelegate(host, ctx, options) {
  const command = delegateCommand(host, ctx, options)
  if (!command) return undefined
  const probe = spawnSync(command.executable, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true })
  if (probe.error || probe.status !== 0) return undefined
  const result = spawnSync(command.executable, command.args, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true })
  return {
    delegated: true,
    command: [command.executable, ...command.args].join(' '),
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  }
}

export async function install(options) {
  const bundle = await resolveBundle(options, { defaultVersion: cliVersion() })
  const selected = selection(options)
  const state = readState()
  const dryRun = options.flags.has('dry-run')
  const reports = []

  for (const host of selected.hosts) {
    const ctx = buildContext(host, { bundle, options })
    if (options.flags.has('print-snippet')) {
      reports.push({ host: host.id, label: host.label, snippet: snippet(host, ctx) })
      continue
    }
    const entry = { host: host.id, label: host.label, restartHint: host.restartHint, verified: host.verified }
    if (host.config.kind === 'cli' || options.flags.has('delegate')) {
      const delegated = dryRun ? undefined : tryDelegate(host, ctx, options)
      if (delegated) {
        entry.delegate = delegated
        if (!delegated.ok) throw new CliError(`${host.label} 的官方命令执行失败：${delegated.output}`, { code: 'DELEGATE_FAILED', exitCode: EXIT.CONFIG })
        entry.config = { action: 'delegated', file: delegated.command }
      } else if (host.config.kind === 'cli') {
        throw new CliError(
          `没有找到 ${host.id} 命令。请先安装并登录 ${host.label}，然后重试：\n  ${host.plugin?.install ?? ''}`,
          { code: 'UNSUPPORTED_HOST', exitCode: EXIT.UNSUPPORTED }
        )
      }
    }
    if (!entry.config) entry.config = applyMcp(host, ctx, options, state)
    entry.skills = installSkills(bundle, host, ctx, options)
    if (!dryRun) {
      recordHost(state, host.id, {
        bundleVersion: bundle.manifest.version,
        configFile: entry.config.file,
        entry: entry.config.entry,
        skills: entry.skills.filter((item) => item.action !== 'unchanged')
      })
    }
    reports.push(entry)
  }

  if (!dryRun && !options.flags.has('print-snippet')) writeState(state)
  return {
    ok: true,
    command: 'install',
    dryRun,
    bundle: { version: bundle.manifest.version, directory: bundle.directory, source: bundle.source },
    hosts: reports,
    stateFile: stateFile()
  }
}

export async function mcp(options) {
  const selected = selection(options)
  const dryRun = options.flags.has('dry-run')
  if (options.flags.has('remove')) {
    const results = []
    for (const host of selected.hosts) {
      const ctx = { platform: process.platform, env: process.env, home: userHome(), appData: appData(), configHome: configHome(), node: 'node', script: '', flags: [], bundleDir: '', dataDir: '' }
      results.push(removeMcp(host, ctx, options))
    }
    return { ok: true, command: 'mcp', remove: true, dryRun, hosts: results }
  }
  const bundle = await resolveBundle(options, { defaultVersion: cliVersion() })
  const state = readState()
  const results = []
  for (const host of selected.hosts) {
    const ctx = buildContext(host, { bundle, options })
    results.push(applyMcp(host, ctx, options, state))
  }
  if (!dryRun) writeState(state)
  return { ok: true, command: 'mcp', dryRun, bundle: { version: bundle.manifest.version, directory: bundle.directory }, hosts: results }
}

export async function skills(options) {
  const selected = selection(options)
  const state = readState()
  const dryRun = options.flags.has('dry-run')
  if (options.flags.has('remove')) {
    const results = []
    for (const host of selected.hosts) {
      const outcome = removeSkills(state.installs[host.id]?.skills, { dryRun })
      if (!dryRun) forgetHost(state, host.id)
      results.push({ host: host.id, ...outcome })
    }
    if (!dryRun) writeState(state)
    return { ok: true, command: 'skills', remove: true, dryRun, hosts: results }
  }
  const bundle = await resolveBundle(options, { defaultVersion: cliVersion() })
  const results = []
  for (const host of selected.hosts) {
    const ctx = buildContext(host, { bundle, options })
    const installed = installSkills(bundle, host, ctx, options)
    results.push({ host: host.id, label: host.label, skills: installed })
    if (!dryRun) recordHost(state, host.id, { ...(state.installs[host.id] ?? {}), bundleVersion: bundle.manifest.version, skills: installed.filter((item) => item.action !== 'unchanged') })
  }
  if (!dryRun) writeState(state)
  return { ok: true, command: 'skills', dryRun, bundle: { version: bundle.manifest.version }, hosts: results }
}

export async function doctor(options) {
  const detected = detectHosts(baseContext())
  const state = readState()
  const targets = options.hosts.length
    ? options.hosts.map((value) => resolveHost(value))
    : HOSTS.filter((host) => host.id === 'generic' ? false : detected.some((item) => item.id === host.id) || state.installs[host.id])

  const report = []
  for (const host of targets) {
    const ctx = { platform: process.platform, env: process.env, home: userHome(), appData: appData(), configHome: configHome(), node: 'node', script: '', flags: [], bundleDir: '', dataDir: '' }
    let config
    try {
      config = configStatus(host, ctx, options)
    } catch (error) {
      config = { file: options.values?.get('config-path') ?? '', exists: false, readable: false, error: error.message }
    }
    const installation = state.installs[host.id]
    const bundleDir = installation ? cachedVersions().find((item) => item.version === installation.bundleVersion)?.directory : undefined
    let skills = []
    try {
      skills = bundleDir ? skillsStatus(host, ctx, options, bundleDir) : skillsStatus(host, ctx, options)
    } catch { skills = [] }
    report.push({
      host: host.id,
      label: host.label,
      verified: host.verified,
      detected: detected.find((item) => item.id === host.id) ?? null,
      config,
      skills: skills.map(({ name, installed, current, file }) => ({ name, installed, current, file })),
      installedVersion: installation?.bundleVersion,
      restartHint: host.restartHint,
      docsUrl: host.docsUrl,
      quirks: host.quirks
    })
  }

  const versions = cachedVersions().map(({ version, directory, manifest }) => ({ version, directory, valid: Boolean(manifest) }))
  const problems = []
  for (const item of report) {
    if (item.config.exists && !item.config.readable) problems.push(`${item.host} 配置无法解析：${item.config.error}`)
    if (item.installedVersion && !item.config.hasEntry) problems.push(`${item.host} 已安装但配置里找不到条目`)
  }
  return {
    ok: problems.length === 0,
    command: 'doctor',
    node: { executable: process.execPath, version: process.version },
    root: rootDir(),
    stateFile: stateFile(),
    versions,
    hosts: report,
    problems
  }
}

export async function update(options) {
  const state = readState()
  if (!installedHosts(state).length) throw new CliError('还没有安装过任何宿主，请先运行 modcrafting install', { code: 'USAGE' })
  const hosts = options.hosts.length ? options.hosts : installedHosts(state)
  const merged = { ...options, hosts }
  return install(merged)
}

export function uninstall(options) {
  const state = readState()
  const selected = options.hosts.length
    ? { hosts: options.hosts.map((value) => resolveHost(value)) }
    : { hosts: HOSTS.filter((host) => state.installs[host.id]) }
  if (!selected.hosts.length) throw new CliError('没有可卸载的宿主记录；可显式指定 --host', { code: 'USAGE' })
  const dryRun = options.flags.has('dry-run')
  const results = []
  for (const host of selected.hosts) {
    const ctx = { platform: process.platform, env: process.env, home: userHome(), appData: appData(), configHome: configHome(), node: 'node', script: '', flags: [], bundleDir: '', dataDir: '' }
    const config = removeMcp(host, ctx, options)
    const skills = removeSkills(state.installs[host.id]?.skills, { dryRun })
    if (!dryRun) forgetHost(state, host.id)
    results.push({ host: host.id, label: host.label, config, skills })
  }
  if (!dryRun) writeState(state)
  return { ok: true, command: 'uninstall', dryRun, hosts: results }
}

export function versions() {
  const state = readState()
  return {
    ok: true,
    command: 'versions',
    cli: cliVersion(),
    root: rootDir(),
    cached: cachedVersions().map(({ version, directory, manifest }) => ({ version, directory, valid: Boolean(manifest), files: manifest ? Object.keys(manifest.files).length : 0 })),
    installed: Object.entries(state.installs).map(([id, value]) => ({ host: id, version: value.bundleVersion, installedAt: value.installedAt, configFile: value.configFile }))
  }
}

export function verify(options) {
  const dir = path.resolve(options.positionals?.[0] ?? options.values?.get('bundle-dir') ?? '.')
  const manifest = verifyBundle(dir)
  return { ok: true, command: 'verify', directory: dir, version: manifest.version, files: Object.keys(manifest.files).length }
}

export { exists }
