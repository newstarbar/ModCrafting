# Fabric Agent Template Index

本文件只记录稳定模板索引。具体代码由产品内工具生成，避免把长代码块塞进提示词。

## Java 模板

- `ModInitializer` 主入口：调用 `ModItems.registerModItems()`、`ModBlocks.registerModBlocks()` 等显式注册方法。
- `ClientModInitializer` 客户端入口：只放渲染、模型、HUD、键位、客户端事件。
- `ModItems`：使用 `Identifier.of`、`RegistryKey.of`、`Registry.register`、`Item.Settings().registryKey(key)`。
- `ModBlocks`：同时注册 Block 和 BlockItem，Block/Item 均使用 registry key。
- `DataGeneratorEntrypoint`：集中注册 lang、model、loot、tag provider。
- `Mixin`：只生成最小类与 mixin json，注入点由文档查询确认后再补。

## JSON 模板

- `fabric.mod.json`
- `assets/<modid>/lang/zh_cn.json`
- `assets/<modid>/models/item/<name>.json`
- `assets/<modid>/models/block/<name>.json`
- `assets/<modid>/blockstates/<name>.json`
- `data/<modid>/recipes/<name>.json`
- `data/<modid>/loot_tables/blocks/<name>.json`
- `data/<modid>/tags/blocks/<tag>.json`
- `data/<modid>/tags/items/<tag>.json`
