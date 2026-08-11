import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const harnessRoot = path.join(root, 'src', 'renderer', 'src', 'harness')

test('production Harness does not import Test Lab scenarios or sample semantic validators', () => {
  const sources = fs.readdirSync(harnessRoot).filter((name) => name.endsWith('.ts')).map((name) => fs.readFileSync(path.join(harnessRoot, name), 'utf8')).join('\n')
  assert.doesNotMatch(sources, /scripts\/test\/scenarios|plan-semantic-validation/)
})

test('black-box complex scenarios remain outside production source', () => {
  const fixtures = fs.readdirSync(path.join(root, 'scripts', 'test', 'scenarios')).filter((name) => name.endsWith('.json'))
  assert.deepEqual(fixtures.sort(), ['death-rewind.json', 'kill-feed-hud.json', 'player-morph-toggle.json'])
})
