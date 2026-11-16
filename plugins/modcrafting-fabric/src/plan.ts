/**
 * Headless regression runner used by `--plan=FILE`.
 *
 * It drives the same FabricRuntime instance the MCP server uses, so automation never gets a second
 * source of truth: sessions, leases, job ownership and acceptance verdicts all keep their existing
 * semantics. The runner only decides ordering and reporting.
 */
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { CoreError, inspectFabricProject, validateFabricProject, type FabricRuntime } from '../../../packages/modcrafting-core/src/index.ts'
import { renderPlanReport, type PlanStepResult } from './plan-report.ts'

const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1000)))

const stepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('inspect') }).strict(),
  z.object({ op: z.literal('validate') }).strict(),
  z.object({ op: z.literal('prepareAssets'), names: z.array(z.enum(['minecraft-data', 'mc-wiki-zh', 'mc-wiki-zh-index', 'agent-knowledge'])).min(1).optional(), optional: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal('build'), task: z.string().regex(/^[A-Za-z][A-Za-z0-9:.-]*$/).default('build'), timeoutMs: z.number().int().min(1000).max(3_600_000).default(900_000) }).strict(),
  z.object({ op: z.literal('runClient'), timeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000) }).strict(),
  z.object({ op: z.literal('gameTest'), spec: z.record(z.string(), z.unknown()), timeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000) }).strict(),
  z.object({ op: z.literal('screenshot') }).strict()
])

export const planSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(80),
  projectPath: z.string().min(1),
  stopOnFailure: z.boolean().default(true),
  steps: z.array(stepSchema).min(1).max(32)
}).strict()

export type Plan = z.infer<typeof planSchema>

const codeOf = (cause: unknown) => cause instanceof CoreError ? cause.code : typeof (cause as { code?: unknown })?.code === 'string' ? String((cause as { code: string }).code) : 'OPERATION_FAILED'
const terminal = new Set(['completed', 'failed', 'stopped', 'interrupted'])

async function waitForJob(runtime: FabricRuntime, jobId: string, sessionId: string, limitMs: number) {
  const deadline = Date.now() + limitMs
  for (;;) {
    const job = runtime.jobStatus(jobId, sessionId) as Record<string, unknown>
    if (terminal.has(String(job.status))) return job
    if (Date.now() >= deadline) return { ...job, status: 'timeout' }
    await timeout(700)
  }
}

export async function readPlan(planPath: string): Promise<Plan> {
  if (!path.isAbsolute(planPath)) throw new Error('Plan path must be absolute')
  const raw = JSON.parse(await readFile(planPath, 'utf8'))
  const parsed = planSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`INVALID_PLAN: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  if (!path.isAbsolute(parsed.data.projectPath)) throw new Error('INVALID_PLAN: projectPath must be absolute')
  return parsed.data
}

export type PlanRun = {
  runtime: FabricRuntime
  paths: FabricRuntime['paths']
  version: string
  planPath: string
}

export async function runPlan({ runtime, paths, version, planPath }: PlanRun) {
  const plan = await readPlan(planPath)
  const projectPath = plan.projectPath
  const createdAt = new Date().toISOString()
  const planId = `${plan.name}-${createdAt.replace(/[:.]/g, '-')}`
  const session = runtime.createSession({ name: `自动化回归 ${plan.name}`, projectPath })
  const sessionId = session.sessionId
  const steps: PlanStepResult[] = []
  const artifacts: string[] = []

  const record = async (op: string, work: () => Promise<{ verdict: PlanStepResult['verdict']; code: string; detail?: string }>) => {
    const started = Date.now()
    try {
      const value = await work()
      steps.push({ op, ...value, durationMs: Date.now() - started })
      return value
    } catch (cause) {
      const value = { verdict: 'INCONCLUSIVE' as const, code: codeOf(cause), detail: String(cause) }
      steps.push({ op, ...value, durationMs: Date.now() - started })
      return value
    }
  }

  try {
    if (!inspectFabricProject(projectPath).valid) {
      steps.push({ op: 'inspect', verdict: 'FAIL', code: 'PROJECT_UNAVAILABLE', durationMs: 0, detail: '工程不是有效的 Fabric 1.21.4 项目' })
    } else {
      for (const step of plan.steps) {
        if (steps.at(-1)?.verdict === 'FAIL' && plan.stopOnFailure) break
        if (step.op === 'inspect') {
          const project = inspectFabricProject(projectPath)
          steps.push({ op: 'inspect', verdict: project.valid ? 'PASS' : 'FAIL', code: project.valid ? 'OK' : 'PROJECT_INVALID', durationMs: 0, detail: project.modId })
        } else if (step.op === 'validate') {
          const result = validateFabricProject(projectPath)
          const errors = result.diagnostics.filter((entry) => entry.level === 'error')
          steps.push({ op: 'validate', verdict: result.ok ? 'PASS' : 'FAIL', code: result.ok ? 'OK' : 'PROJECT_INVALID', durationMs: 0, detail: errors.slice(0, 3).map((entry) => `${entry.code}@${entry.path}`).join('; ') || undefined })
        } else if (step.op === 'prepareAssets') {
          await record('prepareAssets', async () => {
            await runtime.prepareAssets(step.names, projectPath)
            return { verdict: 'PASS' as const, code: 'OK', detail: step.names?.join(',') ?? '全部' }
          })
        } else if (step.op === 'build') {
          await record('build', async () => {
            const build = runtime.startBuild(projectPath, step.task, sessionId)
            const job = await waitForJob(runtime, build.jobId, sessionId, step.timeoutMs)
            if (job.status === 'completed') return { verdict: 'PASS' as const, code: 'OK' }
            return { verdict: job.status === 'timeout' ? 'INCONCLUSIVE' as const : 'FAIL' as const, code: job.status === 'timeout' ? 'BUILD_TIMEOUT' : 'BUILD_FAILED', detail: `job ${build.jobId} ${String(job.status)}` }
          })
        } else if (step.op === 'runClient') {
          await record('runClient', async () => {
            const run = runtime.runClient(projectPath, undefined, sessionId)
            const deadline = Date.now() + step.timeoutMs
            for (;;) {
              const status = await runtime.runtimeStatus(run.instanceId, sessionId) as Record<string, unknown>
              if (status.canRunTests === true) return { verdict: 'PASS' as const, code: 'OK', detail: String(run.instanceId) }
              if (Date.now() >= deadline) {
                const preparation = (status.preparation ?? {}) as Record<string, unknown>
                return { verdict: 'INCONCLUSIVE' as const, code: 'ENVIRONMENT_UNAVAILABLE', detail: `准备阶段未就绪：${String(preparation.phase ?? 'unknown')}${preparation.blockedReason ? ` · ${String(preparation.blockedReason)}` : ''}` }
              }
              await timeout(1000)
            }
          })
        } else if (step.op === 'gameTest') {
          await record('gameTest', async () => {
            const test = runtime.startTest(step.spec, undefined, sessionId)
            const job = await waitForJob(runtime, test.jobId, sessionId, step.timeoutMs)
            const result = (job.result ?? {}) as Record<string, unknown>
            const verdict = result.verdict === 'PASS' ? 'PASS' as const : result.verdict === 'FAIL' ? 'FAIL' as const : 'INCONCLUSIVE' as const
            return { verdict, code: String(result.code ?? (job.status === 'timeout' ? 'TEST_TIMEOUT' : 'INCONCLUSIVE')), detail: String(result.reason ?? test.scenarioId) }
          })
        } else {
          await record('screenshot', async () => {
            const shot = await runtime.screenshot(undefined, sessionId) as { ok?: boolean; data?: { path?: string } }
            if (shot?.data?.path) artifacts.push(shot.data.path)
            return { verdict: shot?.ok ? 'PASS' as const : 'INCONCLUSIVE' as const, code: shot?.ok ? 'OK' : 'SCREENSHOT_UNAVAILABLE', detail: shot?.data?.path }
          })
        }
      }
    }
  } finally {
    try { runtime.endSession(sessionId) } catch { /* the report is still worth writing */ }
  }

  const verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = steps.some((step) => step.verdict === 'FAIL') ? 'FAIL' : steps.some((step) => step.verdict === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : 'PASS'
  const directory = path.join(paths.reportsRoot, `plan-${planId}`)
  await mkdir(directory, { recursive: true })
  const reportJsonPath = path.join(directory, 'report.json')
  const reportPath = path.join(directory, 'report.html')
  const report = { name: plan.name, planId, projectPath, sessionId, verdict, pluginVersion: version, minecraft: '1.21.4', createdAt, steps, artifacts, reportJsonPath }
  await writeFile(reportJsonPath, `${JSON.stringify({ ...report, plan }, null, 2)}\n`)
  await writeFile(reportPath, renderPlanReport(report))

  return {
    ok: true,
    planId,
    verdict,
    sessionId,
    projectPath,
    steps,
    reportPath,
    reportJsonPath,
    artifacts,
    archiveHint: { tool: 'LibraryUpload', path: reportPath, kind: 'html' }
  }
}
