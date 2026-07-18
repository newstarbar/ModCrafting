export interface ParsedError {
  type: 'gradle-error' | 'gradle-warning' | 'mc-crash' | 'java-exception' | 'general'
  file?: string
  line?: number
  message: string
  detail: string
  raw: string
}

// Parse Gradle build errors
export function parseGradleError(line: string): ParsedError | null {
  // Gradle compilation errors: path/to/file.java:123: error: message
  const gradleErrorMatch = line.match(/([\w/\\\.-]+\.java):(\d+):\s*error:\s*(.+)/)
  if (gradleErrorMatch) {
    return {
      type: 'gradle-error',
      file: gradleErrorMatch[1],
      line: parseInt(gradleErrorMatch[2]),
      message: gradleErrorMatch[3],
      detail: line,
      raw: line
    }
  }

  // Gradle warnings: path/to/file.java:123: warning: message
  const gradleWarningMatch = line.match(/([\w/\\\.-]+\.java):(\d+):\s*warning:\s*(.+)/)
  if (gradleWarningMatch) {
    return {
      type: 'gradle-warning',
      file: gradleWarningMatch[1],
      line: parseInt(gradleWarningMatch[2]),
      message: gradleWarningMatch[3],
      detail: line,
      raw: line
    }
  }

  // Java exception in Gradle output
  if (line.match(/^\s*at\s+[\w\.]+\([\w\.]+\.java:\d+\)/) || line.includes('Exception')) {
    return {
      type: 'java-exception',
      message: line.trim(),
      detail: line,
      raw: line
    }
  }

  // BUILD FAILED
  if (line.includes('BUILD FAILED')) {
    return {
      type: 'gradle-error',
      message: '构建失败 (BUILD FAILED)',
      detail: 'Gradle 构建未成功完成，请查看上方错误详情。',
      raw: line
    }
  }

  return null
}

// Parse Minecraft crash report summary
export function parseMcCrashLine(line: string): ParsedError | null {
  if (line.includes('---- Minecraft Crash Report ----') || line.includes('Crash report saved')) {
    return {
      type: 'mc-crash',
      message: 'Minecraft 发生崩溃',
      detail: line,
      raw: line
    }
  }
  return null
}

// Parse any log line for errors
export function parseAnyError(line: string): ParsedError | null {
  return parseGradleError(line) || parseMcCrashLine(line) || null
}

// Extract error context: grab N lines around an error
export function extractErrorContext(lines: string[], errorIndex: number, contextLines = 3): string {
  const start = Math.max(0, errorIndex - contextLines)
  const end = Math.min(lines.length, errorIndex + contextLines + 1)
  return lines.slice(start, end).join('\n')
}

// Build a repair prompt from build errors
export function buildRepairPrompt(errors: ParsedError[], buildOutput: string): string {
  let prompt = '**ModCrafting 自动错误检测**\n\n'
  prompt += `检测到 ${errors.length} 个问题：\n\n`

  errors.forEach((err, i) => {
    prompt += `${i + 1}. [${err.type}] ${err.message}\n`
    if (err.file) prompt += `   文件: ${err.file}${err.line ? `:${err.line}` : ''}\n`
    prompt += `   详情: ${err.detail}\n\n`
  })

  prompt += '--- 构建输出（尾部） ---\n```\n'
  const trimmed = summarizeBuildOutput(buildOutput)
  prompt += trimmed
  prompt += '\n```\n\n'
  prompt += '请用 read_error_log 定位错误后，用 edit_file / write_file / delete_file 逐文件修复，最后 trigger_build 验证。' +
    '禁止只在聊天中贴完整修正代码。若 splitEnvironment 导致 client 类在 src/main/java：先 write_file 到 src/client/java，再 delete_file 删除旧 main 路径。'

  return prompt
}

/** Extract key lines from build output: errors, exceptions, and the last few lines. */
export function summarizeBuildOutput(output: string, maxLines = 40): string {
  const lines = output.split('\n')
  const important: string[] = []
  const errorPatterns = [
    /error:\s/i, /exception/i, /FAILED/i, /FAILURE/i, /caused by/i,
    /^\s*at\s+[\w.]+\(/, /堆栈跟踪/i, /stack trace/i
  ]

  for (const line of lines) {
    if (errorPatterns.some((p) => p.test(line))) {
      // Include context: 2 lines before each error
      const idx = lines.indexOf(line)
      if (idx > 0 && !important.includes(lines[idx - 1])) important.push(lines[idx - 1])
      if (!important.includes(line)) important.push(line)
      if (idx < lines.length - 1 && !important.includes(lines[idx + 1])) important.push(lines[idx + 1])
    }
  }

  // Always include last 10 lines
  const tail = lines.slice(-10)
  for (const line of tail) {
    if (!important.includes(line)) important.push(line)
  }

  return important.slice(-maxLines).join('\n')
}

/** Extract the actionable parts from a Minecraft crash report (skip system details, mod list, etc.). */
export function summarizeCrashReport(content: string, maxChars = 3000): string {
  const lines = content.split('\n')
  const result: string[] = []
  let inSystemDetails = false
  let inModList = false

  for (const line of lines) {
    // Stop at verbose sections
    if (line.startsWith('-- System Details --') || line.startsWith('-- System --')) {
      inSystemDetails = true
      result.push('-- 系统信息（已省略） --')
      continue
    }
    if (line.startsWith('-- Mod List --') || line.includes('Mod List:')) {
      inModList = true
      result.push('-- 模组列表（已省略） --')
      continue
    }
    // Resume after system/mod sections end
    if (inSystemDetails && line.startsWith('-- ')) {
      inSystemDetails = false
    }
    if (inModList && line.startsWith('-- ')) {
      inModList = false
    }

    if (inSystemDetails || inModList) continue

    // Skip verbose stack frame details that are just repeating info
    if (line.trim().startsWith('at ') && result.filter((l) => l.includes('at ')).length > 15) {
      if (!result.includes('... (更多堆栈帧已省略)'))
        result.push('... (更多堆栈帧已省略)')
      continue
    }

    result.push(line)
  }

  const summary = result.join('\n')
  return summary.length > maxChars ? summary.slice(0, maxChars) + '\n... (已截断)' : summary
}
