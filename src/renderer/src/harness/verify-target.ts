/**
 * Explicit in-game verification target derived from user symptom text.
 * Completion requires mc_inspect/mc_screenshot to land on a matching screen —
 * not merely "left TitleScreen".
 */

export interface VerifyTarget {
  /** Human-readable goal shown in notices / prompts */
  label: string
  /** Optional hotkey extracted from symptom, e.g. "f6" */
  hotkey?: string
  /**
   * screen.simpleName (or className) must match at least one pattern.
   * Empty array = any non-rejected screen (legacy GUI-feature behavior).
   */
  screenNamePatterns: RegExp[]
  /** Always reject these simpleNames */
  rejectScreenNames: string[]
  /** Always reject these screen.kind values */
  rejectKinds: string[]
  /** Short open steps for the agent */
  openSteps: string[]
  derivedFrom: 'symptom' | 'default'
}

const TITLE_REJECT = ['TitleScreen']
const TITLE_KINDS = ['title']

export interface ClassifyVerifyTargetInput {
  label: string
  hotkey?: string
  screenNameHints: string[]
  openSteps: string[]
}

/** Default target when user asks for in-game verify but no concrete screen was classified. */
export function defaultVerifyTarget(): VerifyTarget {
  return {
    label: '打开待测功能界面（非标题屏）后截图/检视',
    screenNamePatterns: [],
    rejectScreenNames: TITLE_REJECT,
    rejectKinds: TITLE_KINDS,
    openSteps: [
      '若症状含热键：mc_input key_press',
      '否则 click_widget 点「模组 / 选项 / 预览」',
      'mc_inspect 确认已离开 TitleScreen'
    ],
    derivedFrom: 'default'
  }
}

function hintToRegExp(hint: string): RegExp | null {
  const raw = hint.trim()
  if (!raw) return null
  // Escape regex metacharacters from model hints; match as substring.
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(escaped, 'i')
  } catch {
    return null
  }
}

/**
 * Build VerifyTarget from constrained LLM classification (not keyword bags).
 */
export function verifyTargetFromClassification(
  payload: ClassifyVerifyTargetInput | null | undefined,
  derivedFrom: 'symptom' | 'default' = 'symptom'
): VerifyTarget | null {
  if (!payload) return null
  const label = String(payload.label || '').trim()
  if (!label) return null
  const patterns = (payload.screenNameHints || [])
    .map(hintToRegExp)
    .filter((re): re is RegExp => Boolean(re))
  const hotkeyRaw = payload.hotkey?.trim()
  const hotkeyMatch = hotkeyRaw?.match(/^f?([1-9]|1[0-2])$/i)
  const hotkey = hotkeyMatch ? `f${hotkeyMatch[1]}` : undefined
  const openSteps = (payload.openSteps || []).map((s) => String(s || '').trim()).filter(Boolean)
  return {
    label: label.slice(0, 160),
    hotkey,
    screenNamePatterns: patterns,
    rejectScreenNames: TITLE_REJECT,
    rejectKinds: TITLE_KINDS,
    openSteps:
      openSteps.length > 0
        ? openSteps.slice(0, 8)
        : [
            hotkey ? `mc_input key_press {"key":"${hotkey}"}` : '打开待测功能界面',
            'mc_inspect 确认已离开 TitleScreen'
          ],
    derivedFrom
  }
}

export function parseInspectScreen(output: string): {
  simpleName: string
  className: string
  kind: string
  title: string
} | null {
  const out = String(output || '')
  if (!out.trim()) return null
  try {
    const data = JSON.parse(out) as {
      screen?: { simpleName?: string; className?: string; kind?: string; title?: string }
      simpleName?: string
      className?: string
      kind?: string
    }
    const screen = data.screen || data
    const simpleName = String(screen.simpleName || '').trim()
    if (!simpleName && !screen.className) return null
    return {
      simpleName,
      className: String(screen.className || ''),
      kind: String(screen.kind || ''),
      title: String((screen as { title?: string }).title || '')
    }
  } catch {
    const simple =
      out.match(/"simpleName"\s*:\s*"([^"]+)"/i)?.[1] ||
      ''
    const kind = out.match(/"kind"\s*:\s*"([^"]+)"/i)?.[1] || ''
    const className = out.match(/"className"\s*:\s*"([^"]+)"/i)?.[1] || ''
    if (!simple && !className) return null
    return { simpleName: simple, className, kind, title: '' }
  }
}

export function matchesVerifyTarget(output: string, target: VerifyTarget): boolean {
  const screen = parseInspectScreen(output)
  if (!screen) {
    // Screenshots may not include screen JSON — allow only if we cannot parse
    // and patterns are empty (weak path). Prefer inspect.
    if (target.screenNamePatterns.length > 0) return false
    return !/"simpleName"\s*:\s*"TitleScreen"/i.test(output)
  }

  const name = screen.simpleName || screen.className.split('.').pop() || ''
  if (target.rejectScreenNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return false
  }
  if (screen.kind && target.rejectKinds.some((k) => k.toLowerCase() === screen.kind.toLowerCase())) {
    return false
  }
  if (target.screenNamePatterns.length === 0) {
    // Any non-rejected screen counts
    return Boolean(name)
  }
  const hay = `${name} ${screen.className}`
  return target.screenNamePatterns.some((re) => re.test(hay))
}

export function formatVerifyTargetBlock(target: VerifyTarget | null | undefined): string {
  if (!target) return ''
  const patterns =
    target.screenNamePatterns.length > 0
      ? target.screenNamePatterns.map((r) => r.source).join(' | ')
      : '任意非 TitleScreen'
  const steps = target.openSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return (
    `【检测目标】${target.label}\n` +
    `成功条件：mc_inspect 的 screen.simpleName 匹配（${patterns}）；` +
    `禁止以 TitleScreen / kind=title 结束。\n` +
    `打开步骤：\n${steps}`
  )
}

export function describeVerifyMismatch(
  output: string,
  target: VerifyTarget
): string {
  const screen = parseInspectScreen(output)
  const actual = screen
    ? `${screen.simpleName || '(unknown)'}${screen.kind ? ` (kind=${screen.kind})` : ''}`
    : '（无法解析当前界面）'
  const expect =
    target.screenNamePatterns.length > 0
      ? target.screenNamePatterns.map((r) => r.source).join(' | ')
      : '非 TitleScreen'
  return `检测未达标：期望界面匹配「${expect}」，实际「${actual}」。继续按【检测目标】打开功能后再 mc_inspect。`
}

/**
 * Landed on a real (non-title) screen that still doesn't match the target —
 * this is a concrete bug finding (wrong wiring), not "keep clicking".
 */
export function isWrongScreenVerifyFinding(
  output: string,
  target: VerifyTarget
): { actual: string; expected: string } | null {
  if (matchesVerifyTarget(output, target)) return null
  const screen = parseInspectScreen(output)
  if (!screen) return null
  const name = (screen.simpleName || screen.className.split('.').pop() || '').trim()
  if (!name) return null
  if (target.rejectScreenNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return null
  }
  if (screen.kind && target.rejectKinds.some((k) => k.toLowerCase() === screen.kind.toLowerCase())) {
    return null
  }
  // Only treat as a finding when we have a positive target pattern to miss.
  if (target.screenNamePatterns.length === 0) return null
  const expected = target.screenNamePatterns.map((r) => r.source).join(' | ')
  return { actual: name, expected }
}

export function formatVerifyRepairKick(finding: {
  actual: string
  expected: string
}): string {
  return [
    `【检测发现错误界面 → 进入修复】期望匹配「${finding.expected}」，实际打开了「${finding.actual}」。`,
    '这通常是入口接错（例如截图/热键后 setScreen 到了 ConfigScreen 而不是 Preview）。',
    '立刻 edit_file / write_file 修改相关源码，使流程打开目标屏；',
    '改完后 trigger_build({"task":"build"}) → trigger_build({"task":"runClient"})，再按【检测目标】mc_inspect 验证。',
    '禁止只在错误界面上反复点按/截图而不改代码；禁止结束本步。'
  ].join('\n')
}
