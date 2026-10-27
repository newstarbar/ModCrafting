import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixtureObserver } from './fixtures/observer.ts'
import { FabricRuntime, CoreError, createRuntimePaths, localAssetStatus, lookupMinecraftData, projectRuntimePaths, searchFabricDocs, FABRIC_TARGET, GAME_TEST_WORLD, DEFAULT_TEST_PROFILE, type TestProfile, type GameTestSpec, type JobSnapshot } from '../../packages/modcrafting-core/src/index.ts'

async function fixture(t: { after: (work: () => Promise<void>) => void }, withMods = false, clientExit?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-core-runtime-'))
  const project = path.join(root, 'project with spaces'); await mkdir(project)
  const paths = createRuntimePaths(path.join(root, 'data'))
  if (withMods) { await mkdir(path.join(paths.assetsRoot, 'base-mods'), { recursive: true }); await writeFile(path.join(paths.assetsRoot, 'base-mods', 'modcrafting-observer-fixture.jar'), 'Fixture only, not a real mod') }
  const calls: Array<{ task: string; args: string[] }> = [], closed: Promise<void>[] = []
  const runtime = new FabricRuntime({ paths, version: 'fixture-runtime', observer: withMods ? fixtureObserver : undefined, toolchain: {
    status: async () => ({ ok: true, platform: process.platform, node: process.version, java: { ok: true }, gradleWrapper: true, target: FABRIC_TARGET, remediation: [] }),
    startGradle: async (_project, task, events, args = []) => {
      calls.push({ task, args })
      const child = spawn(process.execPath, ['-e', task === 'runClient' ? clientExit === undefined ? 'setInterval(()=>{},1000)' : `process.exit(${clientExit})` : `console.log('FIXTURE_BUILD');process.exit(${task === 'failed-build' ? 7 : 0})`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (value) => events?.onLog?.('fixture', String(value)))
      closed.push(new Promise((resolve) => child.once('close', () => resolve())))
      return child
    }
  } })
  t.after(async () => { runtime.close(); let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([Promise.all(closed), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture processes did not stop')), 5000) })]) } finally { clearTimeout(timer) } })
  return { root, project, paths, runtime, calls }
}
async function finished(runtime: FabricRuntime, id: string, sessionId?: string): Promise<JobSnapshot> {
  const limit = Date.now() + 5000
  while (Date.now() < limit) {
    const row = runtime.jobStatus(id, sessionId); assert.ok('status' in row)
    if (row.status !== 'running' && !(row.status === 'stopped' && !row.result && !row.error)) return row
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw Error('Fixture job timed out')
}
async function observer(t: { after: (work: () => Promise<void>) => void }, directory: string, label: string) {
  const requests: Array<{ api: string; body: Record<string, unknown> }> = []; let sequence = 0
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-private-token')
    let text = ''; for await (const part of request) text += String(part)
    requests.push({ api: request.url!, body: text ? JSON.parse(text) : {} })
    response.setHeader('content-type', 'application/json')
    const data = request.url === '/v2/capabilities' ? { ok: true, protocolVersion: 2 }
      : request.url === '/v2/test-preparation' ? { ok: true, phase: 'test_ready', ready: true, failed: false, screen: { simpleName: 'TitleScreen' } }
      : request.url === '/v1/screenshot' ? { ok: true, path: path.join(directory, 'fixture-shot.png') }
      : request.url === '/v2/snapshot' ? { ok: true, worldName: GAME_TEST_WORLD, requestId: `${label}_${++sequence}`, observedAt: Date.now(), inventory: { ok: true, hotbar: [], main: [{ id: 'minecraft:stone', count: 1 }], armor: [], offhand: [] }, player: { health: 20 } }
      : { ok: true, executed: true }
    response.end(JSON.stringify(data))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const port = (server.address() as { port: number }).port
  await writeFile(path.join(directory, 'modcrafting-bridge.json'), JSON.stringify({ port, token: 'fixture-private-token' }))
  return { requests }
}
const spec: GameTestSpec = { version: 2, id: 'runtime-fixture', featureType: 'player_interaction', subject: {}, setup: [], actions: [{ type: 'wait', ms: 20 }, { type: 'command', command: 'fixture-action' }], assertions: [{ type: 'inventory_contains', itemId: 'minecraft:stone' }], cleanup: [{ type: 'command', command: 'fixture-cleanup' }] }

test('Core environment exposes cold resource diagnostics without implicit downloads or directories', async (t) => {
  const f = await fixture(t); const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => { assert.fail('environment status must not download'); return new Response() }
  try {
    const environment = await f.runtime.environmentStatus()
    assert.equal(environment.contractVersion, 1)
    assert.equal(environment.assets.length, 5)
    assert.ok(environment.assets.every((row) => row.status === 'missing'))
    assert.equal(environment.capabilities.toolchain.automaticDownload, false)
    assert.equal(environment.capabilities.entityQuery.tagFilters, false)
    assert.equal(existsSync(f.paths.dataRoot), false)
  } finally { globalThis.fetch = fetchBefore }
})
test('Local resource diagnostics match existing lookup paths and reject incomplete layouts', async (t) => {
  const f = await fixture(t)
  const data = path.join(f.paths.knowledgeRoot, 'minecraft-data', FABRIC_TARGET.minecraft); await mkdir(data, { recursive: true })
  await writeFile(path.join(data, 'index.json'), JSON.stringify({ itemsById: { 'minecraft:stone': { id: 'minecraft:stone' } } }))
  const wiki = path.join(f.paths.knowledgeRoot, 'mc-wiki-zh-index'); await mkdir(wiki); await writeFile(path.join(wiki, 'chunks.json'), '{}')
  const mods = path.join(f.paths.assetsRoot, 'base-mods'); await mkdir(mods, { recursive: true })
  const rows = localAssetStatus(f.paths)
  assert.equal(rows.find((row) => row.name === 'minecraft-data')?.status, 'present')
  assert.equal(lookupMinecraftData(f.paths, 'item', 'stone').ok, true)
  for (const name of ['mc-wiki-zh-index', 'base-mods']) assert.equal(rows.find((row) => row.name === name)?.status, 'invalid')
})
test('Fabric docs search respects limits within and across directories in both resource layouts', async (t) => {
  const f = await fixture(t)
  for (const base of [f.paths.assetsRoot, f.paths.knowledgeRoot]) {
    const docs = path.join(base, 'agent-knowledge/fabric')
    for (const directory of ['a', 'b']) {
      await mkdir(path.join(docs, directory), { recursive: true })
      for (const name of ['one', 'two', 'three']) await writeFile(path.join(docs, directory, `${name}.md`), 'Fixture Fabric registration documentation')
    }
    for (const limit of [1, 2, 4]) {
      const result = searchFabricDocs(f.paths, 'registration', limit)
      assert.equal((result.hits as unknown[]).length, limit)
      assert.equal(result.assetReady, true)
    }
  }
})
test('Explicit asset preparation reports network failure in the configured new data root', async (t) => {
  const f = await fixture(t); const fetchBefore = globalThis.fetch; let calls = 0
  globalThis.fetch = async () => { calls++; throw Error('Fixture network unavailable') }
  try {
    const [result, concurrent] = await Promise.all([f.runtime.prepareAssets(), f.runtime.prepareAssets()])
    assert.equal(result.ok, false); assert.equal(calls, 2)
    assert.deepEqual(concurrent.assets, result.assets)
    assert.equal(result.dataRoot, f.paths.dataRoot)
    assert.ok(result.assets.every((row) => !row.ok && row.error?.includes('Fixture network unavailable')))
    assert.ok(result.localAssets.every((row) => row.status === 'missing'))
  } finally { globalThis.fetch = fetchBefore }
})
test('Cold asset preparation uses proxy fallback and the layouts consumed by Core tools', async (t) => {
  const f = await fixture(t); const fetchBefore = globalThis.fetch
  const archives = new Map<string, Uint8Array>(); let proxyAttempts = 0, directAttempts = 0
  const contents: Record<string, [string, string]> = {
    'minecraft-data': [`minecraft-data/${FABRIC_TARGET.minecraft}/index.json`, JSON.stringify({ itemsById: { 'minecraft:stone': { id: 'minecraft:stone' } } })],
    'mc-wiki-zh': ['mc-wiki-zh/vector.bin', 'Fixture only'],
    'mc-wiki-zh-index': ['mc-wiki-zh-index/chunks.json', '[]'],
    'base-mods': ['_base_mods/modcrafting-observer-fixture.jar', 'Fixture only, not a real mod'],
    'agent-knowledge': ['agent-knowledge/fabric/fixture.md', 'Fixture Fabric documentation']
  }
  for (const [name, [file, data]] of Object.entries(contents)) {
    const source = path.join(f.root, 'zip-source', name), target = path.join(source, file)
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data)
    const archive = path.join(f.root, `${name}.zip`)
    const zip = spawnSync('tar', ['-a', '-cf', archive, '-C', source, file.split('/')[0]], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    assert.equal(zip.status, 0, zip.stderr)
    archives.set(`${name}.zip`, new Uint8Array(await readFile(archive)))
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.startsWith('https://api.github.com/')) {
      const names = url.includes('knowledge-base') ? ['minecraft-data.zip', 'mc-wiki-zh.zip', 'mc-wiki-zh-index.zip'] : ['base-mods.zip', 'agent-knowledge.zip']
      return new Response(JSON.stringify([{ tag_name: `knowledge-${FABRIC_TARGET.minecraft}-fixture`, assets: names.map((name) => ({ name, browser_download_url: `https://github.com/fixture/${name}` })) }]))
    }
    if (url.startsWith('https://gh.xmly.dev/')) { proxyAttempts++; return new Response('', { status: 503 }) }
    assert.ok(url.startsWith('https://github.com/fixture/')); directAttempts++
    const body = archives.get(url.split('/').at(-1)!); assert.ok(body); return new Response(body)
  }
  try {
    const result = await f.runtime.prepareAssets()
    assert.equal(result.ok, true); assert.equal(proxyAttempts, 4); assert.equal(directAttempts, 4)
    assert.ok(result.localAssets.filter(row => row.name !== 'base-mods').every((row) => row.status === 'present'))
    assert.equal(result.localAssets.find(row => row.name === 'base-mods')?.status, 'missing')
    assert.equal(lookupMinecraftData(f.paths, 'item', 'stone').ok, true)
    assert.equal(existsSync(path.join(f.paths.assetsRoot, 'base-mods')), false)
  } finally { globalThis.fetch = fetchBefore }
})
test('Project-scoped preparation stores knowledge under the workspace and leaves the backend root untouched', async (t) => {
  const f = await fixture(t); const fetchBefore = globalThis.fetch
  const source = path.join(f.root, 'zip-source', 'minecraft-data'), member = `minecraft-data/${FABRIC_TARGET.minecraft}/index.json`
  await mkdir(path.dirname(path.join(source, member)), { recursive: true })
  await writeFile(path.join(source, member), JSON.stringify({ itemsById: { 'minecraft:stone': { id: 'minecraft:stone' } } }))
  const archive = path.join(f.root, 'minecraft-data.zip')
  assert.equal(spawnSync('tar', ['-a', '-cf', archive, '-C', source, 'minecraft-data'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).status, 0)
  const body = new Uint8Array(await readFile(archive))
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify([{ tag_name: `knowledge-${FABRIC_TARGET.minecraft}-fixture`, assets: [{ name: 'minecraft-data.zip', browser_download_url: 'https://github.com/fixture/minecraft-data.zip' }] }]))
    if (url.startsWith('https://gh.xmly.dev/')) return new Response('', { status: 503 })
    assert.ok(url.startsWith('https://github.com/fixture/')); return new Response(body)
  }
  try {
    const result = await f.runtime.prepareAssets(['minecraft-data'], f.project)
    assert.equal(result.ok, true)
    assert.equal(result.dataRoot, path.join(f.project, '.modcrafting'))
    const scoped = projectRuntimePaths(f.paths, f.project)
    assert.equal(lookupMinecraftData(scoped, 'item', 'stone').ok, true)
    assert.equal(lookupMinecraftData(f.paths, 'item', 'stone').ok, false)
    assert.ok(String(lookupMinecraftData(f.paths, 'item', 'stone').error).includes(f.paths.knowledgeRoot))
    assert.equal(existsSync(f.paths.knowledgeRoot), false, 'backend knowledge root stays untouched')
    const status = await f.runtime.environmentStatus(f.project)
    assert.equal(status.paths.dataRoot, path.join(f.project, '.modcrafting'))
    assert.equal(status.assets.find(row => row.name === 'minecraft-data')?.status, 'present')
  } finally { globalThis.fetch = fetchBefore }
})
test('Core build jobs expose logs, terminal errors and stable missing-job codes', async (t) => {
  const f = await fixture(t)
  const good = await finished(f.runtime, f.runtime.startBuild(f.project).jobId)
  assert.equal(good.status, 'completed'); assert.match(good.output.join(''), /FIXTURE_BUILD/)
  assert.deepEqual(good.result, { ok: true, task: 'build', exitCode: 0 })
  const bad = await finished(f.runtime, f.runtime.startBuild(f.project, 'failed-build').jobId)
  assert.equal(bad.status, 'failed'); assert.equal(bad.code, 'BUILD_FAILED')
  assert.equal((f.runtime.jobStatus('missing') as { code: string }).code, 'JOB_NOT_FOUND')
  assert.throws(() => f.runtime.startBuild(f.project, 'build & command'), (error) => error instanceof CoreError && error.code === 'INVALID_ARGUMENT')
  assert.throws(() => f.runtime.runClient(f.project), (error) => error instanceof CoreError && error.code === 'OBSERVER_UPDATE_REQUIRED')
})
test('Session profile snapshots apply to a copied save without changing its source or a running options file', async (t) => {
  const f = await fixture(t, true)
  const session = f.runtime.createSession({ name: 'copy-save profile', projectPath: f.project })
  const source = path.join(f.root, 'source-save')
  await mkdir(path.join(source, 'region'), { recursive: true })
  await writeFile(path.join(source, 'level.dat'), 'source level data')
  await writeFile(path.join(source, 'region', 'r.0.0.mca'), 'source chunks')
  const profile: TestProfile = {
    ...structuredClone(DEFAULT_TEST_PROFILE), language: 'en_us', window: { width: 1600, height: 900 },
    renderDistance: 12, maxFps: 120, volumePercent: 80,
    map: { source: 'save_copy', terrain: 'normal', seed: '0', sourcePath: source },
    gameMode: 'adventure', difficulty: 'easy', allowCommands: false
  }
  f.runtime.setTestProfile(session.sessionId, profile, { projectPath: f.project })
  assert.equal(existsSync(path.join(f.project, '.modcrafting', 'test-profile.json')), false, 'project defaults require explicit opt-in')
  f.runtime.setTestProfile(session.sessionId, profile, { projectPath: f.project, saveAsProjectDefault: true })
  assert.deepEqual(JSON.parse(await readFile(path.join(f.project, '.modcrafting', 'test-profile.json'), 'utf8')), profile)

  const launched = f.runtime.runClient(f.project, undefined, session.sessionId)
  assert.equal(launched.profile.language, 'en_us')
  const world = path.join(launched.gameDirectory, 'saves', GAME_TEST_WORLD)
  assert.equal(await readFile(path.join(world, 'level.dat'), 'utf8'), 'source level data')
  assert.equal(await readFile(path.join(world, 'region', 'r.0.0.mca'), 'utf8'), 'source chunks')
  const owner = JSON.parse(await readFile(path.join(world, '.modcrafting-owner.json'), 'utf8'))
  assert.equal(owner.sessionId, session.sessionId); assert.equal(owner.copiedFrom, source)
  const optionsPath = path.join(launched.gameDirectory, 'options.txt'), before = await readFile(optionsPath, 'utf8')
  for (const setting of ['lang:en_us', 'overrideWidth:1600', 'overrideHeight:900', 'renderDistance:12', 'maxFps:120', 'soundCategory_master:0.8', 'narrator:0']) assert.ok(before.includes(setting), setting)

  const changed = { ...profile, language: 'zh_cn' as const }
  f.runtime.setTestProfile(session.sessionId, changed, { projectPath: f.project })
  assert.equal(await readFile(optionsPath, 'utf8'), before, 'changing the next-launch profile must not touch the running game configuration')
  assert.equal(f.runtime.state(session.sessionId).instances[0].profile?.language, 'en_us', 'the launch record keeps the actual applied profile snapshot')
  f.runtime.stopClient(launched.instanceId, session.sessionId)
  await finished(f.runtime, launched.jobId, session.sessionId)
  assert.equal(await readFile(path.join(source, 'level.dat'), 'utf8'), 'source level data')
  assert.equal(await readFile(path.join(source, 'region', 'r.0.0.mca'), 'utf8'), 'source chunks')
})

test('A queued game test keeps its session-owned instance while another project runs in another session', async (t) => {
  const f = await fixture(t, true)
  const a = f.runtime.runClient(f.project, path.join(f.root, 'game A')); const observerA = await observer(t, a.gameDirectory, 'a')
  const testJob = f.runtime.startTest(spec)
  const otherProject = path.join(f.root, 'project B'); await mkdir(otherProject)
  const otherSession = f.runtime.createSession({ name: '另一任务', projectPath: otherProject })
  const b = f.runtime.runClient(otherProject, undefined, otherSession.sessionId); const observerB = await observer(t, b.gameDirectory, 'b')
  assert.notEqual(a.instanceId, b.instanceId)
  const result = await finished(f.runtime, testJob.jobId)
  assert.equal(result.status, 'completed'); assert.equal(result.result?.verdict, 'PASS')
  assert.equal(observerA.requests.filter((row) => row.api === '/v2/command').length, 2)
  assert.equal(observerB.requests.length, 0)
  const saved = JSON.parse(await readFile(String(result.result?.reportPath), 'utf8'))
  assert.equal(saved.instanceId, a.instanceId); assert.equal(saved.gameDirectory, a.gameDirectory)
  assert.equal(JSON.stringify(saved).includes('fixture-private-token'), false)
  assert.ok(f.calls.filter((call) => call.task === 'runClient').every((call) => call.args[0].includes('--gameDir')))
})
test('Runtime readiness, controlled input and screenshot share state without exposing discovery secrets', async (t) => {
  const f = await fixture(t, true); const a = f.runtime.runClient(f.project, path.join(f.root, 'game'))
  assert.throws(() => f.runtime.runClient(f.project, a.gameDirectory), (error) => error instanceof CoreError && error.code === 'SESSION_GAME_BUSY')
  assert.equal((await f.runtime.runtimeStatus(a.instanceId)).bridgeReady, false)
  const bridge = await observer(t, a.gameDirectory, 'ready')
  const state = await f.runtime.runtimeStatus(a.instanceId)
  assert.equal(state.bridgeReady, true); assert.equal(state.canRunTests, true); assert.equal(state.instanceId, a.instanceId)
  assert.equal(JSON.stringify(state).includes('fixture-private-token'), false)
  await f.runtime.input('press_key', { action: 'unsafe-override' }, a.instanceId)
  assert.equal(bridge.requests.at(-1)?.body.action, 'press_key')
  assert.equal((await f.runtime.screenshot(a.instanceId)).data.path, path.join(a.gameDirectory, 'fixture-shot.png'))
  f.runtime.stopClient(a.instanceId)
  await finished(f.runtime, a.jobId)
  assert.throws(() => f.runtime.runClient(f.project, a.gameDirectory), (error) => error instanceof CoreError && error.code === 'INSTANCE_CONFLICT')
  assert.equal((await f.runtime.runtimeStatus(a.instanceId)).bridgeReady, false)
  await assert.rejects(f.runtime.command('fixture', a.instanceId), (error) => error instanceof CoreError && error.code === 'OBSERVER_UNAVAILABLE')
})
test('Invalid scenarios fail before scheduling jobs or selecting a game instance', async (t) => {
  const f = await fixture(t)
  assert.throws(() => f.runtime.startTest({ ...spec, assertions: [] }), (error) => error instanceof CoreError && error.code === 'INVALID_SPEC')
  assert.throws(() => f.runtime.startTest(spec), (error) => error instanceof CoreError && error.code === 'INSTANCE_UNAVAILABLE')
  assert.equal(f.calls.length, 0)
})
test('Client exit failure and explicit cancellation have distinct terminal results', async (t) => {
  const broken = await fixture(t, true, 7)
  const client = broken.runtime.runClient(broken.project)
  const failed = await finished(broken.runtime, client.jobId)
  assert.equal(failed.status, 'failed'); assert.equal(failed.code, 'CLIENT_FAILED')
  const running = await fixture(t, true)
  const stopped = running.runtime.runClient(running.project)
  running.runtime.stopClient(stopped.instanceId)
  const limit = Date.now() + 5000; let state = running.runtime.jobStatus(stopped.jobId)
  while ('status' in state && !state.result && Date.now() < limit) { await new Promise((resolve) => setTimeout(resolve, 10)); state = running.runtime.jobStatus(stopped.jobId) }
  assert.ok('status' in state); assert.equal(state.status, 'stopped'); assert.equal(state.result?.code, 'CANCELLED')
})
