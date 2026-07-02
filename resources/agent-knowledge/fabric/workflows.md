# Fabric Agent Workflows

## 内容注册

1. 读取 `fabric.mod.json` 获取 mod id。
2. 查询 Fabric 文档或 JavaDoc 确认 Registry/API 签名。
3. 使用 `fabric_content_register` 或结构化生成器写注册类。
4. 使用 `fabric_data_assets_generate` 写 lang、model、blockstate、loot、tag。
5. 使用 `trigger_build(build)` 验证。

## 配方与数据资源

1. 配方任务优先使用 `fabric_recipe_generate`。
2. 标签、战利品、模型、语言文件优先使用 `fabric_data_assets_generate`。
3. 需要大量 JSON 时优先规划 DataGen，而不是手写重复资源。
4. 写入后运行 `trigger_build(build)` 或 `trigger_build(runDatagen)`。

## Mixin

1. 先查询 Fabric API 是否已有事件或回调。
2. 只有无公开 API 时使用 `fabric_mixin_scaffold`。
3. 写入前确认 Yarn 目标类和方法签名。
4. 构建失败时使用 `fabric_log_debugger` 分类 Mixin 错误。

## 调试

1. 先读取最近构建或运行日志。
2. 使用 `fabric_log_debugger` 分类问题。
3. 针对分类修复：Mixin、客户端/服务端、资源 JSON、Registry、Gradle/Loom。
4. 修复后重新构建或启动游戏验证。
