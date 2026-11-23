import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PANEL_IDS, isPanelId, panelIdSchema } from '../../packages/modcrafting-core/src/panels.ts'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function read(relative: string): string {
  return readFileSync(path.join(repositoryRoot, relative), 'utf8')
}

test('panel ids are unique and non-empty', () => {
  assert.ok(PANEL_IDS.length > 0)
  assert.equal(new Set(PANEL_IDS).size, PANEL_IDS.length, 'duplicate panel id')
  for (const id of PANEL_IDS) assert.match(id, /^[a-z][a-z0-9]*$/, `${id} must be a lowercase identifier`)
})

test('the schema is the same list, in both directions', () => {
  for (const id of PANEL_IDS) {
    assert.equal(panelIdSchema.parse(id), id)
    assert.equal(isPanelId(id), true)
  }
  assert.throws(() => panelIdSchema.parse('marketplace'), 'an id that is not declared must be rejected')
  assert.throws(() => panelIdSchema.parse('Overview'), 'ids are case-sensitive')
  assert.equal(isPanelId('marketplace'), false)
  assert.equal(isPanelId(undefined), false)
  assert.equal(isPanelId(7), false)
})

test('the sidebar derives from the shared id list instead of copying it', () => {
  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.equal(/type Module = '[a-z]+' \|/.test(app), false, 'App.tsx must use PanelId, not its own union')
  assert.equal(/const modules: Array<\{ id:/.test(app), false, 'App.tsx must not declare its own panel array')
  assert.match(app, /PANEL_ORDER\.map/, 'the sidebar must iterate the registry order')
  assert.match(app, /PANEL_META\[activeModule\]/, 'labels must come from the registry')

  const registry = read('packages/modcrafting-view/src/shell/registry.ts')
  assert.match(registry, /readonly PanelId\[\] = PANEL_IDS/, 'PANEL_ORDER must be the shared list, not a copy')
  assert.match(registry, /Record<PanelId, PanelMeta>/, 'the registry must cover every declared panel id')
})

test('the quest panel is wired into both the shell and the MCP surface', () => {
  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.match(app, /activeModule === 'quest'/, 'the shell must render the quest panel')
  assert.match(app, /<QuestPanel/, 'the quest panel must be imported and mounted')

  const core = read('packages/modcrafting-core/src/panels.ts')
  assert.match(core, /'quest'/, 'the shared id list must declare quest')

  const server = read('plugins/modcrafting-fabric/src/mcp-server.ts')
  assert.match(server, /modcrafting_quest_workspace/, 'the MCP surface must expose the quest workspace')
})

test('the MCP surface no longer hard-codes the panel list', () => {
  const source = readFileSync(path.join(repositoryRoot, 'plugins/modcrafting-fabric/src/mcp-server.ts'), 'utf8')
  assert.equal(
    /currentModule:\s*z\.enum\(\[/.test(source),
    false,
    'currentModule must use panelIdSchema, not a hand-written enum'
  )
  assert.equal(
    /recommendedModules:\s*z\.array\(z\.enum\(\[/.test(source),
    false,
    'recommendedModules must use panelIdSchema, not a hand-written enum'
  )
  assert.equal(
    /view:\s*z\.enum\(\['overview'/.test(source),
    false,
    'open_workbench view must use panelIdSchema, not a hand-written enum'
  )
  assert.match(source, /panelIdSchema/, 'mcp-server must import the shared schema')
})
