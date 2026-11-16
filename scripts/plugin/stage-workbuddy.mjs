#!/usr/bin/env node
/**
 * Build the WorkBuddy host package: one directory that is both a WorkBuddy plugin
 * (commands/agents/skills/hooks/.mcp.json) and an expert package (expertType: agent).
 *
 * Everything that already exists in the Fabric package is copied, never re-authored:
 * hooks, commands, agents and the WorkBuddy-only skill are the only hand-written parts.
 * `.mcp.json` and `plugin.json` are generated so a Fabric version bump cannot leave a
 * second hand-maintained version string behind.
 */
import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { validatePlugin } from './validate.mjs'
import { validateWorkbuddy } from './validate-workbuddy.mjs'
import { WORKBUDDY_SKILL_META, injectFrontmatter } from './skill-meta.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fabric = path.join(root, 'temp/plugin-artifacts/modcrafting-fabric')
const source = path.join(root, 'plugins/modcrafting-workbuddy')
const outputRoot = path.join(root, 'temp/plugin-artifacts')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function assertOrdinary(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), relative = `${prefix}${entry.name}`
    const stat = await lstat(file)
    if (stat.isSymbolicLink()) throw new Error(`WorkBuddy source must not contain links: ${relative}`)
    if (stat.isDirectory()) await assertOrdinary(file, `${relative}/`)
    else if (!stat.isFile()) throw new Error(`WorkBuddy source contains a special file: ${relative}`)
  }
}

export async function stageWorkbuddy(output = path.join(outputRoot, 'modcrafting-workbuddy')) {
  try { await lstat(fabric) } catch { throw new Error('WORKBUDDY_STAGE_MISSING_PLUGIN: run "pnpm run plugin:build && pnpm run plugin:stage" first') }
  const { manifest: identity } = validatePlugin(fabric, true)
  await assertOrdinary(source)
  const resolved = path.resolve(output)
  if (!resolved.startsWith(path.join(outputRoot) + path.sep)) throw new Error('WorkBuddy output must stay under temp/plugin-artifacts')
  await mkdir(outputRoot, { recursive: true })
  try { if ((await lstat(resolved)).isSymbolicLink()) throw new Error('WorkBuddy output must not be a junction/symlink') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await rm(resolved, { recursive: true, force: true })
  await mkdir(resolved, { recursive: true })

  // Reused artefacts: the bundle, its fingerprint, licences and the shared icon.
  for (const file of ['dist/mcp-server.js', 'compatibility.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'assets/modcrafting.png']) {
    await mkdir(path.dirname(path.join(resolved, file)), { recursive: true })
    await copyFile(path.join(fabric, file), path.join(resolved, file))
  }
  const compatibility = JSON.parse(await readFile(path.join(resolved, 'compatibility.json'), 'utf8'))
  if (sha256(await readFile(path.join(resolved, 'dist/mcp-server.js'))) !== compatibility.coreBundleSha256) throw new Error('Bundle fingerprint differs from compatibility.json; rebuild the plugin first')

  // Hand-written WorkBuddy parts.
  for (const directory of ['hooks', 'commands', 'agents', 'avatars']) await cp(path.join(source, directory), path.join(resolved, directory), { recursive: true })
  await copyFile(path.join(source, 'connector-meta.json'), path.join(resolved, 'connector-meta.json'))

  // Skills: shared bodies are copied verbatim, only missing frontmatter keys are appended.
  await mkdir(path.join(resolved, 'skills'), { recursive: true })
  for (const name of await readdir(path.join(fabric, 'skills'))) {
    const target = path.join(resolved, 'skills', name)
    await mkdir(target, { recursive: true })
    const markdown = await readFile(path.join(fabric, 'skills', name, 'SKILL.md'), 'utf8')
    const extra = WORKBUDDY_SKILL_META[name]
    await writeFile(path.join(target, 'SKILL.md'), extra ? injectFrontmatter(markdown, extra) : markdown)
  }
  await cp(path.join(source, 'skills/workbuddy-workflow'), path.join(resolved, 'skills/workbuddy-workflow'), { recursive: true })

  // Manifest: template + injected version/identity, so there is no fourth place to bump.
  const template = JSON.parse(await readFile(path.join(source, 'plugin.template.json'), 'utf8'))
  for (const key of ['author', 'homepage', 'repository', 'license']) {
    if (JSON.stringify(template[key]) !== JSON.stringify(identity[key])) throw new Error(`plugin.template.json ${key} drifted from the Fabric manifest`)
  }
  const manifest = { ...template, version: identity.version }
  await mkdir(path.join(resolved, '.codebuddy-plugin'), { recursive: true })
  await writeFile(path.join(resolved, '.codebuddy-plugin/plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // MCP config: `--web` enables the workbench, `--workbench=builtin` hands the URL to the host
  // browser, `--text=digest` keeps huge JSON out of the context window.
  const mcp = {
    mcpServers: {
      'modcrafting-fabric': {
        type: 'stdio',
        command: 'node',
        args: ['${CODEBUDDY_PLUGIN_ROOT}/dist/mcp-server.js', '--web', '--workbench=builtin', '--text=digest'],
        env: { MODCRAFTING_DATA: '${CODEBUDDY_PLUGIN_DATA}' }
      }
    }
  }
  await writeFile(path.join(resolved, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`)
  await copyFile(path.join(root, 'docs/workbuddy-integration.md'), path.join(resolved, 'README.md'))

  await validateWorkbuddy(resolved, true)
  return { directory: resolved, version: identity.version, coreBundleSha256: compatibility.coreBundleSha256 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) console.log('Usage: workbuddy:stage [--output DIR]. Produces a local WorkBuddy plugin/expert directory only; never installs or publishes.')
  else console.log(JSON.stringify({ ok: true, ...await stageWorkbuddy(values.output ? path.resolve(values.output) : undefined) }))
}
