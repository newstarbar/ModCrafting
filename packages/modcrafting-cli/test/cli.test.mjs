import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeBundle, makeHome, run } from './helpers.mjs'

const bundle = makeBundle('cli')

function snapshot(directory) {
  const result = {}
  const walk = (current, prefix = '') => {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      const relative = `${prefix}${entry.name}`
      if (entry.isDirectory()) walk(file, `${relative}/`)
      else result[relative] = fs.readFileSync(file, 'utf8')
    }
  }
  walk(directory)
  return result
}

test('no arguments prints help', () => {
  const home = makeHome('help')
  const result = run([], { home })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /ModCrafting Fabric 安装器/)
  assert.match(result.stdout, /默认与 CLI 版本一致/)
})

test('--version prints the CLI version', () => {
  const home = makeHome('version')
  const result = run(['--version'], { home })
  assert.equal(result.status, 0)
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/)
})

test('no detected host exits 2 with candidates', () => {
  const home = makeHome('none')
  const result = run(['install', '--auto', '--bundle-dir', bundle, '--json'], { home })
  assert.equal(result.status, 2)
  assert.equal(result.json.code, 'NO_HOST_DETECTED')
})

test('multiple detected hosts without env evidence is ambiguous', () => {
  const home = makeHome('ambiguous')
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const result = run(['install', '--auto', '--bundle-dir', bundle, '--json'], { home, env: { CLAUDECODE: '', CURSOR_TRACE_ID: '' } })
  assert.equal(result.status, 2)
  assert.equal(result.json.code, 'AMBIGUOUS_HOST')
  assert.equal(result.json.details.candidates.length, 2)
})

test('environment evidence breaks the tie', () => {
  const home = makeHome('tie')
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const result = run(['install', '--auto', '--bundle-dir', bundle, '--json'], { home, env: { CLAUDECODE: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.hosts[0].host, 'claude')
})

test('--all-detected installs every strong candidate', () => {
  const home = makeHome('all')
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  const result = run(['install', '--all-detected', '--bundle-dir', bundle, '--json'], { home })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.json.hosts.map((host) => host.host).sort(), ['codex', 'cursor'])
})

test('--dry-run writes nothing', () => {
  const home = makeHome('dry')
  const before = snapshot(home)
  const result = run(['install', '--host', 'cursor', '--bundle-dir', bundle, '--dry-run', '--json'], { home })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(snapshot(home), before)
  assert.match(result.json.hosts[0].config.preview, /modcrafting-fabric/)
})

test('--print-snippet writes nothing and prints the entry', () => {
  const home = makeHome('snippet')
  const before = snapshot(home)
  const result = run(['install', '--host', 'opencode', '--bundle-dir', bundle, '--print-snippet', '--json'], { home })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(snapshot(home), before)
  assert.match(result.json.hosts[0].snippet, /"mcp"/)
})

test('a broken JSON config is never overwritten', () => {
  const home = makeHome('broken')
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  const file = path.join(home, '.cursor', 'mcp.json')
  fs.writeFileSync(file, '{ not json')
  const result = run(['install', '--host', 'cursor', '--bundle-dir', bundle, '--json'], { home })
  assert.equal(result.status, 3)
  assert.equal(result.json.code, 'CONFIG_INVALID')
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json')
})

test('existing servers and unknown keys survive a round trip', () => {
  const home = makeHome('merge')
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  const file = path.join(home, '.cursor', 'mcp.json')
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: [1, 2] }, null, 2)}\n`)
  const installed = run(['install', '--host', 'cursor', '--bundle-dir', bundle, '--json'], { home })
  assert.equal(installed.status, 0, installed.stderr)
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(data.mcpServers.other, { command: 'x' })
  assert.deepEqual(data.keep, [1, 2])
  assert.ok(data.mcpServers['modcrafting-fabric'])
  assert.equal(fs.readdirSync(path.join(home, '.modcrafting', 'backups', 'cursor')).length, 1)

  const removed = run(['uninstall', '--host', 'cursor', '--json'], { home })
  assert.equal(removed.status, 0, removed.stderr)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(after, { mcpServers: { other: { command: 'x' } }, keep: [1, 2] })
})

test('skills are installed once per shared root', () => {
  const home = makeHome('skills')
  const result = run(['install', '--host', 'codex', '--host', 'workbuddy', '--bundle-dir', bundle, '--json'], { home })
  assert.equal(result.status, 0, result.stderr)
  const roots = new Set()
  for (const host of result.json.hosts) for (const skill of host.skills) roots.add(skill.root)
  for (const root of roots) {
    assert.equal(fs.existsSync(path.join(root, 'modcrafting-start', 'SKILL.md')), true)
  }
})

test('versions reports the cache and the installed hosts', () => {
  const home = makeHome('versions')
  run(['install', '--host', 'cursor', '--bundle-dir', bundle, '--json'], { home })
  const result = run(['versions', '--json'], { home })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.installed[0].host, 'cursor')
  assert.equal(result.json.installed[0].version, '9.9.9')
})

test('doctor reports a healthy install', () => {
  const home = makeHome('doctor')
  run(['install', '--host', 'cursor', '--bundle-dir', bundle, '--json'], { home })
  const result = run(['doctor', '--host', 'cursor', '--json'], { home })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.hosts[0].config.hasEntry, true)
})
