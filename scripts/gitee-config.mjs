import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(__dirname, '..', 'build', 'gitee-config.json')

const FALLBACK = { owner: 'newstarbar', repo: 'ModCrafting' }

function readFileConfig() {
  if (!existsSync(configPath)) return null
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (data?.owner && data?.repo) return { owner: String(data.owner), repo: String(data.repo) }
  } catch {
    /* ignore */
  }
  return null
}

/** Resolve Gitee owner/repo: env vars override build/gitee-config.json, then fallback. */
export function resolveGiteeRepo() {
  const fromFile = readFileConfig()
  const owner = process.env.GITEE_OWNER?.trim() || fromFile?.owner || FALLBACK.owner
  const repo = process.env.GITEE_REPO?.trim() || fromFile?.repo || FALLBACK.repo
  const source = process.env.GITEE_OWNER?.trim()
    ? 'env'
    : fromFile
      ? 'build/gitee-config.json'
      : 'fallback'
  return { owner, repo, source }
}

export function giteeUrls(owner, repo, tag, ver) {
  const base = `https://gitee.com/${owner}/${repo}`
  return {
    manifest: `${base}/releases/download/${tag}/latest.yml`,
    setup: `${base}/releases/download/${tag}/ModCrafting%20Setup%20${ver}.exe`,
    portable: `${base}/releases/download/${tag}/ModCrafting%20${ver}%20Portable.exe`,
    releasesPage: `${base}/releases`,
    manifestRaw: `${base}/raw/main/build/update-manifest.json`
  }
}
