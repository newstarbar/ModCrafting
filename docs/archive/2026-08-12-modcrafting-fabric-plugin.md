# ModCrafting Fabric Codex 插件抽离

日期：2026-08-12
触发：核心模块重构

## 完成内容

- 新增 `plugins/modcrafting-fabric/`，以 `.codex-plugin/plugin.json`、两项 Fabric 技能和本地 stdio MCP 提供 Codex 插件能力。
- 新增 `packages/modcrafting-core/`。领域层锁定 Minecraft/Fabric 1.21.4、Observer V2 路径、`ModCrafting Test World` 和游戏验收三态；Node 层提供系统 JDK 21/Gradle Wrapper 检查、知识资产管理、进程作业、Bridge 和测试报告。
- MCP 提供环境、按需资产、三类知识查询、项目检查/脚手架/构建、Minecraft 控制和异步确定性游戏测试共 19 个工具。
- 插件运行时只允许系统 JDK 21 与目标项目既有 `gradlew.bat`；不会下载或修改系统 JDK、Gradle 或离线 Seed。知识资产、Observer 和基础模组只写入 `PLUGIN_DATA`、目标项目和专用游戏目录。
- 添加 `.agents/plugins/marketplace.json` 及 `plugin:build`、`plugin:test`、`plugin:validate` 命令。隔离测试会复制插件并在没有仓库根 `node_modules` 的情况下启动 bundle 自检。

## 验证与后续

- 已执行插件 bundle 构建、隔离 MCP 自检和插件清单校验。
- 真实 `runClient`/Observer 验收依赖本机已准备的 JDK 21、Gradle Wrapper、Minecraft 依赖与下载后的基础资产；缺失时 MCP 返回结构化诊断或 `INCONCLUSIVE`，不得伪造成功。
- Electron 的现有 UI、Provider、IPC、Harness 与 Test Lab MCP 保持原位。后续如要进一步收敛 Electron 运行时，应按文件迁移至 `modcrafting-core`，并在每步后回归应用自动化测试。
