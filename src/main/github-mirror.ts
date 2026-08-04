/**
 * GitHub 加速代理集中管理。
 *
 * 应用自身 Release 与知识库 Release 都托管在 GitHub，国内直连易超时。
 * 使用 `https://gh.xmly.dev/` 代理前缀包裹 GitHub 资源 URL 加速下载。
 *
 * 设计：集中常量 + 工具函数，便于后续替换加速方案。
 * 范围：仅包裹 `https://github.com/...` 与 `https://raw.githubusercontent.com/...`；
 * 清华 TUNA / 腾讯云 / 华为云等国内镜像无需代理。
 */

export const GITHUB_PROXY_PREFIX = 'https://gh.xmly.dev/'

/**
 * 给 https://github.com/... 或 https://raw.githubusercontent.com/... 添加 gh.xmly.dev 代理前缀。
 * 非 GitHub URL（如镜像源、api.github.com）原样返回，避免错误包裹。
 */
export function wrapGithubProxy(url: string): string {
  if (!url.startsWith('https://github.com/') && !url.startsWith('https://raw.githubusercontent.com/')) {
    return url
  }
  return GITHUB_PROXY_PREFIX + url
}

/**
 * 返回直连和代理两版本，用于 pickFastestUrls 测速选优。
 * 调用方构造候选源列表时，传入 direct 与 proxied 两项，由实测速度决定优先顺序。
 */
export function githubDirectAndProxy(url: string): { direct: string; proxied: string } {
  return { direct: url, proxied: wrapGithubProxy(url) }
}
