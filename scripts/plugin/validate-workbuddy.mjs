/**
 * WorkBuddy package validation. Deliberately separate from validate.mjs: the Fabric package keeps
 * its own strict manifest shape (env-less MCP config, cwd-relative args) and must not be loosened
 * to accommodate a host with different conventions.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PERSONAL_PATH = /[A-Za-z]:[\\/](?:Users|project_file)\b|\/home\/[^/]+\//
const HOOK_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd', 'PreCompact', 'PostCompact'])
const HAN = /\p{Script=Han}/gu

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function pngSize(file) {
  const bytes = readFileSync(file)
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Avatar is not a PNG: ${file}`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length }
}

function frontmatter(file) {
  const markdown = readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown)
  if (!match) throw new Error(`Missing YAML frontmatter: ${file}`)
  const values = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair) values[pair[1]] = pair[2].trim()
  }
  return values
}

/** Every path declared as `./x` in the manifest must exist and stay inside the package. */
function assertDeclaredPaths(root, manifest) {
  const declared = []
  for (const key of ['skills', 'commands', 'hooks', 'avatar']) if (typeof manifest[key] === 'string') declared.push([key, manifest[key]])
  for (const key of ['agents']) if (Array.isArray(manifest[key])) for (const value of manifest[key]) declared.push([key, value])
  if (typeof manifest.mcpServers === 'string') declared.push(['mcpServers', manifest.mcpServers])
  for (const [key, value] of declared) {
    if (!value.startsWith('./')) throw new Error(`${key} must be a ./ relative path: ${value}`)
    const target = path.resolve(root, value)
    const relative = path.relative(root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${key} escapes the package: ${value}`)
    if (!existsSync(target)) throw new Error(`${key} points at a missing path: ${value}`)
  }
}

function assertHooks(root) {
  const file = path.join(root, 'hooks/hooks.json')
  const config = readJson(file)
  const keys = Object.keys(config)
  if (keys.length !== 1 || keys[0] !== 'hooks') throw new Error('hooks/hooks.json must contain only a top-level "hooks" key')
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (!HOOK_EVENTS.has(event)) throw new Error(`Unknown hook event: ${event}`)
    if (!Array.isArray(entries)) throw new Error(`hooks.${event} must be an array`)
    for (const entry of entries) {
      if (entry.matcher !== undefined && typeof entry.matcher !== 'string') throw new Error(`hooks.${event}.matcher must be a string`)
      if (!Array.isArray(entry.hooks) || !entry.hooks.length) throw new Error(`hooks.${event}.hooks must be a non-empty array`)
      for (const hook of entry.hooks) {
        if (hook.type !== 'command') throw new Error(`hooks.${event} may only use type "command" so behaviour is deterministic`)
        if (typeof hook.command !== 'string' || !hook.command.trim()) throw new Error(`hooks.${event} command must be a string`)
        if (!hook.command.includes('${CODEBUDDY_PLUGIN_ROOT}')) throw new Error(`hooks.${event} command must use \${CODEBUDDY_PLUGIN_ROOT}; market installs copy the package`)
        if (/[A-Za-z]:[\\/]/.test(hook.command)) throw new Error(`hooks.${event} command must not contain a drive-absolute path`)
        if (/\.\.[\\/]/.test(hook.command)) throw new Error(`hooks.${event} command must not traverse outside the package`)
        if (/\b(?:powershell|pwsh|cmd(?:\.exe)?\s+\/c)\b/i.test(hook.command)) throw new Error(`hooks.${event} must not depend on a Windows-only shell`)
      }
    }
  }
  // The referenced scripts must exist and stay small enough to load quickly.
  for (const name of readdirSync(path.join(root, 'hooks'))) {
    if (!name.endsWith('.mjs')) continue
    if (lstatSync(path.join(root, 'hooks', name)).size > 64 * 1024) throw new Error(`hooks/${name} exceeds the 64KB budget`)
  }
  for (const name of readdirSync(path.join(root, 'hooks/lib'))) {
    if (!name.endsWith('.mjs')) throw new Error(`Unexpected file in hooks/lib: ${name}`)
    if (lstatSync(path.join(root, 'hooks/lib', name)).size > 64 * 1024) throw new Error(`hooks/lib/${name} exceeds the 64KB budget`)
  }
}

function assertMcp(root) {
  const config = readJson(path.join(root, '.mcp.json'))
  const servers = Object.entries(config.mcpServers || {})
  if (servers.length !== 1) throw new Error('.mcp.json must declare exactly one server')
  const [name, server] = servers[0]
  if (name !== 'modcrafting-fabric') throw new Error('The MCP server must be named modcrafting-fabric')
  if (server.type !== 'stdio' || server.command !== 'node') throw new Error('.mcp.json must run the packaged bundle over stdio with node')
  if (!Array.isArray(server.args) || server.args[0] !== '${CODEBUDDY_PLUGIN_ROOT}/dist/mcp-server.js') throw new Error('.mcp.json args[0] must be the packaged bundle through ${CODEBUDDY_PLUGIN_ROOT}')
  for (const value of Object.values(server.env || {})) {
    if (typeof value !== 'string' || PERSONAL_PATH.test(value) || /[A-Za-z]:[\\/]/.test(value)) throw new Error('.mcp.json env must not contain a machine-absolute path')
  }
  if (!server.env?.MODCRAFTING_DATA) throw new Error('.mcp.json must point MODCRAFTING_DATA at the plugin data directory')
}

function assertSkills(root) {
  const directory = path.join(root, 'skills')
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name, 'SKILL.md')
    if (!existsSync(file)) throw new Error(`Missing SKILL.md for skill ${name}`)
    const values = frontmatter(file)
    if (!values.name || !values.description) throw new Error(`Skill ${name} needs name and description`)
    if (values.name !== name) throw new Error(`Skill ${name} declares a different name: ${values.name}`)
    const entries = readdirSync(path.join(directory, name))
    for (const entry of entries) if (entry !== 'SKILL.md' && entry !== 'references') throw new Error(`Unexpected entry in skills/${name}: ${entry}`)
  }
}

function assertCommands(root) {
  for (const name of readdirSync(path.join(root, 'commands'))) {
    if (!name.endsWith('.md')) throw new Error(`Unexpected file in commands: ${name}`)
    const values = frontmatter(path.join(root, 'commands', name))
    if (!values.description) throw new Error(`Command ${name} needs a description`)
  }
}

function assertContents(root) {
  const allowed = (relative) => relative === '.codebuddy-plugin/plugin.json' || relative === '.mcp.json' || relative === 'connector-meta.json'
    || relative === 'compatibility.json' || relative === 'LICENSE' || relative === 'THIRD_PARTY_NOTICES.txt' || relative === 'README.md'
    || relative === 'dist/mcp-server.js' || relative === 'assets/modcrafting.png' || relative === 'avatars/expert.png'
    || relative === 'hooks/hooks.json' || /^hooks\/[^/]+\.mjs$/.test(relative) || /^hooks\/lib\/[^/]+\.mjs$/.test(relative)
    || /^commands\/[^/]+\.md$/.test(relative) || /^agents\/[^/]+\.md$/.test(relative)
    || /^skills\/[^/]+\/SKILL\.md$/.test(relative) || /^skills\/[^/]+\/references\/[^/]+\.md$/.test(relative)
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory)) {
      const relative = `${prefix}${entry}`, file = path.join(directory, entry)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error(`Package contains a link: ${relative}`)
      if (stat.isDirectory()) walk(file, `${relative}/`)
      else if (!allowed(relative)) throw new Error(`Package contains an unexpected file: ${relative}`)
      else if (!relative.endsWith('.png') && PERSONAL_PATH.test(readFileSync(file, 'utf8'))) throw new Error(`Package contains a personal absolute path: ${relative}`)
    }
  }
  walk(root)
}

export function validateWorkbuddy(root, staged = false) {
  if (staged) {
    try { if (lstatSync(root).isSymbolicLink()) throw new Error('WorkBuddy package must not be a junction/symlink') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const manifest = readJson(path.join(root, '.codebuddy-plugin/plugin.json'))
  const compatibility = readJson(path.join(root, 'compatibility.json'))
  for (const key of ['name', 'version', 'description', 'expertType', 'agentName', 'categoryId', 'plugin']) {
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) throw new Error(`Invalid manifest.${key}`)
  }
  if (manifest.name !== 'modcrafting-workbuddy' || manifest.plugin !== manifest.name) throw new Error('Invalid plugin identity')
  if (manifest.license !== 'GPL-3.0' || !manifest.author?.name) throw new Error('Invalid licence/author')
  if (manifest.expertType !== 'agent') throw new Error('expertType must be "agent"')
  if (/\b__VERSION__\b/.test(manifest.version)) throw new Error('Manifest version placeholder was not replaced')
  if (manifest.version !== compatibility.version) throw new Error('Manifest version differs from compatibility.json')
  for (const key of ['displayName', 'profession', 'displayDescription', 'defaultInitPrompt']) {
    if (typeof manifest[key]?.en !== 'string' || typeof manifest[key]?.zh !== 'string') throw new Error(`manifest.${key} needs en and zh`)
  }
  const han = manifest.displayDescription.zh.match(HAN)?.length ?? 0
  if (han < 40 || han > 56) throw new Error(`displayDescription.zh should be 40-50 Chinese characters (marketplace rule), got ${han}`)
  if (!Array.isArray(manifest.tags) || manifest.tags.length !== 3) throw new Error('tags must contain exactly 3 entries')
  for (const tag of manifest.tags) if (typeof tag?.en !== 'string' || typeof tag?.zh !== 'string') throw new Error('every tag needs en and zh')
  if (!Array.isArray(manifest.quickPrompts) || manifest.quickPrompts.length !== 3) throw new Error('quickPrompts must contain exactly 3 entries')
  for (const prompt of manifest.quickPrompts) if (typeof prompt?.en !== 'string' || typeof prompt?.zh !== 'string') throw new Error('every quickPrompt needs en and zh')
  if (manifest.defaultInitPrompt.zh !== manifest.quickPrompts[0].zh) throw new Error('defaultInitPrompt.zh must match quickPrompts[0].zh')
  if (!Array.isArray(manifest.agents) || manifest.agents.length !== 1) throw new Error('agents must list exactly one agent file for this package')

  const avatar = pngSize(path.join(root, 'avatars/expert.png'))
  if (avatar.width !== 512 || avatar.height !== 512) throw new Error(`Avatar must be 512x512, got ${avatar.width}x${avatar.height}`)
  if (avatar.bytes > 500 * 1024) throw new Error('Avatar must stay under 500KB')

  assertDeclaredPaths(root, manifest)
  assertMcp(root)
  assertHooks(root)
  assertSkills(root)
  assertCommands(root)
  const agent = frontmatter(path.join(root, 'agents', `${manifest.agentName}.md`))
  if (!agent.description) throw new Error('Agent definition needs a description')
  if (staged) assertContents(root)
  return { manifest, compatibility }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.resolve(process.argv[2] || 'temp/plugin-artifacts/modcrafting-workbuddy')
  validateWorkbuddy(target, true)
  console.log('WorkBuddy package validation passed: modcrafting-workbuddy')
}
