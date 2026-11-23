#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  FabricRuntime, CoreError, guiWorkspace, guiRequestSchema, createRuntimePaths, ensureRuntimePaths, resolveProjectPath,
  FABRIC_TARGET, inspectFabricProject, lookupMinecraftData, materializeProject, searchFabricDocs, contentWorkspace, contentRequestSchema,
  searchWiki, projectRuntimePaths, validateFabricProject, recipeWorkspace, recipeRequestSchema, gameTestSpecSchema, gameTestTemplate, unsupportedGameTestEvidence,
  textureWorkspace, textureRequestSchema, guiTextureWorkspace, guiTextureRequestSchema,
  testProfileSchema, type GameFeatureType, type ProjectWrapper, voxelWorkspace, voxelRequestSchema,
  resolveTarget, targetSummary, matrix, getRegistry, summarize, capabilitiesFor,
  panelIdSchema, workspaceKinds, questWorkspace, questRequestSchema,
  discoverPack, packDiscoverRequestSchema, packBaseline, packBaselineRequestSchema, createRegistryClient,
  packWorkspaceAction, packActionRequestSchema, bridgeScaffold, bridgeScaffoldRequestSchema,
  transformAction, transformActionRequestSchema
} from '../../../packages/modcrafting-core/src/index.ts'
import { startBrowserView, type BrowserAssets } from './browser-server.ts'
import { openWorkbench, type WorkbenchMode } from './workbench.ts'
import { error, imageResult, metaFor, result } from './output.ts'
import { UI_MIME, uriOf, widgetHtml, type UiPreset } from './mcp-app/ui-resources.ts'
import { runPlan } from './plan.ts'
import type { BundledBuilder, BundledObserver } from '../../../packages/modcrafting-core/src/runtime.ts'

declare const __PLUGIN_VERSION__: string
declare const __WEB_ASSETS__: BrowserAssets
declare const __WIDGET_JS__: string
declare const __PROJECT_WRAPPER__: ProjectWrapper
declare const __OBSERVER__: BundledObserver | undefined
declare const __BUILDER__: BundledBuilder | undefined
const configuredData = process.env.MODCRAFTING_DATA ?? process.env.QODER_PLUGIN_DATA ?? process.env.PLUGIN_DATA ?? process.env.CODEX_PLUGIN_DATA
if (configuredData !== undefined && (!configuredData.trim() || !path.isAbsolute(configuredData))) {
  throw new Error('INVALID_DATA_DIRECTORY: use an absolute writable MODCRAFTING_DATA / PLUGIN_DATA / CODEX_PLUGIN_DATA directory')
}
const dataRoot = configuredData ?? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ModCrafting', 'fabric-plugin')
const paths = createRuntimePaths(dataRoot)
try {
  ensureRuntimePaths(paths)
  const probe = path.join(paths.dataRoot, `.write-check-${process.pid}`)
  fs.writeFileSync(probe, '', { flag: 'wx' }); fs.unlinkSync(probe)
} catch { throw new Error('INVALID_DATA_DIRECTORY: plugin data directory is not writable') }
const runtime = new FabricRuntime({ paths, version: __PLUGIN_VERSION__, observer: __OBSERVER__, builder: __BUILDER__, scaffoldIncludesWrapper: true })
const browserEnabled = process.argv.includes('--web') || process.argv.includes('--web-only')
const portArgument = process.argv.find((value) => value.startsWith('--web-port='))
if (portArgument && !browserEnabled) throw Error('Use --web with --web-port')
const workbenchArgument = process.argv.find((value) => value.startsWith('--workbench='))?.split('=')[1]
if (workbenchArgument && !['system', 'builtin', 'link'].includes(workbenchArgument)) throw Error('Use --workbench=system|builtin|link')
const defaultWorkbenchMode = (workbenchArgument ?? 'system') as 'system' | 'builtin' | 'link'
const planArgument = process.argv.find((value) => value.startsWith('--plan='))
const browser = browserEnabled ? await startBrowserView(runtime, __WEB_ASSETS__, portArgument ? Number(portArgument.split('=')[1]) : 0, { embed: process.argv.includes('--web-embed'), bootstrapSession: process.argv.includes('--web-only') }) : undefined
if (browser) process.stderr.write(`ModCrafting browser: ${browser.url}\n`)

const inputActions = ['key_down', 'key_up', 'key_press', 'press_key', 'mouse_click', 'mouse_move', 'scroll', 'click_at', 'click_widget', 'click_slot', 'set_text', 'forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint', 'use', 'attack', 'inventory', 'drop', 'swap_hands'] as const
function compactJob(job: unknown, tail = 40) {
  if (!job || typeof job !== 'object') return job
  const record = job as Record<string, unknown>
  if (!Array.isArray(record.output)) return job
  const output = record.output as unknown[]
  return { ...record, output: output.slice(-tail), outputLines: output.length, outputTruncated: Math.max(0, output.length - tail) }
}
function compactStatus(value: Record<string, unknown>) {
  const next = { ...value }
  if (next.job) next.job = compactJob(next.job)
  if (next.preparation && typeof next.preparation === 'object') {
    const preparation = { ...(next.preparation as Record<string, unknown>) }
    if (preparation.job) preparation.job = compactJob(preparation.job)
    next.preparation = preparation
  }
  return next
}
function conditionResult(command: string, value: Record<string, unknown>) {
  const data = value.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : {}
  if (/^\s*execute\s+if\s/i.test(command) && value.ok === false && data.accepted === true && data.executed === false && data.error === '测试失败') {
    return { ...value, ok: true, status: 200, data: { ...data, ok: true, condition: false, matched: false, note: '条件不成立；命令语法和执行本身没有失败。' } }
  }
  return value
}
function failure(cause: unknown) {
  const code = cause instanceof CoreError ? cause.code : typeof (cause as { code?: unknown } | null | undefined)?.code === 'string' ? String((cause as { code: string }).code) : 'OPERATION_FAILED'
  return error(String(cause), { code })
}

function buildServer(): McpServer {
  ensureRuntimePaths(paths)
  const server = new McpServer({ name: 'modcrafting-fabric', version: __PLUGIN_VERSION__ })
  server.registerTool('modcrafting_session', { ...metaFor('modcrafting_session'), description: 'Create or manage an isolated task session. Create once at the start of a task, then pass its returned sessionId to every build, game, test, status, stop, and workbench call. Resume before continuing an old session; ending it stops only its jobs and preserves reports. A session binds to one workspace (a single mod project, or a modpack with several member projects); activeMemberId selects which member the authoring tools act on.', inputSchema: z.object({ action: z.enum(['create', 'read', 'resume', 'update', 'end']), sessionId: z.string().optional(), name: z.string().optional(), projectPath: z.string().optional(), workspacePath: z.string().optional(), workspaceKind: z.enum(workspaceKinds).optional(), activeMemberId: z.string().optional(), phase: z.string().optional(), currentModule: panelIdSchema.optional(), recommendedModules: z.array(panelIdSchema).optional() }) }, async (request) => {
    try {
      if (request.action === 'create') return result({ ok: true, session: runtime.createSession({ name: request.name, projectPath: request.projectPath, workspacePath: request.workspacePath, workspaceKind: request.workspaceKind, activeMemberId: request.activeMemberId }) })
      if (!request.sessionId) throw new CoreError('SESSION_REQUIRED', '除 create 外都需要 sessionId。')
      if (request.action === 'read') return result({ ok: true, session: runtime.readSession(request.sessionId) })
      if (request.action === 'resume') return result({ ok: true, session: runtime.resumeSession(request.sessionId) })
      if (request.action === 'end') return result({ ok: true, session: runtime.endSession(request.sessionId) })
      const { action: _action, sessionId, ...changes } = request
      return result({ ok: true, session: runtime.updateSession(sessionId, changes) })
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('modcrafting_test_profile', { ...metaFor('modcrafting_test_profile'), description: 'Read or update the game settings for one task session. Session changes take effect at the next Minecraft launch. Saving as the project default is explicit and writes .modcrafting/test-profile.json.', inputSchema: z.object({ action: z.enum(['read', 'write']), sessionId: z.string().uuid(), projectPath: z.string().optional(), profile: testProfileSchema.optional(), saveAsProjectDefault: z.boolean().default(false) }) }, async (request) => {
    try {
      if (request.action === 'read') return result({ ok: true, sessionId: request.sessionId, profile: runtime.getTestProfile(request.sessionId, request.projectPath) })
      if (!request.profile) throw new CoreError('PROFILE_REQUIRED', '写入配置时需要完整 profile。')
      return result(runtime.setTestProfile(request.sessionId, request.profile, { projectPath: request.projectPath, saveAsProjectDefault: request.saveAsProjectDefault }))
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('minecraft_test_template', { ...metaFor('minecraft_test_template'), description: 'Return a valid GameTestSpec v2 starting template. Edit this object rather than guessing fields; unsupported assertions remain explicitly reported as inconclusive.', inputSchema: z.object({ featureType: z.enum(['new_item', 'new_block', 'new_recipe', 'entity_behavior', 'player_interaction', 'hud_gui']).default('new_item') }) }, async ({ featureType }) => result({ ok: true, spec: gameTestTemplate(featureType as GameFeatureType), schema: gameTestSpecSchema.toJSONSchema() }))
  server.registerTool('modcrafting_open_workbench', { ...metaFor('modcrafting_open_workbench'), description: 'Open the visual workbench for this task session. Pass sessionId and the current project; the workbench shows only that session. mode=builtin returns a hand-off for the host embedded browser (present_files) instead of launching the system browser; mode=link only returns the URL. Returns a link if automatic opening does not work.', inputSchema: z.object({ sessionId: z.string().optional(), projectPath: z.string().optional(), view: panelIdSchema.default('overview'), open: z.boolean().default(true), mode: z.enum(['auto', 'system', 'builtin', 'link']).default('auto') }) }, async (request) => {    try {
      const projectPath = request.projectPath ? resolveProjectPath(request.projectPath) : undefined
      const sessionId = request.sessionId || runtime.createSession({ name: '可视化任务', projectPath }).sessionId
      if (request.sessionId) runtime.resumeSession(sessionId)
      runtime.updateSession(sessionId, { ...(projectPath ? { projectPath } : {}), currentModule: request.view, recommendedModules: [request.view] })
      return result(await openWorkbench(browser?.url, { ...request, sessionId, backendId: runtime.state(sessionId).backendId, defaultMode: defaultWorkbenchMode }))
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('fabric_gui_workspace', { ...metaFor('fabric_gui_workspace'), description: 'Get templates and list/read declarative Screen, configuration and HUD layouts; preview generated Fabric client files before save. Save requires expectedRevision and previewRevision. Unknown or externally modified Java stays read-only; display slots do not implement server containers.', inputSchema: guiRequestSchema }, async request => { try { return result(guiWorkspace(paths, request)) } catch (cause) { return failure(cause) } })
  server.registerTool('fabric_content_workspace', { ...metaFor('fabric_content_workspace'), description: 'List/read supported declarative item, food, block, entity, tool and armor parameters. Entity content may include a base/custom appearance; preview/save accept texturePng base64 and update the managed PNG atomically. Preview changes before save; save requires matching expectedRevision and previewRevision. Handwritten or externally modified generated sources remain read-only. When the project changes Minecraft target, saved objects report requiresMigration instead of silently turning read-only; action=migrate rewrites their resources for the new target.', inputSchema: contentRequestSchema }, async (request) => { try { return result(contentWorkspace(runtime.paths, request)) } catch (cause) { return failure(cause) } })
  server.registerTool('fabric_voxel_workspace', { ...metaFor('fabric_voxel_workspace'), description: 'AI-authored Minecraft-style voxel block/item models. The host agent writes the compact voxel DSL (palette + RLE layers + box ops); this tool never calls an AI service. Workflow: call template for a valid starting object and JSON schema, edit the DSL, call validate to get structured errors, ASCII previews and stats, then preview and save through the content workspace (expectedRevision + previewRevision required; conflicts stay read-only). Compile output is Fabric 1.21.4 model JSON plus a 16px PNG atlas; remind the user to rebuild and check in game. The browser model module is the visual editor for the same DSL.', inputSchema: voxelRequestSchema }, async (request) => { try { return result(voxelWorkspace(runtime.paths, request)) } catch (cause) { return failure(cause) } })
  server.registerTool('fabric_texture_workspace', { ...metaFor('fabric_texture_workspace'), description: 'AI item-texture workspace. Run the whole loop yourself in one turn without asking the user to do manual steps: call prompt to get a generation brief, generate a square PNG with your own image tool, then import (sourcePath/sourceBase64/sourceToken), save, and bind when a content object exists or is being created. The tool removes the background, applies Minecraft-aware pixelization/palette/outline/dither rules, returns quality warnings, and stores candidates. preview is read-only; save needs expectedRevision and previewRevision. Only PNG is accepted; remind the user to rebuild and restart Minecraft for visual validation. The browser workbench textures module is an optional pixel-level polish surface for unsatisfied users, not a required manual step.', inputSchema: textureRequestSchema }, async (request) => { try { const value = textureWorkspace(runtime.paths, request); return imageResult(value, value.image) } catch (cause) { return failure(cause) } })
  server.registerTool('fabric_gui_texture_workspace', { ...metaFor('fabric_gui_texture_workspace'), description: 'Create, read, list and save managed GUI textures for HUD overlays, health-bar art, buff icons and other pixel assets. Textures live under assets/<modid>/textures/gui and are 16–512 px PNG; save is revision-checked and atomic. Use the returned id in a GUI image element. The browser workbench paint module is the visual editor for the same textures.', inputSchema: guiTextureRequestSchema }, async (request) => { try { return result(guiTextureWorkspace(request)) } catch (cause) { return failure(cause) } })
  server.registerTool('fabric_recipe_workspace', { ...metaFor('fabric_recipe_workspace'), description: 'List/read project recipes, search the vanilla/project item catalog, or save a validated recipe using expectedRevision from the last read (null only for new files). The recipe directory and field dialect follow the project\'s Minecraft version, and a file left in the other directory is reported instead of hidden. Shared with the visual recipe editor; refuses external-edit conflicts and unsupported formats. action=migrate rewrites one recipe for the current target and needs confirm=true.', inputSchema: recipeRequestSchema }, async (request) => { try { return result(recipeWorkspace(paths, request)) } catch (cause) { return failure(cause) } })
  server.registerTool('modcrafting_quest_workspace', { ...metaFor('modcrafting_quest_workspace'), description: 'Read and edit an FTB Quests book under config/ftbquests/quests. Workflow: list to see chapters plus the current revision, read to get the graph the workbench renders, then preview with operations and save using the returned previewRevision together with the expectedRevision. Text lives in lang/<locale>.snbt while positions and dependencies live in chapters/*.snbt, so one edit can span two files; save commits all touched files or none. Fields this tool does not model are preserved verbatim. If the pack has no book yet, install FTB Quests and open it once in game, then retry.', inputSchema: questRequestSchema }, async (request) => {
    try { return result(questWorkspace(request.workspacePath, request)) } catch (cause) { return failure(cause) }
  })
  server.registerTool('modcrafting_pack_discover', { ...metaFor('modcrafting_pack_discover'), description: 'Search Modrinth and CurseForge for mods that match a pack idea. Pass a structured intent (goal, features, mustHave, niceToHave, keywords) and a targetId such as fabric@1.21.4. Returns ranked candidates with evidence, coverage and a gap report; nearMiss entries are the concrete inputs for bridge or transform work. CurseForge needs MODCRAFTING_CURSEFORGE_API_KEY; without it the call still returns Modrinth results plus a warning. Results are cached, and offline mode replays the cache instead of failing.', inputSchema: packDiscoverRequestSchema }, async (request) => {
    try {
      const reader = createRegistryClient({
        cacheRoot: path.join(paths.dataRoot, 'registry-cache'),
        curseforgeApiKey: process.env.MODCRAFTING_CURSEFORGE_API_KEY || process.env.CURSEFORGE_API_KEY
      })
      return result({ ...await discoverPack(reader, request) })
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('modcrafting_pack_baseline', { ...metaFor('modcrafting_pack_baseline'), description: 'Read, replace or resolve the shared quality-of-life baseline for a modpack. read returns the workspace override or the shipped groups; write validates and replaces .modcrafting/baseline.json; resolve checks every selected entry against the target loader and Minecraft version, applies mutex/requires rules, substitutes a loader-specific alternative when one exists, and returns picks, required gaps, warnings and ready pack entries. resolve performs registry reads and is cached.', inputSchema: packBaselineRequestSchema }, async (request) => {
    try {
      const reader = createRegistryClient({
        cacheRoot: path.join(paths.dataRoot, 'registry-cache'),
        curseforgeApiKey: process.env.MODCRAFTING_CURSEFORGE_API_KEY || process.env.CURSEFORGE_API_KEY
      })
      return result({ ...await packBaseline(reader, request) })
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('modcrafting_pack_workspace', { ...metaFor('modcrafting_pack_workspace'), description: 'Create, read, edit, solve and export a modpack. Workflow: create writes pack.json once (load on an existing pack); add_entries or add_candidate adds resolved entries; solve closes required dependencies against Modrinth/CurseForge and writes pack.lock.json when the result is satisfied or has only a gap; export writes a .mrpack or a Prism/MultiMC instance under the pack directory. Every edit requires expectedRevision from the last read; a stale revision is refused instead of overwriting external edits. Export refuses a missing or stale lock, and never copies bytes whose license forbids redistribution. add_candidate and solve perform registry reads and are cached.', inputSchema: packActionRequestSchema }, async (request) => {
    try {
      const reader = createRegistryClient({
        cacheRoot: path.join(paths.dataRoot, 'registry-cache'),
        curseforgeApiKey: process.env.MODCRAFTING_CURSEFORGE_API_KEY || process.env.CURSEFORGE_API_KEY
      })
      return result({ ...await packWorkspaceAction(reader, request) })
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('modcrafting_bridge_scaffold', { ...metaFor('modcrafting_bridge_scaffold'), description: 'Generate a compilable Fabric bridge project between two mods that do not know about each other. The project contains an entrypoint, a BridgeAdapter seam with registry (onRegister) and event (onServerStarting) hooks, a mixin config and class, Gradle build files, and a /<modId>-status command. It starts even when one peer is missing and only activates when both are loaded. The target is read from the pack manifest, so the project must be a Fabric pack. Output must be a new or empty directory; the tool refuses mods/ and existing code, and never reads or rewrites the peers\' jars. Next step is filling the adapter TODOs, then building it like any other project.', inputSchema: bridgeScaffoldRequestSchema }, async (request) => {
    try { return result({ ...await bridgeScaffold(request) }) } catch (cause) { return failure(cause) }
  })
  server.registerTool('modcrafting_transform', { ...metaFor('modcrafting_transform'), description: 'Apply, roll back or audit a licence-gated transform for one pack entry. L1 builds a separate resource/data overlay zip; L2 scaffolds a Fabric companion mixin project that targets the source class by string and never puts its jar on the compile classpath. L3 writes a bytecode patch plan and L4 writes a class/resource inventory: this release ships no bytecode engine and no decompiler, so neither modifies the source jar, and both report that plainly. L3/L4 require a modification-permitting licence plus consent=true for this call. A non-redistributable source still transforms locally, but the artifact is marked exportable=false and must not be shipped. The source jar is verified against the manifest hashes and never rewritten; outputs live under transforms/<transformId>/, every apply/refusal/rollback is appended to .modcrafting/transform-audit.jsonl, and rollback removes only artifacts this tool created (a companion project only with deleteProject=true).', inputSchema: transformActionRequestSchema }, async (request) => {
    try { return result({ ...await transformAction(request) }) } catch (cause) { return failure(cause) }
  })
  server.registerTool('modcrafting_environment_status', { ...metaFor('modcrafting_environment_status'), description: 'Check project, Java, cache paths and resource compatibility without downloads. Reports the selected JDK source and candidates; a stale JAVA_HOME is not fatal when a JDK 21 can be discovered. Use modcrafting_toolchain to switch Java without restarting Qoder. An empty folder is a new-project state, not a broken installation. Explain results in plain language; use modcrafting_open_workbench for browser opening.', inputSchema: z.object({ projectPath: z.string().optional() }) }, async ({ projectPath: value }) => { try { return result({ ...await runtime.environmentStatus(value), version: __PLUGIN_VERSION__, projectState: value ? inspectFabricProject(value).valid ? 'existing_project' : 'needs_project' : 'no_project_selected', observer: { bundled: Boolean(__OBSERVER__), version: __OBSERVER__?.version, protocol: __OBSERVER__?.protocol }, builder: runtime.studioInfo(), ...(browser ? { browserUrl: browser.url, browser: { available: true, opened: false } } : {}) }) } catch (cause) { return failure(cause) } })
  server.registerTool('modcrafting_targets', { ...metaFor('modcrafting_targets'), description: 'List which Minecraft versions and mod loaders this build can target, and how far each one has actually been verified. Check this before promising multi-version support: "declared" means the version exists upstream but the build toolchain is unproven, "build-only" means it compiles but has no game-test runtime yet, "supported" means both work. action=target resolves one loader+version pair into the exact mappings, Java level and resource folders that will be generated, which is what you need before writing version-specific code. Never guess a supported version list from memory.', inputSchema: z.object({ action: z.enum(['matrix', 'target']).default('matrix'), loader: z.enum(['fabric', 'neoforge', 'forge']).optional(), minecraft: z.string().min(1).optional() }).strict() }, async ({ action, loader, minecraft }) => {
    try {
      if (action === 'target') {
        if (!loader || !minecraft) throw new CoreError('INVALID_ARGUMENT', 'action=target 需要同时提供 loader 与 minecraft')
        const resolved = resolveTarget(loader, minecraft)
        return result({
          ok: true,
          target: targetSummary(resolved.cell),
          capabilities: capabilitiesFor(resolved),
          layout: { recipeDir: resolved.layout.recipeDir, lootTableDir: resolved.layout.lootTableDir, tagsDir: resolved.layout.tagsDir, itemModelDefinition: resolved.layout.itemModelDefinition, blockstate: resolved.layout.blockstate, recipeIngredient: resolved.layout.recipeIngredient, recipeResult: resolved.layout.recipeResult },
          api: { languageLevel: resolved.api.languageLevel, mapping: resolved.api.mapping, identifier: resolved.api.identifier, food: resolved.api.food, registration: resolved.api.registration, packages: resolved.api.packages }
        })
      }
      const registry = getRegistry()
      return result({ ok: true, targets: matrix(), milestones: registry.milestones(), summary: summarize(registry.cells()), latestRelease: registry.order[0], generatedAt: registry.catalog.generatedAt, sync: registry.catalog.sync, tools: registry.catalog.tools })
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('modcrafting_toolchain', { ...metaFor('modcrafting_toolchain'), description: 'Read, scan for, persist, or clear the JDK 21 used for Gradle builds. `write` validates that javaHome contains java and javac 21 and stores toolchain.json in the data directory, so a stale host JAVA_HOME can be fixed immediately without restarting Qoder. `clear` removes the stored choice.', inputSchema: z.object({ action: z.enum(['read', 'scan', 'write', 'clear']), javaHome: z.string().optional(), projectPath: z.string().optional() }) }, async (request) => { try { return result(await runtime.toolchain(request)) } catch (cause) { return failure(cause) } })
  server.registerTool('modcrafting_prepare_assets', { ...metaFor('modcrafting_prepare_assets'), description: 'Prepare missing knowledge resources. Knowledge data is published per Minecraft version: pass projectPath so the project version is used, or minecraft to request one explicitly. When that version was never published the call says so and lists the versions that exist instead of substituting another version. Pass projectPath to store assets inside that workspace under .modcrafting/knowledge (recommended; travels with the project). Omit to use the backend data directory. Choose only the names needed; healthy resources are reused.', inputSchema: z.object({ names: z.array(z.enum(['minecraft-data', 'mc-wiki-zh', 'mc-wiki-zh-index', 'agent-knowledge'])).min(1).optional(), projectPath: z.string().optional(), minecraft: z.string().min(1).optional() }) }, async ({ names, projectPath, minecraft }) => { try { return result(await runtime.prepareAssets(names, projectPath, minecraft)) } catch (cause) { return failure(cause) } })
  server.registerTool('minecraft_data_lookup', { ...metaFor('minecraft_data_lookup'), description: 'Look up standard Minecraft block, item, entity, enchantment, or recipe data before writing Fabric registration code. Knowledge data is published per Minecraft version, so projectPath is required: it selects the project\'s version and never silently answers from another version. If that version has no data yet the call reports KNOWLEDGE_VERSION_UNAVAILABLE with the versions that are available.', inputSchema: z.object({ kind: z.enum(['block', 'item', 'entity', 'enchantment', 'recipe']), query: z.string().min(1), projectPath: z.string().min(1) }) }, async ({ kind, query, projectPath }) => {
    const project = inspectFabricProject(resolveProjectPath(projectPath))
    return result(lookupMinecraftData(projectRuntimePaths(paths, projectPath), kind, query, { minecraft: project.minecraftVersion, allowFallback: false }))
  })
  server.registerTool('fabric_docs_search', { ...metaFor('fabric_docs_search'), description: 'Search downloaded Fabric documentation by keyword. Pass the projectPath used for preparation to search the project copy; otherwise the backend data directory is searched. When the docs are not downloaded it returns ASSET_NOT_READY and the exact modcrafting_prepare_assets call instead of an empty success; prepare the asset rather than guessing API signatures.', inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(8), projectPath: z.string().optional() }) }, async ({ query, limit, projectPath }) => result(searchFabricDocs(projectRuntimePaths(paths, projectPath), query, limit)))
  server.registerTool('mc_wiki_search', { ...metaFor('mc_wiki_search'), description: 'Search the downloaded Chinese Minecraft knowledge index. Pass the projectPath used for preparation to search the project copy; otherwise the backend data directory is searched.', inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(8), projectPath: z.string().optional() }) }, async ({ query, limit, projectPath }) => result(searchWiki(projectRuntimePaths(paths, projectPath), query, limit)))
  server.registerTool('fabric_project_inspect', { ...metaFor('fabric_project_inspect'), description: 'Inspect a Fabric project without modifying it.', inputSchema: z.object({ projectPath: z.string().min(1) }) }, async ({ projectPath: value }) => { try { return result({ ok: true, project: inspectFabricProject(resolveProjectPath(value)) }) } catch (cause) { return failure(cause) } })
  server.registerTool('fabric_project_scaffold', { ...metaFor('fabric_project_scaffold'), description: 'Create an empty project for any supported target: pass loader (fabric default, neoforge, forge) and minecraft (e.g. 1.20.1, 1.21.4); both default to the pinned Fabric target. Check modcrafting_targets first — the target decides metadata file, resource layout, Java level and build toolchain, and a target whose platform is not implemented is refused with the reason instead of producing a project that cannot build. NeoForge projects get neoforge.mods.toml + ModDevGradle; Forge projects get mods.toml + ForgeGradle. The destination must not already contain files; the first build may download Gradle and dependencies.', inputSchema: z.object({ projectPath: z.string().min(1), modId: z.string().min(2), modName: z.string().min(1), loader: z.enum(['fabric', 'neoforge', 'forge']).optional(), minecraft: z.string().min(1).optional() }) }, async ({ projectPath: value, modId, modName, loader, minecraft }) => { try { return result({ ok: true, project: await materializeProject({ projectPath: value, modId, modName, target: resolveTarget(loader ?? 'fabric', minecraft?.trim() || FABRIC_TARGET.minecraft), wrapper: __PROJECT_WRAPPER__ }) }) } catch (cause) { return failure(cause) } })
  server.registerTool('fabric_validate', { ...metaFor('fabric_validate'), description: 'Validate Fabric metadata, Gradle Wrapper, Minecraft 1.21.4 and project resources. Checks item model definitions in assets/<modid>/items (missing definitions render purple-black), model parents, textures, blockstates, lang JSON, recipe directory and mixin configs. Returns diagnostics with file paths and error/warning levels.', inputSchema: z.object({ projectPath: z.string().min(1) }) }, async ({ projectPath: value }) => { try { return result(validateFabricProject(resolveProjectPath(value))) } catch (cause) { return failure(cause) } })
  server.registerTool('fabric_build_start', { ...metaFor('fabric_build_start'), description: 'Start one project build asynchronously. Builds for the same project run in order. JDK 21 and gradlew.bat are checked before a job is created, so an unusable toolchain returns ENVIRONMENT_UNAVAILABLE immediately instead of a job that fails later. Required: task sessionId.', inputSchema: z.object({ sessionId: z.string().uuid(), projectPath: z.string().min(1), task: z.string().regex(/^[A-Za-z][A-Za-z0-9:.-]*$/).default('build') }) }, async ({ sessionId, projectPath: value, task }) => { try { return result(runtime.startBuild(value, task, sessionId)) } catch (cause) { return failure(cause) } })
  server.registerTool('fabric_job_status', { ...metaFor('fabric_job_status'), description: 'Read a job owned by this task session. Output is tailed; use minecraft_log_read for the full log.', inputSchema: z.object({ sessionId: z.string().uuid(), jobId: z.string().min(1) }) }, async ({ sessionId, jobId }) => result(compactJob(runtime.jobStatus(jobId, sessionId)) as Record<string, unknown>))
  server.registerTool('minecraft_log_read', { ...metaFor('minecraft_log_read'), description: 'Read a page of a job-owned log without returning the whole crash report or Gradle output.', inputSchema: z.object({ sessionId: z.string().uuid(), jobId: z.string().min(1), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() }).strict() }, async ({ sessionId, jobId, offset, limit }) => {
    const value = runtime.jobStatus(jobId, sessionId) as Record<string, unknown>
    const output = Array.isArray(value.output) ? value.output as unknown[] : []
    const start = Math.min(offset ?? 0, output.length), count = limit ?? 200
    return result({ ...value, output: output.slice(start, start + count), offset: start, total: output.length, hasMore: start + count < output.length })
  })
  server.registerTool('fabric_job_stop', { ...metaFor('fabric_job_stop'), description: 'Stop only a long-running job owned by this task session.', inputSchema: z.object({ sessionId: z.string().uuid(), jobId: z.string().min(1) }) }, async ({ sessionId, jobId }) => result(runtime.stopJob(jobId, sessionId)))
  server.registerTool('minecraft_run_client', { ...metaFor('minecraft_run_client'), description: 'Start Minecraft in this task session and return a preparation job. Wait for canRunTests=true before testing. JDK 21, gradlew.bat and the bundled Observer are checked before launch; failures return immediately. The profile is snapshotted at launch.', inputSchema: z.object({ sessionId: z.string().uuid(), projectPath: z.string().min(1), gameDirectory: z.string().optional(), profile: testProfileSchema.optional() }) }, async ({ sessionId, projectPath: value, gameDirectory, profile }) => { try { return result(runtime.runClient(value, gameDirectory, sessionId, profile)) } catch (cause) { return failure(cause) } })
  server.registerTool('minecraft_runtime_status', { ...metaFor('minecraft_runtime_status'), description: 'Read this session’s Minecraft preparation stage, blockers, bridge readiness, and canRunTests flag. Job output is tailed; use minecraft_log_read for the full log.', inputSchema: z.object({ sessionId: z.string().uuid(), instanceId: z.string().optional() }) }, async ({ sessionId, instanceId }) => { try { return result(compactStatus(await runtime.runtimeStatus(instanceId, sessionId))) } catch (cause) { return failure(cause) } })
  server.registerTool('minecraft_stop_client', { ...metaFor('minecraft_stop_client'), description: 'Stop the selected client only if it belongs to this task session.', inputSchema: z.object({ sessionId: z.string().uuid(), instanceId: z.string().optional() }) }, async ({ sessionId, instanceId }) => { try { return result(runtime.stopClient(instanceId, sessionId)) } catch (cause) { return failure(cause) } })
  server.registerTool('minecraft_snapshot', { ...metaFor('minecraft_snapshot'), description: 'Collect a compact Observer V2 snapshot from this session’s ready Minecraft client. By default it returns nearby entities, player/container state and no recipe list or traces. Set full=true only when the full diagnostic dump is needed; prefer minecraft_entity_query or minecraft_widgets for focused reads.', inputSchema: z.object({ sessionId: z.string().uuid(), instanceId: z.string().optional(), radius: z.number().int().min(1).max(64).optional(), includeRecipes: z.boolean().optional(), includeTraces: z.boolean().optional(), traceLimit: z.number().int().min(0).max(256).optional(), includeBlocks: z.boolean().optional(), entityLimit: z.number().int().min(1).max(64).optional(), recipeLimit: z.number().int().min(0).max(500).optional(), full: z.boolean().optional() }).strict() }, async ({ sessionId, instanceId, radius, includeRecipes, includeTraces, traceLimit, includeBlocks, entityLimit, recipeLimit, full }) => {
    try { return result(await runtime.snapshot(instanceId, undefined, sessionId, { radius, includeRecipes: includeRecipes === true, includeTraces: includeTraces === true, traceLimit, includeBlocks: includeBlocks === true, entityLimit, recipeLimit, full: full === true })) }
    catch (cause) { return failure(cause) }
  })
  server.registerTool('minecraft_entity_query', { ...metaFor('minecraft_entity_query'), description: 'Query nearby entities by type, name, command tag or scoreboard team. Returns health, maxHealth, attackDamage, position and identity without the full snapshot. At least one filter is recommended; radius is capped at 64.', inputSchema: z.object({ sessionId: z.string().uuid(), instanceId: z.string().optional(), type: z.string().min(1).optional(), name: z.string().min(1).optional(), tag: z.string().min(1).optional(), team: z.string().min(1).optional(), radius: z.number().int().min(1).max(64).optional(), limit: z.number().int().min(1).max(64).optional() }).strict() }, async ({ sessionId, instanceId, type, name, tag, team, radius, limit }) => { try { return result(await runtime.entityQuery({ type, name, tag, team, radius, limit }, instanceId, sessionId)) } catch (cause) { return failure(cause) } })
  server.registerTool('minecraft_widgets', { ...metaFor('minecraft_widgets'), description: 'Read the current GUI screen: class/title, clickable widgets and container slots. Use this instead of full snapshots when clicking buttons or inspecting an open container.', inputSchema: z.object({ sessionId: z.string().uuid(), instanceId: z.string().optional() }).strict() }, async ({ sessionId, instanceId }) => { try { return result(await runtime.widgets(instanceId, sessionId)) } catch (cause) { return failure(cause) } })
  server.registerTool('minecraft_entity_nbt', { ...metaFor('minecraft_entity_nbt'), description: 'Read one NBT path from one entity selected by a Minecraft selector, e.g. selector="@e[tag=test,limit=1]", path="fabric:attachments". Read-only and restricted to one selector/path; use minecraft_command for other commands.', inputSchema: z.object({ sessionId: z.string().uuid(), instanceId: z.string().optional(), selector: z.string().min(1), path: z.string().min(1) }).strict() }, async ({ sessionId, instanceId, selector, path }) => { try { return result(await runtime.entityNbt(selector, path, instanceId, sessionId)) } catch (cause) { return failure(cause) } })
  server.registerTool('minecraft_screenshot', { ...metaFor('minecraft_screenshot'), description: 'Capture a screenshot from this session’s ready Minecraft client. By default the result contains the PNG path, dimensions and timestamp only; set inline=true only when a base64 image is required. The result is evidence for manual review, not an automatic PASS.', inputSchema: z.object({ sessionId: z.string().uuid(), instanceId: z.string().optional(), inline: z.boolean().optional() }).strict() }, async ({ sessionId, instanceId, inline }) => {
    try {
      const value = await runtime.screenshot(instanceId, sessionId)
      if (inline === true) return result(value)
      const data = { ...(value.data || {}) }
      const omitted = typeof data.base64 === 'string'
      delete data.base64
      return result({ ...value, data: { ...data, inline: false, base64Omitted: omitted } })
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('minecraft_command', { ...metaFor('minecraft_command'), description: 'Run a Minecraft command through the Observer in this task session. A false execute-if condition is returned as ok:true with condition:false, not as a command error.', inputSchema: z.object({ sessionId: z.string().uuid(), command: z.string().min(1), instanceId: z.string().optional() }) }, async ({ sessionId, command, instanceId }) => { try { return result(conditionResult(command, await runtime.command(command, instanceId, sessionId))) } catch (cause) { return failure(cause) } })
  server.registerTool('minecraft_input', { ...metaFor('minecraft_input'), description: 'Send controlled client input. Actions: key_down/key_up/key_press (args: key), press_key (alias for key_press), mouse_click (x,y,button), mouse_move (x,y), scroll (delta), click_at (scaled GUI x,y), click_widget (index or label), click_slot (slot, button?, shift?), set_text (text), and movement presets. Read minecraft_widgets first for GUI coordinates.', inputSchema: z.object({ sessionId: z.string().uuid(), action: z.enum(inputActions), args: z.record(z.string(), z.unknown()).optional(), instanceId: z.string().optional() }).strict() }, async ({ sessionId, action, args, instanceId }) => { try { return result(await runtime.input(action, args, instanceId, sessionId)) } catch (cause) { return failure(cause) } })
  server.registerTool('minecraft_test_start', { ...metaFor('minecraft_test_start'), description: 'Run a typed V2 deterministic game test after canRunTests=true. HUD text, command results, trace sources, live entity tags and visualOnly specs are rejected before launch with CAPABILITY_UNAVAILABLE or MANUAL_ACCEPTANCE_REQUIRED; use minecraft_screenshot for visual review instead of treating INCONCLUSIVE as a pass.', inputSchema: z.object({ sessionId: z.string().uuid(), spec: gameTestSpecSchema, instanceId: z.string().optional() }) }, async ({ sessionId, spec, instanceId }) => {
    const unsupported = unsupportedGameTestEvidence(spec)
    if (unsupported.length) return error(`这个测试包含插件无法自动证明的断言，未启动游戏任务：${unsupported.join('；')}。请改用受支持的断言，或用 minecraft_screenshot 截图后人工验收。`, { code: 'CAPABILITY_UNAVAILABLE', verdict: 'INCONCLUSIVE', remediation: 'Remove unsupported assertions, or use minecraft_screenshot for manual visual acceptance.' })
    if (spec.visualOnly) return error('visualOnly 场景需要人工验收，插件不会把截图观感当作 PASS。请调用 minecraft_screenshot 保存画面并请你确认；需要自动结论时，请移除 visualOnly 并改用受支持的方块/物品/背包断言。', { code: 'MANUAL_ACCEPTANCE_REQUIRED', verdict: 'INCONCLUSIVE', remediation: 'Use minecraft_screenshot and record the user-visible result; do not mark the feature as automatically passed.' })
    try { return result(runtime.startTest(spec, instanceId, sessionId)) }
    catch (cause) {
      if (cause instanceof CoreError) {
        if (cause.code === 'INVALID_SPEC' || cause.code === 'CAPABILITY_UNAVAILABLE' || cause.code === 'MANUAL_ACCEPTANCE_REQUIRED') {
          return error(String(cause), { code: cause.code, verdict: 'INCONCLUSIVE', remediation: cause.code === 'CAPABILITY_UNAVAILABLE' ? 'Remove unsupported assertions, or use minecraft_screenshot for manual visual acceptance.' : cause.code === 'MANUAL_ACCEPTANCE_REQUIRED' ? 'Use minecraft_screenshot and record the user-visible result; do not mark the feature as automatically passed.' : undefined })
        }
        // Missing instance/bridge keeps the established MCP verdict while exposing the precise Core code.
        return error(String(cause), { code: 'ENVIRONMENT_UNAVAILABLE', causeCode: cause.code, verdict: 'INCONCLUSIVE' })
      }
      return error('Minecraft instance or Observer is unavailable', { code: 'ENVIRONMENT_UNAVAILABLE', verdict: 'INCONCLUSIVE' })
    }
  })
  server.registerTool('minecraft_test_status', { ...metaFor('minecraft_test_status'), description: 'Read a deterministic Minecraft test job and report owned by this session.', inputSchema: z.object({ sessionId: z.string().uuid(), jobId: z.string().min(1) }) }, async ({ sessionId, jobId }) => result(runtime.jobStatus(jobId, sessionId)))
  server.registerTool('minecraft_build_studio', { ...metaFor('minecraft_build_studio'),
    description: 'Open a saved structure NBT in the in-game void studio, read back in-game edits, and apply a build to the session test world. Requires the bundled builder component and a ready test world (canRunTests=true). This is the in-game half of the building workflow; the visual building workspace produces the structure file.',
    inputSchema: z.object({
      action: z.enum(['status', 'open', 'commit', 'apply', 'undo', 'exit', 'clear']),
      sessionId: z.string().uuid(),
      instanceId: z.string().optional(),
      projectPath: z.string().optional(),
      buildId: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
      structurePath: z.string().min(1).optional(),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      z: z.number().int().optional(),
      force: z.boolean().default(false),
      teleport: z.boolean().default(true),
      token: z.string().min(1).optional()
    })
  }, async (request) => {
    try {
      if (request.projectPath) runtime.updateSession(request.sessionId, { projectPath: resolveProjectPath(request.projectPath) })
      switch (request.action) {
        case 'status': return result(await runtime.studioStatus(request.instanceId, request.sessionId))
        case 'open': {
          if (!request.buildId || !request.structurePath) throw new CoreError('INVALID_ARGUMENT', 'open 需要 buildId 和 structurePath。')
          if (!path.isAbsolute(request.structurePath)) throw new CoreError('INVALID_ARGUMENT', 'structurePath 必须是绝对路径。')
          return result(await runtime.studioOpen({ buildId: request.buildId, structurePath: request.structurePath, force: request.force }, request.instanceId, request.sessionId))
        }
        case 'commit': {
          if (!request.buildId) throw new CoreError('INVALID_ARGUMENT', 'commit 需要 buildId。')
          return result(await runtime.studioCommit(request.buildId, request.instanceId, request.sessionId))
        }
        case 'apply': {
          if (!request.buildId || request.x === undefined || request.y === undefined || request.z === undefined) throw new CoreError('INVALID_ARGUMENT', 'apply 需要 buildId 和 x/y/z。')
          if (request.structurePath && !path.isAbsolute(request.structurePath)) throw new CoreError('INVALID_ARGUMENT', 'structurePath 必须是绝对路径。')
          return result(await runtime.studioApply({ buildId: request.buildId, structurePath: request.structurePath, x: request.x, y: request.y, z: request.z, force: request.force, teleport: request.teleport }, request.instanceId, request.sessionId))
        }
        case 'undo': return result(await runtime.studioUndo(request.token, request.instanceId, request.sessionId))
        case 'exit': return result(await runtime.studioExit(request.instanceId, request.sessionId))
        case 'clear': return result(await runtime.studioClear(request.buildId, request.force, request.instanceId, request.sessionId))
        default: throw new CoreError('INVALID_ARGUMENT', '未知的 studio 操作。')
      }
    } catch (cause) { return failure(cause) }
  })
  // MCP Apps cards. Read-only: the host pushes structuredContent, the widget never calls back.
  // Non-WorkBuddy hosts simply ignore resources, so this stays additive for Codex/Claude/Qoder.
  const cardTitles: Record<UiPreset, string> = { session: '任务状态', project: '工程状态', media: '素材预览' }
  for (const preset of ['session', 'project', 'media'] as const) {
    server.registerResource(`modcrafting-${preset}-card`, uriOf(preset), {
      title: `ModCrafting ${cardTitles[preset]}`,
      description: 'Read-only inline card for ModCrafting tool results. Rendering data is pushed by the host; the card never calls the server.',
      mimeType: UI_MIME,
      _meta: { ui: { prefersBorder: true } }
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: UI_MIME, text: widgetHtml(preset, __WIDGET_JS__), _meta: { ui: { csp: { connectDomains: [], resourceDomains: ['data:'] } } } }]
    }))
  }
  return server
}

if (process.argv.includes('--self-test')) {
  const server = buildServer()
  console.log(JSON.stringify({ ok: true, name: 'modcrafting-fabric', version: __PLUGIN_VERSION__, registrationOnly: true, server: Boolean(server) }))
  await browser?.close()
} else if (planArgument) {
  // Headless regression: one line of JSON on stdout, progress on stderr, exit 0 even for FAIL or
  // INCONCLUSIVE (both are valid conclusions); only an unreadable/invalid plan exits non-zero.
  try {
    const summary = await runPlan({ runtime, paths, version: __PLUGIN_VERSION__, planPath: planArgument.slice('--plan='.length).replace(/^"|"$/g, '') })
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } catch (cause) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'INVALID_PLAN', error: String(cause) })}\n`)
    process.exitCode = 1
  }
  runtime.close(); await browser?.close()
} else if (process.argv.includes('--web-only')) {
  const close = () => { runtime.close(); void browser?.close() }
  process.once('SIGINT', close); process.once('SIGTERM', close)
} else {
  const handle = serveStdio(() => buildServer())
  const close = () => { runtime.close(); void browser?.close(); void handle.close() }
  process.once('SIGINT', close); process.once('SIGTERM', close); process.stdin.once('end', close)
}
