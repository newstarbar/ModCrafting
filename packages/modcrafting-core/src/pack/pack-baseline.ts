/**
 * The convenience baseline: which client-side quality-of-life mods a pack ships
 * by default, whether each one has a build for the pack's target, and how a
 * resolved baseline becomes ordinary `pack.json` entries.
 *
 * Availability is always asked of the registry, never assumed. The shipped slugs
 * are Fabric names; a NeoForge pack gets an alternative (Sodium -> Embeddium)
 * only when that alternative actually has a matching build, and otherwise gets a
 * named gap the user can act on.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  BUILTIN_BASELINE,
  baselineGroupsOf,
  baselineProfileSchema,
  checkBaselineEntry,
  type BaselineProfile
} from '../pack-model.ts'
import { targetIdSchema, type PackEntry } from '../workspace-model.ts'
import type { LoaderId } from '../version/schema.ts'
import { parseTargetId } from '../version/targets.ts'
import type { DiscoverTarget } from './pack-discover.ts'
import { entryFromVersion } from './pack-entry.ts'
import type { RegistryReader } from './registry-client.ts'
import type { RegistryFile, RegistryProject, RegistryVersion } from './registry-model.ts'

export const BASELINE_FILE = '.modcrafting/baseline.json'

/** Loader-specific replacements for shipped slugs that do not publish that loader. */
export const BASELINE_TARGET_ALTERNATIVES: Readonly<Record<LoaderId, Readonly<Record<string, readonly string[]>>>> = {
  fabric: {},
  neoforge: {
    sodium: ['embeddium'],
    iris: ['oculus'],
    indium: []
  },
  forge: {
    sodium: ['embeddium'],
    iris: ['oculus'],
    indium: []
  }
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function profilePath(root: string): string {
  return path.join(path.resolve(root), ...BASELINE_FILE.split('/'))
}

export function readBaselineProfile(root: string): BaselineProfile {
  const file = profilePath(root)
  if (!existsSync(file)) return BASELINE_PROFILE_COPY()
  try {
    return baselineProfileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch (cause) {
    fail('BASELINE_INVALID', `${BASELINE_FILE} 不合法：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export function writeBaselineProfile(root: string, profile: BaselineProfile): BaselineProfile {
  const parsed = baselineProfileSchema.parse(profile)
  const file = profilePath(root)
  const temporary = `${file}.${process.pid}.tmp`
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return parsed
}

/** A fresh object so callers cannot mutate the shipped profile by accident. */
function BASELINE_PROFILE_COPY(): BaselineProfile {
  return structuredClone(BUILTIN_BASELINE)
}

export interface BaselinePick {
  /** The slug actually installed (may be a loader-specific replacement). */
  slug: string
  requestedSlug: string
  group: string
  required: boolean
  alternative: boolean
  projectId: string
  project: RegistryProject
  version: RegistryVersion
  file: RegistryFile
  reason: string
}

export interface BaselineMissing {
  slug: string
  group: string
  required: boolean
  reason: string
}

export interface BaselineResolution {
  targetId: string
  picks: BaselinePick[]
  missing: BaselineMissing[]
  warnings: string[]
  entries: PackEntry[]
}

function targetIdOf(target: DiscoverTarget): string {
  return `${target.loader}@${target.minecraft}`
}


const CHANNEL_RANK: Readonly<Record<RegistryVersion['channel'], number>> = { release: 0, beta: 1, alpha: 2 }

function chooseVersion(versions: readonly RegistryVersion[]): RegistryVersion | undefined {
  return [...versions]
    .filter((version) => version.files.length > 0)
    .sort((left, right) =>
      CHANNEL_RANK[left.channel] - CHANNEL_RANK[right.channel] ||
      right.publishedAt.localeCompare(left.publishedAt) ||
      right.versionId.localeCompare(left.versionId)
    )[0]
}

function primaryFile(version: RegistryVersion): RegistryFile {
  return version.files.find((file) => file.primary) ?? version.files[0]
}

/** Entries selected by group id, in declaration order, de-duplicated by slug. */
function requestedEntries(profile: BaselineProfile, groupIds: readonly string[]): Array<{ slug: string; required: boolean; group: string; reason: string }> {
  const groups = baselineGroupsOf(profile, groupIds)
  const seen = new Set<string>()
  const output: Array<{ slug: string; required: boolean; group: string; reason: string }> = []
  for (const group of groups) {
    for (const entry of group.entries) {
      const slug = entry.slug.toLowerCase()
      if (seen.has(slug)) continue
      seen.add(slug)
      output.push({ slug, required: entry.required, group: group.id, reason: entry.reason })
    }
  }
  return output
}

async function tryCandidate(
  reader: RegistryReader,
  candidate: string,
  requested: { slug: string; group: string; required: boolean; reason: string },
  target: DiscoverTarget,
  present: readonly string[]
): Promise<{ pick?: BaselinePick; blocked?: string; reason?: string }> {
  let project: RegistryProject
  try {
    project = await reader.project({ registry: 'modrinth', projectId: candidate })
  } catch {
    return { reason: `没有找到模组 ${candidate}` }
  }
  if (!project.loaders.includes(target.loader) || !project.gameVersions.includes(target.minecraft)) {
    return { reason: `${candidate} 没有声明支持 ${target.loader} ${target.minecraft}` }
  }

  const verdict = checkBaselineEntry({ slug: candidate, categories: project.categories, environment: project.environment, present })
  // `=== false` rather than `!verdict.ok`: the project's tsconfig does not enable
  // strictNullChecks, and narrowing a boolean-literal union needs the explicit form.
  if (verdict.ok === false) return { blocked: verdict.message }

  let versions: RegistryVersion[]
  try {
    versions = await reader.versions({ registry: 'modrinth', projectId: project.projectId, loader: target.loader, gameVersion: target.minecraft })
  } catch {
    return { reason: `${candidate} 的版本列表读取失败` }
  }
  const version = chooseVersion(versions)
  if (!version) return { reason: `${candidate} 没有支持 ${target.loader} ${target.minecraft} 的版本` }
  const file = primaryFile(version)
  if (!file) return { reason: `${candidate} 的版本没有可下载文件` }

  return {
    pick: {
      slug: candidate,
      requestedSlug: requested.slug,
      group: requested.group,
      required: requested.required,
      alternative: candidate !== requested.slug,
      projectId: project.projectId,
      project,
      version,
      file,
      reason: requested.reason
    }
  }
}

export async function resolveBaseline(
  reader: RegistryReader,
  input: { profile: BaselineProfile; groupIds: readonly string[]; target: DiscoverTarget }
): Promise<BaselineResolution> {
  const picks: BaselinePick[] = []
  const missing: BaselineMissing[] = []
  const warnings: string[] = []

  for (const requested of requestedEntries(input.profile, input.groupIds)) {
    const alternatives = BASELINE_TARGET_ALTERNATIVES[input.target.loader][requested.slug] ?? []
    const candidates = [...new Set([requested.slug, ...alternatives])]
    let blocked: string | undefined
    let lastReason = `没有找到模组 ${requested.slug}`

    for (const candidate of candidates) {
      const attempt = await tryCandidate(reader, candidate, requested, input.target, picks.map((pick) => pick.slug))
      if (attempt.pick) {
        if (attempt.pick.alternative) warnings.push(`${requested.slug} 在 ${input.target.loader} 上没有可用版本，已改用 ${attempt.pick.slug}。`)
        if (!attempt.pick.file.url) warnings.push(`${attempt.pick.slug} 没有公开下载地址，导出时只能写本地安装引用。`)
        const verdict = checkBaselineEntry({
          slug: attempt.pick.slug,
          categories: attempt.pick.project.categories,
          environment: attempt.pick.project.environment,
          present: picks.map((pick) => pick.slug)
        })
        if (verdict.ok && verdict.warning) warnings.push(verdict.warning)
        picks.push(attempt.pick)
        break
      }
      if (attempt.blocked) { blocked = attempt.blocked; break }
      if (attempt.reason) lastReason = attempt.reason
    }

    if (!picks.some((pick) => pick.requestedSlug === requested.slug)) {
      const reason = blocked ?? lastReason
      if (requested.required) missing.push({ slug: requested.slug, group: requested.group, required: true, reason })
      else warnings.push(`${requested.slug}（可选）未装配：${reason}`)
    }
  }

  return {
    targetId: targetIdOf(input.target),
    picks,
    missing,
    warnings,
    entries: baselineEntries(picks)
  }
}

export function baselineEntries(picks: readonly BaselinePick[]): PackEntry[] {
  return picks.map((pick) => entryFromVersion({
    entryId: pick.slug,
    projectId: pick.projectId,
    source: 'baseline',
    version: pick.version,
    file: pick.file,
    license: pick.project.license,
    environment: pick.project.environment
  }))
}

export const packBaselineRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), workspacePath: z.string().min(1) }).strict(),
  z.object({ action: z.literal('write'), workspacePath: z.string().min(1), profile: baselineProfileSchema }).strict(),
  z.object({
    action: z.literal('resolve'),
    workspacePath: z.string().min(1),
    targetId: targetIdSchema,
    groupIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)).max(8)
  }).strict()
])
export type PackBaselineRequest = z.infer<typeof packBaselineRequestSchema>

export async function packBaseline(reader: RegistryReader, request: PackBaselineRequest): Promise<Record<string, unknown>> {
  if (request.action === 'read') {
    const file = profilePath(request.workspacePath)
    return { action: 'read', profile: readBaselineProfile(request.workspacePath), source: existsSync(file) ? 'workspace' : 'builtin', file }
  }
  if (request.action === 'write') {
    return { action: 'write', profile: writeBaselineProfile(request.workspacePath, request.profile), file: profilePath(request.workspacePath) }
  }
  const { loader, minecraft } = parseTargetId(request.targetId)
  const profile = readBaselineProfile(request.workspacePath)
  const resolution = await resolveBaseline(reader, { profile, groupIds: request.groupIds, target: { loader, minecraft } })
  return { action: 'resolve', ...resolution, profile }
}
