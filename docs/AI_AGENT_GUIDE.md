# AI Agent 开发指南

本文件是 Codex、Claude Code、Cursor 等仓库维护 Agent 的当前入口。具体实现以专题文档和源码为准，不再在这里复制一份容易过时的完整架构。

## 开始工作前

1. 阅读根目录 `AGENTS.md` 或对应 Agent 指引。
2. 根据任务选择专题文档：
   - [架构](./architecture.md)
   - [Harness](./harness.md)
   - [Vibecoding 工作流](./workflow.md)
   - [Test Lab MCP](./test-lab-mcp.md)
   - [命令清单](./commands.md)
3. 检查 `git status`，保留用户已有的未提交修改。
4. 修改 Fabric 内容生成逻辑前，遵循 `minecraft_data_lookup` 的标准 ID 与属性查询约定。

## 当前 Harness 不变量

- 每轮用户消息独立分类为 Chat、Plan 或 Execute；分类失败只能降低路由精度，不能阻止主 Agent 继续。
- 游戏相关计划必须通过 `submit_plan` 提交完整 `AcceptanceContract` 和 V2 `gameTest`。
- 宿主管理终端顺序：实现 → build → run/bridge → `game_test`。
- `run` 只证明客户端和 Observer 已启动；只有 `mc_run_test` 的新会话 `PASS` 能完成 `game_test`。
- 截图、TitleScreen、进入世界或“命令已发送”都不是功能成功。
- `FAIL` 只表示客观可重复的产品断言失败；环境、Provider、导航、Observer 能力和纯视觉确认问题是 `INCONCLUSIVE`。
- 只有同一功能失败签名在清理后的两个独立会话连续出现，才允许自动修复。
- 自动修复只能修改计划声明路径与本轮变更路径；每步骤上限为 20 个模型轮次、40 次工具调用、3 次写入—构建循环。
- 结构化 Mixin/配方验证是结构证据，不是 Java 编译或运行时加载证明。
- 生产 Harness 不得导入 `scripts/test/scenarios/`，也不得包含某个黑盒夹具的实现建议、关键词特判或额外预算。

## 修改 Harness 时

优先检查这些单一事实来源：

| 关注点 | 单一事实来源 |
|---|---|
| 工具能力、超时和推荐集合 | `src/renderer/src/harness/tool-policy.ts` |
| 验收契约 | `src/renderer/src/harness/acceptance-contract.ts` |
| 游戏规格与断言 | `src/renderer/src/harness/game-test-protocol.ts` |
| 游戏执行与裁决 | `src/renderer/src/harness/game-test-runner.ts` |
| 步骤执行与修复 | `src/renderer/src/harness/workflow-engine.ts` |
| 证据推进 | `src/renderer/src/harness/step-evidence.ts` |
| Provider 分类 | `src/renderer/src/harness/turn-classifier.ts` |
| 会话/UI 生命周期 | `src/renderer/src/harness/controller.ts`、`src/renderer/src/components/ChatPanel.tsx` |
| 应用自动化桥 | `src/main/automation-server.ts` |
| Observer V2 | `bridge-mod/src/client/java/com/modcrafting/observer/` |

新增内置工具时必须同步 `tool-policy.ts`；注册表验证会拒绝缺少策略的工具。新增游戏断言时，Schema、运行时验证、执行器、持久化迁移和回归测试必须使用同一结构定义。

## 验证矩阵

按改动范围运行最小充分集合：

```bash
npm test                 # Harness 必跑
npm run build            # TypeScript/Electron 构建
npm run test:mcp         # 修改 Test Lab/MCP 时
npm run test:app         # 修改 Controller、React、IPC、分类或工作流时
npm run test:app:hidden  # 修改窗口可见性/CI 路径时
npm run bridge:build     # 修改 Observer/游戏证据时
```

`test:app:live` 和 `test:app:game` 是显式低频烟测。它们可能因外部服务或环境得到 `INCONCLUSIVE`，报告中的结构化证据才是结论；不允许用截图或进程启动把结果改成 PASS。

## Test Lab 使用原则

- 日常回归使用本地回放 Provider，以固定请求、流式文本和工具调用。
- 所有目标项目复制到沙箱；不要直接对用户项目运行黑盒场景。
- 默认显示 Electron 窗口，便于观察 Agent 活跃状态、计划和工具事件；CI 使用 `test:app:hidden`。
- 真实 API Key 不经过 MCP、不复制到测试 profile、不写入报告。
- 先检查 Test Lab 报告，再请求用户导出人工诊断。

## 文档与归档

- 功能行为改变时同步更新 `docs/harness.md`、`docs/workflow.md`、`docs/architecture.md` 或 `docs/test-lab-mcp.md`。
- `docs/archive/` 记录当时的问题、决策和验证，是历史事实；当前使用说明以非 archive 文档为准。
- 大型重构、复杂 Bug 或 Agent 行为规则变化按 [归档规范](./archiving.md) 写入归档并更新索引。

## 提交前检查

- 未包含 API Key、Authorization、`.env`、个人路径或测试 profile。
- 未提交 `node_modules/`、`release/`、`runtime/`、临时 Test Lab 产物。
- 修改 Observer 后基础 JAR 已由 `npm run bridge:build` 更新。
- `AGENTS.md` 与 `CLAUDE.md` 保持精简且不超过 150 行。
- 文档链接、命令名和工具数量与当前源码一致。
