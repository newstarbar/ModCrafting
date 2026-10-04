import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { ProjectProfile } from '../shared/harness-runtime.ts'

export interface ProjectProfileOptions {
  symbolIndex?: ProjectProfile['symbolIndex']
}

const IGNORED_DIRS = new Set(['.git', '.gradle', 'build', 'run', 'release', 'runtime', 'node_modules', '.idea'])
const DEFAULT_TASKS = ['compileJava', 'compileClientJava', 'processResources', 'classes', 'build', 'runClient', 'runServer', 'runDatagen', 'test']

function readOptional(filePath: string): string {
  try { return readFileSync(filePath, 'utf8') } catch { return '' }
}

function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!\s][^=\s]*)\s*=\s*(.*?)\s*$/)
    if (match) result[match[1]] = match[2]
  }
  return result
}

function listFiles(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return []
  const result: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const absolute = path.join(root, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    try {
      if (entry.isSymbolicLink() || lstatSync(absolute).isSymbolicLink()) continue
      if (entry.isDirectory()) result.push(...listFiles(absolute, relative))
      else result.push(relative.replace(/\\/g, '/'))
    } catch { /* a disappearing file is not a profile blocker */ }
  }
  return result
}

function arrayValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => arrayValues(item))
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') return [(value as { value: string }).value]
  return []
}

function readFabricJson(root: string): { modId?: string; entrypoints: ProjectProfile['entrypoints']; mixinConfigs: string[]; accessWideners: string[]; warnings: string[] } {
  const warnings: string[] = []
  const entrypoints: ProjectProfile['entrypoints'] = { main: [], client: [], server: [] }
  const filePath = path.join(root, 'src', 'main', 'resources', 'fabric.mod.json')
  const text = readOptional(filePath)
  if (!text) return { entrypoints, mixinConfigs: [], accessWideners: [], warnings: ['missing src/main/resources/fabric.mod.json'] }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const rawEntrypoints = parsed.entrypoints && typeof parsed.entrypoints === 'object' ? parsed.entrypoints as Record<string, unknown> : {}
    for (const key of ['main', 'client', 'server'] as const) {
      entrypoints[key] = arrayValues(rawEntrypoints[key]).flatMap((item) => item)
    }
    const mixinConfigs = arrayValues(parsed.mixins).flatMap((item) => item)
    const accessWideners = arrayValues(parsed.accessWideners ?? parsed.access_wideners ?? parsed.accessWidener ?? parsed.access_widener).flatMap((item) => item)
    return { modId: typeof parsed.id === 'string' ? parsed.id : undefined, entrypoints, mixinConfigs, accessWideners, warnings }
  } catch (error) {
    warnings.push(`fabric.mod.json parse failed: ${error instanceof Error ? error.message : String(error)}`)
    return { entrypoints, mixinConfigs: [], accessWideners: [], warnings }
  }
}

function fileFingerprint(root: string, files: string[]): string {
  const hash = createHash('sha256')
  for (const relative of files.sort()) {
    const absolute = path.join(root, relative)
    try {
      hash.update(relative).update('\0').update(readFileSync(absolute)).update('\0')
    } catch { hash.update(relative).update('\0missing\0') }
  }
  return hash.digest('hex')
}

function detectTasks(buildText: string): string[] {
  const found = new Set(DEFAULT_TASKS)
  for (const match of buildText.matchAll(/(?:tasks\.(?:register|create)|registerTask)\s*\(?\s*['"]([^'"]+)['"]/gi)) found.add(match[1])
  return [...found]
}

function detectExistingImplementations(root: string, javaFiles: string[]): { registeredSymbols: string[]; eventHandlers: string[] } {
  const registered = new Set<string>()
  const handlers = new Set<string>()
  for (const relative of javaFiles) {
    const text = readOptional(path.join(root, relative))
    if (!text) continue
    for (const match of text.matchAll(/(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)/g)) registered.add(`${relative}:${match[1]}`)
    for (const match of text.matchAll(/(?:Registry\.register|register\s*\(|\b[A-Za-z]+Registry\s*\.)[^\n;]{0,180}/g)) registered.add(`${relative}:${match[0].trim()}`)
    for (const match of text.matchAll(/\b(?:[A-Za-z]+Events|[A-Za-z]+Callback|ClientTickEvents|ServerTickEvents|CommandRegistrationCallback)\b[^\n;]{0,180}/g)) handlers.add(`${relative}:${match[0].trim()}`)
  }
  return { registeredSymbols: [...registered].slice(0, 512), eventHandlers: [...handlers].slice(0, 256) }
}

export function inspectProjectProfile(projectPath: string, options: ProjectProfileOptions = {}): ProjectProfile {
  const root = path.resolve(projectPath)
  const gradleProperties = readOptional(path.join(root, 'gradle.properties'))
  const buildGradle = `${readOptional(path.join(root, 'build.gradle'))}\n${readOptional(path.join(root, 'build.gradle.kts'))}`
  const settingsGradle = `${readOptional(path.join(root, 'settings.gradle'))}\n${readOptional(path.join(root, 'settings.gradle.kts'))}`
  const props = parseProperties(gradleProperties)
  const fabric = readFabricJson(root)
  const allFiles = listFiles(root)
  const javaFiles = allFiles.filter((file) => /\.(java|kt)$/i.test(file) && /^(src\/(?:main|client|server)\/)/i.test(file))
  const resourceFiles = allFiles.filter((file) => file.startsWith('src/main/resources/'))
  const implementations = detectExistingImplementations(root, javaFiles)
  const sourceSets: Array<'main' | 'client' | 'server' | string> = ['main']
  if (/(?:sourceSets\s*\{[^}]*\bclient\b|src\/client\/java)/is.test(buildGradle) || allFiles.some((file) => file.startsWith('src/client/'))) sourceSets.push('client')
  if (/(?:sourceSets\s*\{[^}]*\bserver\b|src\/server\/java)/is.test(buildGradle) || allFiles.some((file) => file.startsWith('src/server/'))) sourceSets.push('server')
  const splitEnvironment = /splitEnvironmentSourceSets\s*\(/i.test(buildGradle)
  const dependencies = [...buildGradle.matchAll(/(?:implementation|modImplementation|modApi|api|compileOnly)\s*[ (]*["']([^"']+)["']/gi)].map((match) => match[1])
  const pluginMatch = buildGradle.match(/fabric-loom[^\n]*?version\s*["']([^"']+)["']/i) || buildGradle.match(/id\s*["']fabric-loom["']\s+version\s*["']([^"']+)["']/i)
  const warnings = [...fabric.warnings]
  if (!existsSync(path.join(root, 'gradlew.bat')) && !existsSync(path.join(root, 'gradlew'))) warnings.push('missing Gradle wrapper')
  if (!buildGradle.trim()) warnings.push('missing build.gradle or build.gradle.kts')
  const profileFiles = allFiles.filter((file) => /^(gradle\.properties|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|src\/main\/resources\/fabric\.mod\.json|src\/(?:main|client|server)\/)/i.test(file))
  const fingerprint = fileFingerprint(root, profileFiles)
  return {
    version: 1,
    projectPath: root,
    fingerprint,
    minecraftVersion: props.minecraft_version,
    yarnMappings: props.yarn_mappings,
    loaderVersion: props.loader_version,
    fabricApiVersion: props.fabric_version,
    loomVersion: pluginMatch?.[1],
    javaVersion: props.java_version || (buildGradle.match(/(?:sourceCompatibility|java\s*\{[^}]*languageVersion)[^\n]*?(?:JavaVersion\.VERSION_|of\s*\(\s*)(\d+)/i)?.[1]),
    modId: fabric.modId,
    entrypoints: fabric.entrypoints,
    mixinConfigs: fabric.mixinConfigs,
    accessWideners: fabric.accessWideners,
    sourceSets,
    splitEnvironment,
    dependencies: [...new Set(dependencies)],
    gradleTasks: detectTasks(`${buildGradle}\n${settingsGradle}`),
    javaFiles,
    resourceFiles,
    registeredSymbols: implementations.registeredSymbols,
    eventHandlers: implementations.eventHandlers,
    symbolIndex: options.symbolIndex || { available: false },
    warnings
  }
}
