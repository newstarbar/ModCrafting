import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(__dirname, '..', '..', 'packaging', 'gitee-config.json')

const FALLBACK = { owner: 'chenmo-starry-sky', repo: 'mod-crafting' }
const FALLBACK_ENV = { owner: 'chenmo-starry-sky', repo: 'mod-crafting-env' }

function readFileConfig() {
  if (!existsSync(configPath)) return null
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (data?.owner && data?.repo) {
      return {
        owner: String(data.owner),
        repo: String(data.repo),
        envRepo: data.envRepo ? String(data.envRepo) : null
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Resolve Gitee main repo owner/repo (binary releases): env vars override packaging/gitee-config.json, then fallback. */
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

/**
 * Resolve Gitee env repo owner/repo (seed/jre shards + extra-zips).
 * Env repo shares the same owner as the main repo; only the repo name differs.
 * Env var GITEE_ENV_REPO overrides packaging/gitee-config.json `envRepo`, then fallback.
 */
export function resolveGiteeEnvRepo() {
  const fromFile = readFileConfig()
  const owner = process.env.GITEE_OWNER?.trim() || fromFile?.owner || FALLBACK_ENV.owner
  const repo = process.env.GITEE_ENV_REPO?.trim() || fromFile?.envRepo || FALLBACK_ENV.repo
  const source = process.env.GITEE_ENV_REPO?.trim()
    ? 'env'
    : fromFile?.envRepo
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

/**
 * Env repo URLs (seed/jre shards + extra-zips, all >100MB aggregated).
 * Returns the download base URL: https://gitee.com/<owner>/<envRepo>/releases/download/<tag>/
 */
export function giteeEnvUrls(owner, repo, tag) {
  const base = `https://gitee.com/${owner}/${repo}`
  return {
    releasesPage: `${base}/releases`,
    downloadBase: `${base}/releases/download/${tag}/`
  }
}
