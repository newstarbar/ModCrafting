import { createHash } from 'node:crypto'
import path from 'node:path'
import type { BuildReport, BuildReportOptions, Diagnostic, DiagnosticResponsibility, DiagnosticStage } from '../shared/harness-runtime.ts'
import { normalizeDiagnosticMessage, stableTextHash } from '../shared/harness-diagnostics.ts'

export type { BuildReportOptions } from '../shared/harness-runtime.ts'

const JAVA_ERROR_RE = /(?:^|\n)\s*(?:(?:e|error):\s*)?(?<file>(?:[A-Za-z]:[\\/])?[^\n:]+\.(?:java|kt)):(?<line>\d+)(?::(?<column>\d+))?:\s*(?:error|错误):\s*(?<message>[^\n]+)/gim
const GRADLE_ERROR_RE = /(?:^|\n)\s*>?\s*(?<file>[^\n:]+\.(?:java|kt)):(?<line>\d+):\s*(?<message>[^\n]+)/gim
const SYMBOL_RE = /(?:symbol|符号):\s*(?:(?:class|类|method|方法|variable|变量)\s+)?([^\n]+)/i
const MIXIN_RE = /(?:MixinApplyError|InvalidInjectionException|mixin target|注入目标|@Inject|@Redirect)/i
const DEPENDENCY_RE = /(?:could not resolve|无法解析|failed to resolve|依赖.*下载|class path|classpath|repositories|repository)/i
const CONFIG_RE = /(?:gradle\.properties|build\.gradle|settings\.gradle|fabric\.mod\.json|source.?set|splitEnvironment|配置)/i
const TOOLCHAIN_RE = /(?:jdk|java .*not found|gradle wrapper|构建环境|toolchain|java_home|无法启动 gradle)/i
const STARTUP_RE = /(?:error starting game|启动失败|failed to start|no main manifest|crash report|fabric loader)/i

function relativePath(projectPath: string, value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\\/g, '/')
  const absolute = path.isAbsolute(value) || /^[A-Za-z]:\//.test(normalized)
  const result = absolute ? path.relative(projectPath, value) : normalized
  const rel = result.replace(/\\/g, '/').replace(/^\.\//, '')
  return rel && !rel.startsWith('../') ? rel : normalized
}

function normalizeProblemReportOutput(value: string): string {
  if (!/<(?:html|body|table|tr|td|div|span)\b/i.test(value)) return value
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
}

function stageFor(task: string, message: string): DiagnosticStage {
  if (/runclient|runserver|run.?client/i.test(task) || STARTUP_RE.test(message)) return 'startup'
  if (/test|mc_run_test|game/i.test(task)) return 'game_test'
  if (MIXIN_RE.test(message)) return 'mixin'
  if (CONFIG_RE.test(message)) return 'configuration'
  if (DEPENDENCY_RE.test(message)) return 'dependency'
  if (/resource|json|processResources|accesswidener/i.test(message)) return 'resource'
  if (/compile|cannot find symbol|找不到符号|error:|错误:/i.test(message)) return 'java_compile'
  if (TOOLCHAIN_RE.test(message)) return 'toolchain'
  return 'unknown'
}

function responsibilityFor(stage: DiagnosticStage, message: string, baseline: boolean): DiagnosticResponsibility {
  if (baseline) return 'baseline'
  if (stage === 'toolchain') return 'environment'
  if (stage === 'game_test' || stage === 'startup') return 'environment'
  if (stage === 'configuration' || stage === 'dependency') return 'project'
  if (stage === 'mixin' || stage === 'java_compile' || stage === 'resource') return 'generated_code'
  if (/observer|bridge|world|navigation|能力|环境/i.test(message)) return 'environment'
  return 'unknown'
}

function diagnosticId(stage: DiagnosticStage, file: string | undefined, line: number | undefined, message: string): string {
  return stableTextHash(`${stage}|${file || ''}|${line || ''}|${normalizeDiagnosticMessage(message)}`)
}

function rootCauseId(stage: DiagnosticStage, message: string, symbol?: string, file?: string): string {
  const normalized = normalizeDiagnosticMessage(symbol || message)
  // A bare "cannot find symbol" line is followed by the concrete symbol in
  // javac's next lines.  The parser may not always receive that continuation,
  // so keep the source file in the root key instead of merging every missing
  // symbol in the project into one diagnostic cluster.
  const locationHint = !symbol && /cannot find symbol|找不到符号/i.test(message) ? file || '' : ''
  return stableTextHash(`${stage}|${normalized}|${locationHint}`)
}

function makeDiagnostic(options: BuildReportOptions, file: string | undefined, line: number | undefined, column: number | undefined, message: string, raw: string): Diagnostic {
  const normalizedFile = relativePath(options.projectPath, file)
  const symbol = message.match(SYMBOL_RE)?.[1]?.trim()
  const stage = stageFor(options.task, `${message}\n${raw}`)
  const normalizedMessage = normalizeDiagnosticMessage(message)
  const id = diagnosticId(stage, normalizedFile, line, message)
  return {
    id,
    stage,
    responsibility: responsibilityFor(stage, `${message}\n${raw}`, options.baseline === true),
    message: message.trim(),
    normalizedMessage,
    raw: raw.trim(),
    ...(normalizedFile ? { file: normalizedFile } : {}),
    ...(line != null ? { line } : {}),
    ...(column != null ? { column } : {}),
    ...(symbol ? { symbol } : {}),
    rootCauseId: rootCauseId(stage, message, symbol, normalizedFile)
  }
}

function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const byId = new Map<string, Diagnostic>()
  for (const item of items) {
    const existing = byId.get(item.id)
    if (!existing || item.raw.length > existing.raw.length) byId.set(item.id, item)
  }
  // Javac often repeats the same missing import/symbol at every use site. Keep
  // one actionable diagnostic and retain the other locations as related files
  // instead of making the model chase a dozen equivalent errors.
  const byRoot = new Map<string, Diagnostic>()
  for (const item of byId.values()) {
    const root = item.rootCauseId || item.id
    const existing = byRoot.get(root)
    if (!existing) {
      byRoot.set(root, { ...item, relatedFiles: item.file ? [item.file] : undefined })
      continue
    }
    const related = new Set([...(existing.relatedFiles || []), ...(item.file ? [item.file] : [])])
    existing.relatedFiles = [...related].slice(0, 16)
    if (item.raw.length > existing.raw.length) existing.raw = item.raw
  }
  return [...byRoot.values()].map((item) => ({
    ...item,
    ...(item.relatedFiles && item.relatedFiles.length > 1 ? { relatedFiles: item.relatedFiles } : { relatedFiles: undefined })
  })).slice(0, 200)
}

export function parseBuildDiagnostics(options: BuildReportOptions): Diagnostic[] {
  const output = normalizeProblemReportOutput(options.output || '')
  const diagnostics: Diagnostic[] = []
  let match: RegExpExecArray | null
  JAVA_ERROR_RE.lastIndex = 0
  while ((match = JAVA_ERROR_RE.exec(output)) !== null) {
    diagnostics.push(makeDiagnostic(options, match.groups?.file, Number(match.groups?.line), match.groups?.column ? Number(match.groups.column) : undefined, match.groups?.message || match[0], match[0]))
  }
  GRADLE_ERROR_RE.lastIndex = 0
  while ((match = GRADLE_ERROR_RE.exec(output)) !== null) {
    const message = match.groups?.message || match[0]
    if (!/(?:error|错误|cannot find symbol|找不到符号|exception|failed|失败|mixin|注入)/i.test(message)) continue
    diagnostics.push(makeDiagnostic(options, match.groups?.file, Number(match.groups?.line), undefined, message, match[0]))
  }

  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (MIXIN_RE.test(trimmed) || DEPENDENCY_RE.test(trimmed) || CONFIG_RE.test(trimmed) || TOOLCHAIN_RE.test(trimmed) || STARTUP_RE.test(trimmed)) {
      const hasLocation = diagnostics.some((item) => item.raw.includes(trimmed) || item.message.includes(trimmed))
      if (!hasLocation && /(?:failed|失败|error|错误|exception|无法|not found|不存在)/i.test(trimmed)) diagnostics.push(makeDiagnostic(options, undefined, undefined, undefined, trimmed, trimmed))
    }
  }

  if (diagnostics.length === 0 && options.exitCode !== 0) {
    const fallback = output.trim().split(/\r?\n/).filter((line) => /(?:failed|失败|error|错误|exception|caused by|无法|not found)/i.test(line)).slice(-12)
    for (const line of fallback) diagnostics.push(makeDiagnostic(options, undefined, undefined, undefined, line.trim(), line))
  }
  return dedupeDiagnostics(diagnostics)
}

export function createBuildReport(options: BuildReportOptions): BuildReport {
  const diagnostics = parseBuildDiagnostics(options)
  const output = options.output || ''
  const failed = options.cancelled === true || options.exitCode !== 0 || /BUILD FAILED|构建失败/i.test(output)
  const stage = diagnostics[0]?.stage || stageFor(options.task, output)
  const responsibility = options.cancelled ? 'environment' : diagnostics[0]?.responsibility || responsibilityFor(stage, output, options.baseline === true)
  const outputFingerprint = createHash('sha256').update(output).digest('hex')
  return {
    version: 1,
    task: options.task,
    projectPath: options.projectPath,
    ok: !failed,
    exitCode: options.exitCode,
    stage,
    responsibility,
    diagnostics,
    output,
    outputFingerprint,
    ...(options.usedOnlineFallback != null ? { usedOnlineFallback: options.usedOnlineFallback } : {}),
    ...(options.cancelled != null ? { cancelled: options.cancelled } : {}),
    generatedAt: Date.now(),
    ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {})
  }
}
