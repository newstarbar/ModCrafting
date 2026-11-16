import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createZip } from '../lib/zip.mjs'
import { makeBundle, makeHome, run, runAsync } from './helpers.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function zipOf(directory, prefix = '') {
  const entries = []
  const walk = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      const name = `${relative}${entry.name}`
      if (entry.isDirectory()) walk(file, `${name}/`)
      else entries.push([`${prefix}${name}`, fs.readFileSync(file)])
    }
  }
  walk(directory)
  return createZip(entries)
}

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('downloads, verifies and caches a bundle', async () => {
  const bundleDir = makeBundle('download', '9.9.9')
  const zip = zipOf(bundleDir, 'modcrafting-bundle/')
  const digest = sha256(zip)
  await withServer((request, response) => {
    if (request.url === '/v9.9.9/ModCrafting-MCP-v9.9.9.zip') {
      response.writeHead(200).end(zip)
      return
    }
    if (request.url === '/v9.9.9/ModCrafting-Fabric-SHA256SUMS-v9.9.9.txt') {
      response.writeHead(200).end(`${digest}  ModCrafting-MCP-v9.9.9.zip\n`)
      return
    }
    response.writeHead(404).end('no')
  }, async (base) => {
    const home = makeHome('download')
    const result = await runAsync(['install', '--host', 'cursor', '--bundle-version', '9.9.9', '--json'], {
      home,
      env: { MODCRAFTING_RELEASE_BASE: base, MODCRAFTING_NO_NETWORK: '' }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.json.bundle.version, '9.9.9')
    assert.equal(fs.existsSync(path.join(home, '.modcrafting', 'versions', '9.9.9', 'bundle.json')), true)
    assert.equal(fs.existsSync(path.join(home, '.modcrafting', 'versions', '9.9.9', 'dist', 'mcp-server.js')), true)
  })
})

test('rejects a bundle whose checksum does not match', async () => {
  const zip = zipOf(makeBundle('bad-sum', '9.9.8'))
  await withServer((request, response) => {
    if (request.url.endsWith('ModCrafting-MCP-v9.9.8.zip')) return response.writeHead(200).end(zip)
    if (request.url.includes('SHA256SUMS')) return response.writeHead(200).end(`${'0'.repeat(64)}  ModCrafting-MCP-v9.9.8.zip\n`)
    response.writeHead(404).end('no')
  }, async (base) => {
    const home = makeHome('bad-sum')
    const result = await runAsync(['install', '--host', 'cursor', '--bundle-version', '9.9.8', '--json'], {
      home,
      env: { MODCRAFTING_RELEASE_BASE: base, MODCRAFTING_NO_NETWORK: '' }
    })
    assert.equal(result.status, 4)
    assert.match(result.json.message, /SHA-256/)
    assert.equal(fs.existsSync(path.join(home, '.modcrafting', 'versions', '9.9.8')), false)
  })
})

test('a 404 explains the offline alternative', async () => {
  await withServer((request, response) => response.writeHead(404).end('no'), async (base) => {
    const home = makeHome('missing')
    const result = await runAsync(['install', '--host', 'cursor', '--bundle-version', '9.9.7', '--json'], {
      home,
      env: { MODCRAFTING_RELEASE_BASE: base, MODCRAFTING_NO_NETWORK: '' }
    })
    assert.equal(result.status, 4)
    assert.match(result.json.message, /--from-zip/)
  })
})

test('--no-network without a cache fails fast', () => {
  const home = makeHome('offline')
  const result = run(['install', '--host', 'cursor', '--bundle-version', '9.9.6', '--json'], { home })
  assert.equal(result.status, 4)
  assert.match(result.json.message, /no-network|--from-zip|缓存/)
})

test('installs from a ZIP without any network', () => {
  const zip = zipOf(makeBundle('zip-install', '9.9.5'), 'ModCrafting-Offline/')
  const home = makeHome('zip-install')
  const file = path.join(home, 'offline.zip')
  fs.writeFileSync(file, zip)
  const result = run(['install', '--host', 'cursor', '--from-zip', file, '--json'], { home })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.bundle.version, '9.9.5')
  assert.equal(fs.existsSync(path.join(home, '.modcrafting', 'versions', '9.9.5', 'bundle.json')), true)
})
