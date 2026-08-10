# Agent 对话与游戏测试会话恢复

日期：2026-08-10

## 问题

诊断会话将 `mc_run_test` 计划步骤错误保存为 `inspect`，且位于构建和启动之前。工具门控拒绝中包含允许工具列表；执行器错误地只要看到字符串 `submit_plan` 就把任何被拒绝的工具伪装为 submit_plan 成功提示，导致 `mc_run_test`、构建和启动反复循环。

## 修复

- `submit_plan` 生成真实 `game_test`，计划编译器固定终端顺序为实现、build、run、game_test。
- 仅真实 `submit_plan` 调用获得执行阶段提示；其他拒绝保留原工具名与错误类型。
- `GameTestSpec` 采用严格断言与动作验证；玩家热键交互生成 input 动作，实体存在断言支持预期不存在。
- 计划步骤可持久化完整规格；恢复时重新注册场景，并扫描旧工具输出中的 fenced V2 JSON。旧 `inspect + mc_run_test` 会迁移到 game_test 并重排。
- 找不到或无法恢复场景时返回 `INCONCLUSIVE`，不进入自动修复。

## 验证

- `npm test`：412 项通过。
- `npm run bridge:build`：通过。
- `npm run build`：通过。
