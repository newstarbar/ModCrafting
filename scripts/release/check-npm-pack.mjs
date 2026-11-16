#!/usr/bin/env node
/**
 * Gate for `npx github:` / `npm i modcrafting`: the published tarball must
 * contain the whole zero-dependency CLI and nothing private.
 *
 * A missing lib file is the failure mode that produces "CLI installed but
 * command not found at runtime", so it is checked explicitly instead of
 * trusting the `files` field alone.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cli = path.join(root, 'packages', 'modcrafting-cli')
const FORBIDDEN = [/^temp\//, /^node_modules\//, /^\.env/, /^Python\//, /^plugins\//, /^scripts\//, /^\.workbuddy\//, /^\.qoder\//, /^\.git/, /test_output\.txt$/, /^failures/, /^dist\//, /^out\//, /^resources\//, /^bridge-mod\//, /^builder-mod\//]
const MAX_BYTES = 3 * 1024 * 1024

export function checkPack({ quiet = false } = {}) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const raw = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 })
  const [report] = JSON.parse(raw)
  const files = report.files.map((entry) => entry.path.replace(/\\/g, '/'))
  const bytes = files.reduce((total, relative) => total + (report.files.find((entry) => entry.path.replace(/\\/g, '/') === relative)?.size ?? 0), 0)

  const required = ['package.json', 'README.md', 'LICENSE', 'PROMPT.md', 'docs/install.md', 'packages/modcrafting-cli/bin/modcrafting.mjs']
  for (const name of readdirSync(path.join(cli, 'lib'))) if (name.endsWith('.mjs')) required.push(`packages/modcrafting-cli/lib/${name}`)

  const problems = []
  for (const entry of required) if (!files.includes(entry)) problems.push(`缺少文件：${entry}`)
  for (const entry of files) {
    for (const pattern of FORBIDDEN) if (pattern.test(entry)) problems.push(`包含不应发布的文件：${entry}`)
  }
  if (bytes > MAX_BYTES) problems.push(`tarball 过大：${(bytes / 1024 / 1024).toFixed(2)}MB > 3MB`)

  const result = { ok: problems.length === 0, files: files.length, bytes, filename: report.filename, problems }
  if (!quiet) console.log(JSON.stringify(result, null, 2))
  if (!result.ok) {
    const error = new Error(`npm 打包检查失败：\n${problems.join('\n')}`)
    error.code = 'PACK_CHECK_FAILED'
    throw error
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { quiet: { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help) console.log('Usage: cli:pack:check [--quiet]. Runs npm pack --dry-run and asserts the CLI + docs are present and private folders are excluded.')
  else checkPack({ quiet: values.quiet })
}
