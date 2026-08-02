/**
 * 统一下载 User-Agent。
 *
 * 部分国内镜像 / Gitee 对非浏览器 UA 的下载请求会降速或返回异常：
 * - 华为云 Adoptium 镜像实测：无 UA（undici 默认 `node`）返回 200 但 body 为空且无
 *   Content-Length，下载挂起；带浏览器 UA 后首个 chunk 正常返回。
 * - Gitee Releases 附件实测：浏览器约 2MB/s，而应用内（undici 默认 UA）约 100KB/s，
 *   疑似按 UA 限速。
 * 因此所有下载请求（下载流、HEAD 探测、Release API）统一携带浏览器 UA。
 */
export const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** 下载用 fetch 实现签名（兼容 Node 全局 fetch 与 Electron net.fetch） */
export type DownloadFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

let fetchImpl: DownloadFetchLike = (input, init) => globalThis.fetch(input as RequestInfo | URL, init)

/** 当前下载 fetch 实现（默认 Node 全局 fetch / undici） */
export function getDownloadFetch(): DownloadFetchLike {
  return fetchImpl
}

/**
 * 主进程启动时调用：切换到 Electron net.fetch（Chromium 网络栈）。
 *
 * Gitee 等下载源按客户端 TLS/请求指纹限速（非 UA、非 HTTP 版本、非匿名）：
 * - undici（Node/OpenSSL 指纹）实测仅 ~60KB/s
 * - curl 实测 ~2.7MB/s
 * - Electron net.fetch（Chromium 指纹，与 Chrome 浏览器一致）实测 ~44MB/s
 * 切换到 Chromium 栈后，下载速度与浏览器一致，并自动获得 HTTP/2 与系统代理支持。
 */
export async function enableElectronNetFetch(): Promise<void> {
  try {
    // 动态 import：避免纯 Node 上下文（CLI 测试/编译）顶层依赖 electron
    const { net } = await import('electron')
    if (typeof net?.fetch === 'function') {
      fetchImpl = (async (input, init) => {
        try {
          return await net.fetch(input as string, init as never)
        } catch (err) {
          // net.fetch（Chromium 栈，走系统代理）失败时回退 Node 全局 fetch（undici，不走系统代理）。
          // 覆盖场景：用户配置了系统代理但代理软件未运行/失效 → Chromium 栈连接失败，
          // undici 直连可正常下载；AbortError（首字节超时）不回退——网络确实慢/挂起，undici 同样
          if (err instanceof Error && err.name === 'AbortError') throw err
          console.warn(`[download] net.fetch 失败，回退 Node fetch: ${String(err).slice(0, 160)}`)
          return globalThis.fetch(input as RequestInfo | URL, init)
        }
      }) as DownloadFetchLike
      console.log('[download] 已切换到 Electron net.fetch（Chromium 网络栈，失败自动回退 Node fetch）')
      return
    }
  } catch {
    /* 非 Electron 环境 */
  }
  console.warn('[download] Electron net.fetch 不可用，保持 Node fetch')
}

/** 测试/特殊场景注入自定义 fetch 实现 */
export function setDownloadFetchImpl(impl: DownloadFetchLike): void {
  fetchImpl = impl
}
