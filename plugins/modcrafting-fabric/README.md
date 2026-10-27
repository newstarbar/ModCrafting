# ModCrafting Fabric Plugin

面向 Qoder、Codex 等外部 Agent 的 Fabric 1.21.4 MCP 插件。Agent 负责交流、规划与源码编辑；ModCrafting 提供工程检查、知识查询、内容/配方/界面工作台、构建、Minecraft 启动准备和游戏内测试。

当前插件版本：**0.1.6**。运行环境不依赖 Electron；游戏运行需要系统 JDK 21 和工程 Gradle Wrapper。JDK 不可用时可用 `modcrafting_toolchain` 指定已有 JDK 21，无需重启 Qoder。Qoder 的 ZIP 安装方式见仓库 [Qoder 使用指南](../../docs/qoder-user-guide.md)。

## 本插件提供什么

- 每个任务独立 session，隔离工作台状态、测试配置、作业、游戏实例和报告；工程源码仍可共享。
- 生物内容支持浏览器外观编辑器：可绘制基型皮肤，或切换到自定义方块模型，增删身体/头/腿等部件；保存时 PNG、模型数据和代码一起事务写入。
- 物品、食物、方块、工具和护甲支持在内容页直接绘制图标/纹理；独立的“纹理”工作区可绘制 GUI 血条、Buff 图标和 HUD 图片，并在界面编辑器中作为“图片”元素引用。
- 浏览器工作台使用侧栏导航和单一主区域；Agent 可推荐模块，用户仍可手动切换。
- 测试实例默认简体中文、1280×720、视距 8、60 FPS、30% 音量，旁白关闭；默认平地、种子 0、创造模式、和平难度并允许命令。
- Minecraft 准备流程有明确阶段。`bridgeReady` 不等于 `canRunTests`；只有测试环境就绪才允许执行玩法断言。
- 复制存档时来源只读，测试只修改 session 专属副本。运行期间改配置仅对下次启动生效。
- 自定义模型自动分配 UV 并生成 `EntityModel`/`LivingEntityRenderer`；仍沿用所选猪/僵尸基型的 AI、碰撞尺寸和属性。网页 3D 预览是近似效果，最终以游戏内截图为准。
- 默认 `minecraft_snapshot` 是精简快照；完整诊断需显式 `full=true`。`minecraft_screenshot` 默认只返回路径，`inline=true` 才内嵌图片。
- 定向读取使用 `minecraft_entity_query`、`minecraft_widgets`、`minecraft_entity_nbt`；长日志用 `minecraft_log_read` 分页。GameTest 额外支持实体属性、名称和队伍断言。

工具描述、输入 Schema 和有效 GameTest 模板由 MCP Server 暴露。使用前先通过 `modcrafting_environment_status` 检查工程，再在任务开始时调用 `modcrafting_session` 创建/恢复 session。后续游戏和测试工具显式传递同一个 `sessionId`。

## 开发与打包

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run typecheck
pnpm test
pnpm run plugin:smoke
```

完整候选包需系统 JDK 21：

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'
pnpm run candidate:build
pnpm run plugin:qoder -- --source 'D:\path\to\candidate\plugin'
```

命令只生成本地目录和 ZIP。它不安装插件、不编辑真实 Qoder 设置、不上传或发布。候选的验收边界见 [候选验收记录](../../docs/candidate-validation.md)。

## 已知边界

- 未在真实登录的 Qoder 新聊天中复验，不宣称宿主模型调用已通过。
- 不支持的观察断言返回能力不足；截图只是辅助证据。
- 插件不会自动下载 JDK/Gradle，不包含 Minecraft 游戏本体。
- `release` 不包含旧 Electron/Desktop 应用、旧 Harness、Windows 安装器或旧配置迁移工具；历史版保留在旧 `main`。
