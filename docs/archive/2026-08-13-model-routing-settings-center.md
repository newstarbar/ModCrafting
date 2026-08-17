# 2026-08-13：多模型路由与独立设置中心

## 完成内容

- 新增版本化的模型路由公共类型、内置策略、任务模板、职责预算和静态路由决策。
- 路由配置独立持久化，Provider Endpoint/默认模型改为按厂商保存；密钥仍使用原有安全存储。
- Harness 在既有 Chat / Plan / Execute 生命周期中加入角色模型选择、明确回退链、协作事件和视觉能力门控；写入工具仍只分配给 implementer。
- 会话和消息持久化路由选择及协作轨迹，输入区可切换路由预设或固定模型。
- 齿轮进入独立设置中心，包含首次策略选择、Provider、模型路由、预设和工具/MCP 分类。
- Test Lab 新增 `configure_routing`，并为 `use_saved_providers` 提供兼容别名。

## 验证与后续维护

- 路由预算、单一写入者、UI 视觉约束、Minecraft/bug 模板与配置归一化由 Harness 测试覆盖。
- 路由模型失败只沿 primary/fallback 链降级；取消、安全拒绝和无效请求不触发换模型。
- 后续新增职责或 Provider 时，应同步更新 `src/shared/model-routing.ts`、设置中心、预加载类型与 Test Lab 回放场景，并保持协作轨迹不含密钥或隐藏推理。
