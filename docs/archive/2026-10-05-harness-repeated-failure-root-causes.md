# Harness 反复错误根因修复（嵌套 Mixin / 证据门死锁 / 计划白名单 / reasoning 连续性）

**归档日期**：2026-10-05
**触发方式**：大功能自动（修复复杂 bug + 调整 Agent 行为规则）
**涉及文件数**：16（含 4 个测试文件、1 个新增主进程模块）
**问题类型**：bug 修复 / 重构 / 文档

## 背景

会话诊断日志 `temp/logs/mc-session-diag-20261004-184642.md`：一条用户消息（"将潜影贝的飞弹攻击替换为苦力怕"）触发 38 次工具调用、11 次失败，运行停在步骤 3/7，工程始终未编译成功，而对外报告是"已用 18/18 轮"。

排查结论：反复错误的主体不是模型乱来，而是 **harness 自身三处机制互相矛盾**，把模型推进到"唯一正确的动作必然被拒绝"的状态。另有 4 次失败（`submit_plan` 缺 gameTest、两次 `duplicate_build_report`、`aci_write_gate`）是正确护栏且一轮即恢复，本次不动。

## 根因分析

| # | 根因 | 日志证据 |
|---|------|---------|
| RC1 | `fabric_mixin_scaffold` 对 `$` 嵌套类生成不可编译代码（`@Mixin(Outer.Inner.class)` + `import Outer.Inner;`，Yarn 内部类通常 private），而 `fabric_mixin_validate` 用同一套错误形式做字符串匹配，于是把这个形态判为"静态校验通过" | #21 生成 → #22/#28/#31 三次构建失败（首次 92.4s）→ #32 仍报"Mixin 静态校验通过" |
| RC2 | 证据门死锁：`mixins.json` 已由上一步 `fabric_mixin_register` 真实写出，本步 `complete_step` 却只承认"本步内的写入产物"；模型转去调 `fabric_mod_json_validate`（当时既不返回 `validation` 也不返回 `artifactPaths`，还会验证错文件）拿到 `ok:true` 仍被拒；拒绝文案又把它推回重复调用该校验器，连续两次直接 `attempt = maxIterations` | #35/#36 校验 `ok:true` → #37/#38 `blocked: [step_evidence_required]` → "已用 18/18 轮"（实际只跑了两轮） |
| RC3 | 计划阶段锁定白名单不含 `read_file` 与任何知识工具，而提示词与 AGENTS.md 强制"写码前必须查知识库"——两条规则不可同时满足 | #14 `blocked: [tool_inactive]`（同一轮 #7 用同工具曾成功） |
| RC4 | 成员查询未命中只返回空列表 + 同族子串建议；符号索引其实已收录 `ShulkerEntity$ShootBulletGoal`，但模型看不到它 | #5 `methods:[] fields:[] suggestions:[]` |
| RC5 | thinking 模式要求把 `reasoning_content` 回传给后续轮次，harness 捕获后从不存入历史，也不关闭 thinking；400 之后还沿 fallback ladder 换模型，换到的模型同样 400 | 附录 7370-7382 行 `API error 400 ... reasoning_content` |

## 改动清单

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `src/renderer/src/harness/mixin-utils.ts` | 修改 | 新增 `mixinAnnotationForm()`；`$` 嵌套目标统一渲染 `@Mixin(targets = "A$B")`，`topLevelImport` 保证嵌套参数类型只 import 外层类 |
| `src/renderer/src/harness/tool-definitions.ts` | 修改 | `fabric_mixin_validate` 改为按 `mixinAnnotationForm` 比对（旧点号类字面量判失败）并拒绝嵌套 import；`fabric_mod_json_validate` 返回 `artifactPaths` + `mod_json` 结构化 validation，且拒绝校验非 `fabric.mod.json` 的路径 |
| `src/renderer/src/harness/tools.ts` / `events.ts` | 修改 | validation `kind` 联合加 `mod_json`；`ToolEvent.validation` 复用 `ToolValidationEvidence`，删掉重复内联定义 |
| `src/renderer/src/harness/workflow-engine.ts` | 修改 | 本轮写入产物集合 `runWriteArtifacts{path,stepId}`；`stepEvidenceSatisfied`/`missingWriteEvidencePaths` 支持跨步采纳并发 Notice；连续两次缺证据进入 `[HARNESS_PAUSED:evidence_deadlock]`；`forcedStepStop` + `buildStepFailureMessage(budgetNote)` 报告真实轮次；`roundReasoning` 随 assistant 轮次入历史 |
| `src/renderer/src/harness/controller.ts` | 修改 | `evidence_deadlock` 不触发备用模型切换；`reasoning_content` 协议错误直接上抛，不走 fallback ladder |
| `src/renderer/src/harness/plan-phase-gate.ts` / `agent.ts` | 修改 | 白名单改为能力判据 `isPlanPostLockTool()`（project.read + knowledge.read），删除 `agent.ts` 内重复集合；锁定提示文案同步 |
| `src/main/fabric-symbol-hints.ts` | 新增 | 成员未命中时扫描 `${owner}$*` 嵌套类，给出"`嵌套类 X 有 m()V；Mixin 请用 @Mixin(targets = "X")`"，含有界编辑距离 |
| `src/main/fabric-metadata.ts` | 修改 | 接入嵌套类提示；`mixin-precheck.ts` 缺目标类诊断文案补 `targets=` 形态 |
| `src/renderer/src/harness/chat-message.ts` | 修改 | `ChatMessage.reasoningContent`；`assistantToolCallMessage`/`appendToolRoundHistory` 写入；新增 `withoutReasoningEcho()` |
| `src/renderer/src/harness/model-adapter.ts` | 修改 | `openAiChatMessage()`：仅当该轮自带推理时才序列化为 `reasoning_content`；Anthropic 分支不透传 |
| `src/renderer/src/harness/fetch-retry.ts` | 修改 | `isReasoningContinuityError()`，刻意不归入可重试网络错误 |
| `src/shared/llm-providers.ts` | 修改 | thinking 请求字段收敛为声明式 `THINKING_PROFILES` 表；删除只服务于单一 `if` 的 `isGlmModel` |
| `src/renderer/src/components/ChatPanel.tsx` | 修改 | 会话诊断导出把 reasoning 原文替换为长度标记，避免日志体积翻倍 |
| `scripts/test/harness-step-evidence-adoption.test.ts` | 新增 | 跨步采纳生效 / 仅磁盘存在不满足 / 两次拒绝进入诚实暂停 |
| `scripts/test/harness-reasoning-continuity.test.ts` | 新增 | 出站字段边界（openai 有、anthropic 无、无推理不新增）与错误分类 |
| `scripts/test/harness-fabric-symbol-hints.test.ts` | 新增 | 基于真实 1.21.4 索引验证嵌套类提示 |
| `scripts/test/harness-fabric-reliability.test.ts` / `harness-plan-phase-gate.test.ts` / `harness-llm-providers.test.ts` | 修改 | 嵌套 targets 断言、锁定白名单翻正、声明式表断言 |
| `docs/harness.md` / `docs/workflow.md` / `AGENTS.md` / `CLAUDE.md` | 修改 | 行为规则表与护栏说明同步 |

## 关键决策

1. **`targets=` 判据用"是否含 `$`"，不用访问标志**：索引生成时丢弃了 access flags，无法判"仅私有"；`targets=` 对公有/私有嵌套类都成立且不需要 import，因此是唯一稳健形式。代价是历史手写 `@Mixin(A.B.class)` 会新报失败——属预期纠错，文案直接给出修法。
2. **证据门采用"本轮写入产物跨步采纳"，而不是放松证据要求**：只接受 `project.write` 工具真实返回的 `artifactPath(s)` 且需 `patternMatchesPath` 命中目标路径；磁盘存在性、上一轮的失效产物一律不接受（重写类步骤的目标文件本来就存在，用磁盘存在做证据会假满足）。同一步骤自身不进采纳集合，避免"自己给自己造证据"。
3. **不做任何按模型名/Provider 的特化分支**（开发者明确要求）：`reasoning_content` 采用"谁产出就回传谁"的通用连续性方案，判据是消息自身是否带该字段，而非模型是谁。回传会抬高输入 token，这是 thinking 模式的协议成本而非浪费。
4. **诚实预算报告**：护栏强制停止时区分"真实消耗 loopIterations"与"步骤预算"，不再把两者混为"已用 18/18 轮"。
5. **正确护栏保持不动**：`duplicate_build_report`、`aci_write_gate`、`submit_plan` gameTest 门都按预期一轮恢复，改动它们只会削弱防线。

## 验证方式

```bash
npm test              # 689 用例；新增/改写的 4 个套件全绿，失败集与改动前逐条一致（22 条为并行在途改动导致）
npm run test:app      # 真实 Electron + 回放 Provider 冒烟：{"ok":true}
npm run test:mcp      # Test Lab MCP 协议自测：{"ok":true,...,"server":true}
```

单测锁住的关键边界：嵌套 target 不再产出嵌套 import；`fabric_mixin_validate` 对旧形态判失败；跨步采纳 + 磁盘存在不算证据；两次缺证据即暂停且文案含真实轮次；`reasoning_content` 只在 openai-chat 且消息自带时出现。

**未完成的验证**：日志里那条"潜影贝飞弹换苦力怕"目标没有对应的回放 fixture（`scripts/test/scenarios/` 只有 MiniMax/morph/kill-feed/death-rewind 四套），因此无法按原计划做该会话的应用级回放复现。需要复现时应先录制一条 thinking 模式的多工具会话作为 fixture。

## 经验教训

1. **"生成器与校验器共享同一个错误假设"是最危险的缺陷**：它让失败在下游静默消失，模型收到"校验通过"却构建失败，只能反复原地打转。校验器必须能证伪生成器，而不是复述它。
2. **护栏文案是模型的行为输入**：拒绝信息里点名"再调一次那个校验器"就会制造死锁循环；文案必须给出唯一可推进的动作（对具体路径 edit/write，或调用注册工具）。
3. **提示词约束与工具白名单必须由同一处派生**：文档承诺"锁定后仍允许只读工具"，代码却漏掉 `read_file` 与全部知识工具，模型无论怎么选都违规。改为按 `BUILTIN_TOOL_POLICIES` 能力判读后，新增只读工具自动生效。
4. **"文件已存在"不等于"本步写了它"**：证据采纳应绑定真实工具产物与轮次作用域，而不是绑定磁盘状态。
5. **Provider 协议错误分类要先于重试策略**：400 类协议违约沿 fallback ladder 换模型只会重复失败并丢历史；识别为协议问题、就地重试一次、然后如实上抛，才能把一次会话的浪费压到一轮。
6. **快速排查路径**：看到"已用 N/N 轮"但日志里 `loopIterations` 很小 → 必是某处 `attempt = maxIterations` 强制停机；顺着 `[step_evidence_required]` / `tool_not_offered` / `tool_inactive` 的 errorKind 就能定位是哪一层门。
