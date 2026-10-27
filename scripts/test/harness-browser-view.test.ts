import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fixtureObserver } from './fixtures/observer.ts'
import { FabricRuntime, createRuntimePaths, encodePng, FABRIC_TARGET, GAME_TEST_WORLD, validateGameTestSpec, type GameTestSpec, type JobSnapshot } from '../../packages/modcrafting-core/src/index.ts'
import { startBrowserView } from '../../plugins/modcrafting-fabric/src/browser-server.ts'

const assets = { html: '<!doctype html><title>fixture view</title>', js: '/* fixture */', css: 'body{color:white}' }
async function fixture(t: { after: (work: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-view-'))
  const project = path.join(root, 'project'); await mkdir(project)
  const children: Promise<void>[] = []
  const runtime = new FabricRuntime({ paths: createRuntimePaths(path.join(root, 'data')), version: 'browser-fixture', observer: fixtureObserver, toolchain: {
    status: async () => ({ ok: true, platform: process.platform, node: process.version, java: { ok: true }, gradleWrapper: true, target: FABRIC_TARGET, remediation: [] }),
    startGradle: async (_, task, events) => {
      const child = spawn(process.execPath, ['-e', task === 'runClient' ? 'setInterval(()=>{},1000)' : "console.log('VIEW_FIXTURE_BUILD');setTimeout(()=>process.exit(0),300)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (part) => events?.onLog?.('fixture', String(part)))
      children.push(new Promise((resolve) => child.once('close', () => resolve())))
      return child
    }
  } })
  const sessionId = runtime.createSession({ name: 'browser fixture', projectPath: project }).sessionId
  const view = await startBrowserView(runtime, assets)
  t.after(async () => { runtime.close(); await Promise.all(children); await view.close() })
  const url = new URL(view.url), token = new URLSearchParams(url.hash.slice(1)).get('token')!
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-modcrafting-session': sessionId, 'x-modcrafting-backend': runtime.backendId }
  const call = async (body: unknown) => (await fetch(url.origin + '/api/action', { method: 'POST', headers, body: JSON.stringify(body) })).json()
  const state = async () => (await fetch(url.origin + '/api/state', { headers })).json()
  return { root, project, runtime, sessionId, url, headers, view, call, state }
}
async function settled(runtime: FabricRuntime, id: string, sessionId: string): Promise<JobSnapshot> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { const job = runtime.jobStatus(id, sessionId); assert.ok('status' in job); if (job.result || job.error) return job; await new Promise((resolve) => setTimeout(resolve, 15)) }
  throw Error('Fixture job did not settle')
}
test('Browser view uses loopback, authenticates APIs and rejects cross-site/rebinding requests', async (t) => {
  const f = await fixture(t)
  const page = await fetch(f.url.origin)
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal((await fetch(f.url.origin + '/api/state')).status, 401)
  assert.equal((await fetch(f.url.origin + '/api/state', { headers: { ...f.headers, origin: 'https://outside.example' } })).status, 403)
  assert.equal((await fetch(f.url.origin + '/api/state', { headers: { ...f.headers, 'sec-fetch-site': 'cross-site' } })).status, 403)
  const rebinding = await new Promise<number>((resolve, reject) => { const request = httpRequest(f.url.origin + '/api/state', { headers: { ...f.headers, host: 'outside.example' } }, (reply) => { reply.resume(); resolve(reply.statusCode!) }); request.once('error', reject); request.end() })
  assert.equal(rebinding, 403)
  assert.equal((await fetch(f.url.origin + '/api/action', { method: 'POST', headers: f.headers, body: '{' })).status, 400)
  assert.equal((await fetch(f.url.origin + '/api/action', { method: 'POST', headers: f.headers, body: 'x'.repeat(256 * 1024 + 1) })).status, 413)
  assert.equal((await f.call({ operation: 'command', command: 'unsafe' })).code, 'INVALID_ARGUMENT')
  assert.equal((await f.call({ operation: 'build', projectPath: f.project, task: 'build & anything' })).code, 'INVALID_ARGUMENT')
  assert.equal((await f.call({ operation: 'project', projectPath: path.join(f.root, 'missing') })).code, 'PROJECT_UNAVAILABLE')
  assert.equal((await f.state()).jobs.length, 0)
})
test('Browser and Core share jobs in both directions; closing view leaves a running build intact', async (t) => {
  const f = await fixture(t), first = f.runtime.startBuild(f.project, 'build', f.sessionId)
  assert.equal((await f.state()).jobs[0].id, first.jobId)
  assert.equal((await f.call({ operation: 'stop', jobId: first.jobId })).ok, true)
  assert.equal((await settled(f.runtime, first.jobId, f.sessionId)).status, 'stopped')
  const second = await f.call({ operation: 'build', projectPath: f.project })
  assert.equal(f.runtime.state(f.sessionId).jobs.at(-1)?.id, second.jobId)
  await f.view.close()
  assert.equal((await settled(f.runtime, second.jobId, f.sessionId)).status, 'completed')
  assert.equal((f.runtime.jobStatus(second.jobId, f.sessionId) as JobSnapshot).result?.exitCode, 0)
})
test('Task sessions keep builds and job controls separate even when they share one project', async (t) => {
  const f = await fixture(t)
  const other = f.runtime.createSession({ name: 'second task', projectPath: f.project })
  const first = f.runtime.startBuild(f.project, 'build', f.sessionId)
  const second = f.runtime.startBuild(f.project, 'build', other.sessionId)
  assert.equal((await settled(f.runtime, first.jobId, f.sessionId)).status, 'completed')
  assert.equal((await settled(f.runtime, second.jobId, other.sessionId)).status, 'completed')
  assert.ok(f.runtime.state(f.sessionId).jobs.some((job) => job.id === first.jobId))
  assert.ok(!f.runtime.state(f.sessionId).jobs.some((job) => job.id === second.jobId))
  assert.equal((f.runtime.jobStatus(first.jobId, other.sessionId) as { code: string }).code, 'JOB_NOT_OWNED')
  assert.throws(() => f.runtime.stopJob(first.jobId, other.sessionId), { code: 'JOB_NOT_OWNED' })
  assert.ok(f.runtime.state(other.sessionId).jobs.some((job) => job.id === second.jobId))
  f.runtime.endSession(other.sessionId)
  assert.ok(f.runtime.state(other.sessionId).jobs.some((job) => job.id === second.jobId), 'ended sessions remain readable for history')
  assert.equal((f.runtime.jobStatus(second.jobId, other.sessionId) as JobSnapshot).status, 'completed')
  assert.throws(() => f.runtime.startBuild(f.project, 'build', other.sessionId), { code: 'SESSION_ENDED' })
  const selected = await f.call({ operation: 'select_session', sessionId: other.sessionId })
  assert.equal(selected.readOnly, true)
  const archivedHeaders = { ...f.headers, 'x-modcrafting-session': other.sessionId }
  const archivedState = await (await fetch(f.url.origin + '/api/state', { headers: archivedHeaders })).json()
  assert.ok(archivedState.jobs.some((job: JobSnapshot) => job.id === second.jobId))
})
test('Browser exposes real Core verdicts/reports and bridge images; no arbitrary report/file read', async (t) => {
  const f = await fixture(t)
  await mkdir(path.join(f.runtime.paths.assetsRoot, 'base-mods'), { recursive: true })
  await writeFile(path.join(f.runtime.paths.assetsRoot, 'base-mods/modcrafting-observer.jar'), 'Fixture only')
  const client = f.runtime.runClient(f.project, undefined, f.sessionId)
  const gameDir = client.gameDirectory
  let sequence = 0
  const observer = createServer((req, res) => {
    req.resume(); res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/v2/capabilities' ? { ok: true, protocolVersion: 2 }
      : req.url === '/v2/test-preparation' ? { ok: true, phase: 'test_ready', ready: true, failed: false, screen: { simpleName: 'TitleScreen' } }
      : req.url === '/v1/screenshot' ? { ok: true, base64: 'aGVsbG8=', path: 'do-not-read-this-file' }
      : { ok: true, worldName: GAME_TEST_WORLD, requestId: `fixture_${++sequence}`, observedAt: Date.now(), player: { health: 20 } }))
  })
  await new Promise<void>((resolve) => observer.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => observer.close(() => resolve())))
  await writeFile(path.join(gameDir, 'modcrafting-bridge.json'), JSON.stringify({ port: (observer.address() as { port: number }).port, token: 'fixture-token' }))
  const instanceId = client.instanceId
  assert.equal((await f.call({ operation: 'runtime', instanceId })).bridgeReady, true)
  assert.equal((await f.call({ operation: 'snapshot', instanceId })).data.worldName, GAME_TEST_WORLD)
  assert.equal((await f.call({ operation: 'screenshot', instanceId })).image, 'data:image/png;base64,aGVsbG8=')
  let successfulJobId = ''
  for (const [id, assertion, verdict] of [
    ['view-pass', { type: 'snapshot_value', source: 'player', pointer: '/health', equals: 20 }, 'PASS'],
    ['view-fail', { type: 'snapshot_value', source: 'player', pointer: '/health', equals: -1 }, 'FAIL'],
    ['view-unsupported', { type: 'hud_text', text: 'unknown' }, 'INCONCLUSIVE']
  ] as const) {
    const spec: GameTestSpec = { version: 2, id, featureType: 'player_interaction', subject: {}, setup: [], actions: [{ type: 'wait', ms: 10 }], assertions: [assertion], cleanup: [] }
    assert.equal(validateGameTestSpec(spec).ok, true)
    const started = await f.call({ operation: 'test', instanceId, spec })
    const job = await settled(f.runtime, started.jobId, f.sessionId)
    assert.equal(job.result?.verdict, verdict)
    if (verdict === 'PASS') successfulJobId = started.jobId
    const report = await (await fetch(f.url.origin + '/api/report/' + started.jobId, { headers: f.headers })).json()
    assert.equal(report.verdict, verdict); assert.equal(report.instanceId, instanceId)
    assert.equal((await f.state()).jobs.find((value: JobSnapshot) => value.id === job.id).result.verdict, verdict)
    job.result!.reportPath = path.join(f.root, 'private.json'); await writeFile(job.result!.reportPath as string, '{}')
    const protectedReport = await (await fetch(f.url.origin + '/api/report/' + started.jobId, { headers: f.headers })).json()
    assert.equal(protectedReport.verdict, verdict, 'mutating a returned job snapshot cannot redirect report reads')
  }
  assert.equal((await f.call({ operation: 'test', instanceId, spec: {} })).code, 'INVALID_ARGUMENT')
  assert.equal((await f.call({ operation: 'stop', jobId: 'not-owned' })).code, 'JOB_NOT_FOUND')
  await f.call({ operation: 'stop', jobId: client.jobId }); await settled(f.runtime, client.jobId, f.sessionId)
  f.runtime.endSession(f.sessionId)
  const archived = await (await fetch(f.url.origin + '/api/report/' + successfulJobId, { headers: f.headers })).json()
  assert.equal(archived.verdict, 'PASS', `historical reports remain readable after a session ends: ${JSON.stringify(archived)}`)
  assert.equal((await f.state()).sessionId, f.sessionId)
  assert.equal((await f.state()).sessions.find((value: { sessionId: string }) => value.sessionId === f.sessionId).status, 'ended')
  assert.equal((await f.call({ operation: 'build', projectPath: f.project, task: 'build' })).code, 'SESSION_ENDED')
})


test('Browser texture batches require authentication, a supported project, and bounded IDs', async (t) => {
  const f = await fixture(t)
  await mkdir(path.join(f.project, 'src/main/resources'), { recursive: true })
  await writeFile(path.join(f.project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'visual_test', version: '1' }))
  await writeFile(path.join(f.project, 'gradle.properties'), 'minecraft_version=1.21.4\n')
  await writeFile(path.join(f.project, 'gradlew.bat'), '@echo fixture')
  const cache = path.join(f.runtime.paths.assetsRoot, 'minecraft-textures/1.21.4')
  await mkdir(path.join(cache, 'assets/minecraft/textures/item'), { recursive: true })
  await writeFile(path.join(cache, '.visuals-ready.json'), JSON.stringify({ version: '1.21.4' }))
  await writeFile(path.join(cache, 'assets/minecraft/textures/item/apple.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  const batch = { operation: 'visuals', projectPath: f.project, itemIds: ['minecraft:apple'], textureIds: ['minecraft:item/apple', 'minecraft:../secret'] }
  const result = await f.call(batch)
  assert.equal(result.ok, true); assert.equal(result.ready, true); assert.ok(result.items['minecraft:apple'].startsWith('data:image/png;base64,')); assert.equal(result.textures['minecraft:../secret'], null)
  assert.equal((await f.call({ ...batch, itemIds: Array(81).fill('minecraft:apple') })).code, 'INVALID_ARGUMENT')
  assert.equal((await fetch(f.url.origin + '/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) })).status, 401)
})

test('Browser texture upload, import, preview and save share authentication and revision checks', async (t) => {
  const f = await fixture(t)
  await mkdir(path.join(f.project, 'src/main/resources'), { recursive: true })
  await writeFile(path.join(f.project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'texture_view', version: '1', depends: { minecraft: '1.21.4' }, entrypoints: { main: [] } }))
  await writeFile(path.join(f.project, 'gradlew.bat'), '@echo fixture'); await writeFile(path.join(f.project, 'gradle.properties'), 'minecraft_version=1.21.4\n')
  const source = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const index = (y * 64 + x) * 4, inside = Math.abs(x - 32) + Math.abs(y - 32) < 22
    source.data[index] = inside ? 120 : 255; source.data[index + 1] = inside ? 70 : 0; source.data[index + 2] = inside ? 180 : 255; source.data[index + 3] = 255
  }
  const png = Buffer.from(encodePng(source))
  const unauthenticated = await fetch(f.url.origin + '/api/texture-source', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })
  assert.equal(unauthenticated.status, 401)
  const upload = await fetch(f.url.origin + '/api/texture-source', { method: 'POST', headers: { ...f.headers, 'content-type': 'image/png' }, body: png })
  const uploaded = await upload.json() as { sourceToken: string }
  assert.equal(upload.status, 200); assert.match(uploaded.sourceToken, /^[a-f0-9-]{36}\.png$/i)
  const invalid = await fetch(f.url.origin + '/api/texture-source', { method: 'POST', headers: { ...f.headers, 'content-type': 'image/png' }, body: 'not png' })
  assert.equal(invalid.status, 400)
  const tooLarge = await fetch(f.url.origin + '/api/texture-source', { method: 'POST', headers: { ...f.headers, 'content-type': 'image/png' }, body: 'x'.repeat(8 * 1024 * 1024 + 1) })
  assert.equal(tooLarge.status, 413)
  const imported = await f.call({ operation: 'texture', request: { action: 'import', projectPath: f.project, textureId: 'texture_view:item/test', sourceToken: uploaded.sourceToken, options: { size: 16, background: 'auto', trim: true, pixelize: true, paletteSize: 12, outline: 1 } } })
  assert.equal(imported.ok, true); assert.ok(imported.image.startsWith('data:image/png;base64,')); assert.ok(imported.candidateId)
  const preview = await f.call({ operation: 'texture', request: { action: 'preview', projectPath: f.project, textureId: 'texture_view:item/test', pixelsBase64: imported.pixels.base64, width: 16, height: 16, analyzeOnly: true } })
  assert.equal(preview.ok, true); assert.match(preview.previewRevision, /^[a-f0-9]{64}$/)
  const saved = await f.call({ operation: 'texture', request: { action: 'save', projectPath: f.project, textureId: 'texture_view:item/test', pixelsBase64: imported.pixels.base64, width: 16, height: 16, expectedRevision: null, previewRevision: preview.previewRevision } })
  assert.equal(saved.ok, true); assert.match(saved.revision, /^[a-f0-9]{64}$/)
  assert.equal(existsSync(path.join(f.project, 'src/main/resources/assets/texture_view/textures/item/test.png')), true)
})
