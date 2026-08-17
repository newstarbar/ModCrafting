# 归档索引

- [2026-08-13] [Game-test INCONCLUSIVE recovery](./2026-08-13-game-test-inconclusive-recovery.md) — 将无效测试规格、环境故障与视觉审核从通用澄清链路中分离，并加入有界自动修复与场景版本追踪。

- [2026-08-12] [ModCrafting Fabric Codex 插件抽离](./2026-08-12-modcrafting-fabric-plugin.md) - 新增可独立安装的 Fabric 1.21.4 Codex 插件、共享 Node 核心与本地 MCP；触发：核心模块重构。

- [2026-08-11] [Harness 可靠性重构会话总复盘](./2026-08-11-harness-reliability-session-retrospective.md) — 系统梳理确定性游戏测试、会话恢复、分类与步骤推进、Test Lab、运行态 UX 和去除样例过拟合的完整演进链。触发：开发者主动。

- [2026-08-10] [Harness Test Lab and repair-safety recovery](./2026-08-10-harness-test-lab.md) — real Electron automation, stdio MCP, replay regression, bounded repair scope, and the 2026-08-11 sample-overfitting recovery.

- [2026-08-10] **Agent 对话与游戏测试会话恢复** — 修复计划步骤迁移后遗留的 Mixin 证据推进和 MiniMax 意图分类全量兜底。触发：自动。

- [2026-08-09] [确定性游戏内测试 V2](./2026-08-09-deterministic-game-test-v2.md) — 将“启动/截图即成功”改为宿主控制的 Arrange → Act → Assert → Cleanup 状态机；触发：核心 Harness 重构。

- [2026-08-09] **Harness 工具策略与取消链路重构** — 统一能力目录与超时策略，消除工具白名单漂移和悬挂调用。触发：自动。
- [2026-08-04] **移除 Gitee 下载依赖 · GitHub + gh.xmly.dev 代理加速重构** — 统一 GitHub 资产下载走 gh.xmly.dev 反代，环境产物不再上传 Gitee，Gitee 仅保留 Setup/Portable 浏览器备用入口。触发：自动。
- [2026-08-02] **环境下载、Fabric 初始化与打包可靠性修复** — 统一完整 JDK 在线初始化、离线验证、结构化诊断与 Windows 产物门禁。触发：自动。
- [2026-07-30] **修复 Release 资源生成目录** — 干净的 GitHub Actions 工作区会创建生成索引所需的父目录。触发：自动。

- [2026-08-11] [游戏测试运行时依赖与假就绪修复](./2026-08-11-game-test-runtime-readiness.md) — 基础模组、Observer V2 与运行时就绪契约。

归档规则见 [../archiving.md](../archiving.md)。新条目按日期倒序添加。
