# AGENTS.md

本文件是 ModCrafting 发布主线的精简工程指引。当前默认产品是 Fabric Core/MCP + 可选浏览器工作台；旧 Electron/Desktop 已从 `release` 分支移除，历史代码保留在 `main`。

## 架构

- `packages/modcrafting-core/`：工程、session、配置、构建、Minecraft 运行时、测试与报告。
- `plugins/modcrafting-fabric/`：MCP 服务、工具 Schema、浏览器服务和工作台入口。
- `packages/modcrafting-view/`：React 浏览器工作台；不要引入另一套 UI 框架。
- `bridge-mod/`：Minecraft 1.21.4 Observer V2。
- `scripts/bench/`、`scripts/plugin/`：测试夹具、构建、候选包和宿主分发。
- 详细接口见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/core-contracts.md`](docs/core-contracts.md)。

## 常用命令

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run typecheck
pnpm test
pnpm run plugin:smoke
pnpm run candidate:build
pnpm run plugin:qoder -- --source ABSOLUTE_CANDIDATE_PLUGIN_DIR
```

运行游戏需要系统 JDK 21、工程 Gradle Wrapper 和 Observer V2。候选构建需要设置绝对路径 `JAVA_HOME`；不会下载旧 Desktop 工具链。

## 实现约定

- 先检查 `packages/modcrafting-core` 和插件现有调用，再改代码；保持 MCP 为薄适配层。
- 每个聊天任务显式创建或恢复 `sessionId`。游戏、配置、日志、报告和停止操作必须校验 session 归属；不使用全局“最近实例”。
- 游戏桥接连接成功不等于测试环境就绪。测试必须等待 `canRunTests=true`，并报告准备阶段、阻塞原因和当前界面。
- 配置修改仅在明确请求时保存为工程默认；运行中修改只对下次启动生效。
- 编辑器草稿不自动写入工程；写回继续使用 revision / 冲突检查。
- 面向新手的 MCP 描述和错误优先说清“发生了什么、下一步怎么做”，避免只给内部术语。
- 不恢复 Electron、旧 Harness、安装器、旧发布脚本或 Desktop 用户数据迁移链路到 `release`。
- 大功能、主流程修复或构建链调整后更新 `docs/archive/`；不要把真实 Qoder 模型聊天、游戏玩法和离线 Smoke 混为同一验收结论。

## 版本号

- 语义：`X.Y.Z` 中 Z（第三位）= 本地开发/测试验证更新，每轮本地验证递增；Y（第二位）= GitHub 发行版变更；X（第一位）= 大版本更新。
- 升版本同步三处：根 `package.json`、`plugins/modcrafting-fabric/.codex-plugin/plugin.json`、`plugins/modcrafting-fabric/compatibility.json`，再重跑 `candidate:build` 与 `stage-qoder` 出新包。

## 分支与交付

- `release` 是当前发布主线；`main` 是只读历史版本。除非用户明确要求，不向 `main` 合并新产品实现。
- `candidate:build` 和 `plugin:qoder` 仅生成本地候选包；不自动修改 Qoder 配置、创建发布、推送标签或上传二进制。
- 提交只包含本次明确修改的文件；保留其他工作区内容。不要提交 `.env`、API Key、个人路径、`node_modules/`、`temp/`、`runtime/` 或本地游戏存档。
