# AI Agent 开发指南

本文件为 Codex、Claude Code、Cursor Agent 等 AI 助手在此仓库中工作时提供指导。

## 常用命令

```bash
npm run dev                    # Electron 开发模式（热更新）
npm run build                  # 仅编译 TypeScript / 前端
npm run start                  # 直接运行编译后的 Electron 应用
npm run test                   # 运行 harness 单元测试
npm run build:win              # 完整 Windows 构建（Setup + Portable）
npm run build:win:setup        # 仅构建 NSIS 安装版
npm run build:win:portable     # 仅构建便携版
npm run toolchain:verify       # 检查 JDK/Gradle/Wrapper 文件是否齐全
npm run toolchain:verify-offline  # 验证离线构建流程
npm run toolchain:setup        # 下载 JDK 21 + Gradle 9.5 到 resources/
npm run toolchain:prefetch     # 预取 Fabric/Minecraft 依赖（约 1GB）
npm run assets:prepare         # 下载 MC 客户端 JAR + 生成物品预览（发布前）
npm run assets:mc              # 仅下载/解压 temp/minecraft-assets
npm run assets:items           # 从已解压资源生成 public/items 与 items.ts
npm run knowledge:fetch-data   # 拉取 minecraft-data 结构化数据（PrismarineJS）
npm run knowledge:fetch-wiki   # 抓取中文 MC 百科核心词条（zh.minecraft.wiki）
npm run knowledge:build-data-index  # 构建 minecraft-data 查询索引（含中英文别名）
npm run knowledge:build-wiki-embeddings  # 计算百科向量 embeddings（需 @xenova/transformers）
npm run knowledge:cache-model  # 缓存 transformers.js 模型到本地
npm run knowledge:build-all    # 一键构建所有知识库（fetch + index + embeddings + model）
npm run clean:local -- --all   # 清理本地 release/out/temp 等生成物
```

旧命令别名（`setup:toolchain`、`prefetch:deps`、`verify:toolchain` 等）仍可用，但优先使用 `toolchain:*` / `assets:*` 命名空间。

测试使用 `scripts/test/run-harness.mjs` 自动收集 `scripts/test/harness-*.test.ts`。新增 harness 测试放在 `scripts/test/` 下，遵循 `harness-*.test.ts` 命名规范。

## 脚本目录结构

```
scripts/
├── toolchain/     # JDK、Gradle、Fabric 依赖种子
├── assets/        # MC 渲染资源与图标
├── packaging/     # electron-builder / NSIS
├── release/       # 发版清单与 Gitee 同步
├── knowledge/     # Minecraft 知识库构建脚本（fetch/build-index/build-embeddings）
├── test/          # harness 单元测试
├── lib/           # 跨脚本共享（ensure-native-deps、paths）
├── _archive/      # 一次性维护脚本
└── prebuild-win.mjs
```

## 维护注意事项

- **工具链下载逻辑双份**：`scripts/toolchain/toolchain-download.mjs`（构建脚本）与 `src/main/toolchain-download.ts`（运行时）需同步修改 URL/版本。
- **安装器静态资源**：`packaging/` 目录（原 `build/`），生成物在 `packaging/nsisbi/`（gitignore）。
- **更新清单 URL**：`packaging/update-manifest.json` 的 raw 路径为 `main/packaging/update-manifest.json`。
- **知识库构建**：`scripts/knowledge/build-all.mjs` 编排所有知识库构建步骤。新增构建步骤时需同步更新 `build-all.mjs`、`package.json` 的 `knowledge:*` 脚本、`scripts/prebuild-win.mjs` 的 `tryKnowledgeBuild()`、`scripts/toolchain/verify-toolchain.mjs` 的资源检查。
- **MC 版本升级**：升级 `resources/fabric-versions.json` 中的 `minecraft_version` 时，需重新运行 `npm run knowledge:build-all` 重建对应版本的知识库索引。
- **百科词条扩展**：编辑 `scripts/knowledge/wiki-pages-list.json` 添加新词条后，运行 `npm run knowledge:fetch-wiki` 抓取，再运行 `npm run knowledge:build-wiki-embeddings` 重建向量索引。

## 架构

ModCrafting 是一个用于 AI 辅助 Minecraft Fabric 模组开发的 Electron 桌面应用。采用三进程架构：

### 主进程（`src/main/`）

入口：`src/main/index.ts` — 创建 BrowserWindow（contextIsolation 开启，nodeIntegration 关闭，sandbox 关闭），注册所有 IPC 处理器、菜单和更新器。

| 模块 | 用途 |
|--------|---------|
| `ipc-handlers.ts` | 中央 IPC 处理器注册（约 50 个通道：fs, dialog, project, env, config, secrets, knowledge, mc, updater） |
| `build-env.ts` | 工具链子系统：JDK 21 + Gradle 9.5 配置，Fabric 离线依赖缓存（gradle-home-seed），gradlew.bat 生成，三种版本（dev/full/portable） |
| `mc-runtime.ts` | Minecraft 游戏实例管理器：启动 `gradlew runClient`，每个实例独立的 GRADLE_USER_HOME，崩溃检测，日志流式输出 |
| `terminal-handler.ts` | PTY 终端管理（基于 node-pty），通过 `terminal:data` 事件转发数据 |
| `api-config.ts` | API 端点/模型/配置持久化，API Key 通过 Electron `safeStorage` 加密存储 |
| `knowledge-service.ts` | Agent 知识库：`resources/agent-knowledge/` 中的内置 markdown + 用户覆盖 + URL 抓取 |
| `minecraft-data-service.ts` | Minecraft 结构化数据查询服务：加载 `resources/minecraft-data/<version>/index.json`，按 ID/口语名查询方块、物品、实体、附魔属性 |
| `mc-wiki-vector-service.ts` | 中文 MC 百科向量检索服务：加载预计算 embeddings，运行时用 transformers.js 计算查询向量并执行余弦相似度检索 |
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
| `tool-definitions.ts` | 通过 `registerModCraftingTools()` 注册的内置工具：文件操作、Fabric 文档、配方生成、Mixin 脚手架/注册、构建/运行触发、澄清提问、Minecraft 知识库查询（`minecraft_data_lookup`、`mc_wiki_search`、`vanilla_mc_wiki_query`） |
| `mc-data-tool.ts` | `minecraft_data_lookup`（结构化数据查询）与 `mc_wiki_search`（百科向量检索）工具实现，封装 preload API 调用 |
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
- `resources/agent-knowledge/fabric/` — 本地官方中文 develop 文档（`docs/develop/**`，由 `npm run docs:sync-fabric` 从 fabric-docs 同步）+ `docs/index.md`；运行时不联网。
- `resources/minecraft-data/<version>/` — Minecraft 结构化数据集索引（`index.json` + 别名映射），由 `npm run knowledge:build-data-index` 构建；运行时不联网。
- `resources/mc-wiki-zh/` — 中文 MC 百科核心词条 MD 文件，由 `npm run knowledge:fetch-wiki` 抓取。
- `resources/mc-wiki-zh-index/` — 百科向量索引（`embeddings.bin` + `chunks.json` + `manifest.json`），由 `npm run knowledge:build-wiki-embeddings` 预计算。
- `resources/mc-wiki-model/` — transformers.js 模型缓存（`Xenova/all-MiniLM-L6-v2` onnx 权重），由 `npm run knowledge:cache-model` 下载。
- `resources/_base_mods/` — 捆绑的辅助模组（如 Mod Menu、ModCrafting Observer），新建项目时复制进去

### Agent 关键特性

- **项目勘探**：计划阶段前自动读取 `fabric.mod.json`、`*.mixins.json`、资源目录结构，注入系统提示词
- **澄清提问**：`ask_clarification` 工具，计划/执行两阶段均可暂停向用户提问。执行阶段通过 `ClarificationNeeded` 事件 + ChatPanel 横幅 UI 交互
- **覆盖保护**：`write_file` 覆盖已有文件时输出被替换的旧内容（≤2KB），标注增删行数
- **结构化修改**：`fabric_mixin_register` 自动查找 mixins.json → 解析 → 追加条目 → 写回，避免手动编辑 JSON 误删条目
- **EBUSY 重试**：`build-env.ts` 中 `retryRmdirSync()` 对 Windows 文件锁（EBUSY/EPERM/ENOTEMPTY）最多 3 次重试，100ms 递增退避
- **本地知识库**：内置两套离线知识库（minecraft-data 结构化数据集 + 中文 MC 百科向量库），运行时不联网。详见下方"Minecraft 知识库"章节。

## Minecraft 知识库

ModCrafting 内置两套本地 Minecraft 离线知识库，agent 在生成 Fabric 模组代码时优先查询本地数据，避免 ID 与属性参数错误。

### 1. minecraft-data 结构化数据集

- **位置**：`resources/minecraft-data/<version>/index.json`（+ 原始 JSON 数据）
- **数据来源**：[PrismarineJS/minecraft-data](https://github.com/PrismarineJS/minecraft-data)，由 `npm run knowledge:fetch-data` 拉取
- **覆盖内容**：全版本原版方块、物品、实体、附魔、合成配方 JSON，包含标准命名空间 ID、方块硬度、爆炸抗性、堆叠大小、工具类型、耐久、生命值、附魔等级等全部属性
- **别名映射**：自动构建中英文别名映射（钻石矿石 ↔ diamond_ore ↔ minecraft:diamond_ore，含"矿石↔矿"等后缀变体）
- **构建命令**：`npm run knowledge:build-data-index`
- **查询工具**：`minecraft_data_lookup`（agent 工具）/ `window.api.mcDataLookupBlock` 等（preload API）
- **运行时服务**：`src/main/minecraft-data-service.ts` — 加载 index.json，提供 `lookupBlockById`、`lookupBlockByName`、`lookupItemById`、`lookupItemByName`、`lookupEntityById`、`lookupEntityByName`、`lookupEnchantment`、`searchRecipes` 等函数

### 2. 中文 MC 百科向量知识库

- **位置**：
  - `resources/mc-wiki-zh/` — 百科 MD 文档（按 category 子目录组织）
  - `resources/mc-wiki-zh-index/` — 预计算向量索引（`embeddings.bin` + `chunks.json` + `manifest.json`）
  - `resources/mc-wiki-model/` — transformers.js 模型缓存（`Xenova/all-MiniLM-L6-v2` onnx 权重）
- **数据来源**：[zh.minecraft.wiki](https://zh.minecraft.wiki)，由 `npm run knowledge:fetch-wiki` 抓取核心词条集（清单见 `scripts/knowledge/wiki-pages-list.json`）
- **检索方案**：transformers.js + 预计算 embeddings（384 维 all-MiniLM-L6-v2），运行时计算查询向量并执行余弦相似度检索
- **覆盖内容**：覆盖所有游戏机制、红石、生物、模组基础术语；处理模糊、不专业的游戏描述（"会爆炸的绿色怪物" → 苦力怕）
- **构建命令**：`npm run knowledge:build-wiki-embeddings`（需先 `npm run knowledge:fetch-wiki` 抓取文档）
- **查询工具**：`mc_wiki_search`（agent 工具）/ `window.api.mcWikiSearch`（preload API）
- **运行时服务**：`src/main/mc-wiki-vector-service.ts` — 加载预计算索引，运行时用 transformers.js 计算查询向量并执行检索

### 代码生成逻辑

agent 在编写 Fabric 模组代码时遵循以下优先级：

1. **用户输入模糊、不专业的游戏描述**（如"会爆炸的绿色怪物"、"挖矿掉的红色石头"）→ 先用 `mc_wiki_search` 检索百科知识库解析需求
2. **编写 Fabric 方块/物品/实体/附魔注册代码** → 必须先调用 `minecraft_data_lookup` 查询标准 ID 与原版属性（硬度、爆炸抗性、堆叠、工具、耐久、生命值、附魔等级等），禁止凭记忆填写原版参数
3. **原版机制/红石/生物/术语解释** → 优先用 `mc_wiki_search` 或 `vanilla_mc_wiki_query`；Fabric API/注册/事件/迁移用 `fabric_docs_search`；标准 ID 与属性参数用 `minecraft_data_lookup`

### 一键构建

```bash
npm run knowledge:build-all
```

依次执行：fetch-minecraft-data → fetch-mc-wiki-zh → build-mc-data-index → build-wiki-embeddings → cache-transformer-model。

支持 `--skip-data`、`--skip-wiki`、`--skip-embeddings`、`--skip-model` 单独跳过某步骤。

### 优雅降级

知识库资源缺失时（未构建或构建失败），agent 工具会返回明确的"服务不可用"提示，并给出构建命令建议。`vanilla_mc_wiki_query` 会自动回退到内置的本地知识文件（`resources/agent-knowledge/fabric/docs/`）。`fabric-agent-policy.ts` 中的护栏规则确保 agent 即使在知识库不可用时也不会凭记忆填写原版参数，而是提示用户运行构建命令。

### 测试

知识库相关测试位于 `scripts/test/`：

- `harness-mc-data-lookup.test.ts` — `minecraft_data_lookup` 工具的查询、别名解析、配方附加、未命中提示等行为
- `harness-mc-wiki-search.test.ts` — `mc_wiki_search` 工具的服务可用性检查、懒加载初始化、结果格式化、topK 裁剪等行为
- `harness-knowledge-build.test.ts` — 知识库构建脚本的存在性、`wiki-pages-list.json` 数据结构、`build-mc-data-index.mjs` 端到端构建、`build-all.mjs` 参数解析等
