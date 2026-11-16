import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { HOSTS } from '../lib/hosts.mjs'
import { makeBundle, makeHome, run } from './helpers.mjs'

const bundle = makeBundle('hosts')

function configFileFor(home, host) {
  const ctx = {
    platform: process.platform,
    env: {},
    home,
    appData: path.join(home, 'AppData', 'Roaming'),
    configHome: path.join(home, '.config')
  }
  const candidates = host.config.paths(ctx)
  return candidates[0]
}

function prepare(home, host) {
  if (host.config.createParents || !host.config.paths) return
  const file = configFileFor(home, host)
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true })
}

for (const host of HOSTS) {
  if (host.id === 'generic' || host.id === 'dsh') continue
  test(`install/uninstall ${host.id}`, () => {
    const home = makeHome(host.id)
    prepare(home, host)
    const installed = run(['install', '--host', host.id, '--bundle-dir', bundle, '--json'], { home })
    assert.equal(installed.status, 0, installed.stderr)
    assert.equal(installed.json.ok, true)

    const file = configFileFor(home, host)
    assert.equal(fs.existsSync(file), true, `${host.id} 没有写出配置 ${file}`)
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /modcrafting-fabric/)

    const again = run(['install', '--host', host.id, '--bundle-dir', bundle, '--json'], { home })
    assert.equal(again.status, 0, again.stderr)
    const config = again.json.hosts[0].config
    assert.equal(config.action, 'unchanged', `${host.id} 第二次安装应为幂等`)

    const removed = run(['uninstall', '--host', host.id, '--json'], { home })
    assert.equal(removed.status, 0, removed.stderr)
    const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    assert.equal(after.includes('modcrafting-fabric'), false, `${host.id} 卸载后仍有残留`)
  })
}

test('generic requires --config-path', () => {
  const home = makeHome('generic')
  const failed = run(['install', '--host', 'generic', '--bundle-dir', bundle, '--json'], { home })
  assert.equal(failed.status, 1)
  assert.equal(failed.json.code, 'USAGE')
})

test('generic writes the given file', () => {
  const home = makeHome('generic-ok')
  const file = path.join(home, 'custom', 'mcp.json')
  const installed = run(['install', '--host', 'generic', '--config-path', file, '--bundle-dir', bundle, '--json'], { home })
  assert.equal(installed.status, 0, installed.stderr)
  assert.equal(fs.existsSync(file), true)
})

test('dsh explains that it needs the official command', () => {
  const home = makeHome('dsh')
  const failed = run(['install', '--host', 'dsh', '--bundle-dir', bundle, '--json'], { home })
  assert.equal(failed.status, 5)
  assert.match(failed.json.message, /dsh|命令/)
})

test('unknown host is a usage error', () => {
  const home = makeHome('unknown')
  const failed = run(['install', '--host', 'nope', '--bundle-dir', bundle, '--json'], { home })
  assert.equal(failed.status, 1)
  assert.match(failed.json.message, /未知宿主/)
})
