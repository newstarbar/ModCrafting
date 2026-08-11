# ModCrafting Test Lab MCP

Test Lab 是仓库内开发工具，用于在隔离环境中启动真实 Electron、驱动正式 React/Controller/IPC 生命周期并收集结构化证据。它不进入普通用户的 MCP 设置，也不随正式安装包发布。

## 两种运行入口

### Standalone 应用回归

```powershell
npm run build
npm run test:app
```

`test:app` 使用本地 OpenAI 兼容回放 Provider，默认前台显示窗口，验证认证发现文件、项目沙箱、真实对话生命周期、事件账本、运行中 Assistant 活跃卡片和脱敏 Provider 请求。

```powershell
npm run test:app:hidden  # 隐藏 Electron，供 CI/无人值守运行
npm run test:app:live    # 真实 Provider 前台烟测
npm run test:app:game    # 真实 Provider + Minecraft/Observer 前台烟测
```

Standalone 产物位于系统临时目录：

```text
<temp>/modcrafting-app-test/<runId>/artifacts/
```

### stdio MCP

```powershell
npm run build
npm run test:mcp:serve
```

本地 MCP 命令为：

```text
node --experimental-strip-types scripts/mcp/modcrafting-test-mcp.ts
```

stdout 只承载 MCP 协议，诊断写入 stderr。`npm run test:mcp` 只做 Server/Schema/工具发现烟测，不启动 Electron。

## 自动化安全模型

- 每次运行使用独立 `userData`、沙箱工作区、发现文件和产物目录。
- 主进程只监听 `127.0.0.1` 随机端口，每次生成新的 256 位 Bearer Token。
- capabilities、command、events、snapshot 和 shutdown 全部需要认证。
- 不开放 CORS，不提供任意 JavaScript 执行。
- 自动化模式禁用更新器，但构建、终端、Gradle、Minecraft Runtime 和 Observer 走正式实现。
- 目标项目始终复制到运行沙箱；MCP 不提供绕过隔离的参数。
- 真实 API Key 只在显式 live 模式下从正式 profile 解密到内存，不经过 MCP 参数/结果，不复制到测试 profile，不写入报告。

## MCP 工具（11）

| 工具 | 当前行为 |
|---|---|
| `modcrafting_launch` | 启动隔离 Electron；`visible=true` 为默认值，`liveProvider` 必须显式开启 |
| `modcrafting_configure_provider` | 配置本地回放 Provider；只接受 endpoint/model/providerId，内部使用测试密钥 |
| `modcrafting_use_saved_provider` | 仅 live-enabled 运行可用，从正式 profile 只读载入指定 Provider |
| `modcrafting_open_project` | 把源项目复制到运行沙箱后打开 |
| `modcrafting_send_turn` | 以 `agent`、`plan` 或 `ask` 模式发送真实用户消息 |
| `modcrafting_wait` | 等待 `turn_done` 或应用 idle；单次最长 120 秒 |
| `modcrafting_snapshot` | 读取应用、Controller、计划和 UI 状态，可附前台截图 |
| `modcrafting_respond` | 响应审批、澄清或 GUI 布局请求；澄清答复会等待上一轮收束 |
| `modcrafting_run_scenario` | 从夹具 ID/文件或旧 inline 参数运行一键场景并写报告 |
| `modcrafting_get_report` | 返回当前运行的产物位置和完整事件账本 |
| `modcrafting_stop` | 关闭 Electron 并保留产物 |

确定性 Provider 回归建议使用显式序列：

1. `modcrafting_launch({ visible: true })`
2. `modcrafting_configure_provider(...)`
3. `modcrafting_open_project(...)`
4. `modcrafting_send_turn(...)`
5. `modcrafting_wait(...)` / `modcrafting_snapshot(...)`
6. `modcrafting_get_report()`
7. `modcrafting_stop()`

真实 Provider 流程在第 1 步设置 `liveProvider: true`，随后调用 `modcrafting_use_saved_provider`。

## 黑盒场景

`scripts/test/scenarios/` 当前包含：

- `player-morph-toggle`：可逆的玩家状态/热键交互；
- `kill-feed-hud`：HUD 事件文本；
- `death-rewind`：死亡后的历史状态恢复。

夹具可以包含具体功能、提示、澄清答复和 AcceptanceContract，但生产 Harness 禁止导入这些文件或根据其关键词选择实现。`modcrafting_run_scenario({ scenario: "player-morph-toggle" })` 默认前台启动独立运行。

当前声明式场景执行器可自动断言 `event_kind`、`tool_called` 和 `plan_step`，并把夹具 AcceptanceContract 附到报告。更丰富的进程、文件差异和契约逐项 Oracle 仍应以 AutomationSnapshot、事件账本和游戏测试报告为事实来源，不能在文档中假定已经自动覆盖。

一键场景如果没有可用 Provider、模型未提交完整计划、需要未声明的澄清，或没有到达游戏证据阶段，应返回/记录 `INCONCLUSIVE`；不得因为 Electron 已启动或截图存在而报告 PASS。

## 产物目录

MCP 运行保存在：

```text
%LOCALAPPDATA%/ModCrafting Test Lab/runs/<runId>/
├── profile/
├── workspace/
└── artifacts/
    ├── run.json
    ├── events.ndjson
    ├── provider-requests.redacted.jsonl
    ├── process.log
    ├── workspace.patch
    ├── snapshots/
    └── screenshots/
```

部分文件只有执行到对应阶段才存在。报告必须清除 Authorization、API Key 和环境机密。

## 裁决

- `PASS`：所有必要的确定性断言均有动作后的新证据。
- `FAIL`：可重复的产品断言确定失败。
- `INCONCLUSIVE`：应用、测试桥、Provider、环境、超时、Observer 能力或用户确认阻止裁决。

真实 Provider/Minecraft 烟测的进程退出成功只表示报告已正常生成，不等于功能 PASS；必须读取 `run.json` 的 verdict 和证据。

## 前台与隐藏模式

本地运行默认最大化并聚焦 ModCrafting 窗口，便于观察 Agent 活跃动画、计划推进、工具事件和 Minecraft 交接。`--hidden` 只改变 Electron 窗口可见性；profile、沙箱、认证和断言逻辑不变。测试过程中不要手动操作 UI，以免破坏场景确定性。
