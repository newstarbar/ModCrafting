# 常见编译错误速查（1.21.4 / Fabric）

面向 Agent 修复：先对照错误类型，再 `fabric_docs_search` 查本地文档/Yarn，最后改码。

## cannot find symbol / 找不到符号

- 类名或方法被 Yarn/版本改名：用 `fabric_docs_search` 查精确类名，或看本地 Yarn 命中。
- 错误 import（混用 yarn/mojmap、旧包名）：以项目现有 import 与 Yarn 为准。
- `Item.Settings` / `Block.Settings` 缺少 `registryKey` / `setId`：见 `develop/items/first-item`、`develop/blocks/first-block`。

## client 代码进了 main（splitEnvironment）

典型：`Attempted to load class ... for invalid dist DEDICATED_SERVER` 或编译期引用 `net.minecraft.client`。

- 渲染、Screen、HUD、ClientModInitializer 相关类必须在 `src/client/java`。
- 从 `src/main/java` **迁走**（write 新路径 + delete 旧路径），不要原地改引用硬顶。

## Registry / Identifier

- `Duplicate key` / `already registered`：同一 `Identifier` 注册两次。
- 注册时机：在 `ModInitializer`（或显式调用的注册类）中完成，避免隐式静态块竞态。

## Mixin 编译期

- 目标方法签名与 Yarn 不一致：先查 Yarn 方法描述符，再改 `@Inject`/`@At`。
- 能用 Fabric API 事件替代时优先不用 Mixin。见 `develop/mixins/bytecode`、`yarn-gotchas`。

## Gradle / Loom

- 依赖解析失败：检查 Loom、Fabric API、Loader、Yarn、Java 21 是否与 `fabric-versions` 锁定一致。
- 见 `develop/loom/index`、`develop/loom/fabric-api`。
