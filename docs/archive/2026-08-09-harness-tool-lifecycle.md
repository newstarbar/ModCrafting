# Harness 工具策略与取消链路重构

**归档日期**：2026-08-09
**触发方式**：大功能自动
**涉及文件数**：21
**问题类型**：重构 / 复杂 bug 修复

## 背景

真实使用中 Agent 会卡在工具调用；同时，系统提示要求查询 Minecraft 数据，但多个步骤白名单并未提供对应工具，造成重复 `tool_not_offered`。

## 根因分析

工具执行器此前直接等待工具 Promise，批量只读调用使用 `Promise.all`，没有统一 deadline。渲染层 abort 也无法取消主进程 shell/Gradle 子进程，GUI 预览 Promise 只有用户操作才能结束。工具集合则由多个分散的名称数组维护，提示词、Plan 和工作流门控容易漂移。

## 改动清单

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `src/renderer/src/harness/tool-policy.ts` | 新增 | 集中定义能力、超时和步骤推荐工具集合。 |
| `src/renderer/src/harness/tools.ts` | 修改 | 增加 run/execution ID、timeout/cancel outcome、并发上限与 `allSettled` 批处理。 |
| `src/main/tool-execution-registry.ts` | 新增 | 管理主进程 Agent 工具取消信号。 |
| `src/main/build-env.ts`、`src/main/ipc-handlers.ts` | 修改 | 给命令/Gradle 传递执行 ID，支持取消和 Windows 进程树终止。 |
| `src/renderer/src/harness/*` | 修改 | Plan/步骤策略改用能力目录，步骤时机问题改为 `policy_deferred`。 |

## 关键决策

- 保留工具名和 JSON Schema；仅替换内部选取与执行生命周期。
- 对计划期写入、危险命令和 Schema 错误保留硬拒绝；普通步骤时机冲突不再永久封禁工具。
- 超时不自动重试，避免重复写入、重复构建或启动多个游戏实例。
- GUI 预览属于显式用户等待，不设墙钟超时；停止、会话切换和清空会话必须主动 resolve。

## 验证方式

- `npm test`：401 项通过，新增悬挂工具超时、取消 outcome、能力可见性测试。
- `npm run build`：Electron main、preload 与 renderer 均通过生产构建。

## 经验教训

工具权限和工具执行不能分别以名称数组与临时 Promise 管理。新增工具时必须在能力目录中声明；所有非交互调用都必须有可观测的终态和可传播到主进程的取消路径。
