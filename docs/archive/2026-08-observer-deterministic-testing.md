# Observer V2 严格确定性测试与形式 PASS 防护

本次 Harness 核心调整将游戏测试从“截图/命令发送成功”升级为可追溯的客观证据协议：

- GameTestSpec 支持命名检查点、运行变量、`set_player_state`/`kill_player`/`respawn` 受控动作。
- 新增 `snapshot_relation`、`elapsed_between`、`combat_event`，HUD 断言支持轨迹游标、归一化位置、颜色、透明度和唯一 token。
- GameTestSession 保存 Observer 启动 ID、变量指纹、检查点快照、动作真实耗时和世界 Tick。
- Observer V2 增加服务端尺寸/眼高/维度、HUD 全文本重载轨迹、战斗归因轨迹和受限玩家状态控制。
- 缺少证据、能力或世界 Tick 时只进入 Evidence Repair / Environment Recovery / INCONCLUSIVE，不再自动弹出通用澄清。
- 多次 PASS 必须来自不同 Observer 启动 ID和不同运行变量指纹；否则返回 `INDEPENDENT_REPLAY_NOT_PROVEN`。

严格三阶段场景应使用 M0/M1/M1_STABLE/M2/M2_STABLE、H1/H2/H3/H4、P/A/C/D/R 检查点，并由 Luna 只批准 HUD 布局，不补写断言。
