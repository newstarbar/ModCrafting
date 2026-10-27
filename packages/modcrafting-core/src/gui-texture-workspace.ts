import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { validatePixelTexture } from './entity-appearance.ts'
import { inspectFabricProject } from './node.ts'
import { CoreError } from './runtime.ts'

const revision = z.string().regex(/^[a-f0-9]{64}$/), projectPath = z.string().min(1)
const textureId = z.string().regex(/^[a-z0-9_-]+:gui\/[a-z][a-z0-9_]{0,47}$/)
export const guiTextureRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), projectPath }).strict(),
  z.object({ action: z.literal('read'), projectPath, id: textureId }).strict(),
  z.object({ action: z.literal('save'), projectPath, id: textureId, texturePng: z.string().min(1).max(8_000_000), expectedRevision: revision.nullable() }).strict()
])
export type GuiTextureRequest = z.input<typeof guiTextureRequestSchema>
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const fail = (code: string, message: string): never => { throw new CoreError(code, message) }
function safe(file: string) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('TEXTURE_PATH_UNSAFE', '纹理路径不能经过链接或 junction')
    if (path.dirname(current) === current) return file
  }
}
function bytes(root: string, relative: string) {
  const file = safe(path.join(root, relative)); if (!existsSync(file)) return null
  const stat = lstatSync(file); if (!stat.isFile() || stat.size > 1024 * 1024) fail('TEXTURE_LIMIT', '纹理必须是小于 1MB 的普通文件：' + relative)
  return readFileSync(file)
}
function decodePng(raw: string) {
  const encoded = raw.replace(/^data:image\/png;base64,/, '').replace(/\s+/g, '')
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('INVALID_ARGUMENT', 'texturePng 必须是 PNG base64')
  const data = Buffer.from(encoded, 'base64'); const problem = validatePixelTexture(data)
  if (problem) fail('INVALID_ARGUMENT', problem)
  return data
}
const relativePath = (modId: string, name: string) => `src/main/resources/assets/${modId}/textures/gui/${name}.png`
const manifestPath = (name: string) => `.modcrafting/textures/gui/${name}.json`
function parseId(id: string, modId: string) {
  const [namespace, category, name] = id.split(/[:/]/)
  if (namespace !== modId || category !== 'gui' || !/^[a-z][a-z0-9_]{0,47}$/.test(name || '')) fail('INVALID_TEXTURE_ID', '纹理 ID 必须为 <本模组>:gui/<小写名称>')
  return name
}
function read(root: string, modId: string, id: string) {
  const name = parseId(id, modId), manifest = bytes(root, manifestPath(name)), png = bytes(root, relativePath(modId, name))
  if (!manifest || !png) fail('TEXTURE_NOT_FOUND', '没有找到受管理的 GUI 纹理：' + id)
  let stored: Record<string, unknown>
  try { stored = JSON.parse(manifest.toString('utf8')) } catch { fail('TEXTURE_READ_ONLY', '纹理清单无法解析，交给 Agent 检查：' + manifestPath(name)) }
  if (stored.version !== 1 || stored.id !== id || stored.path !== relativePath(modId, name) || stored.sha256 !== hash(png)) fail('TEXTURE_READ_ONLY', '纹理清单与 PNG 不一致，交给 Agent 检查：' + id)
  return { id, path: relativePath(modId, name), revision: hash(Buffer.concat([manifest, png])), image: 'data:image/png;base64,' + png.toString('base64'), width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}
function list(root: string, modId: string) {
  const folder = safe(path.join(root, '.modcrafting/textures/gui')); if (!existsSync(folder)) return []
  const entries = readdirSync(folder, { withFileTypes: true }); if (entries.length > 200) fail('TEXTURE_LIMIT', 'GUI 纹理超过 200 个')
  if (entries.some(entry => entry.isSymbolicLink())) fail('TEXTURE_PATH_UNSAFE', '纹理目录包含链接')
  return entries.filter(entry => entry.isFile() && /^[a-z][a-z0-9_]{0,47}\.json$/.test(entry.name)).flatMap(entry => {
    try { const name = path.basename(entry.name, '.json'), value = read(root, modId, `${modId}:gui/${name}`); return [{ id: value.id, path: value.path, width: value.width, height: value.height, revision: value.revision }] } catch { return [] }
  })
}
export function guiTextureWorkspace(raw: GuiTextureRequest): Record<string, unknown> {
  const request = guiTextureRequestSchema.parse(raw)
  if (!path.isAbsolute(request.projectPath)) fail('PROJECT_UNAVAILABLE', '需要工程绝对路径')
  const root = safe(path.resolve(request.projectPath)), project = inspectFabricProject(root)
  if (!project.valid || !project.modId || project.minecraftVersion !== '1.21.4') fail('PROJECT_UNAVAILABLE', '仅支持有效 Fabric 1.21.4 工程')
  const modId = project.modId!
  if (request.action === 'list') return { ok: true, textures: list(root, modId) }
  if (request.action === 'read') return { ok: true, document: read(root, modId, request.id) }
  const name = parseId(request.id, modId), target = relativePath(modId, name), manifest = manifestPath(name), png = decodePng(request.texturePng)
  const existingPng = bytes(root, target), existingManifest = bytes(root, manifest)
  if (!existingManifest && existingPng) fail('TEXTURE_READ_ONLY', '同名 PNG 已存在但不受纹理编辑器管理，不能覆盖：' + target)
  if (existingManifest && !existingPng) fail('TEXTURE_READ_ONLY', '纹理清单存在但 PNG 缺失，交给 Agent 检查：' + target)
  if (existingManifest && existingPng) {
    const current = read(root, modId, request.id)
    if (current.revision !== request.expectedRevision) fail('TEXTURE_CONFLICT', '纹理已被修改，请重新读取再保存')
  } else if (request.expectedRevision !== null) fail('TEXTURE_CONFLICT', '新纹理不能使用旧 revision 创建')
  const lock = safe(path.join(root, '.modcrafting/textures.lock')); mkdirSync(path.dirname(lock), { recursive: true })
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }) } catch { fail('TEXTURE_BUSY', '纹理正在保存或存在未恢复锁，请检查 textures.lock') }
  let pngWritten = false, manifestWritten = false
  try {
    const currentPng = bytes(root, target), currentManifest = bytes(root, manifest)
    if ((currentPng?.toString('base64') ?? null) !== (existingPng?.toString('base64') ?? null) || (currentManifest?.toString('base64') ?? null) !== (existingManifest?.toString('base64') ?? null)) fail('TEXTURE_CONFLICT', '保存时纹理或清单发生变化，请重新读取')
    const backup = safe(path.join(root, '.modcrafting/texture-backups', name + '-' + randomUUID() + '.json')); mkdirSync(path.dirname(backup), { recursive: true })
    writeFileSync(backup, json({ id: request.id, beforePng: existingPng?.toString('base64') ?? null, beforeManifest: existingManifest?.toString('utf8') ?? null }), { flag: 'wx' })
    mkdirSync(path.dirname(path.join(root, target)), { recursive: true })
    const tempPng = path.join(root, target) + '.modcrafting-' + randomUUID() + '.tmp'; writeFileSync(tempPng, png, { flag: 'wx' }); renameSync(tempPng, path.join(root, target)); pngWritten = true
    const manifestDirectory = path.dirname(path.join(root, manifest)); mkdirSync(manifestDirectory, { recursive: true })
    const tempManifest = path.join(root, manifest) + '.modcrafting-' + randomUUID() + '.tmp'; writeFileSync(tempManifest, json({ version: 1, id: request.id, path: target, sha256: hash(png), createdAt: new Date().toISOString() }), { flag: 'wx' }); renameSync(tempManifest, path.join(root, manifest)); manifestWritten = true
    return { ok: true, document: read(root, modId, request.id), backup }
  } catch (cause) {
    if (pngWritten) { if (existingPng) writeFileSync(path.join(root, target), existingPng); else unlinkSync(path.join(root, target)) }
    if (manifestWritten) { if (existingManifest) writeFileSync(path.join(root, manifest), existingManifest); else unlinkSync(path.join(root, manifest)) }
    throw cause
  } finally { unlinkSync(lock) }
}
