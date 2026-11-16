#!/usr/bin/env node
/**
 * Publish the three tarballs, skipping versions that already exist so a re-run
 * of a release tag is idempotent. Requires NODE_AUTH_TOKEN (or NPM_TOKEN).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function npmRun(args, options = {}) {
  return execFileSync(npm, args, { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

export function publishNpm({ directory = path.join(root, 'temp/npm-artifacts'), dryRun = false, provenance = false } = {}) {
  const receiptFile = path.join(directory, 'receipt.json')
  if (!existsSync(receiptFile)) throw new Error(`缺少 ${receiptFile}；先运行 pnpm run release:npm`)
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
  const token = process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN
  if (!token && !dryRun) throw new Error('缺少 NODE_AUTH_TOKEN / NPM_TOKEN，拒绝发布')
  const published = []
  const skipped = []
  for (const item of receipt.packages) {
    let exists = false
    try {
      const value = npmRun(['view', `${item.name}@${receipt.version}`, 'version', '--json']).trim()
      exists = value.includes(receipt.version)
    } catch {
      exists = false
    }
    if (exists) {
      skipped.push({ name: item.name, version: receipt.version, reason: 'already published' })
      continue
    }
    if (dryRun) {
      published.push({ name: item.name, version: receipt.version, dryRun: true })
      continue
    }
    const args = ['publish', item.file, '--access', 'public']
    if (provenance) args.push('--provenance')
    const output = npmRun(args, { env: { ...process.env, NODE_AUTH_TOKEN: token } })
    published.push({ name: item.name, version: receipt.version, output: output.trim().split('\n').at(-1) })
  }
  return { ok: true, version: receipt.version, published, skipped }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, 'dry-run': { type: 'boolean' }, provenance: { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help) console.log('Usage: release:npm:publish [--directory DIR] [--dry-run] [--provenance]. Publishes existing tarballs; skips versions already on the registry.')
  else console.log(JSON.stringify(publishNpm({ directory: values.directory ? path.resolve(values.directory) : undefined, dryRun: Boolean(values['dry-run']), provenance: Boolean(values.provenance) }), null, 2))
}
