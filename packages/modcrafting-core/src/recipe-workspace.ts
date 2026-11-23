import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { inspectFabricProject, resolveKnowledgeIndex } from './node.ts'
import type { RuntimePaths } from './contracts.ts'
import { CoreError, projectRuntimePaths } from './runtime.ts'
import { validateRecipeContent } from './recipe-format.ts'
import { recipeContentFromDraft, recipeDraftFromContent } from './recipe-editor.ts'
import { isRecipeInTargetDialect, readRecipeRefs } from './resources/validate.ts'
import type { ResourceLayout } from './resources/layout.ts'
import { projectLayout } from './version/project-gate.ts'

export const recipeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog'), projectPath: z.string().min(1) }).strict(),
  z.object({ action: z.literal('list'), projectPath: z.string().min(1) }).strict(),
  z.object({ action: z.literal('read'), projectPath: z.string().min(1), recipeId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('save'), projectPath: z.string().min(1), recipeId: z.string().min(1), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().min(1).max(65536) }).strict(),
  z.object({ action: z.literal('migrate'), projectPath: z.string().min(1), recipeId: z.string().min(1), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict()
])
export type RecipeRequest = z.input<typeof recipeRequestSchema>
export type RecipeItem = { id: string; name: string; zhName?: string; stackSize?: number; source: 'vanilla' | 'project' }
export type RecipeDocument = { recipeId: string; file: string; revision: string; content: string; editable: boolean; errors: string[]; warnings: string[]; inTargetDialect?: boolean; minecraft?: string }
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const resourceId = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/

function safePath(file: string) {
  for (let part = path.resolve(file); ; part = path.dirname(part)) {
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new CoreError('RECIPE_PATH_UNSAFE', '配方路径不能经过链接或 junction')
    if (path.dirname(part) === part) break
  }
  return file
}
function walk(directory: string, max = 4000): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  function visit(dir: string) {
    safePath(dir)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new CoreError('RECIPE_PATH_UNSAFE', '资源目录包含链接，请先核对工程路径')
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(file)
      if (files.length > max) throw new CoreError('RECIPE_LIMIT', '工程资源数量过多，请缩小资源范围')
    }
  }
  visit(directory); return files
}
function splitId(id: string): [string, string] {
  if (!resourceId.test(id) || id.split(/[:/]/).some(part => !part || part === '.' || part === '..')) throw new CoreError('INVALID_RECIPE_ID', '使用 namespace:name 格式，禁止空段和路径穿越')
  const [namespace, name] = id.split(':')
  return [namespace, name]
}
/** Where a save must land: always the target dialect directory. */
function recipeWriteFile(root: string, layout: ResourceLayout, id: string): string {
  const [namespace, name] = splitId(id)
  return safePath(path.join(root, layout.recipePath(namespace, name)))
}
/** Where a read should look: target first, then the other directory. */
function recipeReadFile(root: string, layout: ResourceLayout, id: string): { file: string; inTargetDialect: boolean } | undefined {
  const [namespace, name] = splitId(id)
  for (const dir of layout.recipeDirs()) {
    const file = safePath(path.join(root, 'src/main/resources/data', namespace, dir, name + '.json'))
    if (existsSync(file)) return { file, inTargetDialect: dir === layout.recipeDir }
  }
  return undefined
}
function readDocument(root: string, layout: ResourceLayout, recipeId: string): RecipeDocument {
  const found = recipeReadFile(root, layout, recipeId)
  if (!found) throw new CoreError('RECIPE_NOT_FOUND', '配方文件不存在')
  if (lstatSync(found.file).size > 65536) throw new CoreError('RECIPE_LIMIT', '配方文件超过 64KB')
  const bytes = readFileSync(found.file), content = bytes.toString('utf8')
  const validation = validateRecipeContent(content, { mcVersion: layout.minecraft })
  const warnings = [...validation.warnings]
  if (!found.inTargetDialect) warnings.push(`该配方位于 ${path.basename(path.dirname(found.file))} 目录，${layout.minecraft} 使用 ${layout.recipeDir}；游戏不会加载它，保存时会写入正确目录。`)
  if (!isRecipeInTargetDialect(content, layout)) warnings.push(`配方字段形状不属于 ${layout.minecraft} 方言，可能无法被游戏加载。`)
  return { recipeId, file: path.relative(root, found.file).replaceAll('\\', '/'), revision: hash(bytes), content, editable: validation.valid, errors: validation.errors, warnings, inTargetDialect: found.inTargetDialect, minecraft: layout.minecraft }
}
function catalog(paths: RuntimePaths, root: string, layout: ResourceLayout): { items: RecipeItem[]; dataVersion: string; exact: boolean; warning?: string } {
  const resolution = resolveKnowledgeIndex(projectRuntimePaths(paths, root).knowledgeRoot, layout.minecraft)
  if (!resolution) throw new CoreError('ASSET_UNAVAILABLE', '请先准备 minecraft-data 知识数据；不自动下载资源')
  const data = JSON.parse(readFileSync(resolution.file, 'utf8')) as { itemsById?: Record<string, Record<string, unknown>> }
  if (!data.itemsById) throw new CoreError('ASSET_UNAVAILABLE', 'minecraft-data 缺少 itemsById')
  const items: RecipeItem[] = Object.entries(data.itemsById).filter(([id]) => id !== 'minecraft:air').map(([id, value]) => ({ id, name: String(value.name || id), zhName: typeof value.zhName === 'string' ? value.zhName : undefined, stackSize: Number(value.stackSize || 64), source: 'vanilla' }))
  const assets = path.join(root, 'src/main/resources/assets')
  if (existsSync(assets)) for (const ns of readdirSync(assets, { withFileTypes: true })) {
    if (!ns.isDirectory()) continue
    // Item model definitions exist only from 1.21.4; older targets keep models/item only.
    const types = layout.itemModelDefinition === 'assets-items' ? ['items', 'models/item'] : ['models/item']
    for (const type of types) for (const file of walk(path.join(assets, ns.name, type))) {
      const id = ns.name + ':' + path.relative(path.join(assets, ns.name, type), file).replaceAll('\\', '/').replace(/\.json$/, '')
      if (!items.some(item => item.id === id)) items.push({ id, name: id.split(':')[1], source: 'project' })
    }
  }
  return {
    items,
    dataVersion: resolution.minecraft,
    exact: resolution.exact,
    ...(resolution.exact ? {} : { warning: `物品目录来自 ${resolution.minecraft} 的知识数据，不是 ${layout.minecraft}；保存前的校验可能包含该版本不存在的物品。` })
  }
}

/** Same file-based recipe operations for the browser and external Agent. */
export function recipeWorkspace(paths: RuntimePaths, raw: RecipeRequest): Record<string, unknown> {
  const request = recipeRequestSchema.parse(raw)
  if (!path.isAbsolute(request.projectPath)) throw new CoreError('PROJECT_UNAVAILABLE', '请提供工程绝对路径')
  const root = safePath(path.resolve(request.projectPath)), project = inspectFabricProject(root)
  if (!project.valid) throw new CoreError('PROJECT_UNAVAILABLE', project.errors.join('; '))
  const resolved = projectLayout(project), layout = resolved.layout
  if (request.action === 'catalog') return { ok: true, ...catalog(paths, root, layout), minecraft: layout.minecraft, ...(resolved.warning ? { layoutWarning: resolved.warning } : {}) }
  if (request.action === 'list') {
    const data = path.join(root, 'src/main/resources/data')
    const recipes: RecipeDocument[] = []
    const seen = new Set<string>()
    if (existsSync(data)) for (const ns of readdirSync(data, { withFileTypes: true })) {
      if (!ns.isDirectory()) continue
      // Target directory first, so a stale file in the other one cannot shadow it.
      for (const dir of layout.recipeDirs()) {
        const directory = path.join(data, ns.name, dir)
        for (const file of walk(directory)) {
          const id = ns.name + ':' + path.relative(directory, file).replaceAll('\\', '/').replace(/\.json$/, '')
          if (seen.has(id)) continue
          seen.add(id)
          recipes.push(readDocument(root, layout, id))
        }
      }
    }
    return { ok: true, recipes, minecraft: layout.minecraft }
  }
  if (request.action === 'read') return { ok: true, document: readDocument(root, layout, request.recipeId), minecraft: layout.minecraft }
  if (request.action === 'migrate') {
    const existing = recipeReadFile(root, layout, request.recipeId)
    if (!existing) throw new CoreError('RECIPE_NOT_FOUND', '配方文件不存在')
    if (existing.inTargetDialect) return { ok: true, noop: true, document: readDocument(root, layout, request.recipeId) }
    const original = readFileSync(existing.file, 'utf8'), currentHash = hash(original)
    if (currentHash !== request.expectedRevision) throw new CoreError('RECIPE_CONFLICT', '配方已改变，请重新读取后再迁移')
    let content: string
    // Rewriting the JSON, not moving the file: older dialects use different field shapes.
    try { content = recipeContentFromDraft(recipeDraftFromContent(original), original, layout.minecraft) }
    catch { throw new CoreError('RECIPE_READ_ONLY', '不支持的配方类型，保留原文件为只读') }
    const validation = validateRecipeContent(content, { mcVersion: layout.minecraft })
    if (!validation.valid) throw new CoreError('INVALID_RECIPE', validation.errors.join('; '))
    const target = recipeWriteFile(root, layout, request.recipeId)
    mkdirSync(safePath(path.dirname(target)), { recursive: true })
    const backup = safePath(path.join(paths.dataRoot, 'recipe-backups', hash(root), currentHash + '.json'))
    mkdirSync(path.dirname(backup), { recursive: true })
    if (!existsSync(backup)) writeFileSync(backup, original, { flag: 'wx' })
    writeFileSync(target, content, { flag: 'w' })
    unlinkSync(existing.file)
    return {
      ok: true, migrated: true,
      from: path.relative(root, existing.file).replaceAll('\\', '/'),
      to: path.relative(root, target).replaceAll('\\', '/'),
      backup,
      document: readDocument(root, layout, request.recipeId)
    }
  }
  const file = recipeWriteFile(root, layout, request.recipeId)
  const existing = recipeReadFile(root, layout, request.recipeId)
  // Updating is allowed only after the Agent/browser has read the current revision.
  const checkRevision = () => {
    safePath(file)
    const current = existing && existsSync(existing.file) ? hash(readFileSync(existing.file)) : null
    if (current !== request.expectedRevision) throw new CoreError('RECIPE_CONFLICT', '配方已被外部修改。草稿已保留，请重新加载并比较，不能直接覆盖。')
  }
  checkRevision()
  const catalogResult = catalog(paths, root, layout), items = catalogResult.items
  const vanilla = new Set(items.filter(item => item.source === 'vanilla').map(item => item.id))
  const validation = validateRecipeContent(request.content, { knownVanillaIds: vanilla, mcVersion: layout.minecraft })
  if (!validation.valid) throw new CoreError('INVALID_RECIPE', validation.errors.join('; '))
  const refs = readRecipeRefs(request.content)
  if (!refs?.result.id) throw new CoreError('INVALID_RECIPE', '配方缺少产物 ID')
  const output = items.find(item => item.id === refs.result.id)
  if (!output) throw new CoreError('INVALID_RECIPE', '产物不在原版/工程物品目录中：' + refs.result.id)
  if (refs.result.count > (output.stackSize || 64)) throw new CoreError('INVALID_RECIPE', '产物数量超过物品堆叠上限')
  for (const id of refs.ingredients) {
    if (id === 'minecraft:air' || !id.startsWith('#') && !items.some(item => item.id === id)) throw new CoreError('INVALID_RECIPE', '未知材料：' + id)
  }
  // Unsupported serializers stay read-only: we must never "normalise" a file we cannot understand.
  if (request.expectedRevision && !readDocument(root, layout, request.recipeId).editable) throw new CoreError('RECIPE_READ_ONLY', '不支持的配方必须保留为只读')
  const parsed = JSON.parse(request.content)
  const content = JSON.stringify(parsed, null, 2) + '\n'
  mkdirSync(safePath(path.dirname(file)), { recursive: true })
  const temporary = file + `.modcrafting-${process.pid}-${Date.now()}.tmp`
  let ownsTemporary = false
  try {
    writeFileSync(temporary, content, { flag: 'wx' }); ownsTemporary = true
    checkRevision()
    if (request.expectedRevision === null) writeFileSync(file, content, { flag: 'wx' })
    else {
      const backup = safePath(path.join(paths.dataRoot, 'recipe-backups', hash(root), request.expectedRevision + '.json'))
      mkdirSync(path.dirname(backup), { recursive: true })
      if (!existsSync(backup) && existing && existsSync(existing.file)) writeFileSync(backup, readFileSync(existing.file), { flag: 'wx' })
      checkRevision(); renameSync(temporary, file); ownsTemporary = false
    }
  } finally { if (ownsTemporary) unlinkSync(temporary) }
  const staleLegacy = existing && !existing.inTargetDialect
  return {
    ok: true,
    document: readDocument(root, layout, request.recipeId),
    minecraft: layout.minecraft,
    // The legacy file is left untouched on purpose: only an explicit migration deletes it.
    ...(staleLegacy ? { migrationRequired: true, legacyFile: path.relative(root, existing.file).replaceAll('\\', '/') } : {}),
    ...(catalogResult.exact ? {} : { catalogWarning: catalogResult.warning })
  }
}
