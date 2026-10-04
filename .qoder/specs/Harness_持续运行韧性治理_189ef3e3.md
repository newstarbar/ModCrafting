# Harness 持续运行韧性治理实施计划

## 根因诊断（三路调研交叉验证，关键代码点已亲自核验）

1. **所有终态一律停等用户**：网络重试耗尽、协议降级耗尽、步骤失败、预算耗尽等一切可恢复中断，最终都落到"结束本轮 + 提示发送『继续』"，不存在自动续跑层。
2. **失败传播靠窄正则**：`controller.ts:610` 用 `/^Error:|执行因错误中断|^\[HARNESS_PAUSED:(?:diagnostic_stalled|protocol|budget)\]/` 判定 `agent.run` 返回文本成败。`workflow-engine.ts:1821` 的"步骤 #X「Y」因网络错误中断"与 `agent.ts:1237-1247` 静默 catch 返回的裸 `finalContent` 均不命中 → 既不触发 fallback 链，也不保存 checkpoint。
3. **静默吞错**：`session-runtime.ts:520-536` 与 `ChatPanel.tsx:951` 的空 catch 使 controller 异常对用户完全不可见（真实会话证据：8/18 三个"发需求即空回复"会话）。
4. **checkpoint 前置条件过严**：`controller.ts:344` `if (!initialWorkspace ...) return`——workspace 建立前的中断永远不落盘（真实机器 harness-checkpoints 目录不存在）。
5. **90 分钟时间预算跨恢复继承**：`controller.ts:332` 恢复时 `startedAt` 不重置，长任务恢复后立即再 PAUSED。
6. **运行时感知缺口**：游戏崩溃事件 `mc:crashed` 只到达 UI 面板不进 Harness；主进程游戏实例启动无看门狗；渲染进程无 unhandledrejection 兜底。

## 实施步骤

### Phase 1 — 失败传播修复（基础，小改动，可独立交付）

**Step 1：集中失败签名表**
- `src/shared/harness-runtime.ts`：新增 `TurnFailureKind = 'network' | 'protocol' | 'budget' | 'diagnostic_stalled' | 'step_failed' | 'generic_error' | 'inconclusive'` 与纯函数 `parseTurnFailure(text: string): { kind: TurnFailureKind; recoverable: boolean } | null`。只匹配宿主生成前缀（`Error:`、`执行因错误中断`、`[HARNESS_PAUSED:*]`、`步骤 #N「…」因网络错误中断`、`INCONCLUSIVE`），禁止添加泛化模式（防模型正文误判）。
- `src/renderer/src/harness/controller.ts:610`：正则替换为 `parseTurnFailure(result)`。

**Step 2：补齐失败文本前缀**
- `src/renderer/src/harness/agent.ts:1237-1247`：catch 分支返回值加 `执行因错误中断：${errMsg}` 前缀（workflow 路径 L500-519 已有此前缀，保持一致）。
- `src/renderer/src/harness/workflow-engine.ts:1820-1825`：网络中断 finalContent 已被 Step 1 签名表覆盖，仅需确认无其他裸失败文本出口遗漏。

**Step 3：消灭静默吞错**
- `src/renderer/src/harness/session-runtime.ts:520-536`：catch 中 emit error 级 Notice（`本轮异常结束。原因：…`），并对当前 turn 追加 `reason:'error'` 收尾（复用 `ensureClosingSummaryEntry` 模式）。
- `src/renderer/src/components/ChatPanel.tsx:951`：automation 发送路径同样处理。
- `controller.ts:1859-1861`：非网络错误分支同时 emit error Notice（当前只改 agentStatus）。

### Phase 2 — 有界自动续跑（核心能力）

**Step 4：RecoveryCoordinator 决策表**
- 新文件 `src/renderer/src/harness/recovery-coordinator.ts`（唯一新模块，纯函数约 150 行，可独立单测）：
  - 输入：`parseTurnFailure` 结果 + `autoResumeCount` + 上次续跑的 failureKind + 预算状态。
  - 输出：`{ action: 'auto_retry' | 'notify_user', reason?: string }`。
  - 规则：`network`/`protocol`/`step_failed` 可自动续跑；`budget`/澄清/视觉审核/`awaiting_user` 永不自动续跑（保持有意护栏）；**相同 failureKind 连续出现 2 次即停止**（防重复失败循环，历史教训：诊断优先于盲目重试）；上限默认 3 次（`agent-config.ts` 加用户开关，默认开）。

**Step 5：controller 集成自动续跑**
- `src/renderer/src/harness/controller.ts`：`runTurn` 返回前，TurnResult 为可恢复失败且 `decideRecovery` 判定 `auto_retry` 时，以内部信号调用既有 `retryExecuteTurn()`（L1942，当前仅 UI 按钮触发）；每次续跑 emit Notice（用户可见+可取消）；`recordCollaboration` 记录 trace；收尾总结计数呈现。

**Step 6：checkpoint 扩展**
- `src/shared/harness-runtime.ts` `TaskCheckpoint`（L176，schemaVersion 2 → 3）：新增 `autoResumeCount?: number`、`autoResumeHistory?: { kind, at }[]`；`workspace` 改为可选以支持轻量 checkpoint（向后兼容：加载端 `schemaVersion` 判断）。
- `controller.ts:342-344` `saveHarnessCheckpoint`：无 `executionWorkspace` 时保存轻量 checkpoint（plan + budgets + 诊断 + autoResume 计数，workspace 缺省），保存时清理同项目旧 checkpoint。
- `controller.ts:306-340` `restorePlanFromCheckpoint`：还原 autoResumeCount。

**Step 7：90 分钟预算死锁修复**
- `controller.ts:332`：恢复时 `startedAt` 重置为当前时间（仅时间预算重置，次数预算 12/40/120 保留；重置限 1 次/任务，checkpoint 审计），配 Notice 说明。

### Phase 3 — 运行时韧性（可与 Phase 2 并行，模块隔离）

**Step 8：网络重试与退避升级**
- `src/renderer/src/harness/fetch-retry.ts`（现仅 21 行）：退避升级为指数+抖动，尊重 429 `Retry-After`。
- `workflow-engine.ts:107` `MAX_MODEL_NETWORK_RETRIES=2` 提为可配置（默认 5，经 agent-config）。

**Step 9：游戏崩溃路由进 Harness**
- `controller.ts` 订阅 preload 已暴露的 `window.api.onMcCrashed`（`src/preload/index.ts:355`）；活跃 run/game_test 步骤收到 `exitReason: 'crash'`（区分 `manual`，不触发）→ 直接调用既有 `hostRecoverGameTestEnvironment`（workflow-engine.ts:1249），消耗其既有 2 次预算，避免"桥接 10s 超时才发现"的浪费。

**Step 10：游戏实例启动看门狗**
- `src/main/mc-runtime.ts`：`starting` 状态加活性看门狗——`handleOutput`（L332-348）每有输出即喂狗；10 分钟无输出且未达 `isClientStarted` → 判定 `start_failed` 并通知渲染进程。保留 `waitForMcRunReady` 8 分钟墙钟为第二道兜底。

**Step 11：渲染进程异常兜底**
- `src/renderer/src/main.tsx`：挂载 `window.addEventListener('unhandledrejection')` → `logger.error` + Notice 事件，与 `AppErrorBoundary` 互补。

### Phase 4 — 测试、验证与归档

**Step 12：回归测试**
- 新增 `scripts/test/harness-continuity.test.ts`（自动被 run-harness.mjs 收集）：签名表全覆盖（含步骤网络中断文本）、静默吞错修复、RecoveryCoordinator 决策边界（有/无上限、相同原因连续 2 次停止、预算类不续跑）、预算恢复重置、轻量 checkpoint 往返。不改任何既有测试断言。
- 运行 `npm test` 全量回归；`npm run test:app` 真实 Electron 回放回归。

**Step 13：归档**
- 按 AGENTS.md 归档机制写 `docs/archive/2026-08-26-harness-continuity-auto-resume.md`。

## 依赖关系

- Step 1 → Step 2 → Step 4 → Step 5 → Step 6（签名表是决策表输入；自动续跑依赖结构化判定与计数持久化）
- Step 3、Step 7 独立，可先行
- Phase 3（Step 8-11）与 Phase 2 模块隔离，可并行
- Step 12 依赖全部；Step 13 收尾

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 自动续跑烧钱/死循环 | 硬上限 3 次 + 相同原因连续 2 次即停 + 每次续跑 Notice 可见可取消 + 复用 12/40/120/90 预算闸门 |
| 放宽失败判定导致误判 | 签名表只匹配宿主生成前缀，禁止泛化模式 |
| 自动续跑掩盖真实故障 | 每次续跑 emit Notice + collaboration trace + 收尾总结计数 |
| 续跑重复副作用 | 仅在 execute 阶段（影子工程内）续跑；走 retryExecuteTurn 既有去重护栏 |
| 8/18 两大重构（atomic-self-healing、pi-layering）尚未提交 | 实施前先提交现有工作，避免混入同一 diff |
| 修改 controller 触碰既有测试 | 只新增测试文件；harness-controller.test.ts 如受影响仅同步常量引用 |

## 拒绝的替代方案

1. **完整 TurnOutcome 返回类型重构**（Alex 方案 Step 1-3）：将 `agent.run` 从 `Promise<string>` 改为结构化返回。虽是长期最优解，但波及 turn-classifier、session-runtime、automation、Test Lab 回放等多方消费方，breaking 风险高；本计划以"集中签名表解析"达到同等判定效果，返回类型重构留作后续独立事项。
2. **大文件拆分**（workflow-engine 3368 行 / controller 2471 行）：拆分收益低于回归风险，且不直接解决中断问题；本次只改出口层不动内部状态机。
3. **无限自动重试 / 任务级断路器全量引入**（Sam 方案激进版）：断路器状态机复杂度高，先用"有界续跑 + 相同原因熔断"覆盖 90% 场景。
4. **仅按最小方案修补**（Jack 方案原样）：不包含崩溃路由与看门狗，游戏测试类中断（历史最高频场景之一）仍会浪费大量轮次预算后停等用户。

## 关键文件

1. `src/renderer/src/harness/controller.ts` — 失败正则（L610）、runTurn 收敛点（L1840-1867）、checkpoint（L306-407）、自动续跑落点
2. `src/renderer/src/harness/workflow-engine.ts` — 网络中断出口（L1802-1826）、步骤失败出口（L3310-3343）
3. `src/renderer/src/harness/agent.ts` — 静默 catch（L1237-1247）、workflow catch（L500-519）
4. `src/shared/harness-runtime.ts` — 失败签名表与 TaskCheckpoint 扩展落点
5. `src/renderer/src/harness/session-runtime.ts` — 空 catch（L520-536）
6. 新文件 `src/renderer/src/harness/recovery-coordinator.ts`