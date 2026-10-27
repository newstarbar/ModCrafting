import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import sharp from 'sharp'
import { captureWorkbench } from './capture-workbench.mjs'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const { values } = parseArgs({ options: { entry: { type: 'string' }, edge: { type: 'string' }, 'open-browser': { type: 'boolean' } } })
const parent = path.resolve('temp/experience-smoke'); await mkdir(parent, { recursive: true })
const directory = await mkdtemp(path.join(parent, 'run-')), project = path.join(directory, '中文 模组')
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(values.entry || 'temp/plugin-artifacts/modcrafting-fabric/dist/mcp-server.js'), '--web'], env: { ...process.env, MODCRAFTING_DATA: path.join(directory, 'data'), TEMP: directory, TMP: directory }, stderr: 'pipe' })
transport.stderr.on('data', () => {}) // Browser tokens stay out of saved diagnostics.
const client = new Client({ name: 'experience-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } })
const call = async (name, args = {}) => {
  const reply = await client.callTool({ name, arguments: args })
  assert.equal(reply.isError || false, false)
  return reply.structuredContent || JSON.parse(reply.content.find(value => value.type === 'text').text)
}
try {
  await client.connect(transport)
  const tools = (await client.listTools()).tools
  assert.equal(tools.length, 28)
  const environment = await call('modcrafting_environment_status')
  assert.equal(environment.observer.bundled, true); assert.equal(environment.observer.protocol, 2)
  assert.equal(environment.version, client.getServerVersion().version)
  const created = await call('fabric_project_scaffold', { projectPath: project, modId: 'experience_smoke', modName: '体验检查' })
  assert.equal(created.project.valid, true)
  const task = await call('modcrafting_session', { action: 'create', name: '工作台体验检查', projectPath: project })
  const sessionId = task.session.sessionId
  const template = await call('fabric_content_workspace', { action: 'template', projectPath: project, kind: 'item' })
  assert.equal(template.value.parameters.maxStackSize, 64); assert.equal(template.value.parameters.durability, 0)
  const workbench = await call('modcrafting_open_workbench', { sessionId, projectPath: project, view: 'content', open: Boolean(values['open-browser']) })
  assert.ok(workbench.browserUrl)
  if (values['open-browser']) assert.equal(workbench.opened, true)
  const url = new URL(workbench.browserUrl), parameters = new URLSearchParams(url.hash.slice(1))
  assert.equal(parameters.get('project'), project); assert.equal(parameters.get('view'), 'content'); assert.equal(parameters.get('sessionId'), sessionId)
  const headers = { authorization: `Bearer ${parameters.get('token')}`, 'content-type': 'application/json', 'x-modcrafting-session': sessionId, 'x-modcrafting-backend': parameters.get('backendId') }
  assert.equal((await fetch(url.origin + '/api/state', { headers })).status, 200)
  assert.equal((await fetch(url.origin + '/api/state')).status, 401)
  const templateReply = await fetch(url.origin + '/api/action', { method: 'POST', headers, body: JSON.stringify({ operation: 'content', request: { action: 'template', kind: 'item', projectPath: project } }) })
  assert.deepEqual((await templateReply.json()).value, template.value)
  let browserRendered = false
  if (values.edge) {
    const stdout = await captureWorkbench(values.edge, workbench.browserUrl, directory, { name: 'workbench-desktop' })
    assert.match(stdout, /内容参数工作区/); assert.match(stdout, /experience_smoke/)
    assert.match(stdout, /工作台已连接/)
    assert.equal(stdout.includes('页面加载失败'), false)
    const desktopScreenshot = path.join(directory, 'workbench-desktop.png')
    assert.equal((await readFile(desktopScreenshot)).subarray(0, 4).toString('hex'), '89504e47')
    assert.ok((await sharp(desktopScreenshot).stats()).channels.some(channel => channel.stdev > 3), 'browser capture must contain painted content, not a uniform background')
    const narrowDom = await captureWorkbench(values.edge, workbench.browserUrl, directory, { width: 420, height: 900, name: 'workbench-narrow', expectMobileNav: true })
    assert.match(narrowDom, /class="mobile-nav"/)
    const narrowScreenshot = path.join(directory, 'workbench-narrow.png')
    assert.equal((await readFile(narrowScreenshot)).subarray(0, 4).toString('hex'), '89504e47')
    assert.ok((await sharp(narrowScreenshot).stats()).channels.some(channel => channel.stdev > 3), 'narrow capture must contain painted content, not a uniform background')
    // The page has already removed the private fragment; redact defensively before saving.
    await writeFile(path.join(directory, 'workbench-dom.html'), stdout.replaceAll(parameters.get('token'), '[redacted]'))
    browserRendered = true
  }
  const report = { ok: true, version: environment.version, toolCount: tools.length, observer: environment.observer, sameBackendAuthenticated: true, contentTemplateRoundTrip: true, projectRouted: true, systemBrowserRequested: workbench.opened, browserRendered, directory, realGame: 'not run', qoderModelChat: 'not run' }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await client.close() }
