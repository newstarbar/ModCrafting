# Vibecoding 工作流

## Test Lab regression workflow

### Game-test recovery states

An inconclusive `mc_run_test` is routed by structured code, never by localized
reason text and never through the product-preference clarification overlay:

`CONTRACT_CHECK -> SCENARIO_READY -> RUNNING -> PASS/FAIL/INCONCLUSIVE`.
Invalid evidence enters bounded `EVIDENCE_REPAIR` (new scenario ID required),
Observer/world failures enter two-attempt `ENVIRONMENT_RECOVERY`, and only a
purely visual claim enters `VISUAL_REVIEW`. A stale or superseded scenario
cannot advance a game-test step. Only an explicit Agent `ask_clarification`
call can pause for user input.

修改 Harness 时，优先运行确定性应用场景，不要先要求开发者人工复现并导出诊断。`npm run test:app` 会在独立 profile 中前台启动真实 Electron、复制沙箱夹具、配置内存回放 Provider、发送真实对话并验证 Controller/React/事件账本。`npm run test:app:hidden` 用于无人值守或 CI；`npm run test:mcp` 验证开发专用 stdio MCP。

Standalone runner 的产物位于系统临时目录 `modcrafting-app-test/<runId>/artifacts/`；通过 MCP 启动的运行位于 `%LOCALAPPDATA%/ModCrafting Test Lab/runs/<runId>/artifacts/`。

真实 Provider 或 Minecraft 只用于显式低频烟测。凭据、Provider、Observer、启动或宿主环境不可用时结果为 `INCONCLUSIVE`，不得转换为代码修复信号。

## 确定性游戏内测试

游戏内验收采用确定性测试状态机，而不是“看到截图就算成功”：

1. `runClient` 仅在客户端菜单稳定、目标模组与 `modmenu`/`modcrafting_observer` 都出现在 Fabric 加载清单、并且 Observer V2 capabilities 可连接时完成；`MC_PHASE:menu` 不是通过证据。
2. `mc_test_scenario` 根据实际功能创建带目标 ID 与断言的测试规格。
3. `mc_run_test` 在专用 `ModCrafting Test World` 内准备环境、执行动作、采集动作后的快照、逐项断言并清理。
4. 只有满足场景 `requiredPassCount` 的独立 `PASS` 才可结束客观测试；需要多次 PASS 时主机重启 Minecraft 并从 setup 重放同一场景。`FAIL` 需清理后原样复测一次才会触发产品修复；`INCONCLUSIVE` 由 Harness 按结构化原因自动进入契约修订（最多三次）、环境恢复（最多两次）或专用视觉审核，绝不把导航、桥接或视觉问题当成代码错误，也不弹出通用澄清。

实施计划先提交 `AcceptanceContract`：每条用户需求必须映射到构建成功、游戏断言或用户视觉确认。Harness 不包含样例功能的实现建议；复杂例子仅作为 Test Lab 的黑盒夹具运行。

计划终端顺序固定为“实现 → 构建 → 启动客户端/桥接 → `game_test`”。执行阶段只会对真实的 `submit_plan` 调用给出阶段提示；其他被门控的工具保留原工具名和允许列表，避免错误提示驱动的调用循环。恢复历史会话时会迁移旧的 `inspect + mc_run_test` 步骤，并恢复保存在计划或工具 JSON 中的场景规格。

截图是报告附件，不能单独通过测试。物品、方块、配方、实体、交互和 GUI 分别使用注册表、背包/主手、方块/实体快照、命令结果、Screen/控件状态等客观证据；纯视觉布局交由用户确认。

ModCrafting 把 **AI 对话式开发（Vibecoding）**、**Fabric 工程脚手架**、**一键游戏内测试** 和 **离线构建环境** 整合进同一个 Electron 桌面应用。

## 核心流程

```
用户需求
    ↓
分类 → 项目勘探 → submit_plan
    ↓
AcceptanceContract + 实现步骤
    ↓
执行实现 → build → run/bridge → game_test
    ↓
逐 requirement 汇总 PASS / FAIL / INCONCLUSIVE
    ↓
仅可重复、范围内的功能 FAIL 进入受限修复
```

## 三模式智能路由

每轮独立 LLM 分类，自动分流至三种模式：

| 模式 | 触发场景 | 工具集 | 行为 |
|------|---------|--------|------|
| **Chat** | 概念问答、方案说明 | 禁用写入/执行工具 | 直接给最佳方案不做比较 |
| **Plan** | 开发任务 | 只读工具 + `submit_plan` | 1-9 步结构化实现计划（宿主另行追加构建、启动和游戏测试） |
| **Execute** | 计划已批准 | 全部工具（按步骤门控） | 逐步执行，每轮必调工具，旁白 ≤2 句 |

同时识别错误报告、用户症状、游戏内验证请求等侧面信号并注入到目标块中。MiniMax 分类使用兼容的工具请求（正数低温度、不强制对象式 `tool_choice`）；响应格式不兼容时同一超时预算内尝试一次 JSON-only 分类，仍失败才使用结构兜底，并在诊断导出中记录脱敏失败原因。

## Plan → Execute 双阶段

### Plan 阶段

- **目的**：让 AI 先勘探项目再给出结构化计划
- **工具**：只读工具（`list_directory`、`read_file`、`grep`、`fabric_docs_search` 等）+ `submit_plan` + `ask_clarification`
- **门控**：`plan-phase-gate.ts`
  - `MAX_READONLY_ROUNDS = 15`：超过 15 轮只读勘探后进入"建议提交"状态
  - 锁定后仍允许 `grep` / `list_directory` / `read_file`，仅禁用写入工具
  - 措辞为"建议尽快提交"而非"已锁定"
- **输出**：`submit_plan`（write / recipe / mixin / inspect 实现步骤；`AcceptanceContract`；游戏功能附带动作定义的 `gameTest`）

### 计划编译

`plan-compiler.ts` 处理管道：解析 → 迁移旧步骤 → 剥离模型生成的终端步骤 → 删除模糊步骤 → 按路径去重 → 由宿主追加 build → run → `game_test`。游戏计划缺少完整 V2 `gameTest` 或 AcceptanceContract 时，执行门控直接拒绝，不允许从 Markdown 计划绕过。

### Execute 阶段

`workflow-engine.ts` 串行逐步执行：

- `complete_step` 先等待本轮验证工具结束；只有证据成立才推进。无证据请求会明确返回 `step_evidence_required`，连续两次不会再无限循环。
- `inspect` 验收可以声明 `fabric_mixin_validate` 或 `fabric_recipe_validate`；宿主仅接受 `valid=true`、对应验证类型和匹配目标路径的结构化结果。

- 每轮执行**全部**允许的工具（只读并行，写入串行）
- 知识查询工具不消耗 attempt 配额
- 每步骤最多 20 个模型轮次、40 次工具调用和 3 次写入—构建循环
- 构建失败只有落在计划/本轮变更范围内才进入修复；范围外返回 `INCONCLUSIVE/out_of_scope_build_failure`
- 同一失败签名没有有效差异连续出现时停止，要求重新规划
- 支持 `ask_clarification` 暂停向用户提问

## 澄清提问

`ask_clarification` 工具：

- **允许场景**：产品偏好、需求歧义
- **禁止场景**：代码事实（API 命名、类名、mixin 路径等）必须走工具勘察
- 执行阶段通过 `ClarificationNeeded` 事件 + ChatPanel 横幅 UI 交互；答复会等待前一轮完全收束后再恢复，避免竞态丢失

## 项目向导

图形化新建项目：

- **输入**：Mod ID、包名、作者、版本
- **自动生成**：`build.gradle`、`fabric.mod.json`、入口类
- **捆绑 mod**：基础模组同步会验证 Fabric ID 与 Observer V2 元数据，优先使用当前应用内 JAR；运行时下载的旧版双层目录会先自动迁移。同步失败时禁止启动 `runClient`。

## 模板快速创建

7 种内置模板，表单填写后跳过 Plan 阶段，直接由 `fabric_template_generate` 工具透传生成：

| 模板 | 说明 |
|------|------|
| 自定义方块 | Block with Item |
| 自定义物品 | Simple Item |
| 自定义食物 | FoodComponent |
| 自定义实体 | Entity + Renderer |
| 自定义工具 | ToolItem / Tier |
| 自定义护甲 | ArmorMaterial |
| 自定义配方 | Recipe JSON |

## 项目勘探

计划阶段前自动读取：
- `fabric.mod.json`
- `*.mixins.json`
- 资源目录结构

注入到系统提示词，供 AI 了解项目当前状态。

## 崩溃与构建错误处理

1. 自动检测崩溃报告（`mc-runtime.ts`）
2. 一键附加到对话上下文
3. Harness 先区分产品错误、环境错误、Harness 错误和计划范围外错误
4. 只有范围内、可重复的产品失败进入“修改 → 重建 → 新会话复测”
5. 环境、导航、Provider、Observer 能力或计划范围外错误保持 `INCONCLUSIVE`

## 图形化游戏测试

- 多实例支持（独立 `gameDir` 与 Gradle 守护进程）
- 阶段进度条
- 人话摘要（避免原始 Gradle 日志噪音）
- 独立 `GRADLE_USER_HOME` 隔离
- `run` 与 `game_test` 分离，启动成功不会显示成功能验收通过
- Agent 运行时在对话内显示持续活跃状态；停止、澄清和完成使用真实 Controller 状态

## 上下文压缩

- 老旧工具结果微压缩
- 接近 token 上限触发 LLM 摘要
- 跨轮诊断保留（近期 5 条用户反馈 + 2 条助手摘要）

## 路由工作流

输入区可在“路由预设”和“固定模型”间切换。路由模式把策略（快速、均衡、深度及更多预设）和任务模板（自动、新功能、Bug 修复、UI/GUI、构建环境、Minecraft 内容、重构、知识/文档）分别作为会话临时选择；未修改时使用全局默认。执行时从路由、协调、只读勘探、规划、实现、诊断/审查、验证到总结逐步推进，且仅实现职责可写文件。

齿轮打开独立设置中心。用户可按厂商配置 Endpoint、默认模型和加密密钥，在“模型路由”查看职责与预算，在“预设”复制、导入或导出不含密钥的自定义策略。

## API 配置

| 字段 | 默认值 | 说明 |
|------|--------|------|
| API Endpoint | `https://api.deepseek.com/v1` | OpenAI 兼容接口地址 |
| Model | `deepseek-v4-flash` | 可从内置 Provider/模型列表切换 |
| API Key | （用户填写） | 本地加密存储，**切勿提交到 Git** |

支持 DeepSeek 等 OpenAI 兼容端点；密钥仅存本机，不进仓库。
