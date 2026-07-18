/** Validation helpers for ask_clarification — kept pure for harness tests. */

export const MAX_CLARIFY_QUESTION_CHARS = 160
export const MAX_CLARIFY_OPTION_CHARS = 48
export const MAX_EXECUTE_CLARIFICATIONS = 2

const CODE_FACT_RE =
  /方法名|get[A-Z][A-Za-z0-9_]+|set[A-Z][A-Za-z0-9_]+|API\s*调用|签名不一致|类名不|空类|mixins\.json|未注册|已注册|编译错误|找不到符号/

const PREFERENCE_RE =
  /你希望|偏好|要不要|是否需要|选哪种|哪种更好|产品|玩法|用户体验|确认一下需求|你更想/

export type ClarifyValidationOk = {
  ok: true
  question: string
  options: string[]
}

export type ClarifyValidationErr = {
  ok: false
  error: string
}

export type ClarifyValidationResult = ClarifyValidationOk | ClarifyValidationErr

/** True when the question looks like a code-fact dump rather than a user preference. */
export function looksLikeCodeFactQuestion(question: string): boolean {
  const q = question.trim()
  if (!q) return false
  if (PREFERENCE_RE.test(q)) return false
  return CODE_FACT_RE.test(q)
}

export function validateClarificationArgs(
  rawQuestion: unknown,
  rawOptions: unknown
): ClarifyValidationResult {
  const question = String(rawQuestion || '').trim()
  const list = Array.isArray(rawOptions) ? (rawOptions as unknown[]) : []
  const options = [
    ...new Set(list.map((o) => String(o || '').trim()).filter(Boolean))
  ].slice(0, 4)

  if (!question) {
    return { ok: false, error: 'Error: question 不能为空' }
  }
  if (question.length > MAX_CLARIFY_QUESTION_CHARS) {
    return {
      ok: false,
      error:
        `Error: question 过长（${question.length}>${MAX_CLARIFY_QUESTION_CHARS} 字）。` +
        '只问一句用户偏好/需求歧义；代码事实请先 read_file/grep 后自行按最简一致方案修改。'
    }
  }
  if (options.length < 2) {
    return {
      ok: false,
      error:
        'Error: ask_clarification 必须提供至少 2 个 options；禁止无选项的开放式提问。' +
        '请改用 list_directory/read_file 自行勘察，或给出明确互斥短选项后再问。'
    }
  }
  for (const opt of options) {
    if (opt.includes('\n') || opt.includes('\r')) {
      return {
        ok: false,
        error:
          'Error: option 禁止换行。请用短标签（≤48 字），不要把多步实现方案塞进选项。'
      }
    }
    if (opt.length > MAX_CLARIFY_OPTION_CHARS) {
      return {
        ok: false,
        error:
          `Error: option 过长（${opt.length}>${MAX_CLARIFY_OPTION_CHARS} 字）。` +
          '选项必须是短标签，例如「删空壳并注册实装 Mixin」，禁止贴完整实施方案。'
      }
    }
  }
  if (looksLikeCodeFactQuestion(question)) {
    return {
      ok: false,
      error:
        'Error: 这像是代码事实/工程整理问题（API 命名、空类、Mixin 注册等），不是用户偏好。' +
        '请先 read_file/grep，默认选更干净一致的方案直接改，不要用 ask_clarification 做代码评审。'
    }
  }

  return { ok: true, question, options }
}

export function formatClarificationOutput(question: string, options: string[]): string {
  const optionsText = '\n\n选项：\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n')
  return `[CLARIFICATION_NEEDED]\n问题：${question}${optionsText}`
}
