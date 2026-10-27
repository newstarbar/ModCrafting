import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createHash } from 'node:crypto'
import { writeHostConfig } from './host-config.mjs'

const distribution = path.resolve(process.argv[2] || '')
if (!process.argv[2]) throw Error('Usage: host:smoke PATH-TO-HOST-DISTRIBUTION. SDK/JSON/TOML config verification, not a native host acceptance test.')
const manifest = JSON.parse(await readFile(path.join(distribution, 'manifest.json'), 'utf8'))
assert.equal(manifest.hostManifestVersion, 1)
const scope = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-host-smoke-'))
const results = []
for (const host of ['codex', 'claude', 'qoder']) {
  const plugin = path.join(scope, host, 'plugin with spaces'), dataRoot = path.join(scope, host, 'data')
  await cp(path.join(distribution, manifest.plugins[host]), plugin, { recursive: true })
  const entry = path.join(plugin, 'dist/mcp-server.js')
  assert.equal(createHash('sha256').update(await readFile(entry)).digest('hex'), manifest.coreBundleSha256)
  const config = path.join(scope, host, host === 'codex' ? 'mcp.toml' : 'mcp.json')
  writeHostConfig({ host, pluginDirectory: plugin, dataRoot, node: process.execPath, web: true }, config)
  // Native Codex consumption is a separate acceptance test; its JSON-compatible quoted TOML fields are checked here.
  const contents = await readFile(config, 'utf8')
  const server = host === 'codex' ? {
    command: JSON.parse(contents.split('\n').find((row) => row.startsWith('command = ')).slice(10)),
    args: JSON.parse(contents.split('\n').find((row) => row.startsWith('args = ')).slice(7)),
    cwd: JSON.parse(contents.split('\n').find((row) => row.startsWith('cwd = ')).slice(6)),
    env: { MODCRAFTING_DATA: JSON.parse(contents.split('\n').find((row) => row.startsWith('MODCRAFTING_DATA = ')).slice(19)) }
  } : JSON.parse(contents).mcpServers['modcrafting-fabric']
  const guard = path.join(scope, host, 'isolated.mjs')
  await writeFile(guard, `import { registerHooks } from 'node:module';import { fileURLToPath } from 'node:url';registerHooks({resolve(s,c,n){const r=n(s,c);if(r.url.startsWith('file:')&&!fileURLToPath(r.url).startsWith(${JSON.stringify(plugin + path.sep)}))throw Error('MODULE_OUTSIDE_PACKAGE');return r}})`)
  const transport = new StdioClientTransport({ command: server.command, args: ['--import', pathToFileURL(guard).href, ...server.args], cwd: server.cwd, env: server.env, stderr: 'pipe' })
  transport.stderr.on('data', () => {})
  const client = new Client({ name: 'modcrafting-host-config-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } })
  client.onerror = () => {}
  const row = { host, nativeHostTest: false }
  try {
    await client.connect(transport)
    assert.equal((await client.listTools()).tools.length, 28); row.tools = 28
    const call = async (name, args = {}) => { const reply = await client.callTool({ name, arguments: args }); return reply.structuredContent || JSON.parse(reply.content.find((value) => value.type === 'text').text) }
    const environment = await call('modcrafting_environment_status')
    assert.equal(environment.paths.dataRoot, dataRoot); assert.ok(environment.browserUrl)
    assert.ok(environment.assets.filter(value => value.name !== 'base-mods').every((value) => value.status === 'missing'))
    const project = path.join(scope, host, 'project with spaces'); await mkdir(path.join(project, 'src/main/resources'), { recursive: true })
    await writeFile(path.join(project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ id: 'host_smoke', version: '1.0.0', depends: { minecraft: '1.21.4' } }))
    await writeFile(path.join(project, 'gradlew.bat'), '@echo off\r\nexit /b 99\r\n')
    await writeFile(path.join(project, 'gradle.properties'), 'minecraft_version=1.21.4\n')
    assert.equal((await call('fabric_project_inspect', { projectPath: project })).project.modId, 'host_smoke')
    assert.equal((await call('fabric_project_inspect', { projectPath: path.join(scope, 'missing') })).code, 'PROJECT_UNAVAILABLE')
    const session = await call('modcrafting_session', { action: 'create', name: `${host} config smoke`, projectPath: project })
    const sessionId = session.session.sessionId
    const workbench = await call('modcrafting_open_workbench', { sessionId, projectPath: project, open: false })
    const url = new URL(workbench.browserUrl), fragment = new URLSearchParams(url.hash.slice(1)), token = fragment.get('token')
    const headers = { authorization: `Bearer ${token}`, 'x-modcrafting-session': sessionId, 'x-modcrafting-backend': fragment.get('backendId') }
    const state = await (await fetch(url.origin + '/api/state', { headers })).json()
    assert.equal(state.contractVersion, 1); assert.equal(state.sessionId, sessionId); assert.deepEqual(state.jobs, [])
    assert.equal((await fetch(url.origin)).status, 200)
    await call('modcrafting_session', { action: 'end', sessionId })
    row.ok = true; row.browserFallback = true; row.isolatedModules = true
  } finally { await client.close() }
  results.push(row)
}
await writeFile(path.join(scope, 'summary.json'), JSON.stringify({ execution: 'SDK/config', results }, null, 2))
console.log(JSON.stringify({ ok: true, node: process.version, execution: 'SDK/config', scope, results }))
