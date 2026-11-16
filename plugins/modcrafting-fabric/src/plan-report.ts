/** Self-contained HTML report for `--plan` runs: no scripts, no network, printable and archivable. */
export type PlanStepResult = { op: string; verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; code: string; durationMs: number; detail?: string }
export type PlanReport = {
  name: string
  planId: string
  projectPath: string
  sessionId: string
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  pluginVersion: string
  minecraft: string
  createdAt: string
  steps: PlanStepResult[]
  artifacts: string[]
  reportJsonPath: string
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] as string))

const CSS = `
:root{color-scheme:light;--fg:#1b2416;--muted:#5d6b57;--line:#dfe5d8;--pass:#2f6b1f;--fail:#a3282c;--warn:#8a5a00;--chip:#f1f5ea;--bg:#ffffff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:880px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:15px;margin:28px 0 8px}
.meta{color:var(--muted);font-size:13px}
.badge{display:inline-block;padding:8px 16px;border-radius:10px;font-size:18px;font-weight:700;margin:16px 0 4px}
.badge.pass{background:#e7f2df;color:var(--pass)}
.badge.fail{background:#fbe6e6;color:var(--fail)}
.badge.unknown{background:#fbf0d9;color:var(--warn)}
.note{color:var(--muted);font-size:13px;margin:0 0 8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}
td.ok{color:var(--pass);font-weight:600}
td.bad{color:var(--fail);font-weight:600}
td.warn{color:var(--warn);font-weight:600}
code{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
dl{display:grid;grid-template-columns:120px 1fr;gap:4px 12px;font-size:13px;margin:0}
dt{color:var(--muted)}
dd{margin:0;word-break:break-all}
ul{padding-left:20px;font-size:13px}
footer{margin-top:40px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
`

function verdictText(verdict: PlanReport['verdict']) {
  if (verdict === 'PASS') return 'PASS —— 所有步骤都通过'
  if (verdict === 'FAIL') return 'FAIL —— 有步骤未通过'
  return 'INCONCLUSIVE —— 暂时无法验证，这不是通过'
}

function cellClass(verdict: PlanStepResult['verdict']) {
  return verdict === 'PASS' ? 'ok' : verdict === 'FAIL' ? 'bad' : 'warn'
}

export function renderPlanReport(report: PlanReport) {
  const badge = report.verdict === 'PASS' ? 'pass' : report.verdict === 'FAIL' ? 'fail' : 'unknown'
  const rows = report.steps.map((step) => `<tr><td><code>${escapeHtml(step.op)}</code></td><td class="${cellClass(step.verdict)}">${escapeHtml(step.verdict)}</td><td><code>${escapeHtml(step.code)}</code></td><td>${step.durationMs} ms</td><td>${escapeHtml(step.detail ?? '')}</td></tr>`).join('')
  const artifacts = report.artifacts.length ? `<ul>${report.artifacts.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join('')}</ul>` : '<p class="note">这次运行没有产出截图类文件。</p>'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ModCrafting 回归报告 · ${escapeHtml(report.name)}</title><style>${CSS}</style></head><body><main>
<h1>ModCrafting 回归报告</h1>
<div class="meta">${escapeHtml(report.name)} · ${escapeHtml(report.planId)} · ${escapeHtml(report.createdAt)}</div>
<div class="badge ${badge}">${escapeHtml(verdictText(report.verdict))}</div>
<p class="note">结论只覆盖本次运行观察到的证据。截图、编译成功、单条命令成功都不构成玩法验证通过。</p>
<h2>运行环境</h2>
<dl>
<dt>插件版本</dt><dd>${escapeHtml(report.pluginVersion)}</dd>
<dt>Minecraft</dt><dd>${escapeHtml(report.minecraft)}</dd>
<dt>工程</dt><dd><code>${escapeHtml(report.projectPath)}</code></dd>
<dt>会话</dt><dd><code>${escapeHtml(report.sessionId)}</code></dd>
<dt>机器可读报告</dt><dd><code>${escapeHtml(report.reportJsonPath)}</code></dd>
</dl>
<h2>步骤</h2>
<table><thead><tr><th>步骤</th><th>结论</th><th>代码</th><th>耗时</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>
<h2>产物</h2>
${artifacts}
<footer>由 ModCrafting 生成。这个页面是自包含的：没有脚本、没有外链，可以直接归档或离线打开。</footer>
</main></body></html>`
}
