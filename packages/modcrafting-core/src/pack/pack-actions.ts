/**
 * The request surface shared by the MCP tool and the browser workbench.
 *
 * Keeping the action union in core (instead of duplicating it in two servers)
 * means the two entry points cannot drift: a browser action and an MCP tool call
 * go through the same validation, the same revision checks, and the same error
 * codes.
 */

import { z } from 'zod'
import { packLockSchema, packManifestSchema } from '../pack-model.ts'
import { packEntrySchema, targetIdSchema } from '../workspace-model.ts'
import { parseTargetId } from '../version/targets.ts'
import { exportPack } from './pack-export.ts'
import { entryFromVersion } from './pack-entry.ts'
import { pickVersion, solvePackWithRegistry } from './pack-solver.ts'
import {
  addPackEntries,
  createPack,
  loadPackWorkspace,
  removePackEntries,
  savePackManifest,
  setPackEntryEnabled,
  writePackLock,
  type PackWorkspace
} from './pack-workspace.ts'
import type { RegistryReader } from './registry-client.ts'
import type { RegistryFile, RegistryVersion } from './registry-model.ts'

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

const workspacePath = z.string().min(1)
const expectedRevision = z.string().min(1)

export const packActionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('load'), workspacePath }).strict(),
  z.object({
    action: z.literal('create'),
    workspacePath,
    name: z.string().trim().min(1).max(120),
    version: z.string().trim().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/).optional(),
    targetId: targetIdSchema,
    baselineGroups: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)).max(8).optional()
  }).strict(),
  z.object({ action: z.literal('save'), workspacePath, manifest: packManifestSchema, expectedRevision }).strict(),
  z.object({ action: z.literal('add_entries'), workspacePath, entries: z.array(packEntrySchema).min(1).max(256), expectedRevision }).strict(),
  z.object({ action: z.literal('remove_entries'), workspacePath, entryIds: z.array(z.string().min(1)).min(1).max(256), expectedRevision }).strict(),
  z.object({ action: z.literal('set_enabled'), workspacePath, entryId: z.string().min(1), enabled: z.boolean(), expectedRevision }).strict(),
  z.object({ action: z.literal('write_lock'), workspacePath, lock: packLockSchema }).strict(),
  z.object({ action: z.literal('solve'), workspacePath, generatedAt: z.string().min(1).optional(), writeLock: z.boolean().default(true) }).strict(),
  z.object({
    action: z.literal('add_candidate'),
    workspacePath,
    registry: z.enum(['modrinth', 'curseforge']),
    projectId: z.string().min(1).max(128),
    expectedRevision
  }).strict(),
  z.object({
    action: z.literal('export'),
    workspacePath,
    kind: z.enum(['mrpack', 'prism']),
    outputDir: z.string().min(1).max(512).optional(),
    loaderVersion: z.string().min(1).max(64).optional(),
    overwrite: z.boolean().optional(),
    generatedAt: z.string().min(1).optional()
  }).strict()
])
export type PackActionRequest = z.infer<typeof packActionRequestSchema>

function workspaceView(workspace: PackWorkspace): Record<string, unknown> {
  return {
    path: workspace.path,
    manifestFile: workspace.manifestFile,
    lockFile: workspace.lockFile,
    manifest: workspace.manifest,
    revision: workspace.revision,
    lock: workspace.lock,
    drift: workspace.drift
  }
}

function entryIdFor(slug: string, workspace: PackWorkspace, projectId: string, source: 'modrinth' | 'curseforge'): string {
  const base = slug.toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 56) || 'mod'
  const holder = workspace.manifest.entries.find((entry) => entry.entryId === base)
  if (!holder || (holder.projectId === projectId && holder.source === source)) return base
  const prefixed = `${base}-${source}`
  if (!workspace.manifest.entries.some((entry) => entry.entryId === prefixed)) return prefixed
  for (let index = 2; index < 100; index++) {
    const candidate = `${prefixed}-${index}`
    if (!workspace.manifest.entries.some((entry) => entry.entryId === candidate)) return candidate
  }
  fail('PACK_ENTRY_ID_CONFLICT', `无法为 ${slug} 生成不重复的条目 id。请先清理清单里同名的条目。`)
}

function primaryFile(version: RegistryVersion): RegistryFile | undefined {
  return version.files.find((file) => file.primary) ?? version.files[0]
}

async function addCandidate(reader: RegistryReader, request: Extract<PackActionRequest, { action: 'add_candidate' }>): Promise<Record<string, unknown>> {
  const workspace = loadPackWorkspace(request.workspacePath)
  const target = parseTargetId(workspace.manifest.targetId)

  let project
  try {
    project = await reader.project({ registry: request.registry, projectId: request.projectId })
  } catch (cause) {
    fail('PROJECT_NOT_FOUND', `在 ${request.registry} 上找不到项目 ${request.projectId}：${(cause as Error).message}。请检查项目 id，或先在发现面板里搜索。`)
  }

  let rows: RegistryVersion[]
  try {
    rows = await reader.versions({
      registry: request.registry,
      projectId: project.projectId,
      loader: target.loader,
      gameVersion: target.minecraft
    })
  } catch (cause) {
    fail('REGISTRY_READ_FAILED', `读取 ${project.projectId} 的版本失败：${(cause as Error).message}。请检查网络或数据源密钥后重试。`)
  }

  const version = pickVersion(rows, target)
  if (!version) {
    fail('NO_COMPATIBLE_VERSION', `${project.projectId} 没有支持 ${workspace.manifest.targetId} 的版本。请换一个目标版本，或选择替代模组。`)
  }
  const file = primaryFile(version)
  if (!file) fail('VERSION_FILE_MISSING', `${project.projectId}@${version.versionId} 没有任何可安装文件。请选择其他版本。`)

  const entryId = entryIdFor(project.slug, workspace, project.projectId, request.registry)
  const entry = entryFromVersion({
    entryId,
    projectId: project.projectId,
    source: request.registry,
    version,
    file,
    license: project.license,
    environment: project.environment
  })
  const result = addPackEntries(workspace.path, { entries: [entry], expectedRevision: request.expectedRevision })
  return {
    action: 'add_candidate',
    entry,
    added: result.added,
    replaced: result.replaced,
    ...workspaceView(result.workspace)
  }
}

export async function packWorkspaceAction(reader: RegistryReader, request: PackActionRequest): Promise<Record<string, unknown>> {
  switch (request.action) {
    case 'load':
      return { action: 'load', ...workspaceView(loadPackWorkspace(request.workspacePath)) }
    case 'create':
      return {
        action: 'create',
        ...workspaceView(createPack(request.workspacePath, {
          name: request.name,
          targetId: request.targetId,
          ...(request.version ? { version: request.version } : {}),
          ...(request.baselineGroups ? { baselineGroups: request.baselineGroups } : {})
        }))
      }
    case 'save':
      return {
        action: 'save',
        ...workspaceView(savePackManifest(request.workspacePath, { manifest: request.manifest, expectedRevision: request.expectedRevision }))
      }
    case 'add_entries': {
      const result = addPackEntries(request.workspacePath, { entries: request.entries, expectedRevision: request.expectedRevision })
      return { action: 'add_entries', added: result.added, replaced: result.replaced, ...workspaceView(result.workspace) }
    }
    case 'remove_entries': {
      const result = removePackEntries(request.workspacePath, { entryIds: request.entryIds, expectedRevision: request.expectedRevision })
      return { action: 'remove_entries', removed: result.removed, ...workspaceView(result.workspace) }
    }
    case 'set_enabled':
      return {
        action: 'set_enabled',
        ...workspaceView(setPackEntryEnabled(request.workspacePath, {
          entryId: request.entryId,
          enabled: request.enabled,
          expectedRevision: request.expectedRevision
        }))
      }
    case 'write_lock': {
      const written = writePackLock(request.workspacePath, request.lock)
      return { action: 'write_lock', file: written.file, lock: written.lock, drift: written.drift }
    }
    case 'solve': {
      const workspace = loadPackWorkspace(request.workspacePath)
      const target = parseTargetId(workspace.manifest.targetId)
      const result = await solvePackWithRegistry(reader, {
        manifest: workspace.manifest,
        target,
        generatedAt: request.generatedAt ?? new Date().toISOString()
      })
      // A conflict or an unsatisfiable declaration is not a lockfile: writing one
      // would suggest the pack is buildable when it is not.
      const writable = result.verdict === 'satisfied' || result.verdict === 'gap'
      // Callers normally parse through the schema (which defaults this to true),
      // but the core action stays correct for direct programmatic use too.
      const wrote = request.writeLock !== false && writable
      if (wrote) writePackLock(workspace.path, result.lock)
      return {
        action: 'solve',
        verdict: result.verdict,
        findings: result.findings,
        missing: result.missing,
        lock: result.lock,
        wrote,
        ...(wrote ? { drift: loadPackWorkspace(workspace.path).drift } : { drift: workspace.drift })
      }
    }
    case 'add_candidate':
      return addCandidate(reader, request)
    case 'export':
      return {
        action: 'export',
        ...exportPack({
          root: request.workspacePath,
          kind: request.kind,
          ...(request.outputDir ? { outputDir: request.outputDir } : {}),
          ...(request.loaderVersion ? { loaderVersion: request.loaderVersion } : {}),
          ...(request.overwrite !== undefined ? { overwrite: request.overwrite } : {}),
          ...(request.generatedAt ? { generatedAt: request.generatedAt } : {})
        })
      }
  }
}
