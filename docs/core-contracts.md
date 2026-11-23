# 独立 Core 业务与展示契约

契约版本：1，日期：2026-10-25。当前目标为 Windows x64 / Fabric 1.21.4。实现为 packages/modcrafting-core/src/contracts.ts、runtime.ts、sessions.ts、node.ts、game-test.ts；不依赖 Electron、MCP SDK、模型 API 或旧 Harness。

## 入口与状态所有者

一个后端由一个 FabricRuntime 持有构建、Minecraft 和测试任务及实例映射。MCP 负责注册/参数解析/响应包装，调用该 runtime；live Bench 已直接复用相同 Core 能力，可选界面后续接入。

同进程入口复用同一个 runtime 对象。跨进程入口需连接已有所有者，不能另建 runtime 并假定会共享任务状态。P3 的可选 loopback HTTP 服务直接接入 MCP 已有对象，浏览器不另建所有者；未实现 MCP Apps 或 WebSocket。启动见 [浏览器指南](./browser-view.md)。

浏览器只消费 contracts.ts 的数据类型与序列化响应，运行时留在 Node 后端。既有静态 Core 函数继续导出，不因抽取而破坏旧调用者。

| 业务 | Core 入口 | 主要结果 |
|---|---|---|
| 环境、资源与能力 | runtime.environmentStatus(projectPath?) | CoreEnvironmentStatus；contractVersion、paths、assets、capabilities；JavaStatus 含来源、候选和 configPath |
| 工具链选择 | runtime.toolchain({action, javaHome?, projectPath?}) | read/scan/write/clear；写入经探针验证的 JDK 21 并持久化 toolchain.json |
| 资源准备 | runtime.prepareAssets() | ok、assets[].ok/error/path、dataRoot、localAssets |
| 项目检查/创建/校验 | inspectFabricProject、scaffoldFabricProject、validateFabricProject；检查已有路径用 resolveProjectPath | FabricProject、checks、文件级 ProjectDiagnostic；脚手架不自动生成 Wrapper |
| 标准数据与知识 | lookupMinecraftData、searchFabricDocs、searchWiki | 结构化查询；缺失时返回 ASSET_NOT_READY 与可执行的 prepare_assets 提示；Wiki 当前为关键词索引查询 |
| 生物外观 | contentWorkspace 的 entity appearance、layoutEntityBoxes、generateContent | 基型皮肤或自定义方块模型；自动 UV、PNG 事务写入、生成 EntityModel/LivingEntityRenderer；3D 预览为近似效果 |
| 通用纹理 | textureWorkspace；GUI image 元素 | GUI 血条/Buff 图标/HUD 图片保存到 assets/<modid>/textures/gui；revision 与原子写入；GUI 代码按纹理 ID 绘制 |
| 会话生命周期 | createSession、readSession、resumeSession、updateSession、endSession | 持久化 sessionId；恢复时由单个 backend 独占 |
| 测试配置 | getTestProfile、setTestProfile | 版本化 TestProfile；默认仅写当前 session，显式选择后才写工程默认 |
| 构建 | runtime.startBuild(projectPath, task?, sessionId) | session 所有的 jobId；同工程排队、跨进程互斥 |
| 游戏运行与状态 | runClient、runtimeStatus、stopClient(sessionId) | session 专属实例、配置快照、准备 job；GameRuntimeStatus |
| 游戏观察与控制 | snapshot、entityQuery、widgets、entityNbt、command、input | BridgeResult；compact snapshot 默认省略配方/trace/物品指纹；只使用本地 Observer 的允许路径 |
| 截图 | runtime.screenshot(instanceId?, sessionId?)；MCP minecraft_screenshot | 默认 BridgeResult.data.path + 元数据；inline=true 才返回 base64；不是自动 PASS |
| 确定性测试 | startTest(spec, instanceId?, sessionId) | 等待该会话实例 canRunTests 后执行；jobId、scenarioId、按 session 保存的报告 |
| 任务日志与停止 | jobStatus、stopJob、close | JobSnapshot / CoreFailure、最近 300 条日志；只停止本 runtime 拥有的进程 |
| 可选视图状态 | runtime.state() | CoreRuntimeState，contractVersion=1，jobs 与 instances；无需 UI 持有另一份任务映射 |

当前插件注册 37 个工具（本地线 28 个 + PR #5 的工具链/GUI 纹理等，合并去重后实测）。`modcrafting_session` 创建、恢复、更新展示意图并结束会话；`modcrafting_test_profile` 读取/写入测试配置；`minecraft_test_template` 返回可用的 GameTestSpec 和真实输入 Schema；`modcrafting_targets` 以只读方式返回可构建的加载器 × Minecraft 版本矩阵、每个单元格的证据等级，以及单个目标的映射/Java 级别/资源目录解析结果；`modcrafting_toolchain` 读取/扫描/保存/清除 JDK 21 选择；`minecraft_snapshot` 默认返回精简观测，`minecraft_entity_query`/`minecraft_widgets`/`minecraft_entity_nbt` 提供定向读取；`minecraft_log_read` 分页读取长日志；`minecraft_screenshot` 默认只返回路径。`fabric_texture_workspace` 为 AI 物品贴图提供提示词包、PNG 导入、MC 像素化、质检、候选、revision 保存与内容绑定；它不调用任何图像模型。`fabric_gui_texture_workspace` 管理 GUI/HUD 纹理（PR #5 集成）。`fabric_voxel_workspace` 为 AI 3D 体素模型提供模板、校验、ASCII 预览与 revision 保存；宿主 Agent 只写紧凑的语义 DSL，编译全部在插件内确定性完成。`minecraft_build_studio` 通过随包建筑工作室组件打开/提交/应用结构，要求组件存在且测试世界就绪。构建、游戏、状态、停止、测试与报告访问都要求并校验 sessionId；省略实例时只在当前会话中选择，不再使用全局最近实例。响应继续包含 structuredContent 及其 JSON 文本，沿用 [MCP 结构化结果规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content)。

## 贴图工作区

`fabric_texture_workspace` 的动作是 `prompt`、`import`、`preview`、`read`、`list`、`save`、`bind`。`textureId` 必须为 `<modid>:item/<小写名称>`，目标文件为 `src/main/resources/assets/<modid>/textures/item/<name>.png`。首版源图只接受 PNG（本地 `sourcePath`、base64 或浏览器上传 token），上限 16MB / 4096×4096；输出支持 16/32/64，要求二进制 Alpha。

- `prompt` 只读，返回 prompt、负向词、目标路径、标准轮廓提示和检查清单；宿主 Agent 负责实际生图。
- `import` 保存 AI 源图与处理结果为 runtime 候选（`texture-library/<projectHash>/<name>/<candidateId>`），每个纹理最多 20 个。
- `preview` 只读；`analyzeOnly=true` 用于保存前校验当前画布像素，不重新量化。
- `save` 必须同时匹配当前 PNG 的 `expectedRevision` 和预览的 `previewRevision`；使用 `texture.lock`、备份和临时文件原子替换。硬性质检失败（尺寸、空图、半透明 Alpha、伪放大）拒绝保存；其他问题返回 warning。
- `bind` 读取 content 对象，设置 `texture` 后依次调用 content preview/save；内容 revision 不匹配时返回 `CONTENT_CONFLICT`，不绕过现有保护。
- 浏览器 POST `/api/texture-source` 接受 ≤8MB PNG 并受 Bearer token、backend、session 校验；普通 `/api/action` 仍限制 256KB。保存贴图后必须重建并重启 Minecraft，Observer 截图只作视觉证据。

## 体素模型工作区

`fabric_voxel_workspace` 的动作是 `template`、`list`、`read`、`validate`、`preview`、`save`；`validate` 纯函数校验，不需要 projectPath。DSL 存放在 content 对象的 `voxel` 字段（仅 block/item），随 `.modcrafting/content/<name>.json` 走统一的 revision / 冲突检查 / 备份回滚。

- `size` 每轴 1..32 且总体素 ≤32768；`palette` 1..26 个小写符号，值为 `#rrggbb` 或 `{color, pattern: flat|noise|checker, top?, side?, bottom?}`。
- `layers` 为按 Y 层的 RLE 字符串（`(\d{1,4})?[a-z.]`，`-` 为空层，x 优先，长度和必须等于 x*z）；`ops` 为 box 原语（from/to 闭区间、hollow、mirror x|z|xz），在 layers 之后按数组顺序求值。
- `optimize`：贪心合并 cuboid、调色板量化（0-8）、2×2×2 降采样、移除悬浮体素、cuboid 上限（默认 1500，≤4000，超出报 `VOXEL_TOO_COMPLEX`）。
- 编译产物：贪心合并后的 block model elements、`textures/block/<name>_atlas.png`（16px tile + 1px gutter，确定性噪声，字节级可复现）与 `<name>_particle.png`、1.21.4 `items/<id>.json` 定义。图片是受管二进制：ContentFile 用 `binary` + base64 传输，外部改写后对象转只读。
- 浏览器“模型”页提供 Three.js 体素画布（旋转/增设/涂色/擦除/镜像/锁定层/撤销重做）；含 `ops` 的对象只读展示，需显式“转为可编辑层”压平后才能编辑。保存后需重建并重启 Minecraft 才能看到新外观。

## 环境与资源语义

environmentStatus.ok 沿用系统工具链检查结果，不能解释为所有资源、游戏或验收已就绪。必须分别读取 assets、runtimeStatus.bridgeReady 和 `canRunTests`。JavaStatus 会报告选中的 JDK 来源（configured / modcrafting-env / java-home / path / discovered）、候选列表和可选配置路径；显式指向不存在的目录会失败，显式 JDK 版本不对时允许继续发现可用 JDK 21。`remediation` 会合并缺少知识资源的修复提示。

| 资源 | 当前消费路径，相对 runtime 数据根 |
|---|---|
| minecraft-data | knowledge/minecraft-data/1.21.4/index.json |
| Wiki 包 | knowledge/mc-wiki-zh/ |
| Wiki 关键词索引 | knowledge/mc-wiki-zh-index/chunks.json |
| Fabric 文档 | 优先旧 knowledge/agent-knowledge/fabric；否则 assets/agent-knowledge/fabric |
| Observer V2 | 当前插件包内经 SHA-256 校验的组件；启动时复制到 session 游戏目录。旧缓存不作为兼容来源 |

LocalAssetStatus.status 为 missing / present / invalid，缺失或无效时带 remediation。present 只证明本地文件与基本布局/JSON 形状存在，不认证资源来源、内容完整性、JAR 兼容性或知识查询结果；不能代替真实构建/Observer 验证。base-mods 只能通过完整插件包修复，不能靠资源下载。

Observer 来源与知识缓存分开。完整插件内置当前源码构建的 Observer V2，并于每次启动验证 SHA-256 后复制到会话游戏目录；知识资源准备不会下载/覆盖桥接组件。桥接握手成功也不代表测试世界就绪，继续读取独立准备状态。

runtime 构造和环境诊断不会下载或创建资源。MCP 启动仍沿用 P1 的数据目录可写检查，但不触发 prepareAssets。资源准备需显式调用，写入独立 dataRoot；同一 runtime 内并发请求合并为一次准备，避免既有 PID staging 冲突。

知识资源通过 `modcrafting_prepare_assets` 按需准备，下载失败时保留资源名和可操作原因。缺少知识资源时 `lookupMinecraftData`、`fabric_docs_search`、`searchWiki` 返回 ASSET_NOT_READY（坏 JSON 为 ASSET_INVALID）和精确的 prepare_assets 参数，不再返回 ok=true 的空结果。`fabric_docs_search` 按词分词并按命中数、词频和路径加权排序，返回 matchedTerms/searchedFiles；不再要求整句精确子串。Observer V2 独立随插件构建并校验 SHA-256；资源准备不下载或覆盖游戏桥接组件。资源压缩包解压使用相对路径调用 tar，兼容 Windows 上 GNU tar 对盘符的解析差异。

工具链来自系统 JDK 21 和工程 Wrapper，automaticDownload=false。JDK 解析顺序为 toolchain.json → MODCRAFTING_JAVA_HOME → JAVA_HOME → PATH → 常见安装目录扫描；显式坏路径不会被 PATH 静默掩盖。`modcrafting_toolchain write` 会实际执行候选 JDK 并检查 javac，成功后将绝对路径写入数据根的 toolchain.json，使系统 JAVA_HOME 过期时无需重启 Qoder。Core scaffold 默认不写 Wrapper；完整 MCP 包会注入仓库固定的 Windows Wrapper。资源准备不安装 JDK/Gradle；需要 Windows tar，Wrapper 与对应依赖由明确的工程环境提供。

## 任务、实例与错误

JobSnapshot 包含 id、kind、sessionId、status、startedAt、finishedAt、output、pid、result、error/code；没有 ChildProcess 对象。当前 kind 为 build / minecraft / minecraft_prepare / game_test，status 为 running / completed / failed / stopped / interrupted。

- completed 表示执行完成，不能当作游戏 PASS；测试需要读取 result.verdict、result.code、acceptance 和 cleanup。
- 客户端/构建非零退出为 failed，分别为 CLIENT_FAILED / BUILD_FAILED。
- stopped 表示停止请求已接受；进程终止和 callback 可能稍后结束，result.code=CANCELLED 区分主动停止。close 复用现有进程树停止机制，退出处理遵循 [Node 子进程 close 语义](https://nodejs.org/api/child_process.html#event-close)。
- interrupted 表示后端重启时旧任务仍未结束。任务/报告元数据保留，但不宣称旧子进程仍可由新后端控制。
- 缺失任务为 ok=false / JOB_NOT_FOUND；非法 Gradle 参数为 INVALID_ARGUMENT；缺路径为 PROJECT_UNAVAILABLE；缺系统工具链/Wrapper 为 ENVIRONMENT_UNAVAILABLE；缺基础模组为 ASSET_UNAVAILABLE。工具链写入的非法路径为 INVALID_ARGUMENT，不是 JDK 21 为 JDK21_REQUIRED，后端不支持配置/扫描为 ENVIRONMENT_UNAVAILABLE。
- `fabric_validate` 的 diagnostics 逐文件给出 error/warning，覆盖 1.21.4 版本、items 模型定义、模型 parent、纹理、blockstates、语言 JSON、配方目录和 Mixin 配置；`checks.resourceReferences` 以是否存在 error 级诊断为准。
- 缺实例为 INSTANCE_UNAVAILABLE；活跃或仍在停止回调中的实例占用相同 gameDirectory 时为 INSTANCE_CONFLICT；未运行或缺桥为 OBSERVER_UNAVAILABLE。启动前若发现残留 `modcrafting-bridge.json`，会检查端口是否仍在监听：已退出则重命名为 `.stale-<timestamp>` 后继续，仍在监听才返回 INSTANCE_CONFLICT；隔离失败返回 BRIDGE_STALE_CLEANUP_FAILED。未知内部失败为 JOB_FAILED 或保留 Node errno；MCP 的其他操作异常为 OPERATION_FAILED。

BridgeResult 保留 ok、HTTP status、data 与 error；查询失败还应读取 Observer data.code。CoreError 的 code 可直接供调用者分类，无需根据自然语言日志猜测。

GameRuntimeStatus 包含 instanceId、sessionId、projectPath、gameDirectory、jobId、preparationJobId、配置快照、bridgeReady、canRunTests、准备阶段/阻塞原因/当前界面和原始 Observer capabilities。桥接成功只代表通信正常；只有准备阶段 `test_ready` 且 `canRunTests=true` 才允许测试。BridgeDiscovery 的端口/token 不进入公开状态或报告；每次动作重新读取指定实例的发现文件，停止实例不能继续控制。准备总时限 300 秒，失败报告具体阶段、原因和恢复建议。

startTest 在启动时固定当前 session 的实例，避免另一任务将动作/报告切换到其他游戏。复制存档来源只读；Core 复制到 session 专用目录并写入归属标记，Observer 只在该副本内设置游戏模式、难度与命令开关。运行时修改 profile 不覆盖 options.txt，下一次启动时才应用。

## 场景、证据与能力

场景仍为 GameTestSpec version=2，严格校验后执行；报告摘要为 reportVersion=1。CoreCapabilities.contractVersion=1 是业务/展示契约版本，三种版本各自独立。

支持 inventory_contains、block_equals、entity_exists、entity_attribute、entity_name、entity_team、snapshot_value、snapshot_changed。实体属性断言使用 Observer 快照中的 health/maxHealth/attackDamage/movementSpeed；名称和队伍来自同一快照。live 标签过滤、HUD、command_result 与 trace 来源断言仍为能力不足。Observer 原始 capabilities 出现某字段，不表示 Core 已支持对应可信断言。

PASS 需要有效断言、独立新鲜快照及完整清理；观测不匹配为 FAIL；能力/环境/证据不足及清理失败为 INCONCLUSIVE。有效场景缺实例时，MCP 为兼容保留 ENVIRONMENT_UNAVAILABLE / INCONCLUSIVE；Core 直接调用通过 CoreError 细分原因。MCP `minecraft_test_start` 会在启动游戏任务前拒绝 HUD、command_result、trace、live entity tag 和 visualOnly 断言，分别返回 CAPABILITY_UNAVAILABLE / MANUAL_ACCEPTANCE_REQUIRED；Core `startTest` 与 live Bench 仍会执行这些场景并生成带 unavailable 证据的 INCONCLUSIVE 报告，不能把这种报告当作 PASS。`minecraft_command` 对 `execute if` 条件不成立返回 ok=true、condition=false，避免把正常未命中误报为命令失败。截图由 `minecraft_screenshot` 提供，只是人工验收证据；默认不内嵌 base64。

## 会话与工作台隔离

会话 JSON 和历史报告持久化在数据根；游戏数据保留于工程的 `run/modcrafting-fabric/sessions/<sessionId>`。后端实例通过 PID 锁独占接管会话。重启后确认旧 PID 已退出，运行任务标记 interrupted；锁恢复过程使用额外的恢复标记，避免两个后端同时接管。结束会话停止其所属作业，结束标记和报告保留。

同工程源码和可视化写回继续共享现有 revision/冲突保护；构建全局排队。同一工程运行游戏时，其他会话收到占用提示，不停止已有实例；不同工程可并行。实例目录必须在会话专属根下，job status/stop 和报告路径必须匹配 session。

Agent 可用 `modcrafting_session.update` 更新 phase、recommendedModules 和 currentModule。浏览器工作台采用侧栏导航和单一主区域；用户手动切换后暂停自动导航，重新启用“跟随 Agent”后恢复。内容/配方/GUI 编辑器草稿按 session/工程存于标签页，恢复前检查工程 revision，不自动保存。会话和 backend 标识用于路由，旧请求在切换时取消并丢弃迟到响应。

生物内容可带 `appearance`：`base` 模式绘制 64×32（猪）或 64×64（僵尸）基型 UV 纹理；`custom` 模式用最多 32 个方块部件描述几何，自动打包到 256×256（或用户指定方形）UV 纹理，并生成 `EntityModel`/`LivingEntityRenderer`。纹理 PNG 与生成文件在同一 content workspace 事务中写入，manifest 记录 PNG SHA-256；外部修改会让对象转为只读。自定义模型仍复用所选猪/僵尸基型的 AI、碰撞尺寸和实体属性；3D 预览只用于近似检查，最终以游戏内渲染为准。

## 浏览器工作台接入约定

最小界面读取项目/资源、任务日志、实例/桥状态、截图或报告产物及验收三态；必要操作调用 Core，不另建执行器。模型、对话和代码编辑由外部 Agent 承担。

截图和报告只由拥有它们的 session 读取；浏览器不能直接访问任意本地路径或桥端文件。工作台使用 Token 鉴权并复用 MCP 的 Core runtime；页面切换 session 时取消旧请求并丢弃迟到响应。模型、聊天和代码编辑由外部 Agent 承担。

项目通过 Agent 明确传入的工程绝对路径选择，不扫描或导入旧 Desktop 的项目目录、账户配置、聊天、报告或密钥。


MCP scaffold 使用构建时嵌入的 Windows Wrapper（Gradle 9.5.0 + 分发 SHA-256）。Core scaffold 可选注入 ProjectWrapper；完整候选包固定注入该 Wrapper。

## 多目标矩阵与证据等级

目标版本不再是常量。`packages/modcrafting-core/src/version/catalog.json` 由 `pnpm run versions:sync` 从 Mojang 版本清单、Fabric Meta、NeoForge maven（不可达时回退 launcher 镜像）与 Forge promotions 生成并签入仓库；`catalog.order` 是唯一的版本全序，因为 Minecraft 自 2026 年起同时存在 `1.21.11` 与 `26.1` 两套编号，字符串或数字比较都会出错。

三个正交投影决定生成结果。禁止在 codegen 里手写资源路径或 `net.minecraft.` 字面量，否则同一份生成器无法同时服务 Yarn 与 Mojmap 目标：

| 投影 | 随什么变 | 覆盖内容 |
|---|---|---|
| `ResourceLayout` | 仅 Minecraft | `recipe/recipes`、`loot_table(s)`、`tags/item(s)`、`assets/<ns>/items/` 物品模型定义、配方 result 形状 |
| `JavaApiProfile` | Minecraft + 映射 | Java 级别（17/21/25）、`new Identifier` vs `Identifier.of`、食物组件形态、Yarn 与 Mojmap 包名 |
| `LoaderPlatform` | 仅加载器 | entrypoint、注册风格、元数据文件 |

单元格的 `status` 是构建能力，`runtimeObserver` 是独立的运行能力：

| 状态 | 含义 | 证据上限 |
|---|---|---|
| `declared` | 上游存在该版本，构建工具链尚未验证 | codegen |
| `build-only` | 已通过编译探针，但没有可用的游戏内测试运行时；上游只有 beta 时同样封顶于此 | compile |
| `supported` | 编译与 Observer 游戏内测试均可用 | runtime |
| `unavailable` | 上游没有该加载器的这个版本 | none |
| `unknown` | 本次同步未覆盖（网络或镜像失败），保留上次已知值 | none |

因此「仅构建可验证」必须显式表达为 `build-only` 或 `declared`，不得对外声称支持。`versions:sync` 失败时不删除任何单元格，只写 `sync.stale` 与 `failures`；`versions:check` 仅在上游出现更新的正式版时失败，避免日常改动因上游发版变红。

## 资源方言与迁移

资源路径与资源 JSON 形状由 `packages/modcrafting-core/src/resources/layout.ts` 单独拥有，`resources/transform.ts` 是唯一出口；生成器与读取器都不得手写 `src/main/resources` 前缀（`version/resources-profile.ts` 只是兼容壳）。三个投影之外新增第四类知识：`RESOURCE_SHAPE_EVIDENCE` 记录哪些形状已用真实客户端资源证实，未证实的形状不会进入方言签名，也不会被当成事实输出。

内容清单是 v2：

```json
{ "version": 2, "target": { "loader": "fabric", "minecraft": "1.20.1" }, "dialect": "recipes|loot_tables|tags/items|advancements|none|object|item-object", "files": { "路径": "sha256" } }
```

`readManaged` 始终与清单里 **stored target** 的产物比对，而不是与当前工程目标比对，因此修改 `gradle.properties` 不会让已保存对象变成「外部篡改」。目标变化时返回 `requiresMigration: true` 并保持只读；只有显式 `action=migrate`（需 `confirm=true` 与 `expectedRevision`）才会按新目标重写与删除文件，删除项先备份到 `content-backups`，失败按逆序回滚。未知清单版本仍然拒绝。

配方读写按工程版本解析目录：读取目标目录优先、另一目录次之并给出 `inTargetDialect:false` 警告；保存只写目标目录；`migrate` 是**重写 JSON 字段方言**而不是移动字节，未知 serializer 保持只读。

知识数据按 Minecraft 版本发布，因此 `lookupMinecraftData` 与 `minecraft_data_lookup` 默认严格：该版本没有数据就返回 `KNOWLEDGE_VERSION_UNAVAILABLE` 并列出可用版本，不回退、不冒充。纹理缓存允许回退到最近可用版本，但必须返回 `exact:false` 与 `usedVersion`，并在文案里说明图标可能与游戏内不同。缓存标记 `.visuals-ready.json` 带版本校验，旧版本的标记不会被当作新版本已就绪。

1.21.4 的产物由 `scripts/test/golden/baseline.json` 钉死；`golden:update` 只重写代表形态与索引，拒绝覆盖基线。代表形态由方言签名自动推导，因此新增版本会自动落进正确的桶，新增方言维度会立刻分裂出新桶。

## 编译探针与工具链边界

`pnpm run probe:target --target fabric@1.21.4 [--record]` 是「可构建」的判定入口。它物化一个真实工程、用真实 Gradle 构建，并把证据写回 `release.build`（`evidence: probed`、`probedAt`、`javaMajor`）与 `probedAt`。证据必须和它证明的那个版本元组绑在一起，孤立的 `probed` 标志没有意义。

探针只证明**构建**。成功的编译会把单元格设为 `build-only`，绝不设为 `supported`——后者需要真正的游戏内测试，探针不跑游戏。非 Fabric 目标直接返回 `JAVA_DIALECT_PENDING`：Java 方言层（P4）未完成时构建必然失败，谎报可构建比拒绝更糟。

2026-11-16 实测得到两条硬约束：

1. **构建工具链属于产品，不属于目标。** maven 上最新的 fabric-loom 1.19.4 要求 Gradle ≥ 9.8.0，而仓库钉的是 9.5.0，按「每个目标用最新插件」会让构建因为与 Minecraft 无关的原因失败。因此 `materializeVersions()` 对**所有** Fabric 目标统一使用钉住的 Gradle 9.5.0 + Loom 1.17.12，目标只改变 Minecraft、loader、fabric-api 与 yarn。catalog 里的 `build` 仍记录上游最新值，用于回答「是否有更新」，不代表我们构建时用它。
2. **JDK 是目标属性。** 1.20.1 在 JDK 21 上可正常构建（`javaTarget: 17`，编译目标是 17），26.x 的 `javaTarget: 25` 必须 JDK 25。探针优先选与要求完全一致的 JDK，其次选更高的；找不到就返回 `JDK_MISSING` 并列出本机可用版本。

已验证的目标（Fabric 8/10）：`1.20.1`、`1.20.4`、`1.20.6`、`1.21.1`、`1.21.4`、`1.21.5`、`1.21.8`、`1.21.11`，全部用同一套 Gradle 9.5.0 + Loom 1.17.12 + JDK 21 真实编译，单次 137–345s。`26.1`/`26.3` 停在 `declared`，原因是双重的：需要 JDK 25，且 maven 最新 Loom 需要 Gradle ≥ 9.8——支持年份版本意味着引入第二套工具链，这是 P4 的决策点。NeoForge 因官方 maven 在本机不可达、且 Java 方言未适配而停在 `declared`。

## Java 方言层

生成器**始终输出 1.21.2+ 的现代形态**（`Identifier.of`、`RegistryKey` 注册、`settings.registryKey(...)`），由 `version/java-dialect.ts` 的确定性变换适配到老世代：老目标上 `Identifier.of` → `new Identifier`，注册回退为按 Identifier，`settings.registryKey(...)` 与内联的 `RegistryKey.of(...)` 被移除，无用 import 随之清除。现代目标上该变换是**逐字节 no-op**，1.21.4 的 golden 基线因此不受影响。

符号表里所有随世代变化的值都来自 `JavaApiProfile`，生成器不得手写 `net.minecraft.` 字面量。两处是**用真实 Yarn 映射查证**的（不是猜的，写错的直接后果就是编译失败）：

| 值 | ≤ 1.20.4 | ≥ 1.20.5 |
|---|---|---|
| `FoodComponent` 包 | `net.minecraft.item.FoodComponent` | `net.minecraft.component.type.FoodComponent` |
| Builder 的营养方法 | `hunger(int)` | `nutrition(int)` |

工具、护甲、生物的 Java 使用 1.21.2+ 的材质/渲染 API，老世代**直接拒绝**（`JAVA_DIALECT_UNSUPPORTED`），不假装兼容。探针加 `--content` 后会物化物品+方块+食物三个真实对象并编译——这是 Java 方言的判定标准：**编译通过才算数**。已验证：`fabric@1.20.1`（129s）与 `fabric@1.21.4`（202s）的生成内容均真实编译通过。

## 能力面：Agent 的通用入口

「这个目标能做什么」只在一处回答：`capabilitiesFor(target)`（`version/capabilities.ts`）。生成器拒绝、工程物化拒绝、构建探针、MCP 工具描述全部从这张表派生——`modcrafting_targets action=target` 直接返回它，Agent 在动手前一次查询就拿到完整边界，而不是靠撞四种不同的墙来学习同一个限制。

每项能力是 `available | blocked`，blocked 必须带 `reason`（为什么）和 `requirement`（什么能解锁它）。这张表是**架构通用、覆盖渐进**的体现：`fabric@26.3` 的内容能力是 available，但 build 会明确说 blocked，并给出 `requires: JDK 25；Gradle ≥ 9.8 与 Loom 1.19.4`；`neoforge@1.21.4` 的 createProject 是 blocked，理由是平台层未实现、路径是 `loaders/neoforge`。Agent 拿到的是可执行的计划，不是一个含糊的「不支持」。

通用性由**推导一致性测试**守住（`harness-capabilities.test.ts`）：整张矩阵上，能力表说的必须与代码做的逐格一致——内容能力对照全部 10 个 Fabric 里程碑 × 6 种类型的真实生成结果，物化能力对照全部 30 格的真实物化结果。未来任何人加一种类型、加一个 loader，只需要改这张表和它的实现，测试会立刻指出两边不一致的地方。

配套通用化：`fabric_project_scaffold` 接受 `minecraft` 参数（不再写死 1.21.4），内部走 `materializeProject`；`probe:target` 的 loader 判定也来自能力表。

### GUI 方言（已实现并编译证明）

`gui-codegen` 按 `JavaApiProfile.render` 输出两种绘制世代：1.21.2+ 用 `drawTexture(RenderLayer::getGuiTextured, …)` 与 `renderBackground(DrawContext, int, int, float)`；1.20.x 用无 RenderLayer 前缀的重载与 1 参 `renderBackground(DrawContext)`。两者的等价性不是猜的——用 `javap` 直接反编译两边映射后的真实 jar 确认：1.20.1 存在与现代调用**参数完全对位**的无前缀重载，`Screen.renderBackground` 则从 1 参变为 4 参。`Identifier` 差异由统一的 Java 方言变换处理。已验证：`fabric@1.20.1` 与 `fabric@1.21.4` 的生成内容（物品+方块+食物+GUI）均真实编译通过，GUI 能力对所有 Fabric 目标翻为 available。

### NeoForge 平台层（结构层已实现，编译验证待网络）

`loaders/neoforge.ts` 产出结构完整的 NeoForge 工程：ModDevGradle 构建（`neoForge { version = '21.4.161' }`，版本取自 catalog 的 `loaderVersion`）、`META-INF/neoforge.mods.toml`、`@Mod` 主类与**空的 `DeferredRegister.Items/Blocks` 容器**（内容层落地后注册进它们，而不是发明第二条注册路径）。`gradle.properties` 保留 `minecraft_version` 供全部下游工具读取——ModDevGradle 虽然自己推导 MC 版本，但布局、知识查询、能力表都读这个属性。

随之打通的三件事：`inspectFabricProject` 认得两种平台 metadata（`FabricProject.loader`），`capabilitiesFor` 把 neoforge 的 createProject 翻为 available（content/gui 仍 blocked，等 Mojmap 内容层），探针按能力表决定是否注入生成内容——neoforge 探针物化骨架后在 maven 闸门处诚实停下（`MAVEN_UNREACHABLE`），构建证据保持 `declared`，等一台能访问 NeoForge maven 的机器跑 probe 才翻 `probed`。

forge 的平台模块尚不存在，`loaders/forge` 是下一个 `requirement`。

### 26.x：工具链已就绪，卡在映射数据（上游）

2026-11-16 用真实探针把 26.3 逐层推进，结论是三条事实而非猜测：

1. **yarn 没有 26.x 构建**（`maven.fabricmc.net` 的 maven-metadata 实测），catalog 里原先的 `26.3+build.1` 是同步时编造的假数据，已改为 `mojmap` 并写明原因。
2. **生态侧别的都在**：fabric-loader 0.20.1 支持 26.3、`fabric-api 0.166.2+26.3` 存在、intermediary 存在——所以 26.x 走 Mojang 官方映射。
3. **第二套工具链本身可用**：JDK 25 + Gradle 9.8.0 + Loom 1.19.4 能完整跑到配置阶段，MC 26.1.2 的 153MB 客户端/服务端 jar 已下载。但 loom 的 `officialMojangMappings()` 报 `Failed to find official mojang mappings for 26.3`——**上游映射数据尚未覆盖**，不是我们的代码问题。

因此 26.x 的 build 保持 blocked，`requires` 里增加「26.x 映射方案待定」，并在 catalog 的 `reason` 记录两次探针的实证。等映射发布后重跑 `probe:target` 即可翻绿，工具链无需再动。

同时把映射差异接入能力面：`mappingKind !== yarn` 时内容与 GUI 一律 blocked（现有发射器是 Yarn 结构），避免 26.x 工程拿到编译不过的 Java。

### golden 的部分产出模型

26.x 的内容被拒但**配方照常产出**（配方与映射无关）。golden 因此区分两类单元格：完整映射的与代表形态逐字节相等；`partial` 单元格只保证「已产出的文件与之逐字节相等」——"更少文件"可以，"不同的文件"不行。索引升级到 schemaVersion 2 并记录每个 partial 单元格的原因。

## 批量探针与 CI 验证通道

单格探针只能证明一格，而内容发射器（Mojmap、NeoForge DeferredRegister）需要的是**快速反馈回路**——本机既到不了 NeoForge maven，也拿不到 26.x 映射，所以在这台机器上盲写 Java 等于自审自证。因此新增：

- `pnpm run probe:all`（`scripts/probe/all.mjs`）：按能力表遍历整张矩阵，逐格调用 `probe:target`，输出一行一格的结果与汇总；`--list` 只打印计划，用于确认「哪格为什么不可做」。
- **已知阻塞不算失败**：能力表已声明 blocked 的格（缺 JDK、缺上游映射）即使构建失败也记 `BLOCKED_AS_EXPECTED`，退出码只由**真实失败**决定。这样 CI 不会因为「上游还没发布」而长期红着，红就是真有回归。
- `.github/workflows/probe.yml`：ubuntu + JDK 21/25 + Gradle 缓存，按需或每周跑一次，产物上传 `probe-summary.json` 与各格构建日志。

写 Mojmap / DeferredRegister 发射器的正确顺序因此是：**先在 CI 上跑通对应的探针格，再写发射器，用探针验证**——而不是先写 200 行 Java 再赌它对。

### NeoForge 内容发射器（item）

`loaders/neoforge-content.ts` 产出 Mojmap + `DeferredRegister` 的 Java，与 Fabric 的静态 `Registry.register` 是两套并行的发射器，由 `(loader, mappingKind)` 选择，而不是在模板里加分支。

两条设计约束：

1. **注册归属在内容类**：每个内容类持有自己的 `DeferredRegister` 并暴露 `register(IEventBus)`；`ContentIndex` 是唯一的聚合点，`@Mod` 构造函数只调用它。这样新增内容永远不需要手改 `Main.java`，注册顺序也是确定的。
2. **按对象分包**：`modcrafting.generated.<mod>.o_<name>.content.ModItems`——两个物品若共用一个包会写同一个文件，第二个会覆盖第一个。测试专门覆盖这条。

`ContentIndex.java` 由工作区在每次保存时从 `.modcrafting/content/*.json` 全量重生成：它是内容集合的纯函数，可重复、可校验；`readManaged` 对这个文件做「注册是否还在」的校验，被外部改动就报只读而不是静默覆盖。

能力面按类型逐个翻：NeoForge 的 item 为 available，block/food/tool/armor/entity 仍 blocked 且 reason 指明「item 先验证」。**编译验证仍在 CI**：本机到不了 NeoForge maven，形状由单测钉住，等 `probe:target --target neoforge@1.21.4` 通过后才算证明。

### Forge 平台层与第三套工具链

`loaders/forge.ts` 产出结构完整的 Forge 工程，与 NeoForge 的差异都是硬差异、不是风格差异：ForgeGradle 取代 ModDevGradle、`META-INF/mods.toml` 取代 `neoforge.mods.toml`（依赖字段是 `mandatory` 而非 `type`）、事件总线取 `FMLJavaModLoadingContext`。ForgeGradle 只发布在 `maven.minecraftforge.net`，所以 `settings.gradle` 必须自带 `pluginManagement` 仓库——少了它插件根本解析不到（探针实测）。

**第三套工具链**：ForgeGradle 6 明确拒绝 Gradle 9.x（"Versions Gradle 9.0 and newer are not supported yet"，探针实测），因此 Forge 目标使用 Gradle 8.10.2 + JDK 17。`materializeVersions` 现在有三条分支：内置（9.5.0/Loom 1.17.12）、26.x（9.8.0/Loom 1.19.4）、forge（8.10.2/ForgeGradle 6）。三条都是被上游约束逼出来的，不是偏好。

`inspectFabricProject` 同步识别第三种平台元数据（`mods.toml` → `loader: 'forge'`）。至此矩阵里 **blocked 归零**：每个 loader 都有平台模块，剩下的都是「已声明待验证」。

Forge 的构建验证尚未完成：本机首次 ForgeGradle 初始化在 40 分钟内没有进入配置阶段（三个依赖源均可访问），属于本机环境下的异常缓慢，交由 CI 用更长窗口验证。

### Forge 内容发射器

`loaders/forge-content.ts`：Mojmap 映射 + Forge 注册 API。与 NeoForge 的差别是**注册层**而非映射层——Forge 用无类型的 `DeferredRegister.create(ForgeRegistries.ITEMS, MOD_ID)` 与 `RegistryObject<T>`，NeoForge 用 `DeferredItem`/`registerSimpleItem` 这类类型化辅助。所以是两份发射器，不是一份带开关。

两块共用的约定：内容类自持注册器并暴露 `register(IEventBus)`，`ContentIndex` 聚合。区别只在 `ContentIndex` 的总线类型：NeoForge 是 `net.neoforged.bus.api.IEventBus`，Forge 是 `net.minecraftforge.eventbus.api.IEventBus`——由 `neoForgeContentIndex(..., busImport)` 参数注入，测试专门断言不会把 NeoForge 的类型写进 Forge 工程。

### MCP 脚手架工具支持三种 loader

`fabric_project_scaffold` 增加 `loader` 参数（`fabric` 默认 / `neoforge` / `forge`）。此前能力表说 neoforge/forge 可建，但工具只接受 `minecraft`——Agent 实际上建不出来，属于「能力面与工具面不一致」。现在两端一致：同一份 `resolveTarget(loader, minecraft)` 决定元数据文件、构建工具链与 Java 级别。
