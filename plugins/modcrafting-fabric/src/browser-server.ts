import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { FabricRuntime, CoreError, inspectFabricProject, resolveProjectPath, recipeWorkspace, recipeRequestSchema, contentWorkspace, contentRequestSchema, textureWorkspace, textureRequestSchema, isPng } from '../../../packages/modcrafting-core/src/index.ts'
import { guiWorkspace, guiRequestSchema } from '../../../packages/modcrafting-core/src/gui-workspace.ts'
import { visualAssets } from '../../../packages/modcrafting-core/src/visual-assets.ts'
import { gameTestTemplate, gameTestSpecSchema, testProfileSchema, type GameFeatureType } from '../../../packages/modcrafting-core/src/domain.ts'

const projectPath = z.string().min(1), instanceId = z.string().min(1)
const actionSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('resume_session'), sessionId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('select_session'), sessionId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('profile_read'), projectPath: projectPath.optional() }).strict(),
  z.object({ operation: z.literal('profile_write'), projectPath: projectPath.optional(), profile: testProfileSchema, saveAsProjectDefault: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal('template'), featureType: z.enum(['new_item', 'new_block', 'new_recipe', 'entity_behavior', 'player_interaction', 'hud_gui']).default('new_item') }).strict(),
  z.object({ operation: z.literal('gui'), request: guiRequestSchema }).strict(),
  z.object({ operation: z.literal('visuals'), projectPath, itemIds: z.array(z.string().min(1).max(200)).max(80), textureIds: z.array(z.string().min(1).max(200)).max(16) }).strict(),
  z.object({ operation: z.literal('content'), request: contentRequestSchema }).strict(),
  z.object({ operation: z.literal('texture'), request: textureRequestSchema }).strict(),
  z.object({ operation: z.literal('recipe'), request: recipeRequestSchema }).strict(),
  z.object({ operation: z.literal('project'), projectPath }).strict(),
  z.object({ operation: z.literal('environment'), projectPath: projectPath.optional() }).strict(),
  z.object({ operation: z.literal('prepare'), projectPath: projectPath.optional() }).strict(),
  z.object({ operation: z.literal('build'), projectPath, task: z.string().regex(/^[A-Za-z][A-Za-z0-9:.-]*$/).default('build') }).strict(),
  z.object({ operation: z.literal('run'), projectPath }).strict(),
  z.object({ operation: z.literal('stop'), jobId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal('runtime'), instanceId: instanceId.optional() }).strict(),
  z.object({ operation: z.literal('snapshot'), instanceId: instanceId.optional() }).strict(),
  z.object({ operation: z.literal('screenshot'), instanceId: instanceId.optional() }).strict(),
  z.object({ operation: z.literal('test'), instanceId: instanceId.optional(), spec: gameTestSpecSchema }).strict()
])
export type BrowserAction = z.input<typeof actionSchema>
export type BrowserAssets = { html: string; js: string; css: string }

/** Optional loopback view of an existing owner, never a second FabricRuntime. */
export async function startBrowserView(runtime: FabricRuntime, assets: BrowserAssets, port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('INVALID_BROWSER_PORT')
  const token = randomBytes(32).toString('hex')
  let origin = ''
  const server = createServer(async (request, response) => {
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)) }
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    // Host blocks DNS rebinding; Origin and Fetch Metadata block cross-site actions.
    if (request.headers.host !== origin.slice('http://'.length) || request.headers.origin && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
      json(403, { ok: false, code: 'ORIGIN_FORBIDDEN', error: 'Use the local browser URL' }); return
    }
    const url = new URL(request.url || '/', origin)
    const publicAssets: Record<string, [string, string]> = { '/': ['text/html; charset=utf-8', assets.html], '/view.js': ['text/javascript; charset=utf-8', assets.js], '/view.css': ['text/css; charset=utf-8', assets.css] }
    if (request.method === 'GET' && publicAssets[url.pathname]) {
      const [type, contents] = publicAssets[url.pathname]; response.writeHead(200, { 'content-type': type }); response.end(contents); return
    }
    const supplied = Buffer.from((request.headers.authorization || '').replace(/^Bearer /, ''))
    const expected = Buffer.from(token)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { json(401, { ok: false, code: 'VIEW_AUTH_REQUIRED', error: 'Open the complete URL printed by the server' }); return }
    try {
      if (request.headers['x-modcrafting-backend'] !== runtime.backendId) throw new CoreError('BACKEND_MISMATCH', '这个浏览器链接连接的不是原来的任务后端，请从当前任务重新打开工作台。')
      const sessionId = String(request.headers['x-modcrafting-session'] || '')
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new CoreError('SESSION_REQUIRED', '工作台没有选择任务会话，请从当前任务链接重新打开。')
      if (request.method === 'GET' && url.pathname === '/api/state') { json(200, runtime.state(sessionId)); return }
      if (request.method === 'GET' && url.pathname === '/api/sessions') { json(200, { sessions: runtime.state(sessionId).sessions || [] }); return }
      if (request.method === 'GET' && url.pathname.startsWith('/api/report/')) {
        const job = runtime.jobStatus(decodeURIComponent(url.pathname.slice('/api/report/'.length)), sessionId)
        if (!('result' in job) || typeof job.result?.reportPath !== 'string') throw new CoreError('REPORT_UNAVAILABLE', 'This job has no report')
        const root = await realpath(runtime.paths.reportsRoot), file = await realpath(job.result.reportPath)
        const relative = path.relative(root, file)
        if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(file)).isFile()) throw new CoreError('REPORT_UNAVAILABLE', 'Report is outside the runtime report directory')
        json(200, JSON.parse(await readFile(file, 'utf8'))); return
      }
      if (request.method === 'POST' && url.pathname === '/api/texture-source') {
        const type = String(request.headers['content-type'] || '')
        if (!type.startsWith('image/png') && !type.startsWith('application/octet-stream')) { json(415, { ok: false, code: 'PNG_REQUIRED', error: '只接受 PNG 源图' }); return }
        const parts: Buffer[] = []; let length = 0
        for await (const part of request) {
          length += part.length
          if (length > 8 * 1024 * 1024) { json(413, { ok: false, code: 'SOURCE_TOO_LARGE', error: '源图超过 8MB' }); return }
          parts.push(part)
        }
        const bytes = Buffer.concat(parts)
        if (!isPng(bytes)) { json(400, { ok: false, code: 'SOURCE_INVALID', error: '文件不是有效的 PNG' }); return }
        const uploadRoot = path.join(runtime.paths.dataRoot, 'texture-uploads', sessionId)
        await mkdir(uploadRoot, { recursive: true })
        const sourceToken = randomUUID() + '.png'
        await writeFile(path.join(uploadRoot, sourceToken), bytes, { flag: 'wx' })
        json(200, { ok: true, sourceToken, size: bytes.length }); return
      }
      if (request.method !== 'POST' || url.pathname !== '/api/action') { json(404, { ok: false, code: 'NOT_FOUND' }); return }
      if (!request.headers['content-type']?.startsWith('application/json')) { json(415, { ok: false, code: 'JSON_REQUIRED' }); return }
      const parts: Buffer[] = []; let length = 0
      for await (const part of request) {
        length += part.length
        if (length > 256 * 1024) { json(413, { ok: false, code: 'REQUEST_TOO_LARGE' }); return }
        parts.push(part)
      }
      const parsed = actionSchema.safeParse(JSON.parse(Buffer.concat(parts).toString('utf8')))
      if (!parsed.success) { json(400, { ok: false, code: 'INVALID_ARGUMENT', error: parsed.error.message }); return }
      const action = parsed.data
      let value: unknown
      switch (action.operation) {
        case 'gui': {
          const project = inspectFabricProject(resolveProjectPath(action.request.projectPath))
          if (!project.valid || project.minecraftVersion !== '1.21.4') throw new CoreError('PROJECT_UNAVAILABLE', '需要有效的 Fabric 1.21.4 工程')
          runtime.updateSession(sessionId, { projectPath: project.path })
          value = guiWorkspace(runtime.paths, action.request); break
        }
        case 'visuals': {
          const project = inspectFabricProject(resolveProjectPath(action.projectPath))
          if (!project.valid || project.minecraftVersion !== '1.21.4') throw new CoreError('PROJECT_UNAVAILABLE', '需要有效的 Fabric 1.21.4 工程')
          runtime.updateSession(sessionId, { projectPath: project.path })
          value = await visualAssets(runtime.paths, project.path, action.itemIds, action.textureIds); break
        }
        case 'content': {
          const project = inspectFabricProject(resolveProjectPath(action.request.projectPath))
          if (!project.valid || project.minecraftVersion !== '1.21.4') throw new CoreError('PROJECT_UNAVAILABLE', '需要有效的 Fabric 1.21.4 工程')
          runtime.updateSession(sessionId, { projectPath: project.path })
          value = contentWorkspace(runtime.paths, action.request); break
        }
        case 'texture': {
          const project = inspectFabricProject(resolveProjectPath(action.request.projectPath))
          if (!project.valid || project.minecraftVersion !== '1.21.4') throw new CoreError('PROJECT_UNAVAILABLE', '需要有效的 Fabric 1.21.4 工程')
          runtime.updateSession(sessionId, { projectPath: project.path })
          value = textureWorkspace(runtime.paths, action.request, { uploadRoot: path.join(runtime.paths.dataRoot, 'texture-uploads', sessionId) }); break
        }
        case 'recipe': {
          const project = inspectFabricProject(resolveProjectPath(action.request.projectPath))
          if (!project.valid || project.minecraftVersion !== '1.21.4') throw new CoreError('PROJECT_UNAVAILABLE', '需要有效的 Fabric 1.21.4 工程')
          runtime.updateSession(sessionId, { projectPath: project.path })
          value = recipeWorkspace(runtime.paths, action.request); break
        }
        case 'resume_session': value = { ok: true, session: runtime.resumeSession(action.sessionId) }; break
        case 'select_session': {
          const session = runtime.readSession(action.sessionId)
          value = { ok: true, session: session.status === 'ended' ? session : runtime.resumeSession(action.sessionId), readOnly: session.status === 'ended' }
          break
        }
        case 'profile_read': value = { ok: true, sessionId, profile: runtime.getTestProfile(sessionId, action.projectPath) }; break
        case 'profile_write': value = runtime.setTestProfile(sessionId, action.profile, { projectPath: action.projectPath, saveAsProjectDefault: action.saveAsProjectDefault }); break
        case 'template': value = { ok: true, spec: gameTestTemplate(action.featureType as GameFeatureType), schema: gameTestSpecSchema.toJSONSchema() }; break
        case 'project': {
          const project = inspectFabricProject(resolveProjectPath(action.projectPath))
          if (project.valid) runtime.updateSession(sessionId, { projectPath: project.path, currentModule: 'overview' })
          value = { ok: true, project }; break
        }
        case 'environment': value = await runtime.environmentStatus(action.projectPath); break
        case 'prepare': value = await runtime.prepareAssets(undefined, action.projectPath); break
        case 'build': value = runtime.startBuild(action.projectPath, action.task, sessionId); break
        case 'run': value = runtime.runClient(action.projectPath, undefined, sessionId); break
        case 'stop': value = runtime.stopJob(action.jobId, sessionId); break
        case 'runtime': value = await runtime.runtimeStatus(action.instanceId, sessionId); break
        case 'snapshot': value = await runtime.snapshot(action.instanceId, undefined, sessionId); break
        case 'test': value = runtime.startTest(action.spec, action.instanceId, sessionId); break
        case 'screenshot': {
          const result = await runtime.screenshot(action.instanceId, sessionId)
          const base64 = result.data.base64
          // Serve bridge image data only; never read an arbitrary bridge-supplied file path.
          value = typeof base64 === 'string' && base64.length <= 16 * 1024 * 1024 && /^[A-Za-z0-9+/=\r\n]+$/.test(base64)
            ? { ok: result.ok, image: `data:image/png;base64,${base64}`, path: result.data.path }
            : { ok: false, code: 'SCREENSHOT_UNAVAILABLE', error: result.error || 'Observer did not return image data' }
          break
        }
      }
      json(200, value)
    } catch (cause) {
      json(cause instanceof SyntaxError ? 400 : 200, { ok: false, code: cause instanceof CoreError ? cause.code : cause instanceof SyntaxError ? 'INVALID_JSON' : 'OPERATION_FAILED', error: String(cause) })
    }
  })
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  let closing: Promise<void> | undefined
  return {
    url: `${origin}/#token=${token}`,
    close: () => closing ??= new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections() })
  }
}
