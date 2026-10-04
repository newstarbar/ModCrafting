# 2026-10-04：模型路由信号-决策升级

## 背景

既有多模型路由以「角色预设 + 正则任务模板」为主：`routeUserTurn` 等于静态规则，协作轨迹会排队大量从不执行的职责，且角色模型钉死、不按难度升降档。业界成熟方案（RouteLLM / LLMRouter / vLLM Semantic Router / LiteLLM）多为 Python 研究库或 K8s 代理，不适合直接嵌入 Electron；可复用的是信号→决策→角色×档位绑定模式（对齐 ControlFlow / Semantic Router 思路）。

## 完成内容

- `src/shared/model-routing.ts`：新增 `RoutingSignals`、`activeRoles`、`byDifficulty`、`resolveBindingForDifficulty`、`executableRolesForIntent`、混合决策构建；内置 fast/balanced/deep/economy/code 预设附带难度档位池。
- `src/renderer/src/harness/routing-classifier.ts`：歧义时用 router 模型 refinement 信号，失败 fail-open。
- `controller.ts`：hybrid 路由；只排队可执行职责；explorer / debugger / codeReviewer / summarizer 真实委派；鉴权/429/协议失败冷却 60s；单轮委派计入预算。
- 设置中心文案补充「角色×档位」与信号降级说明。
- harness 路由单测覆盖信号、activeRoles、档位解析、自定义 byDifficulty 归一化。

## 验证

```bash
npm test
```

重点文件：`scripts/test/harness-model-routing.test.ts`。

## 维护要点

- 新增职责时同步更新 `AGENT_ROLE_IDS`、`executableRolesForIntent` 与真实 `runForRole` 挂钩点。
- 勿把「答得差」当作 fallback 条件；冷却仅用于鉴权/限流/协议失败。
- 学习型强/弱路由（RouteLLM mf）列为远期，本阶段不做。
