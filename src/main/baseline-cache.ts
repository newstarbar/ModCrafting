import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BuildReport } from '../shared/harness-runtime.ts'

export class BaselineBuildCache {
  private readonly root: string

  constructor(root: string) { this.root = path.resolve(root) }

  private file(projectPath: string, profileFingerprint: string, task: string): string {
    const key = createHash('sha256').update(`${path.resolve(projectPath)}\0${profileFingerprint}\0${task}`).digest('hex')
    return path.join(this.root, `${key}.json`)
  }

  async get(projectPath: string, profileFingerprint: string, task: string): Promise<BuildReport | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(projectPath, profileFingerprint, task), 'utf8')) as BuildReport
      return parsed.version === 1 && parsed.ok ? parsed : null
    } catch { return null }
  }

  async put(projectPath: string, profileFingerprint: string, task: string, report: BuildReport): Promise<void> {
    if (!report.ok) return
    await mkdir(this.root, { recursive: true })
    const target = this.file(projectPath, profileFingerprint, task)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, JSON.stringify(report, null, 2), 'utf8')
    const fs = await import('node:fs/promises')
    await fs.rename(temporary, target)
  }

  async clear(): Promise<void> { await rm(this.root, { recursive: true, force: true }) }
}
