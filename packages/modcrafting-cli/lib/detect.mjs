/** Host detection: environment hints are weak, existing directories are strong. */
import fs from 'node:fs'
import { HOSTS, resolveHost } from './hosts.mjs'
import { CliError, EXIT } from './args.mjs'

function present(file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

export function detectHosts(ctx) {
  const found = []
  for (const host of HOSTS) {
    if (host.id === 'generic') continue
    const envHits = host.detect.env.filter((name) => Boolean(ctx.env[name]))
    const pathHits = host.detect.paths(ctx).filter(present)
    if (!envHits.length && !pathHits.length) continue
    found.push({
      host,
      id: host.id,
      strong: pathHits.length > 0,
      evidence: { env: envHits, paths: pathHits }
    })
  }
  return found.sort((a, b) => Number(b.strong) - Number(a.strong) || b.evidence.env.length - a.evidence.env.length)
}

/**
 * Resolve the host list for a command.
 * explicit > all-detected > auto (single strong candidate, or the unique
 * candidate with the strongest environment evidence).
 */
export function selectHosts(options, ctx) {
  const explicit = options.hosts
  if (explicit.length) {
    const hosts = []
    for (const value of explicit) {
      const host = resolveHost(value)
      if (!hosts.includes(host)) hosts.push(host)
    }
    return { mode: 'explicit', hosts, detected: detectHosts(ctx) }
  }

  const detected = detectHosts(ctx)
  const strong = detected.filter((item) => item.strong)

  if (options.flags.has('all-detected')) {
    if (!strong.length) throw new CliError('没有检测到任何已安装的宿主；请用 --host 指定', { code: 'NO_HOST_DETECTED', exitCode: EXIT.HOST, details: { detected } })
    return { mode: 'all', hosts: strong.map((item) => item.host), detected }
  }

  if (!strong.length) {
    const candidates = detected.map((item) => ({ id: item.id, label: item.host.label, evidence: item.evidence }))
    throw new CliError(
      candidates.length
        ? `只找到了弱证据，无法确认宿主：${candidates.map((item) => item.id).join('、')}。请用 --host 指定。`
        : `没有检测到已安装的宿主。可用 --host 指定：${HOSTS.filter((host) => host.id !== 'generic').map((host) => host.id).join('、')}`,
      { code: candidates.length ? 'WEAK_HOST_EVIDENCE' : 'NO_HOST_DETECTED', exitCode: EXIT.HOST, details: { candidates } }
    )
  }

  if (strong.length === 1) return { mode: 'auto', hosts: [strong[0].host], detected }

  // Several hosts with real config directories: prefer the one the current
  // process is obviously running inside (environment evidence), otherwise stop.
  const scored = strong.map((item) => ({ item, score: item.evidence.env.length })).sort((a, b) => b.score - a.score)
  if (scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? 0)) {
    return { mode: 'auto', hosts: [scored[0].item.host], detected }
  }
  throw new CliError(
    `检测到多个宿主：${strong.map((item) => item.id).join('、')}。请用 --host 选择，或 --all-detected 全部安装。`,
    {
      code: 'AMBIGUOUS_HOST',
      exitCode: EXIT.HOST,
      details: { candidates: strong.map((item) => ({ id: item.id, label: item.host.label, evidence: item.evidence })) }
    }
  )
}
