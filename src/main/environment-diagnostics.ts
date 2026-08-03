import { app, shell } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getRuntimeLayout } from './runtime-layout'

export interface EnvironmentError {
  id: string
  code: string
  phase: string
  message: string
  technicalMessage: string
  retryable: boolean
  source?: string
  occurredAt: string
}

const MAX_LOG_BYTES = 1_000_000
let lastEnvironmentError: EnvironmentError | null = null

function redact(value: string): string {
  return value
    .replace(/(api[_-]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(new RegExp(process.env.USERPROFILE?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '__never__', 'gi'), '%USERPROFILE%')
}

export function writeDiagnostic(scope: string, value: unknown): void {
  try {
    const { logRoot } = getRuntimeLayout()
    fs.mkdirSync(logRoot, { recursive: true })
    const target = path.join(logRoot, 'environment.log')
    if (fs.existsSync(target) && fs.statSync(target).size > MAX_LOG_BYTES) {
      fs.renameSync(target, path.join(logRoot, 'environment.previous.log'))
    }
    const line = `[${new Date().toISOString()}] ${scope}: ${redact(typeof value === 'string' ? value : JSON.stringify(value))}${os.EOL}`
    fs.appendFileSync(target, line, 'utf8')
  } catch {
    // Diagnostics must never turn a recoverable initialization error into a crash.
  }
}

export function recordEnvironmentError(
  phase: string,
  error: unknown,
  options: Partial<Pick<EnvironmentError, 'code' | 'message' | 'retryable' | 'source'>> = {}
): EnvironmentError {
  const technicalMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const item: EnvironmentError = {
    id: `env-${Date.now().toString(36)}`,
    code: options.code || 'ENVIRONMENT_INITIALIZATION_FAILED',
    phase,
    message: options.message || '环境准备失败，请查看详细信息后重试。',
    technicalMessage,
    retryable: options.retryable ?? true,
    source: options.source,
    occurredAt: new Date().toISOString()
  }
  lastEnvironmentError = item
  writeDiagnostic('environment-error', item)
  return item
}

export function getLastEnvironmentError(): EnvironmentError | null {
  return lastEnvironmentError
}

export function openEnvironmentLogs(): { success: boolean; path: string } {
  const { logRoot } = getRuntimeLayout()
  fs.mkdirSync(logRoot, { recursive: true })
  shell.openPath(logRoot)
  return { success: true, path: logRoot }
}

export function exportEnvironmentDiagnostics(): { success: boolean; path?: string; error?: string } {
  try {
    const { logRoot, runtimeRoot } = getRuntimeLayout()
    fs.mkdirSync(logRoot, { recursive: true })
    const target = path.join(app.getPath('downloads'), `ModCrafting-diagnostics-${Date.now()}.json`)
    fs.writeFileSync(target, JSON.stringify({
      generatedAt: new Date().toISOString(),
      runtimeRoot: redact(runtimeRoot),
      lastEnvironmentError,
      log: fs.existsSync(path.join(logRoot, 'environment.log'))
        ? redact(fs.readFileSync(path.join(logRoot, 'environment.log'), 'utf8'))
        : ''
    }, null, 2), 'utf8')
    return { success: true, path: target }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
