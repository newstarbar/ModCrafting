/**
 * 多源下载测速选优。
 *
 * 不同用户网络环境下，各下载源（Gitee / GitHub / 腾讯云 / 华为云 / 官方源等）
 * 速度差异巨大（实测同一网络下 services.gradle.org 43KB/s vs 腾讯云镜像 14MB/s，
 * 相差 330 倍）。固定镜像顺序无法适配所有网络，因此在各阶段下载前对候选源
 * 用注入的 Chromium fetch（与最终下载同一网络栈，测速结果才准确）流式下载
 * 前 512KB 计时，选择最快的源。
 */
import { DOWNLOAD_USER_AGENT, getDownloadFetch } from './download-shared'

/** 探测下载量：512KB，相对实际下载量（65MB~1GB）可忽略 */
const PROBE_BYTES = 512 * 1024
/** 单源探测超时（10s：给慢启动/代理握手留余量） */
const PROBE_TIMEOUT_MS = 10000
/** 测速有效性阈值：最快的源低于此速度视为测速无效，按原始候选顺序返回 */
const MIN_VALID_SPEED_KBPS = 200

export interface ProbeCandidate {
  url: string
  label: string
}

export interface ProbeResult extends ProbeCandidate {
  /** 测得吞吐 KB/s；失败/超时为 null */
  speedKBps: number | null
}

/** 会话级缓存：同一 URL 只探测一次，避免多阶段重复开销 */
const probeCache = new Map<string, number | null>()

/**
 * 用指定 fetch 实现探测单个源速度。失败/超时返回 null。
 * 抽出来是为了支持并发用不同网络栈测速。
 */
async function probeWith(
  fetchImpl: typeof globalThis.fetch,
  url: string
): Promise<number | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const t0 = Date.now()
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': DOWNLOAD_USER_AGENT },
      signal: controller.signal
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const reader = res.body.getReader()
    let received = 0
    while (received < PROBE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
    }
    await reader.cancel().catch(() => {})
    const secs = (Date.now() - t0) / 1000
    // 必须下载满 PROBE_BYTES 才算有效测速：API 接口的小响应（如 Adoptium API 返回 JSON）
    // 不能反映 CDN 下载速度，会让小响应源排在大文件源前面导致选错源
    if (received >= PROBE_BYTES && secs > 0) return Math.round(received / 1024 / secs)
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测单个下载源速度（KB/s），失败/超时返回 null；结果按 URL 缓存。
 *
 * 并发用两个网络栈测速，取较快的：
 * - net.fetch（Chromium 栈）：走系统代理，对需要代理的国外源（GitHub）有效
 * - globalThis.fetch（Node undici）：不走系统代理，对国内源（清华 TUNA）有效
 *
 * 实测 2026-08：用户系统代理残留时，net.fetch 对清华 TUNA 测速全失败，
 * 但 curl（不走代理）实测 14MB/s。双栈并发测速能覆盖两种场景。
 */
export async function probeSpeed(url: string): Promise<number | null> {
  const cached = probeCache.get(url)
  if (cached !== undefined) return cached

  const [chromiumSpeed, nodeSpeed] = await Promise.allSettled([
    probeWith(getDownloadFetch(), url),
    probeWith(globalThis.fetch, url)
  ])

  const c = chromiumSpeed.status === 'fulfilled' ? chromiumSpeed.value : null
  const n = nodeSpeed.status === 'fulfilled' ? nodeSpeed.value : null
  // 取两个中较快的；都失败则 null
  const speed = c !== null && n !== null
    ? Math.max(c, n)
    : (c ?? n ?? null)

  probeCache.set(url, speed)
  return speed
}

/** 格式化速度用于用户可见消息 */
export function formatSpeed(speedKBps: number): string {
  return speedKBps >= 1024 ? `${(speedKBps / 1024).toFixed(1)}MB/s` : `${speedKBps}KB/s`
}

/** 测速结构化事件（渲染层专门 UX 面板展示，取代字符消息） */
export interface ProbeEvent {
  /** 当前已完成的候选源列表（逐源累积；done 时为全量排序结果） */
  candidates: ProbeResult[]
  /** 是否全部测速完成 */
  done: boolean
  /** done 时：选中的最快源 label（全部失败时为 undefined） */
  chosen?: string
}

let probeListener: ((e: ProbeEvent) => void) | null = null

/** 注册测速事件监听（主进程启动时接线 → 广播 env:sourceProbe 到渲染层） */
export function setProbeListener(fn: ((e: ProbeEvent) => void) | null): void {
  probeListener = fn
}

/**
 * 并发探测全部候选源并按速度降序返回（失败/超时的排最后兜底）。
 * 测速结果通过 probeListener 结构化事件实时上报（逐源 candidate → 完成 done），
 * 渲染层据此渲染专门测速面板。
 */
export async function pickFastestUrls(
  candidates: ProbeCandidate[],
  _onMessage?: (msg: string) => void
): Promise<ProbeResult[]> {
  if (candidates.length <= 1) {
    return candidates.map((c) => ({ ...c, speedKBps: null }))
  }
  const results: ProbeResult[] = []
  await Promise.all(
    candidates.map(async (c) => {
      const speed = await probeSpeed(c.url)
      results.push({ ...c, speedKBps: speed })
      probeListener?.({ candidates: [...results], done: false })
    })
  )
  const sorted = [...results].sort((a, b) => (b.speedKBps ?? -1) - (a.speedKBps ?? -1))
  const chosen = sorted.find((c) => c.speedKBps && c.speedKBps > 0)

  // 兜底：如果最快的源速度低于阈值（如只有慢源通过代理测速成功，国内源全失败），
  // 视为测速无效，按原始候选顺序返回（候选顺序已按"国内主源优先"排好）
  const maxSpeed = sorted[0]?.speedKBps ?? 0
  const finalSorted = maxSpeed > 0 && maxSpeed < MIN_VALID_SPEED_KBPS
    ? results // 原始顺序（不做 sort）
    : sorted

  probeListener?.({ candidates: finalSorted, done: true, chosen: chosen?.label })
  return finalSorted
}
