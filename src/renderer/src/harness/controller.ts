// ======== Controller ========
// Ported from Reasonix internal/control/controller.go
// Session management, plan/execute phases, approval gates

import { type Sink, EventKind, type Event, FuncSink, LoggerSink } from './events'
import { Agent } from './agent'
import type { ChatMessage } from './chat-message'
import { Registry } from './tools'
import { PlanTracker } from './plan-tracker'
import { parsePlanSteps, planHasActionableSteps, selectPlanText, isActionablePlanText } from '../utils/plan-steps'
import { logger } from '../utils/logger'
import { buildFabricAgentPolicyPrompt } from './fabric-agent-policy'
import { isRetryableFetchError } from './fetch-retry'
import {
  type ComposerMode,
  resolveTurnIntent,
  buildSessionGoalBlock
} from './turn-intent'

export interface ControllerOptions {
  registry: Registry
  projectPath: string | null
  apiConfig: { endpoint: string; apiKey: string; model: string }
  onEvent?: (event: Event) => void
  onAgentStatus?: (status: string) => void
  onStreamUpdate?: (text: string, reasoning?: string) => void
}

export class Controller {
  private agent: Agent
  private registry: Registry
  private sink: Sink
  private _projectPath: string | null

  apiConfig: { endpoint: string; apiKey: string; model: string }

  // Session
  messages: ChatMessage[] = []
  private _running = false
  private abortController: AbortController | null = null

  private _phase: 'plan' | 'execute' = 'plan'
  private planTracker: PlanTracker | null = null
  private pendingApproval: { id: string; resolve: (allow: boolean) => void } | null = null
  private composerMode: ComposerMode = 'agent'
  private sessionGoal = ''
  private planReadyAwaitingExecute = false
  private lastTurnMode: 'chat' | 'develop' | 'plan_only' | 'resume' = 'chat'

  // Callbacks
  onEvent?: (event: Event) => void
  onAgentStatus?: (status: string) => void
  onStreamUpdate?: (text: string, reasoning?: string) => void

  constructor(opts: ControllerOptions) {
    this.registry = opts.registry
    this._projectPath = opts.projectPath
    this.apiConfig = opts.apiConfig
    this.onEvent = opts.onEvent
    this.onAgentStatus = opts.onAgentStatus
    this.onStreamUpdate = opts.onStreamUpdate

    this.sink = new LoggerSink(
      new FuncSink((event) => {
        this.onEvent?.(event)
      })
    )

    this.agent = new Agent({
      registry: this.registry,
      sink: this.sink,
      onToolDispatch: (name) => {
        this.onAgentStatus?.(`执行: ${name}...`)
      },
      onToolResult: (name, _id, output) => {
        this.onAgentStatus?.(`${name} 完成`)
        logger.tool(`${name} completed`, output.slice(0, 100))
      }
    })
  }

  get running(): boolean { return this._running }
  get projectPath(): string | null { return this._projectPath }
  get phase(): 'plan' | 'execute' { return this._phase }
  get isPlanReady(): boolean { return this.planReadyAwaitingExecute }
  get lastTurnModeSnapshot(): typeof this.lastTurnMode { return this.lastTurnMode }
  get composerModeSnapshot(): ComposerMode { return this.composerMode }

  setComposerMode(mode: ComposerMode): void {
    this.composerMode = mode
  }

  setSessionGoal(goal: string): void {
    this.sessionGoal = goal.trim()
  }

  getSessionGoal(): string {
    return this.sessionGoal
  }

  setProjectPath(p: string | null): void {
    this._projectPath = p
  }

  setApiConfig(config: { endpoint: string; apiKey: string; model: string }): void {
    this.apiConfig = config
  }

  setRegistry(registry: Registry): void {
    this.registry = registry
    this.agent.setRegistry(registry)
  }

  private emitEvent(event: Event): void {
    this.sink.emit(event)
  }

  private intentContext(): Parameters<typeof resolveTurnIntent>[1] {
    return {
      phase: this._phase,
      planTracker: this.planTracker,
      hasProject: Boolean(this._projectPath),
      composerMode: this.composerMode
    }
  }

  /** Skip execute when plan has no concrete steps */
  private isActionablePlan(planText: string): boolean {
    return isActionablePlanText(planText)
  }

  private buildExecuteConfirmMessage(tracker: PlanTracker): string {
    const current = tracker.currentStep
    if (!current) {
      return '计划已确认。全部步骤已完成，请输出总结。'
    }
    let content =
      `计划已确认。当前执行步骤 #${current.id}：${current.description}\n` +
      `串行工作流：执行当前步骤所需工具；主机会根据工具结果自动推进到下一步。` +
      `禁止重复已成功工具，禁止跳过步骤。\n` +
      tracker.toContextBlock()
    if (tracker.isOpsOnly()) {
      content += '\n本项目为构建/运行任务，无需 list_directory/read_file 探索。直接从当前步骤开始执行。'
    }
    return content
  }

  private emitPlanState(tracker: PlanTracker): void {
    this.emitEvent({
      kind: EventKind.PlanState,
      planSteps: tracker.snapshot()
    })
  }

  private async buildProjectInfo(): Promise<string> {
    let projectInfo = ''
    if (this._projectPath) {
      projectInfo = `## 项目信息\n项目路径：${this._projectPath}\n`
      try {
        const mainJava = `${this._projectPath}/src/main/java`
        const entries = await window.api.listDirectory(mainJava)
        if (entries.length > 0) {
          const packages: string[] = []
          const walkDir = async (dir: string, prefix: string) => {
            const sub = await window.api.listDirectory(dir)
            for (const e of sub) {
              if (e.isDirectory) {
                const pkg = prefix ? `${prefix}.${e.name}` : e.name
                packages.push(pkg)
                await walkDir(e.path, pkg)
              }
            }
          }
          for (const e of entries) {
            if (e.isDirectory) await walkDir(e.path, e.name)
          }
          if (packages.length > 0) {
            projectInfo += `源码包路径：${packages.join(', ')}\n`
            projectInfo += `包名用点号分隔，例如：com.example.modname\n`
          }
        }
        const clientJava = `${this._projectPath}/src/client/java`
        const clientEntries = await window.api.listDirectory(clientJava).catch(() => [])
        if (clientEntries.length > 0) {
          projectInfo += `客户端源码目录：src/client/java\n`
        }
      } catch {
        // ignore scan errors
      }
    }
    return projectInfo
  }

  // Build system prompt with tool descriptions and Fabric knowledge
  private async buildSystemPrompt(mode: 'chat' | 'plan' | 'execute'): Promise<string> {
    const toolNameMap: Record<string, string> = {
      read_file: '读取文件',
      write_file: '写入文件',
      list_directory: '列出目录',
      run_command: '运行命令',
      trigger_build: '触发构建',
      create_recipe: '创建配方',
      fabric_docs_search: '查询 Fabric 文档',
      fabric_javadoc_lookup: '查询 Fabric JavaDoc',
      vanilla_mc_wiki_query: '查询原版 Wiki',
      fabric_meta_version_check: '查询 Fabric 版本',
      fabric_mod_json_validate: '校验 fabric.mod.json',
      fabric_recipe_generate: '生成 Fabric 配方',
      fabric_content_register: '生成内容注册',
      fabric_data_assets_generate: '生成资源数据',
      fabric_mixin_scaffold: '生成 Mixin 脚手架',
      fabric_log_debugger: '分析 Fabric 日志',
      read_error_log: '读取错误日志',
      complete_step: '完成任务步骤'
    }
    const toolDescs = this.registry.names().filter((name) => name !== 'complete_step').map((name) => {
      const t = this.registry.get(name)
      const cn = toolNameMap[name] || name
      const kind = t?.readOnly() ? '（只读）' : '（写入）'
      return t ? `- **${cn}** (\`${t.name}\`): ${t.description} ${kind}` : ''
    }).join('\n')

    const projectInfo = await this.buildProjectInfo()
    const fabricPolicy = buildFabricAgentPolicyPrompt(mode)
    const goalBlock = buildSessionGoalBlock(this.sessionGoal)

    if (mode === 'chat') {
      return `# ModCrafting AI 助手

## 对话模式

你是 Minecraft Fabric 模组开发助手。用户正在向你提问或寻求解释。

规则：
- **直接使用中文回答**，简洁清晰，不要写长篇分析。
- **禁止方案推演。** 如果用户问"怎么做"，直接给出最佳实践方案，不比较多个方案。
- **不要输出编号实施计划**（除非用户明确要求开发）。
- **不要调用任何工具**。
- 可以提供 Java/JSON 代码示例（markdown 代码块）。
- 如果用户后续明确要求开发功能，再进入实施流程。

${goalBlock}

${fabricPolicy}

${projectInfo}`
    }

    const phaseHeader = mode === 'plan'
      ? `## 📋 第一阶段：制定计划

输出风格硬约束：
- 禁止方案对比推演。选定技术路线后不再回头讨论替代方案。
- 最多 3 句背景说明（共不超过 80 字），然后直接列出步骤。
- 不要解释概念或写分析段落。

输出结构化实施计划。不要调用任何工具。

计划格式要求：
- **每行一个步骤**：\`N. [kind] 简短标题 — 目标路径\`
- **kind** 仅允许：\`write\` | \`recipe\` | \`inspect\`
- 示例：
  1. [write] src/main/java/.../Mixin.java — 二段跳逻辑
  2. [recipe] data/<modid>/recipe/jump_boots.json — 跳跃靴配方

计划必须精简：
- **禁止写构建/运行步骤**（主机会自动追加 gradlew build 与 runClient）。
- **禁止空泛步骤**（确保无错、测试功能、输出总结）。
- **每步只做一件事**；最多 6 步。
- **禁止重复步骤。**`
      : `## 🔧 第二阶段：执行计划

输出风格硬约束：
- 每轮回复的非工具文字不超过 3 句。超出视为违规。
- 不要写分析段落、方案论证或概念解释。
- 旁白只告知"当前在做什么"（如"正在写入 Mixin..."），不告知"为什么"。
- 直接调用工具执行，禁止只输出文字不行动。

严格按照之前的计划执行。**不要重新规划**。步骤完成由主机根据工具结果自动判定。

规则：
- **每个文件只写一次。** 不要重复写入。
- **配方/合成任务优先调用 create_recipe。** 不要手写重复 recipe JSON。
- **写完全部文件后，通过 trigger_build 构建，再通过 trigger_build(runClient) 启动真实测试。**
- **运行测试需等待游戏真正进入可玩状态后才算完成。**
- **不要主动调用 complete_step。** 直接执行当前步骤需要的工具。
- **全部步骤完成后输出总结。**`

    const extraRules = mode === 'execute'
      ? '\n- **禁止输出计划！** 直接调用工具执行已有计划。\n- **每轮至少调用一个工具。** 不允许只输出文字。\n- **每轮的非工具旁白文字不超过 3 句。** 不要写分析段落。'
      : '\n- **不要调用工具，只输出计划文本。**\n- **最多 3 句背景说明，然后直接列出步骤。** 禁止方案推演。'

    return `# ModCrafting AI 助手
${phaseHeader}

## 最重要的规则（必须遵守）
- **必须使用中文回答！** 所有对话、推理、解释、总结都必须使用中文。只有 Java/JSON 代码内容保持英文。
- **禁止输出方案推演过程。** 不要写"方案A vs 方案B"的分析段落。选定方案，一句话说明，直接行动。${extraRules}

你是 Minecraft Fabric 模组开发助手。你通过写代码、构建项目和运行测试来帮助用户。你的输出风格是专业、果断、行动优先——像资深开发者，不像学生做作业。

## 可用工具
${toolDescs}

${mode === 'plan' ? '## 当前：输出计划阶段\n只输出计划文本，不要调用工具。' : '## 当前：执行阶段\n直接调用工具执行计划中的每一项。批量调用多个 write_file 提高效率。最后通过 trigger_build 构建并启动游戏进行真实测试（日志在右侧面板显示）。'}

## 重要规则
- **必须使用中文**回答用户。
- **写代码前先用 fabric_docs_search 查 Yarn 类名/方法名/字段名，不要凭记忆硬猜。**
- **没有步骤限制。**
- **最多 3 轮探索。** 之后探索工具将被锁定。
- 使用 write_file 编写完整、可编译的 Java 代码。
- 创建配方/合成表时优先使用 fabric_recipe_generate 或 create_recipe，不要手写 recipe JSON。
- 使用 Yarn mappings。
- 主类 → ModInitializer，客户端类 → ClientModInitializer。

${goalBlock}

${fabricPolicy}

${projectInfo}`
  }

  private async updateSystemPrompt(mode: 'chat' | 'plan' | 'execute'): Promise<void> {
    const prompt = await this.buildSystemPrompt(mode)
    const sysIdx = this.messages.findIndex((m) => m.role === 'system')
    if (sysIdx >= 0) {
      this.messages[sysIdx] = { role: 'system', content: prompt }
    } else {
      this.messages.unshift({ role: 'system', content: prompt })
    }
  }

  private trimTrailingAssistants(): void {
    while (this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1]
      if (last.role === 'assistant') {
        this.messages.pop()
        continue
      }
      break
    }
  }

  private async runChatTurn(streamCb: (text: string, reasoning?: string) => void): Promise<string> {
    await this.updateSystemPrompt('chat')
    const result = await this.agent.run(
      this.apiConfig.endpoint,
      this.apiConfig.apiKey,
      this.apiConfig.model,
      this.messages,
      this._projectPath,
      this.abortController!.signal,
      streamCb,
      { phase: 'plan', emitLifecycle: true, turnMode: 'chat', composerMode: this.composerMode }
    )
    return result
  }

  private async runExecutePhase(streamCb: (text: string, reasoning?: string) => void): Promise<string> {
    await this.updateSystemPrompt('execute')
    this._phase = 'execute'
    this.planReadyAwaitingExecute = false
    if (this.planTracker && this.planTracker.steps.length > 0) {
      this.planTracker.markRunning()
      this.emitPlanState(this.planTracker)
    }
    this.emitEvent({ kind: EventKind.Phase, phase: 'execute_start' })
    this.onAgentStatus?.('执行中...')

    return this.agent.run(
      this.apiConfig.endpoint,
      this.apiConfig.apiKey,
      this.apiConfig.model,
      this.messages,
      this._projectPath,
      this.abortController!.signal,
      streamCb,
      {
        phase: 'execute',
        emitLifecycle: true,
        planTracker: this.planTracker,
        opsOnlyPlan: this.planTracker?.isOpsOnly() ?? false
      }
    )
  }

  private async beginExecuteFromTracker(streamCb: (text: string, reasoning?: string) => void): Promise<string> {
    if (!this.planTracker || this.planTracker.steps.length === 0) {
      this.emitEvent({ kind: EventKind.Notice, notice: { level: 'warn', text: '没有可执行的计划' } })
      this.emitEvent({ kind: EventKind.TurnDone, phase: 'plan_ready' })
      return ''
    }
    this.messages.push({
      role: 'user',
      content: this.buildExecuteConfirmMessage(this.planTracker)
    })
    return this.runExecutePhase(streamCb)
  }

  private async runTurn(input: string, options: { pushUser: boolean }): Promise<string> {
    if (this._running) return ''

    this._running = true
    this.abortController = new AbortController()
    this.agent.resetRunState()

    const intent = resolveTurnIntent(input, this.intentContext())
    this.lastTurnMode = intent === 'plan_only' ? 'plan_only' : intent

    if (options.pushUser) {
      this.messages.push({ role: 'user', content: input })
    }
    this.onAgentStatus?.('思考中...')

    let planStreamReasoning = ''
    let planStreamText = ''
    const streamCb = (text: string, reasoning?: string) => {
      if (text) planStreamText = text
      if (reasoning) planStreamReasoning = reasoning
      this.onStreamUpdate?.(text, reasoning)
    }

    try {
      if (intent === 'chat') {
        const result = await this.runChatTurn(streamCb)
        this.onAgentStatus?.('')
        return result
      }

      if (intent === 'resume') {
        if (!this.planTracker) {
          this.onAgentStatus?.('')
          this.emitEvent({
            kind: EventKind.Notice,
            notice: { level: 'warn', text: '没有可恢复的计划，请先描述功能或生成计划。' }
          })
          this.emitEvent({ kind: EventKind.TurnDone, phase: 'resume_missing_plan' })
          return ''
        }
        const result = await this.beginExecuteFromTracker(streamCb)
        this.onAgentStatus?.('')
        return result
      }

      if (intent === 'develop' && this._phase === 'execute' && this.planTracker && !this.planTracker.allDone()) {
        const result = await this.runExecutePhase(streamCb)
        this.onAgentStatus?.('')
        return result
      }

      if (intent === 'develop' || intent === 'plan_only') {
        if (intent === 'plan_only') {
          this._phase = 'plan'
          this.planTracker = null
          this.planReadyAwaitingExecute = false
        }

        await this.updateSystemPrompt('plan')
        this.emitEvent({ kind: EventKind.Phase, phase: 'plan_start' })

        const planResult = await this.agent.run(
          this.apiConfig.endpoint,
          this.apiConfig.apiKey,
          this.apiConfig.model,
          this.messages,
          this._projectPath,
          this.abortController.signal,
          streamCb,
          { phase: 'plan', emitLifecycle: false, turnMode: intent, composerMode: this.composerMode }
        )

        const fullPlanText = selectPlanText(planStreamReasoning, planStreamText, planResult)
        logger.agent('Plan merged', {
          steps: parsePlanSteps(fullPlanText).length,
          actionable: this.isActionablePlan(fullPlanText)
        })

        this.emitEvent({ kind: EventKind.Phase, phase: 'plan_done', text: fullPlanText })
        this.emitEvent({ kind: EventKind.Phase, phase: 'plan_stream_end' })

        if (!this.isActionablePlan(fullPlanText)) {
          this.onAgentStatus?.('')
          this.emitEvent({
            kind: EventKind.Notice,
            notice: {
              level: 'warn',
              text: planHasActionableSteps(fullPlanText)
                ? '计划已生成但缺少可执行步骤描述，未进入执行阶段'
                : '未能解析出编号实施步骤，未进入执行阶段'
            }
          })
          if (intent !== 'plan_only') {
            this.emitEvent({ kind: EventKind.TurnDone })
          }
          return planResult
        }

        this.planTracker = PlanTracker.fromPlanText(fullPlanText)
        this.emitPlanState(this.planTracker)

        if (intent === 'plan_only') {
          this._phase = 'plan'
          this.planReadyAwaitingExecute = true
          this.onAgentStatus?.('')
          this.emitEvent({ kind: EventKind.Phase, phase: 'plan_ready' })
          this.emitEvent({ kind: EventKind.TurnDone, phase: 'plan_ready', composerMode: this.composerMode })
          return planResult
        }

        const execResult = await this.beginExecuteFromTracker(streamCb)
        this.onAgentStatus?.('')
        return execResult || planResult
      }

      const result = await this.runExecutePhase(streamCb)
      this.onAgentStatus?.('')
      return result
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error('Controller send error', errMsg)
      const incompletePlan = this.planTracker && !this.planTracker.allDone()
      if (incompletePlan && isRetryableFetchError(err)) {
        this.messages.push({
          role: 'system',
          content:
            `【系统】执行因网络错误中断：${errMsg}。计划未完成，发送「继续」可从当前步骤恢复。`
        })
        this.emitEvent({
          kind: EventKind.Notice,
          notice: {
            level: 'warn',
            text: `网络请求失败：${errMsg}。计划未完成，可发送「继续」恢复执行。`
          }
        })
      } else {
        this.onAgentStatus?.(`错误: ${errMsg}`)
      }
      this.emitEvent({ kind: EventKind.TurnDone, error: errMsg })
      return `Error: ${errMsg}`
    } finally {
      this._running = false
      this.abortController = null
    }
  }

  async startExecuteFromPlan(): Promise<string> {
    if (this._running) return ''
    if (!this.planTracker || this.planTracker.steps.length === 0) {
      this.emitEvent({ kind: EventKind.Notice, notice: { level: 'warn', text: '没有可执行的计划' } })
      return ''
    }

    this._running = true
    this.abortController = new AbortController()
    this.agent.resetRunState()
    this.onAgentStatus?.('执行中...')

    const streamCb = (text: string, reasoning?: string) => {
      this.onStreamUpdate?.(text, reasoning)
    }

    try {
      const result = await this.beginExecuteFromTracker(streamCb)
      this.onAgentStatus?.('')
      return result
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.emitEvent({ kind: EventKind.TurnDone, error: errMsg })
      return `Error: ${errMsg}`
    } finally {
      this._running = false
      this.abortController = null
    }
  }

  // Send user message — main entry point
  async send(input: string): Promise<string> {
    if (this._running) {
      logger.agent('Queuing steer message')
      this.messages.push({ role: 'user', content: '[mid-turn] ' + input })
      return ''
    }
    return this.runTurn(input, { pushUser: true })
  }

  /** Re-run the last user turn without duplicating the user message */
  async retryFromUser(): Promise<string> {
    if (this._running) return ''

    this.trimTrailingAssistants()
    const lastUser = [...this.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return ''

    // Drop injected execute-confirm prompts so plan phase can run again
    while (this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1]
      if (last.role === 'user' && last !== lastUser) {
        this.messages.pop()
        continue
      }
      break
    }

    this._phase = 'plan'
    this.planTracker = null
    return this.runTurn(lastUser.content, { pushUser: false })
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort()
      this._running = false
      logger.agent('Turn cancelled')
    }
  }

  approve(id: string, allow: boolean): void {
    if (this.pendingApproval && this.pendingApproval.id === id) {
      this.pendingApproval.resolve(allow)
      this.pendingApproval = null
    }
  }

  clearSession(): void {
    this.messages = []
    this._phase = 'plan'
    this.planTracker = null
    this.planReadyAwaitingExecute = false
    this.agent.resetRunState()
    logger.agent('Session cleared')
  }

  /** Export current session messages to a JSON file on desktop. */
  async exportSession(): Promise<string> {
    const toolContentLimit = 2500
    const assistantContentLimit = 1000
    const systemContentLimit = 500

    const trimmed = this.messages.map((m) => {
      if (m.role === 'tool' && m.content && m.content.length > toolContentLimit) {
        return {
          ...m,
          content: m.content.slice(0, toolContentLimit) +
            `\n\n... [截断：原始 ${m.content.length} 字符]`
        }
      }
      if (m.role === 'assistant' && m.content && m.content.length > assistantContentLimit) {
        return {
          ...m,
          content: m.content.slice(0, assistantContentLimit) +
            `\n\n... [截断：原始 ${m.content.length} 字符]`
        }
      }
      if (m.role === 'system' && m.content && m.content.length > systemContentLimit) {
        return {
          ...m,
          content: m.content.slice(0, systemContentLimit) +
            `\n\n... [完整提示词已在工程源码中，此处省略]`
        }
      }
      return m
    })

    const exportObj = {
      exportedAt: new Date().toISOString(),
      sessionGoal: this.sessionGoal || '(未设定)',
      phase: this._phase,
      model: this.apiConfig.model,
      endpoint: this.apiConfig.endpoint.replace(/\/\/.*@/, '//***@'), // strip credentials
      messageCount: this.messages.length,
      messages: trimmed
    }

    const result = await window.api.sessionExport(
      JSON.stringify(exportObj, null, 2),
      'mc-session'
    )
    if (result.success) {
      logger.agent('Session exported', result.path)
      return result.path
    }
    throw new Error('导出失败')
  }

  getSnapshot(): ChatMessage[] {
    return [...this.messages]
  }

  restoreSnapshot(messages: ChatMessage[]): void {
    this.messages = [...messages]
    this._phase = messages.some((m) => m.role === 'user' || m.role === 'assistant') ? 'execute' : 'plan'
    this.agent.resetRunState()
  }
}
