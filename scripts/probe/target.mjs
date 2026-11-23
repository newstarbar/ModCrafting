#!/usr/bin/env node
/**
 * P3 probe: prove, or refute, that one target can really build.
 *
 * This is the gate the multi-version work needs. A cell only stops being
 * "declared" when a real Gradle build succeeded for that exact version tuple, so
 * the probe records the tuple it used — a proof with no toolchain attached is not
 * a proof.
 *
 *   node --experimental-strip-types scripts/probe/target.mjs --target fabric@1.21.4
 *   node --experimental-strip-types scripts/probe/target.mjs --target fabric@1.20.1 --record
 *
 * Exit codes: 0 proven, 1 build failed, 2 blocked (missing prerequisite).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTarget } from '../../packages/modcrafting-core/src/version/targets.ts'
import { capabilitiesFor } from '../../packages/modcrafting-core/src/version/capabilities.ts'
import { materializeProject, materializeVersions } from '../../packages/modcrafting-core/src/node.ts'
import { generateContent } from '../../packages/modcrafting-core/src/content-codegen.ts'
import { newContentObject } from '../../packages/modcrafting-core/src/content-model.ts'
import { generateGui } from '../../packages/modcrafting-core/src/gui-codegen.ts'
import { newGuiLayout } from '../../packages/modcrafting-core/src/gui-model.ts'
import { deriveResourceLayout } from '../../packages/modcrafting-core/src/resources/layout.ts'
import { getRegistry } from '../../packages/modcrafting-core/src/version/registry.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalogFile = path.join(root, 'packages/modcrafting-core/src/version/catalog.json')
const generatedFile = path.join(root, 'packages/modcrafting-core/src/version/catalog.generated.ts')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

const targetId = value('target', 'fabric@1.21.4')
const timeoutMs = Number(value('timeout', '1200000'))
const verbose = flag('verbose')

const emit = (code, payload) => {
  process.stdout.write(`${JSON.stringify({ code, ...payload })}\n`)
  process.exit(code === 'OK' ? 0 : code === 'BUILD_FAILED' ? 1 : 2)
}

const [loader, minecraft] = targetId.includes('@') ? targetId.split('@') : targetId.split('-')
if (!loader || !minecraft) emit('INVALID_TARGET', { target: targetId, message: '使用 fabric@1.21.4 形式' })

let target
try { target = resolveTarget(loader, minecraft) }
catch (error) { emit('TARGET_UNSUPPORTED', { target: targetId, message: error.message, remediation: error.remediation }) }

const versions = materializeVersions(target)

// The capability table decides what this plugin can attempt; the probe never
// carries its own opinion about which loaders are supported.
const capabilities = capabilitiesFor(target)
if (capabilities.createProject.state === 'blocked') {
  emit('JAVA_DIALECT_PENDING', { target: targetId, message: capabilities.createProject.reason, requirement: capabilities.createProject.requirement })
}

function jdkHomes() {
  const homes = [process.env.MODCRAFTING_JAVA_HOME, process.env.JAVA_HOME].filter(Boolean)
  for (const base of ['C:/Program Files/Java', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Microsoft', '/usr/lib/jvm', path.join(root, 'temp/jdks')]) {
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const home = path.join(base, name)
      if (existsSync(path.join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'))) homes.push(home)
    }
  }
  return [...new Set(homes)]
}

function jdkMajor(home) {
  const javac = path.join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')
  if (!existsSync(javac)) return undefined
  const result = spawnSync(javac, ['-version'], { encoding: 'utf8' })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = text.match(/javac (\d+)/)
  return match ? Number(match[1]) : undefined
}

const candidates = jdkHomes().map((home) => ({ home, major: jdkMajor(home) })).filter((entry) => entry.major)
// Prefer the exact major: 26.x needs 25, and a newer JDK cannot emulate it.
const chosen = candidates.find((entry) => entry.major === versions.javaMajor)
  ?? candidates.filter((entry) => entry.major > versions.javaMajor).sort((a, b) => a.major - b.major)[0]
if (!chosen) {
  emit('JDK_MISSING', {
    target: targetId, required: versions.javaMajor,
    available: candidates.map((entry) => `${entry.major}@${entry.home}`),
    message: `找不到 JDK ${versions.javaMajor}（或更高）。1.20.x 可用 17+，26.x 必须 25。`
  })
}

function reachable(url) {
  // fetch() resolves through undici, which on this host cannot reach some mavens that
  // node:https can (probed 2026-11-19). Use the transport that actually works.
  return new Promise((resolve) => {
    const request = https.get(url, { timeout: 8000 }, (response) => { response.destroy(); resolve((response.statusCode ?? 500) < 500) })
    request.on('error', () => resolve(false))
    request.on('timeout', () => { request.destroy(); resolve(false) })
  })
}
const maven = { fabric: 'https://maven.fabricmc.net/', neoforge: 'https://maven.neoforged.net/releases/', forge: 'https://maven.minecraftforge.net/' }[loader]
if (!(await reachable(maven))) emit('MAVEN_UNREACHABLE', { target: targetId, maven, message: `${loader} 的 maven 仓库不可达，构建无法进行（这不是代码问题）` })

// A fresh directory per run, never deleted: the sandbox delete shim times out on a
// built project tree, and Gradle's caches live in GRADLE_USER_HOME so rebuilds stay fast.
const work = path.join(root, 'temp/probe', `${targetId.replace('@', '-')}-${Date.now()}`)
mkdirSync(work, { recursive: true })

const project = await materializeProject({ projectPath: work, modId: 'probe_mod', modName: 'Probe Mod', target })

// --content compiles *generated content*, not just an empty scaffold: this is what
// actually proves the Java dialect per Minecraft version.
if (flag('content')) {
  const layout = deriveResourceLayout(minecraft, getRegistry())
  const mains = [], guiEntries = []
  for (const kind of ['item', 'block', 'food']) {
    // The capability table decides what may be generated; a neoforge probe stays scaffold-only.
    if (capabilities.content[kind]?.state !== 'available') { process.stderr.write('skip ' + kind + ': ' + capabilities.content[kind]?.reason); continue }
    // The capability table decides what may be generated; a neoforge probe stays scaffold-only.
    if (capabilities.content[kind]?.state !== 'available') { process.stderr.write('skip ' + kind + ': ' + capabilities.content[kind]?.reason); continue }
    const value = newContentObject(kind, 'probe_mod')
    value.id = `probe_mod:probe_${kind}`
    value.displayName = `Probe ${kind}`
    const output = generateContent(value, { layout })
    for (const file of output.files) {
      const destination = path.join(project.path, ...file.path.split('/'))
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, file.content, 'utf8')
    }
    mains.push(output.main)
  }
  if (flag('gui') && capabilities.gui.state === 'available') {
    const layout = newGuiLayout('probe_mod')
    const gui = generateGui(layout, false, minecraft)
    for (const file of gui.files) {
      const destination = path.join(project.path, ...file.path.split('/'))
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, file.content, 'utf8')
    }
    guiEntries.push(gui.client)
  }
  const metadataFile = path.join(project.path, 'src/main/resources/fabric.mod.json')
  const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'))
  metadata.entrypoints.main = [...(metadata.entrypoints.main ?? []), ...mains]
  if (guiEntries.length) metadata.entrypoints.client = [...(metadata.entrypoints.client ?? []), ...guiEntries]
  writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf8')
}

const gradleRoot = versions.gradle === '9.5.0' ? path.join(root, 'release/runtime/gradle-9.5') : path.join(root, 'temp/gradle-dist/gradle-' + versions.gradle)
const gradleBin = process.platform === 'win32' ? path.join(gradleRoot, 'bin/gradle.bat') : path.join(gradleRoot, 'bin/gradle')
if (!existsSync(gradleBin)) emit('GRADLE_MISSING', { target: targetId, message: `缺少本地 Gradle 发行版：${gradleBin}` })

// Gradle's user home is what actually grows: each new Minecraft version adds
// ~250-350MB of loom caches. Two rules here:
//  1. never inherit the ambient GRADLE_USER_HOME — on at least one machine it points
//     at a Gradle distribution's `jars` directory, so builds write caches into the
//     installation itself;
//  2. keep it inside the repo (gitignored) so a probe suite cannot fill a tight C:.
// Callers who really want a shared home can pass --gradle-home.
const gradleHome = value('gradle-home', '') || path.join(root, 'temp/gradle-home')
mkdirSync(gradleHome, { recursive: true })

const started = Date.now()
const gradleArgs = ['build', '--no-daemon', '--console=plain', '--stacktrace']
// Node 22 refuses to spawn a .bat directly (EINVAL); cmd.exe is the supported path on Windows.
const command = process.platform === 'win32' ? 'cmd.exe' : gradleBin
const commandArgs = process.platform === 'win32' ? ['/c', gradleBin, ...gradleArgs] : gradleArgs
const build = spawnSync(command, commandArgs, {
  cwd: project.path,
  encoding: 'utf8',
  timeout: timeoutMs,
  windowsHide: true,
  env: { ...process.env, JAVA_HOME: chosen.home, GRADLE_USER_HOME: gradleHome }
})
const durationMs = Date.now() - started
const log = `${build.stdout ?? ''}${build.stderr ?? ''}`
writeFileSync(path.join(work, 'probe-build.log'), log, 'utf8')

if (build.error || build.status !== 0) {
  const tail = log.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
  if (verbose) process.stderr.write(`${tail}\n`)
  emit('BUILD_FAILED', {
    target: targetId, durationMs, status: build.status ?? null,
    java: `${chosen.major}@${chosen.home}`, gradle: versions.gradle, loom: versions.loom,
    log: path.relative(root, path.join(work, 'probe-build.log')),
    message: build.error ? String(build.error) : tail
  })
}

const evidence = { ok: true, java: `${chosen.major}@${chosen.home}`, gradle: versions.gradle, loom: versions.loom, durationMs, at: new Date().toISOString() }
if (flag('record')) {
  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'))
  const cell = catalog.cells.find((entry) => entry.key === targetId)
  if (!cell) emit('CELL_MISSING', { target: targetId, message: 'catalog 里没有这个单元格' })
  // A compile probe proves buildability only. "supported" additionally requires a
  // real in-game test, which this probe never runs.
  cell.status = 'build-only'
  cell.release.evidence = 'probed'
  cell.release.build = { ...cell.release.build, evidence: 'probed', probedAt: evidence.at, javaMajor: chosen.major }
  cell.probedAt = evidence.at
  delete cell.reason
  cell.remediation = cell.runtimeObserver ? undefined : '已通过真实编译；游戏内测试仍需 Observer 运行时'
  if (cell.remediation === undefined) delete cell.remediation
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  writeFileSync(generatedFile, [
    '// Generated by scripts/versions-sync.mjs. Do not edit by hand.',
    '// Regenerate with: pnpm run versions:sync',
    "import type { VersionCatalog } from './schema.ts'",
    '',
    `export const VERSION_CATALOG: VersionCatalog = ${JSON.stringify(catalog, null, 2)}`,
    ''
  ].join('\n'), 'utf8')
}

emit('OK', { target: targetId, minecraft: versions.minecraft, loader: versions.loader, api: versions.api, mappings: versions.mappings, ...evidence, recorded: flag('record') })
