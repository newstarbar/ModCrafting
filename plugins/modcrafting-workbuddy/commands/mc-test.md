---
description: "跑一次确定性玩法测试并给出结论。"
argument-hint: "[测试 id] [featureType]"
---

按 `fabric-game-validation` 的验收边界执行。

1. 恢复本任务 `sessionId`，确认工程已构建成功。
2. `minecraft_run_client` 启动客户端，然后轮询 `minecraft_runtime_status` 直到 `canRunTests === true`；最多等 300 秒，同一种恢复动作不超过两次。
3. 用 `minecraft_test_template` 取模板（`featureType` 取 `$ARGUMENTS` 第二个参数），按用户需求改断言，不要凭空编字段。
4. `minecraft_test_start` → `minecraft_test_status`。
5. 汇报必须写清 `verdict`、`code`、每条证据的通过情况；`INCONCLUSIVE` 一律表述为"暂时无法验证"，并说明是环境、能力还是证据不足。
6. 需要视觉确认时用 `minecraft_screenshot` 存图，并明确这是人工证据，不是自动 PASS。
