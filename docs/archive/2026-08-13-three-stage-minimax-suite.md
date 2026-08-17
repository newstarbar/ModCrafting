# MiniMax-M3 三阶段实机 Suite

日期：2026-08-13

本次 Harness 核心调整把游戏测试从“缺证据后弹通用澄清”改为确定性状态机：契约错误进入 Evidence Repair，观察环境错误进入 Environment Recovery，重复客观 FAIL 才进入 Product Repair；任何游戏测试 INCONCLUSIVE 都不会生成继续游戏断言的澄清。

新增 Observer V2 revision 4 字段、客户端/服务端独立快照、HUD/战斗轨迹游标、单调时钟和世界 Tick 检查，扩展声明式 `snapshot_relation`、`elapsed_between`、`combat_event`、`hud_text` 以及 `wait_until`。HUD 布局批准由主机保存不可变记录，截图不参与 verdict。

Test Lab 新增持久化 `modcrafting_suite_start`、`modcrafting_suite_evaluate_stage`、`modcrafting_suite_get_report`。一个 Suite 只复制一次工作区并复用一个 Electron 会话；三阶段固定任务消息按 PASS 解锁。Suite 审计模型调用为 `minimax/MiniMax-M3`，工具事件带 core/plugin/external 来源，非核心来源终止 Suite。

正式场景夹具已移除 `snapshot_changed`、固定坐标/生命/物品和自动澄清答复，改用 M/H/P-A-C 命名检查点、关系断言、唯一 Token、随机变量、真实死亡/重生和两次独立最终 PASS 契约。

补充护栏：严格场景拒绝裸 `afterAction`；HUD 轨迹年龄按命名检查点时刻计算；恢复的 HUD 布局使用主机规范化 `ApprovedLayoutRecord`；物品栏关系包含组件指纹；运行变量在动作执行前做数值、区域、槽位和堆叠边界校验；最终复测同时比较场景身份、Minecraft 进程、Observer 启动 ID、变量指纹和窗口指纹；Suite 未发送固定阶段任务或阶段间复用旧进程时直接 INCONCLUSIVE。

独立性补充：运行变量指纹不包含 Observer 启动 ID；第二轮最多重采样 10 次，仍与历史变量相同直接返回 `INCONCLUSIVE/INDEPENDENT_REPLAY_NOT_PROVEN`，不执行重复变量。Suite 还要求事件游标中存在完整的 MiniMax-M3 `ModelInvocation` 审计，缺失或混入其他模型均终止 Suite。

HUD 契约补充：阶段二和最终累计场景的必需断言强制归一化右上区域、Alpha≥204、阴影、批准布局元素以及 `H0` 攻击者名称与受害者 Token 同条文本语义，避免只捕获孤立 Token 形成形式 PASS。
Observer 状态准备接口增加 JVM 级一次性锁：首次 `kill_player` 后永久拒绝 `set_player_state`，独立复测必须跨 Minecraft JVM，避免死亡后重注入状态造成形式 PASS。

已验证：`npm test`（508/508）、`npm run build`、`npm run bridge:build`、`npm run test:app:hidden`、`npm run test:mcp`。Suite 阶段契约还强制同一事件窗口出现成功源码写入、`trigger_build(build)` 和带 `[MC_PHASE:ready]` 的 `trigger_build(runClient)`，防止直接复用旧产物形成形式 PASS。真实 Minecraft 和 Luna 的外部三阶段运行必须在有有效 MiniMax Provider、游戏窗口和 Observer 实例的主机上执行；没有这些外部证据时不得宣称最终 PASS。
