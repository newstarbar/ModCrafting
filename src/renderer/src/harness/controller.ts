// ======== Controller ========
// Ported from Reasonix internal/control/controller.go
// Session management, plan/execute phases, approval gates

import { type Sink, EventKind, type Event, FuncSink, LoggerSink } from './events'
import { Agent } from './agent'
import type { ChatMessage } from './chat-message'
import { Registry } from './tools'
import { PlanTracker } from './plan-tracker'
import { parsePlanSteps, planHasActionableSteps, selectPlanText, selectVisiblePlanText, isActionablePlanText } from '../utils/plan-steps'
import { logger } from '../utils/logger'
import { buildFabricAgentPolicyPrompt } from './fabric-agent-policy'
import { isRetryableFetchError } from './fetch-retry'
import {
  type ComposerMode,
  resolveTurnIntent,
  buildSessionGoalBlock
} from './turn-intent'
import { isQuickCreateGeneratedMessage } from '../project/template-params.ts'

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

  private emitPlanDonePhase(
    planStreamReasoning: string,
    planStreamText: string,
    planResult: string
  ): string {
    const fullPlanText = selectPlanText(planStreamReasoning, planStreamText, planResult)
    const visiblePlanText = selectVisiblePlanText(planStreamText, planResult)
    const actionable = this.isActionablePlan(fullPlanText)
    logger.agent('Plan merged', {
      steps: parsePlanSteps(fullPlanText).length,
      visibleSteps: parsePlanSteps(visiblePlanText).length,
      actionable
    })
    this.emitEvent({
      kind: EventKind.Phase,
      phase: 'plan_done',
      text: visiblePlanText,
      planActionable: actionable
    })
    this.emitEvent({ kind: EventKind.Phase, phase: 'plan_stream_end' })
    return fullPlanText
  }

  private planFailureNotice(fullPlanText: string, retried = false): string {
    const prefix = retried ? '两次尝试均未能生成可执行计划。' : '未能生成可执行计划。'
    const detail = planHasActionableSteps(fullPlanText)
      ? '计划含编号步骤但缺少目标路径（如 src/main/java/...）。'
      : '未能解析出符合格式的编号步骤。'
    return (
      `${prefix}${detail}请直接发送计划，例如：\n` +
      '1. [inspect] 确认 API — fabric_docs_search\n' +
      '2. [write] src/main/java/com/example/my_mod/Handler.java — 功能实现\n' +
      '3. [write] src/main/java/com/example/my_mod/MyMod.java — 注册入口'
    )
  }

  private async buildProjectInfo(): Promise<string> {
    let projectInfo = ''
    if (!this._projectPath) return projectInfo

    projectInfo = `## 项目信息\n项目路径：${this._projectPath}\n`

    // 1. Scan Java packages
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
        }
      }
    } catch { /* ignore scan errors */ }

    // 2. Read fabric.mod.json (mod id, entrypoints, mixin ref)
    try {
      const modJsonPath = `${this._projectPath}/src/main/resources/fabric.mod.json`
      const content = await window.api.readFile(modJsonPath)
      const parsed = JSON.parse(content)
      const modId = parsed.id || ''
      if (modId) {
        projectInfo += `Mod ID：${modId}\n`
        if (parsed.entrypoints?.main?.length) {
          projectInfo += `入口点：${parsed.entrypoints.main.join(', ')}\n`
        }
        if (parsed.mixins?.length) {
          projectInfo += `Mixin 配置：${parsed.mixins.join(', ')}\n`
        }
      }
    } catch { /* file may not exist */ }

    // 3. List resources directory (assets, data, actual mixin config filename)
    try {
      const resourcesDir = `${this._projectPath}/src/main/resources`
      const resEntries = await window.api.listDirectory(resourcesDir)
      const topItems = resEntries.map((e) => e.name).join(', ')
      if (topItems) {
        projectInfo += `资源目录：${topItems}\n`
      }
    } catch { /* ignore */ }

    // 4. Read mixin configs for existing entries
    try {
      const resourcesDir = `${this._projectPath}/src/main/resources`
      const resEntries = await window.api.listDirectory(resourcesDir)
      for (const e of resEntries) {
        if (e.name.endsWith('.mixins.json')) {
          try {
            const mixinPath = `${this._projectPath}/src/main/resources/${e.name}`
            const content = await window.api.readFile(mixinPath)
            const parsed = JSON.parse(content)
            const pkg = parsed.package || ''
            const mixins = parsed.mixins || []
            const client = parsed.client || []
            const allMixins = [...new Set([...mixins, ...client])]
            if (allMixins.length > 0) {
              projectInfo +=
                `已注册 Mixin（${e.name}，包 ${pkg || '无'}）：${allMixins.join(', ')}\n`
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* ignore */ }

    // 5. List resource subdirectories
    try {
      const assetsDir = `${this._projectPath}/src/main/resources/assets`
      const assets = await window.api.listDirectory(assetsDir)
      if (assets.length > 0) {
        projectInfo += `资源命名空间：${assets.map((e) => e.name).join(', ')}\n`
      }
    } catch { /* ignore */ }

    // 6. Client source directory
    try {
      const clientJava = `${this._projectPath}/src/client/java`
      const clientEntries = await window.api.listDirectory(clientJava)
      if (clientEntries.length > 0) {
        projectInfo += `客户端源码目录：src/client/java\n`
      }
    } catch { /* ignore */ }

    return projectInfo
  }

  // Build system prompt with tool descriptions and Fabric knowledge
  private async buildSystemPrompt(mode: 'chat' | 'plan' | 'execute'): Promise<string> {
    const toolNameMap: Record<string, string> = {
      read_file: '读取文件',
      write_file: '写入文件',
      edit_file: '编辑文件（精确替换）',
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
      fabric_template_generate: '生成模板代码',
      fabric_content_register: '生成内容注册',
      fabric_data_assets_generate: '生成资源数据',
      fabric_mixin_scaffold: '生成 Mixin 脚手架',
      fabric_mixin_register: '注册 Mixin 条目',
      fabric_log_debugger: '分析 Fabric 日志',
      read_error_log: '读取错误日志',
      complete_step: '完成任务步骤',
      ask_clarification: '向用户提问'
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
- 代码解释场景：可调用 \`read_file\`、\`explain_code\`、\`fabric_docs_search\` 获取上下文后作答；**禁止** write_file、构建、运行等写入/执行工具。
- 非解释场景：**不要调用任何工具**。
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
- 不要解释概念或写分析段落。

**重要：在制定计划前，如果信息不足，必须使用 ask_clarification 工具向用户询问必要的信息。**
工具调用格式：\`<tool_call>{"name": "ask_clarification", "args": {"question": "你的问题"}}<\/tool_call>\`
收集完所有信息后，再输出结构化实施计划。

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
- **禁止重复步骤。**
- **用户已通过模板表单提交完整需求时，禁止先探索项目；直接输出计划。**
- **用户消息含【结构化参数 JSON】时，执行阶段须调用 \`fabric_template_generate\` 并传入完整 \`formFields\`（勿省略硬度、饱食度等表单参数）。**`
      : `## 🔧 第二阶段：执行计划

规则（优先级从高到低）：
1. 只执行当前步骤。不确定路径/类名/包名时用 ask_clarification 确认，禁止猜。
2. 每轮必须调用工具。旁白不超过 2 句，只告知"当前在做什么"。
3. 写完当前步骤所需全部文件后，调用 complete_step 标记完成，再进入下一步。
4. 全部文件写完后 trigger_build build → 成功则 trigger_build runClient。
5. Mixin 用 fabric_mixin_register 注册；配方用 create_recipe/fabric_recipe_generate；模板用 fabric_template_generate（必须传入 formFields）。
6. 禁止重复写同一文件、禁止用相同参数重复调用只读工具。`

    const extraRules = mode === 'execute'
      ? ''
      : '\n- **信息不足时可以使用 ask_clarification 工具提问，收集完信息后再输出计划。**\n- **最多 3 句背景说明，然后直接列出步骤。** 禁止方案推演。'

    return `# ModCrafting AI 助手
${phaseHeader}

你是 Minecraft Fabric 模组开发助手。用中文回答。Java/JSON 代码保持英文。

## 可用工具
${toolDescs}

${mode === 'plan' ? '## 当前：输出计划阶段\n信息不足时可以使用 ask_clarification 工具提问，收集完信息后输出计划文本。' : '## 当前：执行阶段\n直接调用工具执行计划。多用 write_file 批量写入。最后 trigger_build 构建并启动游戏测试。'}

## 重要规则
- **写代码前用 fabric_docs_search 查 Fabric API：搜索具体类名/方法名（如 "FabricItemSettings equipmentSlot"），返回 Javadoc + 方法签名。不要凭记忆写 API 调用。**
- 使用 Yarn mappings。主类→ModInitializer，客户端→ClientModInitializer。${extraRules}

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
    // Also remove stale injected system messages (instructions, error notices)
    // that were added by appendToolRoundHistory or error handlers.
    // Keep only the base system prompt at position 0.
    this.messages = this.messages.filter((m, i) => {
      if (m.role !== 'system') return true
      if (i === 0) return true // base prompt
      const content = m.content || ''
      // Injected system messages use these markers
      if (/^\[SYSTEM:/.test(content)) return false
      if (/^【系统/.test(content)) return false
      if (/^【注意】/.test(content)) return false
      if (/^【系统警告】/.test(content)) return false
      return true
    })
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

      if (intent === 'develop' && isQuickCreateGeneratedMessage(input)) {
        this.emitEvent({
          kind: EventKind.Notice,
          notice: { level: 'info', text: '快捷创建：模板已生成，跳过规划直接构建并运行。' }
        })
        await this.updateSystemPrompt('execute')
        this._phase = 'execute'
        this.planReadyAwaitingExecute = false
        const opsPlan = '1. 构建项目（gradlew build）\n2. 启动游戏进行真实测试（runClient）'
        this.planTracker = PlanTracker.fromPlanText(opsPlan)
        this.emitPlanState(this.planTracker)
        this.emitEvent({ kind: EventKind.Phase, phase: 'plan_done', text: opsPlan, planActionable: true })
        const result = await this.beginExecuteFromTracker(streamCb)
        this.onAgentStatus?.('')
        return result
      }

      if (intent === 'develop' && this._phase === 'execute' && this.planTracker && !this.planTracker.allDone()) {
        // Detect if user is asking for something NEW (not continuing/fixing current plan)
        const isNewRequest = /^\s*(不[对行要]|我不要|换个|改成|改为|我想做|我想要|新建|另外|重新做|放弃|算了|别|不要这个|stop|new\b)/i.test(input) ||
          (input.length > 15 && !/[继续接往下执行试试试修复改重]$/.test(input) && !/build|编译|错误|error|fail|crash|崩溃|bug|问题|修/.test(input.toLowerCase()))
        if (isNewRequest) {
          this.planTracker = null
          this._phase = 'plan'
          this.planReadyAwaitingExecute = false
          this.emitEvent({ kind: EventKind.Notice, notice: { level: 'info', text: '检测到新需求，已清除旧计划。正在重新规划...' } })
          // Fall through to develop path below
        } else {
          const result = await this.runExecutePhase(streamCb)
          this.onAgentStatus?.('')
          return result
        }
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

        if (this.agent.clarificationPending) {
          return planResult
        }

        const fullPlanText = this.emitPlanDonePhase(planStreamReasoning, planStreamText, planResult)

        if (!this.isActionablePlan(fullPlanText)) {
          // Retry once: inject corrective feedback and ask model to try again
          if (!this.messages.some((m) => m.role === 'user' && (m.content || '').includes('请严格按照以下格式输出实施计划'))) {
            this.messages.push({
              role: 'user',
              content:
                '你刚才的回复不符合计划格式要求。请严格按照以下格式输出实施计划：\n\n' +
                'N. [kind] 简短标题 — 目标路径\n\n' +
                '其中 kind 必须是 write、recipe 或 inspect。每行一个步骤，最多 6 步。\n' +
                '不要写构建/运行步骤，不要写背景分析段落。直接列出步骤。'
            })
            this.onAgentStatus?.('重新生成计划...')
            planStreamReasoning = ''
            planStreamText = ''
            const retryResult = await this.agent.run(
              this.apiConfig.endpoint,
              this.apiConfig.apiKey,
              this.apiConfig.model,
              this.messages,
              this._projectPath,
              this.abortController.signal,
              streamCb,
              { phase: 'plan', emitLifecycle: false, turnMode: intent, composerMode: this.composerMode }
            )
            if (this.agent.clarificationPending) return retryResult
            const retryPlanText = this.emitPlanDonePhase(planStreamReasoning, planStreamText, retryResult)
            if (!this.isActionablePlan(retryPlanText)) {
              this.onAgentStatus?.('')
              this.emitEvent({
                kind: EventKind.Notice,
                notice: {
                  level: 'warn',
                  text: this.planFailureNotice(retryPlanText, true)
                }
              })
              if (intent !== 'plan_only') {
                this.emitEvent({ kind: EventKind.TurnDone, phase: 'plan_failed' })
              }
              return retryResult
            }
            // Retry succeeded — continue with retry plan
            this.planTracker = PlanTracker.fromPlanText(retryPlanText)
            this.emitPlanState(this.planTracker)
            if (intent === 'plan_only') {
              this._phase = 'plan'
              this.planReadyAwaitingExecute = true
              this.onAgentStatus?.('')
              this.emitEvent({ kind: EventKind.Phase, phase: 'plan_ready' })
              this.emitEvent({ kind: EventKind.TurnDone, phase: 'plan_ready', composerMode: this.composerMode })
              return retryResult
            }
            const execResult = await this.beginExecuteFromTracker(streamCb)
            this.onAgentStatus?.('')
            return execResult || retryResult
          }

          // Already retried, give up
          this.onAgentStatus?.('')
          this.emitEvent({
            kind: EventKind.Notice,
            notice: {
              level: 'warn',
              text: this.planFailureNotice(fullPlanText)
            }
          })
          if (intent !== 'plan_only') {
            this.emitEvent({ kind: EventKind.TurnDone, phase: 'plan_failed' })
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

  /** Resume execution after a clarification question was answered. */
  async answerClarification(answer: string): Promise<string> {
    if (!this.agent.clarificationPending) return ''
    if (this._running) return ''

    this.agent.clarificationPending = false

    this.messages.push({ role: 'user', content: answer })

    this._running = true
    this.abortController = new AbortController()
    this.agent.resetRunState()

    this.onAgentStatus?.('思考中...')

    let planStreamText = ''
    let planStreamReasoning = ''
    const streamCb = (text: string, reasoning?: string) => {
      if (text) planStreamText = text
      if (reasoning) planStreamReasoning = reasoning
      this.onStreamUpdate?.(text, reasoning)
    }

    try {
      if (this._phase === 'plan' || !this.planTracker) {
        // Resume plan phase — regenerate plan with clarified requirements
        await this.updateSystemPrompt('plan')
        this.emitEvent({ kind: EventKind.Phase, phase: 'plan_start' })

        const planResult = await this.agent.run(
          this.apiConfig.endpoint,
          this.apiConfig.apiKey,
          this.apiConfig.model,
          this.messages,
          this._projectPath,
          this.abortController!.signal,
          streamCb,
          { phase: 'plan', emitLifecycle: false, turnMode: 'develop', composerMode: this.composerMode }
        )

        if (this.agent.clarificationPending) return planResult

        const fullPlanText = this.emitPlanDonePhase(planStreamReasoning, planStreamText, planResult)

        if (!this.isActionablePlan(fullPlanText)) {
          this.onAgentStatus?.('')
          this.emitEvent({
            kind: EventKind.Notice,
            notice: {
              level: 'warn',
              text: this.planFailureNotice(fullPlanText)
            }
          })
          this.emitEvent({ kind: EventKind.TurnDone, phase: 'plan_failed' })
          return planResult
        }

        this.planTracker = PlanTracker.fromPlanText(fullPlanText)
        this.emitPlanState(this.planTracker)

        const execResult = await this.beginExecuteFromTracker(streamCb)
        this.onAgentStatus?.('')
        return execResult || planResult
      }

      // Resume execute phase
      const result = await this.agent.run(
        this.apiConfig.endpoint,
        this.apiConfig.apiKey,
        this.apiConfig.model,
        this.messages,
        this._projectPath,
        this.abortController!.signal,
        streamCb,
        {
          phase: 'execute',
          emitLifecycle: false,
          planTracker: this.planTracker,
          opsOnlyPlan: this.planTracker?.isOpsOnly() ?? false
        }
      )
      this.onAgentStatus?.('')
      return result
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error('Clarification resume error', errMsg)
      this.onAgentStatus?.(`错误: ${errMsg}`)
      this.emitEvent({ kind: EventKind.TurnDone, error: errMsg })
      return `Error: ${errMsg}`
    } finally {
      this._running = false
      this.abortController = null
    }
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort()
      this._running = false
      this.agent.clarificationPending = false
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
    this.agent.clarificationPending = false
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

  /** Rebuild the plan tracker from persisted plan steps, so the workflow
   *  engine can resume execution after a session reload. */
  restorePlanTracker(steps: Array<{ id: string; description: string; status: string }>): void {
    if (!steps || steps.length === 0) {
      this.planTracker = null
      return
    }
    // Build plan text from steps for PlanTracker.fromPlanText
    const planText = steps
      .map((s) => `${s.id}. ${s.description}`)
      .join('\n')
    this.planTracker = PlanTracker.fromPlanText(planText)
    if (this.planTracker) {
      // Restore step statuses
      for (const step of steps) {
        const trackerStep = this.planTracker.steps.find((ts) => ts.id === step.id)
        if (trackerStep) {
          if (step.status === 'completed') {
            trackerStep.status = 'completed'
          } else if (step.status === 'running' && trackerStep.status === 'pending') {
            trackerStep.status = 'running'
          } else if (step.status === 'error') {
            trackerStep.status = 'error'
          }
        }
      }
      this._phase = 'execute'
    }
  }
}
