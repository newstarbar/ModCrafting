import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { openWorkbench } from '../../plugins/modcrafting-fabric/src/workbench.ts'
import { FabricRuntime, SystemToolchainProvider, createRuntimePaths, localAssetStatus, FABRIC_TARGET } from '../../packages/modcrafting-core/src/index.ts'
import { fixtureObserver } from './fixtures/observer.ts'

const parent = path.resolve('temp/experience-tests')
await mkdir(parent, { recursive: true })
async function project() {
  const root = await mkdtemp(path.join(parent, '中文 工程-'))
  await mkdir(path.join(root, 'src/main/resources'), { recursive: true })
  await writeFile(path.join(root, 'src/main/resources/fabric.mod.json'), '{"id":"experience_test"}')
  await writeFile(path.join(root, 'gradle.properties'), 'minecraft_version=1.21.4\n')
  await writeFile(path.join(root, 'gradlew.bat'), '@echo off\r\nchcp 65001 >nul\r\necho JAVA=%JAVA_HOME%\r\necho CACHE=%GRADLE_USER_HOME%\r\necho TEMPORARY=%TEMP%\r\n')
  return root
}
test('workbench routes one backend to a selected project/editor, supports opt-out and falls back when opening fails', async () => {
  const root = await project(), calls: string[] = []
  const sessionId = '3aab15f9-a5c6-46d5-9d30-29cb339990b6'
  const result = await openWorkbench('http://127.0.0.1:1234/#token=private', { projectPath: root, view: 'content', sessionId, backendId: 'backend-fixture' }, async url => { calls.push(url) })
  assert.equal(result.opened, true); assert.equal(result.visibilityConfirmed, false)
  const url = new URL(calls[0]), fragment = new URLSearchParams(url.hash.slice(1))
  assert.equal(url.origin, 'http://127.0.0.1:1234'); assert.equal(fragment.get('project'), root)
  assert.equal(fragment.get('view'), 'content'); assert.equal(fragment.get('token'), 'private')
  assert.equal(fragment.get('sessionId'), sessionId); assert.equal(fragment.get('backendId'), 'backend-fixture')
  assert.equal((await openWorkbench(url.href, { open: false, sessionId, backendId: 'backend-fixture' }, async () => { assert.fail('must not open') })).opened, false)
  const fallback = await openWorkbench(url.href, { sessionId, backendId: 'backend-fixture' }, async () => { throw Error('system opener failed') })
  assert.equal(fallback.code, 'BROWSER_OPEN_FAILED'); assert.ok(fallback.browserUrl); assert.equal(fallback.opened, false)
  assert.equal((await openWorkbench(undefined, {})).code, 'WORKBENCH_DISABLED')
  const empty = await mkdtemp(path.join(parent, 'empty-'))
  assert.equal((await openWorkbench(url.href, { projectPath: empty, sessionId, backendId: 'backend-fixture' }, async () => { assert.fail('invalid project') })).code, 'PROJECT_UNAVAILABLE')
})

test('PATH-only JDK becomes the same JAVA_HOME for a Windows build; cache stays under configured data', { skip: process.platform !== 'win32' }, async () => {
  const original = { JAVA_HOME: process.env.JAVA_HOME, GRADLE_USER_HOME: process.env.GRADLE_USER_HOME, PATH: process.env.PATH }
  const root = await project(), provider = new SystemToolchainProvider(path.join(root, 'data'))
  try {
    // Keep the known JDK on PATH while removing the variable a desktop subprocess may not inherit.
    if (original.JAVA_HOME) process.env.PATH = path.join(original.JAVA_HOME, 'bin') + path.delimiter + original.PATH
    delete process.env.JAVA_HOME; delete process.env.GRADLE_USER_HOME
    const status = await provider.status(root)
    assert.equal(status.java.ok, true); assert.ok(status.java.path)
    assert.equal(status.storage?.gradleUserHome, path.join(root, 'data/cache/gradle'))
    assert.equal(status.storage?.cacheRoot, path.join(root, 'data/cache'))
    assert.ok(status.storage?.source && ['default', 'auto', 'existing'].includes(status.storage.source))
    assert.equal(existsSync(status.storage!.gradleUserHome!), false, 'inspection must not create cache directories')
    let output = ''
    const child = await provider.startGradle(root, 'build', { onLog: (_, line) => { output += line } })
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(code, 0); assert.ok(output.includes(`JAVA=${status.java.path}`))
    assert.ok(output.includes(`CACHE=${status.storage!.gradleUserHome}`)); assert.ok(output.includes(`TEMPORARY=${status.storage!.temporaryDirectory}`))
    assert.ok(output.includes('Gradle 缓存'), 'build output must name the selected cache path')
    assert.ok(existsSync(path.join(root, 'data/cache/.modcrafting-cache.json')), 'a build records the cache for other hosts')
    process.env.JAVA_HOME = path.join(root, 'missing-jdk')
    assert.equal((await provider.status(root)).java.ok, false, 'an explicit broken JAVA_HOME must not silently pass via PATH')
  } finally { for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
})

test('old cached Observer cannot satisfy readiness; matching bundled bytes replace the canonical game component', async t => {
  const root = await project(), paths = createRuntimePaths(path.join(root, 'data'))
  await mkdir(path.join(paths.assetsRoot, 'base-mods'), { recursive: true })
  await writeFile(path.join(paths.assetsRoot, 'base-mods/modcrafting-observer.jar'), 'old v1 cache')
  assert.equal(localAssetStatus(paths).find(row => row.name === 'base-mods')?.status, 'invalid')
  const children: ReturnType<typeof spawn>[] = []
  const runtime = new FabricRuntime({ paths, version: 'fixture', observer: fixtureObserver, toolchain: {
    status: async () => ({ ok: true, platform: process.platform, node: process.version, java: { ok: true }, gradleWrapper: true, target: FABRIC_TARGET, remediation: [] }),
    startGradle: async () => { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true }); children.push(child); return child }
  } })
  t.after(async () => { const exits = children.map(child => new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve()) })); runtime.close(); await Promise.all(exits) })
  const game = path.join(root, 'game'); await mkdir(path.join(game, 'mods'), { recursive: true })
  await writeFile(path.join(game, 'mods/modcrafting-observer.jar'), 'old game v1')
  const instance = runtime.runClient(root, game)
  assert.equal((await readFile(path.join(game, 'mods/modcrafting-observer.jar'))).toString('base64'), fixtureObserver.jarBase64)
  assert.equal(await readFile(path.join(paths.assetsRoot, 'base-mods/modcrafting-observer.jar'), 'utf8'), 'old v1 cache')
  const routes: string[] = []
  const server = createServer((request, response) => { routes.push(request.url!); response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"ok":false,"error":"old bridge"}') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  await writeFile(path.join(game, 'modcrafting-bridge.json'), JSON.stringify({ port: (server.address() as { port: number }).port }))
  const status = await runtime.runtimeStatus(instance.instanceId)
  assert.equal(status.bridgeReady, false); assert.equal(status.code, 'OBSERVER_UPDATE_REQUIRED')
  await assert.rejects(runtime.command('give @s minecraft:stone', instance.instanceId), { code: 'OBSERVER_UPDATE_REQUIRED' })
  assert.ok(routes.every(route => route === '/v2/capabilities'), 'must not guess or dispatch against incompatible command endpoints')
  const corrupted = new FabricRuntime({ paths, version: 'fixture', observer: { ...fixtureObserver, sha256: '0'.repeat(64) } })
  assert.throws(() => corrupted.runClient(root), { code: 'OBSERVER_UPDATE_REQUIRED' })
})

test('healthy selected resources are reused without fetching unrelated knowledge or old base mods', async () => {
  const root = await project(), paths = createRuntimePaths(path.join(root, 'data'))
  const data = path.join(paths.knowledgeRoot, 'minecraft-data/1.21.4/index.json')
  await mkdir(path.dirname(data), { recursive: true }); await writeFile(data, '{"itemsById":{}}')
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw Error('No network is needed for a healthy selected resource') }
  try {
    const runtime = new FabricRuntime({ paths, version: 'fixture', observer: fixtureObserver })
    const result = await runtime.prepareAssets(['minecraft-data'])
    assert.equal(result.ok, true); assert.deepEqual(result.assets, [])
    assert.equal(existsSync(path.join(paths.assetsRoot, 'base-mods')), false)
  } finally { globalThis.fetch = original }
})
