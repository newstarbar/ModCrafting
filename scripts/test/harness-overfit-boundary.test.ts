import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { BUILTIN_TOOL_POLICIES } from '../../src/renderer/src/harness/tool-policy.ts'

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

test('current documentation tracks the built-in tool catalogue', () => {
  const count = Object.keys(BUILTIN_TOOL_POLICIES).length
  const documents = [
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/harness.md'
  ]
  for (const file of documents) {
    const content = fs.readFileSync(path.join(root, file), 'utf8')
    assert.equal(
      content.includes(`工具集（${count}）`) || content.includes(`${count} 个内置 AI 工具`) || content.includes(`${count} Tool Definitions`),
      true,
      `${file} must mention the current ${count}-tool catalogue`
    )
  }
})

test('command documentation includes every Test Lab entry point', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>
  const commands = fs.readFileSync(path.join(root, 'docs', 'commands.md'), 'utf8')
  for (const name of Object.keys(scripts).filter((name) => name === 'bridge:build' || name.startsWith('test:'))) {
    assert.match(commands, new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), `docs/commands.md is missing ${name}`)
  }
})
