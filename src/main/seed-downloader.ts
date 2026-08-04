/**
 * Seed Release 元数据。
 *
 * 2026-08 重构：JDK/JRE/Gradle/Fabric 依赖种子分片下载逻辑已移除，
 * 改为 toolchain-download.ts 走镜像直连（清华 TUNA + Adoptium API + 腾讯云 + 华为云），
 * ensurePortableGradleHome 走联网预热。
 *
 * 本模块仅保留 getSeedReleaseInfo()，供 knowledge-downloader.ts 拼接
 * 知识库辅助资源（agent-knowledge / fabric-symbol-index / base-mods）的下载 URL。
 */
import { wrapGithubProxy } from './github-mirror'

// Release tag hosting the extra resources (agent-knowledge / fabric-symbol-index / base-mods).
// Update when publishing a new seed version.
const SEED_RELEASE_TAG = 'v1.0.0'

// GitHub 不分仓（容量足够），始终指向主仓 newstarbar/ModCrafting
const GITHUB_RELEASE_BASE = `https://github.com/newstarbar/ModCrafting/releases/download/${SEED_RELEASE_TAG}/`
// gh.xmly.dev 代理加速基础 URL（包裹 GITHUB_RELEASE_BASE）
const GITHUB_PROXY_RELEASE_BASE = wrapGithubProxy(GITHUB_RELEASE_BASE)

/**
 * 返回 Release tag 与 GitHub base URL（含代理版本）。
 * 调用方（knowledge-downloader.ts）用这些 base 拼接辅助资源 URL。
 */
export function getSeedReleaseInfo(): { tag: string; githubBase: string; githubProxyBase: string } {
  return {
    tag: SEED_RELEASE_TAG,
    githubBase: GITHUB_RELEASE_BASE,
    githubProxyBase: GITHUB_PROXY_RELEASE_BASE
  }
}
