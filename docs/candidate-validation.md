# 候选包验收记录

该清单区分源码构建、插件接口、浏览器、Minecraft 运行和宿主聊天。每次正式交付均记录分支基线、插件版本、候选目录和 SHA-256 manifest。

## 当前分支

`release` 基于 `61428f6`（GitHub Actions 验收记录），本地已合入 AI 物品纹理工作台、构建工作台、AI 3D 体素模型（0.1.5），并以本地实现为主整合 PR #5 的生物外观编辑器、通用 GUI 纹理、JDK 工具链与知识检索改进，产品版本升为 `0.1.6`。版本号语义见 AGENTS.md：Z（第三位）= 本地开发/测试验证更新，Y（第二位）= GitHub 发行版变更，X（第一位）= 大版本更新。该发布线已移除旧 Electron/Desktop 源码、旧 Harness、旧 Windows 安装/发布链与 Desktop 迁移工具；原 `main` 保留历史记录。

| 项目 | 本分支状态 |
|---|---|
| 旧 Desktop 源码、依赖和命令清理 | 已完成 |
| Core 与浏览器类型检查 | 通过（合并后待复跑） |
| 插件回归 | 合并后待重跑（本地线 107/107，PR 线 127/127，合并后用例数会变化） |
| 插件结构校验与 MCP Smoke | 合并后待重跑；合并后注册 36 个工具（本地 28 + PR 的工具链/GUI 纹理/外观等，无重名） |
| 工作台真实浏览器面板 | 合并后待重跑：内容、配方、界面、纹理、画板、模型等模块需逐面板核验 |
| 生物外观编辑器（PR #5 集成） | 浏览器实际绘制 256×256 纹理、UV 分区/部件编辑、预览/保存均通过；保存 PNG 像素已核验 |
| 通用 GUI 纹理与 HUD 图片（PR #5 集成） | 浏览器创建 64×16 GUI 纹理、绘制并保存，PNG 像素核验；GUI 图片元素预览/应用通过；生成的 drawTexture 代码 Gradle 编译通过 |
| 自定义模型编译（PR #5 集成） | 生成的 EntityModel/LivingEntityRenderer 在临时 Fabric 1.21.4 工程中 Gradle build 通过 |
| AI 物品纹理 / 构建 / 体素模型（本地线） | 合并后待重跑 |
| Fabric Bench fixture | 21/21 用例符合预期：5 PASS、5 FAIL、11 INCONCLUSIVE |
| 完整候选构建 | 合并 0.1.6 后待重跑（源码构建可用本地 Gradle 9.5.0 种子缓存，不加 `--offline`）；Observer V2、插件、产品和三宿主分发均需通过 Stage |
| Qoder ZIP | 0.1.6 合并后待重出包；根清单、MCP 配置、命令、Skills、bundle 与兼容性文件齐全 |
| 空目录首次启动与真实游戏 | 尚未在该发布候选上重跑；当前不宣称 Minecraft 验收通过 |
| Qoder 新聊天的真实模型行为 | 待已登录的 Qoder 桌面宿主复验 |

GitHub Actions 的静态检查与 tag Release 构建规则见仓库根目录 [RELEASE.md](../RELEASE.md)。Actions 可以证明代码检查、候选构建和 ZIP 结构通过，不会自动完成表中的真实游戏或 Qoder 登录聊天验收。

本轮候选产物（均在本地 `temp/`，不提交到仓库）：

- 候选目录：`temp/candidate-artifacts/run-XkrXE4`
- 产品目录：`temp/product-artifacts/modcrafting-VAJTiz`
- 宿主分发：`temp/host-artifacts/modcrafting-LbVP5g`
- Qoder 插件目录：`temp/qoder-artifacts/modcrafting-laAXpS/modcrafting-fabric`
- Qoder ZIP：`temp/qoder-artifacts/modcrafting-laAXpS/modcrafting-fabric-qoder.zip`

本次候选 bundle SHA-256：`d7f504193b6aa3a5d9c341b532ebc851e8ad573783160ca5b1213dccde1a5412`；Qoder ZIP SHA-256：`a9dd72d6a44af305c51ddec2e50ebd987fc1a13b19e433339e8f54b15de68cf6`。Observer V2 `2.0.0`（协议 2）SHA-256 为 `1d5f46db6cddbf6ea4e1c12e73dad3c3ef4b08c860c20e028a61bf534cf308e4`，已内嵌在 bundle 中。外观编辑器验证使用临时数据目录和独立 fixture 工程，不写入真实 Qoder 配置；模型编译只证明 Java/渲染器可编译，不替代游戏内外观验收。

## 发布候选门槛

1. **静态检查**：`pnpm run typecheck`、`pnpm test`、`pnpm run plugin:validate`、`pnpm run plugin:smoke`、`pnpm run bench:fabric` 全部通过。
2. **候选构建**：设置系统 JDK 21 后执行 `pnpm run candidate:build`；确认 Observer V2 和 MCP bundle 是同次源码构建，并核对 manifest 指纹。
3. **Qoder 包**：从候选产品目录的 `plugin` 子目录构建 Qoder ZIP，检查 `.qoder-plugin/plugin.json`、`.mcp.json`、commands、Skills、bundle 和兼容性指纹；不写入真实配置。
4. **首次启动**：对空 session 数据目录，不预写 `options.txt`、测试地图或向导状态；从产品入口准备到 `canRunTests=true`。
5. **真实玩法**：至少执行正例、反例与清理检查；分别记录实例准备、Minecraft 启动、桥接和玩法断言结果。
6. **宿主聊天**：使用真实登录的 Qoder 桌面新聊天调用本版插件。工具结构、SDK Smoke 和旧聊天均不能代替此项。

## 证据记录格式

每个结果记录：分支与 commit、插件版本、操作入口、数据目录是否为空、启动准备阶段、当前界面、`bridgeReady`、`canRunTests`、测试 verdict、清理结果和产物哈希。只说明实际观察到的结果；不以浏览器可访问、桥接已连接或游戏窗口出现推断玩法通过。
