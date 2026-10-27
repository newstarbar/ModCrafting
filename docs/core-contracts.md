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

当前插件注册 36 个工具（本地线 28 个 + PR #5 的工具链/GUI 纹理等，合并去重后实测）。`modcrafting_session` 创建、恢复、更新展示意图并结束会话；`modcrafting_test_profile` 读取/写入测试配置；`minecraft_test_template` 返回可用的 GameTestSpec 和真实输入 Schema；`modcrafting_toolchain` 读取/扫描/保存/清除 JDK 21 选择；`minecraft_snapshot` 默认返回精简观测，`minecraft_entity_query`/`minecraft_widgets`/`minecraft_entity_nbt` 提供定向读取；`minecraft_log_read` 分页读取长日志；`minecraft_screenshot` 默认只返回路径。`fabric_texture_workspace` 为 AI 物品贴图提供提示词包、PNG 导入、MC 像素化、质检、候选、revision 保存与内容绑定；它不调用任何图像模型。`fabric_gui_texture_workspace` 管理 GUI/HUD 纹理（PR #5 集成）。`fabric_voxel_workspace` 为 AI 3D 体素模型提供模板、校验、ASCII 预览与 revision 保存；宿主 Agent 只写紧凑的语义 DSL，编译全部在插件内确定性完成。`minecraft_build_studio` 通过随包建筑工作室组件打开/提交/应用结构，要求组件存在且测试世界就绪。构建、游戏、状态、停止、测试与报告访问都要求并校验 sessionId；省略实例时只在当前会话中选择，不再使用全局最近实例。响应继续包含 structuredContent 及其 JSON 文本，沿用 [MCP 结构化结果规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content)。

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
