# 宿主分发

Core/MCP bundle 与 Skills 在各宿主之间复用；宿主清单和安装机制不同。分两条路径，职责不要混：

| 路径 | 谁改宿主配置 | 覆盖宿主 |
|---|---|---|
| Stage 脚本（`plugin:stage` / `host:stage` / `workbuddy:stage` / `plugin:qoder`） | **不改**，只生成目录或 ZIP | Codex、Claude Code、Qoder、WorkBuddy |
| 安装器（`modcrafting install`） | **默认直写**，写前 `.bak`、幂等、只动自己的键 | 15 个宿主，见 [安装指南](install.md) |

## 宿主清单

| 宿主 | 清单 | 额外能力 | 命令 |
|---|---|---|---|
| Codex | `.codex-plugin/plugin.json` + `.mcp.json` | Skills | `plugin:stage` |
| Claude Code | `.claude-plugin/plugin.json` + `.mcp.json` + marketplace | Skills | `claude:stage`（薄插件，MCP 走 `npx modcrafting-mcp`） |
| Qoder | `.qoder-plugin/plugin.json` + `.mcp.json` | Skills、commands、ZIP | `plugin:qoder` |
| WorkBuddy | `.codebuddy-plugin/plugin.json` + `.mcp.json` | Skills、commands、agents、hooks、内联卡片、专家包 | `workbuddy:stage` |
| Cursor / OpenCode / Pi / Trae / Copilot / Kimi / Devin CLI / Devin Desktop | 无仓库内插件清单 | Skills（Kimi 未验证） | `modcrafting install --host <id>` |
| DeepSeek Harness | 无仓库内插件清单 | 官方插件机制 | `dsh plugin --profile web add github:newstarbar/ModCrafting` |

## WorkBuddy 插件包 + 专家包

```powershell
pnpm run plugin:build
pnpm run plugin:stage       # WorkBuddy 包复用这里产出的独立插件目录
pnpm run workbuddy:stage      # temp/plugin-artifacts/modcrafting-workbuddy
pnpm run workbuddy:validate   # 清单、钩子、技能、路径边界、头像
pnpm run workbuddy:smoke      # 钩子真实执行 + 打包配置启动
codebuddy --plugin-dir temp/plugin-artifacts/modcrafting-workbuddy
```

同一份目录既是插件（commands/agents/skills/hooks）也是专家包（`expertType: agent`）。钩子只在 WorkBuddy 生效；`.mcp.json` 的 `--web --workbench=builtin --text=digest` 也只出现在这个包里，三宿主行为不变。详见 [WorkBuddy 使用指南](workbuddy-integration.md) 与 [WorkBuddy 钩子契约](workbuddy-hooks.md)。

## Qoder 桌面 Plugin ZIP

完整 Qoder Plugin 需要候选目录中与插件 bundle 匹配的 Observer V2。先设置 JDK 21 并构建候选包，然后从 `candidate.json` 读取 `product` 路径：

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'
pnpm run candidate:build
pnpm run plugin:qoder -- --source 'D:\path\to\product\plugin'
```

`plugin:qoder` 在 `temp/qoder-artifacts/` 写出 ZIP。包内含 Qoder manifest、MCP 启动配置、commands、三份 Skills、许可证和兼容性指纹。默认使用 Qoder 管理的插件数据目录占位符，不需要修改 `settings.json`。

安装和首次使用步骤见 [Qoder 使用指南](qoder-user-guide.md)。升级前应在 Qoder 中禁用旧版本或执行宿主支持的替换操作，再安装新 ZIP；不要直接覆盖正在运行的插件缓存。实际新聊天调用需登录 Qoder 后单独验收。

## 其他宿主配置

`pnpm run host:stage -- --product-dir ABSOLUTE_PRODUCT_DIR` 在 `temp/host-artifacts/` 生成 Codex Plugin、Claude Code Plugin 和 Qoder CLI 目录。该命令只复制候选文件，不安装或升级插件。

`host:config` 可为明确指定的宿主生成新的 MCP 配置文件；需提供插件绝对路径和独立 `MODCRAFTING_DATA` 绝对路径。命令拒绝覆盖已有文件。此备用配置只连接 stdio MCP，不安装 Skills。

`host:smoke` 验证配置解析及 SDK 工具发现；不能证明对应宿主账号登录、真实对话或模型调用已经通过。

## 数据和后端隔离

不同宿主建议使用各自的数据根目录。浏览器 URL 连接创建该 URL 的 MCP 后端；新开一个 MCP 进程不会自动共享另一个进程的 session、日志、游戏实例或报告。任务需要关闭时使用所属 session 的结束操作。

本地候选构建只写入 `temp/`，不创建 GitHub Release、不推送 tag，也不改真实宿主配置。匹配版本的 tag 推送后，GitHub Actions 会上传 Qoder 桌面 ZIP、跨宿主包、发布信息和 SHA-256 清单；发布分支与人工验收边界见 [Release 规则](../RELEASE.md)。
