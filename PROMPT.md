# 让 Agent 一句话安装 ModCrafting

把下面这段话发给任意支持的 Agent（Codex、Claude Code、Cursor、Devin、OpenCode、Pi、ZCode、DeepSeek Harness、Qoder、Trae、WorkBuddy、CodeBuddy、GitHub Copilot、Kimi），它会自己完成安装。

---

## 联网安装（推荐）

> 请帮我安装 ModCrafting：在终端运行
> `npx -y github:newstarbar/ModCrafting#release install --auto --json`
> 如果 `--auto` 报告宿主歧义，就根据我当前使用的编辑器加上 `--host <id>` 重试；
> 装完按返回的 `restartHint` 重启我当前的宿主，再运行
> `npx -y github:newstarbar/ModCrafting#release doctor --json` 确认没有 problems。

固定版本更稳（推荐写进脚本）：

```
npx -y github:newstarbar/ModCrafting#v0.2.1 install --auto --json
```

## 国内网络 / 代理环境

Node 的 `fetch` 不读取 `HTTPS_PROXY`，公司代理下联网安装会失败。改用离线包：

> 我下载了 `ModCrafting-Offline-v0.2.1.zip`，请解压到任意目录，然后运行
> `node <解压目录>/cli/bin/modcrafting.mjs install --bundle-dir <解压目录>/bundle --auto --json`，
> 最后按提示重启宿主。

## 失败时给 Agent 的补充指令

- `AMBIGUOUS_HOST`：同时装了多个宿主。用 `--host cursor` / `--host claude` 明确指定，或 `--all-detected` 全部安装。
- `NO_HOST_DETECTED`：宿主没装或装在非默认路径。用 `--host` + `--config-path` 指定。
- `CONFIG_CONFLICT`：配置文件有同名条目或结构异常。安装器不会覆盖，会打印手工命令。
- `BUNDLE_INVALID`：下载被拦截或版本不存在。改用 `--from-zip` 或 `--bundle-version <v>`。
- `UNSUPPORTED_HOST`：该宿主只支持官方命令安装（如 `dsh plugin --profile web add github:newstarbar/ModCrafting`）。

## 安装器会做什么

1. 把自包含 MCP bundle 放到 `~/.modcrafting/versions/<version>/`（SHA-256 校验）。
2. 在你的宿主配置里写入 `modcrafting-fabric` 一个条目（写前备份为 `.bak`，只动这一个键）。
3. 把 3 个技能复制到宿主的 skills 目录（已存在且内容相同则不写）。
4. 记录到 `~/.modcrafting/state.json`，`uninstall` 只会删自己写过的内容。

不会碰你的其它 MCP 服务器、模型配置、会话历史或项目文件。
