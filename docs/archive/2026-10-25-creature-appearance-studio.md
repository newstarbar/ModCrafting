# 浏览器生物外观编辑器与自定义实体模型生成

**归档日期**：2026-10-25（Asia/Shanghai）
**基线**：`release` / `61428f6`
**交付版本**：ModCrafting Fabric 插件 `0.1.5`，Observer `2.0.0` / protocol 2
**触发方式**：用户要求“在浏览器上画出任意生物外形”的大功能实现

## 问题与目标

现有实体内容只支持猪/僵尸基型和外部 PNG 引用，用户无法在工作台内绘制皮肤，也不能改变身体几何。本轮把“外观”拆成两条可组合的路径：

- 基型皮肤：在 64×32（猪）或 64×64（僵尸）原版 UV 上绘制纹理，复用原版渲染器和动画；
- 自定义方块模型：用最多 32 个 cuboid 描述身体/头/腿/翅膀等部件，自动分配 UV，生成 `EntityModel` 与 `LivingEntityRenderer`。

## 实现

| 位置 | 变化 |
| --- | --- |
| `packages/modcrafting-core/src/entity-appearance.ts` | 新增 appearance schema、实体目标尺寸、方块 UV 自动打包、PNG 尺寸校验；自定义模式使用固定 256×256 方形图集。 |
| `packages/modcrafting-core/src/content-model.ts` | 实体对象增加可选 `appearance`；基型纹理尺寸与自定义模型纹理约束。 |
| `packages/modcrafting-core/src/content-workspace.ts` | preview/save 接收 `texturePng`；PNG 与生成文件在同一 revision/事务中写入，manifest 记录 PNG SHA-256，失败回滚，外部修改转为只读。 |
| `packages/modcrafting-core/src/content-codegen.ts` | 自定义模式生成 `ContentEntityModel`/`ContentEntityRenderer` 并注册；`leg_` 前缀部件生成简单步态；基型仍复用猪/僵尸渲染器。 |
| `packages/modcrafting-view/src/EntityAppearanceEditor.tsx` | 画笔、橡皮、填充、取色、撤销/重做、缩放、调色板、导入/导出 PNG、UV 分区、部件/方块编辑。 |
| `packages/modcrafting-view/src/EntityModelPreview.tsx` | 不引入 3D 依赖的近似等距预览，支持水平/俯仰视角和纹理取色。 |
| `packages/modcrafting-view/src/ContentEditor.tsx` | 实体内容接入外观编辑器；preview/save 携带 PNG；切基型时更新纹理尺寸。 |

## 验收证据

- 类型检查通过；插件回归 `123/123`，其中新增外观 UV、PNG 事务、模型/渲染器生成测试。
- 真实 Chromium：选择实体，画布绘制红色像素后预览/应用成功；保存后 PNG 像素为 `[192,57,43,255]`，3D 预览画布有实际渲染像素。
- 自定义模型通过临时 Fabric 1.21.4 工程 `gradlew build`，包括 `EntityModel`、`LivingEntityRenderer`、`EntityRendererRegistry` 和 `TexturedModelData` 代码。
- 完整候选流水线 `run-AyVfU3`：Bench、Observer、插件、产品、三宿主 Stage 全通过；Qoder ZIP 版本 `0.1.5`、14 个文件、bundle SHA-256 `8045951293f04dab565a78e25278436d11163b1b1e6eec0694f4fdb6cb5c6270`。

## 交付边界

外观编辑器改变纹理和方块几何，不改变实体碰撞尺寸、复杂 AI、特殊动画或服务端行为；3D 预览是近似效果，最终必须在游戏内验收。Qoder ZIP 仅生成在本地 `temp/`，未安装、未修改真实 Qoder 配置、未发布或推送。
