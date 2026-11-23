import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { GameInstance, JobSnapshot, TaskSession } from './contracts.ts'
import { PRIMARY_MEMBER_ID, type WorkspaceKind } from './workspace-model.ts'

type SessionRecord = TaskSession & { schemaVersion: 1; backendOwner?: string; ownerPid?: number }
type SessionChanges = Partial<Pick<TaskSession, 'name' | 'projectPath' | 'workspacePath' | 'workspaceKind' | 'activeMemberId' | 'phase' | 'currentModule' | 'recommendedModules' | 'profile'>>

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replaceAll('\\', '/').toLowerCase()
  return normalize(left) === normalize(right)
}

function alive(pid?: number): boolean {
  if (!Number.isInteger(pid) || !pid) return false
  try { process.kill(pid, 0); return true } catch (cause) { return (cause as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Small file-backed session registry. Only the backend holding a session lease may mutate it. */
export class SessionRegistry {
  readonly backendId = randomUUID()
  private readonly root: string
  private readonly owned = new Set<string>()

  constructor(dataRoot: string) {
    this.root = path.join(dataRoot, 'sessions')
    for (const file of (existsSync(this.root) ? readdirSync(this.root) : []).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))) {
      const record = this.readRecord(file.slice(0, -5))
      if (!record || record.status === 'ended' || alive(record.ownerPid)) continue
      let changed = false
      record.jobs = record.jobs.map((job) => {
        if (job.status !== 'running') return job
        changed = true
        return { ...job, status: 'interrupted', code: 'BACKEND_RESTARTED', error: '服务重启时任务仍在运行，状态已标记为中断。请检查游戏目录和报告后再继续。', finishedAt: new Date().toISOString() }
      })
      if (changed) { record.updatedAt = new Date().toISOString(); this.write(record) }
    }
  }

  create(input: { name?: string; projectPath?: string; workspacePath?: string; workspaceKind?: WorkspaceKind; activeMemberId?: string } = {}): TaskSession {
    const now = new Date().toISOString()
    const projectPath = input.projectPath ? path.resolve(input.projectPath) : undefined
    // A project path alone still describes a complete workspace: the project root
    // is the workspace and its only member is `main`. Writing all three keeps
    // later workspace calls from having to re-derive it.
    const workspacePath = input.workspacePath ? path.resolve(input.workspacePath) : projectPath
    const record: SessionRecord = {
      schemaVersion: 1, sessionId: randomUUID(), name: input.name?.trim() || '新任务', projectPath,
      ...(workspacePath ? { workspacePath, workspaceKind: input.workspaceKind ?? 'mod' as WorkspaceKind, activeMemberId: input.activeMemberId ?? PRIMARY_MEMBER_ID } : {}),
      status: 'active', createdAt: now, updatedAt: now, phase: '准备开始', currentModule: 'overview', recommendedModules: [], jobs: [], instances: [],
      backendOwner: this.backendId, ownerPid: process.pid
    }
    this.acquire(record.sessionId)
    this.write(record)
    return this.publicRecord(record)
  }

  read(sessionId: string): TaskSession {
    const record = this.mustRead(sessionId)
    return this.publicRecord(record)
  }

  assertOwned(sessionId: string): TaskSession { return this.publicRecord(this.mustOwn(sessionId)) }

  resume(sessionId: string): TaskSession {
    const record = this.mustRead(sessionId)
    if (record.status === 'ended') throw Object.assign(new Error('该任务会话已结束，不能恢复。'), { code: 'SESSION_ENDED' })
    if (!this.owned.has(sessionId)) this.acquire(sessionId)
    record.backendOwner = this.backendId; record.ownerPid = process.pid; record.updatedAt = new Date().toISOString()
    this.write(record)
    return this.publicRecord(record)
  }

  update(sessionId: string, changes: SessionChanges, options: { memberIds?: readonly string[] } = {}): TaskSession {
    const record = this.mustOwn(sessionId)
    if (changes.projectPath && record.projectPath && !samePath(changes.projectPath, record.projectPath)) {
      this.conflict('project', '一个任务会话只能绑定一个工程。请为另一个工程创建新会话。')
    }
    if (changes.workspacePath && record.workspacePath && !samePath(changes.workspacePath, record.workspacePath)) {
      this.conflict('workspace', '一个任务会话只能绑定一个工作区。请为另一个工作区创建新会话。')
    }
    if (changes.activeMemberId && options.memberIds && !options.memberIds.includes(changes.activeMemberId)) {
      throw Object.assign(
        new Error(`工作区里没有成员「${changes.activeMemberId}」；现有成员：${options.memberIds.join(', ') || '（空）'}`),
        { code: 'MEMBER_NOT_FOUND' }
      )
    }
    Object.assign(record, changes)
    if (changes.projectPath) record.projectPath = path.resolve(changes.projectPath)
    if (changes.workspacePath) record.workspacePath = path.resolve(changes.workspacePath)
    record.updatedAt = new Date().toISOString(); this.write(record)
    return this.publicRecord(record)
  }

  /**
   * Bind the session to a workspace.
   *
   * `primaryPath` is the compatibility projection into `projectPath`: for a mod
   * workspace it is the project root, for a pack it is whichever member the legacy
   * tools should keep reading. Omitting it leaves `projectPath` untouched, which
   * is what a pure metadata update wants.
   */
  bindWorkspace(sessionId: string, input: { workspacePath: string; kind: WorkspaceKind; primaryPath?: string; memberIds?: readonly string[] }): TaskSession {
    const root = path.resolve(input.workspacePath)
    const current = this.mustOwn(sessionId)
    if (current.workspacePath && !samePath(current.workspacePath, root)) {
      this.conflict('workspace', '当前会话已关联其他工作区；请创建新会话，避免游戏和任务混到一起。')
    }
    // Sessions created before workspaces existed only carry `projectPath`. Keep
    // rejecting a genuinely different project rather than silently rebinding.
    if (!current.workspacePath && current.projectPath && !samePath(current.projectPath, input.primaryPath ?? root)) {
      this.conflict('project', '当前会话已关联其他工程；请创建新会话，避免游戏和任务混到一起。')
    }
    let changed = false
    if (!current.workspacePath) { current.workspacePath = root; changed = true }
    if (current.workspaceKind !== input.kind) { current.workspaceKind = input.kind; changed = true }
    const memberId = this.pickMember(current.activeMemberId, input.memberIds)
    if (memberId && memberId !== current.activeMemberId) { current.activeMemberId = memberId; changed = true }
    if (input.primaryPath) {
      const primary = path.resolve(input.primaryPath)
      if (!current.projectPath || !samePath(current.projectPath, primary)) { current.projectPath = primary; changed = true }
    }
    if (changed) { current.updatedAt = new Date().toISOString(); this.write(current) }
    return this.publicRecord(current)
  }

  /** Compatibility adapter: a single-mod project is a workspace with one `main` member. */
  bindProject(sessionId: string, projectPath: string): TaskSession {
    const root = path.resolve(projectPath)
    return this.bindWorkspace(sessionId, { workspacePath: root, kind: 'mod', primaryPath: root, memberIds: [PRIMARY_MEMBER_ID] })
  }

  /**
   * Keep the current member when it still exists, otherwise prefer `main`.
   * Returns undefined when no member list is supplied (metadata-only update).
   */
  private pickMember(current: string | undefined, memberIds?: readonly string[]): string | undefined {
    if (!memberIds || memberIds.length === 0) return current
    if (current && memberIds.includes(current)) return current
    return memberIds.includes(PRIMARY_MEMBER_ID) ? PRIMARY_MEMBER_ID : memberIds[0]
  }

  private conflict(scope: 'workspace' | 'project', message: string): never {
    throw Object.assign(new Error(message), { code: 'SESSION_PROJECT_MISMATCH', scope })
  }

  sync(sessionId: string, jobs: JobSnapshot[], instances: GameInstance[]): void {
    const record = this.mustOwn(sessionId)
    const allJobs = new Map(record.jobs.map((job) => [job.id, job]))
    for (const job of jobs) allJobs.set(job.id, { ...job })
    record.jobs = [...allJobs.values()]
    const allInstances = new Map(record.instances.map((instance) => [instance.instanceId, instance]))
    for (const instance of instances) allInstances.set(instance.instanceId, { ...instance })
    record.instances = [...allInstances.values()]
    record.updatedAt = new Date().toISOString(); this.write(record)
  }

  end(sessionId: string): TaskSession {
    const record = this.mustOwn(sessionId)
    record.status = 'ended'; record.phase = '已结束'; record.updatedAt = new Date().toISOString()
    record.backendOwner = undefined; record.ownerPid = undefined
    this.write(record); this.release(sessionId)
    return this.publicRecord(record)
  }

  list(): TaskSession[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map((file) => this.readRecord(file.slice(0, -5))).filter((value): value is SessionRecord => Boolean(value))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((value) => this.publicRecord(value))
  }

  close(): void {
    // Keep leases until this process exits: child jobs may still be shutting down.
    // A later backend reclaims these lock files after confirming ownerPid is dead.
  }

  private mustOwn(sessionId: string): SessionRecord {
    const record = this.mustRead(sessionId)
    if (record.status === 'ended') throw Object.assign(new Error('该任务会话已结束。'), { code: 'SESSION_ENDED' })
    if (!this.owned.has(sessionId) || record.backendOwner !== this.backendId) throw Object.assign(new Error('该会话尚未由当前后端恢复，请先调用 modcrafting_session resume。'), { code: 'SESSION_NOT_OWNED' })
    return record
  }

  private acquire(sessionId: string): void {
    mkdirSync(this.root, { recursive: true })
    const lock = path.join(this.root, `${sessionId}.lock`)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const descriptor = openSync(lock, 'wx', 0o600)
        try { writeFileSync(descriptor, JSON.stringify({ backendId: this.backendId, pid: process.pid }), 'utf8') }
        finally { closeSync(descriptor) }
        this.owned.add(sessionId)
        return
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
        const recovery = `${lock}.recovery`
        let recoveryDescriptor: number
        try { recoveryDescriptor = openSync(recovery, 'wx', 0o600) }
        catch { throw Object.assign(new Error('该会话正在另一个 ModCrafting 后端中使用，或正在被恢复；请从原工作台继续。'), { code: 'SESSION_IN_USE' }) }
        try {
          let owner: { pid?: number } | undefined
          try { owner = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: number } } catch { /* try the persisted owner record below */ }
          if (!owner) {
            const record = this.readRecord(sessionId)
            if (record && !alive(record.ownerPid)) owner = { pid: record.ownerPid }
          }
          if (!owner || alive(owner.pid)) throw Object.assign(new Error('该会话正在另一个 ModCrafting 后端中使用；请关闭原工作台后再恢复，避免两个页面覆盖同一份数据。'), { code: 'SESSION_IN_USE' })
          try { unlinkSync(lock) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        } finally {
          closeSync(recoveryDescriptor)
          try { unlinkSync(recovery) } catch { /* recovery marker cleanup */ }
        }
      }
    }
    throw Object.assign(new Error('无法独占恢复这个任务会话。'), { code: 'SESSION_IN_USE' })
  }

  private release(sessionId: string): void {
    if (!this.owned.delete(sessionId)) return
    const lock = path.join(this.root, `${sessionId}.lock`)
    try {
      const owner = JSON.parse(readFileSync(lock, 'utf8')) as { backendId?: string }
      if (owner.backendId === this.backendId) unlinkSync(lock)
    } catch { /* another process may already have recovered a stale lock */ }
  }

  private mustRead(sessionId: string): SessionRecord {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw Object.assign(new Error('sessionId 格式无效。'), { code: 'SESSION_NOT_FOUND' })
    const record = this.readRecord(sessionId)
    if (!record) throw Object.assign(new Error('未找到这个任务会话。'), { code: 'SESSION_NOT_FOUND' })
    return record
  }

  private readRecord(sessionId: string): SessionRecord | undefined {
    const file = path.join(this.root, `${sessionId}.json`)
    if (!existsSync(file)) return undefined
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord
      return record.schemaVersion === 1 && record.sessionId === sessionId ? record : undefined
    } catch { return undefined }
  }

  private write(record: SessionRecord): void {
    const target = path.join(this.root, `${record.sessionId}.json`)
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, target)
  }

  private publicRecord(record: SessionRecord): TaskSession {
    const { schemaVersion: _schemaVersion, backendOwner: _backendOwner, ownerPid: _ownerPid, ...value } = record
    return structuredClone(value)
  }
}
