/**
 * Tool metadata + result shaping for the MCP surface.
 *
 * Every registered tool must appear in TOOLS: annotations tell the host whether a call is
 * read-only, idempotent or touches the outside world, and hosts use that for auto-approval,
 * parallel scheduling and permission prompts. A missing entry is a programming error, not a
 * silent default, so `metaFor` throws.
 */
import { uiMetaFor } from './mcp-app/ui-resources.ts'

export type ToolAnnotations = {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}
type Hint = readonly [title: string, readOnly: boolean, destructive: boolean, idempotent: boolean, openWorld: boolean]

const TOOLS: Record<string, Hint> = {
  modcrafting_session: ['Task session', false, false, false, false],
  modcrafting_test_profile: ['Test profile', false, false, false, false],
  minecraft_test_template: ['Game test template', true, false, true, false],
  modcrafting_open_workbench: ['Open workbench', false, false, false, false],
  fabric_gui_workspace: ['Screen workspace', false, false, false, false],
  fabric_content_workspace: ['Content workspace', false, false, false, false],
  fabric_voxel_workspace: ['Voxel model workspace', false, false, false, false],
  fabric_texture_workspace: ['Texture workspace', false, false, false, false],
  fabric_gui_texture_workspace: ['GUI texture workspace', false, false, false, false],
  fabric_recipe_workspace: ['Recipe workspace', false, false, false, false],
  modcrafting_environment_status: ['Environment status', true, false, true, false],
  modcrafting_targets: ['Target matrix', true, false, true, false],
  modcrafting_toolchain: ['JDK toolchain', false, false, false, false],
  modcrafting_prepare_assets: ['Prepare knowledge assets', false, false, false, true],
  minecraft_data_lookup: ['Vanilla data lookup', true, false, true, false],
  fabric_docs_search: ['Fabric docs search', true, false, true, false],
  mc_wiki_search: ['Minecraft wiki search', true, false, true, false],
  fabric_project_inspect: ['Inspect project', true, false, true, false],
  fabric_project_scaffold: ['Scaffold project', false, false, false, false],
  fabric_validate: ['Validate project', true, false, true, false],
  fabric_build_start: ['Start build', false, false, false, true],
  fabric_job_status: ['Job status', true, false, true, false],
  minecraft_log_read: ['Read job log', true, false, true, false],
  fabric_job_stop: ['Stop job', false, true, false, false],
  minecraft_run_client: ['Launch Minecraft', false, false, false, true],
  minecraft_runtime_status: ['Runtime status', true, false, true, false],
  minecraft_stop_client: ['Stop client', false, true, false, false],
  minecraft_snapshot: ['Observer snapshot', true, false, true, false],
  minecraft_entity_query: ['Entity query', true, false, true, false],
  minecraft_widgets: ['Screen widgets', true, false, true, false],
  minecraft_entity_nbt: ['Entity NBT read', true, false, true, false],
  minecraft_screenshot: ['Screenshot', true, false, false, false],
  minecraft_command: ['Run game command', false, true, false, true],
  minecraft_input: ['Controlled input', false, false, false, false],
  minecraft_test_start: ['Start game test', false, true, false, true],
  minecraft_test_status: ['Game test result', true, false, true, false],
  minecraft_build_studio: ['Build studio', false, true, false, false],
  modcrafting_quest_workspace: ['Quest book workspace', false, false, false, false],
  modcrafting_pack_discover: ['Modpack discovery', true, false, true, true],
  modcrafting_pack_baseline: ['Modpack baseline', false, false, false, true],
  modcrafting_pack_workspace: ['Modpack workspace', false, false, false, true],
  modcrafting_bridge_scaffold: ['Bridge scaffold', false, false, false, false],
  modcrafting_transform: ['Pack transform', false, true, false, false]
}

export function metaFor(name: string): { title: string; annotations: ToolAnnotations; _meta?: Record<string, unknown> } {
  const hint = TOOLS[name]
  if (!hint) throw new Error(`TOOL_META_MISSING: add ${name} to src/output.ts before registering it`)
  const [title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = hint
  const ui = uiMetaFor(name)
  return { title, annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }, ...(ui ? { _meta: ui } : {}) }
}

/** `--text=digest` keeps model-facing text small while sending the full value as structuredContent. */
const digestMode = process.argv.includes('--text=digest')
const TEXT_LIMIT = 3000
const KEEP_VERBATIM = new Set(['ok', 'code', 'error', 'verdict', 'sessionId', 'jobId', 'instanceId', 'reportPath', 'paths', 'remediation', 'nextSteps', 'contractVersion', 'version', 'revision', 'previewRevision', 'expectedRevision'])

function digest(value: unknown, depth = 0): unknown {
  if (depth > 3) return '…'
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…(+${value.length - 400})` : value
  if (Array.isArray(value)) return value.length > 8 ? [...value.slice(0, 8).map((item) => digest(item, depth + 1)), `…+${value.length - 8}`] : value.map((item) => digest(item, depth + 1))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = KEEP_VERBATIM.has(key) ? item : digest(item, depth + 1)
    return output
  }
  return value
}

export function result(value: Record<string, unknown>) {
  if (!digestMode) return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value }
  const text = JSON.stringify(digest(value), null, 2)
  return {
    content: [{ type: 'text' as const, text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…完整数据在 structuredContent 中` : text }],
    structuredContent: value
  }
}

export function imageResult(value: Record<string, unknown>, image?: unknown) {
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text' as const, text: JSON.stringify(digestMode ? digest(value) : value, null, 2) }]
  if (typeof image === 'string') {
    const match = /^data:(image\/png);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image)
    if (match) content.push({ type: 'image' as const, data: match[2], mimeType: match[1] })
  }
  return { content, structuredContent: value }
}

export function error(message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2) }], isError: true }
}
