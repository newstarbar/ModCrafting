import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { appData, assertAbsolute, configHome, dataDir, inside, rootDir, userHome, versionsDir } from '../lib/paths.mjs'

test('MODCRAFTING_HOME overrides the install root but not the user home', () => {
  const previous = { ...process.env }
  process.env.MODCRAFTING_HOME = path.resolve('/tmp/mc-root')
  process.env.HOME = path.resolve('/tmp/home')
  process.env.USERPROFILE = path.resolve('/tmp/home')
  try {
    assert.equal(rootDir(), path.resolve('/tmp/mc-root'))
    assert.equal(versionsDir(), path.join(path.resolve('/tmp/mc-root'), 'versions'))
    assert.equal(dataDir('codex'), path.join(path.resolve('/tmp/mc-root'), 'data', 'codex'))
    assert.equal(userHome(), path.resolve('/tmp/home'))
  } finally {
    process.env = previous
  }
})

test('APPDATA and XDG_CONFIG_HOME are honoured', () => {
  const previous = { ...process.env }
  process.env.APPDATA = path.resolve('/tmp/roaming')
  process.env.XDG_CONFIG_HOME = path.resolve('/tmp/config')
  try {
    assert.equal(appData(), path.resolve('/tmp/roaming'))
    assert.equal(configHome(), path.resolve('/tmp/config'))
  } finally {
    process.env = previous
  }
})

test('inside() rejects siblings and parents', () => {
  assert.equal(inside('/a/b', '/a/b/c'), true)
  assert.equal(inside('/a/b', '/a/b'), true)
  assert.equal(inside('/a/b', '/a/c'), false)
  assert.equal(inside('/a/b', '/a'), false)
})

test('assertAbsolute rejects relative paths', () => {
  assert.throws(() => assertAbsolute('relative/dir', 'MODCRAFTING_DATA'), /absolute path/)
  assert.equal(assertAbsolute(path.resolve('/abs'), 'x'), path.resolve('/abs'))
})
