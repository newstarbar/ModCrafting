import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TaskCheckpoint } from '../shared/harness-runtime.ts'

function safeId(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!normalized) throw new Error('checkpoint task id is empty')
  return normalized.slice(0, 160)
}

/** Small atomic JSON store used by Harness recovery. */
export class CheckpointStore {
  private readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  private file(taskId: string): string {
    return path.join(this.root, `${safeId(taskId)}.json`)
  }

  async save(checkpoint: TaskCheckpoint): Promise<TaskCheckpoint> {
    await mkdir(this.root, { recursive: true })
    const target = this.file(checkpoint.taskId)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    const normalized = { ...checkpoint, version: 1 as const, updatedAt: Date.now() }
    await writeFile(temporary, JSON.stringify(normalized, null, 2), 'utf8')
    // rename is atomic on the same volume; writeFile above means a crash cannot
    // leave a half-written checkpoint at the canonical path.
    const fs = await import('node:fs/promises')
    await fs.rename(temporary, target)
    return normalized
  }

  async load(taskId: string): Promise<TaskCheckpoint | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(taskId), 'utf8')) as Partial<TaskCheckpoint>
      if (raw.version !== 1 || typeof raw.taskId !== 'string' || !raw.workspace || !raw.state || !raw.stage) return null
      return raw as TaskCheckpoint
    } catch {
      return null
    }
  }

  async list(): Promise<TaskCheckpoint[]> {
    try {
      const names = (await readdir(this.root)).filter((name) => name.endsWith('.json'))
      const result: TaskCheckpoint[] = []
      for (const name of names) {
        const checkpoint = await this.load(name.slice(0, -5))
        if (checkpoint) result.push(checkpoint)
      }
      return result.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  async remove(taskId: string): Promise<void> {
    await rm(this.file(taskId), { force: true })
  }
}
