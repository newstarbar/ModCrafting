# 独立 Core 业务与展示契约

契约版本：1，日期：2026-10-18。当前目标为 Windows x64 / Fabric 1.21.4。实现为 packages/modcrafting-core/src/contracts.ts、runtime.ts、sessions.ts、node.ts、game-test.ts；不依赖 Electron、MCP SDK、模型 API 或旧 Harness。

## 入口与状态所有者

一个后端由一个 FabricRuntime 持有构建、Minecraft 和测试任务及实例映射。MCP 负责注册/参数解析/响应包装，调用该 runtime；live Bench 已直接复用相同 Core 能力，可选界面后续接入。

同进程入口复用同一个 runtime 对象。跨进程入口需连接已有所有者，不能另建 runtime 并假定会共享任务状态。P3 的可选 loopback HTTP 服务直接接入 MCP 已有对象，浏览器不另建所有者；未实现 MCP Apps 或 WebSocket。启动见 [浏览器指南](./browser-view.md)。

浏览器只消费 contracts.ts 的数据类型与序列化响应，运行时留在 Node 后端。既有静态 Core 函数继续导出，不因抽取而破坏旧调用者。

| 业务 | Core 入口 | 主要结果 |
|---|---|---|
| 环境、资源与能力 | runtime.environmentStatus(projectPath?) | CoreEnvironmentStatus；contractVersion、paths、assets、capabilities 与原工具链字段 |
| 资源准备 | runtime.prepareAssets() | ok、assets[].ok/error/path、dataRoot、localAssets |
| 项目检查/创建/校验 | inspectFabricProject、scaffoldFabricProject、validateFabricProject；检查已有路径用 resolveProjectPath | FabricProject、检查项；脚手架不自动生成 Wrapper |
| 标准数据与知识 | lookupMinecraftData、searchFabricDocs、searchWiki | 已有结构化查询/命中/缺失诊断；Wiki 当前为关键词索引查询 |
| 会话生命周期 | createSession、readSession、resumeSession、updateSession、endSession | 持久化 sessionId；恢复时由单个 backend 独占 |
| 测试配置 | getTestProfile、setTestProfile | 版本化 TestProfile；默认仅写当前 session，显式选择后才写工程默认 |
| 构建 | runtime.startBuild(projectPath, task?, sessionId) | session 所有的 jobId；同工程排队、跨进程互斥 |
| 游戏运行与状态 | runClient、runtimeStatus、stopClient(sessionId) | session 专属实例、配置快照、准备 job；GameRuntimeStatus |
| 游戏观察与控制 | snapshot、command、input | BridgeResult；只使用本地 Observer 的允许路径 |
| 截图 | runtime.screenshot(instanceId?) | BridgeResult.data.path；本阶段仅 Core API，未增加 MCP 截图工具 |
| 确定性测试 | startTest(spec, instanceId?, sessionId) | 等待该会话实例 canRunTests 后执行；jobId、scenarioId、按 session 保存的报告 |
| 任务日志与停止 | jobStatus、stopJob、close | JobSnapshot / CoreFailure、最近 300 条日志；只停止本 runtime 拥有的进程 |
| 可选视图状态 | runtime.state() | CoreRuntimeState，contractVersion=1，jobs 与 instances；无需 UI 持有另一份任务映射 |

当前插件提供 28 个工具。`modcrafting_session` 创建、恢复、更新展示意图并结束会话；`modcrafting_test_profile` 读取/写入测试配置；`minecraft_test_template` 返回可用的 GameTestSpec 和真实输入 Schema。`fabric_texture_workspace` 为 AI 物品贴图提供提示词包、PNG 导入、MC 像素化、质检、候选、revision 保存与内容绑定；它不调用任何图像模型。`fabric_voxel_workspace` 为 AI 3D 体素模型提供模板、校验、ASCII 预览与 revision 保存；宿主 Agent 只写紧凑的语义 DSL，编译全部在插件内确定性完成。`minecraft_build_studio` 通过随包建筑工作室组件打开/提交/应用结构，要求组件存在且测试世界就绪。构建、游戏、状态、停止、测试与报告访问都要求并校验 sessionId；省略实例时只在当前会话中选择，不再使用全局最近实例。响应继续包含 structuredContent 及其 JSON 文本，沿用 [MCP 结构化结果规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content)。

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

environmentStatus.ok 沿用系统工具链检查结果，不能解释为所有资源、游戏或验收已就绪。必须分别读取 assets、runtimeStatus.bridgeReady 和 `canRunTests`。

| 资源 | 当前消费路径，相对 runtime 数据根 |
|---|---|
| minecraft-data | knowledge/minecraft-data/1.21.4/index.json |
| Wiki 包 | knowledge/mc-wiki-zh/ |
| Wiki 关键词索引 | knowledge/mc-wiki-zh-index/chunks.json |
| Fabric 文档 | 优先旧 knowledge/agent-knowledge/fabric；否则 assets/agent-knowledge/fabric |
| Observer V2 | 当前插件包内经 SHA-256 校验的组件；启动时复制到 session 游戏目录。旧缓存不作为兼容来源 |

LocalAssetStatus.status 为 missing / present / invalid。present 只证明本地文件与基本布局/JSON 形状存在，不认证资源来源、内容完整性、JAR 兼容性或知识查询结果；不能代替真实构建/Observer 验证。

Observer 来源与知识缓存分开。完整插件内置当前源码构建的 Observer V2，并于每次启动验证 SHA-256 后复制到会话游戏目录；知识资源准备不会下载/覆盖桥接组件。桥接握手成功也不代表测试世界就绪，继续读取独立准备状态。

runtime 构造和环境诊断不会下载或创建资源。MCP 启动仍沿用 P1 的数据目录可写检查，但不触发 prepareAssets。资源准备需显式调用，写入独立 dataRoot；同一 runtime 内并发请求合并为一次准备，避免既有 PID staging 冲突。

知识资源通过 `modcrafting_prepare_assets` 按需准备，下载失败时保留资源名和可操作原因。Observer V2 独立随插件构建并校验 SHA-256；资源准备不下载或覆盖游戏桥接组件。

工具链来自系统 JDK 21 和工程 Wrapper，automaticDownload=false。Core scaffold 默认不写 Wrapper；完整 MCP 包会注入仓库固定的 Windows Wrapper。资源准备不安装 JDK/Gradle；需要 Windows tar，Wrapper 与对应依赖由明确的工程环境提供。

## 任务、实例与错误

JobSnapshot 包含 id、kind、sessionId、status、startedAt、finishedAt、output、pid、result、error/code；没有 ChildProcess 对象。当前 kind 为 build / minecraft / minecraft_prepare / game_test，status 为 running / completed / failed / stopped / interrupted。

- completed 表示执行完成，不能当作游戏 PASS；测试需要读取 result.verdict、result.code、acceptance 和 cleanup。
- 客户端/构建非零退出为 failed，分别为 CLIENT_FAILED / BUILD_FAILED。
- stopped 表示停止请求已接受；进程终止和 callback 可能稍后结束，result.code=CANCELLED 区分主动停止。close 复用现有进程树停止机制，退出处理遵循 [Node 子进程 close 语义](https://nodejs.org/api/child_process.html#event-close)。
- interrupted 表示后端重启时旧任务仍未结束。任务/报告元数据保留，但不宣称旧子进程仍可由新后端控制。
- 缺失任务为 ok=false / JOB_NOT_FOUND；非法 Gradle 参数为 INVALID_ARGUMENT；缺路径为 PROJECT_UNAVAILABLE；缺系统工具链/Wrapper 为 ENVIRONMENT_UNAVAILABLE；缺基础模组为 ASSET_UNAVAILABLE。
- 缺实例为 INSTANCE_UNAVAILABLE；活跃或仍在停止回调中的实例占用相同 gameDirectory 时为 INSTANCE_CONFLICT；未运行或缺桥为 OBSERVER_UNAVAILABLE。未知内部失败为 JOB_FAILED 或保留 Node errno；MCP 的其他操作异常为 OPERATION_FAILED。

BridgeResult 保留 ok、HTTP status、data 与 error；查询失败还应读取 Observer data.code。CoreError 的 code 可直接供调用者分类，无需根据自然语言日志猜测。

GameRuntimeStatus 包含 instanceId、sessionId、projectPath、gameDirectory、jobId、preparationJobId、配置快照、bridgeReady、canRunTests、准备阶段/阻塞原因/当前界面和原始 Observer capabilities。桥接成功只代表通信正常；只有准备阶段 `test_ready` 且 `canRunTests=true` 才允许测试。BridgeDiscovery 的端口/token 不进入公开状态或报告；每次动作重新读取指定实例的发现文件，停止实例不能继续控制。准备总时限 300 秒，失败报告具体阶段、原因和恢复建议。

startTest 在启动时固定当前 session 的实例，避免另一任务将动作/报告切换到其他游戏。复制存档来源只读；Core 复制到 session 专用目录并写入归属标记，Observer 只在该副本内设置游戏模式、难度与命令开关。运行时修改 profile 不覆盖 options.txt，下一次启动时才应用。

## 场景、证据与能力

场景仍为 GameTestSpec version=2，严格校验后执行；报告摘要为 reportVersion=1。CoreCapabilities.contractVersion=1 是业务/展示契约版本，三种版本各自独立。

支持 inventory_contains、block_equals、entity_exists、snapshot_value、snapshot_changed。实体查询半径 32、上限 64；live 标签过滤、HUD、command_result 与 trace 来源断言仍为能力不足。Observer 原始 capabilities 出现某字段，不表示 Core 已支持对应可信断言。

PASS 需要有效断言、独立新鲜快照及完整清理；观测不匹配为 FAIL；能力/环境/证据不足及清理失败为 INCONCLUSIVE。有效场景缺实例时，MCP 为兼容保留 ENVIRONMENT_UNAVAILABLE / INCONCLUSIVE；Core 直接调用通过 CoreError 细分原因。

## 会话与工作台隔离

会话 JSON 和历史报告持久化在数据根；游戏数据保留于工程的 `run/modcrafting-fabric/sessions/<sessionId>`。后端实例通过 PID 锁独占接管会话。重启后确认旧 PID 已退出，运行任务标记 interrupted；锁恢复过程使用额外的恢复标记，避免两个后端同时接管。结束会话停止其所属作业，结束标记和报告保留。

同工程源码和可视化写回继续共享现有 revision/冲突保护；构建全局排队。同一工程运行游戏时，其他会话收到占用提示，不停止已有实例；不同工程可并行。实例目录必须在会话专属根下，job status/stop 和报告路径必须匹配 session。

Agent 可用 `modcrafting_session.update` 更新 phase、recommendedModules 和 currentModule。浏览器工作台采用侧栏导航和单一主区域；用户手动切换后暂停自动导航，重新启用“跟随 Agent”后恢复。内容/配方/GUI 编辑器草稿按 session/工程存于标签页，恢复前检查工程 revision，不自动保存。会话和 backend 标识用于路由，旧请求在切换时取消并丢弃迟到响应。

## 浏览器工作台接入约定

最小界面读取项目/资源、任务日志、实例/桥状态、截图或报告产物及验收三态；必要操作调用 Core，不另建执行器。模型、对话和代码编辑由外部 Agent 承担。

截图和报告只由拥有它们的 session 读取；浏览器不能直接访问任意本地路径或桥端文件。工作台使用 Token 鉴权并复用 MCP 的 Core runtime；页面切换 session 时取消旧请求并丢弃迟到响应。模型、聊天和代码编辑由外部 Agent 承担。

项目通过 Agent 明确传入的工程绝对路径选择，不扫描或导入旧 Desktop 的项目目录、账户配置、聊天、报告或密钥。


MCP scaffold 使用构建时嵌入的 Windows Wrapper（Gradle 9.5.0 + 分发 SHA-256）。Core scaffold 可选注入 ProjectWrapper；完整候选包固定注入该 Wrapper。
