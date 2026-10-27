# 工作台前端、测试世界重启与桥接残留回归修复

**归档日期**：2026-10-25（Asia/Shanghai）
**基线**：`release` / `61428f6`
**交付版本**：ModCrafting Fabric 插件 `0.1.4`，Observer `2.0.0` / protocol 2
**触发方式**：真实使用日志暴露的复杂回归自动归档

## 问题与目标

真实“圆石食用模组”会话中，工作台的内容/配方/界面三个面板点击后整页报 `React is not defined`；Minecraft 每次重启都新建 `ModCrafting Test World (1)` 并准备失败；强停客户端后残留 `modcrafting-bridge.json` 被误判为活实例；`minecraft_snapshot`/`minecraft_screenshot` 每次响应都超过宿主上下文限制；文档检索长查询始终为空结果。本轮逐项修复这些插件缺陷，不修改使用者的模组工程。

## 实现

| 位置 | 变化 |
| --- | --- |
| `scripts/plugin/build.mjs`、`packages/modcrafting-view/src/App.tsx` | 浏览器 view 改用自动 JSX runtime，构建时拒绝任何经典 `React.createElement`；为每个工作区增加独立错误边界，单面板失败不再吞掉侧边栏。 |
| `bridge-mod/.../GamePreparation.java` | `LevelStorage` 根目录改为 `runDirectory/saves`，与 Core 的 `prepareWorldCopy` 及原版 MinecraftClient 一致，重启可加载同一测试世界。 |
| `packages/modcrafting-core/src/runtime.ts`、`node.ts` | 启动前探测 discovery 端口；端口已关闭则把残留文件重命名为 `.stale-<timestamp>` 后继续，端口仍监听才返回 INSTANCE_CONFLICT。 |
| `runtime.ts`、`bridge-mod/.../GameTestApi.java` | 默认快照使用小半径、无配方、无 trace、实体/物品字段裁剪；Observer 支持 `includeRecipes`/`includeTraces`/`traceLimit`，避免全量 dump。 |
| `plugins/modcrafting-fabric/src/mcp-server.ts` | 新增 `minecraft_entity_query`、`minecraft_widgets`、`minecraft_entity_nbt`、`minecraft_log_read`；截图默认只回路径，`inline=true` 才回 base64；状态/任务输出只回尾部；`execute if` 条件不成立返回 `condition:false`。 |
| `packages/modcrafting-core/src/domain.ts`、`game-test.ts` | 新增 `entity_attribute`、`entity_name`、`entity_team` 断言；Observer 实体快照补充队伍字段；Core 报告保持 PASS/FAIL/INCONCLUSIVE 语义。 |
| `node.ts`、MCP `minecraft_input` | Fabric 文档改为分词加权检索；输入动作增加枚举、`press_key` 别名和可读错误；技能文档同步新工具与 JDK 解析顺序。 |

## 验收证据

- TypeScript 两侧 typecheck 通过；插件全量回归 `121/121` 通过（新增快照裁剪、桥接端口探测、测试世界路径、实体断言用例）。
- MCP Smoke 通过并列出 32 个工具；Fabric Bench fixture `21/21` 符合预期（5 PASS、5 FAIL、11 INCONCLUSIVE）。
- 使用独立临时数据目录和 fixture 工程，在真实 Chromium 中依次打开内容、配方、界面工作区；三个面板均正常渲染，控制台无错误。
- 完整候选流水线 `run-LXtO3m`：Bench、Observer、插件、产品、三宿主 Stage 全通过；产品/宿主目录与 Qoder ZIP 均基于本次源码。
- Qoder ZIP：`temp/qoder-artifacts/modcrafting-7UXMSD/modcrafting-fabric-qoder.zip`，版本 `0.1.4`、非机器专用、14 个文件，ZIP SHA-256 `b0be3d329e69929161202aac1ec9bdd05c43b917922648889452ae1021da1253`；bundle SHA-256 `1cc527c832d2e4fc4bf54ab9f380dd948691a4c5b54031f85cbc946f41870a1d`；Observer SHA-256 `1d5f46db6cddbf6ea4e1c12e73dad3c3ef4b08c860c20e028a61bf534cf308e4`。
- 证据边界：没有在本候选上重跑真实 Minecraft 起停/玩法，也没有在真实登录的 Qoder 新聊天中复验；测试世界路径修复与桥接恢复仍需要真机重启验收。

## 交付边界

Qoder ZIP 只生成在本地 `temp/`，未安装、未修改真实 Qoder 配置、未发布或推送。使用者的 `D:\mcceshi` 工程和旧的根目录测试世界绕过副本不在本轮改动范围；新版启动会使用会话目录下的标准 `saves` 世界。
