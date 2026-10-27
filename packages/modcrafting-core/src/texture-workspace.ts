import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  analyzeTexture, buildTextureBrief, defaultTextureOptions, extractPalette, normalizeTextureOptions, processTexture, TEXTURE_SIZES, textureFileFor,
  validHex, type RGBAImage, type TextureAnalysis, type TextureOptions, type TextureSize
} from './texture-core.ts'
import { decodePng, decodeRgbaBase64, encodePng, encodeRgbaBase64, isPng, MAX_TEXTURE_SOURCE_BYTES, pngDataUrl } from './texture-png.ts'
import { contentWorkspace, contentRequestSchema } from './content-workspace.ts'
import type { ContentObject } from './content-model.ts'
import { inspectFabricProject } from './node.ts'
import { CoreError } from './runtime.ts'
import type { RuntimePaths } from './contracts.ts'

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const sizeSchema = z.union([z.literal(16), z.literal(32), z.literal(64)])
const optionsSchema = z.object({
  size: sizeSchema.optional(),
  background: z.enum(['auto', 'keep', 'chroma', 'color']).optional(),
  backgroundTolerance: z.number().int().min(0).max(255).optional(),
  chromaColor: hex.optional(),
  trim: z.boolean().optional(),
  padding: z.number().int().min(0).max(4).optional(),
  pixelize: z.boolean().optional(),
  outlineExpansion: z.boolean().optional(),
  paletteSize: z.number().int().min(4).max(32).optional(),
  dither: z.enum(['none', 'bayer2', 'bayer4', 'floyd']).optional(),
  alphaThreshold: z.number().int().min(1).max(254).optional(),
  outline: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  contrast: z.number().int().min(-50).max(50).optional(),
  saturation: z.number().int().min(-50).max(50).optional(),
  recolor: z.object({ preset: z.enum(['wood', 'stone', 'iron', 'gold', 'diamond', 'netherite', 'amethyst']).optional(), colors: z.array(hex).max(16).optional() }).strict().optional(),
  mirror: z.enum(['none', 'x']).optional()
}).strict()

const projectPathField = z.string().min(1)
export const textureRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prompt'), projectPath: projectPathField, itemId: z.string().min(1).max(200).optional(), description: z.string().trim().min(1).max(500), size: sizeSchema.optional(), background: z.enum(['magenta', 'white', 'transparent', 'auto']).optional(), palette: z.array(hex).max(16).optional(), style: z.enum(['vanilla', 'detailed']).optional() }).strict(),
  z.object({ action: z.literal('import'), projectPath: projectPathField, textureId: z.string().min(1).max(200), sourcePath: z.string().min(1).optional(), sourceBase64: z.string().min(1).optional(), sourceToken: z.string().min(1).optional(), options: optionsSchema.optional(), prompt: z.string().max(4000).optional() }).strict(),
  z.object({ action: z.literal('preview'), projectPath: projectPathField, textureId: z.string().min(1).max(200), candidateId: z.string().uuid().optional(), pixelsBase64: z.string().min(1).optional(), width: z.number().int().min(1).max(256).optional(), height: z.number().int().min(1).max(256).optional(), options: optionsSchema.optional(), analyzeOnly: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('list'), projectPath: projectPathField, textureId: z.string().min(1).max(200).optional() }).strict(),
  z.object({ action: z.literal('read'), projectPath: projectPathField, textureId: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('save'), projectPath: projectPathField, textureId: z.string().min(1).max(200), candidateId: z.string().uuid().optional(), pixelsBase64: z.string().min(1).optional(), width: z.number().int().min(1).max(256).optional(), height: z.number().int().min(1).max(256).optional(), options: optionsSchema.optional(), expectedRevision: revisionSchema.nullable(), previewRevision: revisionSchema }).strict(),
  z.object({ action: z.literal('bind'), projectPath: projectPathField, contentId: z.string().min(1).max(200), textureId: z.string().min(1).max(200), expectedRevision: revisionSchema.nullable() }).strict()
])
export type TextureRequest = z.input<typeof textureRequestSchema>
type ParsedTextureRequest = z.output<typeof textureRequestSchema>
export type TextureWorkspaceContext = { uploadRoot?: string }

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const fail = (code: string, message: string): never => { throw new CoreError(code, message) }

function safe(file: string): string {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('TEXTURE_PATH_UNSAFE', '贴图路径不能经过链接或 junction')
    if (path.dirname(current) === current) return file
  }
}

function limit(relative: string, maximum: number, label: string): Buffer | null {
  const file = safe(relative)
  if (!existsSync(file)) return null
  const stat = lstatSync(file)
  if (!stat.isFile()) fail('TEXTURE_INVALID', label + '不是普通文件：' + relative)
  if (stat.size > maximum) fail('TEXTURE_SOURCE_TOO_LARGE', `${label}超过 ${Math.round(maximum / 1024)}KB：${relative}`)
  return readFileSync(file)
}

function projectOf(raw: string): { root: string; modId: string } {
  if (!path.isAbsolute(raw)) fail('PROJECT_UNAVAILABLE', '需要 Fabric 工程绝对路径')
  const root = safe(path.resolve(raw)), inspected = inspectFabricProject(root)
  if (!inspected.valid || !inspected.modId || inspected.minecraftVersion !== '1.21.4') fail('PROJECT_UNAVAILABLE', '仅支持有效的 Fabric 1.21.4 工程：' + inspected.errors.join('; '))
  return { root, modId: inspected.modId! }
}

function textureTarget(textureId: string, modId: string): { name: string; file: string } {
  const match = /^([a-z0-9_.-]+):item\/([a-z0-9_]{1,48})$/.exec(textureId)
  if (!match || match[1] !== modId) fail('TEXTURE_ID_INVALID', '贴图 ID 必须使用当前模组命名空间，格式为 <modid>:item/<小写英文/数字/下划线>。')
  const name = match[2]
  return { name, file: textureFileFor(`${modId}:item/${name}`) }
}

function projectRevision(root: string, file: string): { bytes: Buffer | null; revision: string | null } {
  const bytes = limit(path.join(root, file), 1024 * 1024, '工程贴图')
  return { bytes, revision: bytes ? hash(bytes) : null }
}

function candidateRoot(paths: RuntimePaths, root: string, name: string): string {
  return safe(path.join(paths.dataRoot, 'texture-library', hash(path.resolve(root)), name))
}

type CandidateMeta = {
  tool: 'modcrafting-texture'
  version: 1
  candidateId: string
  textureId: string
  name: string
  createdAt: string
  options: TextureOptions
  prompt: string
  sourceHash: string
  palette: string[]
  metrics: unknown
  failures: unknown
  warnings: unknown
}

function readCandidate(paths: RuntimePaths, root: string, name: string, candidateId: string): { directory: string; source: Buffer | null; texture: Buffer; meta: CandidateMeta } {
  if (!/^[0-9a-f-]{36}$/i.test(candidateId)) fail('TEXTURE_CANDIDATE_NOT_FOUND', '候选 ID 无效。')
  const directory = safe(path.join(candidateRoot(paths, root, name), candidateId))
  const metaRaw = limit(path.join(directory, 'meta.json'), 256 * 1024, '候选元数据')
  const texture = limit(path.join(directory, 'texture.png'), 1024 * 1024, '候选贴图')
  if (!metaRaw || !texture) fail('TEXTURE_CANDIDATE_NOT_FOUND', '没有找到这个贴图候选；请重新导入或选择其他候选。')
  let meta: CandidateMeta
  try { meta = JSON.parse(metaRaw.toString('utf8')) } catch { return fail('TEXTURE_CANDIDATE_NOT_FOUND', '候选元数据损坏，请重新导入。') }
  if (meta.tool !== 'modcrafting-texture' || meta.candidateId !== candidateId) fail('TEXTURE_CANDIDATE_NOT_FOUND', '候选元数据不属于当前工具。')
  return { directory, source: limit(path.join(directory, 'source.png'), MAX_TEXTURE_SOURCE_BYTES, '候选源图'), texture, meta }
}

function pruneCandidates(paths: RuntimePaths, root: string, name: string): void {
  const directory = candidateRoot(paths, root, name)
  if (!existsSync(directory)) return
  const candidates: Array<{ id: string; createdAt: string }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const meta = JSON.parse(readFileSync(path.join(directory, entry.name, 'meta.json'), 'utf8')) as CandidateMeta
      if (meta.tool === 'modcrafting-texture') candidates.push({ id: entry.name, createdAt: String(meta.createdAt || '') })
    } catch { /* Only tool-owned candidates are considered. */ }
  }
  if (candidates.length <= 20) return
  for (const candidate of candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, candidates.length - 20)) {
    try { rmSync(safe(path.join(directory, candidate.id)), { recursive: true, force: false }) } catch { /* Keep the newest candidates if cleanup is blocked. */ }
  }
}

function inferSize(image: RGBAImage): TextureSize {
  return image.width === image.height && TEXTURE_SIZES.includes(image.width as TextureSize) ? image.width as TextureSize : 16
}

function analysisOptions(image: RGBAImage, patch: Partial<TextureOptions> = {}): TextureOptions {
  return normalizeTextureOptions({ size: inferSize(image), pixelize: false, trim: false, background: 'keep', outlineExpansion: false, ...patch })
}

function qualityPayload(textureId: string, file: string, png: Uint8Array, image: RGBAImage, analysis: TextureAnalysis, revision: string | null, extra: Record<string, unknown> = {}) {
  return {
    ok: true, textureId, filePath: file,
    image: pngDataUrl(png),
    pixels: { width: image.width, height: image.height, base64: encodeRgbaBase64(image) },
    palette: extractPalette(image, 32),
    metrics: analysis.metrics,
    failures: analysis.failures,
    warnings: analysis.warnings,
    qualityOk: analysis.ok,
    revision,
    ...extra
  }
}

function sourceFromRequest(request: Extract<ParsedTextureRequest, { action: 'import' }>, context: TextureWorkspaceContext): { bytes: Buffer; cleanup?: string } {
  const provided = [request.sourcePath, request.sourceBase64, request.sourceToken].filter(Boolean)
  if (provided.length !== 1) fail('TEXTURE_SOURCE_REQUIRED', '导入时只提供 sourcePath、sourceBase64 或 sourceToken 中的一种。')
  if (request.sourcePath) {
    if (!path.isAbsolute(request.sourcePath)) fail('TEXTURE_SOURCE_INVALID', 'sourcePath 必须是本地 PNG 的绝对路径。')
    const file = safe(request.sourcePath)
    const stat = existsSync(file) ? lstatSync(file) : undefined
    if (!stat?.isFile()) fail('TEXTURE_SOURCE_MISSING', '找不到源图：' + request.sourcePath)
    if (stat.size > MAX_TEXTURE_SOURCE_BYTES) fail('TEXTURE_SOURCE_TOO_LARGE', `源图超过 ${MAX_TEXTURE_SOURCE_BYTES / 1024 / 1024}MB。`)
    const bytes = readFileSync(file)
    if (!isPng(bytes)) fail('TEXTURE_SOURCE_INVALID', '首版只接受 PNG 源图；请让 Agent 导出 PNG 后再导入。')
    return { bytes }
  }
  if (request.sourceBase64) {
    const base64 = request.sourceBase64.replace(/^data:image\/png;base64,/i, '').replace(/\s+/g, '')
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length > MAX_TEXTURE_SOURCE_BYTES) fail('TEXTURE_SOURCE_TOO_LARGE', `源图超过 ${MAX_TEXTURE_SOURCE_BYTES / 1024 / 1024}MB。`)
    if (!isPng(bytes)) fail('TEXTURE_SOURCE_INVALID', '首版只接受 PNG 源图；请让 Agent 导出 PNG 后再导入。')
    return { bytes }
  }
  if (!context.uploadRoot || !/^[a-f0-9-]{36}\.png$/i.test(request.sourceToken!)) fail('TEXTURE_SOURCE_INVALID', '上传令牌无效，请重新拖入 PNG。')
  const file = safe(path.join(context.uploadRoot, request.sourceToken!))
  const stat = existsSync(file) ? lstatSync(file) : undefined
  if (!stat?.isFile()) fail('TEXTURE_SOURCE_MISSING', '上传的源图已过期，请重新拖入 PNG。')
  if (stat.size > 8 * 1024 * 1024) fail('TEXTURE_SOURCE_TOO_LARGE', '上传源图超过 8MB。')
  const bytes = readFileSync(file)
  if (!isPng(bytes)) fail('TEXTURE_SOURCE_INVALID', '首版只接受 PNG 源图。')
  return { bytes, cleanup: file }
}

function projectPalette(root: string, modId: string): string[] {
  const directory = safe(path.join(root, 'src/main/resources/assets', modId, 'textures/item'))
  if (!existsSync(directory)) return []
  const counts = new Map<string, number>()
  let files = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.png') || files++ >= 30) continue
    const file = safe(path.join(directory, entry.name))
    try {
      const stat = lstatSync(file)
      if (stat.size > 256 * 1024) continue
      const image = decodePng(readFileSync(file))
      for (const color of extractPalette(image, 24)) counts.set(color, (counts.get(color) ?? 0) + 1)
    } catch { /* Ignore unrelated or malformed project textures; the brief still works without a palette. */ }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([color]) => color)
}

function listCandidates(paths: RuntimePaths, root: string, name: string) {
  const directory = candidateRoot(paths, root, name)
  if (!existsSync(directory)) return []
  const result: Array<Record<string, unknown>> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const meta = JSON.parse(readFileSync(safe(path.join(directory, entry.name, 'meta.json')), 'utf8')) as CandidateMeta
      if (meta.tool !== 'modcrafting-texture') continue
      const texture = limit(path.join(directory, entry.name, 'texture.png'), 1024 * 1024, '候选贴图')
      result.push({ candidateId: meta.candidateId, createdAt: meta.createdAt, options: meta.options, palette: meta.palette, metrics: meta.metrics, failures: meta.failures, warnings: meta.warnings, image: texture ? pngDataUrl(texture) : null })
    } catch { /* Skip incomplete candidates. */ }
  }
  return result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

function textureList(root: string, modId: string) {
  const directory = safe(path.join(root, 'src/main/resources/assets', modId, 'textures/item'))
  if (!existsSync(directory)) return []
  const textures: Array<Record<string, unknown>> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-z0-9_]{1,48}\.png$/.test(entry.name)) continue
    const name = entry.name.slice(0, -4), file = textureFileFor(`${modId}:item/${name}`), filePath = safe(path.join(root, file))
    try {
      const stat = lstatSync(filePath)
      if (!stat.isFile() || stat.size > 1024 * 1024) continue
      const bytes = readFileSync(filePath)
      if (!isPng(bytes)) continue
      textures.push({ textureId: `${modId}:item/${name}`, name, filePath: file, revision: hash(bytes), image: pngDataUrl(bytes), sizeBytes: bytes.length })
    } catch { /* Only regular PNG files are listed. */ }
  }
  return textures.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

export function textureWorkspace(paths: RuntimePaths, raw: TextureRequest, context: TextureWorkspaceContext = {}): Record<string, unknown> {
  const request = textureRequestSchema.parse(raw)
  const { root, modId } = projectOf(request.projectPath)

  if (request.action === 'prompt') {
    const existing = projectPalette(root, modId)
    const palette = request.palette?.filter(validHex).slice(0, 16) ?? existing
    const brief = buildTextureBrief({
      description: request.description, itemId: request.itemId, modId, size: request.size, background: request.background, palette, style: request.style
    })
    return { ok: true, ...brief, modId, existingPalette: existing }
  }

  if (request.action === 'list') {
    const textures = textureList(root, modId)
    if (!request.textureId) return { ok: true, textures, candidates: [] }
    const target = textureTarget(request.textureId, modId)
    return { ok: true, textures, candidates: listCandidates(paths, root, target.name) }
  }

  const target = textureTarget(request.textureId, modId)

  if (request.action === 'read') {
    const current = projectRevision(root, target.file)
    if (!current.bytes || !current.revision) return { ok: true, textureId: request.textureId, filePath: target.file, exists: false, image: null, pixels: null, palette: [], metrics: null, failures: [], warnings: [], qualityOk: false, revision: null }
    const image = decodePng(current.bytes), analysis = analyzeTexture(image, analysisOptions(image))
    return qualityPayload(request.textureId, target.file, current.bytes, image, analysis, current.revision, { exists: true })
  }

  if (request.action === 'import') {
    const source = sourceFromRequest(request, context)
    const decoded = decodePng(source.bytes)
    const options = normalizeTextureOptions({ ...defaultTextureOptions, ...request.options })
    const processed = processTexture(decoded, options)
    const png = encodePng(processed.image)
    const candidateId = randomUUID(), directory = safe(path.join(candidateRoot(paths, root, target.name), candidateId))
    mkdirSync(directory, { recursive: true })
    writeFileSync(safe(path.join(directory, 'source.png')), source.bytes, { flag: 'wx' })
    writeFileSync(safe(path.join(directory, 'texture.png')), png, { flag: 'wx' })
    const meta: CandidateMeta = {
      tool: 'modcrafting-texture', version: 1, candidateId, textureId: request.textureId, name: target.name,
      createdAt: new Date().toISOString(), options, prompt: request.prompt ?? '', sourceHash: hash(source.bytes),
      palette: processed.palette, metrics: processed.metrics, failures: processed.failures, warnings: processed.warnings
    }
    writeFileSync(safe(path.join(directory, 'meta.json')), json(meta), { flag: 'wx' })
    pruneCandidates(paths, root, target.name)
    if (source.cleanup) try { unlinkSync(source.cleanup) } catch { /* The upload is already consumed; stale files are pruned by the route owner. */ }
    const current = projectRevision(root, target.file)
    return qualityPayload(request.textureId, target.file, png, processed.image, processed, current.revision, { candidateId })
  }

  if (request.action === 'preview') {
    let image: RGBAImage, candidateId: string | undefined
    if (request.candidateId) {
      const candidate = readCandidate(paths, root, target.name, request.candidateId)
      image = decodePng(candidate.source ?? candidate.texture); candidateId = request.candidateId
    } else if (request.pixelsBase64 && request.width && request.height) {
      image = decodeRgbaBase64(request.pixelsBase64, request.width, request.height)
    } else fail('TEXTURE_SOURCE_REQUIRED', '预览需要 candidateId 或完整的 pixelsBase64/width/height。')
    const options = normalizeTextureOptions(request.candidateId
      ? { ...defaultTextureOptions, ...request.options }
      : { ...defaultTextureOptions, size: inferSize(image), pixelize: false, trim: false, background: 'keep', outlineExpansion: false, outline: 0, paletteSize: 32, ...request.options })
    const processed = request.analyzeOnly ? {
      image, palette: extractPalette(image, 32), ...analyzeTexture(image, analysisOptions(image, { ...request.options, size: inferSize(image) }))
    } : processTexture(image, options)
    const png = encodePng(processed.image), current = projectRevision(root, target.file)
    const previewRevision = hash(JSON.stringify({ textureId: request.textureId, width: processed.image.width, height: processed.image.height, pixels: hash(Buffer.from(processed.image.data)) }))
    return qualityPayload(request.textureId, target.file, png, processed.image, processed, current.revision, { candidateId, previewRevision, options })
  }

  if (request.action === 'save') {
    let png: Uint8Array, image: RGBAImage
    if (request.pixelsBase64 && request.width && request.height) { image = decodeRgbaBase64(request.pixelsBase64, request.width, request.height); png = encodePng(image) }
    else if (request.candidateId) {
      const candidate = readCandidate(paths, root, target.name, request.candidateId)
      png = candidate.texture; image = decodePng(candidate.texture)
    } else fail('TEXTURE_SOURCE_REQUIRED', '保存需要 pixelsBase64/width/height 或 candidateId。')
    const analysis = analyzeTexture(image, analysisOptions(image, { ...request.options, size: inferSize(image) }))
    if (!analysis.ok) fail('TEXTURE_QUALITY', analysis.failures.map(value => value.message + value.fix).join('；'))
    const previewRevision = hash(JSON.stringify({ textureId: request.textureId, width: image.width, height: image.height, pixels: hash(Buffer.from(image.data)) }))
    if (previewRevision !== request.previewRevision) fail('TEXTURE_CONFLICT', '预览后像素发生变化；请重新预览再保存，当前草稿不会被覆盖。')
    const targetFile = safe(path.join(root, target.file))
    const lock = safe(path.join(root, '.modcrafting/texture.lock'))
    mkdirSync(path.dirname(lock), { recursive: true })
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }) } catch { return fail('TEXTURE_BUSY', '贴图正在保存或存在未恢复事务，请检查 texture.lock；不会自动删除。') }
    let before: Buffer | null = null, wrote = false
    try {
      // Re-read under the lock so an external edit between preview and save cannot be overwritten.
      const current = projectRevision(root, target.file)
      before = current.bytes
      if ((current.revision ?? null) !== request.expectedRevision) fail('TEXTURE_CONFLICT', '贴图或相关文件已改变；请重新读取后再保存，当前草稿不会被覆盖。')
      if (before && lstatSync(targetFile).nlink > 1) fail('TEXTURE_CONFLICT', '目标贴图存在硬链接，拒绝写入。')
      if (before) {
        const backup = safe(path.join(paths.dataRoot, 'texture-backups', hash(root), randomUUID() + '.png'))
        mkdirSync(path.dirname(backup), { recursive: true }); writeFileSync(backup, before, { flag: 'wx' })
        writeFileSync(safe(path.join(paths.dataRoot, 'texture-backups', hash(root), path.basename(backup, '.png') + '.json')), json({ textureId: request.textureId, createdAt: new Date().toISOString() }), { flag: 'wx' })
      }
      mkdirSync(path.dirname(targetFile), { recursive: true })
      const temporary = targetFile + '.modcrafting-' + randomUUID() + '.tmp'
      try { writeFileSync(temporary, png, { flag: 'wx' }); renameSync(temporary, targetFile); wrote = true }
      finally { if (existsSync(temporary)) unlinkSync(temporary) }
      const written = readFileSync(targetFile)
      if (hash(written) !== hash(Buffer.from(png))) throw new CoreError('TEXTURE_WRITE_FAILED', '写入后的贴图校验失败，已回滚。')
      const revision = hash(written), writtenImage = decodePng(written)
      return qualityPayload(request.textureId, target.file, written, writtenImage, analyzeTexture(writtenImage, analysisOptions(writtenImage, { ...request.options, size: inferSize(writtenImage) })), revision, { exists: true })
    } catch (cause) {
      if (wrote) try {
        if (before) writeFileSync(targetFile, before); else if (existsSync(targetFile)) unlinkSync(targetFile)
      } catch { /* Preserve the original error; the backup remains available. */ }
      throw cause
    } finally { try { unlinkSync(lock) } catch { /* Another writer must not inherit this lock. */ } }
  }

  if (request.action === 'bind') {
    const current = projectRevision(root, target.file)
    if (!current.bytes) fail('TEXTURE_NOT_FOUND', '请先保存贴图 PNG，再绑定到内容对象。')
    const read = contentWorkspace(paths, contentRequestSchema.parse({ action: 'read', projectPath: request.projectPath, id: request.contentId })) as { document?: { editable: boolean; revision: string; value?: ContentObject; reason?: string } }
    const document = read.document
    if (!document?.value) fail('CONTENT_NOT_FOUND', '没有找到要绑定的内容对象。')
    if (!document.editable) fail('CONTENT_READ_ONLY', document.reason || '内容对象不可安全编辑。')
    if (request.expectedRevision !== null && request.expectedRevision !== document.revision) fail('CONTENT_CONFLICT', '内容对象已改变；请重新读取后再绑定。')
    const value = { ...document.value, texture: request.textureId }
    const preview = contentWorkspace(paths, contentRequestSchema.parse({ action: 'preview', projectPath: request.projectPath, value, expectedRevision: document.revision })) as { previewRevision?: string }
    if (!preview.previewRevision) fail('CONTENT_CONFLICT', '内容预览未返回 revision，未写入。')
    const saved = contentWorkspace(paths, contentRequestSchema.parse({ action: 'save', projectPath: request.projectPath, value, expectedRevision: document.revision, previewRevision: preview.previewRevision })) as { document?: unknown }
    return { ok: true, contentId: request.contentId, textureId: request.textureId, document: saved.document }
  }

  return fail('INVALID_ARGUMENT', '未知的贴图操作。')
}
