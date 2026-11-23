/**
 * Loading, resolving and persisting workspaces.
 *
 * The contract this file protects: **a single-mod project never gains a file it
 * did not have**. If `<root>/.modcrafting/workspace.json` is absent and the root
 * is a valid mod project, the workspace is synthesised in memory and nothing is
 * written. That keeps the 37 existing tools, the 18 harnesses and every existing
 * project byte-identical.
 *
 * Resolution is deliberately separate from loading: a member's real metadata is
 * re-read on every `resolveTargetMod`, because `gradle.properties` and
 * `fabric.mod.json` are edited by Gradle, by the user and by other tools. A cached
 * `modId` in the manifest would go stale silently.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { FabricProject } from './contracts.ts'
import { FABRIC_TARGET } from './domain.ts'
import { inspectFabricProject } from './node.ts'
import type { ResourceLayout } from './resources/layout.ts'
import { cellKey, type LoaderId } from './version/schema.ts'
import { projectLayout } from './version/project-gate.ts'
import {
  PRIMARY_MEMBER_ID,
  WORKSPACE_FILE,
  emptyWorkspaceDocument,
  singleModWorkspace,
  workspaceSchema,
  type MemberProject,
  type Workspace,
  type WorkspaceDocument,
  type WorkspaceKind
} from './workspace-model.ts'

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/** Windows comparisons are case-insensitive; every path identity check goes through this. */
export function pathKey(value: string): string {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase()
}

export function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right)
}

export function workspaceFilePath(root: string): string {
  return path.join(path.resolve(root), ...WORKSPACE_FILE.split('/'))
}

function isDirectory(value: string): boolean {
  return existsSync(value) && statSync(value).isDirectory()
}

const PROJECT_MANIFESTS = [
  ['src', 'main', 'resources', 'fabric.mod.json'],
  ['src', 'main', 'resources', 'META-INF', 'neoforge.mods.toml'],
  ['src', 'main', 'resources', 'META-INF', 'mods.toml']
] as const

function hasProjectManifest(root: string): boolean {
  return PROJECT_MANIFESTS.some((segments) => existsSync(path.join(root, ...segments)))
}

/**
 * Whether a directory looks like a pack rather than a project.
 *
 * Only ever used to produce a better error or to let `create` infer the kind —
 * never to decide how to *run* something. An explicit `workspace.json` always wins.
 */
export function isModpackRoot(root: string): boolean {
  const absolute = path.resolve(root)
  if (!isDirectory(absolute)) return false
  const file = workspaceFilePath(absolute)
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { kind?: unknown }
      if (raw.kind === 'modpack') return true
      if (raw.kind === 'mod') return false
    } catch { /* an unreadable file is a validation error, not a kind hint */ }
  }
  return existsSync(path.join(absolute, 'mods')) && !hasProjectManifest(absolute)
}

export function loadWorkspace(root: string): Workspace {
  const absolute = path.resolve(root)
  if (!isDirectory(absolute)) fail('WORKSPACE_NOT_FOUND', `工作区目录不存在：${absolute}`)

  const file = workspaceFilePath(absolute)
  if (existsSync(file)) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (cause) {
      fail('WORKSPACE_INVALID', `${WORKSPACE_FILE} 不是合法 JSON：${(cause as Error).message}`)
    }
    const parsed = workspaceSchema.safeParse(raw)
    if (!parsed.success) {
      const detail = parsed.error.issues.slice(0, 6)
        .map((issue) => `${issue.path.join('.') || 'workspace'}: ${issue.message}`).join('; ')
      fail('WORKSPACE_INVALID', `${WORKSPACE_FILE} 不合法：${detail}`)
    }
    return { ...parsed.data, workspacePath: absolute }
  }

  const project = inspectFabricProject(absolute)
  if (project.valid && project.modId) {
    const loader: LoaderId = project.loader ?? 'fabric'
    const minecraft = project.minecraftVersion?.trim() || FABRIC_TARGET.minecraft
    return singleModWorkspace(absolute, project.modId, cellKey(loader, minecraft))
  }

  if (isModpackRoot(absolute)) {
    fail(
      'WORKSPACE_NOT_INITIALISED',
      `这个目录看起来是整合包（有 mods/，但没有工程清单），还缺少 ${WORKSPACE_FILE}。先调用 modcrafting_workspace 的 create 建立清单，再继续检索或装配。`
    )
  }
  fail(
    'WORKSPACE_UNAVAILABLE',
    `既不是可识别的 mod 工程，也不是整合包：${absolute}${project.errors.length ? `（${project.errors.join('; ')}）` : ''}`
  )
}

/** Strip the runtime-only root before writing, so the file stays portable. */
function documentOf(workspace: Workspace): WorkspaceDocument {
  const { workspacePath: _workspacePath, ...document } = workspace
  return document
}

export function writeWorkspace(workspace: Workspace): Workspace {
  const absolute = path.resolve(workspace.workspacePath)
  const document = workspaceSchema.parse(documentOf(workspace))
  const target = workspaceFilePath(absolute)
  const temporary = `${target}.${process.pid}.tmp`
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
  return { ...document, workspacePath: absolute }
}

export function createWorkspace(input: {
  root: string
  kind: WorkspaceKind
  name?: string
  targetId?: string
  overwrite?: boolean
}): Workspace {
  const absolute = path.resolve(input.root)
  if (!isDirectory(absolute)) fail('WORKSPACE_NOT_FOUND', `工作区目录不存在：${absolute}`)

  const file = workspaceFilePath(absolute)
  if (existsSync(file) && !input.overwrite) {
    fail(
      'WORKSPACE_EXISTS',
      `${absolute} 已经有 ${WORKSPACE_FILE}。读取或修改现有清单，不要覆盖；确实要重建时显式传 overwrite=true。`
    )
  }

  const name = input.name?.trim() || path.basename(absolute)
  if (input.kind === 'mod') {
    const project = inspectFabricProject(absolute)
    if (!project.valid || !project.modId) {
      fail(
        'WORKSPACE_UNAVAILABLE',
        `mod 工作区要求根目录本身是有效工程：${project.errors.join('; ') || '缺少工程清单'}`
      )
    }
    const loader: LoaderId = project.loader ?? 'fabric'
    const minecraft = project.minecraftVersion?.trim() || FABRIC_TARGET.minecraft
    return writeWorkspace({
      ...emptyWorkspaceDocument({
        kind: 'mod',
        name,
        targetId: input.targetId ?? cellKey(loader, minecraft),
        members: [{ memberId: PRIMARY_MEMBER_ID, path: '.', role: 'owned' }]
      }),
      workspacePath: absolute
    })
  }

  return writeWorkspace({
    ...emptyWorkspaceDocument({ kind: 'modpack', name, targetId: input.targetId }),
    workspacePath: absolute
  })
}

/**
 * Absolute directory of a member project.
 *
 * Relative paths resolve against the workspace root so a pack can be moved.
 */
export function memberAbsPath(workspace: Workspace, member: MemberProject): string {
  return path.isAbsolute(member.path) ? path.resolve(member.path) : path.resolve(workspace.workspacePath, member.path)
}

/** The requested member, or the primary one (`main`), or the first one declared. */
export function activeMember(workspace: Workspace, memberId?: string): MemberProject {
  if (workspace.members.length === 0) {
    fail('MEMBER_NOT_FOUND', '这个工作区还没有成员工程；先添加一个自研工程或桥接工程。')
  }
  if (!memberId) {
    return workspace.members.find((member) => member.memberId === PRIMARY_MEMBER_ID) ?? workspace.members[0]
  }
  const found = workspace.members.find((member) => member.memberId === memberId)
  if (!found) {
    fail('MEMBER_NOT_FOUND', `工作区里没有成员 "${memberId}"；现有成员：${workspace.members.map((member) => member.memberId).join(', ')}`)
  }
  return found
}

/**
 * Everything an authoring workspace needs to read and write one member project.
 *
 * `resourcesRoot` is informational (for read-only checks and display). The
 * `layout.*` helpers on `ResourceLayout` already emit the `src/main/resources/`
 * prefix, so writers must join produced paths with `root`, **not** with
 * `resourcesRoot`, or the prefix is applied twice.
 */
export interface TargetModRef {
  readonly memberId: string
  readonly root: string
  readonly modId: string
  readonly loader: LoaderId
  readonly minecraftVersion: string
  readonly resourcesRoot: string
  readonly layout: ResourceLayout
  readonly project: FabricProject
  /** Present when the project's own version had to be replaced by the pinned fallback. */
  readonly warning?: string
}

export function resolveTargetMod(workspace: Workspace, memberId?: string): TargetModRef {
  const member = activeMember(workspace, memberId)
  const root = memberAbsPath(workspace, member)
  const project = inspectFabricProject(root)
  if (!project.valid || !project.modId) {
    fail(
      'MEMBER_UNAVAILABLE',
      `成员 "${member.memberId}" 不是有效工程（${root}）：${project.errors.join('; ') || '缺少工程清单'}`
    )
  }
  // `projectLayout` reads `gradle.properties` and falls back with a warning, so a
  // stale version never turns a readable project into an error. Resource layout is
  // loader-independent, so routing it through the Fabric-shaped helper is correct.
  const resolved = projectLayout(project)
  return {
    memberId: member.memberId,
    root,
    modId: project.modId,
    loader: project.loader ?? 'fabric',
    minecraftVersion: resolved.minecraft,
    resourcesRoot: path.join(root, 'src', 'main', 'resources'),
    layout: resolved.layout,
    project,
    ...(resolved.exact ? {} : { warning: resolved.warning })
  }
}

/** Replace or append a member by `memberId`, keeping declaration order stable. */
export function upsertMember(workspace: Workspace, member: MemberProject): Workspace {
  const index = workspace.members.findIndex((entry) => entry.memberId === member.memberId)
  const members = index >= 0
    ? workspace.members.map((entry, position) => (position === index ? member : entry))
    : [...workspace.members, member]
  return { ...workspace, members }
}

export function removeMember(workspace: Workspace, memberId: string): Workspace {
  if (!workspace.members.some((member) => member.memberId === memberId)) {
    fail('MEMBER_NOT_FOUND', `工作区里没有成员 "${memberId}"`)
  }
  const members = workspace.members.filter((member) => member.memberId !== memberId)
  if (workspace.kind === 'mod' && members.length === 0) {
    fail('MEMBER_REQUIRED', 'mod 工作区必须保留至少一个成员工程；要清空请改用 modpack 类型。')
  }
  return { ...workspace, members }
}
