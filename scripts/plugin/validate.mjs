import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const pluginRoot = resolve('plugins/modcrafting-fabric')
const fail = (message) => {
  console.error(`Plugin validation failed: ${message}`)
  process.exit(1)
}

for (const relativePath of ['.codex-plugin/plugin.json', '.mcp.json', 'dist/mcp-server.js']) {
  if (!existsSync(resolve(pluginRoot, relativePath))) fail(`missing ${relativePath}`)
}

let manifest
let mcpConfig
try {
  manifest = JSON.parse(readFileSync(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
  mcpConfig = JSON.parse(readFileSync(resolve(pluginRoot, '.mcp.json'), 'utf8'))
} catch (error) {
  fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
}

for (const field of ['name', 'version', 'description', 'license']) {
  if (typeof manifest[field] !== 'string' || !manifest[field].trim()) fail(`manifest.${field} must be a non-empty string`)
}
if (typeof manifest.author !== 'object' || typeof manifest.author?.name !== 'string' || !manifest.author.name.trim()) {
  fail('manifest.author.name must be a non-empty string')
}
if (manifest.name !== 'modcrafting-fabric') fail('manifest.name must be modcrafting-fabric')
if (manifest.license !== 'GPL-3.0') fail('manifest.license must be GPL-3.0')
if (manifest.skills !== './skills/') fail('manifest must reference ./skills/')
if (!manifest.mcpServers || typeof manifest.mcpServers !== 'string') fail('manifest must reference .mcp.json')

const skillsRoot = resolve(pluginRoot, 'skills')
const skillDirectories = readdirSync(skillsRoot).filter((entry) => statSync(resolve(skillsRoot, entry)).isDirectory())
for (const directory of skillDirectories) {
  const skillFile = resolve(skillsRoot, directory, 'SKILL.md')
  if (!existsSync(skillFile) || !readFileSync(skillFile, 'utf8').startsWith('---')) fail(`invalid skill ${directory}`)
}
if (!mcpConfig.mcpServers?.['modcrafting-fabric']) fail('MCP configuration must define modcrafting-fabric')

console.log('Plugin validation passed: modcrafting-fabric')
