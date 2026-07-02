# Fabric Agent Policies

## 硬约束

- 默认目标栈：Minecraft 1.21.4、Fabric Loader 0.16.10、Fabric API 0.116.0+1.21.4、Yarn 1.21.4、Java 21。
- 优先使用 Fabric API 事件、Registry、DataGen 和公开 API。
- 客户端代码必须放在 `src/client/java` 或客户端入口，不能被主入口直接引用。
- 所有注册逻辑从 `ModInitializer` 或其显式调用的注册类进入。
- 方块实体、NBT、GUI 和网络包必须考虑服务端状态、客户端显示和同步。
- 资源 JSON 必须匹配 `assets/<modid>/...` 或 `data/<modid>/...` 路径。
- Mixin 和 Access Widener 是高级能力，默认提示冲突风险。

## 验证要求

- 写 Java 或 JSON 后运行 `trigger_build(build)`。
- DataGen 变更后运行 `trigger_build(runDatagen)`。
- 用户要求游戏内行为时运行 `trigger_build(runClient)`。
- 失败时先读取日志，再分类修复，不要盲目重复构建。
