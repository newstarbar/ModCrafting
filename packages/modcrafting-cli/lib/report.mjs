/** Human and machine readable output. `--json` prints the raw envelope. */
const ICONS = { created: '＋', updated: '↻', unchanged: '＝', removed: '－', absent: '·', create: '＋', update: '↻', remove: '－', delegated: '⇢' }

function line(text) {
  return text
}

export function renderHuman(result) {
  const out = []
  if (result.command === 'install') {
    out.push(`ModCrafting ${result.bundle.version}${result.dryRun ? '（预演，未写入）' : ''}`)
    out.push(`bundle：${result.bundle.source}`)
    for (const host of result.hosts) {
      if (host.snippet) {
        out.push('')
        out.push(`# ${host.label}`)
        out.push(host.snippet)
        continue
      }
      const config = host.config ?? {}
      const action = host.delegate ? 'delegated' : config.action
      out.push('')
      out.push(`${ICONS[action] ?? '·'} ${host.label} — ${config.file ?? ''}`)
      if (host.delegate) out.push(`  ${host.delegate.output.split('\n')[0] ?? ''}`)
      const skills = host.skills ?? []
      const created = skills.filter((item) => item.action === 'created').length
      const updated = skills.filter((item) => item.action === 'updated').length
      const summary = created || updated ? `新建 ${created}，更新 ${updated}` : '无变化'
      out.push(`  技能：${skills.length ? `${skills.length} 个（${summary}）` : '该宿主未安装技能'}`)
      if (host.restartHint) out.push(`  下一步：${host.restartHint}`)
    }
    out.push('')
    out.push('验证：npx modcrafting doctor')
    return out.join('\n')
  }

  if (result.command === 'uninstall') {
    out.push(`卸载${result.dryRun ? '（预演）' : ''}`)
    for (const host of result.hosts) {
      out.push(`${ICONS[host.config.action] ?? '·'} ${host.label}：配置 ${host.config.action}${host.config.file ? `（${host.config.file}）` : ''}`)
      if (host.skills.removed.length) out.push(`  技能：删除 ${host.skills.removed.length} 个`)
      if (host.skills.kept.length) out.push(`  技能：保留 ${host.skills.kept.length} 个（文件已被修改）`)
    }
    return out.join('\n')
  }

  if (result.command === 'doctor') {
    out.push(`ModCrafting doctor`)
    out.push(`node：${result.node.executable} (${result.node.version})`)
    out.push(`数据：${result.root}`)
    out.push('')
    for (const host of result.hosts) {
      const config = host.config
      const state = config.hasEntry ? '已配置' : config.exists ? '配置存在但无条目' : '未配置'
      out.push(`${host.label} [${host.host}] ${host.verified === 'yes' ? '' : '(部分验证)'}`)
      out.push(`  配置：${config.file || '—'} — ${state}`)
      if (config.error) out.push(`  错误：${config.error}`)
      if (host.installedVersion) out.push(`  安装版本：${host.installedVersion}`)
      const skills = host.skills.filter((item) => item.installed)
      out.push(`  技能：${skills.length ? skills.map((item) => `${item.name}${item.current === false ? '(过期)' : ''}`).join('、') : '未安装'}`)
    }
    if (result.problems.length) {
      out.push('')
      out.push('问题：')
      for (const problem of result.problems) out.push(`  - ${problem}`)
    } else out.push('\n没有发现问题。')
    return out.join('\n')
  }

  if (result.command === 'versions') {
    out.push(`CLI ${result.cli}`)
    out.push(`缓存版本：${result.cached.length ? result.cached.map((item) => `${item.version}${item.valid ? '' : '(损坏)'}`).join('、') : '无'}`)
    out.push(`已安装宿主：${result.installed.length ? result.installed.map((item) => `${item.host}@${item.version}`).join('、') : '无'}`)
    return out.join('\n')
  }

  if (result.command === 'verify') {
    return `bundle 校验通过：${result.directory}（${result.version}，${result.files} 个文件）`
  }

  return line(JSON.stringify(result, null, 2))
}

export function renderError(error, { json = false } = {}) {
  if (json) return JSON.stringify({ ok: false, code: error.code ?? 'ERROR', message: error.message, details: error.details }, null, 2)
  return `✗ ${error.message}`
}
