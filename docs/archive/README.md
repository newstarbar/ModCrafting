# 归档索引

- [2026-10-26] [AI 3D 体素模型专项功能](./2026-10-26-ai-voxel-model.md) — `fabric_voxel_workspace` 语义体素 DSL + 确定性编译（贪心网格/图集/PNG）+ Three.js 体素画布；方块/物品首轮闭环；128/131 回归（3 项为既有无关失败）。触发：大功能自动归档。

- [2026-10-26] [知识库随工程存放](./2026-10-26-project-knowledge-storage.md) — 四个知识工具与工作区校验支持 projectPath，知识资源默认存入工程 `.modcrafting/`，后端目录兜底；122/123 回归（1 项为既有未跟踪残留）。触发：主流程存储位置变更自动归档。

- [2026-10-19] [Fabric Plugin GitHub Actions 与 Release 规则](./2026-10-19-plugin-github-release.md) — 将 CI 改为当前插件与工作台验证；按版本 tag 构建 Observer V2、Qoder 桌面 ZIP 和跨宿主发布包，显式校验分支/版本并保留旧 Desktop Release 历史。

- [2026-10-18] [测试实例准备、任务会话隔离与工作台重排](./2026-10-18-test-session-workbench.md) — session 配置和归属、真实首次启动自动进专用世界、Agent 推荐的单工作区及窄屏导航；插件 114/114 回归与首次启动真实玩法验收。触发：运行时、Agent 行为及工作台流程大改自动归档。

- [2026-10-18] [Qoder 实测问题的整链修复](./2026-10-18-qoder-experience-repair.md) — 配套桥接组件随包、Java/缓存一致性、按需资源、浏览器工程定位与通俗引导；113 项回归及真实游戏 2 正例/2 反例匹配。触发：复杂修复与交付流程调整自动归档。

- [2026-10-16] [Core/MCP 重构分支交付](./2026-10-16-core-mcp-git-delivery.md) — Git 导出/共享 Store 复建、提交范围与草稿 PR 边界；统一 CSS 行尾以稳定 bundle 哈希。触发：构建修正自动归档。

- [2026-10-16] [R4 MC 界面创作工作台](./2026-10-16-mc-gui-workbench.md) — 三类布局/六类组件、原生 Screen/HUD、安全写回与 22 工具；实机正反例、持久化和绘制顺序修复，独立可体验候选。触发：核心创作模块自动归档。

- [2026-10-16] [浏览器 MC 贴图读取修复](./2026-10-16-browser-minecraft-textures.md) — 本机客户端缓存准备、模型继承/工程纹理、配方槽位与新建预览；98 项回归，60/60 首屏解码与安装后验证。触发：核心素材链路修复自动归档。

- [2026-10-16] [R3 内容参数工作台](./2026-10-16-content-parameter-workbench.md) — 六类参数/纹理与安全写回、21 工具、9 PASS / 3 预期 FAIL 及补验 3 PASS，独立可体验候选；Qoder 新版聊天保留待验收。触发：核心创作模块自动归档。

- [2026-10-15] [配方工坊与真实游戏合成](./2026-10-15-recipe-creator-workbench.md) — Web 拖放/保存/冲突保护、20 工具、两次实际合成 PASS 与两项反例 FAIL；保留后续创作能力和 Qoder 新版聊天验收。触发：核心创作模块自动归档。

- [2026-10-15] [真实桌面宿主接入](./2026-10-15-real-desktop-host-integration.md) — 记录此前 Codex 原生连接与 Qoder 登录桌面只读调用，区分隔离 CLI 验收。

- [2026-10-15] [本地候选固化与真实模组首次使用验收](./2026-10-15-candidate-real-mod-validation.md) — 源码提交 74e8504、独立 Store 安装/82 项验证、Observer 源码组装与真实兑换物品 2 PASS / 2 FAIL，Qoder 调用继续待验收。触发：Core/构建/验收流程自动归档。

- [2026-10-15] [Desktop 默认入口退役与工程路径迁移](./2026-10-15-desktop-retirement.md) — 独立迁移/读回、默认 Core/MCP 入口与旧自动发布退出；80/80 回归、真实 Gradle 构建、45 文件交付。兼容源码/数据与 Qoder 调用项保留。触发：Core/构建/发布调整自动归档。

- [2026-10-14] [转型阶段重规划](./2026-10-14-transformation-replan.md) — P2/P3 已本地验收，P4 分发开发完成；73/73 回归、Codex/Claude 原生调用与浏览器备用、三宿主禁用保留数据；Qoder 已连接 19 工具，调用待登录环境，P5 未开始。触发：工作主线、核心/构建与展示/分发模块自动归档。

- [2026-10-14] [P2 统一验收摘要与 Fabric-Bench MVP](./2026-10-14-acceptance-fabric-bench.md) — 离线 21/21、实机 10/10 预期匹配与基线对照；历史 Desktop 改动按新路线单列审阅。触发：Core/CI 变动自动归档。

- [2026-10-13] [Codex 宿主与真实 Fabric/游戏验收](./2026-10-13-codex-live-mcp-validation.md) — 相对 cwd 修复宿主入口；真实构建及 PASS/FAIL/CLEANUP_FAILED 三条游戏路径通过。触发：集成缺陷/配置修改自动归档。

- [2026-10-13] [P1 独立 MCP 底座与可信验收](./2026-10-13-mcp-foundation-p1.md) — 白名单 Stage、SDK 协议烟测、无伪 PASS 与 finally 清理、独立插件 CI；39 项定向回归通过，真实游戏未验证。触发：Core/构建修改自动归档。

- [2026-10-13] [pnpm Worktree 迁移与基线隔离](./2026-10-13-pnpm-worktree-baseline.md) — Store 硬链接、独立原生产物、npm 基线对照及打包启动/依赖版本修复；保留 CI 既存失败。触发：构建流程修改自动归档。

- [2026-10-05] [上下文窗口归因可视化](./2026-10-05-context-attribution-visualization.md) — 状态栏占比条改为分类分段堆叠 + 明细浮层，诊断导出新增 `### 上下文占用账目`；拉取式读控制器快照、锚定 API prompt_tokens、CJK 修正、exact/near 重复检测与 `unaccounted` 诚实残差。触发：新增核心可观测性模块。

- [2026-10-05] [Skill 技能模块落地](./2026-10-05-skill-module.md) — `SKILL.md` 指令包 + `read_skill` 按需加载；能力声明即门控（`knowledge.read` 全程放行）、md-tree-store 通用覆盖层、electron-free 核心便于单测、`resources/` 需强制入库。触发：新增核心模块。

- [2026-10-05] [Harness 反复错误根因修复](./2026-10-05-harness-repeated-failure-root-causes.md) — 嵌套 Mixin `targets=`、证据门跨步采纳与 `evidence_deadlock` 诚实轮次、计划锁定白名单按能力派生、成员未命中提示嵌套类、`reasoning_content` 通用连续性。触发：修复复杂 bug + 调整 Agent 行为规则。

- [2026-10-04] [默认单厂多模型路由（伴厂专家槽）](./2026-10-04-home-companion-routing.md) — DeepSeek 单厂默认含多模态；伴厂仅补短板/第三方检测；游戏测试模型待评测。触发：产品路由策略重构。

- [2026-10-04] [模型配置入口收敛（4→2）](./2026-10-04-model-config-entry-simplify.md) — 输入区日常选择 + 设置中心连接/高级；退役侧栏重复 API 表单。触发：UX 重构。

- [2026-10-04] [模型路由信号-决策升级](./2026-10-04-model-routing-signal-decision.md) — 规则+可选模型信号、角色×难度档位、真实委派与失败冷却；不引入外部路由运行时。触发：核心 Harness 重构。

- [2026-08-18] [Harness 工具调用管线 Pi 式分层重构](./2026-08-18-harness-tool-pipeline-pi-layering.md) — 按 Provider / Agent Loop / 工具策略分层，修复 index/ID 流式聚合、统一工具快照、协议错误语义、MiniMax Anthropic 适配和可恢复降级。触发：核心 Harness 重构。

- [2026-08-18] [Harness 原子交付与自愈闭环重构](./2026-08-18-harness-atomic-self-healing.md) — 以影子工作区、结构化 BuildReport、诊断驱动修复和持久化 checkpoint 保证验证后原子交付，并支持中断恢复。触发：大功能自动。

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
