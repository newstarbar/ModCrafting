/** Skill installation: copy portable SKILL.md trees into a host's skill roots. */
import fs from 'node:fs'
import path from 'node:path'
import { CliError, EXIT } from './args.mjs'
import { SKILL_NAMES } from './hosts.mjs'
import { atomicWrite, backupFile, ensureDir, exists, removeIfEmpty, sha256 } from './fsx.mjs'
import { backupsDir } from './paths.mjs'

export function skillRoots(host, ctx, options) {
  if (options.flags.has('project')) {
    const relative = host.skills.project(ctx)
    if (!relative) throw new CliError(`${host.label} 不支持项目级技能目录`, { code: 'UNSUPPORTED_HOST', exitCode: EXIT.UNSUPPORTED })
    return [{ root: path.join(process.cwd(), relative), scope: 'project' }]
  }
  const candidates = host.skills.global(ctx)
  if (!candidates.length) return []
  const existing = candidates.find((root) => exists(root))
  if (existing) return [{ root: existing, scope: 'global' }]
  // Unverified hosts: never create a guessed directory; MCP-only install is enough.
  if (host.verified !== 'yes') return []
  return [{ root: candidates[0], scope: 'global' }]
}

export function installSkills(bundle, host, ctx, options) {
  const dryRun = options.flags.has('dry-run')
  const roots = skillRoots(host, ctx, options)
  const installed = []
  for (const { root, scope } of roots) {
    for (const name of SKILL_NAMES) {
      const source = path.join(bundle.directory, 'skills', name, 'SKILL.md')
      if (!exists(source)) continue
      const bytes = fs.readFileSync(source)
      const digest = sha256(bytes)
      const targetDir = path.join(root, name)
      const target = path.join(targetDir, 'SKILL.md')
      const previous = exists(target)
      if (previous && sha256(fs.readFileSync(target)) === digest) {
        installed.push({ root, scope, name, file: target, action: 'unchanged', sha256: digest })
        continue
      }
      if (dryRun) {
        installed.push({ root, scope, name, file: target, action: previous ? 'update' : 'create', sha256: digest })
        continue
      }
      if (previous) backupFile(target, path.join(backupsDir(), host.id))
      ensureDir(targetDir)
      atomicWrite(target, bytes)
      installed.push({ root, scope, name, file: target, action: previous ? 'updated' : 'created', sha256: digest })
    }
  }
  return installed
}

export function removeSkills(records, { dryRun = false } = {}) {
  const removed = []
  const kept = []
  for (const record of records ?? []) {
    if (!record?.file || !exists(record.file)) continue
    const actual = sha256(fs.readFileSync(record.file))
    if (record.sha256 && actual !== record.sha256) {
      kept.push({ ...record, reason: '文件已被修改，保留不删' })
      continue
    }
    if (!dryRun) {
      fs.rmSync(record.file, { force: true })
      removeIfEmpty(path.dirname(record.file))
    }
    removed.push(record)
  }
  return { removed, kept }
}

export function skillsStatus(host, ctx, options, bundleDir) {
  const roots = host.skills.global(ctx)
  const result = []
  for (const root of roots) {
    for (const name of SKILL_NAMES) {
      const file = path.join(root, name, 'SKILL.md')
      const installed = exists(file)
      const source = bundleDir ? path.join(bundleDir, 'skills', name, 'SKILL.md') : undefined
      result.push({ root, name, file, installed, current: installed && source ? sha256(fs.readFileSync(file)) === sha256(fs.readFileSync(source)) : undefined })
    }
  }
  return result
}
