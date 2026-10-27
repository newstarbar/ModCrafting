# Agent 与运行时边界

ModCrafting 不运行自己的模型或聊天循环。Qoder、Codex 等宿主负责对话、模型与代码编辑；ModCrafting 提供 Fabric 工程、构建、游戏准备、工作台编辑和确定性测试能力。

- **MCP**：Agent 调用的稳定工具接口；Schema 和真实 `GameTestSpec` 模板从 Core 定义生成。
- **Core**：唯一的工程/游戏任务所有者；按 `sessionId` 隔离页面意图、配置、作业、实例、日志和报告。
- **浏览器工作台**：复用 MCP 的 Core runtime。用户的手动导航优先，Agent 仅更新推荐模块；草稿不会自动写回。
- **Observer V2**：Minecraft 内状态、动作和准备阶段桥接。连接成功不代表世界已就绪。
- **AI 物品贴图**：宿主模型负责生图；插件只提供提示词包、像素化、质检、网页编辑和带 revision 的 PNG 保存，不调用图像模型。生成贴图不等于游戏内视觉验收。
- **宿主插件包**：Qoder ZIP 与 Codex Plugin 复用同一 Core 构建和 Skills；安装配置与模型聊天属于宿主侧验收。

验收记录必须分开说明：包结构、MCP 初始化/工具调用、浏览器连接、实际游戏启动、玩法断言和宿主真实对话。离线测试和 SDK Smoke 不能代替登录后的 Qoder 新聊天实测。

当前版本没有 Electron 主程序或内置 Agent Loop。历史 Desktop 代码保留在旧 `main` 分支，不应复制回 `release`。远端发布只由 `release` 线上的版本 tag 工作流创建，规则见仓库根目录 `RELEASE.md`。
