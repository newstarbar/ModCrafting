# Harness 可靠性重构会话总复盘

**归档日期**：2026-08-11
**触发方式**：开发者主动
**涉及文件数**：75
**问题类型**：复杂 Bug 修复 / 核心 Harness 重构 / 测试基础设施 / 文档

## 背景

本次会话从“模组编译完成后，游戏内测试敷衍、乱测、随意成功或失败”开始。开发者随后连续提供真实会话诊断，暴露出计划步骤、工具门控、分类器、证据推进、自动修复和 UI 活跃状态之间的连锁故障。

最初的问题并非单个工具实现错误，而是 Harness 对“计划、执行、证据和裁决”的职责边界不清：模型可以自由决定测试流程，截图或启动状态可能被误当成功，环境失败可能触发业务代码修改，测试样例后来又反向渗入生产提示词和预算策略。仅靠人工启动应用、复现、导出诊断再修一个点，无法高效发现这些组合问题。

会话最终形成六个连续提交：

| 提交 | 主题 | 主要结果 |
|---|---|---|
| `aa0056b` | 确定性游戏测试 V2 | 分离 `run` 与 `game_test`，建立 Arrange → Act → Assert → Cleanup 和三态裁决 |
| `6d61051` | 游戏测试会话恢复 | 修复步骤类型、终端顺序、场景持久化和旧会话迁移 |
| `c92f454` | 步骤证据与分类器 | 结构化验证器可以推进步骤；MiniMax 分类失败变得可诊断 |
| `8d45807` | Test Lab 自动化 | 增加真实 Electron Automation Bridge、开发专用 MCP、沙箱和报告 |
| `299d17e` | 对话运行态 UX | Agent 运行时始终显示对话内活跃状态，自动化覆盖真实 React 生命周期 |
| `15700c9` | 去除样例过拟合 | 引入通用验收契约；具体复杂需求迁到 Test Lab 黑盒夹具 |

## 根因链

### 1. 启动、观察和功能成功被混为一谈

旧流程没有宿主控制的完整测试会话。客户端启动、进入世界、截图或一次观察都可能被模型解释为成功；失败也没有区分功能错误、环境错误和证据不足。结果是测试结论不可重复，自动修复的输入也不可信。

### 2. 计划语义、持久化类型和工具门控彼此漂移

`game_test` 曾被保存成 `inspect`，构建、启动和测试顺序可能颠倒。工具被门控拒绝时，错误处理又根据错误文本中的 `submit_plan` 字样误判实际工具，导致 `mc_run_test`、`trigger_build` 等调用反复循环，却显示无关提示。

### 3. 已有证据不能可靠推进步骤

`fabric_mixin_validate` 已返回结构化成功结果，但 `inspect` 步骤只承认读取和搜索。随后调用 `complete_step` 时，宿主返回表面成功的请求标记，却没有推进计划，UI 还可能显示步骤完成。证据执行和完成裁决的顺序也未统一。

### 4. 意图分类器失败被完全吞掉

MiniMax 分类请求使用了不兼容的 `temperature: 0` 和对象式强制 `tool_choice`。HTTP、协议和解析错误全部落入相同结构兜底，用户看到的是“任何消息都分类失败”，却没有 Provider、阶段或状态码可以定位。

### 5. 结构校验越权代替编译和运行验证

Java 身份解析会扫描注释，把注释中的 `class to` 识别成类声明。错误身份随后可能被注册器写入 Mixin 配置；结构校验又被当成编译证明，并能阻塞更权威的真实构建。Scaffold 还可能覆盖已有业务 Mixin，修复循环也可能越过计划路径修改无关代码。

### 6. 单元测试绕过真实应用生命周期

原有测试主要覆盖纯函数和局部 Harness 模块，没有启动真实 Electron、React、Controller、IPC、Provider 流和子进程，因此无法发现“程序仍运行，但对话里没有活跃状态”“澄清事件出现时上一轮尚未收束”等跨层问题。

### 7. 回归样例反向决定生产实现

在为复杂场景补回归时，玩家变身、具体热键、渲染模型、字段组合和额外模型预算进入了生产 Harness。测试不再验证通用能力，而是在要求产品迎合夹具，违背了 Harness 只管理契约、能力、时序和证据的边界。

## 最终架构

### 通用执行链

生产 Harness 现在遵循以下职责分离：

1. `AcceptanceContract` 将原始需求拆成原子 requirement。
2. 每条 requirement 只选择一种 Oracle：`build_success`、`game_assertion` 或 `user_confirmation`。
3. 宿主固定执行实现 → 构建 → 启动/桥接 → `game_test`。
4. `game_test` 创建全新会话，按 Arrange → Act → Assert → Cleanup 顺序执行。
5. 只有全部必要要求得到新鲜证据才返回 `PASS`。
6. 客观、可重复的功能断言失败才可能进入自动修复；环境、协议、能力和视觉确认问题保持 `INCONCLUSIVE`。

### 游戏证据协议

- V2 桥接提供 capabilities、command、snapshot 和 query。
- 快照带请求 ID、世界 tick 和时间戳，断言只能消费动作之后的证据。
- 通用断言覆盖命令、物品栏、主手、方块、实体、玩家、配方、Screen、控件和状态变化。
- 新增基于来源与 JSON Pointer 的 `snapshot_value`、`snapshot_changed`，以及有限容量的 `render_trace`、`hud_text`。
- Observer 只声明通用观测能力，不识别目标模组、业务类名或测试场景；缺少能力时显式返回 `INCONCLUSIVE`。
- 截图只是辅助证据。纯视觉布局必须等待用户确认，不能单独产生自动通过。

### 修复安全边界

- Java 身份解析先剔除注释、字符串和字符字面量，再校验包名、类名、文件名和源码路径。
- Mixin 注册先在内存生成结果，通过检查后再写入；失败不得留下部分配置。
- Scaffold 默认只创建新文件，普通业务 Mixin 不允许被模板覆盖。
- 结构验证只表示 `level: structural`，不能替代 Java 编译或 Mixin 实际加载。
- 自动修复只允许修改计划声明路径和本轮变更路径。
- 每步骤统一限制为 20 个模型轮次、40 次工具调用和 3 次写入—构建循环；相同失败无有效差异连续出现时收敛为可诊断的 `INCONCLUSIVE`。

### Test Lab

Test Lab 由三层组成：

- 应用内部 Automation Bridge：启动隔离的真实 Electron，使用随机本地端口和 Bearer Token，暴露语义命令、事件游标、快照和关闭接口。
- 开发专用 stdio MCP：负责启动应用、复制沙箱项目、发送真实对话、等待状态、响应澄清、读取报告和回收进程。
- 黑盒场景执行器：具体需求只存在于 `scripts/test/scenarios/`，从真实用户提示开始验证计划、工具、文件、构建和游戏证据。

日常门禁使用本地 OpenAI 兼容回放服务，真实 Provider 和 Minecraft 是显式、低频烟测。前台模式默认显示真实 ModCrafting 窗口，隐藏模式仅用于 CI 或无人值守回归。

## 关键文件

| 路径 | 作用 |
|---|---|
| `src/renderer/src/harness/acceptance-contract.ts` | 通用验收契约与旧游戏断言迁移 |
| `src/renderer/src/harness/game-test-protocol.ts` | 游戏规格、动作、断言、会话与兼容协议 |
| `src/renderer/src/harness/game-test-runner.ts` | 确定性测试状态机、证据时序和裁决 |
| `src/renderer/src/harness/workflow-engine.ts` | 步骤执行、证据推进、修复范围和预算 |
| `src/renderer/src/harness/turn-classifier.ts` | Provider 兼容分类、JSON 重试和脱敏诊断 |
| `src/renderer/src/components/ChatPanel.tsx` | 真实对话生命周期、活跃状态和自动化澄清恢复 |
| `src/main/automation-server.ts` | 回环认证的应用自动化桥 |
| `scripts/mcp/modcrafting-test-mcp.ts` | 开发专用 Test Lab MCP 与场景执行器 |
| `scripts/test/run-app-automation.ts` | 前台/隐藏应用级回放和真实烟测入口 |
| `bridge-mod/src/client/java/com/modcrafting/observer/GameTestApi.java` | Observer V2 能力、命令与快照入口 |
| `bridge-mod/src/client/java/com/modcrafting/observer/ObservationTrace.java` | 有容量上限的 HUD 与渲染轨迹 |
| `scripts/test/scenarios/` | 生产代码不可导入的复杂黑盒夹具 |

## 验证结果

最终提交前完成：

- `npm test`：438 项通过。
- `npm run test:mcp`：MCP 构造和工具发现通过。
- `npm run bridge:build`：Observer 构建并更新基础模组成功。
- `npm run build`：Electron 主进程、预加载和 Renderer 构建成功。
- `npm run test:app`：前台真实 Electron 回放通过，包含对话内 Agent 活跃状态断言。
- `npm run test:app:hidden`：隐藏兼容模式通过。
- 生产 Harness 源码边界扫描未发现猪模型、玩家变身、具体热键或样例语义验证器。

真实 MiniMax/Minecraft 前台烟测没有得到 `PASS`：模型生成了 AcceptanceContract，但提交计划时缺少完整 `gameTest`，宿主正确拒绝进入执行阶段并生成 `INCONCLUSIVE` 报告。后续一次长时间外部运行在没有新裁决证据时被人工停止。两个结果都没有被伪装为通过，也没有触发业务代码自动修复。

## 关键决策

1. **Harness 只验证契约，不选择业务实现。** 不通过自然语言正则推断应使用哪个 Mixin、Renderer、模型或 Fabric API。
2. **证据强度必须单向提升。** 结构校验不能代替构建，构建不能代替运行时断言，截图不能代替客观状态。
3. **测试失败和测试不可判定必须分开。** 只有确定性功能失败是 `FAIL`；Provider、桥接、导航、能力和超时问题是 `INCONCLUSIVE`。
4. **测试夹具不得成为生产依赖。** 样例可以非常具体，但只能从外部观察通用 Harness 能力。
5. **回放测试是日常门禁，真实服务是烟测。** 真实 Provider 的随机性、费用和网络状态不能决定基础回归是否稳定。
6. **UI 活跃状态属于正确性。** Agent 正在运行但界面像卡死，是应用级故障，必须由真实 React 生命周期回归覆盖。
7. **诊断优先于盲目重试。** 重复非法调用、相同构建签名和被拒绝的完成请求都应快速收敛并保留原始工具名和错误类型。

## 未闭环事项

- 三个复杂 Test Lab 夹具尚未全部在真实 Minecraft 中获得 `PASS`；当前只完成了结构、回放和一次未决前台烟测。
- 真实模型仍可能遗漏 `gameTest`。后续应优先改进通用 Schema 可发现性、结构化重试和计划诊断，不得为某个夹具添加关键词提示。
- `render_trace` 中无法可靠取得的 Model、纹理等字段必须继续通过 capabilities 声明不可用，不能用猜测值补齐。
- 视觉 `user_confirmation` 需要持续检查截图新鲜度、请求归属和拒绝后的非自动修复语义。
- Test Lab 报告应继续作为首次排查入口；只有桥本身无法启动时才回退到人工会话诊断导出。

## 可复用经验

- 当一个 Agent 问题必须依靠用户多轮人工复现才能发现，应优先补应用级观测和回放能力，而不是继续增加局部规则。
- “工具返回成功”不等于“步骤已满足”；步骤完成必须由宿主按结构化证据裁决。
- 测试能否通过不是唯一指标。架构测试还应禁止生产代码引用夹具、场景关键词或样例预算。
- 自动修复越强，越需要严格区分产品失败与 Harness 自身失败；否则测试基础设施会把自己的错误扩散到业务源码。
- 真实烟测中的 `INCONCLUSIVE` 是有价值的结果。它说明证据链在哪里中断，比截图成功或模型自行宣告完成更可靠。

## 相关专题归档

- [确定性游戏内测试 V2](./2026-08-09-deterministic-game-test-v2.md)
- [Agent 对话与游戏测试会话恢复](./2026-08-10-agent-dialogue-game-test-recovery.md)
- [Harness Test Lab and repair-safety recovery](./2026-08-10-harness-test-lab.md)
