# 候选包验收记录

该清单区分源码构建、插件接口、浏览器、Minecraft 运行和宿主聊天。每次正式交付均记录分支基线、插件版本、候选目录和 SHA-256 manifest。

## 当前分支

`release` 基于 GitHub 原 `main` 的 `307720e`（Qoder 原生插件合并提交），产品版本为 `0.1.3`。版本号语义见 AGENTS.md：Z（第三位）= 本地开发/测试验证更新，Y（第二位）= GitHub 发行版变更，X（第一位）= 大版本更新。该发布线已移除旧 Electron/Desktop 源码、旧 Harness、旧 Windows 安装/发布链与 Desktop 迁移工具；原 `main` 保留历史记录。

| 项目 | 本分支状态 |
|---|---|
| 旧 Desktop 源码、依赖和命令清理 | 已完成 |
| Core 与浏览器类型检查 | 通过 |
| 插件回归 | 107/107 通过 |
| 插件结构校验与 MCP Smoke | 通过；Smoke 列出 28 个工具 |
| Fabric Bench fixture | 21/21 用例符合预期：5 PASS、5 FAIL、11 INCONCLUSIVE |
| 完整候选构建 | 离线源码构建通过；Observer V2、插件、产品和三宿主分发均通过 Stage |
| Qoder ZIP | 0.1.3，14 个文件；根清单、MCP 配置、命令、Skills、bundle 与兼容性文件齐全 |
| 空目录首次启动与真实游戏 | 尚未在该发布候选上重跑；当前不宣称 Minecraft 验收通过 |
| Qoder 新聊天的真实模型行为 | 待已登录的 Qoder 桌面宿主复验 |

GitHub Actions 的静态检查与 tag Release 构建规则见仓库根目录 [RELEASE.md](../RELEASE.md)。Actions 可以证明代码检查、候选构建和 ZIP 结构通过，不会自动完成表中的真实游戏或 Qoder 登录聊天验收。

本次候选 bundle SHA-256：`a31d313f081fca99903c8e0599745983c82b6dbc9ab87083ecde487e687a5c83`。Qoder ZIP 和候选目录保存在本地 `temp/`，不提交到仓库。

## 发布候选门槛

1. **静态检查**：`pnpm run typecheck`、`pnpm test`、`pnpm run plugin:validate`、`pnpm run plugin:smoke`、`pnpm run bench:fabric` 全部通过。
2. **候选构建**：设置系统 JDK 21 后执行 `pnpm run candidate:build`；确认 Observer V2 和 MCP bundle 是同次源码构建，并核对 manifest 指纹。
3. **Qoder 包**：从候选产品目录的 `plugin` 子目录构建 Qoder ZIP，检查 `.qoder-plugin/plugin.json`、`.mcp.json`、commands、Skills、bundle 和兼容性指纹；不写入真实配置。
4. **首次启动**：对空 session 数据目录，不预写 `options.txt`、测试地图或向导状态；从产品入口准备到 `canRunTests=true`。
5. **真实玩法**：至少执行正例、反例与清理检查；分别记录实例准备、Minecraft 启动、桥接和玩法断言结果。
6. **宿主聊天**：使用真实登录的 Qoder 桌面新聊天调用本版插件。工具结构、SDK Smoke 和旧聊天均不能代替此项。

## 证据记录格式

每个结果记录：分支与 commit、插件版本、操作入口、数据目录是否为空、启动准备阶段、当前界面、`bridgeReady`、`canRunTests`、测试 verdict、清理结果和产物哈希。只说明实际观察到的结果；不以浏览器可访问、桥接已连接或游戏窗口出现推断玩法通过。
