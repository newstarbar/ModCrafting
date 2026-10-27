import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { contentObjectSchema, contentKinds, contentForms, newContentObject, type ContentObject, type ContentDocument, type ContentFile } from './content-model.ts'
import { generateContent } from './content-codegen.ts'
import { baseTextureSize, validateEntityTexture, validatePixelTexture } from './entity-appearance.ts'
import { inspectFabricProject, lookupMinecraftData } from './node.ts'
import { CoreError, projectRuntimePaths } from './runtime.ts'
import type { RuntimePaths } from './contracts.ts'

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const texturePng = z.string().min(1).max(8_000_000).optional()
const fields = { projectPath: z.string().min(1), value: contentObjectSchema, expectedRevision: revisionSchema.nullable() }
export const contentRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('template'), projectPath: fields.projectPath, kind: z.enum(contentKinds) }).strict(),
  z.object({ action: z.literal('list'), projectPath: fields.projectPath }).strict(),
  z.object({ action: z.literal('read'), projectPath: fields.projectPath, id: z.string().min(1) }).strict(),
  z.object({ action: z.literal('preview'), ...fields, texturePng }).strict(),
  z.object({ action: z.literal('save'), ...fields, previewRevision: revisionSchema, texturePng }).strict()
])
export type ContentRequest = z.input<typeof contentRequestSchema>
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const fail = (code: string, message: string): never => { throw new CoreError(code, message) }
function safe(file: string): string {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('CONTENT_PATH_UNSAFE', '内容路径不能经过链接或 junction')
    if (path.dirname(current) === current) return file
  }
}
function bytes(root: string, file: string): Buffer | null {
  const absolute = safe(path.join(root, file))
  if (!existsSync(absolute)) return null
  const stat = lstatSync(absolute)
  if (!stat.isFile() || stat.size > 1024 * 1024) fail('CONTENT_LIMIT', '目标不是普通文件或超过 1MB：' + file)
  return readFileSync(absolute)
}
function walk(root: string, directory: string): string[] {
  const output: string[] = []
  const visit = (relative: string, depth: number) => {
    if (depth > 24 || output.length > 3000) fail('CONTENT_LIMIT', '内容目录过深或文件过多')
    const absolute = safe(path.join(root, relative)); if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('CONTENT_PATH_UNSAFE', '资源目录包含链接')
      const name = relative + '/' + entry.name
      if (entry.isDirectory()) visit(name, depth + 1)
      else if (entry.isFile()) output.push(name)
    }
  }
  visit(directory, 0); return output
}
function idName(id: string, modId: string): string {
  if (!new RegExp(`^${modId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[a-z][a-z0-9_]{0,47}$`).test(id)) fail('INVALID_CONTENT_ID', '内容 ID 必须使用当前模组命名空间和小写英文/数字/下划线')
  return id.split(':')[1]
}
const manifestPath = (name: string) => `.modcrafting/content/${name}.json`
const sharedFiles = (modId: string) => ['src/main/resources/fabric.mod.json', `src/main/resources/assets/${modId}/lang/zh_cn.json`, `src/main/resources/assets/${modId}/lang/en_us.json`, 'build.gradle', 'build.gradle.kts']
function objectJson(root: string, file: string): Record<string, any> {
  const content = bytes(root, file)
  if (!content) return {}
  try { const value = JSON.parse(content.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value }
  catch { return fail('CONTENT_READ_ONLY', '无法安全合并 JSON，原文件保持不变：' + file) }
}
function splitClient(root: string) { return ['build.gradle', 'build.gradle.kts'].some(file => bytes(root, file)?.toString('utf8').includes('splitEnvironmentSourceSets')) }
function entrypoints(metadata: Record<string, any>, type: string): unknown[] {
  const entries = metadata.entrypoints?.[type] ?? []
  if (!Array.isArray(entries)) fail('CONTENT_READ_ONLY', '无法安全合并非数组 Fabric entrypoints')
  return entries
}
function textureFile(value: ContentObject) {
  const [ns, name] = value.texture.split(':')
  return `src/main/resources/assets/${ns}/textures/${name}.png`
}
function previewImage(paths: RuntimePaths | undefined, root: string, value: ContentObject, png?: Buffer): string | undefined {
  if (png) return 'data:image/png;base64,' + png.toString('base64')
  const file = textureFile(value)
  const image = value.texture.startsWith('minecraft:')
    ? paths && bytes(paths.assetsRoot, `minecraft-textures/1.21.4/${file.slice('src/main/resources/'.length)}`)
    : bytes(root, file)
  return image && image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'data:image/png;base64,' + image.toString('base64') : undefined
}
function decodeTexturePng(raw?: string): Buffer | undefined {
  if (raw === undefined) return undefined
  const encoded = raw.replace(/^data:image\/png;base64,/, '').replace(/\s+/g, '')
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('INVALID_ARGUMENT', 'texturePng 必须是 PNG base64')
  const buffer = Buffer.from(encoded, 'base64')
  if (!buffer.length) fail('INVALID_ARGUMENT', 'texturePng 不能为空')
  return buffer
}
function validateContentTexture(root: string, value: ContentObject, supplied?: Buffer): Buffer | undefined {
  if (value.kind === 'entity' && value.appearance) {
    const custom = value.appearance.mode === 'custom'
    const expected = custom ? value.appearance.textureSize : baseTextureSize(value.parameters.baseEntity)
    if (custom && value.texture.startsWith('minecraft:')) fail('CONTENT_RESOURCE_MISSING', '自定义模型必须使用工程内 PNG 纹理')
    if (!custom && value.texture.startsWith('minecraft:')) {
      if (supplied) fail('CONTENT_RESOURCE_MISSING', '绘制纹理需要把纹理引用改为工程路径')
      return undefined
    }
    const png = supplied ?? bytes(root, textureFile(value))
    if (!png) fail('CONTENT_RESOURCE_MISSING', '请先绘制并保存生物纹理：' + textureFile(value))
    const problem = validateEntityTexture(png, expected as [number, number])
    if (problem) fail('CONTENT_RESOURCE_MISSING', problem)
    return png
  }
  if (value.texture.startsWith('minecraft:')) {
    if (supplied) fail('CONTENT_RESOURCE_MISSING', '绘制纹理需要把纹理引用改为工程路径')
    return undefined
  }
  const png = supplied ?? bytes(root, textureFile(value))
  if (!png) fail('CONTENT_RESOURCE_MISSING', '请先绘制并保存纹理：' + textureFile(value))
  const problem = validatePixelTexture(png)
  if (problem) fail('CONTENT_RESOURCE_MISSING', problem)
  return png
}
function validateResources(paths: RuntimePaths, root: string, value: ContentObject, suppliedTexture?: Buffer) {
  const knowledge = projectRuntimePaths(paths, root)
  if (!value.voxel) {
    const vanilla = value.texture.startsWith('minecraft:')
    if (!vanilla) {
      const png = suppliedTexture ?? bytes(root, textureFile(value))
      if (!png || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('CONTENT_RESOURCE_MISSING', '工程纹理必须是已存在的 PNG：' + textureFile(value))
    } else if (value.kind === 'entity') {
      if (!['minecraft:entity/pig/pig', 'minecraft:entity/zombie/zombie'].includes(value.texture)) fail('CONTENT_RESOURCE_MISSING', '原版生物纹理目前支持猪或僵尸；其他纹理请放入工程')
    } else {
      const kind = value.texture.startsWith('minecraft:block/') ? 'block' : 'item'
      if (!value.texture.startsWith(`minecraft:${kind}/`)) fail('CONTENT_RESOURCE_MISSING', '使用原版 item/ 或 block/ 纹理引用')
      const query = 'minecraft:' + value.texture.split('/').slice(1).join('/')
      if (!lookupMinecraftData(knowledge, kind, query).ok) fail('CONTENT_RESOURCE_MISSING', '知识库无法确认原版纹理关联：' + query)
    }
  }
  // Knowledge checks precede registration generation; missing data never becomes a guessed baseline.
  const baseline = value.kind === 'block' ? ['block', 'minecraft:stone'] : value.kind === 'entity' ? ['entity', `minecraft:${value.parameters.baseEntity}`] : ['item', value.kind === 'food' ? 'minecraft:apple' : 'minecraft:iron_ingot']
  if (!lookupMinecraftData(knowledge, baseline[0] as 'block' | 'entity' | 'item', baseline[1]).ok) fail('ASSET_UNAVAILABLE', '原版基准知识不可用，请先准备知识数据')
  if (value.kind === 'tool' || value.kind === 'armor') {
    const material = String(value.parameters.material)
    const prefix = material === 'wood' ? 'wooden' : material === 'gold' ? 'golden' : material
    const item = `minecraft:${prefix}_${value.kind === 'tool' ? value.parameters.toolType : value.parameters.armorType}`
    if (!lookupMinecraftData(knowledge, 'item', item).ok) fail('ASSET_UNAVAILABLE', '知识库无法确认所选材质/部位基准：' + item)
  }
}
function readManaged(root: string, modId: string, id: string, image = false, paths?: RuntimePaths): ContentDocument {
  const file = manifestPath(idName(id, modId)), raw = bytes(root, file)
  if (!raw) fail('CONTENT_NOT_FOUND', '没有可编辑对象；手写/第三方内容保持只读')
  const document: ContentDocument = { id, editable: false, revision: hash(raw), files: [file] }
  try {
    const stored = JSON.parse(raw.toString('utf8'))
    if (stored.version !== 1) throw Error('不支持的声明版本')
    const value = contentObjectSchema.parse(stored.value)
    if (value.id !== id) throw Error('内容 ID 与声明文件名不一致')
    document.value = value; document.kind = value.kind
    const generated = generateContent(value, splitClient(root))
    const generatedAll: Array<{ path: string; content: string | Buffer }> = [...generated.files, ...generated.assets]
    const owned = generatedAll.map(target => target.path)
    const tracked = [...new Set([file, ...owned, ...sharedFiles(modId), ...(value.texture.startsWith('minecraft:') || value.voxel ? [] : [textureFile(value)])])].sort()
    document.files = owned
    document.revision = hash(JSON.stringify(tracked.map(file => [file, bytes(root, file)?.toString('base64') ?? null])))
    if (!stored.files || JSON.stringify(Object.keys(stored.files).sort()) !== JSON.stringify([...owned].sort())) throw Error('生成文件清单不匹配，请交由 Agent 检查')
    const storedTexture = stored.texture && typeof stored.texture === 'object' ? stored.texture as { path?: unknown; sha256?: unknown } : undefined
    if (storedTexture && (typeof storedTexture.path !== 'string' || typeof storedTexture.sha256 !== 'string')) throw Error('纹理清单格式无效，保留源码并交由 Agent 检查')
    if (storedTexture && (storedTexture.path !== textureFile(value) || !bytes(root, storedTexture.path) || hash(bytes(root, storedTexture.path)!) !== storedTexture.sha256)) throw Error('绘制纹理已被外部修改，保留源码并交由 Agent 合并：' + String(storedTexture.path))
    for (const target of generatedAll) {
      const current = bytes(root, target.path)
      // Saved hashes detect external edits; generator evolution is applied only through preview/save.
      if (!current || hash(current) !== stored.files[target.path]) throw Error('生成文件已被外部修改，保留源码并交由 Agent 合并：' + target.path)
    }
    const metadata = objectJson(root, sharedFiles(modId)[0])
    if (!entrypoints(metadata, 'main').includes(generated.main) || generated.client && !entrypoints(metadata, 'client').includes(generated.client)) throw Error('生成的 Fabric 入口已被外部修改')
    for (const file of sharedFiles(modId).slice(1, 3)) if (objectJson(root, file)[generated.langKey] !== value.displayName) throw Error('对象名称已被外部修改：' + file)
    document.editable = true
    if (image) document.image = previewImage(paths, root, value, generated.previewPng)
  } catch (cause) { document.editable = false; document.reason = String(cause) }
  return document
}
function preview(paths: RuntimePaths, root: string, modId: string, value: ContentObject, expected: string | null, suppliedTexture?: string) {
  const name = idName(value.id, modId), file = manifestPath(name), exists = bytes(root, file), textureBytes = decodeTexturePng(suppliedTexture)
  const existing = exists ? readManaged(root, modId, value.id) : undefined
  if (existing) {
    if (existing.revision !== expected) fail('CONTENT_CONFLICT', '对象或相关文件已改变，草稿已保留；重新读取比较后再应用')
    if (!existing.editable) fail('CONTENT_READ_ONLY', existing.reason || '对象不可安全编辑')
    if (existing.value!.kind !== value.kind) fail('CONTENT_READ_ONLY', '已有对象不能改变注册类型；请新建不同 ID')
  } else if (expected !== null) fail('CONTENT_CONFLICT', '原对象已被移走，不能按旧版本写入')
  validateResources(paths, root, value, textureBytes)
  // Voxel objects compile their atlas PNG through generated assets; a painted texture is not part of that flow.
  const contentTexture = value.voxel ? undefined : validateContentTexture(root, value, textureBytes)
  const texturePath = contentTexture ? textureFile(value) : undefined
  const textureSha256 = contentTexture ? hash(contentTexture) : undefined
  const generated = generateContent(value, splitClient(root))
  const generatedAll: Array<{ path: string; content: string | Buffer }> = [...generated.files, ...generated.assets]
  if (existing) {
    for (const target of generatedAll) {
      if (!existing.files.includes(target.path) && bytes(root, target.path)) fail('CONTENT_READ_ONLY', '目标文件已存在且不受当前对象管理，不能覆盖：' + target.path)
    }
  }
  if (!exists) {
    const resourcePrefix = `src/main/resources/assets/${modId}`
    for (const target of [`${resourcePrefix}/items/${name}.json`, `${resourcePrefix}/models/item/${name}.json`, `${resourcePrefix}/models/block/${name}.json`]) if (bytes(root, target)) fail('CONTENT_READ_ONLY', '已有资源未受此编辑器管理，不能覆盖：' + target)
    for (const file of walk(root, 'src/main/java').filter(file => file.endsWith('.java'))) {
      if (bytes(root, file)?.toString('utf8').includes(JSON.stringify(name))) fail('CONTENT_READ_ONLY', '源码已有同名 ID 引用，请交由 Agent 核对：' + file)
    }
    for (const target of generatedAll) if (bytes(root, target.path)) fail('CONTENT_READ_ONLY', '目标文件已存在，不能覆盖：' + target.path)
  }
  const metadataFile = sharedFiles(modId)[0], metadata = objectJson(root, metadataFile)
  metadata.entrypoints = { ...metadata.entrypoints }
  for (const [type, entry] of [['main', generated.main], ['client', generated.client]]) if (entry) {
    const entries = entrypoints(metadata, type); metadata.entrypoints[type] = entries.includes(entry) ? entries : [...entries, entry]
  }
  const targets = [...generatedAll, { path: metadataFile, content: json(metadata) }]
  for (const file of sharedFiles(modId).slice(1, 3)) {
    const lang = objectJson(root, file)
    if (!exists && Object.hasOwn(lang, generated.langKey)) fail('CONTENT_READ_ONLY', '同名语言键已存在，请先由 Agent 核对')
    targets.push({ path: file, content: json({ ...lang, [generated.langKey]: value.displayName }) })
  }
  targets.push({ path: file, content: json({ version: 1, value, files: Object.fromEntries(generatedAll.map(target => [target.path, hash(target.content)])), ...(texturePath && textureSha256 ? { texture: { path: texturePath, sha256: textureSha256 } } : {}) }) })
  const changes: ContentFile[] = targets.map(target => {
    const binary = Buffer.isBuffer(target.content)
    const before = bytes(root, target.path)
    return {
      path: target.path,
      before: before ? (binary ? before.toString('base64') : before.toString('utf8')) : null,
      after: binary ? (target.content as Buffer).toString('base64') : target.content as string,
      ...(binary ? { binary: true, size: (target.content as Buffer).length } : {})
    }
  })
  const context = [...sharedFiles(modId).slice(3), ...(texturePath ? [texturePath] : []), ...(value.texture.startsWith('minecraft:') || value.voxel || texturePath ? [] : [textureFile(value)])].map(file => [file, file === texturePath ? contentTexture?.toString('base64') ?? null : bytes(root, file)?.toString('base64') ?? null])
  const previousTexture = texturePath ? bytes(root, texturePath) : undefined
  return { ok: true, value, files: changes, image: previewImage(paths, root, value, generated.previewPng ?? contentTexture), texture: texturePath ? { path: texturePath, base64: contentTexture!.toString('base64'), sha256: textureSha256, beforeSha256: previousTexture ? hash(previousTexture) : null, width: contentTexture!.readUInt32BE(16), height: contentTexture!.readUInt32BE(20) } : undefined, previewRevision: hash(JSON.stringify({ changes, context })) }
}

export function contentWorkspace(paths: RuntimePaths, raw: ContentRequest): Record<string, unknown> {
  const request = contentRequestSchema.parse(raw)
  if (!path.isAbsolute(request.projectPath)) fail('PROJECT_UNAVAILABLE', '需要 Fabric 工程绝对路径')
  const root = safe(path.resolve(request.projectPath)), project = inspectFabricProject(root)
  if (!project.valid || !project.modId || project.minecraftVersion !== '1.21.4') fail('PROJECT_UNAVAILABLE', '仅支持有效 Fabric 1.21.4 工程：' + project.errors.join('; '))
  const modId = project.modId!
  if (request.action === 'template') return { ok: true, value: newContentObject(request.kind, modId), fields: contentForms[request.kind].fields, hint: contentForms[request.kind].hint }
  if (request.action === 'read') return { ok: true, document: readManaged(root, modId, request.id, true, paths) }
  if (request.action === 'list') {
    const documents = walk(root, '.modcrafting/content').filter(file => /^\.modcrafting\/content\/[a-z][a-z0-9_]{0,47}\.json$/.test(file)).map(file => readManaged(root, modId, `${modId}:${path.basename(file, '.json')}`))
    const unmanaged = new Map<string, string[]>()
    const prefix = `src/main/resources/assets/${modId}`
    for (const file of walk(root, prefix).filter(file => /\/(items|models\/item)\/[^/]+\.json$/.test(file))) {
      const id = `${modId}:${path.basename(file, '.json')}`
      if (!documents.some(doc => doc.id === id)) unmanaged.set(id, [...(unmanaged.get(id) || []), file])
    }
    for (const [id, files] of unmanaged) documents.push({ id, editable: false, reason: '已有手写/第三方内容；参数无法可靠反向解析，交由 Agent 修改', revision: hash(JSON.stringify(files.map(file => bytes(root, file)?.toString('base64')))), files })
    return { ok: true, documents }
  }
  if (request.action === 'preview') return preview(paths, root, modId, request.value, request.expectedRevision, request.texturePng)
  const lock = safe(path.join(root, '.modcrafting/content.lock'))
  mkdirSync(path.dirname(lock), { recursive: true })
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }) } catch { return fail('CONTENT_BUSY', '工程内容正在保存或存在未恢复事务，请检查 content.lock；不自动删除') }
  const written: ContentFile[] = []
  const sameBefore = (current: Buffer | null, file: ContentFile): boolean => {
    if (file.before === null) return current === null
    if (!current) return false
    return file.binary ? current.equals(Buffer.from(file.before, 'base64')) : current.toString('utf8') === file.before
  }
  const payloadOf = (file: ContentFile): string | Buffer => file.binary ? Buffer.from(file.after, 'base64') : file.after
  let textureWritten: { target: string; before: Buffer | null; after: Buffer } | undefined
  try {
    const planned = preview(paths, root, modId, request.value, request.expectedRevision, request.texturePng)
    if (planned.previewRevision !== request.previewRevision) fail('CONTENT_CONFLICT', '预览后内容发生改变，请重新预览；草稿保持不变')
    const backup = safe(path.join(paths.dataRoot, 'content-backups', hash(root), randomUUID() + '.json'))
    mkdirSync(path.dirname(backup), { recursive: true }); writeFileSync(backup, json({ objectId: request.value.id, files: planned.files }), { flag: 'wx' })
    for (const file of planned.files.filter(file => file.before !== file.after)) {
      const target = safe(path.join(root, file.path)), current = bytes(root, file.path) ?? null
      if (!sameBefore(current, file) || existsSync(target) && lstatSync(target).nlink > 1) fail('CONTENT_CONFLICT', '保存时文件发生修改或存在硬链接：' + file.path)
      mkdirSync(path.dirname(target), { recursive: true })
      if (file.before === null) writeFileSync(target, payloadOf(file), { flag: 'wx' })
      else {
        const temporary = target + '.modcrafting-' + randomUUID() + '.tmp'
        try { writeFileSync(temporary, payloadOf(file), { flag: 'wx' }); renameSync(temporary, target) } finally { if (existsSync(temporary)) unlinkSync(temporary) }
      }
      written.push(file)
    }
    const texture = planned.texture as { path: string; beforeSha256: string | null; base64: string } | undefined
    if (texture) {
      const target = safe(path.join(root, texture.path)), before = bytes(root, texture.path), after = Buffer.from(texture.base64, 'base64')
      if ((before ? hash(before) : null) !== texture.beforeSha256 || existsSync(target) && lstatSync(target).nlink > 1) fail('CONTENT_CONFLICT', '保存时纹理发生修改或存在硬链接：' + texture.path)
      mkdirSync(path.dirname(target), { recursive: true })
      if (!before) writeFileSync(target, after, { flag: 'wx' })
      else {
        const temporary = target + '.modcrafting-' + randomUUID() + '.tmp'
        try { writeFileSync(temporary, after, { flag: 'wx' }); renameSync(temporary, target) } finally { if (existsSync(temporary)) unlinkSync(temporary) }
      }
      textureWritten = { target, before, after }
    }
    return { ok: true, document: readManaged(root, modId, request.value.id, true, paths), backup }
  } catch (cause) {
    if (textureWritten) {
      const current = bytes(root, path.relative(root, textureWritten.target))
      if (current && hash(current) === hash(textureWritten.after)) {
        if (textureWritten.before) writeFileSync(textureWritten.target, textureWritten.before)
        else unlinkSync(textureWritten.target)
      }
    }
    for (const file of written.reverse()) {
      const current = bytes(root, file.path)
      const after = Buffer.from(file.after, 'base64')
      const unchanged = file.binary ? current !== null && current.equals(after) : current?.toString('utf8') === file.after
      if (unchanged) {
        if (file.before === null) unlinkSync(safe(path.join(root, file.path)))
        else writeFileSync(safe(path.join(root, file.path)), file.binary ? Buffer.from(file.before, 'base64') : file.before)
      }
    }
    throw cause
  } finally { unlinkSync(lock) }
}
