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

function extractHotkey(text: string): string | undefined {
  const m = text.match(/\bF([1-9]|1[0-2])\b/i)
  return m ? `f${m[1]}` : undefined
}

/**
 * Derive a concrete verification target from sticky symptom text.
 * Returns null when no in-game GUI target can be inferred.
 */
export function deriveVerifyTarget(symptom: string | null | undefined): VerifyTarget | null {
  const text = (symptom || '').trim()
  if (!text) return null
  if (/^用户请求游戏内测试/.test(text) && text.length < 40) {
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

  const hotkey = extractHotkey(text)
  const wantsPreview = /预览|preview|WYSIWYG|MainMenuPreview/i.test(text)
  const wantsConfig = /配置|设置屏|ConfigScreen|设置界面/i.test(text)
  const wantsGui = /GUI|gui|界面|屏幕|布局|按钮|控件|面板|显示|错乱|模糊|Screen/i.test(text)

  if (wantsPreview || (hotkey && wantsGui)) {
    const key = hotkey || 'f6'
    return {
      label: `打开 F${key.slice(1).toUpperCase()} 预览屏（MainMenuPreviewScreen / *Preview*）`,
      hotkey: key,
      screenNamePatterns: [/Preview/i, /MainMenuPreviewScreen/i],
      rejectScreenNames: TITLE_REJECT,
      rejectKinds: TITLE_KINDS,
      openSteps: [
        `mc_input key_press {"key":"${key}"}（预览常异步打开，稍后再检视）`,
        '若仍为 TitleScreen：click_widget 进入模组设置里的预览入口',
        'mc_inspect 确认 screen.simpleName 匹配 Preview / MainMenuPreviewScreen',
        '再 mc_screenshot 对照症状'
      ],
      derivedFrom: 'symptom'
    }
  }

  if (wantsConfig) {
    return {
      label: '打开模组配置界面（ConfigScreen / *Config*）',
      hotkey,
      screenNamePatterns: [/ConfigScreen/i, /Config/i, /Settings/i],
      rejectScreenNames: TITLE_REJECT,
      rejectKinds: TITLE_KINDS,
      openSteps: [
        hotkey ? `mc_input key_press {"key":"${hotkey}"}` : 'click_widget label=模组 或 选项',
        'mc_inspect 确认进入 Config/Settings 类界面'
      ],
      derivedFrom: 'symptom'
    }
  }

  if (wantsGui || hotkey) {
    return {
      label: hotkey
        ? `按 ${hotkey.toUpperCase()} 打开相关界面后检视（禁止停在 TitleScreen）`
        : '打开症状相关 GUI 后检视（禁止停在 TitleScreen）',
      hotkey,
      screenNamePatterns: [],
      rejectScreenNames: TITLE_REJECT,
      rejectKinds: TITLE_KINDS,
      openSteps: [
        hotkey
          ? `mc_input key_press {"key":"${hotkey}"}`
          : 'click_widget 点开症状相关按钮',
        'mc_inspect 确认已离开 TitleScreen',
        'mc_screenshot 对照症状'
      ],
      derivedFrom: 'symptom'
    }
  }

  return null
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
