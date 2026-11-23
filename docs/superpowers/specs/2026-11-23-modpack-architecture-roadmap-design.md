# 整合包开发架构路线图

- 日期：2026-11-23
- 分支：`release`
- 状态：已实现 M0–M6（2026-11-23）；验收记录见 `docs/archive/2026-11-23-modpack-authoring-and-tiered-transform.md`
- 相关：`packages/modcrafting-core/src/pack-model.ts`、`workspace-model.ts`、`packages/modcrafting-view/src/shell/`

## 1. 产品边界

ModCrafting 从「单个 Fabric 模组开发」扩展为「整合包创作、求解与导出工作台」。它**不是启动器**。

### 首版纳入

1. 用户想法 → 结构化意图 → Modrinth + CurseForge 双源检索 → 候选评分、覆盖度、缺口报告。
2. 通用底座（性能/画面/操作）的选择、按目标版本查可用性、装配。
3. 版本求解、依赖闭包、冲突检测、可复现锁文件。
4. 桥接 Mod 生成（首版仅 Fabric 工程）。
5. 第三方模组分级改造 L1–L4，带授权门。
6. 任务书（FTB Quests）编辑纳入整合包主线。
7. 导出 `.mrpack` 与 Prism/MultiMC 实例目录。

### 首版不纳入

- 内置启动器、账号、Java/资源下载管理。
- NeoForge/Forge 的自建工程与桥接脚手架；包层可以消费成品 jar。
- 自动发布到 Modrinth/CurseForge。
- 把反编译产物直接再编译分发（L4 只作为分析输入）。

### 已确认的产品决策

| 决策 | 选择 |
| --- | --- |
| 交付边界 | 只做创作与导出，启动交给现有启动器 |
| 数据源 | Modrinth + CurseForge 双源 |
| 改造红线 | 分级授权：L1/L2 默认可用，L3/L4 需许可证允许 + 用户逐次确认 |
| 加载器 | 包层支持 Fabric/NeoForge/Forge；自建与桥接首版仅 Fabric |
| 路线图骨架 | 依赖链里程碑，每个里程碑有可验收产物 |

## 2. 原则

1. **本地优先、确定性**：所有网络访问收敛到注册表适配层，带 TTL 缓存、限流、离线回放；`pnpm test` 永不联网。
2. **纯核心**：评分、覆盖度、求解、冲突判定是纯函数；I/O 只在边界。
3. **每个第三方 jar 可追溯**：来源、版本、哈希、许可证、是否可再分发。`redistributable=false` 的字节永不进入导出包。
4. **Agent 理解，核心计算**：Agent 产出 `packIntentSchema`；检索、打分、求解由核心确定性完成，选择显式落盘。
5. **不静默升级**：清单记「要什么」，锁文件记「怎么复现」；锁文件钉死版本与哈希。

## 3. 架构

### 3.1 核心模块

新增 `packages/modcrafting-core/src/pack/`，现有 `pack-model.ts` 保留并在 `index.ts` 继续导出：

```text
pack/
  pack-model.ts          已有：清单/锁/意图/候选/缺口/baseline schema
  registry-client.ts     HTTP + 缓存 + 限流 + UA + Key 管理 + 错误分类
  adapters/modrinth.ts   search / versions / 依赖归一化
  adapters/curseforge.ts 同上，需 API Key；缺 Key 时降级
  registry-normalize.ts  统一 RegistryProject / RegistryVersion / RegistryFile
  pack-discover.ts       纯：意图→查询、评分权重、覆盖度、缺口
  pack-solver.ts         纯：版本选择、依赖闭包、冲突发现、锁生成
  pack-workspace.ts      pack.json / pack.lock.json 读写、revision、事务
  pack-baseline.ts       底座配置 CRUD、按目标查可用性、装配、互斥校验
  pack-export.ts         .mrpack 写入 + Prism 实例写入
  bridge-scaffold.ts     Fabric 桥接工程生成
  transform/
    trust.ts             许可证/再分发/用户同意门
    zip.ts               最小 ZIP 读写（Node zlib + CRC32，无新依赖）
    l1-overlay.ts        资源/数据包覆盖
    l2-companion.ts      伴生 Mixin Mod（不改第三方字节）
    l3-bytecode.ts       字节码补丁（授权门 + 可回滚）
    l4-analysis.ts       反编译分析，产出补丁规格
```

### 3.2 统一注册表模型

两家 API 归一化为同一组结构，评分与求解只读归一化结果：

```ts
interface RegistryProject {
  registry: 'modrinth' | 'curseforge'
  projectId: string
  slug: string
  title: string
  description: string
  categories: string[]
  downloads: number
  updatedAt: string
  license: PackLicense
  environment: EnvironmentKind
  loaders: LoaderId[]
  gameVersions: string[]
}

interface RegistryVersion {
  registry: 'modrinth' | 'curseforge'
  projectId: string
  versionId: string
  name: string
  versionNumber: string
  gameVersions: string[]
  loaders: LoaderId[]
  channel: 'release' | 'beta' | 'alpha'
  publishedAt: string
  files: RegistryFile[]
  dependencies: RegistryDependency[]
  license: PackLicense
}

interface RegistryFile {
  fileName: string
  primary: boolean
  size: number
  hashes: { sha1?: string; sha512?: string }
  url: string | null       // null = 只能本地安装，不能写进导出包
}
```

### 3.3 数据流

```text
想法 → Agent 结构化 intent
     → discover（双源检索 + 评分 + 缺口）
     → 用户接受候选 → manifest.entries
     → baseline 选择 → 按目标查可用性 → 装配
     → solver（版本/依赖/冲突）→ lock + findings
     → 缺口/冲突转工作项：换候选 / 桥接 / L1–L4 改造
     → export（.mrpack / Prism 实例）
```

### 3.4 工作台

- `PANEL_IDS` 增加 `discover / pack / baseline / bridge / transform`。
- `PanelScope` 增加 `instance`；导航变为「工作区类型 → 面板组」两层。
- `App.tsx` 的 `if` 链替换为注册表渲染函数；三栏布局由 shell 统一提供。
- 面板只做展示与提交，逻辑通过 `/api/action` 与 MCP 工具复用同一套 core 函数。

### 3.5 MCP 工具

| 工具 | 职责 |
| --- | --- |
| `modcrafting_pack_discover` | 意图检索、评分、缺口报告、候选详情 |
| `modcrafting_pack_workspace` | pack.json / pack.lock.json 的读取、条目 CRUD、revision |
| `modcrafting_pack_solve` | 版本求解、依赖闭包、冲突、锁生成 |
| `modcrafting_pack_baseline` | 底座读写、可用性、装配 |
| `modcrafting_pack_export` | `.mrpack` / Prism 导出 |
| `modcrafting_bridge_scaffold` | 生成桥接工程 |
| `modcrafting_transform` | 检查、计划、应用、回滚 |

## 4. 里程碑

### M0 工作台导航骨架

**交付**：`PanelScope` 扩展、导航两层、注册表渲染函数、现有面板全部可达。

**验收**：
- mod 工作区看不到 modpack 专属面板，反之亦然。
- 现有 12 个面板与任务书仍可打开，`PanelHost` 状态隔离不变。
- `harness-panel-registry` 扩展并通过。

### M1 双源检索与缺口

**交付**：`registry-client`、两个适配器、`pack-discover`、Discover 面板、`modcrafting_pack_discover`。

**验收**：
- 无 CurseForge Key 时仍可用 Modrinth，返回明确修复指引。
- 同一意图、同一缓存内容产生字节一致的评分结果。
- 缺口报告给出 `missing` 与 `nearMiss`，覆盖度低于阈值时 `authorFromScratch` 有明确语义。
- 测试全部使用录制夹具，不联网。

### M2 底座与装配

**交付**：`pack-baseline`、Baseline 面板、`modcrafting_pack_baseline`。

**验收**：
- 选择 performance/visual/qol 后，按目标版本查询可用性；不可用项给出替代或明确说明。
- 玩法分类、纯服务端、互斥组合被拒绝并解释原因。
- NeoForge 目标不会硬塞 Fabric 专属 slug，使用可用替代或标记缺口。

### M3 求解、冲突与首个导出

**交付**：`pack-solver`、`pack-workspace`、`pack-export`、Pack 面板、三个 MCP 工具。

**验收**：
- 想法 → 清单 → 锁文件 → `.mrpack` 全链路可重复。
- 声明的 `incompatible`、缺失依赖、重复 modId、版本冲突都产生可操作 finding。
- `redistributable=false` 条目不内联字节；无法下载时导出给出明确警告。
- Prism 实例目录可被 Prism/MultiMC 识别。

### M4 桥接 Mod

**交付**：`bridge-scaffold`、Bridge 面板、`modcrafting_bridge_scaffold`。

**验收**：
- 生成一个可编译的 Fabric 桥接工程（入口点、mixin 配置、构建脚本）。
- 至少一个具体场景端到端：两个模组之间的事件/注册表适配。
- 生成物不修改第三方 jar。

### M5 分级改造

**交付**：`trust`、`zip`、L1–L4 模块、Transform 面板、`modcrafting_transform`。

**验收**：
- L1/L2 可对夹具 jar 生成覆盖包/伴生 Mod。
- L3/L4 在缺少许可证允许或用户同意时硬拒绝，并记录审计。
- 每次应用可回滚；`redistributable=false` 的产物不可导出。

### M6 布局与体验收口

**交付**：三栏布局系统、实例 scope、Discover/Pack/Baseline/Transform 面板视觉统一、空状态与错误态。

**验收**：
- 三个 scope 下所有面板可达，移动端可用。
- 不再有面板 `if` 链；新增面板只需注册表一项。
- `pnpm run typecheck`、`pnpm test`、`pnpm run plugin:smoke` 全绿。

## 5. 测试策略

- 每个纯模块一个 `scripts/test/harness-pack-*.test.ts`，由 `scripts/plugin/test.mjs` 显式列出。
- 网络夹具放在 `scripts/test/fixtures/registry/`，录制脚本单独提供、不进 CI。
- 适配器契约测试：同一夹具分别喂给 Modrinth/CurseForge 适配器，断言归一化结果一致。
- 导出验证：解包 `.mrpack` 校验 `modrinth.index.json`、文件路径、哈希与 `overrides/`。
- 不把离线 Smoke、真实 API 调用和游戏内验收混为同一结论。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| CurseForge API Key 与条款 | 适配器可选；缺 Key 明确降级；Key 只从环境/配置读，不入库 |
| API schema 漂移 | 适配器契约测试 + 录制夹具；错误分类保留原始响应摘要 |
| 许可证与再分发 | 保守授权门；`redistributable` 为假时只写引用；审计记录 |
| L3/L4 可行性 | M5 先做可行性 spike；默认推荐 L2 伴生 Mod |
| NeoForge 底座差异 | 底座按目标查询可用性，提供加载器替代项 |
| 双源导出限制 | `.mrpack` 允许 URL 引用；无法合法直链时退回本地 Prism 实例并警告 |
| 大包性能 | 检索分页、缓存、并发上限；求解纯函数可单测 |

## 7. 依赖关系

```text
M0 ── M1 ── M2 ── M3 ── M4 ── M5
                    └──── M6（可与 M4/M5 并行，最终收口）
```

M1 是其余能力的输入；M3 的首包是整条路线的第一个完整交付；M6 在功能面板齐备后统一视觉与导航。
