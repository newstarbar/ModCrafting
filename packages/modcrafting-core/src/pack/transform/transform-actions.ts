/**
 * Applying, rolling back and auditing a pack transform.
 *
 * Every level goes through the same sequence: resolve the entry, read the jar it
 * names, verify the bytes against the lock hashes, ask the licence/consent gate,
 * and only then write anything. A refusal is written to the audit log before the
 * error is thrown, because a refused operation the user cannot see afterwards is
 * indistinguishable from one that silently did nothing.
 *
 * The output is always a new artifact under `<pack>/transforms/<transformId>/`.
 * No level edits `mods/<file>.jar`: L1 builds a separate resource pack, L2 writes a
 * separate project, L3 writes a plan, L4 writes an inventory. Rollback removes what
 * this module created, and only deletes a companion project when asked and when
 * its marker matches.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { parseTargetId, resolveTarget } from '../../version/targets.ts'
import type { PackEntry } from '../../workspace-model.ts'
import { loadPackWorkspace, type PackWorkspace } from '../pack-workspace.ts'
import { buildOverlayZip, type L1Operation } from './l1-overlay.ts'
import { scaffoldCompanion, type CompanionTarget } from './l2-companion.ts'
import { buildBytecodePlan } from './l3-bytecode.ts'
import { analyzeJar } from './l4-analysis.ts'
import {
  TRANSFORM_LEVELS,
  appendTransformAudit,
  auditPath,
  evaluateTransform,
  readTransformAudit,
  type TransformDecision,
  type TransformLevel
} from './trust.ts'

const TRANSFORM_ID_RE = /^[a-z0-9][a-z0-9_.-]*-l[1-4]-[a-f0-9]{12}$/
const MOD_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/
const JAVA_CLASS_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
const JAVA_METHOD_RE = /^[A-Za-z_$<][\w$<>]*$/

const operationSchema = z.object({
  path: z.string().min(1).max(512),
  text: z.string().max(2_000_000).optional(),
  base64: z.string().max(4_000_000).optional(),
  copy: z.boolean().optional()
}).strict()

const patchSchema = z.object({
  className: z.string().regex(JAVA_CLASS_RE, 'className 必须是 com.example.Example 这样的全限定名'),
  method: z.string().regex(JAVA_METHOD_RE, 'method 必须是 Java 方法名，构造器用 <init>'),
  description: z.string().trim().min(1).max(500)
}).strict()

const companionSchema = z.object({
  projectPath: z.string().min(1).max(1024),
  modId: z.string().regex(MOD_ID_RE, 'modId 必须是小写字母开头，只含 a-z0-9_-'),
  modName: z.string().trim().min(1).max(80),
  sourceModId: z.string().regex(MOD_ID_RE, 'sourceModId 必须是小写字母开头，只含 a-z0-9_-'),
  targets: z.array(z.object({
    className: z.string().regex(JAVA_CLASS_RE, 'className 必须是 com.example.Example 这样的全限定名'),
    method: z.string().regex(JAVA_METHOD_RE, 'method 必须是 Java 方法名，构造器用 <init>').optional(),
    at: z.enum(['HEAD', 'TAIL', 'RETURN']).optional()
  }).strict()).min(1).max(32)
}).strict()

export const transformActionRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply'),
    level: z.enum(TRANSFORM_LEVELS),
    workspacePath: z.string().min(1),
    entryId: z.string().min(1).max(64),
    /** Required only by L3/L4; L1/L2 ignore it. */
    consent: z.boolean().optional(),
    generatedAt: z.string().min(1).optional(),
    packFormat: z.number().int().min(1).max(999).optional(),
    operations: z.array(operationSchema).min(1).max(2048).optional(),
    companion: companionSchema.optional(),
    patches: z.array(patchSchema).min(1).max(2048).optional(),
    maxClasses: z.number().int().min(1).max(20_000).optional()
  }).strict(),
  z.object({
    action: z.literal('rollback'),
    workspacePath: z.string().min(1),
    transformId: z.string().min(1).max(160),
    deleteProject: z.boolean().optional()
  }).strict(),
  z.object({
    action: z.literal('audit'),
    workspacePath: z.string().min(1),
    limit: z.number().int().min(1).max(1000).optional()
  }).strict()
])
export type TransformActionRequest = z.infer<typeof transformActionRequestSchema>

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'entry'
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function transformsRoot(workspacePath: string): string {
  return path.join(path.resolve(workspacePath), 'transforms')
}

function manifestFileFor(outputDir: string): string {
  return path.join(outputDir, 'manifest.json')
}

function readManifest(outputDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestFileFor(outputDir), 'utf8')) as Record<string, unknown>
}

/** Turning a stored manifest back into the response shape, so a re-apply is as informative as the first call. */
function manifestResult(manifest: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const output = (manifest.output ?? {}) as Record<string, unknown>
  const decision = (manifest.decision ?? {}) as Record<string, unknown>
  return {
    ok: true,
    action: 'apply',
    level: manifest.level,
    entryId: manifest.entryId,
    transformId: manifest.transformId,
    exportable: decision.exportable === true,
    decision,
    warnings: manifest.warnings ?? [],
    output: output.path,
    ...output,
    ...extra
  }
}

interface SourceFacts {
  fileName: string
  file: string
  bytes: Buffer
  sha1?: string
  sha512?: string
  sha256: string
  warnings: string[]
}

function refuse(
  workspace: PackWorkspace,
  input: {
    at: string
    level: TransformLevel
    entryId: string
    code: string
    message: string
    source?: { fileName: string; sha1?: string; sha512?: string }
    transformId?: string
  }
): never {
  appendTransformAudit(workspace.path, {
    schemaVersion: 1,
    at: input.at,
    action: 'refuse',
    level: input.level,
    entryId: input.entryId,
    ...(input.transformId ? { transformId: input.transformId } : {}),
    decision: { allowed: false, exportable: false, code: input.code, message: input.message },
    ...(input.source ? { source: input.source } : {})
  })
  fail(input.code, input.message)
}

function readSource(workspace: PackWorkspace, entry: PackEntry, level: TransformLevel, at: string): SourceFacts {
  const file = path.join(workspace.path, 'mods', entry.fileName)
  if (!existsSync(file) || !statSync(file).isFile()) {
    refuse(workspace, {
      at, level, entryId: entry.entryId, code: 'TRANSFORM_SOURCE_MISSING',
      message: `整合包的 mods/ 下没有 ${entry.fileName}。请先安装或下载该 jar（可以在整合包面板里求解并获取），再执行改造。`,
      source: { fileName: entry.fileName, ...entry.hashes }
    })
  }
  const bytes = readFileSync(file)
  const actualSha1 = createHash('sha1').update(bytes).digest('hex')
  const actualSha512 = createHash('sha512').update(bytes).digest('hex')
  const mismatch = (entry.hashes.sha1 && entry.hashes.sha1.toLowerCase() !== actualSha1)
    || (entry.hashes.sha512 && entry.hashes.sha512.toLowerCase() !== actualSha512)
  if (mismatch) {
    refuse(workspace, {
      at, level, entryId: entry.entryId, code: 'TRANSFORM_HASH_MISMATCH',
      message: `${entry.fileName} 的字节与清单记录的哈希不一致，可能被替换或损坏。拒绝在未验证的 jar 上做改造；请重新下载并核对来源。`,
      source: { fileName: entry.fileName, ...entry.hashes }
    })
  }
  const warnings: string[] = []
  if (!entry.hashes.sha1 && !entry.hashes.sha512) {
    warnings.push(`${entry.fileName} 在清单里没有哈希，无法验证 jar 是否被替换；建议先补全 sha1/sha512。`)
  }
  return { fileName: entry.fileName, file, bytes, ...entry.hashes, sha256: sha256(bytes), warnings }
}

function decisionConflict(decision: TransformDecision): { allowed: boolean; exportable: boolean; reasons: string[]; message: string; code?: string } {
  return {
    allowed: decision.allowed,
    exportable: decision.exportable,
    reasons: decision.reasons,
    message: decision.message,
    ...(decision.code ? { code: decision.code } : {})
  }
}

function outputDirFor(workspacePath: string, transformId: string): string {
  return path.join(transformsRoot(workspacePath), transformId)
}

function assertInsideTransforms(workspacePath: string, outputDir: string): void {
  const root = path.resolve(transformsRoot(workspacePath))
  const relative = path.relative(root, path.resolve(outputDir))
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    fail('TRANSFORM_NOT_FOUND', `改造记录路径不合法：${outputDir}`)
  }
}

async function applyTransform(request: Extract<TransformActionRequest, { action: 'apply' }>): Promise<Record<string, unknown>> {
  const workspace = loadPackWorkspace(request.workspacePath)
  const entry = workspace.manifest.entries.find((candidate) => candidate.entryId === request.entryId)
  if (!entry) {
    fail('TRANSFORM_ENTRY_NOT_FOUND', `整合包里没有条目 ${request.entryId}。请刷新清单，确认条目已被添加且 entryId 正确。`)
  }
  if (!entry.enabled) {
    fail('TRANSFORM_ENTRY_DISABLED', `条目 ${entry.entryId} 当前被禁用。请先在整合包面板启用它，再进行改造。`)
  }

  const at = request.generatedAt ?? new Date().toISOString()
  const source = readSource(workspace, entry, request.level, at)
  const decision = evaluateTransform({ level: request.level, license: entry.license, consent: request.consent === true })

  const payload = (() => {
    switch (request.level) {
      case 'L1':
        return { level: 'L1', entryId: entry.entryId, source: source.sha256, packFormat: request.packFormat ?? 46, operations: request.operations ?? [] }
      case 'L2':
        return { level: 'L2', entryId: entry.entryId, source: source.sha256, companion: request.companion ?? null }
      case 'L3':
        return { level: 'L3', entryId: entry.entryId, source: source.sha256, patches: request.patches ?? [] }
      case 'L4':
        return { level: 'L4', entryId: entry.entryId, source: source.sha256, maxClasses: request.maxClasses ?? 200 }
    }
  })()
  const transformId = `${slug(entry.entryId)}-${request.level.toLowerCase()}-${sha256(JSON.stringify(payload)).slice(0, 12)}`
  const outputDir = outputDirFor(workspace.path, transformId)

  if (!decision.allowed || decision.code) {
    refuse(workspace, {
      at, level: request.level, entryId: entry.entryId, transformId,
      code: decision.code ?? 'TRANSFORM_BLOCKED',
      message: decision.message,
      source: { fileName: source.fileName, sha1: source.sha1, sha512: source.sha512 }
    })
  }

  // An identical request after the first one returns the artifact it already
  // produced instead of rewriting it; the licence gate above still ran, so a
  // later consent requirement is not bypassed by an old output.
  if (existsSync(manifestFileFor(outputDir))) {
    return manifestResult(readManifest(outputDir), { existing: true })
  }

  const warnings = [...source.warnings]
  const sourceFacts = {
    fileName: source.fileName,
    ...(source.sha1 ? { sha1: source.sha1 } : {}),
    ...(source.sha512 ? { sha512: source.sha512 } : {}),
    sha256: source.sha256
  }
  let output: Record<string, unknown>
  let extra: Record<string, unknown> = {}

  if (request.level === 'L1') {
    if (!request.operations || request.operations.length === 0) {
      fail('TRANSFORM_OPERATIONS_REQUIRED', 'L1 至少需要一个覆盖操作（path + text/base64/copy）。')
    }
    const overlay = buildOverlayZip({
      jarBytes: source.bytes,
      entryId: entry.entryId,
      operations: request.operations as L1Operation[],
      packFormat: request.packFormat ?? 46,
      provenance: {
        schemaVersion: 1,
        level: 'L1',
        transformId,
        entryId: entry.entryId,
        createdAt: at,
        source: sourceFacts,
        license: entry.license,
        decision: decisionConflict(decision)
      }
    })
    mkdirSync(outputDir, { recursive: true })
    const zipFile = path.join(outputDir, 'overlay.zip')
    writeFileSync(zipFile, overlay.archive)
    output = { kind: 'overlay', path: outputDir, zip: zipFile, files: overlay.files }
    extra = { zip: zipFile, files: overlay.files }
    warnings.push('L1 产物是独立资源包；它不会替换 mods/ 里的源 jar。')
  } else if (request.level === 'L2') {
    if (!request.companion) fail('TRANSFORM_COMPANION_REQUIRED', 'L2 需要 companion 配置：工程路径、modId、sourceModId 和至少一个 mixin 目标。')
    const { loader, minecraft } = parseTargetId(workspace.manifest.targetId)
    if (loader !== 'fabric') {
      fail('TRANSFORM_FABRIC_ONLY', `整合包目标是 ${workspace.manifest.targetId}。v1 的 L2 伴生工程只生成 Fabric 源码；请把目标改为 Fabric，或改用 L1/L3/L4。`)
    }
    let target
    try {
      target = resolveTarget(loader, minecraft)
    } catch (cause) {
      fail('TRANSFORM_TARGET_UNSUPPORTED', `无法解析 ${workspace.manifest.targetId}：${(cause as Error).message}`)
    }
    const scaffolded = await scaffoldCompanion({
      workspacePath: workspace.path,
      projectPath: request.companion.projectPath,
      target,
      entryId: entry.entryId,
      sourceModId: request.companion.sourceModId,
      modId: request.companion.modId,
      modName: request.companion.modName,
      targets: request.companion.targets as CompanionTarget[],
      transformId,
      generatedAt: at,
      decision: decisionConflict(decision)
    })
    mkdirSync(outputDir, { recursive: true })
    const projectPath = path.resolve(request.companion.projectPath)
    output = {
      kind: 'companion',
      path: projectPath,
      projectPath,
      transformDir: outputDir,
      files: scaffolded.files
    }
    extra = { projectPath, transformDir: outputDir, files: scaffolded.files }
    warnings.push('L2 伴生工程使用字符串 mixin 目标，未把源 jar 放进编译类路径；构建前请确认目标类名与方法名。')
  } else if (request.level === 'L3') {
    if (!request.patches || request.patches.length === 0) {
      fail('TRANSFORM_PATCHES_REQUIRED', 'L3 至少需要一个补丁计划（className + method + description）。')
    }
    const plan = buildBytecodePlan({
      transformId,
      entryId: entry.entryId,
      source: sourceFacts,
      patches: request.patches,
      decision: decisionConflict(decision),
      generatedAt: at
    })
    mkdirSync(outputDir, { recursive: true })
    const planFile = path.join(outputDir, 'bytecode-plan.json')
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    output = { kind: 'bytecode-plan', path: outputDir, plan: planFile, applied: false, patches: request.patches.length }
    extra = { plan: planFile, applied: false, patches: request.patches.length }
    warnings.push('L3 只写出补丁计划；当前版本不含字节码引擎，源 jar 未被修改。')
  } else {
    const analysisWarnings: string[] = []
    const maxClasses = request.maxClasses ?? 200
    const analysis = analyzeJar(source.bytes, maxClasses, { warn: (message) => analysisWarnings.push(message) })
    warnings.push(...analysisWarnings)
    const analysisDocument = {
      schemaVersion: 1,
      level: 'L4',
      transformId,
      entryId: entry.entryId,
      createdAt: at,
      source: sourceFacts,
      decision: decisionConflict(decision),
      ...analysis
    }
    mkdirSync(outputDir, { recursive: true })
    const analysisFile = path.join(outputDir, 'analysis.json')
    writeFileSync(analysisFile, `${JSON.stringify(analysisDocument, null, 2)}\n`, 'utf8')
    output = {
      kind: 'analysis',
      path: outputDir,
      analysis: analysisFile,
      classes: analysis.classes.length,
      decompiler: 'not-shipped',
      truncated: analysis.truncated
    }
    extra = {
      analysis: analysisFile,
      classes: analysis.classes.length,
      decompiler: 'not-shipped',
      truncated: analysis.truncated
    }
    warnings.push('L4 只做结构清单，包含类名与大小；当前版本不含反编译器，产物不可导出。')
  }

  const manifest = {
    schemaVersion: 1,
    level: request.level,
    transformId,
    entryId: entry.entryId,
    createdAt: at,
    source: sourceFacts,
    license: entry.license,
    decision: decisionConflict(decision),
    output,
    warnings
  }
  writeFileSync(manifestFileFor(outputDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  appendTransformAudit(workspace.path, {
    schemaVersion: 1,
    at,
    action: 'apply',
    level: request.level,
    entryId: entry.entryId,
    transformId,
    decision: {
      allowed: true,
      exportable: decision.exportable,
      message: decision.message
    },
    source: { fileName: source.fileName, sha1: source.sha1, sha512: source.sha512 }
  })

  return manifestResult(manifest, extra)
}

function rollbackTransform(request: Extract<TransformActionRequest, { action: 'rollback' }>): Record<string, unknown> {
  const workspace = loadPackWorkspace(request.workspacePath)
  if (!TRANSFORM_ID_RE.test(request.transformId)) {
    fail('TRANSFORM_NOT_FOUND', `找不到改造记录 ${request.transformId}。请从审计日志或面板结果中复制完整的 transformId。`)
  }
  const outputDir = outputDirFor(workspace.path, request.transformId)
  assertInsideTransforms(workspace.path, outputDir)
  if (!existsSync(manifestFileFor(outputDir))) {
    fail('TRANSFORM_NOT_FOUND', `找不到改造记录 ${request.transformId}；它可能已经回滚。`)
  }
  const manifest = readManifest(outputDir)
  if (manifest.transformId !== request.transformId) {
    fail('TRANSFORM_NOT_FOUND', `记录 ${request.transformId} 的清单不一致，拒绝删除任何文件。`)
  }

  const output = (manifest.output ?? {}) as Record<string, unknown>
  const decision = (manifest.decision ?? {}) as Record<string, unknown>
  let keptProject = false
  if (output.kind === 'companion' && typeof output.projectPath === 'string') {
    const projectPath = path.resolve(output.projectPath)
    if (request.deleteProject === true) {
      const markerFile = path.join(projectPath, '.modcrafting-transform.json')
      let marker: Record<string, unknown> | null = null
      try {
        marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>
      } catch {
        marker = null
      }
      if (marker?.transformId === request.transformId) {
        rmSync(projectPath, { recursive: true, force: true })
      } else {
        keptProject = true
      }
    } else {
      keptProject = true
    }
  }

  rmSync(outputDir, { recursive: true, force: true })
  appendTransformAudit(workspace.path, {
    schemaVersion: 1,
    at: new Date().toISOString(),
    action: 'rollback',
    level: (manifest.level ?? 'L1') as TransformLevel,
    ...(typeof manifest.entryId === 'string' ? { entryId: manifest.entryId } : {}),
    transformId: request.transformId,
    decision: {
      allowed: true,
      exportable: decision.exportable === true,
      message: keptProject ? '已移除改造记录；伴生工程按请求保留。' : '已移除改造记录及其产物。'
    }
  })

  return {
    ok: true,
    action: 'rollback',
    transformId: request.transformId,
    removed: true,
    keptProject,
    ...(keptProject ? { warning: '伴生工程目录被保留；如不再需要，请手动删除或下次回滚时传 deleteProject=true。' } : {})
  }
}

export async function transformAction(request: TransformActionRequest): Promise<Record<string, unknown>> {
  switch (request.action) {
    case 'apply':
      return applyTransform(request)
    case 'rollback':
      return rollbackTransform(request)
    case 'audit': {
      const workspace = loadPackWorkspace(request.workspacePath)
      const records = readTransformAudit(workspace.path)
      return {
        ok: true,
        action: 'audit',
        file: auditPath(workspace.path),
        total: records.length,
        records: request.limit ? records.slice(-request.limit) : records
      }
    }
  }
}
