# ModCrafting

[![CI](https://github.com/newstarbar/ModCrafting/actions/workflows/plugin.yml/badge.svg?branch=release)](https://github.com/newstarbar/ModCrafting/actions/workflows/plugin.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.15-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![Minecraft](https://img.shields.io/badge/minecraft-1.21.4-62b47a)](https://www.minecraft.net)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

<p align="center"><img src="plugins/modcrafting-fabric/modcrafting.png" width="720" alt="ModCrafting 浏览器工作台"></p>

**和 AI Agent 一起制作、构建并验证 Minecraft Fabric 模组。**

ModCrafting 给 Codex、Claude Code、Cursor 等外部 Agent 装上 36 个 MCP 工具和一个本地浏览器工作台。Agent 负责交流、规划与改代码；ModCrafting 负责 Fabric 工程检查、Minecraft 数据查询、内容/配方/界面/贴图/体素编辑、Gradle 构建、游戏准备与测试报告。

当前发布主线是 `release`。GitHub `main` 只保留旧版 Desktop 历史，不再作为开发或发布基线；`release` 不包含旧 Electron 应用与旧 Desktop 安装链路。

## 它能做什么

| 模块 | 能力 |
|---|---|
| 工程与工具 | 检查/新建 Fabric 1.21.4 工程，查 Minecraft 数据、Wiki 与 Fabric 文档，跑 Gradle 构建 |
| 可视化工作台 | 内容参数、配方、GUI 界面、AI 物品贴图、3D 体素模型、实体外观；单一工作区与 session 隔离 |
| 游戏验证 | Observer V2 接入独立测试实例，自动准备世界并输出 `PASS` / `FAIL` / `INCONCLUSIVE` 三态报告 |
| 内联卡片 | 3 张 `ui://` 卡片在宿主对话里直接渲染检查结果、构建进度与测试报告 |

未知或外部改写的 Java 文件保持只读。截图、桥接成功或构建成功都不能替代玩法验收。

## 支持的 Agent 宿主

| 宿主 | `--host` | 状态 |
|---|---|---|
| OpenAI Codex CLI | `codex` | 已验证 |
| Claude Code | `claude` | 已验证 |
| Cursor | `cursor` | 已验证 |
| Devin CLI | `devin` | 已验证 |
| Devin Desktop (Windsurf) | `devin-desktop` | 已验证 |
| OpenCode | `opencode` | 已验证 |
| Pi | `pi` | 已验证 |
| ZCode | `zcode` | 已验证 |
| Qoder | `qoder` | 已验证 |
| WorkBuddy | `workbuddy` | 已验证 |
| CodeBuddy Code | `codebuddy` | 已验证 |
| GitHub Copilot CLI | `copilot` | 已验证 |
| Trae | `trae` | 部分验证 |
| Kimi Code CLI | `kimi` | 部分验证（仅 MCP） |
| DeepSeek Harness | `dsh` | 通过官方命令委派 |

已验证 = 配置路径与字段按官方文档核对过；部分验证 = 只在目录已存在时写入，不创建猜测路径。完整路径、技能目录与排错见 [安装指南](docs/install.md)。

## 快速开始

### 让 Agent 自己装

把这句话发给 Agent：

```
请安装 ModCrafting：运行 npx -y github:newstarbar/ModCrafting#release install --auto --json，
按返回的 restartHint 重启我当前的宿主，再运行 doctor --json 确认没有 problems。
```

### 手动安装

```powershell
npx -y github:newstarbar/ModCrafting#release install --auto          # 自动检测宿主
npx -y github:newstarbar/ModCrafting#release install --host cursor   # 指定宿主，可重复
npx -y github:newstarbar/ModCrafting#release doctor                  # 只读体检
```

安装器会把自包含 MCP bundle 放到 `~/.modcrafting/versions/<version>/` 并逐文件校验 SHA-256，写入宿主配置前备份为 `.bak`，只增删 `modcrafting-fabric` 一个条目；你的其它 MCP 服务器、模型配置和会话历史不受影响。退出码：`0` 成功、`1` 用法错误、`2` 宿主歧义或未检测到、`3` 配置冲突、`4` 下载或校验失败、`5` 宿主不支持。

### 离线安装

代理或内网环境用 Release 里的 `ModCrafting-Offline-<tag>.zip`（QQ 群同款）：解压后双击 `install.cmd`，或把包内 `PROMPT.md` 发给 Agent。Node 的 `fetch` 不读取 `HTTPS_PROXY`，这类环境请直接走离线包。

如果当前版本还没有 Release 资产（例如刚合并、尚未发版），用 `--bundle-dir` 指向本地已解包的 bundle，或 `--from-zip` 指向本地 ZIP。

### 验证安装

```powershell
npx -y github:newstarbar/ModCrafting#release doctor --json
```

`ok: true` 且 `problems` 为空即安装成功。宿主里看不到工具时，先重启宿主，再对照 `doctor` 输出的 `config.file`。

## 第一次使用

1. 让 Agent 新建或检查一个 Fabric 1.21.4 工程：空目录表示「可以新建」，不是安装坏了。
2. 说「打开工作台」。Agent 会创建一个 `modcrafting_session` 并给出本机链接；内容、贴图、配方、界面、模型各有独立模块。
3. 需要原版数据或 Wiki 时，Agent 会按需下载到工程的 `.modcrafting/` 目录，不会全量拉取。
4. 要真机验证就说「跑一次游戏测试」：先准备实例，再执行断言，最后给出三态报告。

## 工作原理

- **MCP 后端**：一个自包含 `dist/mcp-server.js`（仅依赖 Node 内置模块），stdio 通信，同时承载 MCP 工具与工作台。
- **浏览器工作台**：只监听 loopback，带一次性 token 与 Origin 校验，按 session 隔离草稿、日志和报告。
- **Observer V2**：以独立测试实例进入专用世界，按 `Arrange → Act → Assert → Cleanup` 推进，报告区分通过、失败与证据不足。

## 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | 22.15+ | 运行 MCP、安装器与工作台 |
| pnpm | 10.34.7 | 仅源码开发需要 |
| JDK 21 | 21.x | 构建 Observer、跑真实游戏测试 |
| Minecraft | 1.21.4（Fabric） | 当前验证目标，Windows x64 |

## 开发与验证

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck && pnpm test
pnpm run plugin:build && pnpm run plugin:validate && pnpm run plugin:stage
pnpm run bundle:stage && pnpm run cli:test && pnpm run cli:pack:check && pnpm run claude:check
pnpm run plugin:smoke && pnpm run workbuddy:stage && pnpm run workbuddy:smoke
pnpm run bench:fabric
```

Stage 脚本只写 `temp/`，不改宿主配置；唯一会写宿主配置的是用户显式运行的 `modcrafting install`。版本号规则与发版流程见 [Release 规则](RELEASE.md) 和 [分发产物](docs/distribution.md)。

## 文档

- [安装指南](docs/install.md) — 15 个宿主的配置路径、技能目录与排错
- [分发产物与发布流程](docs/distribution.md) — bundle 契约、npm 包、Release 资产
- [命令清单](docs/commands.md) — 构建、测试、候选包与游戏验证
- [宿主分发](docs/host-distribution.md) — Stage 与安装器的职责边界
- [架构与模块边界](docs/architecture.md) — Core、MCP、浏览器与 Observer
- [Core 接口契约](docs/core-contracts.md) — session、游戏准备、配置与测试 Schema
- [浏览器工作台](docs/browser-view.md) — 页面、草稿、鉴权与 session 隔离
- [GitHub Actions 与 Release 规则](RELEASE.md) — CI 门禁、tag 与资产
- [文档导航](docs/README.md) / [归档记录](docs/archive/README.md)

## 贡献

请基于 `release` 分支提交 PR。CI 会跑类型检查、插件回归、安装器测试、MCP 协议 Smoke、WorkBuddy 钩子与离线 Bench；PR 描述里请写清复现步骤与实际执行的验证项。旧 Desktop 相关改动不接收。

问题与建议走 [Issues](https://github.com/newstarbar/ModCrafting/issues)。

## 许可与声明

GPL-3.0，见 [LICENSE](LICENSE)；随包第三方组件见 [THIRD_PARTY_NOTICES.txt](plugins/modcrafting-fabric/THIRD_PARTY_NOTICES.txt)。

ModCrafting 与 Mojang/Microsoft 无官方关联，不包含 Minecraft 游戏本体。使用需遵守 Minecraft 最终用户许可协议。
