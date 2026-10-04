/**
 * Fast semantic compile using the bundled JDK 21 javac + Loom/Fabric jar classpath.
 *
 * Goal: catch Java type/method/import errors in 2-8 seconds WITHOUT spinning up Gradle.
 *
 * Pipeline:
 *   1. Resolve the bundled gradle-home-seed and walk Loom minecraftMaven + modules-2 for jars.
 *   2. Collect every .java file under src/{main,client,server}/java in the project (shadow).
 *   3. Spawn javac with --release 21 -proc:none and the assembled classpath.
 *   4. Parse javac's `file:line: error: msg` output, classify each diagnostic as
 *      "hard" (real error) vs "soft" (AW-widened, split-env cross-side, etc.) so the
 *      existing repair loop knows what to actually chase.
 *
 * Constraints:
 *   - No new npm dependency. Everything is already on disk under resources/gradle-home-seed.
 *   - We deliberately disable annotation processing (-proc:none). Loom's Mixin AP is slow,
 *     noisy, and its real failures (target does not exist) are caught better by the
 *     dedicated mixin-precheck module than by javac-after-AP.
 *   - We do NOT modify the shadow workspace: -d points to a temp dir.
 *   - On any missing dependency (third-party mod, self-built lib not in seed), we mark
 *     the run `degraded` so the harness can fall back to the slower Gradle validation
 *     gate instead of mis-attributing the gap.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveBundledGradleHomeSeedPath } from './build-env.ts'
import { loadAccessWidenerEntries } from './access-widener.ts'
import { applyVerdict } from './compile-verdict.ts'
import { createBuildReport } from './build-report.ts'
import { runMixinPrecheck } from './mixin-precheck.ts'
import { readFileSync } from 'node:fs'
import type { BuildReport, ProjectProfile } from '../shared/harness-runtime.ts'

/** Local YARN-named Minecraft jars. Intermediary variants are intentionally excluded
 *  because they carry obfuscated descriptors that javac-without-mappings can't resolve. */
const LOOM_NAMED_JAR_GLOBS = [
  'caches/fabric-loom/minecraftMaven/net/minecraft/minecraft-common-*.jar',
  'caches/fabric-loom/minecraftMaven/net/minecraft/minecraft-clientonly-*.jar'
]

/** Module group roots that contain runtime jars we want on the classpath. */
const MODULE_GROUP_DIRS = [
  'caches/modules-2/files-2.1/net.fabricmc.fabric-api',
  'caches/modules-2/files-2.1/io.github.llamalad7',     // mixin (Fabric fork)
  'caches/modules-2/files-2.1/net.fabricmc',
  'caches/modules-2/files-2.1/com.mojang',
  'caches/modules-2/files-2.1/com.google.guava',
  'caches/modules-2/files-2.1/com.google.code.gson',
  'caches/modules-2/files-2.1/com.google.errorprone',
  'caches/modules-2/files-2.1/io.netty',
  'caches/modules-2/files-2.1/org.slf4j',
  'caches/modules-2/files-2.1/org.apache.logging.log4j',
  'caches/modules-2/files-2.1/org.apache.commons',
  'caches/modules-2/files-2.1/org.jetbrains',
  'caches/modules-2/files-2.1/org.lwjgl',
  'caches/modules-2/files-2.1/org.joml',
  'caches/modules-2/files-2.1/it.unimi.dsi',
  'caches/modules-2/files-2.1/org.cadixdev',
  'caches/modules-2/files-2.1/org.ow2.asm'
]

/** Module groups that should NEVER go on a fast-compile classpath: build-time only. */
const EXCLUDED_GROUP_HINTS = [
  'gradle-',                // gradle internal classes
  'fabric-loom',             // build plugin code
  'com.fasterxml.jackson',  // used by gradle internals; bloats classpath
  'org.springframework',     // gradle dependency, not runtime
  'org.sonatype.oss',        // build-only
  'org.mockito',             // test scope
  'org.junit',               // test scope
  'org.jetbrains.kotlin',   // kotlin stdlib (project might not use kotlin)
  'jakarta.platform',
  'commons-codec',
  'commons-io',
  'commons-logging'
]

export interface FastCompileResult {
  ok: boolean
  exitCode: number
  output: string
  durationMs: number
  /** True when we couldn't assemble a complete classpath (third-party mod dep, etc.).
   *  Harness should fall back to a full Gradle validation gate in that case. */
  degraded: boolean
  /** True if we couldn't even find a JDK or seed; caller should fall back to Gradle. */
  unavailable: boolean
  /** Resolved classpath entries (for diagnostics / debugging). */
  classpathEntries: number
  /** Source files passed to javac. */
  sourceFiles: number
}

export interface FastCompileOptions {
  /** Root of the project to compile (typically the shadow workspace path). */
  projectPath: string
  /** Absolute path to a JDK 21 root (containing bin/javac). */
  jdkPath: string
  /** AbortSignal from the harness so a stopped task tears down javac promptly. */
  abortSignal?: AbortSignal
  /** Hard wall-clock cap, in ms. Default 60s — if we exceed this, fall back. */
  timeoutMs?: number
  /** Project profile for tiered-verdict classification (splitEnvironment, etc.). */
  projectProfile?: ProjectProfile
  /** Inject a custom fabric-symbol lookup (defaults to fabric-metadata's lookupFabricSymbol). */
  symbolLookup?: (req: { className: string; memberName?: string; descriptor?: string; memberKind?: 'method' | 'field' | 'any' }) => { ok: boolean; class?: { name: string; methods: Array<{ name: string; descriptor: string }>; fields: Array<{ name: string }> }; methods: Array<{ name: string; descriptor: string }>; fields: Array<{ name: string }> } | null
}

interface ClasspathAssembly {
  jars: string[]
  /** Modules in the project's `dependencies` block that we couldn't locate on disk. */
  missingModules: string[]
}

const cachedClasspathByFingerprint = new Map<string, { jars: string[]; missingModules: string[] }>()

/** Public: assemble the javac classpath from the bundled seed. */
export function assembleFastCompileClasspath(seedPath: string, projectPath: string): ClasspathAssembly {
  // Project fingerprint varies by source files; here we just key by seed path + project fingerprint.
  const fingerprint = `${seedPath}|${statSync(projectPath).mtimeMs}`
  const cached = cachedClasspathByFingerprint.get(fingerprint)
  if (cached) return { jars: cached.jars, missingModules: cached.missingModules }

  const jars: string[] = []
  const missing: string[] = []

  // 1. Loom-named Minecraft jars (the user-facing Yarn-named code).
  for (const glob of LOOM_NAMED_JAR_GLOBS) {
    jars.push(...collectJarsMatching(seedPath, glob))
  }

  // 2. Runtime modules we always want (groups listed in MODULE_GROUP_DIRS).
  for (const groupRel of MODULE_GROUP_DIRS) {
    const groupRoot = path.join(seedPath, groupRel)
    if (!existsSync(groupRoot)) continue
    jars.push(...walkAllJars(groupRoot))
  }

  // 3. Project's declared dependencies — anything in modules-2 that we haven't covered
  //    above, so third-party Fabric mods added by the user still compile. We pull every
  //    .jar whose path isn't in the excluded list.
  const modulesRoot = path.join(seedPath, 'caches', 'modules-2', 'files-2.1')
  if (existsSync(modulesRoot)) {
    for (const group of safeReaddir(modulesRoot)) {
      const groupRel = group.replace(/\\/g, '/')
      if (EXCLUDED_GROUP_HINTS.some((hint) => groupRel.toLowerCase().includes(hint))) continue
      if (MODULE_GROUP_DIRS.some((hint) => groupRel.includes(hint))) continue
      const groupAbs = path.join(modulesRoot, group)
      jars.push(...walkAllJars(groupAbs))
    }
  }

  // 4. Surface any project-declared modules we couldn't find — best-effort parse of
  //    build.gradle (matches the same regex family as project-profile.ts:115).
  const declaredDeps = readProjectDependencies(projectPath)
  for (const dep of declaredDeps) {
    const found = jars.some((jar) => jar.toLowerCase().includes(`/${dep.toLowerCase()}`))
    if (!found) missing.push(dep)
  }

  // Deduplicate (preserve order).
  const seen = new Set<string>()
  const dedup: string[] = []
  for (const jar of jars) {
    if (seen.has(jar)) continue
    seen.add(jar)
    dedup.push(jar)
  }

  cachedClasspathByFingerprint.set(fingerprint, { jars: dedup, missingModules: missing })
  return { jars: dedup, missingModules: missing }
}

/** Collect every .java file in src/{main,client,server}/java. */
export function collectJavaSources(projectPath: string): string[] {
  const roots = ['src/main/java', 'src/client/java', 'src/server/java']
  const found: string[] = []
  for (const rel of roots) {
    const abs = path.join(projectPath, rel)
    if (!existsSync(abs)) continue
    walkJava(abs, found)
  }
  return found
}

/** Run javac and stream output to a buffer; returns exit code, output, and degraded flag. */
export async function runFastCompile(options: FastCompileOptions): Promise<FastCompileResult> {
  const seedPath = resolveBundledGradleHomeSeedPath()
  if (!seedPath) {
    return {
      ok: false, exitCode: -1, output: 'gradle-home-seed not ready; cannot assemble fast classpath',
      durationMs: 0, degraded: true, unavailable: true, classpathEntries: 0, sourceFiles: 0
    }
  }
  const javacBin = path.join(options.jdkPath, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')
  if (!existsSync(javacBin)) {
    return {
      ok: false, exitCode: -1, output: `javac not found at ${javacBin}`,
      durationMs: 0, degraded: true, unavailable: true, classpathEntries: 0, sourceFiles: 0
    }
  }

  const startedAt = Date.now()
  const sources = collectJavaSources(options.projectPath)
  if (sources.length === 0) {
    return {
      ok: true, exitCode: 0, output: '(no Java sources to compile)',
      durationMs: Date.now() - startedAt, degraded: false, unavailable: false,
      classpathEntries: 0, sourceFiles: 0
    }
  }

  const assembly = assembleFastCompileClasspath(seedPath, options.projectPath)
  const outDir = mkdtempSync(path.join(tmpdir(), 'modcrafting-fastc-'))
  const timeoutMs = options.timeoutMs ?? 60_000

    const args = [
      '--release', '21',
      '-nowarn',
      '-proc:none',
      '-implicit:none',
      '-Xmaxerrs', '200',
      '-d', outDir,
      '-classpath', assembly.jars.join(path.delimiter)
    ]
    args.push(...sources)

  return await new Promise<FastCompileResult>((resolve) => {
    const child = spawn(javacBin, args, { windowsHide: true })
    let output = ''
    let settled = false
    const finish = (result: FastCompileResult): void => {
      if (settled) return
      settled = true
      try { rmSync(outDir, { recursive: true, force: true }) } catch { /* ignore */ }
      resolve(result)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({
        ok: false, exitCode: -1, output: output + '\n[fast-compile: timeout]',
        durationMs: Date.now() - startedAt, degraded: true, unavailable: false,
        classpathEntries: assembly.jars.length, sourceFiles: sources.length
      })
    }, timeoutMs)

    const onAbort = (): void => {
      try { child.kill() } catch { /* ignore */ }
      finish({
        ok: false, exitCode: -1, output: output + '\n[fast-compile: cancelled]',
        durationMs: Date.now() - startedAt, degraded: true, unavailable: false,
        classpathEntries: assembly.jars.length, sourceFiles: sources.length,
      })
    }
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })

    const collect = (chunk: Buffer): void => {
      const text = chunk.toString()
      output += text
      // Trim runaway output: 256KB is plenty for real javac errors.
      if (output.length > 256 * 1024) output = output.slice(-256 * 1024)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({
        ok: false, exitCode: -1, output: output + `\n[fast-compile spawn error] ${String(err)}`,
        durationMs: Date.now() - startedAt, degraded: true, unavailable: false,
        classpathEntries: assembly.jars.length, sourceFiles: sources.length
      })
    })
    const onClose = (code: number | null): void => {
      clearTimeout(timer)
      options.abortSignal?.removeEventListener('abort', onAbort)
      const ok = code === 0
      finish({
        ok, exitCode: code ?? -1, output,
        durationMs: Date.now() - startedAt,
        degraded: !ok && assembly.missingModules.length > 0,
        unavailable: false,
        classpathEntries: assembly.jars.length, sourceFiles: sources.length
      })
    }
    child.on('close', onClose)
  })
}

/**
 * Run fast-compile + parse + verdict → return a BuildReport ready for the harness.
 *
 * Pass-through semantics:
 *   - On success: a BuildReport marked ok=true, no degraded flag. The renderer can
 *     accept the unit as compiled and skip the Gradle validation build.
 *   - On degraded (missing module deps): ok=false AND degraded=true. The harness
 *     should fall back to the full Gradle validation gate.
 *   - On hard errors: ok=false, only severity=hard diagnostics survive, soft ones
 *     are still in the list but the BuildReport's overall verdict reflects hard
 *     errors only.
 */
export async function runFastCompileReport(options: FastCompileOptions & { projectProfile: ProjectProfile }): Promise<BuildReport & { fast: { durationMs: number; classpathEntries: number; sourceFiles: number; degraded: boolean } }> {
  const result = await runFastCompile(options)
  // First pass: parse with the existing pipeline. We use a synthetic task name so
  // stageFor() / responsibilityFor() classify as java_compile + generated_code.
  const report = createBuildReport({
    projectPath: options.projectPath,
    task: 'fast_compile_javac',
    output: result.output,
    exitCode: result.exitCode,
    cancelled: result.output.includes('[fast-compile: cancelled]') || undefined
  })

  // Second pass: re-classify diagnostics with AW + profile context.
  const awEntries = loadAccessWidenerEntries(options.projectPath)
  const withSeverity = applyVerdict(report.diagnostics, awEntries, options.projectProfile)

  // Third pass: mixin precheck. Read sources/mixin configs we just compiled.
  const sources: Array<{ path: string; content: string }> = []
  const mixinConfigs: Array<{ path: string; content: string }> = []
  for (const file of collectJavaSources(options.projectPath)) {
    try { sources.push({ path: file, content: readFileSync(file, 'utf8') }) } catch { /* ignore */ }
  }
  for (const file of collectMixinConfigs(options.projectPath)) {
    try { mixinConfigs.push({ path: file, content: readFileSync(file, 'utf8') }) } catch { /* ignore */ }
  }
  const mixinResult = runMixinPrecheck({
    projectPath: options.projectPath,
    sources, mixinConfigs,
    projectProfile: options.projectProfile,
    awEntries,
    ...(options.symbolLookup ? { symbolLookup: options.symbolLookup as any } : {})
  })

  const allDiagnostics = [...withSeverity, ...mixinResult.diagnostics]
  const hardCount = allDiagnostics.filter((d) => d.severity !== 'soft').length
  const ok = result.ok && hardCount === 0
  const degraded = result.degraded || result.unavailable
  return {
    ...report,
    ok,
    diagnostics: allDiagnostics,
    degraded,
    fast: {
      durationMs: result.durationMs,
      classpathEntries: result.classpathEntries,
      sourceFiles: result.sourceFiles,
      degraded,
      mixinFiles: mixinResult.perFile.length,
      awIssues: mixinResult.awIssues.length
    }
  }
}

function collectMixinConfigs(projectPath: string): string[] {
  const out: string[] = []
  const candidates = [
    'src/main/resources',
    'src/client/resources',
    'src/main',
    'src/client'
  ]
  for (const rel of candidates) {
    const abs = path.join(projectPath, rel)
    if (!existsSync(abs)) continue
    walkMixinConfigs(abs, out)
  }
  return out
}

function walkMixinConfigs(dir: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { walkMixinConfigs(full, out); continue }
    if (entry.isFile() && /\.mixins?\.json$/i.test(entry.name)) out.push(full)
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function walkJava(dir: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { walkJava(full, out); continue }
    if (entry.isFile() && entry.name.endsWith('.java')) out.push(full)
  }
}

function walkAllJars(dir: string): string[] {
  const out: string[] = []
  let entries: ReturnType<typeof readdirSync>
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { out.push(...walkAllJars(full)); continue }
    if (entry.isFile() && entry.name.endsWith('.jar') && !entry.name.endsWith('-sources.jar') && !entry.name.endsWith('-javadoc.jar')) {
      out.push(full)
    }
  }
  return out
}

function collectJarsMatching(seedPath: string, globRel: string): string[] {
  const parts = globRel.split('/')
  const tail = parts.pop() || ''
  const dir = path.join(seedPath, ...parts)
  if (!existsSync(dir)) return []
  const wildcard = new RegExp('^' + tail.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  const out: string[] = []
  for (const entry of safeReaddir(dir)) {
    if (entry.endsWith('-sources.jar') || entry.endsWith('-javadoc.jar')) continue
    if (!wildcard.test(entry)) continue
    if (!entry.endsWith('.jar')) continue
    // Skip intermediary jars: their descriptors are obfuscated.
    if (entry.includes('-intermediary-')) continue
    out.push(path.join(dir, entry))
  }
  return out
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

/** Best-effort dependency parse — same regex family as project-profile.ts:115. */
function readProjectDependencies(projectPath: string): string[] {
  const out: string[] = []
  const candidates = ['build.gradle', 'build.gradle.kts']
  for (const name of candidates) {
    const file = path.join(projectPath, name)
    if (!existsSync(file)) continue
    try {
      const text = require('node:fs').readFileSync(file, 'utf8') as string
      const re = /(?:implementation|modImplementation|modApi|api|compileOnly)\s*[ (]*["']([^"']+)["']/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) out.push(m[1])
    } catch { /* ignore */ }
  }
  return out
}

/** For tests: clear the cache between assertions. */
export function _resetFastCompileCache(): void { cachedClasspathByFingerprint.clear() }