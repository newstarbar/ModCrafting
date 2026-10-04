# Harness 原子交付与自愈闭环重构

**归档日期**：2026-08-18  
**触发方式**：大功能自动  
**涉及文件数**：25+  
**问题类型**：核心 Harness 重构

## 背景

实际运行中，Harness 会在构建或游戏测试失败后反复读取同一份日志、重复检索知识库并重复构建，修复预算耗尽后异常结束会话。用户项目还可能在验证完成前被直接改写，应用重载或 API 超时后也无法从原修复状态继续。可靠性不能依赖针对某个模组功能训练模型，而应由宿主侧的项目画像、影子工程、确定性诊断和可恢复状态机保证。

## 根因分析

旧流程把探索、生成、完整构建、日志解释和修复放在同一个文本循环中：所有文件写完才验证；进展只比较错误数量；修复次数固定且不能按诊断簇重新计数；构建结果与日志读取没有结构化边界；真实工程没有事务隔离。因此模型即使看到相同错误，也没有可靠的“已尝试什么、为什么失败、下一步应推进哪个阶段”的状态。

## 改动清单

| 文件路径 | 改动类型 | 说明 |
|---|---|---|
| `src/shared/harness-runtime.ts` | 新增 | `ProjectProfile`、`ExecutionWorkspace`、`BuildReport`、`ValidationResult`、`TaskCheckpoint`、Provider 能力协议。 |
| `src/shared/harness-diagnostics.ts` | 新增 | 诊断集合指纹、根因消除和阶段推进判定。 |
| `src/main/workspace-manager.ts` | 新增 | 影子工作区、排除目录、基线哈希、补丁 journal、冲突检测、原子 promote/rollback。 |
| `src/main/project-profile.ts` | 新增 | 解析 Gradle/Loom/source sets、Fabric 元数据、入口点、Mixin、access widener 和符号索引状态。 |
| `src/main/build-report.ts` | 新增 | 英文/中文编译器、Gradle、Mixin 和启动日志的结构化诊断与级联去重。 |
| `src/main/baseline-cache.ts` | 新增 | 按项目与画像指纹缓存成功的基线编译报告。 |
| `src/main/checkpoint-store.ts` | 新增 | 原子写入和读取可恢复任务检查点。 |
| `src/main/ipc-handlers.ts` | 修改 | 暴露画像、workspace、staged build、BuildReport、基线缓存和 checkpoint IPC；构建直接返回报告。 |
| `src/preload/index.ts`、`src/renderer/src/vite-env.d.ts` | 修改 | 将宿主能力安全暴露到 Harness。 |
| `src/renderer/src/harness/workflow-engine.ts` | 修改 | 增量 validation gate、静态检查、诊断驱动修复、重复构建/日志/知识查询护栏和可恢复预算。 |
| `src/renderer/src/harness/controller.ts` | 修改 | 任务启动画像与影子工程、checkpoint 保存/恢复、fallback、严格验收后的原子交付和失败回滚。 |
| `src/renderer/src/harness/agent.ts`、`model-adapter.ts` | 修改/新增 | 标准化 Provider 请求、能力探测、流式 reasoning/tool/usage 事件和适配层。 |
| `src/renderer/src/harness/tool-definitions.ts`、`tools.ts`、`events.ts` | 修改 | `trigger_build` 返回 `BuildReport`，工具事件携带结构化报告。 |
| `src/renderer/src/harness/knowledge-fact-cache.ts`、`doc-search-dedup.ts` | 新增/修改 | 画像版本作用域的知识事实缓存和近似查询去重。 |
| `docs/harness.md`、`src/renderer/src/utils/log-parser.ts`、`fabric-agent-policy.ts` | 修改 | 更新预算、状态机、验证门和修复协议说明。 |
| `scripts/test/harness-runtime-reliability.test.ts` | 新增 | 覆盖 BuildReport、画像、workspace 事务、重启回滚、知识缓存和 Provider 能力。 |

## 关键决策

1. Agent 的全部读写、编译和测试先落到应用数据目录的影子工程；只有编译和最终 `AcceptanceContract` 通过才 promote。
2. 发生并发编辑、最终构建失败、网络中断或预算耗尽时保存影子工程和 checkpoint，状态进入 `PAUSED` 或 `promotion_conflict`，不异常终止会话。
3. 构建失败由宿主直接变为 `BuildReport`，模型按 diagnostic ID、根因假设、文件补丁和预期验证推进提交 `RepairProposal`；重复读取已包含的日志不再算进展。
4. 保留已配置的 primary/fallback 链，不自动调用未配置模型；模型无需训练，Provider 差异收敛在 `ModelAdapter`。
5. 可靠性预算使用同诊断簇 2+2、全任务 12 个修复候选/40 轮/120 工具调用/90 分钟，并允许从检查点原地继续。

## 验证方式

- `npm test`：515/515 通过。
- `node --experimental-strip-types --test scripts/test/harness-runtime-reliability.test.ts`：7/7 通过。
- `npx tsc -p tsconfig.node.json --noEmit --pretty false`：通过。
- `npm run build`：通过。
- `git diff --check`：通过。

## 经验教训

- “模型多试几次”不能替代执行状态；必须让宿主保存基线、输入指纹、诊断集合、补丁和预算。
- 构建报告是修复循环的唯一事实源；日志工具只能补充新的证据，不能让模型重复消费同一尾部。
- 影子工程的回滚路径必须在应用重启后仍能从 journal/备份重新推导，不能只依赖内存对象。
- 诊断数量下降不是唯一进展信号；根因消除、验证阶段前进和旧根因暴露的下游错误都应被识别。
