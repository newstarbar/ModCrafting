# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指导。

## 常用命令

```bash
npm run dev              # Electron 开发模式（热更新）
npm run build            # 仅编译 TypeScript / 前端
npm run start            # 直接运行编译后的 Electron 应用
npm run test:harness     # 运行 harness 单元测试（plan-tracker, turn-intent）
npm run build:win        # 完整 Windows 构建（Setup + Portable）
npm run build:win:setup  # 仅构建 NSIS 安装版
npm run build:win:portable # 仅构建便携版
npm run verify:toolchain # 检查 JDK/Gradle/Wrapper 文件是否齐全
npm run verify:offline   # 验证离线构建流程
npm run setup:toolchain  # 下载 JDK 21 + Gradle 9.5 到 resources/
npm run prefetch:deps    # 预取 Fabric/Minecraft 依赖（约 1GB）
npm run prepare:renderer-assets  # 下载 MC 客户端 JAR + 生成物品预览（发布前）
npm run prefetch:mc-assets       # 仅下载/解压 temp/minecraft-assets
npm run generate:items           # 从已解压资源生成 public/items 与 items.ts
```

测试使用 Node.js 内置测试运行器（`node --experimental-strip-types --test`）。新增 harness 测试放在 `scripts/` 目录下，遵循 `harness-*.test.ts` 命名规范，然后在 `package.json` 的 `test:harness` 脚本中注册。

## 架构

ModCrafting 是一个用于 AI 辅助 Minecraft Fabric 模组开发的 Electron 桌面应用。采用三进程架构：

### 主进程（`src/main/`）

入口：`src/main/index.ts` — 创建 BrowserWindow（contextIsolation 开启，nodeIntegration 关闭，sandbox 关闭），注册所有 IPC 处理器、菜单和更新器。

| 模块 | 用途 |
|--------|---------|
| `ipc-handlers.ts` | 中央 IPC 处理器注册（约 50 个通道：fs, dialog, project, env, config, secrets, knowledge, mc, updater） |
| `build-env.ts` | 工具链子系统（1819 行）：JDK 21 + Gradle 9.5 配置，Fabric 离线依赖缓存（gradle-home-seed），gradlew.bat 生成，三种版本（dev/full/portable） |
| `mc-runtime.ts` | Minecraft 游戏实例管理器：启动 `gradlew runClient`，每个实例独立的 GRADLE_USER_HOME，崩溃检测，日志流式输出 |
| `terminal-handler.ts` | PTY 终端管理（基于 node-pty），通过 `terminal:data` 事件转发数据 |
| `api-config.ts` | API 端点/模型/配置持久化，API Key 通过 Electron `safeStorage` 加密存储 |
| `knowledge-service.ts` | Agent 知识库：`resources/agent-knowledge/` 中的内置 markdown + 用户覆盖 + URL 抓取 |
| `updater.ts` | 检查 `update-manifest.json`（Gitee 优先 → GitHub 回退），使用 `electron-updater` 并显示进度 |
| `edition.ts` | 检测版本类型：`dev`（未打包）、`full`（捆绑完整工具链）、`portable`（通过 PORTABLE_EXECUTABLE_DIR 环境变量判断） |

### 预加载脚本（`src/preload/index.ts`）

使用 `contextBridge.exposeInMainWorld('api', ...)` 暴露类型化 API。每个方法封装 `ipcRenderer.invoke()` 或 `ipcRenderer.on()`（事件监听返回清理函数）。这是渲染进程与主进程之间的**唯一**桥接。

### 渲染进程（`src/renderer/src/`）

React 19 UI + AI harness 系统。

**组件**：`App.tsx` 是根组件（视图路由、会话状态、工具链初始化遮罩）。三栏工作区布局：`SessionSidebar` | `ChatPanel` | 右侧面板（`McRuntimePanel` + `BottomPanel`）。

**Harness 系统**（`harness/`）—— AI Agent 核心：

| 模块 | 职责 |
|--------|------|
| `controller.ts` | 顶层编排器：会话生命周期、意图解析、plan→execute 阶段切换、系统提示词构建 |
| `agent.ts` | LLM 交互循环：SSE 流式输出，工具调用解析（原生 function-calling + `<tool_call>` XML 回退），循环守卫，指数退避重试 |
| `tools.ts` | `Registry`、`Tool` 接口、`ToolContext`。`executeBatch()` 并行执行只读工具，串行执行写入工具 |
| `tool-definitions.ts` | 通过 `registerModCraftingTools()` 注册的 20 个内置工具：文件操作、Fabric 文档、配方生成、Mixin 脚手架/注册、构建/运行触发、澄清提问 |
| `workflow-engine.ts` | 执行阶段的串行逐步执行：每轮执行**全部**允许的工具（只读并行，写入串行）。知识查询工具不消耗 attempt 配额。修复模式（构建/运行失败时最多 3 轮修复）。支持 `ask_clarification` 暂停。 |
| `plan-tracker.ts` | `PlanTracker` 类：步骤状态追踪、自动推进、上下文块格式化 |
| `plan-compiler.ts` | 计划编译管道：解析 → 剥离主机终端步骤 → 删除模糊步骤 → 按路径去重 → 追加构建+运行步骤 |
| `step-policy.ts` | 按工作流步骤类型（inspect/write/recipe/build/run/answer）的工具门控 |
| `step-evidence.ts` | 基于证据的步骤推进：`findAdvanceEvidence()` 根据步骤类型检查工具结果 |
| `turn-intent.ts` | 将用户输入分类为 `chat`/`resume`/`develop`/`plan_only`，基于模式、上下文和编辑器模式 |
| `fabric-agent-policy.ts` | 领域特定的护栏规则、任务分类、知识源定义，用于系统提示词 |
| `fabric-utils.ts` | `validateFabricModJsonContent()`、`classifyFabricLog()`、`buildDataAssetFiles()` |
| `fetch-retry.ts` | 重试逻辑：对临时错误（5xx、429、超时、ECONNRESET）最多 3 次尝试，指数退避 |

**数据流**：用户输入 → `ChatPanel` → `Controller.send()` → 意图解析 → 构建系统提示词 → `Agent` 流式调用 LLM → 工具调用进入 `Registry` → `window.api.*` → IPC → 主进程。事件通过 `Sink` → Controller 回调 → React state → UI 回流。

### PanelBridge

`src/renderer/src/utils/panel-bridge.ts` — 单例，使 harness 工具（`trigger_build`、`runClient`）能够通过实际的 UI 面板 React ref 触发构建/游戏启动，桥接 harness 系统与组件树。

### 捆绑资源

- `resources/fabric-versions.json` — 锁定版本：MC 1.21.4、Fabric Loader 0.16.10、Fabric API 0.116.0+1.21.4、Loom 1.17.12、Gradle 9.5.0、Java 21
- `resources/agent-knowledge/fabric/` — 精简本地知识库：`api-aliases.md`（类名纠正）、`networking-snippets.md`（C2S 模板）、`yarn-gotchas.md`（Yarn/Mixin 易错点）、8 个核心 docs 镜像 + `docs/index.md`（官方 URL 索引，含联网-only 主题）
- `resources/_base_mods/` — 捆绑的辅助模组（如 Mod Menu），新建项目时复制进去

### Agent 关键特性

- **项目勘探**：计划阶段前自动读取 `fabric.mod.json`、`*.mixins.json`、资源目录结构，注入系统提示词
- **澄清提问**：`ask_clarification` 工具，计划/执行两阶段均可暂停向用户提问。执行阶段通过 `ClarificationNeeded` 事件 + ChatPanel 横幅 UI 交互
- **覆盖保护**：`write_file` 覆盖已有文件时输出被替换的旧内容（≤2KB），标注增删行数
- **结构化修改**：`fabric_mixin_register` 自动查找 mixins.json → 解析 → 追加条目 → 写回，避免手动编辑 JSON 误删条目
- **EBUSY 重试**：`build-env.ts` 中 `retryRmdirSync()` 对 Windows 文件锁（EBUSY/EPERM/ENOTEMPTY）最多 3 次重试，100ms 递增退避
