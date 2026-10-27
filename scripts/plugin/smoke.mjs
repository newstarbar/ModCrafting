import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client, isJSONRPCRequest, isJSONRPCNotification, isJSONRPCResultResponse, isJSONRPCErrorResponse } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import Ajv from 'ajv/dist/2020.js'
import { validatePlugin } from './validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = path.resolve(process.argv[2] || path.join(root, 'temp/plugin-artifacts/modcrafting-fabric'))
validatePlugin(source, true)
// A sibling outside the repository has no ancestor node_modules. Retain only our own fixtures/evidence.
const scope = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-mcp-smoke-'))
const stage = path.join(scope, 'plugin')
await cp(source, stage, { recursive: true })
const { manifest, config } = validatePlugin(stage, true)
const serverConfig = config.mcpServers['modcrafting-fabric']
const entry = path.resolve(stage, serverConfig.cwd, serverConfig.args[0])
const guard = path.join(scope, 'isolate.mjs')
await writeFile(guard, `import { registerHooks } from 'node:module';\nimport { fileURLToPath } from 'node:url';\nimport path from 'node:path';\nconst allowed = ${JSON.stringify(stage + path.sep)};\nregisterHooks({ resolve(specifier, context, next) { const value = next(specifier, context); if (value.url.startsWith('file:') && !fileURLToPath(value.url).startsWith(allowed)) throw new Error('MODULE_OUTSIDE_STAGE'); return value; } });\n`)

async function bounded(work, label, timeout = 8000) {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`HARD_TIMEOUT: ${label}`)), timeout) })]) }
  finally { clearTimeout(timer) }
}

class AuditedTransport extends StdioClientTransport {
  wire = ''
  diagnostics = ''
  sent = []
  async start() {
    await super.start()
    // SDK does not expose raw stdout; this test-only hook audits its child pipe, never implements RPC.
    this.child = this._process
    this.exit = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })))
    this.child.stdout.on('data', (chunk) => { this.wire += chunk })
  }
  async send(message) { this.sent.push(message); return super.send(message) }
  audit() {
    for (const line of this.wire.trim().split('\n').filter(Boolean)) {
      const message = JSON.parse(line)
      assert.ok(isJSONRPCRequest(message) || isJSONRPCNotification(message) || isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message), 'stdout must contain only SDK-valid JSON-RPC')
    }
  }
}

async function session(env, use, args = ['--import', pathToFileURL(guard).href, entry]) {
  const transport = new AuditedTransport({ command: process.execPath, args, cwd: scope, env, stderr: 'pipe' })
  transport.stderr.on('data', (chunk) => { transport.diagnostics += chunk })
  const client = new Client({ name: 'modcrafting-protocol-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } })
  client.onerror = () => {} // Assertions report protocol failures without dumping request parameters.
  try {
    await bounded(client.connect(transport), 'initialize')
    return await use(client, transport)
  } catch (error) {
    if (transport.diagnostics.includes('INVALID_DATA_DIRECTORY')) error.message = 'INVALID_DATA_DIRECTORY: startup rejected'
    else if (transport.diagnostics) process.stderr.write(transport.diagnostics)
    throw error
  } finally {
    await bounded(client.close(), 'close', 5000).catch(() => { transport.child?.kill('SIGKILL') })
    if (transport.child && transport.child.exitCode === null && transport.child.signalCode === null) transport.child.kill('SIGKILL')
    if (transport.exit) await bounded(transport.exit, 'owned child exit', 3000)
    transport.audit()
  }
}

const data = path.join(scope, 'data')
const fixtures = path.join(scope, 'fixtures')
await mkdir(fixtures)
for (const valid of [true, false]) {
  const project = path.join(fixtures, valid ? 'valid' : 'invalid')
  await mkdir(path.join(project, 'src/main/resources'), { recursive: true })
  await writeFile(path.join(project, 'src/main/resources/fabric.mod.json'), valid ? JSON.stringify({ schemaVersion: 1, id: 'smoke_fixture', version: '0.0.0', environment: '*', depends: { minecraft: '~1.21.4' } }) : '{invalid JSON')
  await writeFile(path.join(project, 'gradlew.bat'), '@echo off\r\nexit /b 99\r\n') // Never executed: metadata only.
  await writeFile(path.join(project, 'gradle.properties'), 'minecraft_version=1.21.4\n')
}
const textureSource = path.join(fixtures, 'texture.png')
await writeFile(textureSource, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4XmP4z/D/PyV4OBowLeoEXoyuftSA4WkAqXgYGAAAJELrn3xHf+oAAAAASUVORK5CYII=', 'base64'))
const call = async (client, name, args = {}) => {
  const value = await bounded(client.callTool({ name, arguments: args }), `tools/call ${name}`)
  const decoded = value.structuredContent || JSON.parse(value.content.find((entry) => entry.type === 'text').text)
  return decoded
}
let toolCount = 0, sessionId
await session({ MODCRAFTING_DATA: data, PATH: fixtures }, async (client, transport) => {
  assert.equal(client.getServerVersion().version, manifest.version)
  assert.ok(transport.sent.some((message) => message.method === 'initialize'))
  assert.ok(transport.sent.some((message) => message.method === 'notifications/initialized'))
  const { tools } = await bounded(client.listTools(), 'tools/list')
  toolCount = tools.length
  const names = tools.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of ['modcrafting_session', 'modcrafting_test_profile', 'minecraft_test_template', 'modcrafting_environment_status', 'fabric_project_inspect', 'fabric_validate', 'fabric_recipe_workspace', 'fabric_content_workspace', 'fabric_texture_workspace', 'fabric_gui_workspace', 'minecraft_test_start', 'minecraft_test_status', 'minecraft_build_studio']) assert.ok(names.includes(name), `Missing ${name}`)
  const ajv = new Ajv({ strict: false, validateFormats: false })
  for (const tool of tools) assert.equal(ajv.validateSchema(tool.inputSchema), true, `Invalid schema: ${tool.name}`)
  assert.equal((await call(client, 'fabric_gui_workspace', { action: 'template', projectPath: path.join(fixtures, 'valid'), layoutType: 'hud-overlay' })).value.layoutType, 'hud-overlay');
  assert.deepEqual((await call(client, 'fabric_gui_workspace', { action: 'list', projectPath: path.join(fixtures, 'valid') })).documents, []);
  const content = await call(client, 'fabric_content_workspace', { action: 'list', projectPath: path.join(fixtures, 'valid') }); assert.ok(content.ok);
  const texture = await call(client, 'fabric_texture_workspace', { action: 'prompt', projectPath: path.join(fixtures, 'valid'), description: 'copper sword', itemId: 'smoke_fixture:copper_sword', size: 16 });
  assert.equal(texture.target.textureId, 'smoke_fixture:item/copper_sword');
  assert.match(texture.prompt, /16x16/);
  const importedTexture = await call(client, 'fabric_texture_workspace', { action: 'import', projectPath: path.join(fixtures, 'valid'), textureId: 'smoke_fixture:item/smoke_texture', sourcePath: textureSource, options: { size: 16, background: 'auto', trim: true, padding: 1, pixelize: false, paletteSize: 12, outline: 0 } });
  assert.ok(importedTexture.candidateId); assert.ok(importedTexture.image.startsWith('data:image/png;base64,'));
  const texturePreview = await call(client, 'fabric_texture_workspace', { action: 'preview', projectPath: path.join(fixtures, 'valid'), textureId: 'smoke_fixture:item/smoke_texture', pixelsBase64: importedTexture.pixels.base64, width: 16, height: 16, analyzeOnly: true });
  assert.match(texturePreview.previewRevision, /^[a-f0-9]{64}$/);
  const savedTexture = await call(client, 'fabric_texture_workspace', { action: 'save', projectPath: path.join(fixtures, 'valid'), textureId: 'smoke_fixture:item/smoke_texture', pixelsBase64: importedTexture.pixels.base64, width: 16, height: 16, expectedRevision: null, previewRevision: texturePreview.previewRevision });
  assert.equal(savedTexture.ok, true); assert.match(savedTexture.revision, /^[a-f0-9]{64}$/);
  assert.equal((await call(client, 'fabric_texture_workspace', { action: 'read', projectPath: path.join(fixtures, 'valid'), textureId: 'smoke_fixture:item/smoke_texture' })).exists, true);
  const environment = await call(client, 'modcrafting_environment_status')
  assert.equal(environment.platform, process.platform)
  assert.equal(environment.target.minecraft, '1.21.4')
  assert.equal(environment.java.ok, false)
  assert.ok(environment.remediation.length > 0)
  assert.equal(environment.contractVersion, 1)
  assert.equal(environment.assets.length, 5)
  assert.ok(environment.assets.filter(asset => asset.name !== 'base-mods').every((asset) => asset.status === 'missing'))
  assert.equal(environment.assets.find(asset => asset.name === 'base-mods').status, environment.observer.bundled ? 'present' : 'missing')
  assert.equal(environment.capabilities.toolchain.scaffoldIncludesWrapper, true)
  assert.equal(environment.capabilities.entityQuery.tagFilters, false)
  assert.equal(environment.capabilities.toolchain.automaticDownload, false)
  const newProject = path.join(scope, 'new-scaffold-with-wrapper')
  const created = await call(client, 'fabric_project_scaffold', { projectPath: newProject, modId: 'new_scaffold', modName: 'New Scaffold' })
  assert.equal(created.project.valid, true)
  sessionId = (await call(client, 'modcrafting_session', { action: 'create', name: 'MCP protocol smoke', projectPath: newProject })).session.sessionId
  const studio = await call(client, 'minecraft_build_studio', { action: 'status', sessionId })
  assert.equal(studio.ok, false)
  assert.ok(['INSTANCE_UNAVAILABLE', 'BUILDER_UNAVAILABLE'].includes(studio.code), `Unexpected studio status code: ${studio.code}`)
  assert.deepEqual((await call(client, 'fabric_recipe_workspace', { action: 'list', projectPath: newProject })).recipes, [])
  assert.equal((await readFile(path.join(newProject, 'gradle/wrapper/gradle-wrapper.jar'))).subarray(0, 2).toString(), 'PK')
  assert.match(await readFile(path.join(newProject, 'gradle/wrapper/gradle-wrapper.properties'), 'utf8'), /distributionSha256Sum=[a-f0-9]{64}/)
  for (const valid of [true, false]) {
    const projectPath = path.join(fixtures, valid ? 'valid' : 'invalid')
    const inspected = await call(client, 'fabric_project_inspect', { projectPath })
    assert.equal(inspected.project.valid, valid)
    const validation = await call(client, 'fabric_validate', { projectPath })
    assert.equal(validation.ok, valid)
  }
  const knowledge = await call(client, 'minecraft_data_lookup', { kind: 'item', query: 'stone' })
  assert.equal(knowledge.ok, false)
  assert.match(knowledge.error, /unavailable.*prepare_assets/)
  assert.deepEqual(await readdir(path.join(data, 'knowledge')), [])
  assert.deepEqual(await readdir(path.join(data, 'assets')), [])
  const gameSpec = { version: 2, id: 'smoke_game', featureType: 'new_item', subject: {}, setup: [], actions: [{ type: 'wait', ms: 0 }], assertions: [{ type: 'inventory_contains', itemId: 'minecraft:stone' }], cleanup: [] }
  const template = await call(client, 'minecraft_test_template', { featureType: 'new_item' })
  assert.equal(template.spec.version, 2); assert.equal(template.schema.required.includes('assertions'), true)
  const noGame = await call(client, 'minecraft_test_start', { sessionId, spec: gameSpec })
  assert.equal(noGame.code, 'ENVIRONMENT_UNAVAILABLE')
  assert.equal(noGame.verdict, 'INCONCLUSIVE')
  const missingJob = await call(client, 'minecraft_test_status', { sessionId, jobId: 'fixture-not-running' })
  assert.equal(missingJob.ok, false)
  assert.equal(missingJob.code, 'JOB_NOT_FOUND')
  await call(client, 'modcrafting_session', { action: 'end', sessionId })
  // Closing stdin must end the server without transport.close() killing it.
  transport.child.stdin.end()
  const exited = await bounded(transport.exit, 'stdin EOF exit', 2000)
  assert.equal(exited.code, 0)
})

// Both legacy data-directory aliases remain accepted.
for (const key of ['PLUGIN_DATA', 'CODEX_PLUGIN_DATA']) {
  await session({ [key]: path.join(scope, key) }, async (client) => { assert.equal((await client.listTools()).tools.length, toolCount) })
}
const invalidDirectory = path.join(scope, 'not-a-directory')
await writeFile(invalidDirectory, 'fixture blocks mkdir')
for (const value of ['', 'relative-directory', invalidDirectory]) {
  const started = Date.now()
  await assert.rejects(session({ MODCRAFTING_DATA: value }, async () => assert.fail('Invalid data must not initialize')), /INVALID_DATA_DIRECTORY/)
  assert.ok(Date.now() - started < 4000, 'invalid directory must fail promptly')
}
// A valid but unwritable Windows destination: the pipe/device namespace cannot hold persistent directories.
if (process.platform === 'win32') await assert.rejects(session({ MODCRAFTING_DATA: '\\\\.\\NUL\\modcrafting-fixture' }, async () => assert.fail('Unwritable directory initialized')), (error) => !String(error).includes('HARD_TIMEOUT'))
await session({ MODCRAFTING_DATA: path.join(scope, 'unexpected-exit') }, async (client, transport) => {
  transport.child.kill('SIGKILL')
  await bounded(transport.exit, 'unexpected server exit', 2000)
  await assert.rejects(bounded(client.listTools(), 'request after unexpected exit', 2000), (error) => !String(error).includes('HARD_TIMEOUT'))
})

const summary = { ok: true, node: process.version, toolCount, protocol: ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'], isolatedModules: true, missingJavaDiagnosed: true, realGame: 'not run', scope }
await writeFile(path.join(scope, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
