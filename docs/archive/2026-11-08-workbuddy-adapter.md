# WorkBuddy 生态适配（2026-11-08）

## 背景

目标是把现有插件适配进 WorkBuddy，并且不是"再包一层 Skill + MCP"，而是用上宿主独有的生态位。边界确认：交付形态为**本地插件包 + 专家包**（不做开放平台 Connector 上架，只保留元信息）；允许修改 MCP 工具定义（title/annotations/`_meta.ui`/返回体积/新增 `ui://` 资源与 `--plan` 入口），**不改 `packages/modcrafting-core` 的语义**；Codex / Claude / Qoder 三宿主必须零回归。

## 调研结论

- WorkBuddy 插件识别 `.codebuddy-plugin/plugin.json`，组件目录（`commands/ agents/ skills/ hooks/ settings.json .mcp.json`）必须在插件根；市场安装会把包**复制**到 `~/.codebuddy/plugins/cache/`，因此任何 `../` 或盘符路径都会失效。
- Hooks 有 27 个事件；`SessionStart` 与 `UserPromptSubmit` 的 stdout 会进入上下文；`PreToolUse` 支持 `permissionDecision`（allow/deny/ask）与 `modifiedInput`；`PostToolUse` 的 `updatedToolOutput` 会替换发给模型的结果，**传数组时只替换 content**。Windows 强制 Git Bash。
- MCP Apps 已受支持：工具加 `_meta.ui.resourceUri`，资源 MIME 为 `text/html;profile=mcp-app`，宿主把 HTML 跑在异源 sandbox iframe；**HTML > 256KB 会降级为传 URI**；`structuredContent` 由宿主推送；反向 `callServerTool` **每次都要授权弹窗**。
- 专家包就是带 `expertType: agent` 的插件包；`displayDescription` 中文需 40–50 字，`tags`/`quickPrompts` 各 3 条，头像 512×512 PNG。

## 决策

- **一个包、两种装机方式**：`temp/plugin-artifacts/modcrafting-workbuddy` 同时是插件与专家包，避免 hooks/commands/skills 出现第二份手写副本。
- **`.mcp.json` 与 `plugin.json` 只由 stage 生成**，模板里的版本用 `__VERSION__`。手写会让版本出现第四处，漂移在 validate 阶段就失败。
- **共享 SKILL 正文零改动**，只注入 WorkBuddy 需要的 frontmatter（`allowed-tools`、`user-invocable`）：这三份技能已在三宿主验收，重构风险大于收益。
- **`--text=digest`、`--workbench=builtin` 只写进 WorkBuddy 的 `.mcp.json`**，默认行为（full text、system 浏览器）逐字节不变，三宿主不受影响。
- **不加 `outputSchema`**：SDK 2.0.0 会在 `structuredContent` 不符时抛 `ProtocolError`（工具硬失败），而 36 个工具大多透传 Core 的 `Record<string, unknown>`。
- **widget 零反向调用、零轮询**：反向调用每次弹授权，做轮询式面板会是体验灾难；刷新等于代理再调一次工具。
- **CSP 只在 `--web-embed` 时放开 `frame-ancestors`**：嵌入只影响"谁能展示"，Host/Origin/Fetch-Metadata/令牌四层数据防护不变。
- **`--plan` 执行完毕即退出码 0**（含 FAIL / INCONCLUSIVE）：自动化平台把非 0 当任务崩溃，而 FAIL 是有效结论；只有计划文件无效才返回 1。

## 新增/修改

- MCP：`src/output.ts`（36 工具 title/annotations 表 + digest + 注释缺失即抛错）、`src/plan.ts`、`src/plan-report.ts`、`src/mcp-app/{ui-resources,bridge,widget,widget-entry}.ts`。
- 宿主行为：`src/workbench.ts` 增加 `mode=auto|system|builtin|link` 与 `suggestedTool`；`src/browser-server.ts` 增加 EADDRINUSE 回退、`--web-embed`、`--web-only` 引导会话；`src/mcp-server.ts` 增加 `--text`、`--workbench`、`--web-embed`、`--plan` 与三个 `ui://` 资源。
- WorkBuddy 包：`plugins/modcrafting-workbuddy/`（`hooks/` 三脚本 + lib、`commands/` 五个、`agents/modcrafting.md`、`skills/workbuddy-workflow`、`avatars/expert.png`、`plugin.template.json`、`connector-meta.json`）。
- 分发：`scripts/plugin/{stage-workbuddy,validate-workbuddy,smoke-workbuddy,skill-meta,tool-count}.mjs`；`package.json` 增加 `workbuddy:*` 与 `widget:typecheck`；`.gitattributes` 对钩子目录强制 LF。
- 断链修复：`smoke-hosts.mjs`、`smoke-experience.mjs`、`scripts/acceptance/run-first-use.mjs` 里硬编码的 `28` 改为 `EXPECTED_TOOL_COUNT`，并在 `smoke.mjs` 增加"源码 registerTool 数量 == 常量"的闸门。

## 验证

- `plugin:build` → `plugin:stage` → `plugin:smoke`：36 工具、注解齐全（16 只读 / 5 破坏性）、3 张 `ui://` 卡片（7.7KB，自包含）、`--text=digest` 生效、`--web-only` URL 自带 session、`--plan` PASS 且报告 <200KB。
- `candidate:build` → `host:stage` → `host:smoke`：Codex / Claude / Qoder 各 36 工具，浏览器备用路径正常。
- `workbuddy:stage` → `workbuddy:validate` → `workbuddy:smoke`：包结构、清单、钩子 schema、技能 frontmatter、无个人路径；三个钩子在隔离目录里用 `bash -c` 原样执行 —— SessionStart 预热 ≤1400 字符、PreToolUse 缺 `sessionId` 自动补且高危转 `ask`、PostToolUse 压缩后不含 `structuredContent` 键且 `isError` 静默、工作台 URL 交给 `present_files`；打包配置启动后 `mode=builtin` 生效。

## 未验收（不得用上面的结论替代）

- WorkBuddy 真实宿主的**内联卡片渲染**与授权弹窗行为（需要真实对话）。
- 专家召唤后的依赖引导卡片与市场展示（`categoryId`、文案长度、头像）。
- 真实游戏 `build → runClient → gameTest` 在 WorkBuddy 会话里的完整链路。
- 市场缓存复制后的路径解析（本地用 `--plugin-dir` 验证，未走市场安装）。
