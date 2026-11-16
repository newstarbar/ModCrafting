---
name: workbuddy-workflow
description: How to use ModCrafting inside WorkBuddy - inline status cards, built-in browser workbench, hook behaviour, headless regression and library archiving. 中文：在 WorkBuddy 里正确使用 ModCrafting 的内联卡片、内置浏览器工作台、钩子行为、无头回归与资料库归档。
version: 1.0.0
author: newstarbar
---

# 在 WorkBuddy 里使用 ModCrafting

这份技能只讲**宿主相关的用法**。工具本身怎么选、怎么写代码，看 `modcrafting-start`、`fabric-mod-development`、`fabric-game-validation`。

## 工作台：交给宿主内置浏览器

`modcrafting_open_workbench` 会返回 `browserUrl`。WorkBuddy 下不要启动系统浏览器：

1. 调用工具时传 `mode: "builtin"`（或依赖包内默认值）。
2. 把返回的 `browserUrl` 原样交给 `present_files`。
3. 用户确认看到页面之前，不要声称"已打开"。

不要用 Shell、`Start-Process`、`explorer.exe` 打开链接，也不要另起一个 `--web-only` 服务。若返回 `WORKBENCH_DISABLED`，说明当前包没带 `--web` 参数，让用户重装完整插件包，不要绕路。

## 内联卡片：只读，不轮询

任务、工程、素材类工具会附带一张只读卡片（`ui://modcrafting/*`）。规则：

- 卡片只展示 `structuredContent`，**不会**发起任何服务端调用。
- 想刷新就再调用一次工具，宿主会自动把新结果推给卡片。
- 不要指示用户在卡片里点刷新，也不要等待卡片回传数据。
- 真正的编辑（贴图、配方、界面、模型）在浏览器工作台里做，不在卡片里做。

## 钩子：这是插件行为，不用向用户解释

- 会话开始时会看到一段"最近任务会话"预热信息，直接用它判断继续还是新建。
- 缺少 `sessionId` 时钩子会自动补上当前会话；补不上时服务端会返回 `SESSION_REQUIRED`，按提示 `create` 或 `resume`。
- 停止任务、跑测试、执行命令、下载资料、启动客户端这类操作会弹一次确认。不要试图绕过确认，也不要把确认说成"插件报错"。

## 无头回归

```
node "${CODEBUDDY_PLUGIN_ROOT}/dist/mcp-server.js" --plan="<计划文件绝对路径>"
```

- stdout 只有一行 JSON，`stderr` 是进度，不要混读。
- 退出码 0 表示计划执行完毕（包括 FAIL / INCONCLUSIVE）；只有计划文件本身无效才返回 1。
- `verdict` 为 `INCONCLUSIVE` 时必须写成"暂时无法验证"。

## 资料库归档

报告是 HTML，可以直接归档：

1. `present_files` 打开 `reportPath`。
2. `LibraryUpload` 上传同一个文件（`.html` 会存成网页），之后可以用资料库检索。
3. 回答里同时给出本地绝对路径和归档结果，方便用户离线复查。

## 不要做的事

- 不要为了让流程"看起来跑通"而跳过 `canRunTests`。
- 不要把截图、编译成功、单条命令成功当作玩法验证通过。
- 不要在报告里只写结论不写证据；每条证据都要有断言类型和实际观察。
