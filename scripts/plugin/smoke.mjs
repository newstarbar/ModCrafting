import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client, isJSONRPCRequest, isJSONRPCNotification, isJSONRPCResultResponse, isJSONRPCErrorResponse } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import Ajv from 'ajv/dist/2020.js'
import { validatePlugin } from './validate.mjs'
import { EXPECTED_TOOL_COUNT } from './tool-count.mjs'

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
// An explicitly broken JAVA_HOME stays an error even on machines with a discoverable JDK 21.
// Use a separate data root for toolchain configuration tests; this keeps startup deterministic.
await session({ MODCRAFTING_DATA: data, PATH: fixtures, JAVA_HOME: path.join(scope, 'missing-jdk'), MODCRAFTING_JAVA_HOME: '' }, async (client, transport) => {
  assert.equal(client.getServerVersion().version, manifest.version)
  assert.ok(transport.sent.some((message) => message.method === 'initialize'))
  assert.ok(transport.sent.some((message) => message.method === 'notifications/initialized'))
  const { tools } = await bounded(client.listTools(), 'tools/list')
  toolCount = tools.length
  // Drift gate: the packaged tool count and the source registration count must agree with the
  // shared constant, so host smoke tests can never silently validate a stale number again.
  assert.equal(toolCount, EXPECTED_TOOL_COUNT, 'tools/list count differs from scripts/plugin/tool-count.mjs')
  const serverSource = await readFile(path.join(root, 'plugins/modcrafting-fabric/src/mcp-server.ts'), 'utf8')
  assert.equal((serverSource.match(/\bserver\.registerTool\(/g) || []).length, EXPECTED_TOOL_COUNT, 'EXPECTED_TOOL_COUNT is stale; update scripts/plugin/tool-count.mjs')
  const names = tools.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of ['modcrafting_session', 'modcrafting_test_profile', 'minecraft_test_template', 'modcrafting_environment_status', 'modcrafting_toolchain', 'fabric_project_inspect', 'fabric_validate', 'fabric_recipe_workspace', 'fabric_content_workspace', 'fabric_texture_workspace', 'fabric_gui_workspace', 'fabric_voxel_workspace', 'minecraft_test_start', 'minecraft_test_status', 'minecraft_build_studio', 'minecraft_snapshot', 'minecraft_screenshot', 'minecraft_entity_query', 'minecraft_widgets', 'minecraft_entity_nbt', 'minecraft_log_read']) assert.ok(names.includes(name), `Missing ${name}`)
  const ajv = new Ajv({ strict: false, validateFormats: false })
  for (const tool of tools) assert.equal(ajv.validateSchema(tool.inputSchema), true, `Invalid schema: ${tool.name}`)
  // Every tool must carry a host-facing title and full hint set; hosts use these for approval,
  // parallelism and permission prompts, so a silent default is a bug rather than a fallback.
  for (const tool of tools) {
    assert.ok(typeof tool.title === 'string' && tool.title.length > 0, `Missing title: ${tool.name}`)
    assert.ok(tool.annotations, `Missing annotations: ${tool.name}`)
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof tool.annotations[hint], 'boolean', `annotations.${hint} must be boolean: ${tool.name}`)
  }
  assert.equal(tools.filter((tool) => tool.annotations.readOnlyHint).length, 16, 'read-only tool count changed; update src/output.ts deliberately')
  assert.deepEqual(tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name).sort(), ['fabric_job_stop', 'minecraft_build_studio', 'minecraft_command', 'minecraft_stop_client', 'minecraft_test_start'])
  // Inline cards: exactly the tools that render well as a read-only card declare a ui:// resource.
  assert.deepEqual(tools.filter((tool) => tool._meta?.ui?.resourceUri).map((tool) => tool.name).sort(), [
    'fabric_gui_texture_workspace', 'fabric_job_status', 'fabric_project_inspect', 'fabric_texture_workspace',
    'fabric_validate', 'minecraft_runtime_status', 'minecraft_screenshot', 'minecraft_test_status',
    'modcrafting_environment_status', 'modcrafting_session'
  ])
  const { resources } = await bounded(client.listResources(), 'resources/list')
  assert.equal(resources.length, 3, 'exactly three UI cards are expected')
  for (const resource of resources) {
    assert.match(resource.uri, /^ui:\/\/modcrafting\/[a-z]+\.html$/)
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app')
    const read = await bounded(client.readResource({ uri: resource.uri }), `resources/read ${resource.uri}`)
    const html = read.contents[0].text
    assert.ok(Buffer.byteLength(html) < 256 * 1024, 'the host stops inlining HTML above 256KB')
    assert.ok(html.includes('<div id="root">'), 'the card needs a mount point')
    assert.equal(/<script src=|<link\b|src="https?:|href="https?:/.test(html), false, 'cards must be self-contained: no external script, stylesheet or link')
  }
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
  assert.ok(environment.java.candidates.some((candidate) => candidate.source === 'java-home' && candidate.error), 'the broken JAVA_HOME must be diagnosed')
  assert.ok(environment.remediation.some((line) => line.includes('modcrafting_toolchain')), 'Java remediation must offer the no-restart toolchain switch')
  const toolchain = await call(client, 'modcrafting_toolchain', { action: 'read' })
  assert.equal(toolchain.java.ok, false)
  assert.ok(toolchain.java.configPath.endsWith('toolchain.json'))
  const coldDocs = await call(client, 'fabric_docs_search', { query: 'registry' })
  assert.equal(coldDocs.ok, false); assert.equal(coldDocs.code, 'ASSET_NOT_READY')
  assert.deepEqual(coldDocs.remediation.arguments.names, ['agent-knowledge'])
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
  const unsupported = await call(client, 'minecraft_test_start', { sessionId, spec: { ...gameSpec, id: 'unsupported_game', assertions: [{ type: 'hud_text', text: 'old' }] } })
  assert.equal(unsupported.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(unsupported.verdict, 'INCONCLUSIVE')
  const visual = await call(client, 'minecraft_test_start', { sessionId, spec: { ...gameSpec, id: 'visual_game', visualOnly: true } })
  assert.equal(visual.code, 'MANUAL_ACCEPTANCE_REQUIRED')
  const badToolchain = await call(client, 'modcrafting_toolchain', { action: 'write', javaHome: path.join(scope, 'missing-jdk') })
  assert.equal(badToolchain.code, 'JDK21_REQUIRED')
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

// `--text=digest` may only shrink the model-facing text; structuredContent stays complete.
await session({ MODCRAFTING_DATA: path.join(scope, 'digest') }, async (client) => {
  const reply = await client.callTool({ name: 'modcrafting_environment_status', arguments: {} })
  const text = reply.content.find((entry) => entry.type === 'text').text
  assert.ok(text.length <= 3200, `digest text must stay under 3.2KB, got ${text.length}`)
  assert.equal(reply.structuredContent.assets.length, 5, 'digest must not truncate structuredContent')
  assert.equal(reply.structuredContent.contractVersion, 1)
}, ['--import', pathToFileURL(guard).href, entry, '--text=digest'])

// `--web-only` has no MCP caller to pass a session in the fragment, so it must bootstrap one,
// otherwise the printed URL always fails with SESSION_REQUIRED on the first paint.
{
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [entry, '--web-only'], { cwd: scope, env: { ...process.env, MODCRAFTING_DATA: path.join(scope, 'web-only') }, stdio: ['ignore', 'ignore', 'pipe'] })
  const url = await bounded(new Promise((resolve, reject) => {
    let buffered = ''
    child.stderr.on('data', (chunk) => { buffered += chunk; const match = /ModCrafting browser: (\S+)/.exec(buffered); if (match) resolve(match[1]) })
    child.once('exit', (code) => reject(new Error(`--web-only exited early with ${code}`)))
  }), 'web-only bootstrap url', 8000)
  const fragment = new URLSearchParams(new URL(url).hash.slice(1))
  assert.match(fragment.get('sessionId') || '', /^[0-9a-f-]{36}$/i, '--web-only URL must carry a starter session')
  assert.match(fragment.get('backendId') || '', /^[0-9a-f-]{36}$/i, '--web-only URL must carry the backend id')
  child.kill('SIGTERM')
  await bounded(new Promise((resolve) => child.once('exit', resolve)), 'web-only shutdown', 5000)
}

// `--plan` is the automation entry point: one JSON line on stdout, a self-contained report, and a
// zero exit code for any completed plan. A missing plan must fail loudly instead.
{
  const { execFile } = await import('node:child_process')
  const planData = path.join(scope, 'plan-data')
  const runPlanFile = (file) => new Promise((resolve) => execFile(process.execPath, [entry, `--plan=${file}`], { cwd: scope, timeout: 60000, env: { ...process.env, MODCRAFTING_DATA: planData } }, (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout })))
  const planPath = path.join(scope, 'plan.json')
  await writeFile(planPath, JSON.stringify({ version: 1, name: 'smoke-plan', projectPath: path.join(fixtures, 'valid'), stopOnFailure: true, steps: [{ op: 'inspect' }, { op: 'validate' }] }))
  const run = await runPlanFile(planPath)
  assert.equal(run.code, 0, 'a completed plan must exit 0 even when a step is not PASS')
  const summary = JSON.parse(run.stdout)
  assert.equal(summary.ok, true)
  assert.equal(summary.verdict, 'PASS')
  assert.equal(summary.steps.length, 2)
  assert.equal(summary.archiveHint.tool, 'LibraryUpload')
  const html = await readFile(summary.reportPath, 'utf8')
  assert.ok(html.length < 200 * 1024, 'the report must stay small enough to archive')
  assert.equal(/<script\b|<link\b|https?:\/\//.test(html), false, 'the report must be self-contained')
  const broken = await runPlanFile(path.join(scope, 'missing-plan.json'))
  assert.notEqual(broken.code, 0, 'an unreadable plan must not look like a completed run')
}

const summary = { ok: true, node: process.version, toolCount, protocol: ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'], isolatedModules: true, missingJavaDiagnosed: true, toolAnnotations: toolCount, uiCards: 3, digest: true, webOnlyBootstrap: true, plan: 'PASS', realGame: 'not run', scope }
await writeFile(path.join(scope, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
