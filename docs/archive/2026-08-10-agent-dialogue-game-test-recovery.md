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

## 更新：步骤证据与意图分类恢复

后续诊断发现，手写 Mixin 的 `fabric_mixin_validate` 已返回结构化成功，但 `inspect` 证据白名单只接受读取/搜索工具；紧接的 `complete_step` 因而表面成功、实际不推进。宿主现会先执行同轮验证，再裁决完成请求，并仅在验收标准显式声明、验证类型正确、目标路径匹配且 `valid=true` 时接受 Mixin/配方验证。无证据完成请求返回 `step_evidence_required`，重复两次后停止循环。

MiniMax 独立分类器此前发送了 `temperature: 0` 和对象式强制 `tool_choice`，并吞掉所有传输/解析错误，导致每轮落入同一兜底。现在按 Provider 使用兼容请求，遇到格式错误仅重试一次 JSON-only 分类；诊断导出记录脱敏的 Provider、模型、endpoint 主机、阶段和状态码。回归覆盖 Mixin 校验→完成→构建、MiniMax 请求体、协议文本解析、400 重试与 401 脱敏。
