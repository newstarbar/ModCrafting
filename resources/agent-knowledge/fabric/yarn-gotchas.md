# Yarn / Mixin 易错点（MC 1.21.4）

写代码前查 Yarn mappings 或 `searchLocalSources`，避免以下常见错误。

## 客户端/服务端

- `PlayerEntity` **没有** `input` 字段；客户端输入在 `ClientPlayerEntity.input`。
- `ClientPlayerEntity`、`MinecraftClient` 等客户端类**不可**在 common mixin 或服务端代码中引用。
- common mixin 同时应用于客户端与服务端；需要客户端专用逻辑时使用 mixins JSON 的 `"client"` 条目。

## Mixin

- Mixin 类名**不能**与目标类名相同（会导致递归注入失败）。
- `@Accessor` 目标必须是 **interface**（或 abstract class），不能是普通 class。
- 非 `@Accessor` 的 Mixin 必须在 `mixins.json` 中注册。
- `@Inject` 方法通常为 `private void`，末尾参数为 `CallbackInfo` / `CallbackInfoReturnable`。

## 查表方式

- 类名/方法签名：优先 `fabric_docs_search` 的 Yarn 精确匹配或 Fabric API 源码搜索。
- 完整 API 教程：见 `docs/develop/` 下官方中文文档（本地同步，如 `docs/develop/events.md`、`docs/develop/networking.md`）。
