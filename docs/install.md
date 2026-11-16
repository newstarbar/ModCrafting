# 安装 ModCrafting

一句话给 Agent：

```
npx -y github:newstarbar/ModCrafting#release install --auto --json
```

安装器会下载自包含 MCP bundle（SHA-256 校验）、写入宿主 MCP 配置（写前备份）、装上 3 个技能，并在 `~/.modcrafting/state.json` 记账。完整的一句话模板见 [PROMPT.md](../PROMPT.md)。

## 前置条件

- Node.js 22.15 或更新版本（`node --version`）。
- 首次安装需要能访问 GitHub Releases，且 `v<CLI 版本>` 已经发布（否则下载 404）；被墙/代理环境请用[离线包](#离线包qq-群下载)。
- 游戏构建与实机测试还需要 JDK 21 与 Minecraft 1.21.4，这与安装无关。

## 命令

| 命令 | 作用 |
|---|---|
| `install --auto` | 自动检测宿主并安装 |
| `install --host <id>` | 指定宿主（可重复） |
| `install --all-detected` | 给所有检测到的宿主安装 |
| `install --dry-run` | 只打印将要写入的内容 |
| `install --print-snippet` | 只输出配置片段，不写任何文件 |
| `install --from-zip <zip>` | 从离线 ZIP 安装 |
| `install --bundle-version <v>` | 指定 bundle 版本；必须是已发布的 tag（`0.1.8` 或 `v0.1.8`） |
| `mcp --remove` | 只移除 MCP 条目 |
| `skills --remove` | 只移除技能 |
| `doctor` | 只读体检（配置、技能、缓存、Node） |
| `versions` | 列出缓存版本与已装宿主 |
| `uninstall` | 按安装记录精确回滚 |

退出码：`0` 成功｜`1` 用法错误｜`2` 宿主歧义/未检测到｜`3` 配置冲突｜`4` 下载或校验失败｜`5` 宿主不支持。

## 宿主矩阵

`已验证` = 路径与字段按官方文档核对过；`部分验证` = 路径可能随版本/地区变化，安装器只在目录已存在时写入，且不创建猜测路径。

| 宿主 | `--host` | MCP 配置 | 技能目录 | 状态 |
|---|---|---|---|---|
| Codex CLI | `codex` | `~/.codex/config.toml` → `[mcp_servers.modcrafting-fabric]` | `~/.codex/skills/`、`~/.agents/skills/` | 已验证 |
| Claude Code | `claude` | `~/.claude.json` → `mcpServers` | `~/.claude/skills/` | 已验证 |
| Cursor | `cursor` | `~/.cursor/mcp.json` → `mcpServers` | `~/.cursor/skills/` | 已验证 |
| Devin CLI | `devin` | Windows `%APPDATA%\devin\mcp_config.json`；其它 `~/.config/devin/mcp_config.json` | 同目录上一级的 `skills/` | 已验证 |
| Devin Desktop (Windsurf) | `devin-desktop` | `~/.codeium/windsurf/mcp_config.json` | `~/.codeium/windsurf/skills/` | 已验证 |
| OpenCode | `opencode` | `~/.config/opencode/opencode.json` → `mcp` | `~/.config/opencode/skills/` | 已验证 |
| Pi | `pi` | `~/.pi/agent/mcp.json` | `~/.pi/agent/skills/` | 已验证 |
| ZCode | `zcode` | `~/.zcode/cli/config.json` → `mcp.servers` | `~/.zcode/skills/`、`~/.agents/skills/` | 已验证 |
| DeepSeek Harness | `dsh` | 官方命令 `dsh mcp add` | 官方命令 `dsh skills add` | 仅委派 |
| Qoder | `qoder` | `~/.qoder/settings.json` → `mcpServers` | `~/.qoder/skills/` | 已验证 |
| Trae | `trae` | `%APPDATA%\Trae\User\mcp.json`（或 `Trae CN`） | `~/.trae/skills/` | 部分验证 |
| WorkBuddy | `workbuddy` | `~/.workbuddy/mcp.json` | `~/.workbuddy/skills/`、`~/.agents/skills/` | 已验证 |
| CodeBuddy Code | `codebuddy` | `~/.codebuddy/.mcp.json` | `~/.codebuddy/skills/` | 已验证 |
| GitHub Copilot CLI | `copilot` | `~/.copilot/mcp-config.json` | `~/.copilot/skills/`、`~/.agents/skills/` | 已验证 |
| Kimi Code CLI | `kimi` | `$KIMI_CODE_HOME/mcp.json` 或 `~/.kimi-code/mcp.json` | 未验证（只写 MCP） | 部分验证 |
| 其它客户端 | `generic --config-path <file>` | 指定的 JSON 文件 → `mcpServers` | — | 兜底 |

宿主别名也接受：`claude-code`、`windsurf`、`open-code`、`z-code`、`deepseek-harness`、`github-copilot`、`kimi-code`。

### GUI 宿主的 Node 路径

Cursor、Trae、Devin Desktop、WorkBuddy、CodeBuddy、Qoder、Pi 由图形界面启动，通常拿不到登录 shell 的 `PATH`，因此安装器写入的是 **node 绝对路径**。升级 Node 后重新执行一次 `install --host <id>` 即可。用 `--node <path>` 可强制指定。

### 数据目录

每个宿主使用独立的 `MODCRAFTING_DATA`：`~/.modcrafting/data/<host-id>`。这样同一个工作台不会串 session、日志或游戏实例。需要自定义时加 `--data-root <绝对路径>`。

## 原生插件（可选）

除了 MCP + 技能，部分宿主支持把 ModCrafting 作为原生插件安装，能额外获得命令、钩子与专家卡：

| 宿主 | 方式 |
|---|---|
| Codex | 仓库 `.agents/plugins/marketplace.json`；或 Release 里的 Multi-Host ZIP |
| Claude Code | `.claude-plugin/marketplace.json`；或 `claude --plugin-url <Release ZIP URL>` |
| Qoder | 下载 `ModCrafting-Fabric-Qoder-Plugin-<tag>.zip`，在扩展面板导入 |
| WorkBuddy / CodeBuddy | `codebuddy --plugin-dir <插件目录>`（插件包由 `pnpm run workbuddy:stage` 生成） |
| DeepSeek Harness | `dsh plugin --profile web add github:newstarbar/ModCrafting` |

同时装原生插件和直写 MCP 会重复注册工具，二选一即可。

## 离线包（QQ 群下载）

`ModCrafting-Offline-<tag>.zip` 自带 CLI 与 bundle，断网可用：

```
解压到任意目录
双击 install.cmd（Windows）或运行 ./install.sh
或：node <目录>/cli/bin/modcrafting.mjs install --bundle-dir <目录>/bundle --auto
```

包内 `PROMPT.md` 是给 Agent 的原文提示，直接把它发给 Agent 即可。

## 卸载

```
npx -y github:newstarbar/ModCrafting#release uninstall --host cursor
```

只删除安装器写入的条目与内容未变的技能文件；你手动改过的文件会保留并告警。

## 排错

| 现象 | 原因与处理 |
|---|---|
| `AMBIGUOUS_HOST` | 装了多个宿主且当前进程没有宿主环境变量。加 `--host <id>` 或 `--all-detected` |
| `NO_HOST_DETECTED` | 宿主不在默认路径。用 `--host` + `--config-path` 指定 |
| `CONFIG_INVALID` | 配置文件不是合法 JSON。安装器不会覆盖，请先修好 |
| `CONFIG_CONFLICT` | Codex `config.toml` 用了点号键/内联表/重复块。按错误里的 `codex mcp add` 命令手工添加 |
| `BUNDLE_INVALID` / HTTP 404 | 代理拦截或版本不存在。换 `--from-zip`，或 `/mcp` 里确认版本 |
| 宿主里看不到工具 | 没重启宿主；或配置写在了非默认路径。运行 `doctor --json` 对照 `config.file` |
| Cursor 报 `spawn ENOENT` | Node 路径失效（重装/升级过 Node）。重新 `install --host cursor` |
