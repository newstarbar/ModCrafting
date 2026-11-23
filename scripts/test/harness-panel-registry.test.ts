import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PANEL_IDS, isPanelId, panelIdSchema } from '../../packages/modcrafting-core/src/panels.ts'
import { PANEL_META, PANEL_ORDER, SCOPE_LABELS, SCOPE_ORDER, panelGroups, visiblePanels } from '../../packages/modcrafting-view/src/shell/registry.ts'

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
  assert.match(read('packages/modcrafting-view/src/shell/WorkbenchShell.tsx'), /navigation\.map/, 'the sidebar must iterate the grouped registry')
  assert.match(app, /PANEL_META\[activeModule\]/, 'labels must come from the registry')

  const registry = read('packages/modcrafting-view/src/shell/registry.ts')
  assert.match(registry, /readonly PanelId\[\] = PANEL_IDS/, 'PANEL_ORDER must be the shared list, not a copy')
  assert.match(registry, /Record<PanelId, PanelMeta>/, 'the registry must cover every declared panel id')
})

test('a modpack sees both pack and mod panels; a single mod never sees pack panels', () => {
  const packIds = visiblePanels('modpack').map((entry) => entry.id)
  const modIds = visiblePanels('mod').map((entry) => entry.id)
  assert.ok(packIds.includes('quest'), 'a modpack must be able to open the quest book')
  assert.ok(packIds.includes('content'), 'a modpack can still author its member projects')
  assert.equal(modIds.includes('quest'), false, 'a single mod has no pack-level quest book')
  assert.deepEqual([...modIds].sort(), [...visiblePanels(undefined).map((entry) => entry.id)].sort(), 'unknown kind behaves like mod')
  assert.equal(new Set(packIds).size, packIds.length, 'visibility must not duplicate a panel')
})

test('navigation groups follow the declared scope order and never render an empty section', () => {
  const groups = panelGroups('modpack')
  assert.deepEqual(groups.map((group) => group.scope), SCOPE_ORDER.filter((scope) => groups.some((group) => group.scope === scope)))
  assert.deepEqual(groups.map((group) => group.label), groups.map((group) => SCOPE_LABELS[group.scope]))
  for (const group of groups) assert.ok(group.entries.length > 0, `${group.scope} group must not be empty`)
  assert.deepEqual(groups.flatMap((group) => group.entries.map((entry) => entry.id)).sort(), [...PANEL_ORDER].sort(), 'every declared panel appears exactly once')
})

test('the shell owns a three-column layout with a mobile navigation fallback', () => {
  const shell = read('packages/modcrafting-view/src/shell/WorkbenchShell.tsx')
  assert.match(shell, /workbench-context/, 'the shell must render the context column')
  assert.match(shell, /aria-label="工作区上下文"/, 'the context column needs an accessible name')
  assert.match(shell, /panelGroups\(/, 'the shell must derive navigation from the shared registry')
  assert.match(shell, /mobile-nav/, 'the shell must keep a navigation control on narrow screens')

  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.match(app, /<WorkbenchShell/, 'App must compose the shell instead of repeating its layout')
  assert.equal(/workbench-sidebar/.test(app), false, 'the sidebar belongs to the shell, not to App')
  assert.equal(/mobile-nav/.test(app), false, 'the mobile nav belongs to the shell, not to App')

  const css = read('packages/modcrafting-view/src/view.css')
  assert.match(css, /\.workbench-shell\{display:grid;grid-template-columns:205px 230px minmax\(0,1fr\)/, 'the desktop shell must be three columns')
  assert.match(css, /\.workbench-context\{/, 'the context column needs its own layout rules')
})

test('the instance scope owns runtime panels and is reachable from every workspace', () => {
  assert.equal(PANEL_META.game.scope, 'instance')
  assert.equal(PANEL_META.tests.scope, 'instance')
  const modpack = panelGroups('modpack')
  const mod = panelGroups('mod')
  const instanceEntries = (groups: ReturnType<typeof panelGroups>) =>
    groups.find((group) => group.scope === 'instance')?.entries.map((entry) => entry.id) ?? []
  assert.ok(instanceEntries(modpack).includes('game'), 'a modpack can still launch a test instance')
  assert.ok(instanceEntries(modpack).includes('tests'), 'a modpack can still run game tests')
  assert.deepEqual(instanceEntries(mod).sort(), ['game', 'tests'], 'a single mod sees the same instance panels')
})

test('page-level empty and error states come from one shell component', () => {
  const state = read('packages/modcrafting-view/src/shell/PanelState.tsx')
  assert.match(state, /export function PanelEmptyState/)
  assert.match(state, /export function PanelErrorState/)
  for (const panel of ['pack/PackPanel.tsx', 'discover/DiscoverPanel.tsx', 'baseline/BaselinePanel.tsx', 'bridge/BridgePanel.tsx', 'transform/TransformPanel.tsx']) {
    assert.match(read(`packages/modcrafting-view/src/panels/${panel}`), /PanelEmptyState|PanelErrorState/, `${panel} must use the shared state component`)
  }
})

test('the shell renders panels through a registry instead of an if chain', () => {
  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.match(app, /Record<PanelId, \(\) => ReactNode>/, 'the shell must map every panel id to a renderer')
  assert.equal(/if \(activeModule === '/.test(app), false, 'adding a panel must not require another if branch')
  assert.match(app, /panelGroups\(/, 'the sidebar must derive grouped navigation from the registry')
})

test('the discover panel is modpack-only and mounted on both surfaces', () => {
  const packIds = visiblePanels('modpack').map((entry) => entry.id)
  const modIds = visiblePanels('mod').map((entry) => entry.id)
  assert.ok(packIds.includes('discover'), 'a modpack must be able to search the community')
  assert.equal(modIds.includes('discover'), false, 'community search belongs to a pack, not a single mod')

  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.match(app, /discover:\s*\(\)\s*=>/, 'the shell must mount the discover panel')
  assert.match(app, /<DiscoverPanel/, 'the discover panel must be imported and mounted')

  const server = read('plugins/modcrafting-fabric/src/mcp-server.ts')
  assert.match(server, /modcrafting_pack_discover/, 'the MCP surface must expose pack discovery')
})

test('the baseline panel is modpack-only and mounted on both surfaces', () => {
  const packIds = visiblePanels('modpack').map((entry) => entry.id)
  const modIds = visiblePanels('mod').map((entry) => entry.id)
  assert.ok(packIds.includes('baseline'))
  assert.equal(modIds.includes('baseline'), false)

  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.match(app, /baseline:\s*\(\)\s*=>/, 'the shell must mount the baseline panel')
  assert.match(app, /<BaselinePanel/, 'the baseline panel must be imported and mounted')
  assert.match(read('plugins/modcrafting-fabric/src/mcp-server.ts'), /modcrafting_pack_baseline/)
})

test('the pack panel is modpack-only and mounted on both surfaces', () => {
  const packIds = visiblePanels('modpack').map((entry) => entry.id)
  const modIds = visiblePanels('mod').map((entry) => entry.id)
  assert.ok(packIds.includes('pack'), 'a modpack needs its own manifest/lock/export tab')
  assert.equal(modIds.includes('pack'), false, 'a single mod has no pack manifest')

  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.match(app, /pack:\s*\(\)\s*=>/, 'the shell must mount the pack panel')
  assert.match(app, /<PackPanel/, 'the pack panel must be imported and mounted')

  const server = read('plugins/modcrafting-fabric/src/mcp-server.ts')
  assert.match(server, /modcrafting_pack_workspace/, 'the MCP surface must expose the pack workspace')
})

test('the bridge panel is modpack-only and mounted on both surfaces', () => {
  const packIds = visiblePanels('modpack').map((entry) => entry.id)
  const modIds = visiblePanels('mod').map((entry) => entry.id)
  assert.ok(packIds.includes('bridge'), 'a modpack needs a place to author bridge projects')
  assert.equal(modIds.includes('bridge'), false, 'a bridge is a pack-level compatibility project')

  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.match(app, /bridge:\s*\(\)\s*=>/, 'the shell must mount the bridge panel')
  assert.match(app, /<BridgePanel/, 'the bridge panel must be imported and mounted')

  const server = read('plugins/modcrafting-fabric/src/mcp-server.ts')
  assert.match(server, /modcrafting_bridge_scaffold/, 'the MCP surface must expose bridge scaffolding')
})

test('the transform panel is modpack-only and mounted on both surfaces', () => {
  const packIds = visiblePanels('modpack').map((entry) => entry.id)
  const modIds = visiblePanels('mod').map((entry) => entry.id)
  assert.ok(packIds.includes('transform'), 'a modpack needs a place to review and apply transforms')
  assert.equal(modIds.includes('transform'), false, 'transforming a third-party mod is a pack-level decision')

  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.match(app, /transform:\s*\(\)\s*=>/, 'the shell must mount the transform panel')
  assert.match(app, /<TransformPanel/, 'the transform panel must be imported and mounted')

  const server = read('plugins/modcrafting-fabric/src/mcp-server.ts')
  assert.match(server, /modcrafting_transform/, 'the MCP surface must expose transforms')
  const browser = read('plugins/modcrafting-fabric/src/browser-server.ts')
  assert.match(browser, /z\.literal\('transform'\)/, 'the browser must accept a transform operation')
  assert.match(browser, /transformAction\(/, 'the browser operation must call the shared transform action')
})

test('discovery and baseline can hand their picks to the pack manifest', () => {
  const discover = read('packages/modcrafting-view/src/panels/discover/DiscoverPanel.tsx')
  assert.match(discover, /add_candidate/, 'a discovered candidate must be installable from the discovery panel')
  assert.match(discover, /workspacePath/, 'discovery needs to know which pack it is adding to')

  const baseline = read('packages/modcrafting-view/src/panels/baseline/BaselinePanel.tsx')
  assert.match(baseline, /add_entries/, 'resolved baseline picks must be installable')
  assert.match(baseline, /expectedRevision/, 'adding to the manifest must carry the revision it read')
})

test('the quest panel is wired into both the shell and the MCP surface', () => {
  const app = read('packages/modcrafting-view/src/App.tsx')
  assert.match(app, /quest:\s*\(\)\s*=>/, 'the renderer registry must mount the quest panel')
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
