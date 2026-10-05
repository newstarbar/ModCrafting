# Harness 系统


## Game-test INCONCLUSIVE recovery (architecture)

`mc_run_test` never creates a generic clarification request. Its machine-readable
`inconclusiveCode` and `responsibility` route the same game-test step internally:

- `agent_test_design` -> `evidence_repair`: the Agent must create a new
  `scenarioId` with `mc_test_scenario`; the old scenario is marked superseded.
  Three invalid revisions terminate as `REPEATED_INVALID_TEST_SPEC`.
- `environment` -> `environment_recovery`: the host replays the same scenario
  after Observer/world recovery, at most twice. It never opens source-edit tools.
- `visual_review` -> a dedicated status card; it is not an objective verdict.
- Objective `FAIL` emits a cleanup/replay card on the first failure and a
  product-repair card only after the same failure repeats.
- A scenario may declare `requiredPassCount` (1–3). When it is greater than
  one, the host restarts Minecraft and replays the same scenario from setup;
  the step advances only after the required independent PASS count.

Only an explicit Agent `ask_clarification` call can set `needsClarification`.
The UI presents recovery status cards and retains a separate stop-task control;
it does not offer a “continue assertions” choice for an inconclusive test.
## Test Lab 应用自动化

`--automation` 启动隔离的真实 Electron 实例。主进程创建仅回环可访问的认证桥，React 与 `HarnessController` 仍走正式语义命令和生命周期。桥记录单调事件游标、运行/会话 ID 与时间戳，只暴露能力、命令、事件、快照和关闭接口，不允许执行任意 JavaScript。

修复安全由工作流层统一控制：Mixin/配方结构校验只是证据，不是 Java 编译结果；写入编译单元后由宿主自动执行静态校验和增量编译。全任务最多 12 个修复候选、40 个模型轮次、120 个工具调用或 90 分钟；同一诊断簇两个不同候选均无推进时进入可恢复 `PAUSED`，已配置 fallback 会接管。计划范围外的编译失败返回 `INCONCLUSIVE/out_of_scope_build_failure`。

stdio 工具、沙箱、报告和回放流程见 [Test Lab MCP](./test-lab-mcp.md)。

## 确定性游戏内测试 V2

`run` 与 `game_test` 是两个独立的宿主步骤：前者只确认客户端和桥接已经启动；后者执行 `Arrange → Act → Assert → Cleanup`，只有 `mc_run_test` 返回结构化 `PASS` 才能完成。每次 `game_test` 都会创建新会话，旧截图、旧聊天和旧快照不得复用为证据。

计划必须提交 `AcceptanceContract`。它把用户任务拆为带 `sourceQuote` 的原子 requirement，并为每条 requirement 选择 `build_success`、`game_assertion` 或 `user_confirmation` Oracle。Harness 只校验契约完整性、证据时序和实际结果，绝不从自然语言推断某项功能应该使用哪一个业务类、Mixin、模型或 API。

- `submit_plan` 的客观验收放在 `AcceptanceContract.game_assertion`；`mc_test_scenario` 保持 V2 兼容。断言支持旧 V2 类型以及通用 `snapshot_value` / `snapshot_changed` / `snapshot_unchanged`（来源 + JSON Pointer）、`render_trace` 和 `hud_text`。未知 `type`、旧 `kind`、缺字段和占位符会返回字段级错误。
- 计划固定终端顺序：**实现 → build → run → `test_design` → `game_test`**。`test_design` 是强制隔离步骤：AI 读实现代码 → 设计沙盒 preset → 设计 actions/assertions → `mc_test_scenario` 注册含 `sandbox`/`actions`/`assertions`/`acceptanceContract` 的有效 V2 规格。`test_design` 仅允许读代码/世界/注册场景；禁止写产品代码和 `mc_run_test`。
- `test_design` 完成条件：注册有效 V2 场景（含 `acceptanceContract`、非空 `actions`、至少一条机制相关客观断言）；`isValidTestDesignScenarioResult()` 验证；通过后规格自动传播到紧随的 `game_test` 步。缺规格时返回 `SPEC_*`，不推进。
- 沙盒 preset 声明式：`flat_platform`（现有兼容）、`enclosed_arena`（玻璃/屏障围栏+顶盖，防实体越界）、`stimulus_pad`（平台+刺激点）、`crafting_station`（平台+合成台方块）。`entity_behavior` 强制 `enclosed_arena`；`new_recipe` 推荐 `crafting_station`。宿主在 setup 后展开为具体 fill/summon 命令序列。
- 恢复旧会话时，误标为 `inspect` 的 `mc_run_test` 步骤会迁移为 `game_test`，并从计划或旧 JSON 工具输出恢复原 `scenarioId`。
- 宿主固定使用 `ModCrafting Test World` 与 `x/z=-16..16、y=96..112` 测试区，准备阶段会清背包、状态、区域和带 `modcrafting_test` 标签的实体，清理阶段再次回收。
- 裁决只有 `PASS`、`FAIL`、`INCONCLUSIVE`。桥接缺少能力、导航/世界异常、纯视觉布局或无法查询的状态均为 `INCONCLUSIVE`，禁止自动改代码。相同客观断言在清理后的两个独立会话连续失败，才允许进入修复模式。
- V2 桥接提供 `/v2/capabilities`、`/v2/command`、`/v2/snapshot` 和 `/v2/query`；快照带客户端/服务端玩家状态、HUD 文本轨迹、实体渲染轨迹、时间戳和世界 tick。能力未提供时结果只能是 `INCONCLUSIVE`。V1 可继续协助操作，但不能产生自动通过。
- 运行时通过 `McRuntimeReadiness` 公开预期/实际 Fabric 模组、Bridge API 版本、游戏目录与失败代码。只有目标模组、Mod Menu、Observer V2 和桥接均就绪时才产生 `MC_PHASE:ready`；`mc_runtime_status` 可在游戏步骤中诊断环境故障。
- 每次会话会保存 JSON 报告到应用数据目录的 `game-test-reports/`，其中包含动作、命令、断言、新鲜快照、清理和最终裁决；不写入模组仓库。

Harness 系统是 ModCrafting 的 AI Agent 核心，位于 `src/renderer/src/harness/`。

## 模块清单

| 模块 | 职责 |
|--------|------|
| `controller.ts` | 顶层编排器：会话生命周期、意图解析、plan→execute 阶段切换、系统提示词构建 |
| `agent.ts` | LLM 交互循环：SSE 流式输出，工具调用解析（原生 function-calling + XML 回退），循环守卫，指数退避重试 |
| `tools.ts` | `Registry`、`Tool` 接口、`ToolContext`。工具有 deadline/取消结果；`executeBatch()` 以最多 4 个并发执行相邻只读工具，并串行执行写入工具 |
| `tool-policy.ts` | 工具能力、执行类型与超时策略的唯一目录；生成 Plan/工作流推荐工具集合 |
| `tool-definitions.ts` | 通过 `registerModCraftingTools()` 注册的内置工具 |
| `skill-tools.ts` | `read_skill` 工具与技能索引渲染（`formatSkillIndex`），见 [skill.md](./skill.md) |
| `acceptance-contract.ts` | 任务级 requirement 与 build/game/user-confirmation Oracle |
| `game-test-protocol.ts` / `game-test-runner.ts` | V2 游戏规格、动作、断言、新鲜证据和三态裁决 |
| `mc-data-tool.ts` | `minecraft_data_lookup` 与 `mc_wiki_search` 工具实现 |
| `workflow-engine.ts` | 串行步骤、验证门、证据裁决、诊断驱动修复预算与 `ask_clarification` 暂停 |
| `../shared/harness-runtime.ts` | ProjectProfile、ExecutionWorkspace、BuildReport、TaskCheckpoint、Provider 能力等跨进程契约 |
| `../shared/harness-diagnostics.ts` | 诊断集合指纹与“根因消除/阶段推进/下游暴露”进展判定 |
| `model-adapter.ts` | Provider 无关适配（OpenAI Chat / Anthropic Messages / XML fallback）、能力探测和统一请求协议 |
| `tool-call-assembler.ts` | 按 Provider index + ID 聚合流式工具调用；只在参数完整后解析和执行 |
| `active-tool-snapshot.ts` | 每轮生成一次工具能力快照，模型公开列表与返回校验共享同一快照 |
| `knowledge-fact-cache.ts` | 按项目画像指纹隔离的知识事实缓存，阻止跨步骤重复检索 |
| `src/main/project-profile.ts` | 宿主确定性解析 Gradle/Loom/source sets/入口点/符号索引状态 |
| `src/main/workspace-manager.ts` | 影子工作区、基线 manifest、哈希冲突检查、事务 promote/rollback |
| `src/main/build-report.ts` | 英文/中文 javac、Gradle、Mixin、依赖和启动日志结构化诊断 |
| `src/main/checkpoint-store.ts` | 原子 JSON 检查点持久化，支持重载/超时/中断恢复 |
| `plan-tracker.ts` | `PlanTracker` 类：步骤状态追踪、自动推进、上下文块格式化 |
| `plan-compiler.ts` | 计划解析、迁移和去重；宿主追加 build → run → `game_test` |
| `plan-execution-gate.ts` | 游戏计划缺少 V2 gameTest/AcceptanceContract 时阻止执行 |
| `plan-phase-gate.ts` | 计划阶段只读门控：`MAX_READONLY_ROUNDS`、`isPlanPostLockTool`、`shouldNudgePlanSubmit` |
| `step-policy.ts` | 按工作流步骤类型执行安全门控；非安全性的步骤时机问题返回 `policy_deferred`，不会消耗 attempt |
| `step-evidence.ts` | 基于证据的步骤推进：`findAdvanceEvidence()` 根据步骤类型检查工具结果 |
| `tool-rejection-guard.ts` | 保留真实工具名/错误类型并收敛重复非法调用 |
| `turn-classifier.ts` | Provider 分类、JSON-only 重试、结构兜底和脱敏诊断 |
| `turn-intent.ts` | 将用户输入分类为 `chat`/`resume`/`develop`/`plan_only` |
| `fabric-agent-policy.ts` | 领域特定的护栏规则、任务分类、知识源定义 |
| `fabric-utils.ts` | `validateFabricModJsonContent()`、`classifyFabricLog()`、`buildDataAssetFiles()` |
| `fetch-retry.ts` | 重试逻辑：对临时错误（5xx、429、超时、ECONNRESET）最多 3 次尝试，指数退避 |

## 三模式路由

每轮独立 LLM 分类，自动分流至三种模式：

- **Chat 模式**：概念问答、方案说明，禁用写入/执行工具，直接给最佳方案不做比较
- **Plan 模式**：输出结构化 `submit_plan`（实现步骤加可执行 `gameTest`；宿主追加 build / run / game_test）
- **Execute 模式**：按宿主步骤和证据执行；只有范围内、可重复的产品失败进入受限修复

模式切换由 `turn-classifier` 完成，同时识别「错误报告 / 用户症状 / 游戏内验证请求」等侧面信号。计划、执行、压缩和分类器请求都经过同一个 `ModelAdapter`；协议由显式 `protocol` 或旧 endpoint 自动推断。MiniMax 旧 `/v1` 配置保持 OpenAI-compatible，新建 MiniMax 配置使用官方 Anthropic Messages。分类器不再单独拼接 `/chat/completions`。`classificationSource` 区分 `tool_call`、`json_retry` 与 `structural_fallback`，失败诊断只记录 Provider、模型、endpoint 主机、阶段和 HTTP 状态。

### Provider 工具流边界

模型流先经过 `NormalizedModelEvent`，再由 `ToolCallAssembler` 按 Provider index 优先、ID 其次建立双向别名。首块带真实 ID、后续仅带 index 的参数片段会合并为同一个调用；参数始终作为字符串累加，流结束后才解析 JSON。`finish_reason=length`、未闭合 JSON、缺少工具名或参数只产生 `arguments_incomplete`，不会进入 Registry。

每个模型轮次生成一个 `ActiveToolSnapshot`。请求中的工具 Schema、返回后的存在性判断和 `beforeToolCall` 语义策略都引用该快照；旧 checkpoint 的 `allowedTools` 只作为兼容字段，新的 `recommendedTools` 只影响提示排序。错误码分为 `tool_unknown`、`tool_inactive`、`arguments_incomplete`、`arguments_invalid`、`policy_blocked` 和 `execution_failed`，不再把参数错误描述成白名单错误。连续两次相同 Provider 协议故障先降级 XML；仍失败则走用户已配置的 fallback 或保存 `PAUSED` 检查点。Session 导出会保留协议、chunk index/ID、参数累计长度和降级证据，不包含 API Key 或完整敏感参数。

**thinking 连续性（与模型族无关）**：assistant 轮次产出的推理内容作为 `ChatMessage.reasoningContent` 存入历史，openai-chat 出站时仅在"该消息自带推理内容"的条件下序列化为 `reasoning_content`；Anthropic 分支不透传，也不会凭空给没有推理的轮次补字段。Provider 以 `reasoning_content` + `invalid_request_error` 拒绝续聊时，归类为 `isReasoningContinuityError()`：它不属于可重试网络错误，也不进入 fallback 换模型阶梯（换模型只会同样 400 并丢失推理历史），而是就地用 `withoutReasoningEcho()` 去掉回传字段重试一次，仍失败则把协议不兼容明确上抛给用户。回传会抬高输入 token，这是 thinking 模式的协议成本，不是浪费。

## 计划阶段门控

**文件**：`src/renderer/src/harness/plan-phase-gate.ts`

| 常量 | 值 | 说明 |
|------|------|------|
| `MAX_READONLY_ROUNDS` | 15 | 只读勘探轮次上限，超过后进入"建议提交"状态 |
| `MAX_PLAN_SUBMIT_NUDGE_ROUNDS` | 3 | 文字回复后最多提醒次数 |
| `MAX_PLAN_OFFERED_REJECT_ROUNDS` | 2 | 计划被拒绝后最多重试次数 |

**锁定后工具白名单**（`isPlanPostLockTool()`，唯一事实源）：
- `submit_plan`、`ask_clarification`
- 全部 `project.read` 能力工具（`read_file`、`list_directory`、`grep` 等）
- 全部 `knowledge.read` 能力工具（`fabric_docs_search`、`fabric_mixin_target_lookup`、`minecraft_data_lookup`、`mc_wiki_search`、`fabric_javadoc_lookup`、`vanilla_mc_wiki_query` 等）

锁定只禁用写入/构建/游戏类工具：提示词与 AGENTS.md 要求写码前必须查知识库，若锁定同时禁掉知识工具，二者会互相矛盾并让模型反复撞 `tool_inactive`。判定按 `BUILTIN_TOOL_POLICIES` 的能力声明走，新增只读工具无需改门控。

`ask_clarification` 仅允许用于产品偏好与需求歧义；代码事实（API 命名、类名、mixin 路径等）必须走工具勘察。

## 执行阶段

`workflow-engine.ts` 串行逐步执行：
- 每轮执行**全部**允许的工具（只读并行，写入串行）
- 知识查询工具不消耗 attempt 配额
- 写入/配方/Mixin 编译单元通过后才允许进入下一步；相同源码与项目指纹禁止重复构建
- 全任务最多 12 个修复候选、40 个模型轮次、120 个工具调用或 90 分钟；达到预算保存 `PAUSED` 检查点
- `trigger_build` 直接附带 `BuildReport` 和 diagnostic ID；已经返回的失败日志不会再次由 `read_error_log` 重复读取
- `mc_run_test` 仍由宿主执行 `AcceptanceContract`；`requiredPassCount>1` 时必须完成独立重启复测，任何快测/单次 `PASS` 都不会绕过完整契约与 promote 门
- 自动修复只能修改计划声明路径与本轮变更路径；范围外失败要求重新规划
- 进展按诊断 ID 消除、阶段前进和下游错误暴露判定，不按错误行数单一判定；相同诊断簇两个候选无进展后切换 fallback
- 支持 `ask_clarification` 暂停
- `complete_step` 是宿主裁决请求：同轮会先运行证据工具，再决定是否推进。`inspect` 可消费验收标准显式声明且目标路径匹配的 `fabric_mixin_validate` / `fabric_recipe_validate` 结构化成功结果；缺少证据会返回 `step_evidence_required`，不会显示为完成或静默忽略。
- **本轮写入产物跨步采纳**：`write` 步的目标路径若已由本轮更早步骤的 `project.write` 工具真实写出（典型如 `fabric_mixin_register` 在上一步写好 `*.mixins.json`），宿主按实际写入推进并发 `Notice`。采纳只认工具返回值里的 `artifactPath(s)`，磁盘上"文件已存在"永远不构成证据（重写类步骤的目标文件本来就存在）；同一步骤自身不计入被采纳集合。
- 同类证据拒绝连续两次即判定门控自相矛盾，进入可恢复 `[HARNESS_PAUSED:evidence_deadlock]`，文案报告**真实消耗轮次**与步骤预算；不再把 `attempt` 直接推到上限，因此不会再对外谎报"已用 18/18 轮"。该暂停不触发备用模型切换。
- Mixin 目标为 `$` 嵌套类时，脚手架与校验统一使用 `@Mixin(targets = "A$B")`（Yarn 内部类通常是 private，类字面量不可编译），并且不生成嵌套类 import；`fabric_mixin_validate` 对旧的 `@Mixin(A.B.class)` 形式判失败。

## 工具策略与取消

- 工具能力统一为项目读写、知识查询、构建/命令、游戏观察/控制、用户交互和流程控制；新增内置工具必须在 `tool-policy.ts` 声明策略。
- Plan 与写入类步骤均提供 `minecraft_data_lookup`、`mc_wiki_search`，避免系统提示与公开工具集冲突。
- 默认 deadline：本地读写/校验 15 秒，知识库 60 秒，游戏桥 30 秒，进入世界 150 秒，命令 5 分钟，构建/启动游戏 10 分钟。命令和构建另有无进度超时。
- 停止任务会取消 GUI 预览、渲染进程工具和主进程命令/Gradle 子进程；Windows 使用进程树终止避免残留 Java/Gradle。
- 工具结果统一标记 `succeeded`、`failed`、`timed_out` 或 `cancelled`；工具卡会显示超时/取消终态，不会永久停留在运行中。

## 技能模块（Skill）

技能是带 frontmatter 的 `SKILL.md` 指令包：索引（id + 一句话）常驻系统提示词，正文由 `read_skill` 按需取回。技能只补充专业细节，不新增工具能力、不参与门控改写。

- 内置树 `resources/skills/<id>/SKILL.md`，用户覆盖 `userData/skills/<id>/SKILL.md`，共用 `src/main/md-tree-store.ts` 的「内置 + 覆盖」文件树实现
- 启停存 `agent-config.json` 的 `disabledSkills`；设置 → 技能 可开关、编辑、恢复内置
- `read_skill` 策略为 `knowledge.read`，因此 Plan 白名单、探索锁、只读锁、步骤门与轮次预算全部自动放行
- 工具注册不随技能启停变化，以保持广播 catalog 逐轮字节稳定（prompt cache）
- 详见 [skill.md](./skill.md)

## 工具集（48）

工具数量以 `tool-policy.ts` 为准；注册但未声明策略会在启动/测试时失败。

### 项目读取（6）

- `read_file`、`list_directory`、`grep`
- `read_error_log`、`explain_code`、`list_templates`

### 知识与结构校验（13）

- `fabric_docs_search`、`fabric_javadoc_lookup`、`vanilla_mc_wiki_query`
- `minecraft_data_lookup`、`mc_wiki_search`、`fabric_meta_version_check`
- `fabric_mod_json_validate`、`fabric_log_debugger`、`fabric_mixin_target_lookup`
- `fabric_recipe_validate`、`fabric_mixin_validate`、`mc_test_scenario`
- `read_skill`（技能包按需加载，见 [skill.md](./skill.md)）

### 项目写入（10）

- `write_file`、`edit_file`、`delete_file`、`create_recipe`
- `fabric_recipe_generate`、`fabric_content_register`、`fabric_data_assets_generate`
- `fabric_mixin_scaffold`、`fabric_mixin_register`、`fabric_template_generate`

### 进程与构建（2）

- `run_command`
- `trigger_build`

### 游戏观察与控制（11）

- 观察：`mc_screenshot`、`mc_inspect`、`mc_inventory`、`mc_world`、`mc_observe_entity`
- 控制：`mc_chat`、`mc_command`、`mc_input`、`mc_ensure_test_world`、`mc_ensure_cheats`、`mc_run_test`

`run`/客户端启动是宿主管理的工作流步骤，不应与 `trigger_build` 或游戏功能裁决混为一谈。

### 用户交互（1）

- `gui_layout_preview`

### 流程控制（3）

- `submit_plan`、`complete_step`、`ask_clarification`

## 关键护栏

| 护栏 | 实现 |
|------|------|
| ACI 读门控 | `write_file` 前必须先 `read_file` |
| 验收契约 | 每个原子 requirement 必须有唯一 Oracle |
| 证据新鲜度 | 断言只消费本会话动作之后的 tick/时间戳证据 |
| 三态裁决 | `PASS` / `FAIL` / `INCONCLUSIVE` 严格分离 |
| 修复范围 | 只允许计划路径与本轮变更路径；范围外失败重新规划 |
| 原子交付 | Agent 只写影子工程；严格验收后按基线哈希事务提交，真实项目最终 build 失败自动回滚 |
| 可恢复检查点 | 网络、应用重载、冲突、预算耗尽都保留影子工程和 TaskCheckpoint，发送「继续」原地恢复 |
| 执行预算 | 全任务 40 模型轮次 / 120 工具调用 / 12 修复候选 / 90 分钟；同诊断簇主模型 2 个候选后 fallback 2 个候选 |
| 结构化诊断 | BuildReport 合并级联根因，责任区分 baseline/project/generated_code/environment |
| 样例隔离 | 生产 Harness 禁止导入 Test Lab 场景或样例语义规则 |
| 空构建检测 | 构建产物为 0 字节时报告失败 |
| JSON 截断恢复 | LLM 输出 JSON 被截断时自动修复 |
| 迁移批量门控 | 数据迁移操作分批执行 |
| 推理长度软/硬限制 | 6k（软）/ 12k（硬）字符 |
| EBUSY 重试 | `build-env.ts` 对 Windows 文件锁最多 3 次重试，100ms 递增退避 |

## 上下文压缩

- 老旧工具结果微压缩
- 接近 token 上限触发 LLM 摘要
- 跨轮诊断保留（近期 5 条用户反馈 + 2 条助手摘要）

## 输出截断

| 工具 | 限制 | 截断消息 |
|------|------|---------|
| `read_file` | 单次默认 400 行 | （剩余 N 行。用 offset=X 继续读取） |
| 工具输出 | `MAX_TOOL_OUTPUT = 32 * 1024` 字符 | `...[内容过长，已截断]...` |

不显示原始文件大小/字节数，避免误导。

## 多模型协作路由

每轮先用规则提取 `RoutingSignals`（任务模板、难度、是否需视觉/诊断、是否歧义），歧义时由 router 模型 refinement（失败则 fail-open 回退规则）。`RouteDecision` 同时给出全量 `roles` 与本轮真正会执行的 `activeRoles`；协作轨迹只排队 `activeRoles`，避免「展示但不运行」的假委派。

路由固定使用十种职责：router、coordinator、explorer、planner、implementer、debugger、codeReviewer、visualReviewer、verifier、summarizer。预设可为角色声明 `byDifficulty`（simple/standard/complex）模型池；运行时按难度选择 primary/fallback。UI/GUI 必须有可用的视觉审查模型，缺失时暂停并引导到设置中心；Minecraft 内容在勘探阶段先要求查询 `minecraft_data_lookup`。

**默认单厂多模型**：内置策略基于主厂商（默认 DeepSeek）的 Flash / Pro / 多模态梯队协作，视觉审查默认走主厂多模态，不要求第二把 Key。可选「伴厂商」最多 1 个，仅挂到专家槽（`codeReviewer` 第三方审查、可选 `visualReviewer` 游戏/视觉审查预留），用于补短板或交叉检测；游戏测试推荐模型待评测，本阶段不钦定。≥3 厂混搭仅出现在用户自定义预设。

真实委派：规划前可跑 explorer；含诊断信号时执行前可跑 debugger；计划完成后成功交付可跑 codeReviewer / summarizer；knowledge 模板走 explorer → summarizer。鉴权、限流、协议失败会对该模型施加约 60 秒冷却并沿 fallback 链切换，不会因「答得差」随意换模。

模型选择可为会话级“路由预设”或“固定模型”。全局上限为 3 路只读并发、12 次职责委派、3 次专家修复交接；任务级可靠性预算为 12 个修复候选、40 个模型轮次、120 个工具调用或 90 分钟。单轮 `runForRole` 计入委派预算。

协作轨迹只记录职责、模型、状态、用量、回退、耗时和交接摘要，不记录或展示隐藏推理；它随消息持久化，并可由 Test Lab 快照读取。

## 数据流

用户输入 → `ChatPanel` → `Controller.send()` → 意图解析 → 构建系统提示词 → `Agent` 流式调用 LLM → 工具调用进入 `Registry` → `window.api.*` → IPC → 主进程。

事件通过 `Sink` → Controller 回调 → React state → UI 回流。
