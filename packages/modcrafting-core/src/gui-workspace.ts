import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { guiLayoutSchema, newGuiLayout, newGuiElement, guiTypes, type GuiLayout, type GuiDocument, type GuiFile } from './gui-model.ts'
import { generateGui } from './gui-codegen.ts'
import { inspectFabricProject, lookupMinecraftData } from './node.ts'
import type { RuntimePaths } from './contracts.ts'
import { CoreError } from './runtime.ts'
import { recipeWorkspace, type RecipeItem } from './recipe-workspace.ts'

const revision = z.string().regex(/^[a-f0-9]{64}$/), projectPath = z.string().min(1)
export const guiRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('template'), projectPath, layoutType: z.enum(['custom-screen', 'option-list', 'hud-overlay']) }).strict(),
  z.object({ action: z.literal('list'), projectPath }).strict(),
  z.object({ action: z.literal('read'), projectPath, id: z.string().min(1) }).strict(),
  z.object({ action: z.literal('preview'), projectPath, value: guiLayoutSchema, expectedRevision: revision.nullable() }).strict(),
  z.object({ action: z.literal('save'), projectPath, value: guiLayoutSchema, expectedRevision: revision.nullable(), previewRevision: revision }).strict()
])
export type GuiRequest = z.input<typeof guiRequestSchema>
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const fail = (code: string, message: string): never => { throw new CoreError(code, message) }
function safe(file: string) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('GUI_PATH_UNSAFE', '界面路径不能经过链接或 junction')
    if (current === path.dirname(current)) return file
  }
}
function bytes(root: string, relative: string) {
  const file = safe(path.join(root, relative)); if (!existsSync(file)) return null
  const stat = lstatSync(file); if (!stat.isFile() || stat.size > 1024 * 1024) fail('GUI_LIMIT', '界面文件不是普通文件或超过 1MB：' + relative)
  return readFileSync(file)
}
function object(root: string, file: string): Record<string, any> {
  const data = bytes(root, file); if (!data) return {}
  try { const value = JSON.parse(data.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value } catch { return fail('GUI_READ_ONLY', '无法安全合并 JSON：' + file) }
}
function nameOf(id: string, modId: string) {
  const [ns, name, extra] = id.split(':'); if (ns !== modId || extra || !/^[a-z][a-z0-9_]{0,47}$/.test(name || '')) fail('INVALID_GUI_ID', '界面 ID 必须使用本模组命名空间与小写英文/数字/下划线')
  return name
}
const declaration = (name: string) => `.modcrafting/gui/${name}.json`
const shared = (modId: string) => ['src/main/resources/fabric.mod.json', `src/main/resources/assets/${modId}/lang/zh_cn.json`, `src/main/resources/assets/${modId}/lang/en_us.json`, 'build.gradle', 'build.gradle.kts', 'gradle.properties']
const split = (root: string) => ['build.gradle', 'build.gradle.kts'].some(file => bytes(root, file)?.toString('utf8').includes('splitEnvironmentSourceSets'))
function clients(metadata: Record<string, any>): unknown[] {
  const value = metadata.entrypoints?.client ?? []; if (!Array.isArray(value)) fail('GUI_READ_ONLY', '无法安全合并非数组客户端入口'); return value
}
function list(root: string, modId: string) {
  const folder = safe(path.join(root, '.modcrafting/gui')); if (!existsSync(folder)) return []
  const entries = readdirSync(folder, { withFileTypes: true }); if (entries.length > 100) fail('GUI_LIMIT', '界面声明超过 100 项')
  if (entries.some(entry => entry.isSymbolicLink())) fail('GUI_PATH_UNSAFE', '界面目录包含链接')
  return entries.filter(entry => entry.isFile() && /^[a-z][a-z0-9_]{0,47}\.json$/.test(entry.name)).map(entry => read(root, modId, `${modId}:${path.basename(entry.name, '.json')}`))
}
function read(root: string, modId: string, id: string): GuiDocument {
  const file = declaration(nameOf(id, modId)), raw = bytes(root, file); if (!raw) fail('GUI_NOT_FOUND', '未找到受管理的界面；手写 Screen/HUD 保持原样，交给 Agent 检查')
  const document: GuiDocument = { id, editable: false, revision: hash(raw), files: [file] }
  try {
    const stored = JSON.parse(raw.toString('utf8')); if (stored.version !== 1) throw Error('不支持的界面声明版本')
    const value = guiLayoutSchema.parse(stored.value); if (value.id !== id) throw Error('界面声明 ID 不一致')
    document.value = value
    const generated = generateGui(value, split(root)), owned = generated.files.map(file => file.path)
    document.files = owned
    const files = [file, ...owned, ...shared(modId)].sort()
    document.revision = hash(JSON.stringify(files.map(file => [file, bytes(root, file)?.toString('base64') ?? null])))
    if (!stored.files || JSON.stringify(Object.keys(stored.files).sort()) !== JSON.stringify([...owned].sort())) throw Error('生成文件清单不一致')
    for (const file of generated.files) { const current = bytes(root, file.path); if (!current || hash(current) !== stored.files[file.path] || hash(file.content) !== stored.files[file.path]) throw Error('生成文件已被外部修改，交由 Agent 合并：' + file.path) }
    if (!clients(object(root, shared(modId)[0])).includes(generated.client)) throw Error('客户端入口已被外部修改')
    for (const file of shared(modId).slice(1, 3)) if (object(root, file)[generated.keyName] !== value.title) throw Error('快捷键名称已被外部修改')
    document.editable = true
  } catch (error) { document.reason = String(error) }
  return document
}
function preview(paths: RuntimePaths, root: string, modId: string, value: GuiLayout, expected: string | null) {
  const file = declaration(nameOf(value.id, modId)), exists = bytes(root, file)
  if (exists) {
    const current = read(root, modId, value.id)
    if (current.revision !== expected) fail('GUI_CONFLICT', '工程界面已改变，草稿已保留；重新读取比较后应用')
    if (!current.editable) fail('GUI_READ_ONLY', current.reason || '界面只读')
  } else if (expected !== null) fail('GUI_CONFLICT', '原界面已被移走，请重新读取')
  for (const other of list(root, modId)) if (other.id !== value.id && other.value?.keyCode === value.keyCode) fail('INVALID_GUI_KEY', '此默认快捷键已被其他受管理界面使用')
  for (const element of value.elements.filter(element => element.type === 'slot' && element.itemId.startsWith('minecraft:'))) if (!lookupMinecraftData(paths, 'item', element.itemId).ok) fail('ASSET_UNAVAILABLE', '展示槽位的标准物品 ID 无法确认：' + element.itemId)
  const customSlots = value.elements.filter(element => element.type === 'slot' && !element.itemId.startsWith('minecraft:'))
  if (customSlots.length) {
    const items = recipeWorkspace(paths, { action: 'catalog', projectPath: root }).items as RecipeItem[]
    for (const element of customSlots) if (!items.some(item => item.id === element.itemId)) fail('INVALID_GUI_ITEM', '展示物品未出现在工程资源目录中：' + element.itemId)
  }
  for (const element of value.elements.filter(element => element.type === 'image' && element.texture && !element.texture.startsWith('minecraft:'))) {
    const [namespace, ...parts] = element.texture!.split(':'), relative = `src/main/resources/assets/${namespace}/textures/${parts.join(':')}.png`
    if (namespace !== modId || !bytes(root, relative)) fail('GUI_TEXTURE_MISSING', '界面图片纹理不存在：' + element.texture + '（请先在纹理工作区绘制并保存）')
  }
  const generated = generateGui(value, split(root)), metadataFile = shared(modId)[0], metadata = object(root, metadataFile)
  if (!exists) for (const target of generated.files) if (bytes(root, target.path)) fail('GUI_READ_ONLY', '已有文件不受此编辑器管理，不能覆盖：' + target.path)
  const client = clients(metadata); metadata.entrypoints = { ...metadata.entrypoints, client: client.includes(generated.client) ? client : [...client, generated.client] }
  const targets = [...generated.files, { path: metadataFile, content: json(metadata) }]
  for (const file of shared(modId).slice(1, 3)) {
    const lang = object(root, file); if (!exists && Object.hasOwn(lang, generated.keyName)) fail('GUI_READ_ONLY', '同名快捷键语言项已存在')
    targets.push({ path: file, content: json({ ...lang, [generated.keyName]: value.title }) })
  }
  targets.push({ path: file, content: json({ version: 1, value, files: Object.fromEntries(generated.files.map(file => [file.path, hash(file.content)])) }) })
  const files: GuiFile[] = targets.map(file => ({ path: file.path, before: bytes(root, file.path)?.toString('utf8') ?? null, after: file.content }))
  const context = shared(modId).slice(3).map(file => [file, bytes(root, file)?.toString('base64') ?? null])
  return { ok: true, files, previewRevision: hash(JSON.stringify({ files, context })), configName: generated.configName }
}
/** Same versioned, backed-up transaction pattern as R3; never rewrite a handwritten Screen. */
export function guiWorkspace(paths: RuntimePaths, raw: GuiRequest): Record<string, unknown> {
  const request = guiRequestSchema.parse(raw)
  if (!path.isAbsolute(request.projectPath)) fail('PROJECT_UNAVAILABLE', '需要工程绝对路径')
  const root = safe(path.resolve(request.projectPath)), project = inspectFabricProject(root)
  if (!project.valid || !project.modId || project.minecraftVersion !== '1.21.4') fail('PROJECT_UNAVAILABLE', '仅支持有效 Fabric 1.21.4 工程')
  const modId = project.modId!
  if (request.action === 'template') return { ok: true, value: newGuiLayout(modId, request.layoutType), components: guiTypes.filter(type => request.layoutType !== 'hud-overlay' || !['button', 'toggle', 'slider'].includes(type)).map(type => newGuiElement(type, type + '_1')) }
  if (request.action === 'list') return { ok: true, documents: list(root, modId) }
  if (request.action === 'read') return { ok: true, document: read(root, modId, request.id) }
  if (request.action === 'preview') return preview(paths, root, modId, request.value, request.expectedRevision)
  const lock = safe(path.join(root, '.modcrafting/gui.lock')); mkdirSync(path.dirname(lock), { recursive: true })
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }) } catch { return fail('GUI_BUSY', '界面正在保存或存在未恢复锁，请检查 gui.lock；不自动删除') }
  const written: GuiFile[] = []
  try {
    const planned = preview(paths, root, modId, request.value, request.expectedRevision)
    if (planned.previewRevision !== request.previewRevision) fail('GUI_CONFLICT', '预览后文件发生改变，请重新预览；草稿保持不变')
    const backup = safe(path.join(paths.dataRoot, 'gui-backups', hash(root), randomUUID() + '.json'))
    mkdirSync(path.dirname(backup), { recursive: true }); writeFileSync(backup, json({ id: request.value.id, files: planned.files }), { flag: 'wx' })
    for (const file of planned.files.filter(file => file.before !== file.after)) {
      const target = safe(path.join(root, file.path))
      if ((bytes(root, file.path)?.toString('utf8') ?? null) !== file.before || existsSync(target) && lstatSync(target).nlink > 1) fail('GUI_CONFLICT', '文件改变或存在硬链接：' + file.path)
      mkdirSync(path.dirname(target), { recursive: true })
      if (file.before === null) writeFileSync(target, file.after, { flag: 'wx' })
      else { const temporary = target + '.modcrafting-' + randomUUID() + '.tmp'; try { writeFileSync(temporary, file.after, { flag: 'wx' }); renameSync(temporary, target) } finally { if (existsSync(temporary)) unlinkSync(temporary) } }
      written.push(file)
    }
    return { ok: true, document: read(root, modId, request.value.id), backup }
  } catch (error) {
    for (const file of written.reverse()) if (bytes(root, file.path)?.toString('utf8') === file.after) { if (file.before === null) unlinkSync(safe(path.join(root, file.path))); else writeFileSync(safe(path.join(root, file.path)), file.before) }
    throw error
  } finally { unlinkSync(lock) }
}
