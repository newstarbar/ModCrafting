import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { FABRIC_TARGET } from './domain.ts'
import { inspectFabricProject } from './node.ts'
import type { RuntimePaths } from './contracts.ts'
import { CoreError, projectRuntimePaths } from './runtime.ts'
import { validateRecipeContent } from './recipe-format.ts'

export const recipeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog'), projectPath: z.string().min(1) }).strict(),
  z.object({ action: z.literal('list'), projectPath: z.string().min(1) }).strict(),
  z.object({ action: z.literal('read'), projectPath: z.string().min(1), recipeId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('save'), projectPath: z.string().min(1), recipeId: z.string().min(1), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().min(1).max(65536) }).strict()
])
export type RecipeRequest = z.input<typeof recipeRequestSchema>
export type RecipeItem = { id: string; name: string; zhName?: string; stackSize?: number; source: 'vanilla' | 'project' }
export type RecipeDocument = { recipeId: string; file: string; revision: string; content: string; editable: boolean; errors: string[]; warnings: string[] }
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
function recipeFile(root: string, id: string) {
  if (!resourceId.test(id) || id.split(/[:/]/).some(part => !part || part === '.' || part === '..')) throw new CoreError('INVALID_RECIPE_ID', '使用 namespace:name 格式，禁止空段和路径穿越')
  const [namespace, name] = id.split(':')
  return safePath(path.join(root, 'src/main/resources/data', namespace, 'recipe', name + '.json'))
}
function readDocument(root: string, recipeId: string): RecipeDocument {
  const file = recipeFile(root, recipeId)
  if (!existsSync(file)) throw new CoreError('RECIPE_NOT_FOUND', '配方文件不存在')
  if (lstatSync(file).size > 65536) throw new CoreError('RECIPE_LIMIT', '配方文件超过 64KB')
  const bytes = readFileSync(file), content = bytes.toString('utf8')
  const validation = validateRecipeContent(content)
  return { recipeId, file: path.relative(root, file).replaceAll('\\', '/'), revision: hash(bytes), content, editable: validation.valid, errors: validation.errors, warnings: validation.warnings }
}
function catalog(paths: RuntimePaths, root: string): RecipeItem[] {
  const file = path.join(projectRuntimePaths(paths, root).knowledgeRoot, 'minecraft-data', FABRIC_TARGET.minecraft, 'index.json')
  if (!existsSync(file)) throw new CoreError('ASSET_UNAVAILABLE', '请先准备 minecraft-data 知识数据；不自动下载资源')
  const data = JSON.parse(readFileSync(file, 'utf8')) as { itemsById?: Record<string, Record<string, unknown>> }
  if (!data.itemsById) throw new CoreError('ASSET_UNAVAILABLE', 'minecraft-data 缺少 itemsById')
  const items: RecipeItem[] = Object.entries(data.itemsById).filter(([id]) => id !== 'minecraft:air').map(([id, value]) => ({ id, name: String(value.name || id), zhName: typeof value.zhName === 'string' ? value.zhName : undefined, stackSize: Number(value.stackSize || 64), source: 'vanilla' }))
  const assets = path.join(root, 'src/main/resources/assets')
  if (existsSync(assets)) for (const ns of readdirSync(assets, { withFileTypes: true })) {
    if (!ns.isDirectory()) continue
    for (const type of ['items', 'models/item']) for (const file of walk(path.join(assets, ns.name, type))) {
      const id = ns.name + ':' + path.relative(path.join(assets, ns.name, type), file).replaceAll('\\', '/').replace(/\.json$/, '')
      if (!items.some(item => item.id === id)) items.push({ id, name: id.split(':')[1], source: 'project' })
    }
  }
  return items
}

/** Same file-based recipe operations for the browser and external Agent. */
export function recipeWorkspace(paths: RuntimePaths, raw: RecipeRequest): Record<string, unknown> {
  const request = recipeRequestSchema.parse(raw)
  if (!path.isAbsolute(request.projectPath)) throw new CoreError('PROJECT_UNAVAILABLE', '请提供工程绝对路径')
  const root = safePath(path.resolve(request.projectPath)), project = inspectFabricProject(root)
  if (!project.valid) throw new CoreError('PROJECT_UNAVAILABLE', project.errors.join('; '))
  if (request.action === 'catalog') return { ok: true, items: catalog(paths, root) }
  if (request.action === 'list') {
    const data = path.join(root, 'src/main/resources/data')
    const recipes: RecipeDocument[] = []
    if (existsSync(data)) for (const ns of readdirSync(data, { withFileTypes: true })) {
      if (!ns.isDirectory()) continue
      const directory = path.join(data, ns.name, 'recipe')
      for (const file of walk(directory)) {
        const id = ns.name + ':' + path.relative(directory, file).replaceAll('\\', '/').replace(/\.json$/, '')
        recipes.push(readDocument(root, id))
      }
    }
    return { ok: true, recipes }
  }
  if (request.action === 'read') return { ok: true, document: readDocument(root, request.recipeId) }
  const file = recipeFile(root, request.recipeId)
  // Updating is allowed only after the Agent/browser has read the current revision.
  const checkRevision = () => {
    safePath(file)
    const current = existsSync(file) ? hash(readFileSync(file)) : null
    if (current !== request.expectedRevision) throw new CoreError('RECIPE_CONFLICT', '配方已被外部修改。草稿已保留，请重新加载并比较，不能直接覆盖。')
  }
  checkRevision()
  const items = catalog(paths, root), vanilla = new Set(items.filter(item => item.source === 'vanilla').map(item => item.id))
  const validation = validateRecipeContent(request.content, { knownVanillaIds: vanilla })
  if (!validation.valid) throw new CoreError('INVALID_RECIPE', validation.errors.join('; '))
  const parsed = JSON.parse(request.content), result = typeof parsed.result === 'string' ? { id: parsed.result, count: 1 } : parsed.result
  const output = items.find(item => item.id === result.id)
  if (!output) throw new CoreError('INVALID_RECIPE', '产物不在原版/工程物品目录中：' + result.id)
  if ((result.count ?? 1) > (output.stackSize || 64)) throw new CoreError('INVALID_RECIPE', '产物数量超过物品堆叠上限')
  const ingredients = parsed.type === 'minecraft:crafting_shaped' ? Object.values(parsed.key) : parsed.ingredients || [parsed.ingredient]
  for (const id of ingredients as string[]) {
    if (id === 'minecraft:air' || !id.startsWith('#') && !items.some(item => item.id === id)) throw new CoreError('INVALID_RECIPE', '未知材料：' + id)
  }
  if (request.expectedRevision && !readDocument(root, request.recipeId).editable) throw new CoreError('RECIPE_READ_ONLY', '不支持的配方必须保留为只读')
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
      if (!existsSync(backup)) writeFileSync(backup, readFileSync(file), { flag: 'wx' })
      checkRevision(); renameSync(temporary, file); ownsTemporary = false
    }
  } finally { if (ownsTemporary) unlinkSync(temporary) }
  return { ok: true, document: readDocument(root, request.recipeId) }
}
