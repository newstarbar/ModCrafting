# 常见运行时错误速查（1.21.4 / Fabric）

## Mixin apply failed / InvalidInjectionException

- 目标类/方法 Yarn 名或描述符错误、注入点偏移。
- 先 `fabric_docs_search` 查 Mixin 文档与本地 Yarn；能改用事件则移除 Mixin。

## DedicatedServer 加载了 client 类

- 把 client-only 类移到 `src/client/java` / `ClientModInitializer`。
- main 入口禁止引用 client 包。

## 资源 / 模型 / JSON

- `Unable to load model` / `FileNotFoundException` under assets：检查命名空间、路径、`blockstates`、`models`、`textures`。
- JSON 语法错误：用构建日志定位文件后修正。

## Registry 运行时

- 重复注册、错误 `RegistryKey`、物品/方块未在初始化阶段注册。
- 对照 `develop/items/first-item`、`develop/blocks/first-block`。

## 网络 / Payload

- C2S/S2C 类型与编解码不一致：见 `develop/networking.md` 与 `networking-snippets.md`。
