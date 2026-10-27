# 通用纹理绘制与 HUD 图片元素

**归档日期**：2026-10-26（Asia/Shanghai）
**基线**：`release` / `61428f6`
**交付版本**：ModCrafting Fabric 插件 `0.1.6`，Observer `2.0.0` / protocol 2
**触发方式**：在生物外观之后扩展“掉落物品、血条、Buff 模样”等附加外观

## 问题与目标

生物外观编辑器已经能绘制基型皮肤和自定义方块模型，但物品/方块纹理仍要求用户手工放 PNG，HUD 血条和 Buff 图标也没有在浏览器里绘制和引用的路径。本轮复用像素画布，补齐通用纹理与 GUI 图片元素，同时保留生物功能优先。

## 实现

| 位置 | 变化 |
| --- | --- |
| `packages/modcrafting-core/src/content-workspace.ts`、`entity-appearance.ts` | 所有内容类型都接受 `texturePng`；物品/食物/工具/护甲/方块 PNG 与生成模型继续在同一事务中保存，纹理 SHA-256 写入 manifest。 |
| `packages/modcrafting-view/src/TexturePainter.tsx`、`ContentEditor.tsx` | 16–512 像素通用画布；物品/食物/方块/工具/护甲在内容页直接绘制；支持铅笔、橡皮、填充、取色、撤销/重做、导入/导出。 |
| `packages/modcrafting-core/src/texture-workspace.ts` | 独立的 GUI 纹理工作区：list/read/save、revision 冲突、原子 PNG + manifest、备份与回滚。 |
| `packages/modcrafting-view/src/TextureWorkspace.tsx`、`App.tsx` | 新增“纹理”模块；可创建任意宽高 GUI 纹理，保存到 `assets/<modid>/textures/gui`，并在界面图片元素中引用。 |
| `packages/modcrafting-core/src/gui-model.ts`、`gui-workspace.ts`、`gui-codegen.ts` | GUI 增加 `image` 元素和 `texture` 字段；保存时校验工程纹理存在；生成的 HUD/Screen 使用 `DrawContext.drawTexture` 绘制。 |
| `packages/modcrafting-view/src/GuiEditor.tsx` | 图片元素画布预览、纹理 ID 编辑；空纹理显示占位提示。 |

## 验收证据

- 类型检查通过；插件回归 `127/127`，新增物品/食物/方块/工具/护甲绘制、GUI 纹理事务和 GUI image 代码生成测试。
- 浏览器实际创建 `64×16` GUI 纹理、绘制像素并保存；落盘 PNG 像素核验为 `[192,57,43,255]`。
- GUI 编辑器添加图片元素并引用 `gui_test:gui/health_bar`，预览显示真实 PNG，预览/应用成功。
- 生成的 HUD GuiClient 在临时 Fabric 1.21.4 工程中通过 Gradle `compileJava`，`DrawContext.drawTexture` 与 `RenderLayer::getGuiTextured` 可用。
- 生物功能未回退：之前的自定义 EntityModel 编译和外观测试仍通过。
- 完整候选流水线 `run-XkrXE4`：Bench、Observer、插件、产品、三宿主 Stage 全通过；Qoder ZIP 版本 `0.1.6`、14 个文件、bundle SHA-256 `d7f504193b6aa3a5d9c341b532ebc851e8ad573783160ca5b1213dccde1a5412`、ZIP SHA-256 `a9dd72d6a44af305c51ddec2e50ebd987fc1a13b19e433339e8f54b15de68cf6`。

## 交付边界

通用纹理工作区管理 GUI/HUD 像素资源，不自动生成 Buff 逻辑、动态血条数值、物品注册或方块行为；这些仍由 Agent/内容工作区代码生成。3D 生物预览是近似效果，所有最终外观必须在游戏内验证。Qoder ZIP 只生成在本地 `temp/`，未安装、未修改真实 Qoder 配置、未发布或推送。
