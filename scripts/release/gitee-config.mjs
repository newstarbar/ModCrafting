import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(__dirname, '..', '..', 'packaging', 'gitee-config.json')

const FALLBACK = { owner: 'chenmo-starry-sky', repo: 'mod-crafting' }

function readFileConfig() {
  if (!existsSync(configPath)) return null
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (data?.owner && data?.repo) {
      return {
        owner: String(data.owner),
        repo: String(data.repo)
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Resolve Gitee main repo owner/repo（仅发布二进制 Setup/Portable/latest.yml/blockmap）。
 * 2026-08 重构：环境产物（seed/jre shards、extra-zips）已不再上传 Gitee，
 * 全部从 GitHub Release 下载并走 gh.xmly.dev 代理加速，故移除 envRepo 解析。
 *
 * Env vars override packaging/gitee-config.json, then fallback.
 */
export function resolveGiteeRepo() {
  const fromFile = readFileConfig()
  const owner = process.env.GITEE_OWNER?.trim() || fromFile?.owner || FALLBACK.owner
  const repo = process.env.GITEE_REPO?.trim() || fromFile?.repo || FALLBACK.repo
  const source = process.env.GITEE_OWNER?.trim()
    ? 'env'
    : fromFile
      ? 'packaging/gitee-config.json'
      : 'fallback'
  return { owner, repo, source }
}

/** Main repo URLs (Setup/Portable/latest.yml/blockmap). */
export function giteeUrls(owner, repo, tag, ver) {
  const base = `https://gitee.com/${owner}/${repo}`
  return {
    manifest: `${base}/releases/download/${tag}/latest.yml`,
    setup: `${base}/releases/download/${tag}/ModCrafting-Setup-${ver}.exe`,
    portable: `${base}/releases/download/${tag}/ModCrafting-${ver}-Portable.exe`,
    releasesPage: `${base}/releases`,
    manifestRaw: `${base}/raw/main/packaging/update-manifest.json`
  }
}
