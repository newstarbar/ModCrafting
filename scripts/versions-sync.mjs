#!/usr/bin/env node
/**
 * Sync the Minecraft / loader version catalog from upstream metadata.
 *
 * Why a generated catalog instead of a constant: Minecraft moved to year-based
 * ids in 2026 (26.1 / 26.2 / 26.3) next to the legacy 1.20.x / 1.21.x line, so
 * version order can only come from an authoritative release sequence. The
 * catalog is that sequence plus one row per (loader, Minecraft) cell.
 *
 * Rules that keep this honest:
 *  - A failed endpoint never deletes a cell. It records a sync failure and the
 *    previous value survives, so an offline run cannot silently shrink coverage.
 *  - "Not published upstream" (unavailable) and "we could not reach upstream"
 *    (unknown) are different states.
 *  - Probe results always win over sync guesses.
 *
 * Usage:
 *   node scripts/versions-sync.mjs            # fetch and rewrite the catalog
 *   node scripts/versions-sync.mjs --check    # fail only if Mojang shipped a newer release
 *   node scripts/versions-sync.mjs --offline  # validate the checked-in catalog, no network
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_PATH = path.join(ROOT, 'packages/modcrafting-core/src/version/catalog.json')
const GENERATED_PATH = path.join(ROOT, 'packages/modcrafting-core/src/version/catalog.generated.ts')

const DEFAULT_MILESTONES = ['1.20.1', '1.20.4', '1.20.6', '1.21.1', '1.21.4', '1.21.5', '1.21.8', '1.21.11', '26.1', '26.3']
const LOADERS = ['fabric', 'neoforge', 'forge']
const GRADLE_HYPOTHESIS = '9.5.0'
/** The only combination this repository actually builds today, so it is declared rather than guessed. */
const DECLARED_CELL = 'fabric@1.21.4'
const OBSERVER_CELLS = new Set(['fabric@1.21.4'])

const ENDPOINTS = {
  manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  fabricLoader: (mc) => `https://meta.fabricmc.net/v2/versions/loader/${mc}`,
  yarn: (mc) => `https://meta.fabricmc.net/v2/versions/yarn/${mc}`,
  fabricApi: 'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml',
  loom: 'https://maven.fabricmc.net/net/fabricmc/fabric-loom/maven-metadata.xml',
  neoforgeMaven: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
  neoforgeMirror: 'https://meta.prismlauncher.org/v1/net.neoforged',
  moddevGradle: 'https://plugins.gradle.org/m2/net/neoforged/moddev-gradle/maven-metadata.xml',
  forgePromotions: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  forgeGradle: 'https://maven.minecraftforge.net/net/minecraftforge/gradle/ForgeGradle/maven-metadata.xml'
}

const failures = []
function recordFailure(endpoint, reason) { failures.push({ endpoint, reason }) }
const note = (line) => process.stdout.write(`${line}\n`)

async function fetchText(url) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'modcrafting-version-sync' }, signal: AbortSignal.timeout(25000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (cause) {
      lastError = cause
    }
  }
  throw lastError
}
const fetchJson = async (url) => JSON.parse(await fetchText(url))

/** Loose ordering for candidate selection only; never used for catalog identity. */
function compareLoose(a, b) {
  const split = (value) => {
    const [base, ...rest] = String(value).split('-')
    return { base: base.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)), suffix: rest.join('-') }
  }
  const left = split(a), right = split(b)
  for (let index = 0; index < Math.max(left.base.length, right.base.length); index += 1) {
    const x = left.base[index] ?? 0, y = right.base[index] ?? 0
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x - y }
    else if (String(x) !== String(y)) return String(x) < String(y) ? -1 : 1
  }
  if (left.suffix === right.suffix) return 0
  if (!left.suffix) return 1
  if (!right.suffix) return -1
  return left.suffix < right.suffix ? -1 : 1
}
const pickMax = (list, { stable = false } = {}) => {
  const pool = stable ? list.filter((value) => !value.includes('-')) : list
  return pool.length ? [...pool].sort(compareLoose).at(-1) : undefined
}
const mavenVersions = (xml) => [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1].trim()).filter(Boolean)

/**
 * NeoForge encodes the Minecraft version inside its own version number, and the
 * scheme differs per era. Prefix matching alone is wrong: `26.1.2.126` belongs to
 * Minecraft 26.1.2, not 26.1. So we decode the implied Minecraft id and compare.
 *  - 1.x era, 2-segment NeoForge base carries the build: 21.4.161 -> 1.21.4
 *  - the 1.20.1 fork shipped under Forge's scheme:        47.1.106 -> 1.20.1
 *  - year era, third segment 0 means "no patch":         26.3.0.103 -> 26.3
 *  - year era, third segment non-zero:                   26.1.2.126 -> 26.1.2
 */
function impliedNeoforgeMinecraft(version) {
  const parts = version.replace(/-.*$/, '').split('.').map(Number)
  if (parts.length < 3 || parts.some((value) => !Number.isInteger(value))) return undefined
  const [first, second, third] = parts
  if (first === 47) return '1.20.1'
  // Year-based ids must be decoded before the legacy branch, otherwise 26.x
  // would fall into "20 <= first < 40" and be reported as Minecraft 1.26.x.
  if (first >= 26) return parts.length === 3 ? `${first}.${second}` : third === 0 ? `${first}.${second}` : `${first}.${second}.${third}`
  if (first >= 20 && first < 47) return `1.${first}.${second}`
  return undefined
}

function readPrevious() {
  if (!existsSync(CATALOG_PATH)) return undefined
  try { return JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) } catch { return undefined }
}

async function collectUpstream(milestones) {
  const manifest = await fetchJson(ENDPOINTS.manifest)
  const releases = manifest.versions.filter((entry) => entry.type === 'release')
  const order = releases.map((entry) => entry.id)
  const releaseTime = new Map(releases.map((entry) => [entry.id, entry.releaseTime]))

  const javaTargets = new Map()
  for (const mc of milestones) {
    const entry = releases.find((value) => value.id === mc)
    if (!entry) { recordFailure(ENDPOINTS.manifest, `Mojang 清单里没有 ${mc}`); continue }
    try {
      const detail = await fetchJson(entry.url)
      const major = Number(detail.javaVersion?.majorVersion)
      if (Number.isFinite(major)) javaTargets.set(mc, major)
      else recordFailure(entry.url, `${mc} 缺少 javaVersion.majorVersion`)
    } catch (cause) { recordFailure(entry.url, `${mc}: ${cause.message}`) }
  }

  const tools = {}
  for (const [key, url] of [['loom', ENDPOINTS.loom], ['moddevGradle', ENDPOINTS.moddevGradle], ['forgeGradle', ENDPOINTS.forgeGradle]]) {
    try { tools[key] = pickMax(mavenVersions(await fetchText(url)), { stable: true }) ?? pickMax(mavenVersions(await fetchText(url))) }
    catch (cause) { recordFailure(url, cause.message) }
  }

  let fabricApiVersions = []
  try { fabricApiVersions = mavenVersions(await fetchText(ENDPOINTS.fabricApi)) }
  catch (cause) { recordFailure(ENDPOINTS.fabricApi, cause.message) }

  const perMinecraft = new Map()
  const fabricCoverage = new Set()
  for (const mc of milestones) {
    const row = { mc, fabric: undefined, neoforge: undefined, forge: undefined }
    try {
      const loaders = await fetchJson(ENDPOINTS.fabricLoader(mc))
      fabricCoverage.add(mc)
      const stable = loaders.find((entry) => entry.loader?.stable === true) ?? loaders[0]
      const yarn = await fetchJson(ENDPOINTS.yarn(mc))
      const yarnVersion = (stable ? yarn[0]?.version : yarn[0]?.version) || undefined
      if (stable?.loader?.version) {
        row.fabric = {
          loaderVersion: stable.loader.version,
          mappings: { kind: 'yarn', version: yarnVersion ?? `${mc}+build.1`, channel: 'v2' },
          apiVersion: pickMax(fabricApiVersions.filter((value) => value.endsWith(`+${mc}`))) ?? null,
          channel: 'stable', recommended: true
        }
      } else recordFailure(ENDPOINTS.fabricLoader(mc), `没有可用的 Fabric Loader`)
    } catch (cause) { recordFailure(ENDPOINTS.fabricLoader(mc), cause.message) }
    perMinecraft.set(mc, row)
  }

  // NeoForge: prefer the official maven, fall back to the launcher meta mirror.
  const neoforgeVersions = []
  let neoforgeSource = ENDPOINTS.neoforgeMaven
  try { neoforgeVersions.push(...mavenVersions(await fetchText(ENDPOINTS.neoforgeMaven))) }
  catch (cause) {
    recordFailure(ENDPOINTS.neoforgeMaven, cause.message)
    neoforgeSource = ENDPOINTS.neoforgeMirror
    try {
      const mirror = await fetchJson(ENDPOINTS.neoforgeMirror)
      for (const entry of mirror.versions ?? []) {
        const target = (entry.requires ?? []).find((value) => value.uid === 'net.minecraft')
        if (target?.equals) neoforgeVersions.push(entry.version)
      }
    } catch (mirrorCause) { recordFailure(ENDPOINTS.neoforgeMirror, mirrorCause.message) }
  }
  for (const mc of milestones) {
    const row = perMinecraft.get(mc)
    const candidates = neoforgeVersions.filter((value) => impliedNeoforgeMinecraft(value) === mc)
    const chosen = pickMax(candidates, { stable: true }) ?? pickMax(candidates)
    if (!chosen) continue
    const beta = chosen.includes('-beta')
    row.neoforge = {
      loaderVersion: chosen,
      mappings: { kind: 'mojmap', version: mc },
      apiVersion: null,
      channel: beta ? 'beta' : 'stable',
      recommended: !beta,
      note: mc === '1.20.1' ? '1.20.1 线沿用 Forge 式 47.x 坐标（net.neoforged:forge）' : undefined,
      sources: [neoforgeSource]
    }
  }

  let promotions
  try { promotions = (await fetchJson(ENDPOINTS.forgePromotions)).promos ?? {} }
  catch (cause) { recordFailure(ENDPOINTS.forgePromotions, cause.message) }
  for (const mc of milestones) {
    if (!promotions) continue
    const recommended = promotions[`${mc}-recommended`], latest = promotions[`${mc}-latest`]
    const version = recommended ?? latest
    if (!version) continue
    perMinecraft.get(mc).forge = {
      loaderVersion: version,
      mappings: { kind: 'official', version: mc },
      apiVersion: null,
      channel: recommended ? 'stable' : 'latest',
      recommended: Boolean(recommended),
      sources: [ENDPOINTS.forgePromotions]
    }
  }

  return {
    order, releaseTime, javaTargets, tools, perMinecraft,
    coverage: { fabric: fabricCoverage, neoforge: neoforgeVersions.length > 0, forge: Boolean(promotions) }
  }
}

function carryPrevious(previousCell, base) {
  if (previousCell?.release) {
    return {
      ...base,
      status: previousCell.status,
      release: previousCell.release,
      ...(previousCell.reason ? { reason: previousCell.reason } : {}),
      ...(previousCell.remediation ? { remediation: previousCell.remediation } : {}),
      ...(previousCell.probedAt ? { probedAt: previousCell.probedAt } : {})
    }
  }
  return {
    ...base, status: 'unknown', release: null,
    reason: `未能读取 ${base.loader} 的版本索引，本次同步没有覆盖这个单元格`,
    remediation: '检查网络或该加载器的镜像后重新运行 pnpm run versions:sync'
  }
}

function buildCell({ loader, mc, row, javaTarget, tools, previous, generatedAt, coverage }) {
  const key = `${loader}@${mc}`
  const previousCell = previous?.cells?.find((cell) => cell.key === key)
  const upstream = row[loader]
  const probed = previousCell?.probedAt && previousCell?.release?.evidence === 'probed'
  const runtimeObserver = previousCell?.runtimeObserver ?? OBSERVER_CELLS.has(key)
  const covered = loader === 'fabric' ? coverage.fabric.has(mc) : coverage[loader]

  if (!upstream) {
    // Two very different situations. If we never reached this loader's index we
    // keep whatever we knew before. If the index was readable and simply has no
    // entry, the cell genuinely does not exist upstream.
    if (!covered) return carryPrevious(previousCell, { key, loader, mc, runtimeObserver })
    return {
      key, loader, minecraft: mc, status: 'unavailable', release: null,
      reason: `上游未发布 ${loader} 的 ${mc}`,
      remediation: loader === 'fabric' ? `确认 Fabric 是否支持 ${mc}` : `改用同一位次的其他加载器，或等待 ${loader} 跟进 ${mc}`,
      runtimeObserver
    }
  }

  const plugin = loader === 'fabric'
    ? { pluginId: 'fabric-loom', pluginVersion: tools.loom }
    : loader === 'neoforge'
      ? { pluginId: 'net.neoforged.moddev', pluginVersion: tools.moddevGradle }
      : { pluginId: 'net.minecraftforge.gradle', pluginVersion: tools.forgeGradle }
  const hypothesis = plugin.pluginVersion
    ? { gradle: probed ? previousCell.release.build.gradle : GRADLE_HYPOTHESIS, pluginId: plugin.pluginId, pluginVersion: probed ? previousCell.release.build.pluginVersion : plugin.pluginVersion }
    : null
  const evidence = probed ? 'probed' : key === DECLARED_CELL ? 'declared' : 'unverified'

  const beta = upstream.channel === 'beta'
  const status = beta
    ? 'build-only'
    : probed ? (runtimeObserver ? 'supported' : 'build-only') : 'declared'
  const reason = beta
    ? `上游只有 beta（${upstream.loaderVersion}）`
    : !probed
      ? '构建工具链尚未通过真实编译探针'
      : runtimeObserver ? undefined : '该目标没有可用的 Observer 运行时，仅能构建与静态校验'
  const remediation = beta
    ? '可以构建，但发布前请自行评估；或改用同一位次的其他加载器'
    : probed ? undefined : '运行 pnpm run probe:target 升级证据；未验证前不要对外声称支持'

  return {
    key, loader, minecraft: mc, status,
    release: {
      loader, minecraft: mc,
      loaderVersion: upstream.loaderVersion,
      channel: upstream.channel,
      mappings: upstream.mappings,
      apiVersion: upstream.apiVersion ?? null,
      build: hypothesis,
      ...(upstream.note ? { note: upstream.note } : {}),
      javaTarget: javaTarget ?? 21,
      recommended: upstream.recommended,
      sources: upstream.sources ?? [ENDPOINTS.manifest],
      fetchedAt: generatedAt,
      evidence
    },
    ...(reason ? { reason } : {}),
    ...(remediation ? { remediation } : {}),
    runtimeObserver,
    ...(probed ? { probedAt: previousCell.probedAt } : {})
  }
}

function writeCatalog(catalog) {
  const json = `${JSON.stringify(catalog, null, 2)}\n`
  writeFileSync(CATALOG_PATH, json, 'utf8')
  writeFileSync(GENERATED_PATH, [
    '// Generated by scripts/versions-sync.mjs. Do not edit by hand.',
    '// Regenerate with: pnpm run versions:sync',
    "import type { VersionCatalog } from './schema.ts'",
    '',
    `export const VERSION_CATALOG: VersionCatalog = ${JSON.stringify(catalog, null, 2)}`,
    ''
  ].join('\n'), 'utf8')
}

function validateLocal(catalog) {
  const problems = []
  if (catalog.schemaVersion !== 1) problems.push('schemaVersion 必须是 1')
  if (!Array.isArray(catalog.order) || !catalog.order.length) problems.push('order 为空')
  const rank = new Map(catalog.order.map((id, index) => [id, index]))
  for (const mc of catalog.milestones) if (!rank.has(mc)) problems.push(`milestones 里的 ${mc} 不在 order 中`)
  for (const loader of LOADERS) {
    for (const mc of catalog.milestones) {
      if (!catalog.cells.some((cell) => cell.key === `${loader}@${mc}`)) problems.push(`缺少单元格 ${loader}@${mc}`)
    }
  }
  for (const cell of catalog.cells) {
    if (cell.status !== 'supported' && !cell.reason) problems.push(`${cell.key} 缺少 reason`)
    if (cell.release?.evidence === 'probed' && !cell.probedAt) problems.push(`${cell.key} 标了 probed 却没有 probedAt`)
  }
  return problems
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const previous = readPrevious()
  if (args.has('--offline')) {
    if (!previous) { note('没有已签入的 catalog.json，无法离线校验'); process.exit(1) }
    const problems = validateLocal(previous)
    for (const problem of problems) note(`  ! ${problem}`)
    note(problems.length ? `离线校验失败：${problems.length} 个问题` : `离线校验通过：${previous.cells.length} 个单元格，${previous.milestones.length} 个里程碑`)
    process.exit(problems.length ? 1 : 0)
  }

  const milestones = previous?.milestones?.length ? previous.milestones : DEFAULT_MILESTONES
  if (args.has('--check')) {
    const manifest = await fetchJson(ENDPOINTS.manifest)
    const newest = manifest.versions.find((entry) => entry.type === 'release')?.id
    const known = previous?.order?.[0]
    note(`Mojang 最新正式版 ${newest}；catalog 最新 ${known}`)
    if (!newest || !known) { note('缺少可比较的版本'); process.exit(1) }
    const problems = validateLocal(previous)
    for (const problem of problems) note(`  ! ${problem}`)
    if (newest !== known) { note(`需要重新同步：上游已发布 ${newest}`); process.exit(1) }
    process.exit(problems.length ? 1 : 0)
  }

  note(`同步 ${milestones.length} 个里程碑 × ${LOADERS.length} 个加载器…`)
  const upstream = await collectUpstream(milestones)
  const generatedAt = new Date().toISOString()
  const cells = []
  for (const mc of milestones) {
    const row = upstream.perMinecraft.get(mc)
    for (const loader of LOADERS) {
      cells.push(buildCell({ loader, mc, row, javaTarget: upstream.javaTargets.get(mc), tools: upstream.tools, previous, generatedAt, coverage: upstream.coverage }))
    }
  }

  const catalog = {
    schemaVersion: 1,
    generatedAt,
    order: upstream.order,
    releases: upstream.order.map((id) => ({
      id,
      releaseTime: upstream.releaseTime.get(id),
      javaTarget: upstream.javaTargets.get(id) ?? 21,
      type: 'release'
    })),
    milestones,
    cells,
    tools: {
      gradle: [GRADLE_HYPOTHESIS],
      ...(upstream.tools.loom ? { loom: upstream.tools.loom } : {}),
      ...(upstream.tools.moddevGradle ? { mdg: upstream.tools.moddevGradle } : {}),
      ...(upstream.tools.forgeGradle ? { fg: upstream.tools.forgeGradle } : {})
    },
    sync: { stale: failures.length > 0, failures }
  }

  const problems = validateLocal(catalog)
  if (problems.length) {
    for (const problem of problems) note(`  ! ${problem}`)
    note('生成的 catalog 未通过本地校验，已放弃写入')
    process.exit(1)
  }
  writeCatalog(catalog)

  note('')
  note('MC        Fabric            NeoForge           Forge')
  for (const mc of milestones) {
    const row = LOADERS.map((loader) => {
      const cell = cells.find((value) => value.key === `${loader}@${mc}`)
      const version = cell.release?.loaderVersion ?? '—'
      return `${version.padEnd(18)}`
    })
    note(`${mc.padEnd(9)} ${row.join('')}`)
  }
  note('')
  for (const failure of failures) note(`  ! ${failure.endpoint}: ${failure.reason}`)
  note(`写入 ${path.relative(ROOT, CATALOG_PATH)} 与 catalog.generated.ts（${cells.length} 格，${failures.length} 个端点失败）`)
}

main().catch((cause) => { note(`同步失败：${cause.message}`); process.exit(1) })
