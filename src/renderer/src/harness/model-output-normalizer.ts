/**
 * 模型输出规范化：处理不同 LLM 厂商的非标准输出格式。
 *
 * 主要处理：
 * 1. `<think>...</think>` 标签：MiniMax-M3 等模型将推理内容直接输出到正文，
 *    需要提取并路由到 reasoning 字段，避免泄露给用户。
 * 2. `<plan><step .../></plan>` XML：部分模型用 XML 格式输出计划而非调用
 *    submit_plan 工具，需要解析并转换为合成工具调用。
 */

/** 从文本中提取 `<think>...</think>` 块，返回清理后的文本和提取的推理内容。 */
export function stripThinkTags(text: string): { text: string; reasoning: string } {
  const reasoningParts: string[] = []
  // 匹配 `<think>...</think>`（允许跨行、允许未闭合的 `<think>` 直到文本末尾）
  const re = /<think>([\s\S]*?)(?:<\/think>|$)/gi
  const cleaned = text.replace(re, (_match, inner: string) => {
    const trimmed = String(inner).trim()
    if (trimmed) reasoningParts.push(trimmed)
    return ''
  })
  return {
    text: cleaned.trim(),
    reasoning: reasoningParts.join('\n\n')
  }
}

/** `<plan>` XML 中 step 的 kind 到 submit_plan 标准 kind 的映射。
 *  - edit_file / write_file / scaffold → write 或 mixin
 *  - register_mixin / fabric_mixin_* → mixin
 *  - build / run → 过滤掉（由主机自动追加）
 *  - 其他 → 保持原值，由后续校验处理
 */
function normalizeStepKind(rawKind: string, description: string): string | null {
  const k = String(rawKind || '').toLowerCase().trim()
  // build/run 步骤由主机自动追加，不从计划中提交
  if (k === 'build' || k === 'run') return null
  if (k === 'edit_file' || k === 'write_file' || k === 'write') return 'write'
  if (k === 'scaffold' || k === 'register_mixin' || k === 'mixin' || k === 'fabric_mixin_scaffold' || k === 'fabric_mixin_register') return 'mixin'
  if (k === 'recipe' || k === 'fabric_recipe_generate' || k === 'create_recipe') return 'recipe'
  if (k === 'inspect' || k === 'read_file' || k === 'grep' || k === 'list_directory') return 'inspect'
  // 根据描述推断
  const desc = description.toLowerCase()
  if (/mixin|注入|inject|scaffold/.test(desc)) return 'mixin'
  if (/配方|recipe/.test(desc)) return 'recipe'
  if (/检查|读取|查询|inspect|read|grep/.test(desc)) return 'inspect'
  return 'write'
}

interface ParsedPlanStep {
  kind: string
  description: string
  targetPath?: string
  targetPaths?: string[]
  evidence: string
}

/** 从文本中提取 `<plan><step .../></plan>` XML 并解析为步骤数组。
 *  返回 null 表示未找到有效的 plan XML。 */
export function extractPlanFromXml(text: string): ParsedPlanStep[] | null {
  // 匹配 `<plan>...</plan>`（允许自闭合 step 和内容 step）
  const planMatch = text.match(/<plan>([\s\S]*?)<\/plan>/i)
  if (!planMatch) return null

  const inner = planMatch[1]
  const steps: ParsedPlanStep[] = []

  // 匹配 `<step kind="..." description="..." targetPath="..." evidence="..."/>` 或 `</step>`
  const stepRe = /<step\b([^>]*?)(?:\/>|>(?:[\s\S]*?)<\/step>)/gi
  let m: RegExpExecArray | null
  while ((m = stepRe.exec(inner)) !== null) {
    const attrs = m[1] || ''
    const getAttr = (name: string): string | undefined => {
      const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')
      const am = attrs.match(re)
      return am ? am[1] : undefined
    }
    const rawKind = getAttr('kind') || ''
    const description = getAttr('description') || ''
    const targetPath = getAttr('targetPath')
    const evidence = getAttr('evidence') || description.slice(0, 80)
    if (!description) continue
    const kind = normalizeStepKind(rawKind, description)
    if (kind === null) continue // build/run 步骤被过滤
    steps.push({ kind, description, targetPath, evidence })
  }

  return steps.length > 0 ? steps : null
}

/** 将解析出的步骤数组转换为 submit_plan 工具调用的参数。 */
export function buildSubmitPlanArgs(steps: ParsedPlanStep[]): Record<string, unknown> {
  return {
    steps: steps.map((s) => ({
      kind: s.kind,
      description: s.description,
      ...(s.targetPath ? { targetPath: s.targetPath } : { targetPath: s.targetPath || '.' }),
      evidence: s.evidence
    }))
  }
}

/** 流式 `<think>` 标签过滤器：在流式输出中检测 `<think>` 标签边界，
 *  将标签内的内容路由到 reasoning，标签外的内容路由到 text。
 *  处理标签跨 chunk 的情况。 */
export class ThinkTagStreamFilter {
  private buffer = ''
  private inThink = false

  /** 处理一个 chunk 的内容，返回应输出到 text 和 reasoning 的部分。 */
  process(chunk: string): { text: string; reasoning: string } {
    this.buffer += chunk
    let textOut = ''
    let reasoningOut = ''

    while (this.buffer.length > 0) {
      if (this.inThink) {
        const closeIdx = this.buffer.indexOf('</think>')
        if (closeIdx === -1) {
          // 还没找到闭合标签，检查 buffer 末尾是否可能是 `</think>` 的前缀
          const partialMatch = this.buffer.match(/<(?:\/(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?)?$/i)
          if (partialMatch && partialMatch.index !== undefined) {
            // 保留可能的前缀，输出前面的部分作为 reasoning
            reasoningOut += this.buffer.slice(0, partialMatch.index)
            this.buffer = this.buffer.slice(partialMatch.index)
          } else {
            // 不是前缀，全部输出为 reasoning
            reasoningOut += this.buffer
            this.buffer = ''
          }
          break
        }
        // 找到闭合标签
        reasoningOut += this.buffer.slice(0, closeIdx)
        this.buffer = this.buffer.slice(closeIdx + '</think>'.length)
        this.inThink = false
      } else {
        const openIdx = this.buffer.indexOf('<think>')
        if (openIdx === -1) {
          // 没有找到 `<think>`，检查 buffer 末尾是否可能是 `<think>` 的前缀
          const partialMatch = this.buffer.match(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i)
          if (partialMatch) {
            // 可能是 `<think>` 的前缀，保留并输出前面的部分
            textOut += this.buffer.slice(0, partialMatch.index)
            this.buffer = this.buffer.slice(partialMatch.index)
            break
          }
          // 不是前缀，全部输出为 text
          textOut += this.buffer
          this.buffer = ''
          break
        }
        // 找到 `<think>` 标签
        textOut += this.buffer.slice(0, openIdx)
        this.buffer = this.buffer.slice(openIdx + '<think>'.length)
        this.inThink = true
      }
    }

    return { text: textOut, reasoning: reasoningOut }
  }

  /** 流结束时，将剩余 buffer 全部输出。 */
  flush(): { text: string; reasoning: string } {
    const remaining = this.buffer
    this.buffer = ''
    if (this.inThink) {
      // 未闭合的 `<think>`，全部作为 reasoning
      this.inThink = false
      return { text: '', reasoning: remaining }
    }
    return { text: remaining, reasoning: '' }
  }
}
