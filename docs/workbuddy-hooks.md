# WorkBuddy 钩子契约

插件通过 `hooks/hooks.json` 注册三个命令钩子。它们只在 WorkBuddy 生效，其它宿主不会加载这个文件。

## 为什么是命令钩子而不是 prompt 钩子

确定性优先。补 `sessionId`、拦截高危调用、压缩超长输出都是可判定的规则，用 prompt 钩子会让同一操作在不同回合得到不同结论。任何一个脚本崩溃都会**退出码 0**：退出码 2 会阻塞宿主工具调用，插件不能因为自己的缺陷让工具整体不可用。

## 命令字符串的写法

```json
"command": "node \"${CODEBUDDY_PLUGIN_ROOT}/hooks/pre-tool-use.mjs\" \"${CODEBUDDY_PLUGIN_DATA}\""
```

- 只用 `${CODEBUDDY_PLUGIN_ROOT}` / `${CODEBUDDY_PLUGIN_DATA}`，因为市场安装会把包复制到 `~/.codebuddy/plugins/cache/...`，任何 `../` 或盘符路径都会失效。
- 数据目录作为**参数**传入：占位符是命令字符串预替换，不保证导出为子进程环境变量。脚本自身再用 `import.meta.url` 反推插件根，环境缺失也能定位。
- Windows 上钩子经 Git Bash 执行，仓库用 `.gitattributes` 强制 `plugins/modcrafting-workbuddy/** text eol=lf`。
- 不使用 `powershell`、`cmd /c`，保持跨平台。

## SessionStart

输入（stdin）：`{ hook_event_name, session_id, source, ... }`（`source` 为 `startup|resume|clear|compact`）。

输出（stdout，会追加进对话上下文）：

```
最近任务会话：蓝莓任务｜阶段：正在构建｜工程：D:/work/berry｜sessionId：<uuid>
已保存的 JDK 21：C:/Program Files/Java/jdk-21
继续这个任务前先 resume 它；……
```

约束：

- 输出 **≤ 1400 字符**，不写日志正文、不写令牌。
- 只读 `sessions/*.json` 与 `toolchain.json`；**不构造 `SessionRegistry`**（它的构造函数会改写孤儿作业，属于写操作）。
- 不 spawn `java -version`，避免把钩子拖进冷启动延迟。

## PreToolUse

matcher：`^mcp__modcrafting-fabric__`。

职责一：补会话。17 个需要 `sessionId` 的工具在缺少该字段时，从 `<dataRoot>/workbuddy/current-session.json` 读取并补上：

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "modifiedInput": { "sessionId": "<uuid>" } } }
```

安全边界：

- **只新增 `sessionId`**，从不覆盖显式传入的值，从不修改 `projectPath`、`spec`、`command` 等语义字段。
- 缓存里的会话必须仍存在且 `status === "active"` 才可用。
- 没有缓存时**什么都不输出**：让 MCP 返回 `SESSION_REQUIRED` 和 remediation，比钩子拒绝更容易让模型自愈。

职责二：高危确认。以下工具返回 `permissionDecision: "ask"` 和中文理由（理由会显示在宿主确认框里，写"会发生什么"而不是内部错误码）：

`fabric_job_stop`、`minecraft_stop_client`、`minecraft_test_start`、`minecraft_command`、`minecraft_build_studio`、`fabric_project_scaffold`、`modcrafting_prepare_assets`、`minecraft_run_client`。

## PostToolUse

matcher 同上。三件事，按顺序：

1. `modcrafting_session` 返回后把 `sessionId`/`projectPath` 原子写进 `workbuddy/current-session.json`（0600，tmp → rename）。
2. `modcrafting_open_workbench` 返回后追加 `additionalContext`，要求代理用 `present_files` 打开内置浏览器，并禁止 `Shell` / `Start-Process`。
3. 文本总量超过 8000 字符时，用 `updatedToolOutput` 传**内容数组**，只替换超长的 text 块（保留头 1200 + 尾 600 字符），image 块原样保留。

### 为什么传数组而不是整个结果

`updatedToolOutput` 传数组时宿主"原样作为 content 数组"，即只替换 content 块；`structuredContent`（以及内联卡片拿到的数据）保持不变。传整个 result 对象会把 `isError`、`structuredContent` 一起覆盖掉，等于伪造工具结果。

`isError === true` 的结果**一律不输出**，错误码和原文必须原样到达模型。

## 排错

| 现象 | 检查 |
|---|---|
| 会话预热没出现 | `hooks/hooks.json` 是否被宿主加载；`${CODEBUDDY_PLUGIN_DATA}` 是否指向 MCP 实际使用的数据根（应与 `.mcp.json` 的 `MODCRAFTING_DATA` 一致） |
| 缺 sessionId 没被补 | `workbuddy/current-session.json` 是否存在；对应 `sessions/<id>.json` 是否 `status: "active"` |
| 每次调用都弹确认 | 说明命中的是 `HIGH_RISK` 表里的工具，属预期行为 |
| 输出仍很长 | 先确认 `--text=digest` 是否在 `.mcp.json` 里；再确认钩子脚本是否被宿主跳过（`CODEBUDDY_DEBUG=1` 可看 hook 跟踪） |
| 钩子报找不到文件 | 检查换行是否被改成 CRLF（Git Bash 下会让结尾引号错位） |

`pnpm run workbuddy:smoke` 会在隔离目录里用 `bash -c` 原样执行这些命令字符串，并断言退出码与输出形状；`bash` 不可用时它明确标记 `hooks: not exercised`，不会把"没跑"说成"通过"。
