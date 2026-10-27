# AI 3D 体素模型专项功能（2026-10-26）

## 背景

issue 目标：新增 AI 制作 3D 模型的专项能力，提高对 Minecraft 低像素体素建模的适配和 3D 材质贴图的适配，在可视化网页中提供自定义编辑，并支持二次优化。经确认的产品边界：生成算力来自宿主 Coding Agent 的 LLM，插件只提供确定性编译，不调用任何 3D/AI 服务；资产阶段为方块/物品 → 实体 → 建筑分阶段，本期只交付方块/物品；不做 OBJ/GLB 等外部网格导入。

## 调研结论

- Blockbench（GPL-3.0）与 [blockbench URL 参数文档](https://blockbench.net/wiki/docs/url-parameters/)：具备成熟的 MC 模型编辑与链接载入机制，但嵌入浏览器工作台需要完整应用托管，双向保存/插件 API 兼容性未验证；首版不嵌入。
- 体素建模/贪心网格类开源实现（Mikola Lysenko meshing 综述、voxel 类编辑器）：采用业界通用的 6 邻接面剔除 + 逐轴贪心矩形合并思路，TS 自行实现，不引入第三方网格库。
- Minecraft 1.21.4 模型格式：block model elements 支持 from/to/faces 自定义 UV，物品模型定义拆分到 `items/<id>.json`；据此设计编译输出，未参考需要网络下载的实现。

## 决策

- 宿主 Agent 只写紧凑语义 DSL（调色板 + RLE 图层 + box 原语），编译、网格、图集、PNG 全部在插件内确定性完成；同一 DSL 永远得到字节级相同的产物。
- DSL 存放在 content 对象 `voxel` 字段，随 `.modcrafting/content/<name>.json` 复用 revision / 冲突检查 / 备份回滚，不另建文件所有权体系。
- 图集 PNG 为受管二进制：`ContentFile` 增加 `binary` + base64，保存/回滚按字节精确比较；外部改写后对象转只读。PNG 编码自研（node:zlib + CRC32，固定压缩级别，无时间戳），保证确定性；`sharp` 仅在测试中用于解码验证。
- 浏览器编辑器自研 Three.js 体素画布（three.js 已是 view 依赖的一部分进入单文件包），不引入 Blockbench 或其他建模软件；含 `ops` 原语的对象只读展示，需显式压平为图层后编辑，避免 layers/ops 双写歧义。
- 保存后需重新构建并重启 Minecraft；Observer 截图只作视觉证据。

## 新增/修改

- Core：`voxel-dsl.ts`（zod 严格校验、RLE 解析/编码、求值、ASCII 预览）、`voxel-mesh.ts`（贪心网格）、`voxel-atlas.ts`（确定性图集/UV）、`voxel-png.ts`（PNG 编码）、`voxel-codegen.ts`（量化/降采样/去悬浮/编译）、`voxel-workspace.ts`（template/list/read/validate/preview/save）。
- Content 集成：`content-model.ts` 增加 `voxel` 字段与 `binary`/`size`；`content-codegen.ts` 输出图集资产；`content-workspace.ts` 二进制 diff 与冲突检查；`template-codegen.ts` 增加 `GeneratedAsset`。
- MCP：注册 `fabric_voxel_workspace`；模块枚举加 `model`。
- 浏览器：`voxel-editor.ts`（网格/图层互转）、`VoxelCanvas.tsx`（Three.js 渲染与指针编辑）、`ModelEditor.tsx`（模型工坊）、`App.tsx` 模块、`view.css`。
- 构建：`build.mjs` 的 view esbuild 增加 `jsx: 'automatic'`。此前经典 JSX 转换要求每个 tsx 显式 `import React`，缺失时运行时报 `React is not defined`（同时影响已提交的 ContentEditor/visuals 与 GUI 编辑器）。

## 验证

- `pnpm run plugin:typecheck`、`pnpm run view:typecheck`：通过。注意 `plugin:typecheck` 未开 strictNullChecks，zod v4 `z.tuple` 推断退化，schema 内改用 `z.array(...).length(3)`。
- 新增 harness：`harness-voxel-model.test.ts` 8 项（DSL 错误定位、RLE/镜像求值、贪心合并、图集与 PNG 字节确定性、validate 往返、block+item 保存、外部改图集转只读、二进制回滚），全部通过。
- `pnpm run plugin:build`：通过，自包含包约 2.96MB（含 three.js）。
- `pnpm run plugin:smoke`：28 个工具注册成功。
- 真实浏览器验收：`modcrafting_open_workbench` 返回链接 → `view=model` 打开工坊；新建方块 → 压平 → 画布点击放置体素（暴露并修复 place 工具无法在已有表面放置的缺陷）→ 撤销/重做统计正确 → 预览差异含二进制 PNG 预览 → 保存后磁盘生成 model JSON（30 个贪心合并 cuboid）、atlas/particle PNG、1.21.4 items 定义 → “重新加载”读回 DSL。全程无控制台错误。
- 完整 `pnpm test`：128/131；3 个失败与本次无关（仓库根遗留 `src/` 触发 release 清洁度断言；资源准备测试的 Windows `tar` 路径缺陷）。
- 未执行真实 Qoder 登录聊天与 Minecraft 实机外观验收（需 JDK 21 与 Observer 组件，留待用户/Agent 在工作台内完成 setblock/give 验证）。

## 边界

本期不包含：实体模型与动画（二期）、建筑结构（三期）、参考图转体素、OBJ/GLB/Blockbench 文件导入、镜像外的对称轴、非 16px tile 的图集布局。DSL 上限每轴 32、总 32768 体素、26 色、cuboid ≤4000；超出报 `VOXEL_TOO_COMPLEX`。
