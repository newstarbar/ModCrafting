#!/usr/bin/env node
/**
 * WorkBuddy package smoke test.
 *
 * What this proves: the package structure validates, the hooks really execute and return the
 * documented shapes with exit code 0, and the packaged MCP config starts and behaves.
 * What this does NOT prove: how WorkBuddy renders inline cards, how its permission dialog looks,
 * or whether a real mod runs in a real game. Those stay manual acceptance items.
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { validateWorkbuddy } from './validate-workbuddy.mjs'
import { EXPECTED_TOOL_COUNT } from './tool-count.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = path.resolve(process.argv[2] || path.join(root, 'temp/plugin-artifacts/modcrafting-workbuddy'))
validateWorkbuddy(source, true)

const scope = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-workbuddy-smoke-'))
const stage = path.join(scope, 'plugin')
await cp(source, stage, { recursive: true })
const data = path.join(scope, 'data')
const sessions = path.join(data, 'sessions'), stateDirectory = path.join(data, 'workbuddy')
await mkdir(sessions, { recursive: true })
await mkdir(stateDirectory, { recursive: true })

const sessionId = '11111111-2222-4333-8444-555555555555'
const now = new Date().toISOString()
await writeFile(path.join(sessions, `${sessionId}.json`), JSON.stringify({ schemaVersion: 1, sessionId, name: '冒烟任务', status: 'active', phase: '正在构建', projectPath: path.join(scope, 'project'), ownerPid: 999999, createdAt: now, updatedAt: now, jobs: [], instances: [] }, null, 2))
await writeFile(path.join(data, 'toolchain.json'), JSON.stringify({ javaHome: 'C:/Program Files/Java/jdk-21' }, null, 2))

/** Runs one hook command exactly as the host would: substitute the documented placeholders, then let the shell run it. */
function runHook(command, payload, timeout = 8000) {
  const resolved = command
    .replaceAll('${CODEBUDDY_PLUGIN_ROOT}', stage)
    .replaceAll('${CODEBUDDY_PLUGIN_DATA}', data)
  return new Promise((resolve) => {
    const child = execFile('bash', ['-c', resolved], { cwd: scope, timeout, env: { ...process.env, CODEBUDDY_PLUGIN_ROOT: stage, CODEBUDDY_PLUGIN_DATA: data } }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

const hooks = JSON.parse(await readFile(path.join(stage, 'hooks/hooks.json'), 'utf8'))
const commands = Object.fromEntries(Object.entries(hooks.hooks).map(([event, entries]) => [event, entries.flatMap((entry) => entry.hooks.map((hook) => hook.command))]))
assert.deepEqual(Object.keys(commands).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart'])
for (const [event, list] of Object.entries(commands)) assert.equal(list.length, 1, `${event} must declare exactly one command hook`)

const hasBash = await new Promise((resolve) => execFile('bash', ['-c', 'exit 0'], (error) => resolve(!error)))
const results = { package: true, mcp: false, hooks: 'not exercised' }

if (hasBash) {
  const started = await runHook(commands.SessionStart[0], { hook_event_name: 'SessionStart', source: 'startup' })
  assert.equal(started.code, 0, `SessionStart must exit 0, stderr: ${started.stderr}`)
  assert.ok(started.stdout.length > 0 && started.stdout.length <= 1400, `SessionStart output must stay under 1.4KB, got ${started.stdout.length}`)
  assert.ok(started.stdout.includes('任务会话'), 'SessionStart must report the recent task session')
  assert.equal(started.stdout.includes('11111111-2222-4333-8444-555555555555'), true, 'SessionStart must expose the resumable session id')

  const uncached = await runHook(commands.PreToolUse[0], { hook_event_name: 'PreToolUse', tool_name: 'mcp__modcrafting-fabric__fabric_job_status', tool_input: { jobId: 'x' } })
  assert.equal(uncached.code, 0)
  assert.equal(uncached.stdout.trim(), '', 'PreToolUse must stay silent when no session is cached; the MCP server owns SESSION_REQUIRED')

  await runHook(commands.PostToolUse[0], { hook_event_name: 'PostToolUse', tool_name: 'mcp__modcrafting-fabric__modcrafting_session', tool_input: {}, tool_response: { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, session: { sessionId, name: '冒烟任务' } } } })
  const cached = JSON.parse(await readFile(path.join(stateDirectory, 'current-session.json'), 'utf8'))
  assert.equal(cached.sessionId, sessionId, 'PostToolUse must cache the active session')

  const patched = await runHook(commands.PreToolUse[0], { hook_event_name: 'PreToolUse', tool_name: 'mcp__modcrafting-fabric__fabric_job_status', tool_input: { jobId: 'x' } })
  assert.equal(patched.code, 0)
  assert.equal(JSON.parse(patched.stdout).hookSpecificOutput.modifiedInput.sessionId, sessionId, 'PreToolUse must fill a missing sessionId from the cache')

  const risk = await runHook(commands.PreToolUse[0], { hook_event_name: 'PreToolUse', tool_name: 'mcp__modcrafting-fabric__minecraft_test_start', tool_input: { sessionId } })
  assert.equal(JSON.parse(risk.stdout).hookSpecificOutput.permissionDecision, 'ask', 'Destructive game operations must ask once')

  const overwrite = await runHook(commands.PreToolUse[0], { hook_event_name: 'PreToolUse', tool_name: 'mcp__modcrafting-fabric__fabric_build_start', tool_input: { sessionId: '99999999-8888-4777-8666-555555555555', projectPath: path.join(scope, 'project') } })
  const overwriteOutput = JSON.parse(overwrite.stdout || '{}').hookSpecificOutput
  assert.equal(overwriteOutput?.modifiedInput, undefined, 'PreToolUse must never overwrite an explicit sessionId')

  const huge = 'x'.repeat(40000)
  const compressed = await runHook(commands.PostToolUse[0], { hook_event_name: 'PostToolUse', tool_name: 'mcp__modcrafting-fabric__minecraft_log_read', tool_input: {}, tool_response: { content: [{ type: 'text', text: huge }], structuredContent: { ok: true } } })
  assert.equal(compressed.code, 0)
  const compressedOutput = JSON.parse(compressed.stdout).hookSpecificOutput
  assert.ok(Array.isArray(compressedOutput.updatedToolOutput), 'updatedToolOutput must be a content array so structuredContent survives')
  assert.equal('structuredContent' in compressedOutput, false, 'The hook must never replace the whole result object')
  assert.ok(JSON.stringify(compressedOutput).length < 5000, 'Compressed output must be far smaller than the 40KB input')

  const failed = await runHook(commands.PostToolUse[0], { hook_event_name: 'PostToolUse', tool_name: 'mcp__modcrafting-fabric__fabric_build_start', tool_response: { isError: true, content: [{ type: 'text', text: 'boom' }] } })
  assert.equal(failed.code, 0)
  assert.equal(failed.stdout.trim(), '', 'Error results must never be rewritten')

  const handoff = await runHook(commands.PostToolUse[0], { hook_event_name: 'PostToolUse', tool_name: 'mcp__modcrafting-fabric__modcrafting_open_workbench', tool_response: { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, browserUrl: 'http://127.0.0.1:4178/#token=abc' } } })
  assert.match(JSON.parse(handoff.stdout).hookSpecificOutput.additionalContext, /present_files/, 'The workbench URL must be handed to the host browser')

  results.hooks = 'executed'
} else {
  process.stderr.write('bash is not available; hook commands were not executed (reported as not exercised)\n')
}

// The packaged MCP config must actually start and honour its own flags.
const config = JSON.parse(await readFile(path.join(stage, '.mcp.json'), 'utf8')).mcpServers['modcrafting-fabric']
const entry = path.resolve(stage, config.args[0].replace('${CODEBUDDY_PLUGIN_ROOT}', '.'))
assert.equal(createHash('sha256').update(await readFile(entry)).digest('hex'), JSON.parse(await readFile(path.join(stage, 'compatibility.json'), 'utf8')).coreBundleSha256)
const guard = path.join(scope, 'isolate.mjs')
await writeFile(guard, `import { registerHooks } from 'node:module';\nimport { fileURLToPath } from 'node:url';\nconst allowed = ${JSON.stringify(stage + path.sep)};\nregisterHooks({ resolve(specifier, context, next) { const value = next(specifier, context); if (value.url.startsWith('file:') && !fileURLToPath(value.url).startsWith(allowed)) throw new Error('MODULE_OUTSIDE_PACKAGE'); return value; } });\n`)
const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', pathToFileURL(guard).href, entry, ...config.args.slice(1)], env: { MODCRAFTING_DATA: path.join(scope, 'mcp-data') }, cwd: scope, stderr: 'pipe' })
transport.stderr.on('data', () => {})
const client = new Client({ name: 'modcrafting-workbuddy-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } })
client.onerror = () => {}
try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  assert.equal(tools.length, EXPECTED_TOOL_COUNT)
  const digest = await client.callTool({ name: 'modcrafting_environment_status', arguments: {} })
  assert.ok(digest.content.find((block) => block.type === 'text').text.length < 3200, '--text=digest must be active in the packaged config')
  assert.equal(digest.structuredContent.assets.length, 5, 'structuredContent must stay complete')

  const session = await client.callTool({ name: 'modcrafting_session', arguments: { action: 'create', name: 'workbuddy smoke' } })
  const opened = await client.callTool({ name: 'modcrafting_open_workbench', arguments: { sessionId: session.structuredContent.session.sessionId, mode: 'builtin' } })
  assert.equal(opened.structuredContent.ok, true)
  assert.equal(opened.structuredContent.mode, 'builtin', '--workbench=builtin must make builtin the default mode')
  assert.equal(opened.structuredContent.opened, false, 'builtin mode must not launch a system browser')
  assert.equal(opened.structuredContent.suggestedTool.name, 'present_files')
  assert.equal(opened.structuredContent.suggestedTool.arguments.files.length, 1)
  results.mcp = true
} finally {
  await client.close()
}

// No machine-specific paths may leak into a package that others will install.
const personalPath = /[A-Za-z]:[\\/](?:Users|project_file)\b|\/home\/[^/]+\//
for (const file of await readdir(stage, { recursive: true })) {
  if (!/\.(?:mjs|json|md|txt)$/.test(file)) continue
  assert.equal(personalPath.test(await readFile(path.join(stage, file), 'utf8')), false, `Package leaks a personal path: ${file}`)
}

const summary = { ok: true, node: process.version, execution: 'SDK + hooks', version: JSON.parse(await readFile(path.join(stage, '.codebuddy-plugin/plugin.json'), 'utf8')).version, tools: EXPECTED_TOOL_COUNT, ...results, inlineCards: 'not exercised', nativeHost: 'not exercised', realGame: 'not run', scope }
await writeFile(path.join(scope, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
