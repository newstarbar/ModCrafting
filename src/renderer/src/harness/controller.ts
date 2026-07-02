// ======== Controller ========
// Ported from Reasonix internal/control/controller.go
// Session management, plan/execute phases, approval gates

import { type Sink, EventKind, type Event, FuncSink, LoggerSink } from './events'
import { Agent } from './agent'
import { Registry } from './tools'
import { PlanTracker } from './plan-tracker'
import { parsePlanSteps, planHasActionableSteps, selectPlanText, isActionablePlanText } from '../utils/plan-steps'
import { logger } from '../utils/logger'

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
  messages: Array<{ role: string; content: string }> = []
  private _running = false
  private abortController: AbortController | null = null

  private _phase: 'plan' | 'execute' = 'plan'
  private planTracker: PlanTracker | null = null
  private pendingApproval: { id: string; resolve: (allow: boolean) => void } | null = null

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

  setProjectPath(p: string | null): void {
    this._projectPath = p
  }

  setApiConfig(config: { endpoint: string; apiKey: string; model: string }): void {
    this.apiConfig = config
  }

  private emitEvent(event: Event): void {
    this.sink.emit(event)
  }

  /** Heuristic: Q&A vs development task — checked on every user message */
  private isDevelopmentTask(input: string): boolean {
    const trimmed = input.trim()

    const greetingPatterns = /^(你好|您好|嗨|hello|hi|hey|在吗|谢谢|感谢|好的|ok|okay|再见|拜拜)[\s!！。.?？~，,]*$/i
    if (greetingPatterns.test(trimmed)) return false

    const qaPatterns = /^(什么是|为什么|怎么|如何|能否|是否|解释|说明|什么意思|这段|请问)/i
    if (qaPatterns.test(trimmed)) return false

    const devPatterns = /创建|实现|开发|添加|修改|构建|写一个|制作|生成.{0,8}(模组|mod|类|文件|物品|功能)/i
    if (devPatterns.test(trimmed)) return true

    if ((trimmed.endsWith('?') || trimmed.endsWith('？')) && trimmed.length < 120) {
      return false
    }

    // Short casual messages without dev keywords → chat mode
    if (trimmed.length < 24 && !devPatterns.test(trimmed)) return false

    return true
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

    if (mode === 'chat') {
      return `# ModCrafting AI 助手

## 对话模式

你是 Minecraft Fabric 模组开发助手。用户正在向你提问或寻求解释。

规则：
- **直接使用中文回答**，简洁清晰。
- **不要输出编号实施计划**。
- **不要调用任何工具**。
- 可以提供 Java/JSON 代码示例（markdown 代码块）。
- 如果用户后续明确要求开发功能，再进入实施流程。

${projectInfo}`
    }

    const phaseHeader = mode === 'plan'
      ? `## 📋 第一阶段：制定计划

你现在要做的是输出一个**详细的实施计划**。不要调用任何工具。只需列出所有需要创建/修改的文件及其用途。

计划格式要求：
- **每行一个步骤**，使用数字编号：\`1. 步骤描述\`
- 例如：
  1. 创建 src/main/java/.../File.java - 主模组类
  2. 修改 settings.gradle - 配置仓库
  3. 构建项目

计划必须精简：
- **禁止重复步骤，禁止把同一个操作拆成多条**（例如不要既写"构建项目"又写"运行 gradlew build"）。
- **每个操作只出现一次。** 一次构建就是一步，一次运行就是一步。
- 构建/运行类任务通常只需 1-3 步。不要为"确保编译无错误""测试"等再追加重复的构建/运行步骤。

计划输出后系统会自动进入执行阶段。`
      : `## 🔧 第二阶段：执行计划

严格按照之前的计划执行。**不要重新规划**。步骤完成由主机根据工具结果自动判定。

规则：
- **每个文件只写一次。** 不要重复写入。
- **配方/合成任务优先调用 create_recipe。** 不要手写重复 recipe JSON。
- **写完全部文件后调用 trigger_build 构建。**
- **不要主动调用 complete_step。** 直接执行当前步骤需要的工具。
- **全部步骤完成后输出总结。**`

    const extraRules = mode === 'execute'
      ? '\n- **禁止输出计划！** 直接调用工具执行已有计划。\n- **每轮至少调用一个工具。** 不允许只输出文字。'
      : '\n- **不要调用工具，只输出计划文本。**'

    return `# ModCrafting AI 助手
${phaseHeader}

## 最重要的规则（必须遵守）
- **必须使用中文回答！** 所有对话、推理、解释、总结都必须使用中文。只有 Java/JSON 代码内容保持英文。${extraRules}

你是 Minecraft Fabric 模组开发助手。你通过写代码、构建项目和运行测试来帮助用户。

## 可用工具
${toolDescs}

${mode === 'plan' ? '## 当前：输出计划阶段\n只输出计划文本，不要调用工具。' : '## 当前：执行阶段\n直接调用工具执行计划中的每一项。批量调用多个 write_file 提高效率。最后调用 trigger_build 编译。'}

## 重要规则
- **必须使用中文**回答用户。
- **没有步骤限制。**
- **最多 3 轮探索。** 之后探索工具将被锁定。
- 使用 write_file 编写完整、可编译的 Java 代码。
- 创建配方/合成表时优先使用 create_recipe，不要手写 recipe JSON。
- 使用 Yarn mappings。
- 主类 → ModInitializer，客户端类 → ClientModInitializer。

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

  private async runTurn(input: string, options: { pushUser: boolean }): Promise<string> {
    if (this._running) return ''

    this._running = true
    this.abortController = new AbortController()
    this.agent.resetRunState()

    const isDev = this.isDevelopmentTask(input)
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
      if (!isDev) {
        await this.updateSystemPrompt('chat')
        const result = await this.agent.run(
          this.apiConfig.endpoint,
          this.apiConfig.apiKey,
          this.apiConfig.model,
          this.messages,
          this._projectPath,
          this.abortController.signal,
          streamCb,
          { phase: 'plan', emitLifecycle: true }
        )
        this.onAgentStatus?.('')
        return result
      }

      if (this._phase === 'plan') {
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
          { phase: 'plan', emitLifecycle: false }
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
          this.emitEvent({ kind: EventKind.TurnDone })
          return planResult
        }

        this._phase = 'execute'
        await this.updateSystemPrompt('execute')
        this.planTracker = PlanTracker.fromPlanText(fullPlanText)
        if (this.planTracker.steps.length > 0) {
          this.planTracker.markRunning()
          this.emitPlanState(this.planTracker)
        }
        this.messages.push({
          role: 'user',
          content: this.planTracker.steps.length > 0
            ? this.buildExecuteConfirmMessage(this.planTracker)
            : '计划已确认。现在开始执行计划，调用工具实现上述方案。'
        })

        this.emitEvent({ kind: EventKind.Phase, phase: 'execute_start' })
        this.onAgentStatus?.('执行中...')

        const execResult = await this.agent.run(
          this.apiConfig.endpoint,
          this.apiConfig.apiKey,
          this.apiConfig.model,
          this.messages,
          this._projectPath,
          this.abortController.signal,
          streamCb,
          {
            phase: 'execute',
            emitLifecycle: true,
            planTracker: this.planTracker,
            opsOnlyPlan: this.planTracker?.isOpsOnly() ?? false
          }
        )

        this.onAgentStatus?.('')
        return execResult || planResult
      }

      await this.updateSystemPrompt('execute')
      const result = await this.agent.run(
        this.apiConfig.endpoint,
        this.apiConfig.apiKey,
        this.apiConfig.model,
        this.messages,
        this._projectPath,
        this.abortController.signal,
        streamCb,
        {
          phase: 'execute',
          emitLifecycle: true,
          planTracker: this.planTracker,
          opsOnlyPlan: this.planTracker?.isOpsOnly() ?? false
        }
      )

      this.onAgentStatus?.('')
      return result
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error('Controller send error', errMsg)
      this.onAgentStatus?.(`错误: ${errMsg}`)
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
    this.agent.resetRunState()
    logger.agent('Session cleared')
  }

  getSnapshot(): Array<{ role: string; content: string }> {
    return [...this.messages]
  }

  restoreSnapshot(messages: Array<{ role: string; content: string }>): void {
    this.messages = [...messages]
    this._phase = messages.some((m) => m.role === 'user' || m.role === 'assistant') ? 'execute' : 'plan'
    this.agent.resetRunState()
  }
}
