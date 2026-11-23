/**
 * Workspace: the container above a single Gradle project.
 *
 * Until now the top-level entity was one Fabric Gradle project, identified by
 * whatever `fabric.mod.json` it happened to contain. A modpack breaks that: one
 * pack owns several authored projects (the mod being built, compatibility
 * bridges), a set of downloaded jars that are never edited, and one target
 * runtime. This module is the declaration format for that container.
 *
 * Deliberate constraints:
 *  - A **single-mod workspace writes no file at all**. `loadWorkspace()` in
 *    `workspace.ts` synthesises the same shape in memory, so every existing
 *    caller keeps its exact behaviour and no project gains a stray `.modcrafting`
 *    file it never asked for.
 *  - `targetId` is the existing catalog key (`fabric@1.21.4`), not a second
 *    version model. Resolution stays in `version/targets.ts`.
 *  - Paths are stored relative to the workspace root so a pack can be moved or
 *    zipped. `workspace.ts` resolves them on load.
 *
 * Pure module: no Node imports, so the browser can import the types.
 */

import { z } from 'zod'
import { DEFAULT_TARGET_ID } from './domain.ts'
import { loaderIds } from './version/schema.ts'

export const workspaceKinds = ['mod', 'modpack'] as const
export type WorkspaceKind = (typeof workspaceKinds)[number]

/** `owned` = authored here; `bridge` = generated glue; the other two are read-only inputs. */
export const memberRoles = ['owned', 'baseline', 'dependency', 'bridge'] as const
export type MemberRole = (typeof memberRoles)[number]

export const packEntrySources = ['modrinth', 'curseforge', 'local', 'baseline', 'transform'] as const
export type PackEntrySource = (typeof packEntrySources)[number]

/** External catalogues a pack entry may come from. `local` is not a registry. */
export const registryIds = ['modrinth', 'curseforge'] as const
export type RegistryId = (typeof registryIds)[number]

export const ENTRY_SIDES = ['client', 'server', 'both'] as const
export type EntrySide = (typeof ENTRY_SIDES)[number]

/** Relative to the workspace root. Kept here so readers and writers cannot drift. */
export const WORKSPACE_FILE = '.modcrafting/workspace.json'
export const DEFAULT_MAX_INSTANCES = 2
export const DEFAULT_LAUNCHER = 'gradle' as const

// Derived from loaderIds so adding a loader to the catalog cannot leave this behind.
const TARGET_ID_RE = new RegExp(`^(?:${loaderIds.join('|')})@\\d+\\.\\d+(?:\\.\\d+)?$`)
const MEMBER_ID_RE = /^[a-z][a-z0-9_]{0,31}$/
const MOD_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const SHA1_RE = /^[a-f0-9]{40}$/
const SHA512_RE = /^[a-f0-9]{128}$/

export const targetIdSchema = z.string().regex(TARGET_ID_RE, 'targetId 必须是 fabric@1.21.4 这样的矩阵键')
export const memberIdSchema = z.string().regex(MEMBER_ID_RE, 'memberId 必须是小写字母开头、最长 32 位的标识符')

export const hashesSchema = z.object({
  sha1: z.string().regex(SHA1_RE).optional(),
  sha512: z.string().regex(SHA512_RE).optional()
}).strict()
export type PackHashes = z.infer<typeof hashesSchema>

export const licenseSchema = z.object({
  /** SPDX id, or `All-Rights-Reserved` when the source does not publish one. */
  id: z.string().trim().min(1).max(64),
  /**
   * False is the safe default: such an entry may be installed locally and even
   * transformed, but its bytes must never be inlined into an exported pack.
   */
  redistributable: z.boolean()
}).strict()
export type PackLicense = z.infer<typeof licenseSchema>

export const sourceRefSchema = z.object({
  registry: z.enum(packEntrySources),
  projectId: z.string().min(1).max(128).optional(),
  versionId: z.string().min(1).max(128).optional(),
  sha512: z.string().regex(SHA512_RE).optional()
}).strict()
export type SourceRef = z.infer<typeof sourceRefSchema>

export const memberProjectSchema = z.object({
  memberId: memberIdSchema,
  /** Relative to the workspace root; absolute paths are accepted but hurt portability. */
  path: z.string().min(1).max(512),
  role: z.enum(memberRoles),
  /** Cached at write time; `resolveTargetMod` re-reads the real metadata and wins. */
  modId: z.string().regex(MOD_ID_RE).optional(),
  targetId: targetIdSchema.optional(),
  source: sourceRefSchema.optional()
}).strict()
export type MemberProject = z.infer<typeof memberProjectSchema>

export const packEntrySchema = z.object({
  entryId: z.string().regex(ENTRY_ID_RE),
  /** A jar file name only: no separators, no traversal, no control characters. */
  fileName: z.string().min(1).max(255)
    .refine((value) => /\.jar$/i.test(value), 'entry fileName 必须是 .jar 文件')
    .refine((value) => !/[<>:"/\\|?*\u0000-\u001F]/.test(value), 'entry fileName 不能包含路径分隔符或 Windows 保留字符')
    .refine((value) => value !== '.' && value !== '..' && !value.startsWith('.'), 'entry fileName 不能以点开头'),
  source: z.enum(packEntrySources),
  projectId: z.string().min(1).max(128).optional(),
  versionId: z.string().min(1).max(128).optional(),
  hashes: hashesSchema,
  license: licenseSchema,
  enabled: z.boolean(),
  side: z.enum(ENTRY_SIDES).optional()
}).strict()
export type PackEntry = z.infer<typeof packEntrySchema>

export const workspaceRuntimeSchema = z.object({
  maxInstances: z.number().int().min(1).max(8),
  /** `gradle` keeps the single-mod dev loop; `standalone` is required to load production jars. */
  launcher: z.enum(['gradle', 'standalone'])
}).strict()
export type WorkspaceRuntime = z.infer<typeof workspaceRuntimeSchema>

export const workspaceSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(workspaceKinds),
  name: z.string().trim().min(1).max(120),
  targetId: targetIdSchema,
  members: z.array(memberProjectSchema).max(64),
  entries: z.array(packEntrySchema).max(1024),
  runtime: workspaceRuntimeSchema
}).strict()
  .refine((value) => value.kind === 'modpack' || value.members.length >= 1, {
    message: 'mod 工作区至少需要一个成员工程',
    path: ['members']
  })
  .refine((value) => new Set(value.members.map((member) => member.memberId)).size === value.members.length, {
    message: '成员 memberId 不能重复',
    path: ['members']
  })
  .refine((value) => new Set(value.entries.map((entry) => entry.entryId)).size === value.entries.length, {
    message: 'entryId 不能重复',
    path: ['entries']
  })
  .refine((value) => new Set(value.entries.map((entry) => entry.fileName.toLowerCase())).size === value.entries.length, {
    message: '同一个包内不能有两个同名 jar（Windows 大小写不敏感）',
    path: ['entries']
  })

/** The persisted document, before the workspace root is attached. */
export type WorkspaceDocument = z.infer<typeof workspaceSchema>

/** A document plus the absolute directory it was loaded from. */
export interface Workspace extends WorkspaceDocument {
  readonly workspacePath: string
}

export function emptyWorkspaceDocument(input: {
  kind: WorkspaceKind
  name: string
  targetId?: string
  members?: MemberProject[]
  runtime?: Partial<WorkspaceRuntime>
}): WorkspaceDocument {
  return {
    schemaVersion: 1,
    kind: input.kind,
    name: input.name.trim() || '未命名工作区',
    targetId: input.targetId ?? DEFAULT_TARGET_ID,
    members: input.members ?? [],
    entries: [],
    runtime: {
      maxInstances: input.runtime?.maxInstances ?? DEFAULT_MAX_INSTANCES,
      launcher: input.runtime?.launcher ?? DEFAULT_LAUNCHER
    }
  }
}

/**
 * The in-memory shape of a single-mod workspace.
 *
 * Nothing is written to disk: the project root *is* the workspace, the one
 * Gradle project is member `main`, and the launcher stays on the dev loop.
 */
export function singleModWorkspace(projectRoot: string, name: string, targetId?: string): Workspace {
  return {
    ...emptyWorkspaceDocument({
      kind: 'mod',
      name,
      targetId,
      members: [{ memberId: 'main', path: '.', role: 'owned' }]
    }),
    workspacePath: projectRoot
  }
}

/** Root member id for every single-mod workspace, and the default when none is given. */
export const PRIMARY_MEMBER_ID = 'main'
