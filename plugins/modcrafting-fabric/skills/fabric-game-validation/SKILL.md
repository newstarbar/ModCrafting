---
name: fabric-game-validation
description: Validate Fabric 1.21.4 gameplay changes with Observer V2 and deterministic ModCrafting game tests.
---

Use this skill when a Fabric change needs in-game evidence.

先用普通中文说明当前进展、遇到什么问题和下一步；向用户显示“已通过 / 未通过 / 暂时无法验证”，原始错误码和协议细节放在诊断信息中。一次聊天任务创建一个 `modcrafting_session`，把返回的 `sessionId` 传给后续构建、启动、状态、停止、测试和报告工具。继续旧任务时先恢复 session。不能用 MCP 连接标识代替任务 session。

1. 读取 `modcrafting_test_profile`。默认简体中文、1280×720、视距 8、60 FPS、30% 音量、旁白关闭；测试地图默认平地/种子 0、创造/和平并允许测试命令。只有用户明确选择保存工程默认时，才传 `saveAsProjectDefault:true`。
2. 构建成功后调用 `minecraft_run_client({sessionId,projectPath})`。插件会使用独立游戏目录，处理首次无障碍向导，自动创建或加载 `ModCrafting Test World`。复制存档只读来源，在会话副本里调整配置。不要要求用户手工覆盖 Observer 或预先编辑 `options.txt`。
3. 轮询 `minecraft_runtime_status({sessionId,instanceId})`，区分客户端启动、桥接连接与测试世界准备；只有 `canRunTests:true` 才继续。准备最多等待 300 秒；失败时查看阶段、当前界面和恢复建议。同一恢复动作最多尝试两次，禁止循环重启客户端。
4. 通过 `minecraft_test_template({featureType})` 取得实际 schema 和有效示例，再调用 `minecraft_test_start({sessionId,instanceId,spec})`。不靠多轮错误猜字段。测试仅在本会话归属的 `ModCrafting Test World` 和预留区域运行；绝不对开发者普通存档执行自动清理。
5. 使用相同 sessionId 查询/停止 job 并读取报告。`PASS` 表示结构化断言均通过且清理成功；`FAIL` 表示真实观察与预期不同；环境、证据、能力或清理问题返回 `INCONCLUSIVE`。启动成功、桥接响应、命令执行和玩法验证是不同结果；截图或单次命令不能代表测试通过。

This plugin supports inventory_contains, block_equals, entity_exists, entity_attribute, entity_name, entity_team, snapshot_value, and snapshot_changed with fresh before/after snapshots. entity_attribute reads health/maxHealth/attackDamage/movementSpeed from the observed living entity; entity_name and entity_team read the same snapshot. HUD, command_result, and trace-source snapshot assertions are CAPABILITY_UNAVAILABLE until freshness/semantics are implemented. Empty actions/assertions or malformed fields are INVALID_SPEC. Missing evidence and cleanup failure must never PASS. Check the report's code and cleanup status; unsupported assertions remain explicitly unavailable.

Live entity_exists assertions with a tag are CAPABILITY_UNAVAILABLE: Observer V2 reads client entities and cannot verify server command tags. Use entityType or the new entity_attribute/name/team assertions for observed entities; server tags may still identify owned entities in cleanup commands.

Prefer focused observation over full dumps: `minecraft_entity_query` returns nearby entities with health/maxHealth/attackDamage/position, `minecraft_widgets` returns the current screen and container slots, and `minecraft_entity_nbt` reads one NBT path. `minecraft_snapshot` is compact by default; set full=true only when diagnosing. `minecraft_screenshot` returns a path by default; inline=true is an explicit opt-in. Use `minecraft_log_read` for long job logs.
