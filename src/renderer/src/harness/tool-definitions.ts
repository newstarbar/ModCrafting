// ======== ModCrafting Tool Definitions ========
// Built-in tools for the Fabric mod development environment

import { type Tool, type ToolContext, type Previewer } from './tools'
import type { FileDiff } from './events'

// ── read_file ──
export const readFileTool: Tool & Previewer = {
  name: 'read_file',
  description: 'Read the content of a file. Path is relative to project root.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from project root' }
    },
    required: ['path']
  },
  readOnly: () => true,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const filePath = `${ctx.projectPath}/${args.path}`
    try {
      const res = await window.api.readFile(filePath)
      if (res.success) return res.content || '(empty file)'
      return `Error: ${res.error}`
    } catch (err) {
      return `Error reading file: ${err}`
    }
  },
  preview: () => null
}

// ── write_file ──
export const writeFileTool: Tool & Previewer = {
  name: 'write_file',
  description: 'Write content to a file. Path is relative to project root. Creates directories automatically.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from project root' },
      content: { type: 'string', description: 'Full file content to write' }
    },
    required: ['path', 'content']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const filePath = `${ctx.projectPath}/${args.path}`
    const content = String(args.content || '')
    try {
      const res = await window.api.writeFile(filePath, content)
      if (res.success) {
        // Log file change
        logger.file(`Written: ${args.path}`, `${content.length} bytes`)
        return `✅ Written: ${args.path} (${content.length} bytes)`
      }
      return `Error: ${res.error}`
    } catch (err) {
      return `Error writing file: ${err}`
    }
  },
  preview(args: Record<string, unknown>): FileDiff | null {
    const path = String(args.path || '')
    const content = String(args.content || '')
    return {
      path,
      added: content.split('\n').length,
      removed: 0,
      content
    }
  }
}

// ── list_directory ──
export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List files and directories. Path is relative to project root. Empty string lists root.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path (default: root)' }
    }
  },
  readOnly: () => true,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const dirPath = args.path ? `${ctx.projectPath}/${args.path}` : ctx.projectPath
    try {
      const entries = await window.api.listDirectory(dirPath)
      const lines = entries.map((e: { name: string; isDirectory: boolean }) =>
        e.isDirectory ? `${e.name}/` : e.name
      )
      return lines.join('\n') || '(empty directory)'
    } catch (err) {
      return `Error listing directory: ${err}`
    }
  }
}

// ── run_command ──
export const runCommandTool: Tool = {
  name: 'run_command',
  description: 'Run a shell command in the project directory. Use for building, testing, or git operations.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' }
    },
    required: ['command']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    try {
      const command = String(args.command || '')
      const prep = await window.api.prepareBuild(ctx.projectPath)
      const fullCmd = prep.ok ? prep.cmdPrefix + command : command
      const res = await window.api.runCommandStream(fullCmd, ctx.projectPath)
      const output = res.output || '(no output)'
      const exitInfo = res.exitCode !== null ? `\n[exit code: ${res.exitCode}]` : ''
      if (!prep.ok && prep.error) return `环境准备失败: ${prep.error}\n${output}${exitInfo}`
      return output + exitInfo
    } catch (err) {
      return `Error running command: ${err}`
    }
  }
}

// ── read_error_log ──
export const readErrorLogTool: Tool = {
  name: 'read_error_log',
  description: 'Read build error logs or crash reports to help debug issues.',
  schema: {
    type: 'object',
    properties: {
      logType: {
        type: 'string',
        enum: ['last-build', 'last-crash'],
        description: 'Type of log to read'
      }
    },
    required: ['logType']
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const logType = String(args.logType || 'last-build')
    // Try to read from known log locations
    try {
      if (logType === 'last-crash' && _ctx.projectPath) {
        const crashReports = `${_ctx.projectPath}/run/crash-reports`
        const entries = await window.api.listDirectory(crashReports)
        if (entries.length > 0) {
          const latest = entries.sort((a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name))[0]
          const res = await window.api.readFile(latest.path)
          if (res.success) return res.content.slice(0, 4000)
        }
      }
      if (logType === 'last-build' && _ctx.projectPath) {
        const candidates = [
          `${_ctx.projectPath}/build/reports/problems/problems-report.html`,
          `${_ctx.projectPath}/build/reports/tests/test/index.html`,
          `${_ctx.projectPath}/run/logs/latest.log`
        ]
        for (const p of candidates) {
          if (await window.api.exists(p)) {
            const res = await window.api.readFile(p)
            if (res.success && res.content) return res.content.slice(0, 4000)
          }
        }
      }
      return `[${logType}]: No log file found. Run a build first, or check the terminal panel.`
    } catch {
      return `[${logType}]: No log file found.`
    }
  }
}

// ── trigger_build ──
export const triggerBuildTool: Tool = {
  name: 'trigger_build',
  description: 'Trigger a Gradle build in the project directory.',
  schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        enum: ['build', 'runClient'],
        description: 'Gradle task to run'
      }
    },
    required: ['task']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const task = String(args.task || 'build')

    if (task === 'runClient') {
      try {
        const res = await window.api.mcStartOrCreate(ctx.projectPath)
        if (!res.success) {
          return `Error starting game: ${res.error || 'unknown error'}`
        }
        return `已启动游戏实例（${res.id || 'mc'}）。请在右侧「游戏」面板查看进度。`
      } catch (err) {
        return `Error starting game: ${err}`
      }
    }

    try {
      const res = await window.api.runGradleTask(ctx.projectPath, task)
      const output = res.output || `Task "${task}" completed (exit: ${res.exitCode})`
      const exitInfo = res.exitCode !== 0 ? `\n[退出码: ${res.exitCode}]` : ''
      const fallbackNote = res.usedOnlineFallback ? '\n[已联网补全依赖缓存]' : ''
      return output + exitInfo + fallbackNote
    } catch (err) {
      return `Error running build: ${err}`
    }
  }
}

// ── complete_step ──
export const completeStepTool: Tool = {
  name: 'complete_step',
  description: 'Mark a plan step as completed. Call this when you finish implementing a step from the plan.',
  schema: {
    type: 'object',
    properties: {
      stepId: {
        type: 'string',
        description: 'The step ID (number or description prefix) to mark complete'
      }
    },
    required: ['stepId']
  },
  readOnly: () => false,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const stepId = String(args.stepId || '')
    return `[STEP_DONE:${stepId}]`
  }
}

// Register all built-in tools
import { Registry } from './tools'
import { logger } from '../utils/logger'

export function registerModCraftingTools(registry: Registry): void {
  registry.add(readFileTool)
  registry.add(writeFileTool)
  registry.add(listDirectoryTool)
  registry.add(runCommandTool)
  registry.add(readErrorLogTool)
  registry.add(triggerBuildTool)
  registry.add(completeStepTool)
  logger.agent('Tools registered', registry.names())
}
