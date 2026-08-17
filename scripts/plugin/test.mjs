#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const server = path.join(root, 'plugins', 'modcrafting-fabric', 'dist', 'mcp-server.js')
if (!existsSync(server)) throw new Error('Plugin has not been built. Run npm run plugin:build first.')
const isolated = path.join(root, 'temp', 'plugin-isolation', 'modcrafting-fabric')
await rm(path.dirname(isolated), { recursive: true, force: true })
await cp(path.join(root, 'plugins', 'modcrafting-fabric'), isolated, { recursive: true, filter: (source) => !source.includes(`${path.sep}src${path.sep}`) && !source.includes(`${path.sep}scripts${path.sep}`) })
const result = spawnSync(process.execPath, [path.join(isolated, 'dist', 'mcp-server.js'), '--self-test'], { cwd: isolated, encoding: 'utf8' })
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status || 1) }
const output = JSON.parse(result.stdout.trim())
if (output.ok !== true || output.tools !== 19) throw new Error(`Plugin MCP self-test did not expose all tools: ${result.stdout}`)
console.log(JSON.stringify({ ok: true, isolated: true, ...output }))
