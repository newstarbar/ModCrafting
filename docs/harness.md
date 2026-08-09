# Harness 系统

## 确定性游戏内测试 V2

`run` 与 `game_test` 是两个独立的宿主步骤：前者只确认客户端和桥接已经启动；后者执行 `Arrange → Act → Assert → Cleanup`，只有 `mc_run_test` 返回结构化 `PASS` 才能完成。每次 `game_test` 都会创建新会话，旧截图、旧聊天和旧快照不得复用为证据。

- `submit_plan.gameTest` 和 `mc_test_scenario` 要求具体的功能类型、目标 ID（或 GUI 热键）及至少一条客观断言；`<modid>` 等占位符和纯截图测试会被拒绝。
- 宿主固定使用 `ModCrafting Test World` 与 `x/z=-16..16、y=96..112` 测试区，准备阶段会清背包、状态、区域和带 `modcrafting_test` 标签的实体，清理阶段再次回收。
- 裁决只有 `PASS`、`FAIL`、`INCONCLUSIVE`。桥接缺少能力、导航/世界异常、纯视觉布局或无法查询的状态均为 `INCONCLUSIVE`，禁止自动改代码。相同客观断言在清理后的两个独立会话连续失败，才允许进入修复模式。
- V2 桥接提供 `/v2/capabilities`、`/v2/command`、`/v2/snapshot` 和 `/v2/query`；快照带时间戳和世界 tick。V1 可继续协助操作，但不能产生自动通过。
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
| `mc-data-tool.ts` | `minecraft_data_lookup` 与 `mc_wiki_search` 工具实现 |
| `workflow-engine.ts` | 执行阶段串行逐步执行；修复模式（构建/运行失败时最多 3 轮修复）；`ask_clarification` 暂停 |
| `plan-tracker.ts` | `PlanTracker` 类：步骤状态追踪、自动推进、上下文块格式化 |
| `plan-compiler.ts` | 计划编译管道：解析 → 剥离主机终端步骤 → 删除模糊步骤 → 按路径去重 → 追加构建+运行步骤 |
| `plan-phase-gate.ts` | 计划阶段只读门控：`MAX_READONLY_ROUNDS`、`isPlanPostLockTool`、`shouldNudgePlanSubmit` |
| `step-policy.ts` | 按工作流步骤类型执行安全门控；非安全性的步骤时机问题返回 `policy_deferred`，不会消耗 attempt |
| `step-evidence.ts` | 基于证据的步骤推进：`findAdvanceEvidence()` 根据步骤类型检查工具结果 |
| `turn-intent.ts` | 将用户输入分类为 `chat`/`resume`/`develop`/`plan_only` |
| `fabric-agent-policy.ts` | 领域特定的护栏规则、任务分类、知识源定义 |
| `fabric-utils.ts` | `validateFabricModJsonContent()`、`classifyFabricLog()`、`buildDataAssetFiles()` |
| `fetch-retry.ts` | 重试逻辑：对临时错误（5xx、429、超时、ECONNRESET）最多 3 次尝试，指数退避 |

## 三模式路由

每轮独立 LLM 分类，自动分流至三种模式：

- **Chat 模式**：概念问答、方案说明，禁用写入/执行工具，直接给最佳方案不做比较
- **Plan 模式**：输出结构化 `submit_plan`（write / recipe / mixin / inspect 四种 kind，1-6 步）
- **Execute 模式**：逐步执行计划，每轮必调工具，旁白 ≤2 句，构建失败自动进入修复模式

模式切换由 `turn-classifier` 完成，同时识别「错误报告 / 用户症状 / 游戏内验证请求」等侧面信号。

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
- 修复模式：构建/运行失败时最多 3 轮修复
- 支持 `ask_clarification` 暂停

## 工具策略与取消

- 工具能力统一为项目读写、知识查询、构建/命令、游戏观察/控制、用户交互和流程控制；新增内置工具必须在 `tool-policy.ts` 声明策略。
- Plan 与写入类步骤均提供 `minecraft_data_lookup`、`mc_wiki_search`，避免系统提示与公开工具集冲突。
- 默认 deadline：本地读写/校验 15 秒，知识库 60 秒，游戏桥 30 秒，进入世界 150 秒，命令 5 分钟，构建/启动游戏 10 分钟。命令和构建另有无进度超时。
- 停止任务会取消 GUI 预览、渲染进程工具和主进程命令/Gradle 子进程；Windows 使用进程树终止避免残留 Java/Gradle。
- 工具结果统一标记 `succeeded`、`failed`、`timed_out` 或 `cancelled`；工具卡会显示超时/取消终态，不会永久停留在运行中。

## 工具集（30+）

### 文件操作
- `read_file`（默认 400 行，支持分页 offset/limit）
- `write_file`（覆盖已有文件时输出旧内容 ≤2KB，标注增删行数）
- `edit_file`
- `list_directory`

### 搜索
- `grep`（基于 ripgrep）

### Fabric 专项
- `fabric_docs_search`
- `fabric_mixin_register`（自动查找 mixins.json → 解析 → 追加条目 → 写回）
- `fabric_template_generate`（7 种内置模板：方块/物品/食物/实体/工具/护甲/配方）

### 构建与运行
- `trigger_build`
- `runClient`

### Minecraft 知识库
- `minecraft_data_lookup`（结构化数据查询）
- `mc_wiki_search`（百科向量检索）
- `vanilla_mc_wiki_query`（百科检索，自动使用本地向量库）

### 游戏内校验
- `mc_inspect`
- `mc_screenshot`
- `mc_ensure_test_world`

### 流程控制
- `ask_clarification`（严格澄清）
- `submit_plan`（结构化计划提交）
- `complete_step`（验收推进）

## 关键护栏

| 护栏 | 实现 |
|------|------|
| ACI 读门控 | `write_file` 前必须先 `read_file` |
| 重复成功守卫 | 同一步骤重复成功自动推进 |
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
