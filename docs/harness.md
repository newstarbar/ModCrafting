# Harness 系统

## Test Lab 应用自动化

`--automation` 启动隔离的真实 Electron 实例。主进程创建仅回环可访问的认证桥，React 与 `HarnessController` 仍走正式语义命令和生命周期。桥记录单调事件游标、运行/会话 ID 与时间戳，只暴露能力、命令、事件、快照和关闭接口，不允许执行任意 JavaScript。

修复安全由工作流层统一控制：Mixin/配方结构校验只是证据，不是 Java 编译结果；写入后始终允许真实构建。每步骤最多 3 次写入—构建、20 个模型轮次和 40 次工具调用。计划范围外的编译失败返回 `INCONCLUSIVE/out_of_scope_build_failure`；相同失败签名没有有效差异连续出现时停止并要求重新规划。

stdio 工具、沙箱、报告和回放流程见 [Test Lab MCP](./test-lab-mcp.md)。

## 确定性游戏内测试 V2

`run` 与 `game_test` 是两个独立的宿主步骤：前者只确认客户端和桥接已经启动；后者执行 `Arrange → Act → Assert → Cleanup`，只有 `mc_run_test` 返回结构化 `PASS` 才能完成。每次 `game_test` 都会创建新会话，旧截图、旧聊天和旧快照不得复用为证据。

计划必须提交 `AcceptanceContract`。它把用户任务拆为带 `sourceQuote` 的原子 requirement，并为每条 requirement 选择 `build_success`、`game_assertion` 或 `user_confirmation` Oracle。Harness 只校验契约完整性、证据时序和实际结果，绝不从自然语言推断某项功能应该使用哪一个业务类、Mixin、模型或 API。

- `submit_plan` 的客观验收放在 `AcceptanceContract.game_assertion`；`mc_test_scenario` 保持 V2 兼容。断言支持旧 V2 类型以及通用 `snapshot_value` / `snapshot_changed`（来源 + JSON Pointer）、`render_trace` 和 `hud_text`。未知 `type`、旧 `kind`、缺字段和占位符会返回字段级错误。
- 提交计划会固定重排为实现 → build → run → `game_test`。恢复旧会话时，误标为 `inspect` 的 `mc_run_test` 步骤会迁移为 `game_test`，并从计划或旧 JSON 工具输出恢复原 `scenarioId`。
- 宿主固定使用 `ModCrafting Test World` 与 `x/z=-16..16、y=96..112` 测试区，准备阶段会清背包、状态、区域和带 `modcrafting_test` 标签的实体，清理阶段再次回收。
- 裁决只有 `PASS`、`FAIL`、`INCONCLUSIVE`。桥接缺少能力、导航/世界异常、纯视觉布局或无法查询的状态均为 `INCONCLUSIVE`，禁止自动改代码。相同客观断言在清理后的两个独立会话连续失败，才允许进入修复模式。
- V2 桥接提供 `/v2/capabilities`、`/v2/command`、`/v2/snapshot` 和 `/v2/query`；快照带客户端/服务端玩家状态、HUD 文本轨迹、实体渲染轨迹、时间戳和世界 tick。能力未提供时结果只能是 `INCONCLUSIVE`。V1 可继续协助操作，但不能产生自动通过。
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
| `acceptance-contract.ts` | 任务级 requirement 与 build/game/user-confirmation Oracle |
| `game-test-protocol.ts` / `game-test-runner.ts` | V2 游戏规格、动作、断言、新鲜证据和三态裁决 |
| `mc-data-tool.ts` | `minecraft_data_lookup` 与 `mc_wiki_search` 工具实现 |
| `workflow-engine.ts` | 串行步骤、证据裁决、修复范围、20/40/3 预算与 `ask_clarification` 暂停 |
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

模式切换由 `turn-classifier` 完成，同时识别「错误报告 / 用户症状 / 游戏内验证请求」等侧面信号。分类器会按 Provider 协议构造请求；MiniMax 不使用对象式强制 `tool_choice`，并采用正数低温度。主工具调用响应无法解析或返回 400/404/422 时，会在同一超时预算内仅重试一次 JSON-only 请求；两次失败才使用结构性兜底。`classificationSource` 区分 `tool_call`、`json_retry` 与 `structural_fallback`，失败诊断只记录 Provider、模型、endpoint 主机、阶段和 HTTP 状态。

## 计划阶段门控

**文件**：`src/renderer/src/harness/plan-phase-gate.ts`

| 常量 | 值 | 说明 |
|------|------|------|
| `MAX_READONLY_ROUNDS` | 15 | 只读勘探轮次上限，超过后进入"建议提交"状态 |
| `MAX_PLAN_SUBMIT_NUDGE_ROUNDS` | 3 | 文字回复后最多提醒次数 |
| `MAX_PLAN_OFFERED_REJECT_ROUNDS` | 2 | 计划被拒绝后最多重试次数 |

**锁定后工具白名单**（`PLAN_POST_LOCK_TOOL_NAMES`）：
- `submit_plan`、`ask_clarification`、`grep`、`list_directory`、`read_file`

锁定后**仍允许只读勘探工具**，仅禁用写入工具，避免 AI 在勘探阶段无限循环的同时不阻碍大项目勘探。

`ask_clarification` 仅允许用于产品偏好与需求歧义；代码事实（API 命名、类名、mixin 路径等）必须走工具勘察。

## 执行阶段

`workflow-engine.ts` 串行逐步执行：
- 每轮执行**全部**允许的工具（只读并行，写入串行）
- 知识查询工具不消耗 attempt 配额
- 每步骤最多 20 个模型轮次、40 次工具调用、3 次写入—构建修复
- 自动修复只能修改计划声明路径与本轮变更路径；范围外失败要求重新规划
- 相同失败签名无有效差异连续出现两次时停止循环
- 支持 `ask_clarification` 暂停
- `complete_step` 是宿主裁决请求：同轮会先运行证据工具，再决定是否推进。`inspect` 可消费验收标准显式声明且目标路径匹配的 `fabric_mixin_validate` / `fabric_recipe_validate` 结构化成功结果；缺少证据会返回 `step_evidence_required`，不会显示为完成或静默忽略。

## 工具策略与取消

- 工具能力统一为项目读写、知识查询、构建/命令、游戏观察/控制、用户交互和流程控制；新增内置工具必须在 `tool-policy.ts` 声明策略。
- Plan 与写入类步骤均提供 `minecraft_data_lookup`、`mc_wiki_search`，避免系统提示与公开工具集冲突。
- 默认 deadline：本地读写/校验 15 秒，知识库 60 秒，游戏桥 30 秒，进入世界 150 秒，命令 5 分钟，构建/启动游戏 10 分钟。命令和构建另有无进度超时。
- 停止任务会取消 GUI 预览、渲染进程工具和主进程命令/Gradle 子进程；Windows 使用进程树终止避免残留 Java/Gradle。
- 工具结果统一标记 `succeeded`、`failed`、`timed_out` 或 `cancelled`；工具卡会显示超时/取消终态，不会永久停留在运行中。

## 工具集（45）

工具数量以 `tool-policy.ts` 为准；注册但未声明策略会在启动/测试时失败。

### 项目读取（6）

- `read_file`、`list_directory`、`grep`
- `read_error_log`、`explain_code`、`list_templates`

### 知识与结构校验（12）

- `fabric_docs_search`、`fabric_javadoc_lookup`、`vanilla_mc_wiki_query`
- `minecraft_data_lookup`、`mc_wiki_search`、`fabric_meta_version_check`
- `fabric_mod_json_validate`、`fabric_log_debugger`、`fabric_mixin_target_lookup`
- `fabric_recipe_validate`、`fabric_mixin_validate`、`mc_test_scenario`

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
| 执行预算 | 每步骤 20 模型轮次 / 40 工具调用 / 3 修复循环 |
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

## 数据流

用户输入 → `ChatPanel` → `Controller.send()` → 意图解析 → 构建系统提示词 → `Agent` 流式调用 LLM → 工具调用进入 `Registry` → `window.api.*` → IPC → 主进程。

事件通过 `Sink` → Controller 回调 → React state → UI 回流。
