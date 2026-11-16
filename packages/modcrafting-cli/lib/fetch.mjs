/** Network access: one place for URLs, timeouts and the SHA256SUMS parser. */
import { CliError, EXIT } from './args.mjs'

export const RELEASE_BASE = process.env.MODCRAFTING_RELEASE_BASE ?? 'https://github.com/newstarbar/ModCrafting/releases/download'

export function releaseAssetUrl(tag, asset) {
  return `${RELEASE_BASE.replace(/\/$/, '')}/${tag}/${asset}`
}

export function releaseSumsUrl(tag) {
  return releaseAssetUrl(tag, `ModCrafting-Fabric-SHA256SUMS-${tag}.txt`)
}

export function parseSums(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match) map.set(match[2].trim(), match[1].toLowerCase())
  }
  return map
}

export async function download(url, { timeout = 120000, redirects = 5 } = {}) {
  let current = url
  for (let attempt = 0; attempt <= redirects; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout)
    let response
    try {
      response = await fetch(current, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'modcrafting-cli' } })
    } catch (cause) {
      throw new CliError(`请求失败 ${current}：${cause.message}`, { code: 'NETWORK', exitCode: EXIT.BUNDLE })
    } finally {
      clearTimeout(timer)
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new CliError(`重定向缺少 Location：${current}`, { code: 'NETWORK', exitCode: EXIT.BUNDLE })
      current = new URL(location, current).toString()
      continue
    }
    if (!response.ok) throw new CliError(`HTTP ${response.status}：${current}`, { code: 'NETWORK', exitCode: EXIT.BUNDLE })
    const buffer = Buffer.from(await response.arrayBuffer())
    return buffer
  }
  throw new CliError(`重定向次数过多：${url}`, { code: 'NETWORK', exitCode: EXIT.BUNDLE })
}
