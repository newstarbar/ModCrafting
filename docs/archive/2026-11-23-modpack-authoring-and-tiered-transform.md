# 整合包创作、分级改造与三栏工作台（M0–M6）

**归档日期**：2026-11-23
**触发方式**：大功能自动归档
**涉及文件数**：约 50（Core 22 个新模块、View 5 个新面板与 2 个 shell 组件、MCP/浏览器 3 处、12 个 harness）
**问题类型**：新功能 + 架构重构

## 背景

原项目只服务单个 Fabric 模组的开发。用户要求把产品延伸到整合包：

1. 从想法检索 Modrinth / CurseForge 的现有或近似模组；
2. 对不完全满足需求的模组做分级改造（承认逆向工程的不确定性）；
3. 调整冲突、补充兼容模组；
4. 编写桥接 Mod；
5. 把可视化浏览器工作台提升到架构层面的布局；
6. 提供不改变原版玩法的通用底座（优化/画面/操作）与 FTB Quests 任务书面板。

已确认的边界：只做创作与导出（`.mrpack` + Prism/MultiMC 实例），不做启动器；双源数据；包层支持 Fabric/NeoForge/Forge，自建 Mod（桥接/伴生）仅 Fabric；改造分级授权——L1/L2 默认，L3/L4 需要许可证允许修改且逐次确认，不可再分发产物只能留在本地。

## 关键决策

- **清单与锁分离**：`pack.json` 记录“要什么”，`pack.lock.json` 记录“解析成了什么”。每次写清单都带 revision，冲突时拒绝覆盖。
- **确定性优先**：求解、锁文件、ZIP 条目全部用 code-unit 排序与固定时间戳；同一输入在不同机器上产生字节一致的锁和包。
- **先闭合再导出**：求解器做必需依赖 BFS；`satisfied`/`gap` 才写锁，`conflict`/`unsatisfiable` 不写，避免留下看似可构建的锁。导出拒绝缺失或过期的锁。
- **许可证是一等数据**：`redistributable=false` 的条目可以本地安装与改造，但字节绝不内联进导出包；L1/L2 产物也标 `exportable=false`。
- **L3/L4 诚实降级**：当前版本不内置字节码引擎与反编译器。L3 只写补丁计划（`applied:false`），L4 只写类/资源清单（`decompiler:'not-shipped'`），并在结果与 UI 里明说。拒绝与回滚同样写入 `.modcrafting/transform-audit.jsonl`。
- **伴生工程用字符串目标**：L2 生成 `@Mixin(targets = "...")`，源 jar 不进入编译类路径，既不复制第三方字节，也不会因对方换版本而让工程无法编译。
- **三栏 shell**：导航回答“去哪”，上下文栏回答“我现在在哪个工作区、什么目标、什么阶段、Agent 推荐什么”，主栏放面板。App 只决定中间内容；移动端由同一个注册表生成分组 `<select>`。
- **实例 scope 落地**：`game`/`tests` 改为 instance scope，实例组不再是空壳；单模组与整合包都可见。
- **统一页级状态**：新增 `PanelEmptyState` / `PanelErrorState`，Pack/Discover/Baseline/Bridge/Transform 与工程缺失守卫共用同一套空态/错误态。

## 改动清单

| 区域 | 文件 | 说明 |
| --- | --- | --- |
| Core 模型 | `pack-model.ts`、`workspace-model.ts`、`pack/license-policy.ts` | 锁条目补 registry/project/version；许可证修改权限判定；底座/license 类型 |
| 注册表 | `pack/registry-model.ts`、`adapters/modrinth.ts`、`adapters/curseforge.ts`、`registry-client.ts` | 双源归一化、缓存/TTL/离线、错误分类 |
| 发现/底座 | `pack/pack-discover.ts`、`pack/pack-baseline.ts`、`pack/pack-entry.ts` | 意图评分、覆盖度/缺口/nearMiss；性能/画面/操作分组与加载器替代；候选→条目 |
| 求解/IO | `pack/pack-solver.ts`、`pack/pack-workspace.ts` | BFS 闭包、findings、确定性锁；事务写、revision、drift |
| 导出 | `pack/zip.ts`、`pack/pack-export.ts` | 确定性 ZIP；`.mrpack` 与 Prism 实例；哈希/许可证/路径守卫 |
| 桥接 | `pack/bridge-scaffold.ts`、`pack/java-package.ts` | 可编译 Fabric 桥接工程（入口/适配器/Mixin/构建文件/状态命令） |
| 分级改造 | `pack/transform/trust.ts`、`l1-overlay.ts`、`l2-companion.ts`、`l3-bytecode.ts`、`l4-analysis.ts`、`transform-actions.ts` | 许可证+consent 门、审计、L1 覆盖包、L2 伴生工程、L3 计划、L4 清单、hash 校验与回滚 |
| 共享动作 | `pack/pack-actions.ts` | MCP 与浏览器共用同一套 pack 动作与错误码 |
| 工作台 | `packages/modcrafting-view/src/shell/WorkbenchShell.tsx`、`PanelState.tsx`、`registry.ts`、`panels/{pack,discover,baseline,bridge,transform}/` | 三栏布局、实例 scope、统一状态、五个新面板 |
| MCP/浏览器 | `plugins/modcrafting-fabric/src/{mcp-server,browser-server,output}.ts` | `modcrafting_pack_workspace`、`modcrafting_pack_discover`、`modcrafting_pack_baseline`、`modcrafting_bridge_scaffold`、`modcrafting_transform`；浏览器 operation 同名 |
| 测试 | `scripts/test/harness-pack-*.test.ts`、`harness-bridge-scaffold.test.ts`、`harness-panel-registry.test.ts`、`fixtures/registry/` | 全程离线夹具，覆盖发现/底座/求解/导出/改造/桥接/面板 |
| 回归修复 | `harness-modcrafting-plugin-core.test.ts`、`harness-plugin-runtime.test.ts` | 清洁度断言改为检查被跟踪文件；tar 归档改用相对输出名，修复 Windows 绝对路径被当作远程主机 |

## 验证方式

- `pnpm run typecheck`：plugin/widget/view 三段全部通过。
- `pnpm test`：**366/366 通过**（此前两项既有失败已修复并纳入全绿）。
- 新增 harness 覆盖：发现与底座夹具、求解闭包与冲突、清单 revision、ZIP 确定性与路径安全、两种导出、桥梁工程、许可证/审计、L1–L4 与回滚。`harness-panel-registry` 17 项通过。
- `pnpm run plugin:build && pnpm run plugin:stage && pnpm run plugin:smoke`：**43 个工具**注册，read-only 18 个不变，schema/annotations/UI 卡片检查通过，`plan: PASS`。
- 未执行：真实 Modrinth/CurseForge 网络调用、Gradle 实际编译桥接/伴生工程、Minecraft 实机验收、真实启动器导入。Smoke 明确标注 `realGame: not run`，这些不能由离线冒烟替代。

## 边界与后续

- 发现/底座只依赖录制夹具；CurseForge 无 Key 时降级到 Modrinth 并给修复指引。
- 桥接与伴生工程是“可编译的源码骨架”，测试验证结构与内容，未在真实 Gradle/JDK 下构建。
- L3/L4 不包含字节码引擎/反编译器；需要真正改字节时，优先 L2 或外部受信任工具，且仍受许可证约束。
- 导出只产出 `.mrpack` 与 Prism/MultiMC 实例目录，不内置启动、下载与账号能力。
- 任务书面板延续既有的 revision/preview 流程；FTB Quests 未安装时给出安装与首次创建章节的指引。

## 经验教训

- **确定性不是可选项**：`localeCompare` 在不同 locale 下会改变 ZIP 条目与锁的顺序，必须用 code-unit 比较；固定时间戳同理。
- **诚实的状态比“看起来完成”重要**：L3/L4 宁可只输出计划/清单，也不要生成一个无法验证的“已修改”jar；UI 和返回结构都保留 `applied:false` / `engine:not-shipped`。
- **拒绝也要留痕**：许可证门、consent 门、hash 不匹配都在抛错前写审计；否则用户无法区分“拒绝”与“静默无操作”。
- **Windows 工具链差异要进测试**：GNU tar 会把 `-f C:\...` 当作远程主机；相对输出名 + `cwd` 是更稳的写法。
- **本地残留不等于分支内容**：清洁度断言应检查 `git ls-files`，否则任何人的旧 Desktop `src/` 都会把发布测试变红。
