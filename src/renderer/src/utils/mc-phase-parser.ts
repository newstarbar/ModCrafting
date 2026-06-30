export type McPhase = 'idle' | 'prepare' | 'compile' | 'launch' | 'playing' | 'done' | 'error'

export interface McPhaseInfo {
  phase: McPhase
  summaryLine: string
  hasError: boolean
}

const PHASE_RANK: Record<McPhase, number> = {
  idle: 0,
  prepare: 1,
  compile: 2,
  launch: 3,
  playing: 4,
  done: 5,
  error: -1
}

const CLIENT_STARTED_MARKERS = [
  'loading minecraft',
  'minecraft client started',
  'setting user:',
  'backend library: lwjgl',
  'lwjgl version',
  'openal initialized',
  'sound engine started',
  'reloading resourcemanager',
  'fabric loader/gameprovider',
  'spongepowered mixin subsystem'
]

const ERROR_MARKERS = [
  'build failed',
  'failure: build failed',
  'could not find or load main class',
  'execution failed for task'
]

function normalizeForMatch(text: string): string {
  return text.toLowerCase()
}

export function isMcClientStarted(text: string): boolean {
  const lower = normalizeForMatch(text)
  return CLIENT_STARTED_MARKERS.some((m) => lower.includes(m))
}

function lineHasError(text: string): boolean {
  const lower = normalizeForMatch(text)
  if (lower.includes('/warn]') || lower.includes('[warn]') || lower.includes('warning')) {
    return false
  }
  if (lower.includes('reference missing files')) {
    return false
  }
  if (ERROR_MARKERS.some((m) => lower.includes(m))) return true
  if (lower.includes('exception in thread') && !lower.includes('update checker')) return true
  return false
}

function bumpPhase(current: McPhase, next: McPhase): McPhase {
  if (next === 'error') return 'error'
  if (PHASE_RANK[next] > PHASE_RANK[current]) return next
  return current
}

/** Split raw stdout/stderr chunks into individual log lines. */
export function splitLogChunks(chunks: string[]): string[] {
  const lines: string[] = []
  for (const chunk of chunks) {
    const parts = chunk.split(/\r?\n/)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.length > 0) lines.push(part)
      else if (i < parts.length - 1) lines.push('')
    }
  }
  return lines
}

function phaseFromLine(line: string): { phase: McPhase; summary: string } | null {
  const lower = normalizeForMatch(line)

  if (lineHasError(line)) {
    return {
      phase: 'error',
      summary: lower.includes('build failed')
        ? '编译失败，请展开技术详情查看原因'
        : '启动过程中出现错误'
    }
  }

  if (lower.includes('downloading') || lower.includes('resolving dependencies') || lower.includes('stopping daemon')) {
    return { phase: 'prepare', summary: '正在准备构建环境…' }
  }

  if (
    lower.includes('> task :compilejava') ||
    lower.includes('> task :compileclientjava') ||
    lower.includes('> task :compilekotlin') ||
    (lower.includes('compiling') && lower.includes('java'))
  ) {
    return { phase: 'compile', summary: '正在编译模组代码…' }
  }

  if (lower.includes('> task :runclient') || (lower.includes('runclient') && lower.includes('task'))) {
    return { phase: 'launch', summary: '正在启动 Minecraft 客户端…' }
  }

  if (lower.includes('loading minecraft') && lower.includes('fabric loader')) {
    return { phase: 'launch', summary: '正在加载 Minecraft 与 Fabric…' }
  }

  if (isMcClientStarted(line)) {
    if (lower.includes('setting user:') || lower.includes('sound engine started') || lower.includes('backend library: lwjgl')) {
      return { phase: 'playing', summary: 'Minecraft 已启动，可在弹出的窗口中游戏' }
    }
    if (lower.includes('loading minecraft')) {
      return { phase: 'launch', summary: '正在加载游戏…' }
    }
    return { phase: 'playing', summary: 'Minecraft 已启动，可在弹出的窗口中游戏' }
  }

  if (lower.includes('build successful')) {
    return { phase: 'launch', summary: '编译完成，正在启动游戏…' }
  }

  return null
}

/** Derive human-readable phase + summary from accumulated MC runtime log lines. */
export function parseMcLogs(logChunks: string[], status: string): McPhaseInfo {
  if (status === 'running') {
    return {
      phase: 'playing',
      summaryLine: '游戏运行中，可在弹出的窗口中游玩',
      hasError: false
    }
  }

  const lines = splitLogChunks(logChunks)

  if (lines.length === 0) {
    if (status === 'starting') {
      return { phase: 'prepare', summaryLine: '正在准备启动环境…', hasError: false }
    }
    return { phase: 'idle', summaryLine: '点击「启动游戏」开始测试模组', hasError: false }
  }

  let phase: McPhase = 'prepare'
  let summaryLine = '正在准备启动环境…'
  let hasError = false
  let lastMeaningful = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    lastMeaningful = trimmed.slice(0, 120)

    const parsed = phaseFromLine(trimmed)
    if (!parsed) continue

    if (parsed.phase === 'error') {
      hasError = true
      phase = 'error'
      summaryLine = parsed.summary
    } else {
      phase = bumpPhase(phase, parsed.phase)
      summaryLine = parsed.summary
    }
  }

  if (status === 'starting' && phase === 'idle') {
    phase = 'prepare'
  }

  if (status === 'stopped' || status === 'crashed') {
    if (hasError) {
      phase = 'error'
    } else if (phase === 'playing' || PHASE_RANK[phase] >= PHASE_RANK.launch) {
      phase = 'done'
      summaryLine = '游戏已结束'
    } else if (lastMeaningful) {
      summaryLine = lastMeaningful
    }
  }

  return { phase, summaryLine, hasError }
}

export const PHASE_LABELS: Record<McPhase, string> = {
  idle: '待命',
  prepare: '准备环境',
  compile: '编译模组',
  launch: '启动游戏',
  playing: '游戏中',
  done: '已结束',
  error: '出错'
}

export const PHASE_ORDER: McPhase[] = ['prepare', 'compile', 'launch', 'playing']

export function phaseStepIndex(phase: McPhase, status: string): number {
  if (status === 'running') return 3
  const idx = PHASE_ORDER.indexOf(phase)
  if (idx >= 0) return idx
  if (phase === 'done') return 3
  return -1
}
