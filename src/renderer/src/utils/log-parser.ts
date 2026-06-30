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

  prompt += '--- 构建输出 ---\n```\n'
  // Take last 200 lines of build output
  const outputLines = buildOutput.split('\n')
  prompt += outputLines.slice(-200).join('\n')
  prompt += '\n```\n\n'
  prompt += '请分析以上错误并给出修复方案。对于每个需要修改的文件，请以注释形式指明文件路径，并给出完整的修正代码。'

  return prompt
}
