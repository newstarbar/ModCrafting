# 上下文窗口归因可视化（运行时分段条 + 诊断导出账目）

**归档日期**：2026-10-05
**触发方式**：大功能自动（新增核心模块 + 修改诊断导出行为）
**涉及文件数**：10（3 个新增、7 个修改）
**问题类型**：功能新增 / 可观测性 / 文档

## 背景

承接 `2026-10-05-harness-repeated-failure-root-causes.md`。那次修复解决了"为什么会卡死"，但复盘同一份会话诊断日志 `temp/logs/mc-session-diag-20261004-184642.md` 时发现：**当时没有任何指标能看出上下文被浪费了**。

对日志附录（Controller API 消息快照，182,709 B ≈ 模型实际所见）做字节统计：

| 项 | 字节 | 占快照 |
|----|------|--------|
| 静态系统提示 `[1]` | 30,549 | 16.7% |
| 同一份 V2 游戏场景 JSON 出现 4 次 | 88,616 | 48.5% |
| 其中助手把 `submit_plan` 工具结果原样复读进自身文本（`[39]`/`[43]`） | 44,234 | **24%（纯浪费）** |
| 单条 `fabric_mixin_target_lookup` 成员全量 dump（`#8`） | 10,318 | 5.6% |

而状态栏的上下文条算的是 `prompt_tokens ÷ 有效窗口`，DeepSeek 声明 `contextWindow: 1_000_000`，整场会话只显示 2~3%，永远"安全"。**结论：缺的不是更大的百分比条，而是分类归因与重复检测。**

## 关键设计决策

| 决策 | 取舍与理由 |
|------|-----------|
| 拉取式而非在请求热路径埋点 | `controller.getSnapshot()` 返回 `this.messages` 且**保留 `origin` / `phase`**（导出器就在读这两个字段），渲染层已能拿到近乎完整的"模型所见"。因此不改 `agent.ts`，避开刚落地的大改（`fc72cfd`，148 文件 / +17015 行） |
| 已知低估显式化为 `unaccounted` | engine 每轮的 `workflowPrompt` 与工具 schema 不在控制器快照里。宁可列一块"未归类"并强制展示，也不把系统提示的比例放大去吸收它 |
| 估算只许缩小、不许放大 | 若用 `k = promptTokens / Σ估算` 放大，等于把看不见的注入与 schema 记到系统提示账上；改为 `scale = min(1, promptTokens/Σ估算)`，残差进 `unaccounted` |
| 不用 `context-compact.ts` 的 `len/4` | 该函数自述"仅供压缩触发，非计费"，且对中文低估约 4 倍；本仓库提示词几乎全中文，沿用会让残差吞掉真实分类 |
| `duplicateShare` 分母取已测量部分 | 1M 窗口下 `unaccounted` 会把重复占比稀释成"看起来安全"，正是本次要治的病 |
| 图片不按 base64 长度估 | 走固定估算，避免 200KB 的 data URL 被算成 5 万 token |
| 只提示不干预 | 超阈值/高重复只发 `Notice` 与徽标，不新增预算引擎、不中断任务；留 `CONTEXT_ATTRIBUTION_ENABLED` 作为回退开关 |

## 首轮实机反馈后的三处纠正

首版在真实窗口被指出「点不出浮层 / 方向不对 / 比例不对」，三条全部成立，且根因互不相同：

| 现象 | 根因 | 修复 |
|------|------|------|
| 点击无浮层 | `.statusbar { overflow-x: auto }` 使状态栏成为滚动裁剪容器（CSS 规范：一个轴非 `visible` 时另一轴也取 `auto`），向上溢出的绝对定位子元素被整块裁掉 | 浮层改 `createPortal` 到 `document.body` + `position: fixed`，按锚点 `getBoundingClientRect()` 定位并做视口夹取；开关状态与外部点击 / Esc 关闭一并收进 `StatusBar`，删除 `App` 侧的重复监听 |
| 比例不正确 | 分段容器占满轨道 100% 宽度，"窗口只用了 3%"这条原始语义被彻底丢失——分段条变成了纯构成图 | 容器宽度改为占用百分比，右侧留空即剩余额度；容器内部再按 `share` 分配，占用与构成同时可读 |
| 方向错误 | 分类一律按 token 降序，体量最大的 `unaccounted`（暗灰 `#4a4640`）排在最左，与空轨道底色 `#161412` 几乎无法区分，把有颜色的真实分类全挤到右端 | `unaccounted` 恒定居末，其余按 token 降序 |

教训：**改造既有可视化时必须保住它原本的编码量**。占比条的"填充宽度 = 占用率"是用户已经建立的心智模型，只加构成维度不能让构成吃掉占用。

## 改动清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/renderer/src/utils/context-attribution.ts` | 新增 | `buildContextAttribution(messages, {promptTokens, windowTokens})`：8 类分类、锚定、两级重复检测、`byTool` 聚合、`toContextFrame` 紧凑帧；`estimateTextTokens` 做 CJK 修正；纯函数无 IO |
| `src/renderer/src/components/ContextBreakdown.tsx` | 新增 | 浮层明细：分类表、Top-N 最大消息、重复组、工具体积、"窗口占用 vs 计费等效"，并固定输出估算口径免责说明；由 `StatusBar` 经 portal 渲染，接收视口锚点 |
| `src/renderer/src/components/StatusBar.tsx` | 修改 | 占比条改为「宽度 = 占用率」的分段堆叠条，浮层开关/定位/外部点击与 Esc 关闭全部内聚于此；仅在存在归因时输出 `role="button"`/`aria-*`，**无归因时逐字节退回改动前的单色 `__fill`**；tooltip 追加重复占比与重复徽标 |
| `src/renderer/src/utils/usage.ts` | 修改 | `UsageStats` 新增可选 `attribution` / `attributionHistory`；`normalizeSessionUsage` 恢复时清空（归因须由活跃快照重算） |
| `src/renderer/src/harness/session-runtime.ts` | 修改 | `EventKind.Usage` 分支内计算归因并追加有界历史（`slice(-60)`）；`try/catch` 保证记账异常不影响运行 |
| `src/renderer/src/App.tsx` | 修改 | 仅透传 `attribution` 给 StatusBar |
| `src/renderer/src/utils/session-export-md.ts` | 修改 | 新增 `mdTable()` 表格构造器与本文件首个表格章节 `### 上下文占用账目`；强制输出"导出体积≈真实上下文 1.8 倍、`clip()` 已截断，不得由正文反推"的口径警告 |
| `src/renderer/src/components/ChatPanel.tsx` | 修改 | 导出时传入 `contextAttribution` / `contextAttributionHistory` |
| `src/renderer/src/styles/global.css` | 修改 | 分段/浮层样式，全部复用既有 CSS 变量与 MC 边框贴图，不新增依赖 |
| `docs/harness.md` | 修改 | 新增「上下文占用归因」小节 |

## 验证

- 新增 `scripts/test/harness-context-attribution.test.ts` **14 例全绿**，含关键回归：`tool` 长结果被 `assistant` 原样复读必须被识别并量化；行号 gutter 不得掩盖近似复读；无 usage 时降级；图片 base64 不得进文本估算；锚定后 `Σ分类 === promptTokens` 无漂移。
- **真实日志夹具复算**：把该日志附录的 79 条消息解析后喂入模块，得到重复浪费 12,554 token / **27.2%**、系统提示 18.4%、工具结果 43.9%，与独立字节统计（24% / 16.7%）同量级（差异来自 token 化权重），证明归因方向正确。
- `npx vitest run` 全量 **5 文件 39 例通过**；StatusBar 快照文件净增 199 行、删除 0 行，即既有 6 个快照逐字节不变。新增 3 例覆盖交互：点击经 portal 出现在 `document.body`（断言其**不在**状态栏容器内，锁死裁剪回归）、Esc 关闭、卸载后不残留、无归因时不输出 `role`/`aria-label` 且点击无效、分段总宽 = 占用率、`unaccounted` 居末。
- 首次改动曾因无条件加 `aria-label` 破坏 6 个快照并给非交互元素挂上交互语义，已改为仅在可点击时输出。
- `npm run typecheck`：23 条错误 = `fc72cfd` 记录基线，**零新增**，且无一条位于本次改动文件。
- `npm test`：失败集合仅 `mc-test-scenario` / `test-design-step` / `game-test-recovery` / `plan-tracker`（2 条 recipe）/ `game-test-protocol` / `write-path-mismatch` / `plan-compiler-dedupe`，均为基线类别；`normalizeSessionUsage` 两例单独验证通过。

## 已知限制

- `unaccounted` 在 1M 窗口下可能偏大（估算器偏差 + 不可见注入混在一起），无法进一步拆分——除非改请求热路径。
- 逐轮序列只在内存中，切换/恢复会话后不保留（有意不动 `session-store` 持久化语义）。
- 占用率极低时（如 3%）分段会被压到几像素宽，构成信息只能靠浮层读——这是保住"宽度 = 占用率"语义的必然代价，不做视觉放大以免再次误导。
- 三处纠正后仍**待开发者在真实 Electron 窗口二次确认**观感（浮层位置是否遮挡、`border-image` 贴图在 portal 下的呈现）。
