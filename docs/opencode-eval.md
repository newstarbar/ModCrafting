# OpenCode vs ModCrafting Agent 评测指南

本文件用于 Phase 1 本机对比评测。在集成 OpenCode 前，用同一模型、同一模组项目、同一批任务量化差距。

## 前置条件

1. 本机安装 OpenCode CLI：`npm i -g opencode-ai@latest` 或 `scoop install opencode`
2. 验证：`opencode --version`
3. ModCrafting 中配置与 OpenCode 相同的 API Key / 模型
4. 准备一个可复现的 Fabric 模组项目（建议用 ModCrafting 新建模板项目）

## 评测任务（8–12 项）

| ID | 任务 | 类型 | 验收标准 |
|----|------|------|----------|
| T01 | 添加一个简单物品（含 lang + 模型占位） | 写码 | `gradlew build` 成功，物品注册类存在 |
| T02 | 为 T01 物品添加合成配方 | 配方 | `data/<modid>/recipe/*.json` 合法 |
| T03 | 新建 Mixin 修改玩家跳跃高度 | Mixin | mixins.json 已注册，Java 编译通过 |
| T04 | 修复故意引入的编译错误（错误类名） | 修复 | 一次 build 内修复或 ≤2 轮修复 |
| T05 | 修复 Gradle 依赖版本不匹配 | 修复 | build 成功 |
| T06 | 多文件重构：把逻辑从 main 类抽到 Handler | 重构 | 至少 2 个文件正确修改 |
| T07 | 探索陌生项目：说明 mod 入口与资源结构 | 勘察 | 正确指出 main/client 入口与 assets 路径 |
| T08 | 运行客户端并处理启动崩溃日志 | 闭环 | 能读日志并给出可行修复 |
| T09 | 添加方块 + blockstate + 模型 | 写码 | 资源路径正确 |
| T10 | fabric.mod.json 缺字段修复 | 领域 | validate 通过，build 成功 |

## 评分维度（每项 1–5 分）

| 维度 | 说明 |
|------|------|
| 一次成功率 | 无需人工纠正即完成任务 |
| 人工介入次数 | 越少越好（记录次数） |
| 错误工具次数 | 调用了与步骤无关的工具 |
| 计划可用性 | 计划是否含路径/步骤类型/可执行性 |
| build/run 修复轮数 | 失败到成功的轮次 |
| 耗时（分钟） | 从发 prompt 到验收通过 |

## 记录表

复制下表，每个任务跑两遍（ModCrafting / OpenCode CLI）：

```
任务: T__
引擎: ModCrafting | OpenCode
模型: ___________
项目: ___________

一次成功率:     /5
人工介入次数:
错误工具次数:
计划可用性:       /5
build/run 修复轮:
耗时(分钟):

备注:


```

## OpenCode 侧操作提示

- 进入项目目录后运行 `opencode`
- 勘察类任务用 **plan** agent（Tab 切换）
- 写码类任务用 **build** agent
- 记录是否手动切换 agent、是否触发权限确认

## ModCrafting 侧操作提示

- 使用 Agent 模式（非 Ask）
- 计划模式先生成计划，再点「执行计划」
- 记录澄清提问次数与计划步骤质量

## 退出标准

- 完成至少 8 个任务的对比记录
- 若 OpenCode 在「通用写码」维度平均高出 ModCrafting ≥1 分，进入 Phase 2/4
- 若差距不明显，优先做 Phase 3 自研加强，暂缓 SDK 嵌入

## 评测结果归档

建议将填好的表格保存为 `docs/opencode-eval-results.md`（本地，不提交敏感 API 信息）。
