# 在 WorkBuddy 中使用 ModCrafting

ModCrafting 在 WorkBuddy 里是一个**插件包 + 专家包**：同一份目录，既能作为插件安装（带命令、技能、钩子、MCP），也能作为专家被召唤（带角色设定与依赖引导）。它复用 Fabric / Codex / Claude / Qoder 已经验收过的同一个 `dist/mcp-server.js`，不复制第二套工具实现。

## 1. 安装

先产出包（WorkBuddy 包复用 `plugin:stage` 的独立插件目录，因此顺序不能省）：

```
pnpm run plugin:build
pnpm run plugin:stage
pnpm run workbuddy:stage
pnpm run workbuddy:smoke
```

本地验证（推荐先做这一步）：

```
codebuddy --plugin-dir <包目录>
```

持久安装（把包放进一个本地 marketplace 后）：

```
codebuddy plugin marketplace add <marketplace 目录或 Git 源>
codebuddy plugin install modcrafting-workbuddy@<marketplace> --scope user
codebuddy plugin validate            # 校验清单、技能、钩子语法
```

安装后启用插件即生效，钩子随插件启用一起注册，不需要额外开关。

> 包由 `pnpm run workbuddy:stage` 生成到 `temp/plugin-artifacts/modcrafting-workbuddy`；该命令只生成本地文件，不改任何宿主账户配置。

## 2. 这个包多做了一件什么事

纯 MCP + Skill 能做到"模型知道有哪些工具、怎么调"。WorkBuddy 还能在**宿主侧**替你做四件事，本包全部接上了：

| 能力 | 实现在哪 | 用户能感知到什么 |
|---|---|---|
| 会话预热 | `hooks/session-start.mjs` | 新开一个聊天就能看到"最近任务会话 / 阶段 / 工程 / JDK"，不用先问一遍 |
| 会话守卫 + 高危确认 | `hooks/pre-tool-use.mjs` | 忘记传 `sessionId` 时自动补齐；停止任务、跑测试、执行命令、启动客户端前弹一次确认 |
| 输出瘦身 | `hooks/post-tool-use.mjs` + `--text=digest` | 超大 JSON 不会撑爆上下文，`structuredContent` 仍完整 |
| 内置浏览器工作台 | `modcrafting_open_workbench` 的 `mode=builtin` | 返回一个可交给 `present_files` 的 URL，在工作台预览面板打开，不弹系统浏览器 |

三宿主（Codex / Claude / Qoder）不受影响：这些开关只出现在本包的 `.mcp.json` 与 `hooks/` 里。

## 3. 日常用法

1. 召唤专家或直接对话，说清你想做什么（例如"做一个能吃的蓝莓，带贴图和配方"）。
2. 新任务会先建会话；继续旧任务会自动 `resume`。
3. 需要可视化调整时说"打开工作台"，代理会调用 `modcrafting_open_workbench` 并用 `present_files` 打开。
4. 构建、进游戏、跑测试都会走同一套会话；测试结论只有 PASS / FAIL / INCONCLUSIVE 三种。
5. `INCONCLUSIVE` 表示**暂时无法验证**，不是通过。

## 4. 工作台

- 后端只在 `127.0.0.1` 上监听，默认随机端口，令牌放在 URL 片段里。
- 如果预览面板显示空白，说明面板以 iframe 方式加载而被 CSP `frame-ancestors` 拦住，用 `--web-embed` 重新连接（该开关只放开"谁可以嵌入展示"，Host / Origin / Fetch-Metadata / 令牌四层数据防护不变）。
- `pnpm start` 打开的是本地工作台，URL 自带引导会话，首屏不再报 `SESSION_REQUIRED`。每次启动会创建一个名为「本地工作台」的引导会话；需要清理时用 `modcrafting_session` 的 `end` 收尾。

## 5. 自动化回归

计划文件放在工程的 `.modcrafting/plans/*.json`，例如：

```json
{
  "version": 1,
  "name": "nightly-regression",
  "projectPath": "D:/work/my-mod",
  "stopOnFailure": true,
  "steps": [
    { "op": "inspect" },
    { "op": "validate" },
    { "op": "build", "task": "build" },
    { "op": "runClient" },
    { "op": "gameTest", "spec": { "version": 2, "id": "nightly", "featureType": "new_item" } },
    { "op": "screenshot" }
  ]
}
```

运行：

```
node "${CODEBUDDY_PLUGIN_ROOT}/dist/mcp-server.js" --plan="<计划文件绝对路径>"
```

- stdout 只有一行 JSON 结论，stderr 是进度。
- 退出码 0 表示计划执行完毕（含 FAIL / INCONCLUSIVE）；只有计划文件无效才返回 1。
- 报告写成自包含 HTML，可以 `present_files` 打开，也可以 `LibraryUpload` 归档到资料库。

## 6. 钩子行为与排错

- 钩子脚本任何异常都返回退出码 0（退出码 2 会阻塞宿主工具调用，插件不能因为自己的 bug 让工具不可用）。
- Windows 上钩子通过 Git Bash 执行，插件目录内的换行被强制为 LF。
- 钩子只读 `sessions/*.json` 与 `toolchain.json`，不构造运行时、不加锁、不改会话状态。
- 详细输入输出契约见 `docs/workbuddy-hooks.md`。

## 7. 已知边界

- 专家不能自带工具，所有能力来自 `.mcp.json` 声明的 ModCrafting MCP；召唤时会引导连接。
- 内联卡片是只读的：完整编辑器在浏览器工作台，卡片只展示结果。
- 需要系统安装 Node.js ≥ 22（与 `.mcp.json` 的 `command: node` 一致），以及 JDK 21 才能构建。
- 真实游戏验证仍需本机 Minecraft、Gradle Wrapper 与 Observer V2；离线烟雾测试不能替代。

## 8. 相关文档

- `docs/host-distribution.md`：四宿主分发方式对照
- `docs/agent-integration-boundaries.md`：谁负责对话、谁负责构建与验收
- `docs/workbuddy-hooks.md`：三个钩子的契约与排错
