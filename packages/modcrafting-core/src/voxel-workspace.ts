import path from 'node:path'
import { z } from 'zod'
import { contentObjectSchema, newContentObject, type ContentDocument, type ContentObject } from './content-model.ts'
import { contentWorkspace, type ContentRequest } from './content-workspace.ts'
import { inspectFabricProject } from './node.ts'
import { CoreError, resolveProjectPath } from './runtime.ts'
import type { RuntimePaths } from './contracts.ts'
import { voxelAsciiViews, voxelDslSchema, voxelLimits, validateVoxel, type VoxelDsl } from './voxel-dsl.ts'
import { analyzeVoxel } from './voxel-codegen.ts'

const fail = (code: string, message: string): never => { throw new CoreError(code, message) }
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const modelKind = z.enum(['block', 'item'])

export const voxelRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('template'), projectPath: z.string().min(1), kind: modelKind }).strict(),
  z.object({ action: z.literal('list'), projectPath: z.string().min(1) }).strict(),
  z.object({ action: z.literal('read'), projectPath: z.string().min(1), id: z.string().min(1) }).strict(),
  z.object({ action: z.literal('validate'), kind: modelKind, voxel: z.unknown() }).strict(),
  z.object({ action: z.literal('preview'), projectPath: z.string().min(1), value: contentObjectSchema, expectedRevision: revisionSchema.nullable() }).strict(),
  z.object({ action: z.literal('save'), projectPath: z.string().min(1), value: contentObjectSchema, expectedRevision: revisionSchema.nullable(), previewRevision: revisionSchema }).strict()
])
export type VoxelRequest = z.input<typeof voxelRequestSchema>

const VOXEL_HINT = '先用少量 box 定整体轮廓，再用 layers 补细节；调色板建议 ≤8 色；对称形状优先使用 mirror；layers 从下往上（第一层是 y=0）；每次修改后先 validate 查看 ASCII 三视图与 stats；cuboids 超限时开启 merge、quantize、downscale=2 或简化形状。'

const exampleVoxel = (): VoxelDsl => ({
  version: 1,
  size: [16, 16, 16],
  palette: { a: { color: '#3a2a1a', pattern: 'noise' }, b: '#ffcc55' },
  ops: [
    { op: 'box', p: 'a', from: [2, 0, 2], to: [13, 3, 13] },
    { op: 'box', p: 'b', from: [5, 4, 5], to: [10, 11, 10] },
    { op: 'box', p: 'a', from: [6, 12, 6], to: [9, 13, 9] }
  ],
  texture: { mode: 'shaded', resolution: 16 },
  optimize: { merge: true, quantize: 0, downscale: 1, removeFloating: false, maxCuboids: voxelLimits.defaultCuboids }
})

const requireProject = (projectPath: string) => {
  if (!path.isAbsolute(projectPath)) fail('PROJECT_UNAVAILABLE', '需要 Fabric 工程绝对路径')
  const project = inspectFabricProject(resolveProjectPath(projectPath))
  if (!project.valid || !project.modId || project.minecraftVersion !== '1.21.4') fail('PROJECT_UNAVAILABLE', '仅支持有效 Fabric 1.21.4 工程：' + project.errors.join('; '))
  return project
}

const atlasTexture = (value: ContentObject, modId: string): ContentObject => {
  if (!value.voxel) return value
  const name = value.id.split(':')[1]
  return { ...value, texture: `${modId}:${value.kind === 'block' ? 'block' : 'item'}/${name}_atlas` }
}

export function voxelWorkspace(paths: RuntimePaths, raw: VoxelRequest): Record<string, unknown> {
  const request = voxelRequestSchema.parse(raw)
  if (request.action === 'validate') {
    const check = validateVoxel(request.voxel)
    if (!check.ok) return { ok: false, code: 'VOXEL_DSL_INVALID', errors: check.errors, limits: voxelLimits, hint: VOXEL_HINT }
    const analysis = analyzeVoxel(check.value)
    return {
      ok: true, kind: request.kind, stats: analysis.stats, warnings: analysis.warnings,
      previews: voxelAsciiViews(analysis.grid, analysis.size, analysis.symbols), limits: voxelLimits, hint: VOXEL_HINT
    }
  }
  if (request.action === 'template') {
    const project = requireProject(request.projectPath)
    const value = newContentObject(request.kind, project.modId)
    value.voxel = exampleVoxel()
    value.texture = atlasTexture(value, project.modId).texture
    return { ok: true, value, schema: voxelDslSchema.toJSONSchema(), example: exampleVoxel(), limits: voxelLimits, hint: VOXEL_HINT }
  }
  if (request.action === 'list') {
    const result = contentWorkspace(paths, { action: 'list', projectPath: request.projectPath } as ContentRequest) as { documents?: ContentDocument[] }
    return { ok: true, documents: (result.documents ?? []).filter(document => document.value?.voxel) }
  }
  if (request.action === 'read') {
    return contentWorkspace(paths, { action: 'read', projectPath: request.projectPath, id: request.id } as ContentRequest)
  }
  const project = requireProject(request.projectPath)
  return contentWorkspace(paths, {
    action: request.action,
    projectPath: request.projectPath,
    value: atlasTexture(request.value, project.modId),
    expectedRevision: request.expectedRevision,
    ...(request.action === 'save' ? { previewRevision: request.previewRevision } : {})
  } as ContentRequest)
}
