import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'
import {
  clearBridgeDiscovery,
  readBridgeDiscovery,
  requestBridge,
  type BridgeDiscovery
} from '../../src/main/mc-bridge-client.ts'
import { contentAsText, isVisionCapableModel, toolResultMessage } from '../../src/renderer/src/harness/chat-message.ts'
import { formatBridgeResult } from '../../src/renderer/src/harness/mc-observer-tools.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('mc-bridge-client', () => {
  it('reads and clears discovery file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bridge-'))
    const file = path.join(dir, 'modcrafting-bridge.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, port: 12345, token: 'abc', modVersion: '1.0.0' }),
      'utf-8'
    )
    const discovery = readBridgeDiscovery(dir)
    assert.equal(discovery?.port, 12345)
    assert.equal(discovery?.token, 'abc')
    clearBridgeDiscovery(dir)
    assert.equal(readBridgeDiscovery(dir), null)
  })

  it('sends Authorization Bearer and parses JSON', async () => {
    let seenAuth = ''
    const server = http.createServer((req, res) => {
      seenAuth = String(req.headers.authorization || '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, hello: 'world' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    const discovery: BridgeDiscovery = { version: 1, port: addr.port, token: 'secret-token' }
    try {
      const result = await requestBridge(discovery, 'GET', '/v1/health', undefined, 3000)
      assert.equal(result.ok, true)
      assert.equal(result.data.hello, 'world')
      assert.equal(seenAuth, 'Bearer secret-token')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  })

  it('returns connection error when server down', async () => {
    const discovery: BridgeDiscovery = { version: 1, port: 1, token: 'x' }
    const result = await requestBridge(discovery, 'GET', '/v1/health', undefined, 500)
    assert.equal(result.ok, false)
    assert.match(String(result.error), /桥接连接失败|超时/)
  })
})

describe('mc-observer helpers', () => {
  it('omits base64 from formatted output', () => {
    const text = formatBridgeResult({
      ok: true,
      status: 200,
      data: { ok: true, path: '/tmp/a.png', base64: 'AAAA' }
    })
    assert.match(text, /path/)
    assert.doesNotMatch(text, /AAAA/)
    assert.match(text, /omitted/)
  })

  it('detects vision-capable models', () => {
    assert.equal(isVisionCapableModel('gpt-4o'), true)
    assert.equal(isVisionCapableModel('claude-sonnet-4'), true)
    assert.equal(isVisionCapableModel('deepseek-chat'), false)
  })

  it('builds multimodal tool result for screenshots', () => {
    const msg = toolResultMessage({ id: '1', name: 'mc_screenshot' }, '{"ok":true}', {
      base64: 'abc',
      mimeType: 'image/png'
    })
    assert.ok(Array.isArray(msg.content))
    assert.equal(contentAsText(msg.content).includes('ok'), true)
  })
})
