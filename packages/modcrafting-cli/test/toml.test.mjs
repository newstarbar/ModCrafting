import test from 'node:test'
import assert from 'node:assert/strict'
import { readServerBlock, removeServerBlock, renderServerBlock, upsertServerBlock } from '../lib/toml.mjs'

const entry = { command: 'node', args: ['C:/x/mcp-server.js'], cwd: 'C:/x', env: { MODCRAFTING_DATA: 'C:/data' } }

test('appends a block to an empty document', () => {
  const result = upsertServerBlock('', 'modcrafting-fabric', entry)
  assert.equal(result.changed, true)
  assert.match(result.text, /^\[mcp_servers\.modcrafting-fabric\]\ncommand = "node"/)
  assert.match(result.text, /\[mcp_servers\.modcrafting-fabric\.env\]\nMODCRAFTING_DATA = "C:\/data"/)
  assert.equal(result.text.endsWith('\n'), true)
})

test('preserves comments, ordering and unrelated tables', () => {
  const original = '# top\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n\n[projects."/tmp/x"]\ntrust_level = "trusted"\n'
  const result = upsertServerBlock(original, 'modcrafting-fabric', entry)
  assert.equal(result.text.includes('# top'), true)
  assert.equal(result.text.includes('[mcp_servers.other]'), true)
  assert.equal(result.text.includes('[projects."/tmp/x"]'), true)
  assert.equal(result.text.indexOf('[mcp_servers.other]') < result.text.indexOf('[mcp_servers.modcrafting-fabric]'), true)
})

test('is idempotent', () => {
  const first = upsertServerBlock('', 'modcrafting-fabric', entry)
  const second = upsertServerBlock(first.text, 'modcrafting-fabric', entry)
  assert.equal(second.changed, false)
  assert.equal(second.text, first.text)
})

test('replaces an existing block in place and removes stale env', () => {
  const original = `${renderServerBlock('modcrafting-fabric', { command: 'old', args: ['old.js'] })}\n\n[other]\nkey = 1\n`
  const result = upsertServerBlock(original, 'modcrafting-fabric', entry)
  assert.equal(result.changed, true)
  assert.equal(result.text.includes('old.js'), false)
  assert.equal(result.text.includes('command = "node"'), true)
  assert.equal(result.text.includes('[other]'), true)
  assert.equal(result.text.indexOf('[mcp_servers.modcrafting-fabric]') < result.text.indexOf('[other]'), true)
})

test('keeps CRLF documents CRLF', () => {
  const original = 'model = "x"\r\n'
  const result = upsertServerBlock(original, 'modcrafting-fabric', entry)
  assert.equal(result.text.includes('\r\n'), true)
  assert.equal(/[^\r]\n/.test(result.text), false)
})

test('strips a BOM before editing', () => {
  const result = upsertServerBlock('\uFEFFmodel = "x"\n', 'modcrafting-fabric', entry)
  assert.equal(result.text.includes('\uFEFF'), false)
  assert.equal(result.text.includes('model = "x"'), true)
})

test('refuses duplicate blocks', () => {
  const duplicated = `${renderServerBlock('modcrafting-fabric', entry)}\n${renderServerBlock('modcrafting-fabric', entry)}\n`
  assert.throws(() => upsertServerBlock(duplicated, 'modcrafting-fabric', entry), /出现了多次/)
})

test('refuses dotted keys and inline tables', () => {
  assert.throws(() => upsertServerBlock('mcp_servers.modcrafting-fabric.command = "x"\n', 'modcrafting-fabric', entry), /点号键/)
  assert.throws(() => upsertServerBlock('mcp_servers = { x = 1 }\n', 'modcrafting-fabric', entry), /内联表/)
})

test('removes only our blocks', () => {
  const original = `[mcp_servers.other]\ncommand = "x"\n\n${renderServerBlock('modcrafting-fabric', entry)}\n\n[projects]\nkeep = true\n`
  const result = removeServerBlock(original, 'modcrafting-fabric')
  assert.equal(result.changed, true)
  assert.equal(result.text.includes('modcrafting-fabric'), false)
  assert.equal(result.text.includes('[mcp_servers.other]'), true)
  assert.equal(result.text.includes('[projects]'), true)
})

test('removal of an absent block is a no-op', () => {
  const result = removeServerBlock('model = "x"\n', 'modcrafting-fabric')
  assert.equal(result.changed, false)
  assert.equal(result.text, 'model = "x"\n')
})

test('reads back the generated block', () => {
  const block = renderServerBlock('modcrafting-fabric', entry)
  assert.equal(readServerBlock(`model = "x"\n\n${block}\n`, 'modcrafting-fabric'), block)
})

test('quotes keys that are not bare-safe', () => {
  const block = renderServerBlock('modcrafting-fabric', { command: 'node', env: { 'ODD KEY': 'v' } })
  assert.match(block, /"ODD KEY" = "v"/)
})
