# AI 物品贴图专项功能（2026-10-25）

## 背景

issue 目标：新增 AI 绘制物品贴图的专项能力，提高对 Minecraft 低分辨率像素画的适配，并在浏览器工作台提供逐像素编辑、二次优化和编辑。此前 Core 只能读取/预览工程 PNG，`content-workspace` 的保存事务只处理文本，不能写 PNG；仓库也没有图像模型调用。

## 调研结论

- [blockpixel-artist](https://github.com/yzxr123/blockpixel-artist)（Apache-2.0）：目标网格直接构图、canonical 轮廓模板、自动质检。采用其质检维度（尺寸、二进制 Alpha、部分透明、NN 放大、宏块均匀度、调色板碎片、连通分量、贴边、边缘亮度、占用率），用 TS 重写。
- [PixelOE](https://github.com/KohakuBlueleaf/PixelOE)（Apache-2.0）：对比度感知轮廓扩张 + 降采样 + 调色板量化/抖动；自行实现简化管线，不拷贝无许可证的 PixelOE.js 代码。
- [pixelgen / minecraft-item-16px](https://github.com/yuuki14202028/pixelgen)：验证专用 SD1.5 可原生出 16×16 透明物品图，但需要 GPU，权重为 CreativeML OpenRAIL-M，训练数据含 all-rights-reserved；首版不接入。
- [texlab](https://github.com/payangar-dev/texlab)：同类 MC 贴图编辑器 + MCP，Tauri/Rust，仅参考交互。

## 决策

- 宿主 Agent 负责生图；插件 `fabric_texture_workspace` 只提供提示词包、导入、像素化、质检、候选和保存，不调用任何模型。
- 首版支持 16/32/64、只接受 PNG、要求二进制 Alpha；不接专用模型/ComfyUI/HF Space。
- 纯 TS 像素算法由服务端与浏览器共用；服务端用 `fast-png`（MIT，依赖 fflate/iobuffer，纯 JS）编解码，避免原生 `sharp` 进入单文件包。
- 候选源图/结果保存在 runtime 数据根；工程只写 `assets/<modid>/textures/item/<name>.png`。
- 保存使用独立 `texture.lock`、备份、tmp/rename、`expectedRevision` + `previewRevision`；物品引用通过 `bind` 复用 content workspace revision。
- 浏览器新增 `textures` 模块和自研 canvas 像素编辑器，不引入新的 UI 框架。
- 使用流程以 Agent 自动完成为默认（2026-10-26 按用户反馈调整）：同一轮对话内连续 prompt → 生图 → import → save → bind，结束一次性汇报质检与重建/重启提醒；工作台“贴图”模块只作可选润色入口，不要求用户手动逐步操作。

## 新增/修改

- Core：`texture-core.ts`（纯算法/质检/提示词）、`texture-png.ts`（PNG 编解码/限制）、`texture-workspace.ts`（候选库/保存/bind）。
- MCP：注册 `fabric_texture_workspace`；返回 MCP image content 与 data URL；模块枚举加 `textures`。
- 浏览器：`browser-server` 新增 texture action 与 `POST /api/texture-source`（8MB PNG）；`TextureStudio.tsx`、`pixel-editor.ts`、`client.ts` 上传方法、`App.tsx` 模块和 `view.css`。
- 构建：`fast-png` 依赖；`build.mjs` 的外部依赖检查改为允许 Node 内建模块，因为 `fflate` 以裸名引入 `worker_threads`。
- 文档/技能：architecture、core-contracts、agent-integration-boundaries、candidate-validation、qoder-user-guide、fabric-mod-development、modcrafting-start。

## 验证

- `pnpm run plugin:typecheck`、`pnpm run view:typecheck`：通过。
- 新增单测：Texture pipeline 6 项、pixel editor 2 项、texture workspace 3 项、browser texture 链路 1 项，全部通过。
- `pnpm run plugin:build`：通过；`THIRD_PARTY_NOTICES.txt` 包含 fast-png/fflate/iobuffer。
- `pnpm run plugin:stage && pnpm run plugin:smoke`：28 个工具；真实 PNG 经单文件产物完成 import、analyzeOnly preview、save、read。
- 真实浏览器验收：`textures` 模块加载无控制台错误；上传 PNG 后生成候选并显示 16×16 画布；保存后 revision 从 `412b6361` 变为 `a0817d95`，工程 PNG 被原子替换。
- 完整 `pnpm test`：120/122；两个失败与本次贴图改动无关：仓库根存在未跟踪 `src/`，触发 release 清洁度断言；离线资源测试的 `tar` 在当前环境报 `Cannot connect to C: resolve failed`。
- 未执行真实 Qoder 登录聊天、真实 Minecraft 贴图外观验收或 `candidate:build`（需要 JDK 21 与 Observer/Builder 组件）。

## 边界

首版不包含：外部模型 API/ComfyUI、专用 16×16 模型、图层/动画/精灵表、方块可平铺纹理、批量 AI 变体。保存后无热重载，必须重建并重启；截图只能作为视觉证据，不能自动判定美术质量。
