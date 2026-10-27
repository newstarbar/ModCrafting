import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, readFile, copyFile, writeFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { hashTree } from '../bench/bench-support.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({ options: { 'product-dir': { type: 'string' }, 'assets-data': { type: 'string' }, 'run-root': { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) { console.log('Usage: acceptance:first-use --product-dir COMPLETE-PRODUCT --assets-data PREPARED-DATA --run-root NEW-RUNS-ROOT. Requires JDK 21. Uses a truly empty game directory with no options.txt or saves; does not write game setup in the test harness, read model credentials, or publish.'); process.exit(0) }
for (const key of ['product-dir', 'assets-data', 'run-root']) if (!values[key] || !path.isAbsolute(values[key])) throw Error(`--${key} must be absolute`)
const product = values['product-dir'], assets = values['assets-data'], runRoot = values['run-root']
for (const input of [product, assets, runRoot]) {
  for (let current = input; ; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw Error('Input/output must not traverse a junction/symlink') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (path.dirname(current) === current) break
  }
}
for (const input of [product, assets]) {
  const relative = path.relative(input, runRoot)
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw Error('Run root must be outside every input')
}
const assetInput = path.join(assets, 'knowledge/minecraft-data')
const before = await Promise.all([product, assetInput].map(hashTree))
await mkdir(runRoot, { recursive: true }); const scope = await mkdtemp(path.join(runRoot, 'run-'))
const data = path.join(scope, 'data'), project = path.join(scope, 'project')
await mkdir(path.join(data, 'knowledge/minecraft-data/1.21.4'), { recursive: true })
await copyFile(path.join(assets, 'knowledge/minecraft-data/1.21.4/index.json'), path.join(data, 'knowledge/minecraft-data/1.21.4/index.json'))
const save = (name, value) => writeFile(path.join(scope, `${name}.json`), JSON.stringify(value, null, 2))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function poll(work, name, timeout = 300000) { const deadline = Date.now() + timeout; do { const value = await work(); if (value) return value; if (Date.now() >= deadline) { const final = await work(); if (final) return final; throw Error('TIMEOUT: ' + name) }; await sleep(300) } while (true) }
class Transport extends StdioClientTransport { async start() { await super.start(); this.child = this._process; this.exit = new Promise((resolve) => this.child.once('exit', resolve)) } }
const transport = new Transport({ command: process.execPath, args: [path.join(product, 'plugin/dist/mcp-server.js'), '--web'], cwd: product, env: { MODCRAFTING_DATA: data, JAVA_HOME: process.env.JAVA_HOME, GRADLE_USER_HOME: process.env.GRADLE_USER_HOME, PATH: process.env.PATH, TEMP: scope, TMP: scope }, stderr: 'pipe' }); transport.stderr.on('data', () => {})
const client = new Client({ name: 'modcrafting-cold-first-use', version: '1' }, { versionNegotiation: { mode: 'legacy' } }); client.onerror = () => {}
const trace = [], jobs = [], summary = { ok: false, scope, execution: 'live', gameDirectoryPreparedByProduct: true, cases: [] }
let sessionId
async function call(name, args = {}) { const response = await client.callTool({ name, arguments: args }, { timeout: 20000 }); const value = response.structuredContent || JSON.parse(response.content.find((part) => part.type === 'text').text); trace.push({ name, arguments: args, result: value }); return value }
async function settled(id) { return poll(async () => { const value = await call('fabric_job_status', { sessionId, jobId: id }); return value.status === 'completed' || value.status === 'failed' || value.status === 'stopped' || value.status === 'interrupted' ? value : undefined }, id) }
let instance
console.log(JSON.stringify({ step: 'cold-first-use-start', scope }))
try {
  await client.connect(transport); summary.serverPid = transport.child.pid
  assert.equal((await client.listTools()).tools.length, 28)
  sessionId = (await call('modcrafting_session', { action: 'create', name: '空目录首次启动' })).session.sessionId
  const environment = await call('modcrafting_environment_status'); assert.equal(environment.java.ok, true)
  assert.equal(environment.observer.bundled, true); summary.observer = environment.observer; summary.version = environment.version
  for (const [kind, query] of [['item', 'iron_ingot'], ['block', 'stone'], ['block', 'air']]) assert.equal((await call('minecraft_data_lookup', { kind, query })).ok, true)
  const created = await call('fabric_project_scaffold', { projectPath: project, modId: 'iron_ticket', modName: 'Iron Ticket' }); assert.equal(created.project.valid, true)
  await call('modcrafting_session', { action: 'update', sessionId, projectPath: project, phase: '正在准备工程', currentModule: 'build', recommendedModules: ['build'] })
  assert.equal((await call('fabric_project_inspect', { projectPath: project })).project.modId, 'iron_ticket')
  await cp(path.join(root, 'examples/iron-ticket/src'), path.join(project, 'src'), { recursive: true })
  assert.equal((await call('fabric_validate', { projectPath: project })).ok, true)
  const profile = await call('modcrafting_test_profile', { action: 'read', sessionId, projectPath: project })
  assert.equal(profile.profile.language, 'zh_cn'); assert.equal(profile.profile.map.terrain, 'flat'); summary.profile = profile.profile
  const spec = JSON.parse(await readFile(path.join(root, 'examples/iron-ticket/test-spec.json'), 'utf8'))
  const template = await call('minecraft_test_template', { featureType: 'player_interaction' }); assert.equal(template.spec.version, 2)
  const build = await call('fabric_build_start', { sessionId, projectPath: project, task: 'build' }); jobs.push(build.jobId)
  const built = await settled(build.jobId); await save('build', built); assert.equal(built.result?.exitCode, 0, JSON.stringify(built))
  console.log(JSON.stringify({ step: 'mod-built', scope }))
  const game = path.join(project, 'run', 'modcrafting-fabric', 'sessions', sessionId)
  assert.equal(await lstat(game).then(() => true, () => false), false, 'the game directory must not exist before product launch')
  instance = await call('minecraft_run_client', { sessionId, projectPath: project }); jobs.push(instance.jobId, instance.preparationJobId)
  const firstTest = await call('minecraft_test_start', { sessionId, instanceId: instance.instanceId, spec: { ...spec, id: 'cold_start_waits_for_world' } }); jobs.push(firstTest.jobId)
  const ready = await poll(async () => {
    const value = await call('minecraft_runtime_status', { sessionId, instanceId: instance.instanceId })
    if (value.job.status === 'failed' || value.job.error || value.preparation.phase === 'failed') throw Error(JSON.stringify(value))
    return value.canRunTests ? value : undefined
  }, 'automatic first-run and test-world readiness')
  summary.preparation = { bridgeReady: ready.bridgeReady, canRunTests: ready.canRunTests, phase: ready.preparation.phase }
  assert.equal(ready.canRunTests, true)
  const options = await readFile(path.join(game, 'options.txt'), 'utf8')
  assert.match(options, /lang:zh_cn/); assert.match(options, /overrideWidth:1280/); assert.match(options, /overrideHeight:720/); assert.match(options, /renderDistance:8/); assert.match(options, /maxFps:60/)
  const owner = JSON.parse(await readFile(path.join(game, 'saves', 'ModCrafting Test World', '.modcrafting-owner.json'), 'utf8'))
  assert.equal(owner.sessionId, sessionId); summary.emptyStartOptionsApplied = true; summary.sessionWorldOwner = owner.sessionId
  const first = await settled(firstTest.jobId); assert.equal(first.result?.verdict, 'PASS', JSON.stringify(first)); assert.equal(first.result?.cleanup.failed, false); summary.cases.push({ id: 'cold_start_waits_for_world', verdict: first.result.verdict, reportPath: first.result.reportPath })
  for (const [id, modify, verdict] of [
    ['no_use_control', value => { value.actions = [{ type: 'wait', ms: 500 }]; value.assertions = [value.assertions[0]] }, 'FAIL'],
    ['use_once', () => {}, 'PASS'],
    ['wrong_reward_expectation', value => { value.assertions[0].countAtLeast = 2 }, 'FAIL'],
    ['use_once_repeat', () => {}, 'PASS']
  ]) {
    const value = structuredClone(spec); value.id = 'first_use_' + id; modify(value)
    const started = await call('minecraft_test_start', { sessionId, instanceId: instance.instanceId, spec: value }); jobs.push(started.jobId)
    const job = await settled(started.jobId); await save(id, job); assert.equal(job.result.cleanup.failed, false)
    summary.cases.push({ id, verdict: job.result.verdict, expected: verdict, cleanup: job.result.cleanup, reportPath: job.result.reportPath }); console.log(JSON.stringify({ step: 'mod-case', id, verdict: job.result.verdict, expected: verdict }))
  }
  assert.ok(summary.cases.slice(1).every(value => value.verdict === value.expected), JSON.stringify(summary.cases))
  const workbench = await call('modcrafting_open_workbench', { sessionId, projectPath: project, open: false })
  const url = new URL(workbench.browserUrl), fragment = new URLSearchParams(url.hash.slice(1)), token = fragment.get('token'), backendId = fragment.get('backendId')
  const visible = await (await fetch(url.origin + '/api/state', { headers: { authorization: `Bearer ${token}`, 'x-modcrafting-session': sessionId, 'x-modcrafting-backend': backendId } })).json()
  assert.ok(visible.jobs.some(value => value.id === build.jobId)); assert.ok(visible.jobs.some(value => value.id === firstTest.jobId)); assert.equal(visible.sessionId, sessionId)
  const reportResponse = await fetch(`${url.origin}/api/report/${encodeURIComponent(firstTest.jobId)}`, { headers: { authorization: `Bearer ${token}`, 'x-modcrafting-session': sessionId, 'x-modcrafting-backend': backendId } })
  assert.equal(reportResponse.status, 200); assert.equal((await reportResponse.json()).sessionId, sessionId)
  await mkdir(path.join(scope, 'export')); const jar = path.join(scope, 'export/iron_ticket-0.1.0.jar'); await copyFile(path.join(project, 'build/libs/iron_ticket-0.1.0.jar'), jar)
  await copyFile(path.join(product, 'plugin/LICENSE'), path.join(scope, 'export/LICENSE'))
  summary.export = jar; summary.browserSessionIsolation = true; summary.reportSessionIsolation = true; summary.ok = true
} catch (error) { summary.error = String(error); throw error }
finally {
  for (const jobId of jobs) await call('fabric_job_stop', { sessionId, jobId }).catch(() => {})
  if (sessionId) await call('minecraft_stop_client', { sessionId }).catch(() => {})
  if (sessionId) { const ended = await call('modcrafting_session', { action: 'end', sessionId }).catch(() => undefined); summary.sessionEnded = ended?.session?.status === 'ended' }
  await client.close().catch(() => {}); summary.serverExit = await transport.exit
  await save('tool-trace', trace.map(row => ({ ...row, result: row.name === 'modcrafting_environment_status' ? { ...row.result, browserUrl: row.result.browserUrl ? new URL(row.result.browserUrl).origin : undefined } : row.result })))
  const after = await Promise.all([product, assetInput].map(hashTree)); summary.inputsUnchanged = after.every((value, index) => JSON.stringify(value) === JSON.stringify(before[index]))
  await save('acceptance', summary); console.log(JSON.stringify(summary))
}
