# Fabric 1.21.4 确定性生成规则

本项目固定使用 Minecraft 1.21.4、Java 21、Yarn 1.21.4+build.1。模型不得凭记忆猜测旧版本格式或方法重载。

## 配方

- 路径固定为 `src/main/resources/data/<modid>/recipe/<name>.json`，目录是单数 `recipe`。
- ingredient/key 使用字符串物品 ID 或 `#标签`。
- crafting 与 stonecutting 输出使用 `result: { "id": "namespace:item", "count": 1 }`。
- smelting/blasting 输出仍是字符串 ID，时间字段为全小写 `cookingtime`。
- 只用 `create_recipe` / `fabric_recipe_generate` 写入，并以结构化 recipe validation 作为完成证据。

## Mixin

- 顺序固定：`fabric_mixin_target_lookup` → `fabric_mixin_scaffold` → 只编辑 handler 业务逻辑 → `fabric_mixin_register` → `fabric_mixin_validate`。
- 重载方法必须携带 JVM descriptor；`@At(INVOKE/FIELD)` 必须携带完整 owner、member 与 descriptor。
- 客户端类只能注册到 Mixin 配置的 `client` 数组。
- 普通 Mixin 写入或编译成功不是完成证据，必须通过静态 Mixin 验证并完成 `build`、`runClient`。
- 不支持构造器注入、LocalCapture、slice、通配 selector、ModifyVariable、ModifyConstant；遇到这些需求必须澄清，禁止生成猜测代码。
