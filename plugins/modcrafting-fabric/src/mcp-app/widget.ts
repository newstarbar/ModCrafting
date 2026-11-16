/**
 * Read-only card renderers. Rules baked in here:
 *  - No fetch, no polling, no reverse tool calls: the host pushes a new structuredContent each
 *    time the model calls the associated tool.
 *  - Everything is escaped; nothing is injected as HTML from tool output.
 *  - Long lists are clipped with a "共 N 条" note instead of virtual scrolling.
 */
import type { Payload } from './bridge.ts'

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] as string))
const text = (value: unknown) => escapeHtml(value === undefined || value === null || value === '' ? '—' : value)
const root = () => document.getElementById('root') as HTMLElement

function row(label: string, value: unknown) {
  return `<div class="row"><span>${escapeHtml(label)}</span><span>${text(value)}</span></div>`
}

function verdictClass(verdict: unknown) {
  return verdict === 'PASS' ? 'pass' : verdict === 'FAIL' ? 'fail' : 'unknown'
}

function verdictLabel(verdict: unknown) {
  if (verdict === 'PASS') return 'PASS'
  if (verdict === 'FAIL') return 'FAIL'
  return 'INCONCLUSIVE（暂时无法验证，不是通过）'
}

function clip<T>(items: T[], limit = 8) {
  if (items.length <= limit) return { shown: items, note: '' }
  return { shown: items.slice(0, limit), note: `共 ${items.length} 条，已显示前 ${limit} 条` }
}

function renderSession(value: Payload) {
  const session = (value.session ?? {}) as Payload
  const job = (value.job ?? {}) as Payload
  const result = (value.result ?? job.result ?? {}) as Payload
  const preparation = (value.preparation ?? {}) as Payload
  const output = Array.isArray(value.output) ? value.output as unknown[] : Array.isArray(job.output) ? job.output as unknown[] : []
  const tail = clip(output.slice(-6), 6)

  const head = `<h1>任务状态</h1><div class="sub">${text(session.sessionId ?? value.sessionId)}</div>`
  const rows = [
    row('任务名', session.name ?? value.name),
    row('阶段', session.phase ?? value.phase ?? preparation.phase),
    row('工程', session.projectPath ?? value.projectPath),
    row('作业', value.status ?? job.status),
    row('可测试', value.canRunTests === undefined ? undefined : value.canRunTests ? '可以（canRunTests=true）' : '还不可以'),
    row('阻塞', preparation.blockedReason ?? value.blockedReason)
  ].join('')

  const verdict = result.verdict ?? value.verdict
  const badge = verdict ? `<div class="row"><span>结论</span><span class="${verdictClass(verdict)}">${escapeHtml(verdictLabel(verdict))}</span></div>` : ''
  const code = result.code ?? value.code
  const codeRow = code ? row('代码', code) : ''
  const evidence = Array.isArray(result.evidence) ? result.evidence as Payload[] : []
  const evidenceList = evidence.length
    ? `<table><thead><tr><th>断言</th><th>结果</th><th>说明</th></tr></thead><tbody>${evidence.slice(0, 8).map((item) => `<tr><td>${text((item.assertion as Payload)?.type ?? item.type)}</td><td class="${item.passed ? 'pass' : 'fail'}">${item.passed ? 'PASS' : item.unavailable ? '不可用' : 'FAIL'}</td><td>${text(item.detail)}</td></tr>`).join('')}</tbody></table>`
    : ''

  const log = tail.shown.length
    ? `<table><thead><tr><th>最近输出</th></tr></thead><tbody>${tail.shown.map((line) => `<tr><td><code>${text(line)}</code></td></tr>`).join('')}</tbody></table>${tail.note ? `<div class="notice">${escapeHtml(tail.note)}</div>` : ''}`
    : ''

  const report = result.reportPath ?? value.reportPath
  return `${head}${rows}${badge}${codeRow}${evidenceList}${log}${report ? `<div class="notice">报告：<code>${text(report)}</code></div>` : ''}<div class="notice">只读卡片；编辑请打开工作台。</div>`
}

function renderProject(value: Payload) {
  const project = (value.project ?? {}) as Payload
  const java = (value.java ?? {}) as Payload
  const target = (value.target ?? {}) as Payload
  const assets = Array.isArray(value.assets) ? value.assets as Payload[] : []
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics as Payload[] : []
  const remediation = Array.isArray(value.remediation) ? value.remediation as unknown[] : []
  const clipped = clip(diagnostics, 6)

  const head = `<h1>工程状态</h1><div class="sub">${text(project.modId ?? value.projectState ?? value.platform)}</div>`
  const rows = [
    row('工程有效', project.valid === undefined ? undefined : project.valid ? '是' : '否'),
    row('Minecraft', target.minecraft ?? project.minecraftVersion),
    row('JDK 21', java.ok === undefined ? undefined : java.ok ? `可用 ${java.version ?? ''}` : '不可用'),
    row('JDK 路径', java.home ?? java.javaHome ?? value.selectedJavaHome),
    row('校验', value.ok === undefined ? undefined : value.ok ? '通过' : '未通过')
  ].join('')
  const assetList = assets.length
    ? `<table><thead><tr><th>资源</th><th>状态</th></tr></thead><tbody>${assets.slice(0, 8).map((asset) => `<tr><td>${text(asset.name)}</td><td>${text(asset.status)}</td></tr>`).join('')}</tbody></table>`
    : ''
  const diagnosticList = clipped.shown.length
    ? `<table><thead><tr><th>级别</th><th>路径</th><th>说明</th></tr></thead><tbody>${clipped.shown.map((item) => `<tr><td class="${item.level === 'error' ? 'fail' : 'unknown'}">${text(item.level)}</td><td><code>${text(item.path)}</code></td><td>${text(item.message)}</td></tr>`).join('')}</tbody></table>${clipped.note ? `<div class="notice">${escapeHtml(clipped.note)}</div>` : ''}`
    : ''
  const remedies = remediation.length ? `<ul>${remediation.slice(0, 4).map((line) => `<li>${text(line)}</li>`).join('')}</ul>` : ''
  return `${head}${rows}${assetList}${diagnosticList}${remedies}<div class="notice">只读卡片；完整检查请让助手运行 fabric_validate。</div>`
}

function renderMedia(value: Payload) {
  const data = (value.data ?? {}) as Payload
  const target = (value.target ?? {}) as Payload
  const warnings = Array.isArray(value.warnings) ? value.warnings as unknown[] : []
  const source = typeof value.image === 'string' ? value.image : typeof data.image === 'string' ? data.image : ''
  const image = /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(source) ? `<img alt="预览" src="${source}">` : ''
  const head = `<h1>素材预览</h1><div class="sub">${text(target.textureId ?? data.path ?? value.candidateId)}</div>`
  const rows = [
    row('候选', value.candidateId ?? target.textureId),
    row('尺寸', data.width && data.height ? `${data.width}×${data.height}` : value.width && value.height ? `${value.width}×${value.height}` : undefined),
    row('文件', data.path ?? value.path),
    row('已保存', value.revision === undefined ? undefined : value.saved === false ? '否' : '是')
  ].join('')
  const warn = warnings.length ? `<ul>${warnings.slice(0, 5).map((line) => `<li>${text(line)}</li>`).join('')}</ul>` : ''
  const missing = image ? '' : '<div class="notice">这张工具结果没有内嵌 PNG（默认只返回路径）。需要看图时用 inline=true 重试。</div>'
  return `${head}${rows}${image}${warn}${missing}`
}

export function render(value: Payload) {
  const preset = document.body.dataset.preset
  const html = preset === 'project' ? renderProject(value) : preset === 'media' ? renderMedia(value) : renderSession(value)
  root().innerHTML = html
}
