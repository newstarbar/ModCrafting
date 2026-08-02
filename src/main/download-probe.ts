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
/** 单源探测超时 */
const PROBE_TIMEOUT_MS = 6000

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

/** 探测单个下载源速度（KB/s），失败/超时返回 null；结果按 URL 缓存 */
export async function probeSpeed(url: string): Promise<number | null> {
  const cached = probeCache.get(url)
  if (cached !== undefined) return cached

  let speed: number | null = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const t0 = Date.now()
    const res = await getDownloadFetch()(url, {
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
    if (received > 0 && secs > 0) speed = Math.round(received / 1024 / secs)
  } catch {
    /* 探测失败 → null */
  } finally {
    clearTimeout(timer)
  }

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
  probeListener?.({ candidates: sorted, done: true, chosen: chosen?.label })
  return sorted
}
