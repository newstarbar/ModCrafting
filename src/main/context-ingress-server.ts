import { app, BrowserWindow, ipcMain } from 'electron'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { randomBytes, randomUUID } from 'crypto'

const DISCOVERY_DIR = path.join(os.homedir(), '.modcrafting')
const DISCOVERY_FILE = path.join(DISCOVERY_DIR, 'context-ingress.json')

let ingressServer: http.Server | null = null
let ingressPort = 0
let ingressToken = ''
let activeProjectPath: string | null = null

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function attachmentsDir(projectPath: string): string {
  return path.join(projectPath, '.modcrafting', 'attachments')
}

function extForMime(mime: string, fallbackName?: string): string {
  const m = mime.toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('gif')) return '.gif'
  if (m.includes('webp')) return '.webp'
  if (m.includes('bmp')) return '.bmp'
  if (fallbackName) {
    const ext = path.extname(fallbackName)
    if (ext) return ext
  }
  return '.bin'
}

export function setIngressProjectPath(projectPath: string | null): void {
  activeProjectPath = projectPath
}

export function getIngressProjectPath(): string | null {
  return activeProjectPath
}

export async function saveAttachment(opts: {
  projectPath: string
  sourcePath?: string
  base64?: string
  mimeType?: string
  fileName?: string
}): Promise<{ ok: true; path: string; mimeType: string; name: string } | { ok: false; error: string }> {
  try {
    const projectPath = opts.projectPath
    if (!projectPath) return { ok: false, error: '缺少 projectPath' }
    const dir = attachmentsDir(projectPath)
    ensureDir(dir)

    if (opts.sourcePath) {
      const src = opts.sourcePath
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        return { ok: false, error: `源文件不存在: ${src}` }
      }
      const name = opts.fileName || path.basename(src)
      const dest = path.join(dir, `${randomUUID()}${path.extname(name) || ''}`)
      fs.copyFileSync(src, dest)
      const mimeType = opts.mimeType || guessMime(dest)
      return { ok: true, path: dest, mimeType, name }
    }

    if (opts.base64) {
      const mimeType = opts.mimeType || 'application/octet-stream'
      const name = opts.fileName || `attachment${extForMime(mimeType)}`
      const dest = path.join(dir, `${randomUUID()}${extForMime(mimeType, name)}`)
      fs.writeFileSync(dest, Buffer.from(opts.base64, 'base64'))
      return { ok: true, path: dest, mimeType, name }
    }

    return { ok: false, error: '需要 sourcePath 或 base64' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function guessMime(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'application/octet-stream'
}

export function readAttachmentDataUrl(
  filePath: string
): { ok: true; dataUrl: string; mimeType: string } | { ok: false; error: string } {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return { ok: false, error: `文件不存在: ${filePath}` }
    }
    const mimeType = guessMime(filePath)
    const buf = fs.readFileSync(filePath)
    // Cap ~4MB raw for data URL into the model
    if (buf.length > 4_000_000) {
      return { ok: false, error: '图片过大（>4MB），无法内嵌' }
    }
    return {
      ok: true,
      mimeType,
      dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function writeDiscovery(): void {
  ensureDir(DISCOVERY_DIR)
  const payload = {
    version: 1,
    port: ingressPort,
    token: ingressToken,
    host: '127.0.0.1'
  }
  fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(payload), 'utf-8')
}

function clearDiscovery(): void {
  try {
    if (fs.existsSync(DISCOVERY_FILE)) fs.unlinkSync(DISCOVERY_FILE)
  } catch {
    // ignore
  }
}

function pushToRenderer(payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('context:push', payload)
    }
  }
}

async function handleIngressBody(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kind = String(body.kind || 'image')
  if (kind !== 'image' && kind !== 'file' && kind !== 'text') {
    return { ok: false, code: 'BAD_REQUEST', error: `未知 kind: ${kind}` }
  }

  if (kind === 'text') {
    const text = String(body.text || '')
    if (!text.trim()) return { ok: false, code: 'BAD_REQUEST', error: 'text 为空' }
    pushToRenderer({ kind: 'text', text, source: String(body.source || 'ingress') })
    return { ok: true }
  }

  const projectPath = activeProjectPath
  if (!projectPath) {
    return { ok: false, code: 'NO_PROJECT', error: 'Electron 尚未打开项目，无法接收附件' }
  }

  const sourcePath = typeof body.path === 'string' ? body.path : undefined
  const base64 = typeof body.base64 === 'string' ? body.base64 : undefined
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : undefined
  const fileName = typeof body.name === 'string' ? body.name : undefined

  const saved = await saveAttachment({
    projectPath,
    sourcePath,
    base64,
    mimeType: mimeType || (kind === 'image' ? 'image/png' : undefined),
    fileName
  })
  if (!saved.ok) {
    return { ok: false, code: 'SAVE_FAILED', error: saved.error }
  }

  if (kind === 'image' || guessMime(saved.path).startsWith('image/')) {
    pushToRenderer({
      kind: 'image',
      path: saved.path,
      mimeType: saved.mimeType,
      name: saved.name,
      source: String(body.source || 'game')
    })
  } else {
    pushToRenderer({
      kind: 'file',
      path: saved.path,
      name: saved.name,
      source: String(body.source || 'game')
    })
  }
  return { ok: true, path: saved.path }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

export function startContextIngressServer(): void {
  if (ingressServer) return
  ingressToken = randomBytes(16).toString('hex')
  ingressServer = http.createServer(async (req, res) => {
    const send = (status: number, data: Record<string, unknown>) => {
      const raw = JSON.stringify(data)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      })
      res.end(raw)
    }

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        })
        res.end()
        return
      }

      const url = req.url || '/'
      const pathname = url.split('?')[0]

      if (req.method === 'GET' && pathname === '/v1/health') {
        send(200, { ok: true, projectOpen: Boolean(activeProjectPath) })
        return
      }

      if (req.method === 'POST' && pathname === '/v1/context') {
        const auth = req.headers.authorization || ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
        if (!token || token !== ingressToken) {
          send(401, { ok: false, code: 'UNAUTHORIZED', error: '缺少或错误的 Authorization Bearer token' })
          return
        }
        const raw = await readRequestBody(req)
        let body: Record<string, unknown> = {}
        if (raw.trim()) {
          try {
            body = JSON.parse(raw) as Record<string, unknown>
          } catch {
            send(400, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON' })
            return
          }
        }
        const result = await handleIngressBody(body)
        send(result.ok ? 200 : 400, result)
        return
      }

      send(404, { ok: false, code: 'NOT_FOUND', error: `未知路径: ${pathname}` })
    } catch (e) {
      send(500, { ok: false, code: 'INTERNAL', error: e instanceof Error ? e.message : String(e) })
    }
  })

  ingressServer.listen(0, '127.0.0.1', () => {
    const addr = ingressServer?.address()
    if (addr && typeof addr === 'object') {
      ingressPort = addr.port
      writeDiscovery()
      console.log(`[context-ingress] listening on 127.0.0.1:${ingressPort}`)
    }
  })
}

export function stopContextIngressServer(): void {
  if (ingressServer) {
    ingressServer.close()
    ingressServer = null
  }
  ingressPort = 0
  ingressToken = ''
  clearDiscovery()
}

export async function saveAttachmentAs(
  sourcePath: string,
  suggestedName?: string
): Promise<{ ok: true; path: string } | { ok: false; cancelled?: boolean; error?: string }> {
  try {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
      return { ok: false, error: '无效路径' }
    }
    const resolved = path.resolve(sourcePath)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return { ok: false, error: '文件不存在' }
    }
    const { dialog, BrowserWindow } = await import('electron')
    const win = BrowserWindow.getFocusedWindow()
    const defaultName = suggestedName || path.basename(resolved)
    const saveOpts = {
      title: '另存为',
      defaultPath: defaultName,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, saveOpts)
      : await dialog.showSaveDialog(saveOpts)
    if (result.canceled || !result.filePath) {
      return { ok: false, cancelled: true }
    }
    fs.copyFileSync(resolved, result.filePath)
    return { ok: true, path: result.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function setupContextIngressHandlers(): void {
  ipcMain.handle('context:setProjectPath', async (_e, projectPath: string | null) => {
    setIngressProjectPath(projectPath)
    return { ok: true }
  })

  ipcMain.handle(
    'attachments:save',
    async (
      _e,
      opts: {
        projectPath: string
        sourcePath?: string
        base64?: string
        mimeType?: string
        fileName?: string
      }
    ) => saveAttachment(opts)
  )

  ipcMain.handle('attachments:readDataUrl', async (_e, filePath: string) => readAttachmentDataUrl(filePath))

  ipcMain.handle(
    'attachments:saveAs',
    async (_e, sourcePath: string, suggestedName?: string) => saveAttachmentAs(sourcePath, suggestedName)
  )

  ipcMain.handle('dialog:selectAttachmentFiles', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '添加附件'
    })
    if (result.canceled || result.filePaths.length === 0) return [] as string[]
    return result.filePaths
  })
}
