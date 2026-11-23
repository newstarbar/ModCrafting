import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  activeMember,
  createWorkspace,
  isModpackRoot,
  loadWorkspace,
  memberAbsPath,
  removeMember,
  resolveTargetMod,
  upsertMember,
  workspaceFilePath,
  writeWorkspace
} from '../../packages/modcrafting-core/src/workspace.ts'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'modcrafting-workspace-'))
  temporaryRoots.push(root)
  return root
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

/** The minimum `inspectFabricProject` accepts: metadata, wrapper, target version. */
function fabricProject(root: string, options: { modId?: string; minecraft?: string | null } = {}): string {
  const modId = options.modId ?? 'demo_mod'
  mkdirSync(path.join(root, 'src', 'main', 'resources'), { recursive: true })
  writeFileSync(
    path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'),
    JSON.stringify({ schemaVersion: 1, id: modId, version: '0.1.0', depends: { minecraft: '~1.21.4' } }),
    'utf8'
  )
  writeFileSync(path.join(root, 'gradlew.bat'), '@echo off\n', 'utf8')
  const minecraft = options.minecraft === null ? undefined : options.minecraft ?? '1.21.4'
  writeFileSync(path.join(root, 'gradle.properties'), minecraft ? `minecraft_version=${minecraft}\n` : '', 'utf8')
  return root
}

test('a single-mod project is synthesised in memory and writes no file', () => {
  const root = fabricProject(temporaryRoot(), { modId: 'solo' })
  const workspace = loadWorkspace(root)

  assert.equal(workspace.kind, 'mod')
  assert.equal(workspace.workspacePath, path.resolve(root))
  assert.equal(workspace.name, 'solo', 'the mod id is the only name available without a manifest')
  assert.equal(workspace.targetId, 'fabric@1.21.4')
  assert.deepEqual(workspace.members, [{ memberId: 'main', path: '.', role: 'owned' }])
  assert.deepEqual(workspace.entries, [])
  assert.equal(workspace.runtime.launcher, 'gradle')

  // The whole point of synthesising: no project gains an unrequested dotfile.
  assert.equal(existsSync(workspaceFilePath(root)), false)
  assert.equal(existsSync(path.join(root, '.modcrafting')), false)
})

test('an uninitialised pack is refused with an actionable code, not treated as a project', () => {
  const root = temporaryRoot()
  mkdirSync(path.join(root, 'mods'), { recursive: true })

  assert.equal(isModpackRoot(root), true)
  assert.throws(
    () => loadWorkspace(root),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === 'WORKSPACE_NOT_INITIALISED'
  )
})

test('a pack manifest round-trips and stays portable', () => {
  const root = temporaryRoot()
  mkdirSync(path.join(root, 'mods'), { recursive: true })
  const created = createWorkspace({ root, kind: 'modpack', name: 'Test Pack' })

  assert.equal(created.kind, 'modpack')
  assert.equal(created.name, 'Test Pack')
  assert.equal(existsSync(workspaceFilePath(root)), true)

  const stored = JSON.parse(readFileSync(workspaceFilePath(root), 'utf8')) as Record<string, unknown>
  assert.equal(stored.schemaVersion, 1)
  assert.equal('workspacePath' in stored, false, 'the absolute root must not be persisted')
  assert.equal(readdirSync(path.dirname(workspaceFilePath(root))).some((name) => name.endsWith('.tmp')), false)

  const reloaded = loadWorkspace(root)
  assert.deepEqual(reloaded.members, [])
  assert.equal(reloaded.workspacePath, path.resolve(root))
})

test('create refuses to clobber an existing manifest unless asked', () => {
  const root = temporaryRoot()
  createWorkspace({ root, kind: 'modpack', name: 'First' })
  assert.throws(
    () => createWorkspace({ root, kind: 'modpack', name: 'Second' }),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === 'WORKSPACE_EXISTS'
  )
  assert.equal(loadWorkspace(root).name, 'First')
  assert.equal(createWorkspace({ root, kind: 'modpack', name: 'Second', overwrite: true }).name, 'Second')
})

test('resolveTargetMod reads real metadata instead of trusting the manifest cache', () => {
  const root = fabricProject(temporaryRoot(), { modId: 'authored' })
  const workspace = loadWorkspace(root)

  const target = resolveTargetMod(workspace)
  assert.equal(target.memberId, 'main')
  assert.equal(target.modId, 'authored')
  assert.equal(target.loader, 'fabric')
  assert.equal(target.minecraftVersion, '1.21.4')
  assert.equal(target.root, path.resolve(root))
  assert.equal(target.resourcesRoot, path.join(path.resolve(root), 'src', 'main', 'resources'))
  assert.equal(target.warning, undefined)

  // layout paths already carry `src/main/resources`, so writers join with `root`.
  assert.equal(target.layout.recipePath('authored', 'widget'), 'src/main/resources/data/authored/recipe/widget.json')
  assert.equal(path.join(target.root, target.layout.langPath('authored', 'zh_cn')), path.join(target.resourcesRoot, 'assets', 'authored', 'lang', 'zh_cn.json'))

  // The manifest's cached modId must never win over the file on disk.
  writeFileSync(
    path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'),
    JSON.stringify({ schemaVersion: 1, id: 'renamed', version: '0.1.0' }),
    'utf8'
  )
  assert.equal(resolveTargetMod({ ...workspace, members: [{ memberId: 'main', path: '.', role: 'owned', modId: 'stale' }] }).modId, 'renamed')
})

test('a project without minecraft_version keeps working with an explicit warning', () => {
  const root = fabricProject(temporaryRoot(), { minecraft: null })
  const target = resolveTargetMod(loadWorkspace(root))

  assert.equal(target.minecraftVersion, '1.21.4', 'falls back to the pinned target rather than failing')
  assert.match(target.warning ?? '', /minecraft_version/)
})

test('members resolve relative to the workspace root and selection is explicit', () => {
  const pack = temporaryRoot()
  mkdirSync(path.join(pack, 'mods'), { recursive: true })
  const workspace = createWorkspace({ root: pack, kind: 'modpack', name: 'Multi' })

  const own = fabricProject(path.join(pack, 'projects', 'core'), { modId: 'core' })
  const bridge = fabricProject(path.join(pack, 'projects', 'bridge'), { modId: 'bridge' })
  const withMembers = writeWorkspace({
    ...upsertMember(upsertMember(workspace, { memberId: 'main', path: 'projects/core', role: 'owned' }),
      { memberId: 'bridge_core', path: 'projects/bridge', role: 'bridge' }),
    workspacePath: pack
  })

  assert.equal(memberAbsPath(withMembers, activeMember(withMembers, 'bridge_core')), path.resolve(bridge))
  assert.equal(resolveTargetMod(withMembers, 'bridge_core').modId, 'bridge')
  assert.equal(resolveTargetMod(withMembers).modId, 'core', 'main is the default member')

  assert.throws(
    () => activeMember(withMembers, 'missing'),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === 'MEMBER_NOT_FOUND'
  )

  const withoutBridge = removeMember(withMembers, 'bridge_core')
  assert.deepEqual(withoutBridge.members.map((member) => member.memberId), ['main'])
  assert.equal(existsSync(path.join(own, 'gradlew.bat')), true)

  // A pack may legitimately have zero members; a mod workspace may not.
  assert.deepEqual(removeMember(withMembers, 'main').members.map((member) => member.memberId), ['bridge_core'])
  const solo = loadWorkspace(fabricProject(temporaryRoot(), { modId: 'solo' }))
  assert.throws(
    () => removeMember(solo, 'main'),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === 'MEMBER_REQUIRED'
  )
})

test('manifest validation rejects duplicate ids, duplicate jars and unsafe file names', () => {
  const root = temporaryRoot()
  const workspace = createWorkspace({ root, kind: 'modpack', name: 'Validation' })
  const entry = {
    entryId: 'sodium',
    fileName: 'sodium-0.6.jar',
    source: 'modrinth' as const,
    hashes: {},
    license: { id: 'MIT', redistributable: true },
    enabled: true
  }

  assert.throws(
    () => writeWorkspace({ ...workspace, entries: [entry, { ...entry, entryId: 'sodium_2' }] }),
    /不能有两个同名 jar/
  )
  assert.throws(
    () => writeWorkspace({ ...workspace, entries: [entry, { ...entry, fileName: 'other.jar', entryId: 'sodium' }] }),
    /entryId 不能重复/
  )
  assert.throws(
    () => writeWorkspace({ ...workspace, entries: [{ ...entry, fileName: '../escape.jar' }] }),
    /路径分隔符|\\.\\./
  )
  assert.throws(
    () => writeWorkspace({ ...workspace, entries: [{ ...entry, fileName: '.hidden.jar' }] }),
    /不能以点开头/
  )
  assert.throws(
    () => writeWorkspace({ ...workspace, targetId: 'fabric' }),
    /targetId/
  )

  // A case-only difference is still a collision on Windows.
  assert.throws(
    () => writeWorkspace({ ...workspace, entries: [entry, { ...entry, entryId: 'sodium_upper', fileName: 'Sodium-0.6.jar' }] }),
    /不能有两个同名 jar/
  )
})
