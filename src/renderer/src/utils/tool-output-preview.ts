import {
  formatKnowledgeHitPlain,
  parseKnowledgeHitTrails
} from './knowledge-hit-tags.ts'

/** Extract a clean preview summary from tool output (for collapsed view). */
export function extractPreview(toolName: string, output: string, args?: Record<string, unknown>): string {
  if (!output) return ''

  if (toolName === 'read_file') {
    const path = String(args?.path || '')
    const fileName = path.split('/').pop() || path
    const match = output.match(/共 (\d+) 行，显示 (\d+)-(\d+) 行/)
    if (match) return `${fileName}  ${match[2]}-${match[3]} / ${match[1]} 行`
    const sizeMatch = output.match(/(\d+)\s*bytes/)
    return sizeMatch ? `${fileName} (${sizeMatch[1]} bytes)` : fileName
  }
  if (toolName === 'write_file') {
    const path = String(args?.path || '')
    const fileName = path.split('/').pop() || path
    const diffMatch = output.match(/新增 (\d+) 行.*删除 (\d+) 行/)
    const sizeMatch = output.match(/(\d+)\s*bytes/)
    if (diffMatch) return `${fileName}  +${diffMatch[1]} -${diffMatch[2]}`
    if (sizeMatch) return `${fileName}  + 行 (${sizeMatch[1]} bytes)`
    return fileName
  }
  if (toolName === 'edit_file') {
    const path = String(args?.path || '')
    const fileName = path.split('/').pop() || path
    const lineMatch = output.match(/第 (\d+) 行/)
    const diffMatch = output.match(/\+(\d+) 行|修改 (\d+) 行/)
    const lineInfo = lineMatch ? `第 ${lineMatch[1]} 行` : ''
    const diffInfo = diffMatch ? ` +${diffMatch[1] || diffMatch[2]}` : ''
    return `${fileName}${lineInfo ? ' ' + lineInfo : ''}${diffInfo}`
  }

  if (toolName === 'list_directory') {
    const path = String(args?.path || '')
    const dirName = path.split('/').pop() || '/'
    const items = output.split('\n').filter((l) => l.trim() && !l.startsWith('total'))
    return `${dirName} (${items.length} 项)`
  }

  if (toolName === 'grep') {
    const pattern = String(args?.pattern || '').trim()
    const label = pattern.length > 32 ? `${pattern.slice(0, 32)}…` : pattern
    const hitMatch = output.match(/找到\s*(\d+)\s*处/)
    if (hitMatch) return `${label || 'grep'} → ${hitMatch[1]} 处`
    if (/^无匹配/.test(output)) return `${label || 'grep'} → 无匹配`
    const lines = output.split('\n').filter((l) => l.trim()).length
    return label ? `${label} (${lines} 行)` : `${lines} 行结果`
  }

  if (toolName === 'trigger_build' || toolName === 'run_command') {
    if (output.includes('BUILD SUCCESSFUL')) {
      const timeMatch = output.match(/(\d+)s/)
      return timeMatch ? `BUILD SUCCESSFUL (${timeMatch[1]}s)` : 'BUILD SUCCESSFUL'
    }
    if (output.includes('BUILD FAILED')) return 'BUILD FAILED'
    if (output.includes('MC_PHASE:ready') || output.includes('稳定观察')) return '游戏测试通过'
    if (output.includes('MC_PHASE:playing') || output.includes('已启动游戏')) return '游戏运行中'
    const exitMatch = output.match(/\[exit code: (\d+)\]|\[退出码: (\d+)\]/)
    const exitCode = exitMatch?.[1] ?? exitMatch?.[2]
    if (exitCode && exitCode !== '0') return `退出码 ${exitCode}`
    return '已完成'
  }

  if (toolName === 'fabric_docs_search' || toolName === 'fabric_javadoc_lookup' || toolName === 'vanilla_mc_wiki_query') {
    const trails = parseKnowledgeHitTrails(output)
    if (trails.length > 0) {
      return trails.slice(0, 2).map(formatKnowledgeHitPlain).join(' · ')
    }
    const human = output.match(/^摘要：(.+)$/m)?.[1]?.trim() || ''
    if (human) return human.length > 72 ? `${human.slice(0, 72)}…` : human
    const summary = output.match(/^结果：(.+)$/m)?.[1] || ''
    const kw = String(args?.keyword || args?.query || '')
    return summary ? `${kw.slice(0, 28)} → ${summary}` : kw.slice(0, 36)
  }
  if (toolName === 'fabric_meta_version_check') {
    const mc = output.match(/"minecraft_version":\s*"([^"]+)"/)?.[1] || ''
    return mc ? `MC ${mc}` : '版本查询'
  }

  if (toolName === 'create_recipe' || toolName === 'fabric_recipe_generate') {
    const name = String(args?.name || '')
    if (name) return `${name}.json`
    const pm = output.match(/已生成配方:\s*(\S+)/)
    if (pm) {
      const p = pm[1]
      return p.split('/').pop() || p
    }
    return '配方'
  }

  if (toolName === 'fabric_content_register') {
    const p = String(args?.path || args?.className || '')
    return p ? p.replace(/^.*\//, '') : '内容注册'
  }
  if (toolName === 'fabric_data_assets_generate') {
    const files = output.match(/- (\S+)/g)
    return files ? `${files.length} 个资源文件` : '资源生成'
  }

  if (toolName === 'fabric_mixin_scaffold') {
    const cls = args?.mixinClass ? String(args.mixinClass).split('.').pop() : null
    return cls || 'Mixin'
  }
  if (toolName === 'fabric_mixin_register') {
    const cls = String(args?.mixinClass || '').split('.').pop() || ''
    return cls ? `${cls} 已注册` : '已注册'
  }

  if (toolName === 'fabric_log_debugger') {
    const k = output.match(/"kind":\s*"([^"]+)"/)?.[1] || ''
    return k || '日志分析'
  }
  if (toolName === 'read_error_log') {
    if (output.includes('BUILD FAILED')) return 'BUILD FAILED'
    if (output.includes('BUILD SUCCESSFUL')) return 'BUILD SUCCESSFUL'
    return '日志'
  }

  if (toolName === 'fabric_mod_json_validate') {
    if (output.includes('"ok": true')) return '校验通过'
    const issues = (output.match(/issue|warning/gi) || []).length
    return issues > 0 ? `${issues} 个问题` : '校验完成'
  }

  if (toolName === 'complete_step') {
    const m = output.match(/步骤 #(\d+)/)
    return m ? `步骤 ${m[1]} 已完成` : '步骤完成'
  }
  if (toolName === 'ask_clarification') {
    const q = String(args?.question || '')
    return q.length > 40 ? `${q.slice(0, 40)}…` : q || '需要确认'
  }

  const fl = output.split('\n')[0]?.trim() || ''
  return fl.length > 52 ? `${fl.slice(0, 52)}…` : fl
}
