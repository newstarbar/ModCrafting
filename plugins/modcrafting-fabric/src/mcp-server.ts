#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GAME_TEST_WORLD,
  JobManager,
  SystemToolchainProvider,
  bridgeRequest,
  createRuntimePaths,
  ensureRuntimePaths,
  inspectFabricProject,
  lookupMinecraftData,
  prepareAssets,
  readBridgeDiscovery,
  scaffoldFabricProject,
  searchFabricDocs,
  searchWiki,
  testVerdict,
  validateFabricProject,
  validateGameTestSpec,
  writeGameTestReport,
  type BridgeDiscovery,
  type GameAction,
  type GameAssertion,
  type GameTestSpec
} from '../../../packages/modcrafting-core/src/index.ts'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = process.env.PLUGIN_DATA || process.env.CODEX_PLUGIN_DATA || path.join(pluginRoot, '.data')
const paths = createRuntimePaths(dataRoot)
const toolchain = new SystemToolchainProvider()
const jobs = new JobManager()
const gameInstances = new Map<string, { projectPath: string; gameDirectory: string; jobId: string; discovery?: BridgeDiscovery }>()

function result(value: Record<string, unknown>) { return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value } }
function error(message: string, extra: Record<string, unknown> = {}) { return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2) }], isError: true } }
function projectPath(value: string): string { const resolved = path.resolve(value); if (!fs.existsSync(resolved)) throw new Error('projectPath does not exist'); return resolved }
function instance(id?: string) { const value = id ? gameInstances.get(id) : Array.from(gameInstances.values()).at(-1); if (!value) throw new Error('no Minecraft instance is running'); return value }
function activeDiscovery(id?: string): BridgeDiscovery { const current = instance(id); current.discovery ||= readBridgeDiscovery(current.gameDirectory) || undefined; if (!current.discovery) throw new Error('Observer bridge is not ready; wait for minecraft_runtime_status'); return current.discovery }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 10_000))))
function syncBaseMods(gameDirectory: string): void {
  const source = path.join(paths.assetsRoot, 'base-mods')
  if (!fs.existsSync(source)) throw new Error('base mods are unavailable; run modcrafting_prepare_assets first')
  const destination = path.join(gameDirectory, 'mods')
  fs.mkdirSync(destination, { recursive: true })
  const jars: string[] = []
  const walk = (directory: string) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.toLowerCase().endsWith('.jar')) jars.push(file) } }
  walk(source)
  if (!jars.some((file) => /modcrafting-observer/i.test(path.basename(file)))) throw new Error('Observer V2 jar is missing from prepared base mods')
  for (const jar of jars) fs.copyFileSync(jar, path.join(destination, path.basename(jar)))
}

async function runAction(discovery: BridgeDiscovery, action: GameAction): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  if (action.type === 'wait') { await delay(action.ms); return { ok: true, data: {} } }
  if (action.type === 'input') { const call = await bridgeRequest(discovery, 'POST', '/v1/input', { action: action.action, ...(action.args || {}) }); return { ok: call.ok, data: call.data } }
  const call = await bridgeRequest(discovery, 'POST', '/v2/command', { command: action.command }); return { ok: call.ok && call.data.executed === true, data: call.data }
}
async function snapshot(discovery: BridgeDiscovery) { return bridgeRequest(discovery, 'POST', '/v2/snapshot', { blocks: [{ x: 0, y: 100, z: 4 }], entityRadius: 32, includeRecipes: true }) }
function assertionResult(assertion: GameAssertion, before: Record<string, unknown>, after: Record<string, unknown>): { passed: boolean; unavailable?: boolean; detail: string } {
  if (assertion.type === 'inventory_contains') { const inventory = after.inventory as Record<string, unknown> || {}; const entries = ['hotbar', 'main', 'armor', 'offhand'].flatMap((key) => Array.isArray(inventory[key]) ? inventory[key] as Record<string, unknown>[] : []); const count = entries.filter((item) => item.id === assertion.itemId).reduce((sum, item) => sum + Number(item.count || 0), 0); return { passed: count >= (assertion.countAtLeast || 1), detail: `inventory ${assertion.itemId}: ${count}` } }
  if (assertion.type === 'block_equals') { const block = (after.blocks as Record<string, unknown>[] || []).find((item) => item.x === assertion.x && item.y === assertion.y && item.z === assertion.z); return { passed: block?.blockId === assertion.blockId, detail: `block ${String(block?.blockId || 'missing')}` } }
  if (assertion.type === 'entity_exists') { const found = (after.entities as Record<string, unknown>[] || []).some((item) => (!assertion.entityType || item.type === assertion.entityType) && (!assertion.tag || (item.tags as string[] || []).includes(assertion.tag))); return { passed: found === (assertion.exists ?? true), detail: `entity expected=${assertion.exists ?? true}` } }
  if (assertion.type === 'hud_text') { const trace = after.hudTrace; if (!Array.isArray(trace)) return { passed: false, unavailable: true, detail: 'HUD trace unavailable' }; const found = trace.some((item) => assertion.match === 'exact' ? item.text === assertion.text : String(item.text || '').includes(assertion.text)); return { passed: found, detail: `HUD ${assertion.text}` } }
  if (assertion.type === 'snapshot_value' || assertion.type === 'snapshot_changed') { const get = (value: Record<string, unknown>) => assertion.pointer.slice(1).split('/').reduce<unknown>((current, raw) => current && typeof current === 'object' ? (current as Record<string, unknown>)[raw.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined, value[assertion.source]); const beforeValue = get(before); const afterValue = get(after); if (afterValue === undefined) return { passed: false, unavailable: true, detail: `snapshot source ${assertion.source} unavailable` }; if (assertion.type === 'snapshot_value') return { passed: JSON.stringify(afterValue) === JSON.stringify(assertion.equals), detail: `${assertion.source}${assertion.pointer}` }; return { passed: (assertion.from === undefined || JSON.stringify(beforeValue) === JSON.stringify(assertion.from)) && (assertion.to === undefined ? JSON.stringify(beforeValue) !== JSON.stringify(afterValue) : JSON.stringify(afterValue) === JSON.stringify(assertion.to)), detail: `${assertion.source}${assertion.pointer} changed` } }
  return { passed: false, unavailable: true, detail: 'command_result assertions are unsupported in async test start; use command in setup/actions' }
}

function buildServer(): McpServer {
  ensureRuntimePaths(paths)
  const server = new McpServer({ name: 'modcrafting-fabric', version: '0.1.0' })
  server.registerTool('modcrafting_environment_status', { description: 'Check the Windows, JDK 21, Gradle Wrapper and Fabric 1.21.4 prerequisites without changing the system.', inputSchema: z.object({ projectPath: z.string().optional() }) }, async ({ projectPath: value }) => result({ ok: true, ...(await toolchain.status(value) ) }))
  server.registerTool('modcrafting_prepare_assets', { description: 'Download ModCrafting knowledge and test assets to the plugin data directory. Uses gh.xmly.dev first, then GitHub direct.', inputSchema: z.object({}) }, async () => { try { return result({ ok: true, assets: await prepareAssets(paths), dataRoot: paths.dataRoot }) } catch (cause) { return error(String(cause)) } })
  server.registerTool('minecraft_data_lookup', { description: 'Look up standard Minecraft block, item, entity, enchantment, or recipe data before writing Fabric registration code.', inputSchema: z.object({ kind: z.enum(['block', 'item', 'entity', 'enchantment', 'recipe']), query: z.string().min(1) }) }, async ({ kind, query }) => result(lookupMinecraftData(paths, kind, query)))
  server.registerTool('fabric_docs_search', { description: 'Search downloaded Fabric documentation by keyword.', inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(8) }) }, async ({ query, limit }) => result(searchFabricDocs(paths, query, limit)))
  server.registerTool('mc_wiki_search', { description: 'Search the downloaded Chinese Minecraft knowledge index.', inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(8) }) }, async ({ query, limit }) => result(searchWiki(paths, query, limit)))
  server.registerTool('fabric_project_inspect', { description: 'Inspect a Fabric project without modifying it.', inputSchema: z.object({ projectPath: z.string().min(1) }) }, async ({ projectPath: value }) => { try { return result({ ok: true, project: inspectFabricProject(projectPath(value)) }) } catch (cause) { return error(String(cause)) } })
  server.registerTool('fabric_project_scaffold', { description: 'Create an empty Fabric 1.21.4 project. The destination must not already contain files.', inputSchema: z.object({ projectPath: z.string().min(1), modId: z.string().min(2), modName: z.string().min(1) }) }, async ({ projectPath: value, modId, modName }) => { try { return result({ ok: true, project: await scaffoldFabricProject(value, modId, modName) }) } catch (cause) { return error(String(cause)) } })
  server.registerTool('fabric_validate', { description: 'Validate Fabric metadata, Gradle Wrapper and Minecraft version constraints.', inputSchema: z.object({ projectPath: z.string().min(1) }) }, async ({ projectPath: value }) => { try { return result(validateFabricProject(projectPath(value))) } catch (cause) { return error(String(cause)) } })
  server.registerTool('fabric_build_start', { description: 'Start a Gradle build, test, datagen, or other explicitly requested task asynchronously.', inputSchema: z.object({ projectPath: z.string().min(1), task: z.string().regex(/^[A-Za-z][A-Za-z0-9:.-]*$/).default('build') }) }, async ({ projectPath: value, task }) => { try { const root = projectPath(value); const id = jobs.start('build', async (job) => { const child = await toolchain.startGradle(root, task, { onLog: (_, line) => job.output.push(line) }); job.setChild(child); const code = await new Promise<number>((resolve) => child.once('close', (value) => resolve(value ?? -1))); if (code !== 0) throw new Error(`Gradle ${task} exited ${code}`); return { ok: true, task, exitCode: code } }); return result({ ok: true, jobId: id }) } catch (cause) { return error(String(cause)) } })
  server.registerTool('fabric_job_status', { description: 'Read the current state and recent output of a build, game, or test job.', inputSchema: z.object({ jobId: z.string().min(1) }) }, async ({ jobId }) => result(jobs.status(jobId)))
  server.registerTool('fabric_job_stop', { description: 'Stop a plugin-owned long-running Gradle, Minecraft, or test job.', inputSchema: z.object({ jobId: z.string().min(1) }) }, async ({ jobId }) => result(jobs.stop(jobId)))
  server.registerTool('minecraft_run_client', { description: 'Start runClient through the project Gradle Wrapper. This requires system JDK 21, prepared base mods, and does not download a toolchain.', inputSchema: z.object({ projectPath: z.string().min(1), gameDirectory: z.string().optional() }) }, async ({ projectPath: value, gameDirectory }) => { try { const root = projectPath(value); const gameDir = path.resolve(gameDirectory || path.join(root, 'run', 'modcrafting-fabric')); fs.mkdirSync(gameDir, { recursive: true }); syncBaseMods(gameDir); const gameArgs = `--args=--gameDir \"${gameDir.replace(/\\/g, '/')}\"`; const id = jobs.start('minecraft', async (job) => { const child = await toolchain.startGradle(root, 'runClient', { onLog: (_, line) => job.output.push(line) }, [gameArgs]); job.setChild(child); const code = await new Promise<number>((resolve) => child.once('close', (value) => resolve(value ?? -1))); return { exitCode: code } }); const instanceId = `instance_${Date.now().toString(36)}`; gameInstances.set(instanceId, { projectPath: root, gameDirectory: gameDir, jobId: id }); return result({ ok: true, instanceId, jobId: id, gameDirectory: gameDir }) } catch (cause) { return error(String(cause)) } })
  server.registerTool('minecraft_runtime_status', { description: 'Read Minecraft job status and Observer V2 readiness.', inputSchema: z.object({ instanceId: z.string().optional() }) }, async ({ instanceId }) => { try { const current = instance(instanceId); current.discovery ||= readBridgeDiscovery(current.gameDirectory) || undefined; const capabilities = current.discovery ? await bridgeRequest(current.discovery, 'GET', '/v2/capabilities') : undefined; return result({ ok: true, job: jobs.status(current.jobId), gameDirectory: current.gameDirectory, bridgeReady: Boolean(capabilities?.ok && capabilities.data.protocolVersion === 2), capabilities: capabilities?.data }) } catch (cause) { return error(String(cause)) } })
  server.registerTool('minecraft_stop_client', { description: 'Stop the selected plugin-owned Minecraft client.', inputSchema: z.object({ instanceId: z.string().optional() }) }, async ({ instanceId }) => { try { const current = instance(instanceId); return result(jobs.stop(current.jobId)) } catch (cause) { return error(String(cause)) } })
  server.registerTool('minecraft_snapshot', { description: 'Collect an Observer V2 snapshot from a running Minecraft client.', inputSchema: z.object({ instanceId: z.string().optional() }) }, async ({ instanceId }) => { try { const call = await snapshot(activeDiscovery(instanceId)); return result(call) } catch (cause) { return error(String(cause)) } })
  server.registerTool('minecraft_command', { description: 'Run a Minecraft command through Observer V2 and return its structured result.', inputSchema: z.object({ command: z.string().min(1), instanceId: z.string().optional() }) }, async ({ command, instanceId }) => { try { return result(await bridgeRequest(activeDiscovery(instanceId), 'POST', '/v2/command', { command })) } catch (cause) { return error(String(cause)) } })
  server.registerTool('minecraft_input', { description: 'Send controlled client input through the local Observer bridge.', inputSchema: z.object({ action: z.string().min(1), args: z.record(z.string(), z.unknown()).optional(), instanceId: z.string().optional() }) }, async ({ action, args, instanceId }) => { try { return result(await bridgeRequest(activeDiscovery(instanceId), 'POST', '/v1/input', { action, ...(args || {}) })) } catch (cause) { return error(String(cause)) } })
  server.registerTool('minecraft_test_start', { description: 'Run a V2 deterministic game test asynchronously. Tests only pass in the dedicated ModCrafting Test World.', inputSchema: z.object({ spec: z.unknown(), instanceId: z.string().optional() }) }, async ({ spec: raw, instanceId }) => { const parsed = validateGameTestSpec(raw); if (!parsed.ok) return error(parsed.error); try { const current = instance(instanceId); const id = jobs.start('game_test', async () => { const discovery = activeDiscovery(instanceId); const initial = await snapshot(discovery); if (!initial.ok || initial.data.worldName !== GAME_TEST_WORLD) return { verdict: 'INCONCLUSIVE', reason: `tests require ${GAME_TEST_WORLD}` }; for (const action of parsed.spec.setup) { const value = await runAction(discovery, action); if (!value.ok) return { verdict: 'INCONCLUSIVE', reason: `setup action failed: ${action.type}` } }; const before = await snapshot(discovery); for (const action of parsed.spec.actions) { const value = await runAction(discovery, action); if (!value.ok) return { verdict: 'INCONCLUSIVE', reason: `action failed: ${action.type}` } }; const after = await snapshot(discovery); const evidence = parsed.spec.assertions.map((assertion) => ({ assertion, ...assertionResult(assertion, before.data, after.data) })); for (const action of parsed.spec.cleanup) await runAction(discovery, action); const verdict = testVerdict(evidence, Boolean(parsed.spec.visualOnly)); const reportPath = await writeGameTestReport(paths, parsed.spec.id, { spec: parsed.spec, instanceId, gameDirectory: current.gameDirectory, verdict, evidence, createdAt: new Date().toISOString() }); return { verdict, evidence, reportPath } }); return result({ ok: true, jobId: id, scenarioId: parsed.spec.id }) } catch (cause) { return error(String(cause)) } })
  server.registerTool('minecraft_test_status', { description: 'Read a deterministic Minecraft test job and its report result.', inputSchema: z.object({ jobId: z.string().min(1) }) }, async ({ jobId }) => result(jobs.status(jobId)))
  return server
}

if (process.argv.includes('--self-test')) {
  const server = buildServer()
  console.log(JSON.stringify({ ok: true, name: 'modcrafting-fabric', tools: 19, server: Boolean(server) }))
} else {
  const handle = serveStdio(() => buildServer())
  const close = () => { jobs.stopAll(); void handle.close() }
  process.once('SIGINT', close); process.once('SIGTERM', close)
}
