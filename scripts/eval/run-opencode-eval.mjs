#!/usr/bin/env node
/**
 * Automated OpenCode eval runner.
 *
 * Usage:
 *   npm run eval:opencode
 *   npm run eval:opencode -- --tasks T01,T04
 *   npm run eval:opencode -- --skip-build
 *   npm run eval:opencode -- --dry-run
 *   npm run eval:opencode -- --engine noop   # setup+verify only (agent skipped; expect fails unless fixtures pre-solved)
 *
 * Env:
 *   OPENCODE_MODEL / MODCRAFTING_EVAL_MODEL  (default: opencode/deepseek-v4-flash-free)
 *   OPENCODE_API_KEY / MODCRAFTING_EVAL_API_KEY  (Zen 免费模型通常无需付费 Key；若本机已登录 opencode 可省略)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { scaffoldEvalProject, defaultRuntimeRoot, ensureRuntime } from './scaffold.mjs'
import { applySetups } from './setups.mjs'
import { runVerifiers, snapshotTree } from './verify.mjs'
import { detectOpenCodeCli, runOpenCodeTask } from './engine-opencode.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')
const tasksPath = path.join(__dirname, 'tasks.json')

function parseArgs(argv) {
  const args = {
    tasks: null,
    skipBuild: false,
    dryRun: false,
    engine: 'opencode',
    keep: false,
    outDir: path.join(root, 'temp', 'opencode-eval'),
    failFast: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tasks') args.tasks = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--skip-build') args.skipBuild = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--engine') args.engine = String(argv[++i] || 'opencode')
    else if (a === '--keep') args.keep = true
    else if (a === '--out') args.outDir = path.resolve(String(argv[++i] || args.outDir))
    else if (a === '--fail-fast') args.failFast = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function loadTasks() {
  return JSON.parse(readFileSync(tasksPath, 'utf-8'))
}

function printHelp(catalog) {
  console.log(`OpenCode automated eval

npm run eval:opencode -- [options]

Options:
  --tasks T01,T04     Run subset of tasks
  --engine opencode|noop
  --skip-build        Skip gradleBuild checks (faster smoke)
  --dry-run           List tasks and exit
  --keep              Keep per-task workspaces under temp/opencode-eval
  --out <dir>         Output directory (default: temp/opencode-eval)
  --fail-fast         Stop verifiers on first failure

Tasks in catalog: ${catalog.tasks.map((t) => t.id).join(', ')}
Skipped: ${(catalog.skipped || []).map((s) => s.id).join(', ') || '(none)'}
`)
}

function renderMarkdown(report) {
  const lines = []
  lines.push('# OpenCode Eval Results')
  lines.push('')
  lines.push(`- Generated: ${report.generatedAt}`)
  lines.push(`- Engine: ${report.engine}`)
  lines.push(`- Pass: ${report.passed}/${report.total}`)
  lines.push(`- Duration: ${(report.durationMs / 1000).toFixed(1)}s`)
  if (report.opencodeVersion) lines.push(`- OpenCode: ${report.opencodeVersion}`)
  lines.push('')
  lines.push('| Task | Title | Pass | Agent ms | Notes |')
  lines.push('|------|-------|------|----------|-------|')
  for (const r of report.results) {
    const note = r.error || r.failedChecks?.join('; ') || ''
    lines.push(`| ${r.id} | ${r.title} | ${r.pass ? 'YES' : 'NO'} | ${r.agentMs ?? '-'} | ${note.replace(/\|/g, '/').slice(0, 120)} |`)
  }
  lines.push('')
  for (const r of report.results) {
    lines.push(`## ${r.id} — ${r.title}`)
    lines.push('')
    lines.push(`- pass: **${r.pass}**`)
    lines.push(`- agentMs: ${r.agentMs}`)
    if (r.error) lines.push(`- error: ${r.error}`)
    lines.push('- checks:')
    for (const c of r.checks || []) {
      lines.push(`  - ${c.ok ? 'OK' : 'FAIL'} ${c.name}: ${c.detail || ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

async function runNoopAgent() {
  return {
    ok: true,
    agentOutput: '',
    durationMs: 0,
    error: undefined,
    logs: ''
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const catalog = loadTasks()

  if (args.help) {
    printHelp(catalog)
    process.exit(0)
  }

  const selected = args.tasks
    ? catalog.tasks.filter((t) => args.tasks.includes(t.id))
    : catalog.tasks

  if (selected.length === 0) {
    console.error('No tasks selected')
    process.exit(1)
  }

  if (args.dryRun) {
    printHelp(catalog)
    console.log('Selected:', selected.map((t) => t.id).join(', '))
    process.exit(0)
  }

  mkdirSync(args.outDir, { recursive: true })
  ensureRuntime(defaultRuntimeRoot())

  let opencodeVersion
  if (args.engine === 'opencode') {
    const det = await detectOpenCodeCli()
    if (!det.installed) {
      console.error('OpenCode CLI not found. Install: npm i -g opencode-ai@latest')
      console.error(det.error || '')
      process.exit(2)
    }
    opencodeVersion = det.version
    console.log('OpenCode:', opencodeVersion)
    console.log(
      'Model:',
      process.env.OPENCODE_MODEL || process.env.MODCRAFTING_EVAL_MODEL || 'opencode/deepseek-v4-flash-free'
    )
  }

  const report = {
    generatedAt: new Date().toISOString(),
    engine: args.engine,
    opencodeVersion,
    skipBuild: args.skipBuild,
    results: [],
    passed: 0,
    total: selected.length,
    durationMs: 0
  }

  const wallStart = Date.now()

  for (const task of selected) {
    console.log(`\n=== ${task.id} ${task.title} ===`)
    const workDir = path.join(args.outDir, 'workspaces', `${task.id}-${Date.now()}`)
    const meta = scaffoldEvalProject(workDir, {
      projectName: catalog.projectName,
      groupId: catalog.groupId,
      runtimeRoot: defaultRuntimeRoot()
    })
    applySetups(workDir, task.setup || [])
    const snapshotBefore = snapshotTree(workDir)

    let agentResult
    const agentStart = Date.now()
    if (args.engine === 'noop') {
      agentResult = await runNoopAgent()
      console.log('(noop engine — skipped agent)')
    } else {
      console.log('Running OpenCode…')
      agentResult = await runOpenCodeTask({
        projectDir: workDir,
        prompt: task.prompt,
        agent: task.agent || 'build',
        timeoutMs: task.timeoutMs || 600_000
      })
    }
    const agentMs = Date.now() - agentStart

    if (!agentResult.ok) {
      console.error('Agent error:', agentResult.error)
    } else {
      console.log(`Agent finished in ${(agentMs / 1000).toFixed(1)}s`)
    }

    const verify = await runVerifiers(workDir, task.verify || [], {
      runtimeRoot: meta.runtimeRoot,
      skipBuild: args.skipBuild,
      failFast: args.failFast,
      agentOutput: agentResult.agentOutput || '',
      snapshotBefore,
      buildTimeoutMs: 600_000
    })

    const pass = Boolean(agentResult.ok && verify.ok)
    if (pass) report.passed++

    const failedChecks = (verify.results || []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)
    const row = {
      id: task.id,
      title: task.title,
      pass,
      agentMs,
      error: agentResult.error,
      checks: verify.results,
      failedChecks,
      workspace: args.keep ? workDir : undefined
    }
    report.results.push(row)
    console.log(pass ? 'PASS' : 'FAIL', failedChecks.join(' | '))

    if (!args.keep) {
      // leave last workspace for debugging on fail
      if (pass) {
        try {
          const { wipeDir } = await import('./scaffold.mjs')
          wipeDir(workDir)
        } catch {
          // ignore
        }
      }
    }
  }

  report.durationMs = Date.now() - wallStart

  const jsonPath = path.join(args.outDir, 'results.json')
  const mdPath = path.join(args.outDir, 'results.md')
  const docsMd = path.join(root, 'docs', 'opencode-eval-results.md')
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8')
  writeFileSync(mdPath, renderMarkdown(report), 'utf-8')
  writeFileSync(docsMd, renderMarkdown(report), 'utf-8')

  console.log(`\nDone: ${report.passed}/${report.total} passed`)
  console.log('Wrote', jsonPath)
  console.log('Wrote', mdPath)
  console.log('Wrote', docsMd)

  process.exit(report.passed === report.total ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
