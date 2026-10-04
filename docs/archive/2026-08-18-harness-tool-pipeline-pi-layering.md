# Harness 工具调用管线 Pi 式分层重构

**归档日期**：2026-08-18  
**触发方式**：大功能自动  
**问题类型**：Provider 工具流聚合与 Harness 白名单误判

## 根因

诊断附件中的 22 次 `read_file` 失败不是路径白名单拒绝，而是流式工具调用被拆成两条记录：首块带真实 `id`/工具名，后续参数块只有 `index`。旧适配器生成 `call_0`，Agent 又只按 ID 合并，最终执行器收到 `{}` 并报告 `invalid_tool_arguments`。Schema 错误随后被和白名单错误拼成同一条提示，触发重复调用和错误的硬刹车。

## 改动

- `NormalizedModelEvent` 明确区分 `tool_call_start/delta/end`，不在 Provider 层生成临时 ID。
- `ToolCallAssembler` 按 index 优先、ID 其次聚合，并建立双向别名；参数完整前不解析、不执行。
- `ActiveToolSnapshot` 成为每轮唯一能力快照，模型公开工具与返回校验共享同一份工具 Schema。
- `ToolFailureKind` 将未知工具、未激活工具、流截断、Schema 错误、策略阻止和真实执行失败分开。
- Provider 截断调用不会写回下一轮 assistant tool-call 历史；否则兼容网关可能在恢复请求前再次拒绝非法 JSON。
- `ModelAdapter` 支持 OpenAI Chat、Anthropic Messages 和 XML fallback；分类器与压缩调用也走该适配层。
- MiniMax 新配置默认官方 Anthropic endpoint；旧 `/v1` endpoint 保持兼容，显式 endpoint 优先。
- 协议连续故障不消耗代码修复预算：原生重试两次后进入 XML，仍失败交给已配置 fallback 或 `PAUSED`。
- checkpoint 和 Session 诊断导出保留协议诊断、chunk index/ID、参数长度、降级过程，但不记录 API Key 或完整敏感参数。

## Pi 设计映射

Pi 的 Provider 层负责流协议和工具调用聚合，Agent Loop 在参数完成并通过校验后才运行工具 hook，Coding Agent 再通过 active tools 与独立路径策略表达计划模式和安全边界。本次实现保留 ModCrafting 的 Electron IPC、影子工作区和 AcceptanceContract，只吸收这三个边界，避免在核心循环叠加动态白名单。

参考：

- [Pi OpenAI stream aggregation](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)
- [Pi agent loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- [Pi plan mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts)
- [Pi protected paths](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/protected-paths.ts)
- [Pi MiniMax Anthropic provider](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/minimax-cn.ts)

## 验证

- 回放首块带 ID、后续仅 index 的 `read_file` SSE（包括首块没有 index 的网关变体），得到一个带完整 `path` 的调用。
- 覆盖交错调用、延迟 ID、无 ID、跨 chunk JSON、Unicode、截断和 Anthropic `tool_use/input_json_delta`。
- `npm test`：523/523 通过；新增工具管线回放测试覆盖聚合、错误分类和未知/未启用工具区分。
- `npx tsc -p tsconfig.node.json --noEmit --pretty false`：通过。
- `npm run build`、`npm run test:app`、`npm run test:mcp`：通过。
