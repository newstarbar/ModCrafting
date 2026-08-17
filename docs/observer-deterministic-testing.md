# Observer V2 严格实机测试协议

本项目的正式三阶段测试使用持久化 Test Lab Suite，而不是每个场景重新复制夹具。Suite 一次复制 `resources/_offline_verify_project`、启动一个可见 Electron 会话，并固定所有模型调用为 `minimax/MiniMax-M3`。Luna 只发送三条固定任务句；阶段二可以批准一次 HUD 布局，不能补写断言。

## 启动与阶段推进

通过项目自带 Test Lab MCP：

1. `modcrafting_suite_start`：创建 `%LOCALAPPDATA%/ModCrafting Test Lab/runs/<runId>/workspace`，保存源/工作区哈希、Observer 基础模组哈希、Provider、模型和首个事件游标。
2. `modcrafting_send_turn`：严格按当前阶段接受固定任务句。工作区、会话和 Provider 在 Suite 中不可替换。
3. `modcrafting_wait`：等待 Agent 完成；游戏测试产生澄清时立即记录 INCONCLUSIVE，不发送继续或补充断言。
4. 阶段二需要布局时，Luna 只调用 `modcrafting_respond(gui_layout)`。主机保存不可变 `ApprovedLayoutRecord`，并将逻辑画布坐标归一化。
5. `modcrafting_suite_evaluate_stage`：只读取发送任务前的事件游标之后的证据。PASS 才能解锁下一条固定任务句。
6. `modcrafting_suite_get_report`：生成 `suite.json`、阶段报告和事件审计。

正式 Suite 禁止 `modcrafting_run_scenario`、`modcrafting_open_project`、Provider 替换和澄清答复。Luna 不编辑项目源码，不代替 Agent 生成 `mc_test_scenario`。

## 客观观察协议

- `snapshot_relation` 使用左右独立 `{checkpoint, source, pointer}` 操作数，支持客户端/服务端同步、比例、容差和 `inventory_v1` / `player_state_v1` 深比较。
- 命名检查点保存 Observer 游标、服务器世界 Tick、主机单调时钟和动作时间线；60 秒等待必须同时满足墙钟至少 60 秒与 Tick 差至少 1200。
- `hudTrace` 必须包含序号、文本、屏幕尺寸、文本宽度、归一化坐标、ARGB/Alpha、阴影和绘制时间。HUD 断言只能消费当前检查点游标之后的新轨迹。
- 玩家击杀 HUD 可声明 `requireAttackerVictimSemantics` 和 `attackerCheckpoint`；Observer 会从该检查点读取当前玩家名称，并要求同一条新鲜 HUD 文本同时包含攻击者名称和本轮受害者 Token。
- `combatTrace` 必须证明受害者标签、真实死亡、伤害类型和攻击者 UUID；非玩家负向测试先证明非玩家击杀真实发生。
- 服务端快照提供名称、宽/高/眼高、饥饿、饱和度、选中槽和带槽位物品栏；客户端和服务端是两个独立来源。
- 物品栏条目保留 `componentFingerprint`；运行变量解析后再次检查坐标、生命/饥饿、槽位、数量和未解析占位符，边界错误归入 `SPEC_RUNTIME_VARIABLE_INVALID`。
- `wait_until` 用于 DeathScreen、服务端玩家重新可用和死亡界面退出，不用固定短等待替代状态检查。
- 最终独立复测的运行变量指纹不包含 `observerSessionId`；主机最多重采样 10 次，仍与历史变量相同则返回 `INCONCLUSIVE/INDEPENDENT_REPLAY_NOT_PROVEN`，不会执行重复变量或累计 PASS。
- Suite 必须在事件游标内看到完整的 `ModelInvocation` 审计，且每个调用均为 `minimax/MiniMax-M3`；缺少审计本身也按 INCONCLUSIVE 处理。
- 正式阶段契约还必须在同一事件游标内看到成功的项目源码写入、`trigger_build(task="build")` 和带 `[MC_PHASE:ready]` 的 `trigger_build(task="runClient")`；否则即使场景 PASS 也不能推进阶段。

## 三阶段强制断言

### 阶段一

`M0 → G1_SENT → M1 → M1_STABLE → G2_SENT → M2 → M2_STABLE`。必须验证服务端宽/高为 M0 的 `0.50 ± 2%`，客户端/服务端一致，M1 稳定 1.5 秒，M2 的宽/高/眼高恢复 M0，UUID 全程不变。

### 阶段二

先累计回归阶段一，再执行 `H0/H1/H2/H3/H4`。H1/H2 必须有当前目标 Token 的新鲜 HUD；坐标归一化位于右上区域，样式匹配主机批准记录，H3 已过期，H4 的真实非玩家击杀没有该 Token。截图只用于审计，不参与 verdict。

### 阶段三

先累计回归前两阶段。随机生成互不相同的 P/A/C；P 到 D 使用真实 61 秒等待；D 是真实死亡界面，R 是真实重生后的可用玩家。R 必须逐项恢复 P 的 XYZ、生命、饥饿、饱和度、完整物品栏、选中槽和维度，且 R 不等于 A/C。最终场景要求两次 PASS，第二次必须是不同 JVM、不同 Observer 启动 ID、不同变量指纹和不同窗口尺寸，但相同 scenarioId、revision 和场景指纹。

## 失败归责

- 规格/能力字段错误：Evidence Repair，最多三次新 scenarioId，禁止改产品和询问用户。
- Observer/世界/进程不可用：Environment Recovery，最多两次；截图不能降级为 PASS。
- 客观断言第一次 FAIL：清理后用同一变量原样复测。
- 同一断言第二次 FAIL：Product Repair；修改源码后完整构建、启动，先用原失败变量诊断，再用新随机变量正式测试。
- 游戏测试 INCONCLUSIVE 永远不产生通用 `ClarificationNeeded`。出现意外澄清、续跑或插件/外部工具，Suite 终止为 INCONCLUSIVE。

反例覆盖：仅客户端缩放、0.7 倍缩放、瞬时缩放、聊天 KILL、旧轨迹、HUD 0.1 秒/超过 6 秒、固定像素布局、未真实死亡、固定 P 状态、世界 Tick 未推进、同 JVM/同变量复测、废弃 scenario/revision 和截图降级。

状态准备接口在 Observer 服务端按 JVM 加锁：第一次 `kill_player` 成功后，后续 `set_player_state` 即使发生重生也返回 `STATE_PREPARATION_LOCKED`。下一次独立复测必须启动新的 Minecraft JVM；这样不能通过死亡后再次注入状态制造恢复 PASS。
