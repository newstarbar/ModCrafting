import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertBuildId, prepareStudioInbox, readStudioDiscovery, readStudioOutbox, studioRequest, StudioError } from '../../packages/modcrafting-core/src/building-studio.ts'

test('Studio inbox copies a structure with a sha manifest and rejects unsafe ids/paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-studio-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const game = path.join(root, 'game')
  await mkdir(game)
  const source = path.join(root, 'source.nbt')
  await writeFile(source, 'fixture-nbt')
  const inbox = prepareStudioInbox(game, 'cottage_01', source)
  assert.equal(existsSync(inbox.structurePath), true)
  assert.equal(inbox.sha256, createHash('sha256').update('fixture-nbt').digest('hex'))
  const manifest = JSON.parse(readFileSync(inbox.manifestPath, 'utf8')) as Record<string, unknown>
  assert.equal(manifest.buildId, 'cottage_01')
  assert.equal(manifest.sha256, inbox.sha256)
  assert.throws(() => prepareStudioInbox(game, 'cottage_01', 'relative.nbt'), (error: unknown) => error instanceof StudioError && error.code === 'INVALID_STRUCTURE_PATH')
  assert.throws(() => prepareStudioInbox(game, 'Bad-ID', source), (error: unknown) => error instanceof StudioError && error.code === 'INVALID_BUILD_ID')
  assert.throws(() => assertBuildId('../escape'), (error: unknown) => error instanceof StudioError && error.code === 'INVALID_BUILD_ID')
})

test('Studio discovery and loopback requests enforce the token and route allowlist', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-studio-http-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seen: string[] = []
  const server = createServer(async (request, response) => {
    seen.push(`${request.method} ${request.url}`)
    assert.equal(request.headers.authorization, 'Bearer fixture-token')
    let text = ''
    for await (const part of request) text += String(part)
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/studio/status') response.end(JSON.stringify({ ok: true, protocol: 1, ready: true }))
    else response.end(JSON.stringify({ ok: true, echoed: text ? JSON.parse(text) : {} }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const port = (server.address() as { port: number }).port
  await writeFile(path.join(root, 'modcrafting-builder.json'), JSON.stringify({ port, token: 'fixture-token', protocol: 1, modVersion: '0.1.0' }))
  const discovery = readStudioDiscovery(root)
  assert.ok(discovery)
  const status = await studioRequest(discovery, 'GET', '/v1/studio/status', undefined, 2000)
  assert.equal(status.ok, true)
  assert.equal(status.data.ready, true)
  const opened = await studioRequest(discovery, 'POST', '/v1/studio/open', { buildId: 'cottage_01', force: false }, 2000)
  assert.equal(opened.ok, true)
  assert.deepEqual(opened.data.echoed, { buildId: 'cottage_01', force: false })
  const blocked = await studioRequest(discovery, 'GET', '/v1/other', undefined, 2000)
  assert.equal(blocked.ok, false)
  assert.match(blocked.error || '', /not allowed/)
  assert.deepEqual(seen, ['GET /v1/studio/status', 'POST /v1/studio/open'])
})

test('Studio outbox is read only from the session game directory', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-studio-outbox-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const missing = readStudioOutbox(root, 'missing_build')
  assert.equal(missing, null)
  const directory = path.join(root, 'modcrafting-studio', 'outbox', 'cottage_01')
  await mkdir(directory, { recursive: true })
  writeFileSync(path.join(directory, 'structure.nbt'), 'fixture-outbox')
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ buildId: 'cottage_01', blockCount: 1 }))
  const outbox = readStudioOutbox(root, 'cottage_01')
  assert.ok(outbox)
  assert.equal(outbox.structurePath, path.join(directory, 'structure.nbt'))
  assert.equal(outbox.manifest.blockCount, 1)
})
