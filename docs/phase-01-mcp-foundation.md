# ModCrafting 第一阶段开发执行文档：独立 MCP 底座与可信交付基线

> 状态：待 Codex 实施；本文件是可执行任务书，而不是已完成记录。
> 编写日期：2026-10-12
> 原工作区：`<workspace>\ModCrafting`；P1 实施工作区：`<workspace>\ModCrafting-mcp-p1`（完成 P0 后创建）
> 阶段编号：P1 / MCP Foundation
> 目标读者：Codex（在本仓库根目录打开后直接执行）
> 主线：Core / MCP / Agent 扩展优先；Desktop 进入维护模式；不在本阶段开发新的游戏内 AI Mod。

> **实施前置条件（P0 + P0.5）**：必须先阅读并执行 [`docs/phase-00-git-safety.md`](./phase-00-git-safety.md) 与 [`docs/phase-00-pnpm-worktree.md`](./phase-00-pnpm-worktree.md)，先完成 Git 安全隔离，再在新 Worktree 内迁移 pnpm 并验证依赖/构建基线。未经用户明确授权，不得执行远端 `git push`；P1 所有改动只在 `feat/mcp-foundation-p1` 分支实施。若 P0 或 P0.5 未完成，停止 P1 业务代码修改并报告阻塞。

## 0. 给 Codex 的任务总令

你是负责实际实施的工程师。本阶段只完成**独立 MCP 产品化与可靠性基线**，不要扩展为整个 ModCrafting 转型项目。先勘察后改动，优先复用已有源码、脚本、MCP SDK 和构建管线；每个子任务保持最小变更并执行对应验证。任务不是“开发更多 Agent 功能”，而是让现有 MCP 插件能脱离仓库和 Electron 可靠运行、能够证明真实协议交互，并且不会给出无证据的游戏测试 PASS。

**必须完成**：独立交付目录、真实 MCP 协议烟测、游戏测试断言失效保护、基本 Codex 使用说明、独立 CI、阶段验收报告。

**严禁在本阶段完成**：重写 Pi/Harness、删除 Electron、引入新的模型 API/Agent Loop、开发 Minecraft 陪伴 Mod、开发 Web Dashboard/MCP Apps、同时兼容六个 Agent、增添大量 MCP 工具、改造 Fabric 版本矩阵、改动 Observer 的游戏逻辑、真实发布到 npm/GitHub。

**执行边界**：
1. 不自动运行 `git pull`、`git reset`、`git clean`、`git checkout`、`git rebase`、`git push`、`npm publish`、`release:publish`；不得覆盖用户未跟踪文件。
2. 不修改、读取或输出 `.env`、API Key、Token、账户配置；不得上传本地数据或日志。
3. 开发测试创建的文件只允许写入明确指定的隔离临时目录，清理时只清理本次测试专有目录。
4. 禁止把“启动成功”“工具注册成功”“构建成功”当成“游戏功能验收 PASS”。
5. 若发现现有主分支有其他并行改动或测试基线失败，先记录现状，继续仅与本阶段直接相关的改动；禁止顺便修复大量旧问题。
6. 只修改必要文件，严格遵循 `AGENTS.md`（尤其维护红线、文档归档、发布限制）；不要自行提交或发布。

## 1. 为什么第一阶段选这个方向

### 1.1 转型目标

长期架构应为：

```text
Codex / Claude / Qoder / TRAE / WorkBuddy / DSH
                  |
         [安装/插件适配层]
                  |
             MCP 接口
                  |
      ModCrafting Core（Node）
                  |
   Fabric 知识 / 构建 / Observer / 验收
                  |
         Minecraft 运行环境

可选入口：Minecraft In-Game Mod / Web Dashboard / MCP Apps
旧 Desktop：兼容与维护，不再主导能力设计
```

本阶段仅交付图中的 **MCP 接口 + Core 独立运行基线 + Codex 现有插件闭环**。不要为了未来可能出现的多个 Agent 平台提前设计复杂抽象。

### 1.2 已核查的仓库事实（2026-10-12）

| 项目 | 当前事实 | 本阶段含义 |
|---|---|---|
| Git | `main`，HEAD `b40e1fa`，本地落后 `origin/main` 2 个提交 | 实施前重新查看状态；不要擅自拉取/重置 |
| 未跟踪文件 | `failures.txt`、`failures_after.txt`、`failures_before.txt`、`test_output.txt`、`test_output_with_changes.txt` | 不触碰、不删除、不纳入提交 |
| MCP 插件 | `plugins/modcrafting-fabric/src/mcp-server.ts`，已有 19 个工具 | 复用，不从零写第二个 Server |
| 共享基础 | `packages/modcrafting-core/src/{domain,node,index}.ts` | 继续保持运行逻辑与宿主分离 |
| Codex 插件 | `.codex-plugin/plugin.json` + `.mcp.json` + 两个 Skill | 保持旧清单可用，别随意破坏现有安装形式 |
| 构建 | `scripts/plugin/build.mjs` 产出自包含 `dist/mcp-server.js` | 以该产物为独立交付基础 |
| 校验 | `npm run plugin:validate` 在检查时通过 | 只有清单/目录级校验，不代表协议可调用 |
| 旧自测 | `node plugins/modcrafting-fabric/dist/mcp-server.js --self-test` 输出 19 tools | 自测返回硬编码计数，不能作为真实 MCP 协议验收 |
| 隔离测试 | `scripts/plugin/test.mjs` 将插件复制到 `temp/plugin-isolation` 再运行自测 | 应升级为真实协议连通与工具调用测试 |
| 版本与平台 | 目前核心目标为 MC 1.21.4、Windows x64、JDK 21 | 暂不承诺跨版本或跨 OS 的完整游戏运行 |
| 原 Harness | `src/renderer/src/harness` + `src/main` | 不删除；只保持回归可用 |
| 旧测试能力 | 插件内 `minecraft_test_start` 的断言实现比 Desktop 简化 | 必须防止伪 PASS，并如实声明能力边界 |

已有`AGENTS.md` 及 `docs/archive/2026-10-05-harness-repeated-failure-root-causes.md` 对死锁、证据问题有详细记录；本阶段不要把这些现象重新包装成一个新的 Agent Loop。

### 1.3 本阶段成功定义

一个用户或开发者从干净目录获得 ModCrafting 插件交付文件后：
- 不安装、不运行 Electron Desktop，也不需要整个 Git 仓库源代码；
- 只安装支持版本的 Node.js，完成 MCP 初始化、发现工具、调用基础只读工具；
- 当 Java/JDK、Gradle、知识库、Minecraft、Observer 缺失时，返回可解释的环境诊断，而不是挂起、崩溃或假 PASS；
- 在有 Fabric 环境时可沿现有工具调用链启动构建/游戏测试；
- 任何不具备客观证据的游戏测试不能返回 PASS；
- Codex 既能找到插件技能和工具，也能获得明确的手工安装说明；
- 对上述最低能力，有自动测试和 CI 门禁。

## 2. 总体工程原则

1. **单一业务实现**：所有实际 Fabric / MC 业务能力尽量落在 `packages/modcrafting-core`；`plugins/modcrafting-fabric` 仅承担 MCP 注册、参数转换与生命周期。
2. **不写第二套 Harness**：MCP 工具是给宿主 Agent 使用的，不要在插件中加入模型 API、无限修复循环、复杂规划器和多模型角色路由。
3. **协议真实测试**：不要再用 `--self-test` 模拟工具调用成功；必须通过真实 stdio JSON-RPC / MCP Client 发起请求。
4. **验收保守**：未支持/证据缺失/断言字段非法 → INVALID_SPEC 或 INCONCLUSIVE；观察到功能不符合要求 → FAIL；只有有可核对证据才 PASS。
5. **权限最小**：本阶段不开启任意远程 TCP 监听，不扩大游戏命令权限，不扫描个人目录，不自动修改用户真实世界。
6. **依赖克制**：先用现有 MCP SDK、Node 核心库、已有脚本；新依赖必须说明必要性。
7. **稳定兼容**：尽量保留已有 19 工具名称及成功响应结构；改动不正确的 PASS 行为属于明确的安全修复，需要写测试与迁移说明。
8. **隔离交付**：交付文件不可隐式依赖仓库相对路径、`src`、`node_modules`、`.env`、`resources` 中的私有本地缓存。

## 3. 阶段任务与实施顺序

按 `P1-01 → P1-02 → P1-03 → P1-04 → P1-05 → P1-06` 顺序实施。每个任务完成后做最小测试，再进入下一个。遇到回归时先修当前任务，不得跳过并继续堆叠改动。

### P1-01：冻结旧 Harness 功能扩张，并明确架构边界

**建议文件**：`docs/architecture.md`、`docs/harness.md`、`AGENTS.md`（仅在行数限制允许时增加简短索引）；必要时新建 `docs/agent-integration-boundaries.md`。

**动作**：
- 在文档中明确：Desktop 为既有用户提供兼容维护；新业务优先以 Core / MCP 暴露。
- 现有 `Agent`、`Controller`、`WorkflowEngine` 只做必要缺陷修复，不增加新模型路由、角色编排或工具数量。
- 明确 `scripts/mcp/modcrafting-test-mcp.ts` 是开发测试用的 Electron Test Lab MCP，不是用户安装的 `plugins/modcrafting-fabric` 插件；两者不可混淆。
- 给出未来 `In-Game Mod → Gateway → Core/MCP` 的接口方向，但不创建空壳工程。
- 如果修改 `AGENTS.md`，保持总行数 ≤150；详细说明放到 `docs/`。
- 将阶段文档加入 `docs/README.md` 文档导航（如适用）。

**完成条件**：任何工程师都能解释“新功能写在哪里、不应该写在哪里”，且旧 Desktop 功能不受影响。

### P1-02：正式确定插件可独立部署的目录与运行方式

**建议文件**：`scripts/plugin/build.mjs`、`scripts/plugin/validate.mjs`、`scripts/plugin/test.mjs`、`package.json`、`plugins/modcrafting-fabric/.mcp.json`、`plugins/modcrafting-fabric/.codex-plugin/plugin.json`；新增 `plugins/modcrafting-fabric/README.md`。

**动作**：
1. 在现有自包含 esbuild 产物基础上新增 `npm run plugin:stage`，将**完整且最小**的插件文件复制到 `temp/plugin-artifacts/modcrafting-fabric/`。不要将 Stage 产物写入正式仓库目录，也不要求 Electron Runtime。
2. Stage 目录应包含有效 MCP 入口 JS、当前 Codex 插件清单、MCP 配置、Skill、必要图标、README；如分发需要 LICENSE，先核对仓库已声明的 GPL-3.0 及合法的许可证原文来源，不得臆造许可证内容。
3. Stage 目录必须排除 `src/`、`.data/`、`node_modules/`、`temp/`、`runtime/`、`.env`、构建日志、用户配置与本地知识缓存。
4. 从 Stage 目录外的临时工作目录启动 `node <stage>/dist/mcp-server.js`；确认不会从仓库 `packages/` 或 `node_modules/` 读取源码。
5. 允许通过环境变量配置数据目录。默认应选择适合持久化的用户数据目录，且不能默认将下载缓存写进只读的插件安装目录；兼顾旧 `PLUGIN_DATA` / `CODEX_PLUGIN_DATA` 的兼容行为。必须避免在初始化时下载任何资源。
6. 如果旧插件已在实际环境使用，保留原 `.codex-plugin/plugin.json` 路径与原 MCP 工具名称，不未经验证就迁移到仅有新格式的清单。
7. 仅在当前 Codex 安装机制可验证时，新增可移植根级 `plugin.json` / `mcp.json`；必须保留旧格式兼容并测试。不得假定 Qoder、Claude、TRAE 共用同一个清单格式。
8. 插件版本号和 MCP Server 报告版本应来自同一个可控版本源；废除自测里不可验证的固定数字。不要在本阶段自行发布或擅自升级用户端已安装版本。

**输出**：可复制到另一目录运行的插件 Stage 目录、构建命令和 README。

**完成条件**：测试时将原仓库路径从模块解析范围隔离后，Stage MCP 仍能启动并响应基本协议；不依赖 Electron。

### P1-03：把“注册自测”升级为真实 MCP 协议烟测

**建议文件**：新增 `scripts/plugin/smoke.mjs` 或 `scripts/plugin/smoke.test.mjs`；修改 `scripts/plugin/test.mjs`、`scripts/plugin/validate.mjs`、`package.json`。

**必须覆盖的测试**：
1. 从独立 Stage 目录启动 MCP Server，通过标准 MCP Client（优先复用仓库现有 MCP SDK）完成 `initialize` 与初始化通知。
2. 调用 `tools/list`，验证至少存在以下**当前真实工具**：`modcrafting_environment_status`、`fabric_project_inspect`、`fabric_validate`、`minecraft_test_start`、`minecraft_test_status`；还要检测工具名唯一、Schema 可被协议接受。数量从真实工具注册列表动态取得，不硬编码“19”。
3. 调用 `modcrafting_environment_status`（无项目路径）并校验返回结构和错误诊断。CI 没安装 Java 或知识包也必须得到有效响应。
4. 使用测试专有临时目录构造最小 Fabric 项目夹具，调用 `fabric_project_inspect` 和 `fabric_validate`；至少覆盖有效元数据与无效元数据两种结果。
5. 验证无知识包时 `minecraft_data_lookup` 不会伪造知识结果，按既有接口给出可解释的缺失提示。
6. 模拟启动时数据目录不可写、环境变量配置无效、Server 意外退出，均应快速报错而非超时悬挂。测试工具须有硬超时，并负责结束自己启动的子进程。
7. 测试 `stdout` **只包含合法 MCP JSON-RPC 消息**；日志/诊断只写 `stderr`，不能污染协议流。
8. 主动关闭客户端 stdin 或连接后，Server 应释放由自己创建的非必需句柄并及时退出，不留下后台 Node 进程。
9. 对新版/旧版 Stage 插件配置，验证 MCP 入口实际指向被打包的文件，而不是源仓库中的文件。

**测试实现原则**：不能用手动解析几行 JSON 文本替代 SDK 协议往返；对依赖真实 Minecraft 的部分使用明确标识的 Mock/Fixture，不得在自动化 CI 中悄悄启动真正的游戏。

**输出**：新增 `npm run plugin:smoke`，以及包含真实初始化、tools/list、tools/call 的自动化测试。

### P1-04：游戏验收“不可伪 PASS”防线（仅修正确性，不做大规模引擎迁移）

**涉及**：`packages/modcrafting-core/src/domain.ts` 的 `validateGameTestSpec`；`plugins/modcrafting-fabric/src/mcp-server.ts` 的 `minecraft_test_start`、`assertionResult`、`runAction` 及报告调用；必要时抽取小型纯函数到共享 Core。

**现有风险（已在源码确认）**：
- `validateGameTestSpec` 当前主要检查 version/id/featureType/数组存在与断言非空，无法保证数组内部动作和断言字段有效。
- 插件 `command_result` 断言目前明确不支持。
- `hud_text` 只查后置 `hudTrace`，未在本实现中证明事件发生于动作之后；历史 HUD 事件可能造成假阳性。
- `cleanup` 尚未以 finally 语义保护异常流程，某些失败可能绕过清理或缺少清理状态证据。
- 当前插件的简化测试协议不能与桌面版完整的验证引擎等同。

**本任务限定动作**：
1. 为 GameTestSpec 建立字段级校验：数组中每个 action/assertion 必须是受支持类型，必填值与基本范围合法；拒绝非法对象、空动作集合及不完整的断言参数。对历史合法 Fixture 做兼容测试。
2. 定义结构化结果/错误代码 `INVALID_SPEC`、`CAPABILITY_UNAVAILABLE`、`EVIDENCE_MISSING`、`ENVIRONMENT_UNAVAILABLE`、`CLEANUP_FAILED`（如已有等价代码，优先复用）。
3. **尚不能证明新鲜度的 HUD 轨迹**不得导致 PASS；可先返回 INCONCLUSIVE，除非能以当前 Observer 的真实序号、时间戳或独立基线证明 freshness。不要凭“after 中出现文字”放行。
4. `command_result` 未实现则明确 INCONCLUSIVE，不得隐式转化为其他断言；如果类型输入非法，应该在启动前拒绝。
5. Snapshot 缺字段、Observer 不可用、世界不匹配、查询失败、assertion 类型不支持，均不得返回 PASS；真实观察值不匹配才 FAIL。
6. 用 `try/finally` 或等效状态机确保清理始终尝试，并在结果中报告 cleanup 是否执行/失败；清理失败不能保留“完整测试 PASS”的最终结论。
7. 报告必须说明 `verdict`、`reason/code`、证据来源、版本、场景标识与受支持断言集合；不伪造未执行的复测或独立进程证据。
8. 只提取可复用的纯逻辑，不在本阶段整体搬运 `game-test-protocol.ts` 的千行实现，也不新增虚构的“18 断言全支持”宣传。

**最低回归样例**：

| 场景 | 预期 |
|---|---|
| `assertions: []` | INVALID_SPEC |
| 不存在的 assertion type | INVALID_SPEC |
| assertion 缺必填 ID/坐标/指针 | INVALID_SPEC |
| `command_result` 提供合法结构但当前未支持 | INCONCLUSIVE / CAPABILITY_UNAVAILABLE |
| 只有旧 HUD trace，没有动作后新证据 | 不得 PASS |
| Observer 未就绪 / 非测试世界 | INCONCLUSIVE |
| 有效快照且观察值明确不匹配 | FAIL |
| 有效支持型断言、动作和证据完整 | PASS |
| 动作抛异常但需要 cleanup | 确认已尝试 cleanup，结果不得 PASS |
| cleanup 自身失败 | CLEANUP_FAILED，最终不得 PASS |

测试使用纯函数或可控假的 Bridge Adapter；**不要求在本阶段真实启动 MC 并跑 18 种断言**。

### P1-05：为现有 Codex 插件编写可执行的最短安装文档

**新增文件**：`plugins/modcrafting-fabric/README.md`；必要时补充 `docs/agent-integration-boundaries.md`。

**README 必须包含**：
- 30 秒说明产品是什么、与 Desktop 关系、当前只保证 Fabric 1.21.4；
- 系统要求：Node 版本以实测支持范围为准，Windows、真正运行 Gradle 任务需系统 JDK 21、Fabric 项目 Gradle Wrapper；
- 插件 Stage 目录结构，以及现有 Codex 插件的受支持安装方法；如果安装命令随 Codex 客户端版本不同，写清已验证的实际客户端及替代手动路径，**不要虚构一键安装指令**；
- MCP 的 `tools/list` 和 `modcrafting_environment_status` 最小连接验证；
- 知识库按需准备的方法，明确下载/离线范围、缓存路径、网络失败诊断；
- Demo：打开已有 Fabric 项目 → 项目检查 → 知识查询（已准备资源时）→ 编译 → 轮询任务；
- 游戏测试演示必须前置测试世界、Observer 和授权提醒，不能声称所有游戏操作都能直接完成；
- PASS / FAIL / INCONCLUSIVE 的含义与“不等价桌面端完整能力”的限制；
- 排错：Node/JDK/Gradle、资源缺失、MCP 启动报错、stdout 污染、Observer 未连接；
- 明确**未来**会支持 Claude、Qoder、TRAE、WorkBuddy、DSH，但此阶段不宣称已适配；
- 安全与卸载：数据保留位置、缓存清理边界、禁用插件与删除数据区别。

**要求**：实际验证文档命令，确保不是只有作者本机仓库才可运行。

### P1-06：建立独立、低成本的插件 CI 门禁

**建议新增**：`.github/workflows/plugin.yml`；现有 `.github/workflows/release.yml` 不修改发布逻辑。

**要求**：
1. PR / push 时针对 `plugins/modcrafting-fabric/**`、`packages/modcrafting-core/**`、`scripts/plugin/**`、`package-lock.json`、相关 GitHub workflow 及测试目录变动触发；注意 `package.json` 更改也要触发。
2. 使用 Windows Runner + 与项目当前验证过的 Node 版本（现有 release workflow 使用 Node 22）；CI 不下载完整 MC 客户端资源，不启动 Electron，不执行带 API Key 的在线模型测试。
3. 顺序执行 `npm ci`、`npm run plugin:build`、`npm run plugin:validate`、`npm run plugin:stage`、`npm run plugin:smoke`、`npm run plugin:test`，必要时加只覆盖受影响代码的单元测试。
4. 检查 Stage 目录不含敏感或开发残留文件、不含绝对本机路径、不依赖源仓库。
5. 即使没有游戏/Java，基础 MCP Smoke 应通过；需要 Java 的测试明确跳过并写出跳过原因，而不是错误地报告全套游戏测试 PASS。
6. 采用最小权限，CI 不要求发布 Token，不上传包含用户日志和私人配置的文件，不自动 `npm publish`。
7. 失败时 CI 输出失败步骤、协议异常与修复建议，不把可能包含认证信息的 MCP 参数打印到日志。
8. CI 成功只代表**插件封装与基本接口稳定**，不代表真实游戏功能已验证。真实游戏验收进入下一阶段。

## 4. 对外接口与数据约定

### 4.1 MCP 兼容性基线

保留现有工具名与主要输入字段，优先考虑兼容：
- `modcrafting_environment_status` / `modcrafting_prepare_assets`
- `minecraft_data_lookup` / `fabric_docs_search` / `mc_wiki_search`
- `fabric_project_inspect` / `fabric_project_scaffold` / `fabric_validate`
- `fabric_build_start` / `fabric_job_status` / `fabric_job_stop`
- `minecraft_run_client` / `minecraft_runtime_status` / `minecraft_stop_client`
- `minecraft_snapshot` / `minecraft_command` / `minecraft_input`
- `minecraft_test_start` / `minecraft_test_status`

以上是**当前工具集合快照**，不是永远固定的“19”常量。Smoke 从 `tools/list` 获取真实集合并检测缺失和重复；工具变动须更新显式基线与文档。

### 4.2 诊断结果

尽量保持原有返回字段不破坏调用者，同时确保失败时能稳定区分：
- 参数错误（不可重试）；
- 所需资源/能力缺失（环境或能力问题）；
- 观察到产品断言失败（功能问题）；
- 工具或桥连接超时（可按条件恢复）；
- 运行已取消/清理失败（不得算 PASS）。

不要让模型自行根据自然语言日志推断这些分类；机器可读 code 为准。

### 4.3 数据与安全

- `stdout` 专供 MCP 线路；日志写 `stderr`。
- 本地 Observer 认证 token 不进入模型提示词、测试报告和公开日志。
- 插件数据与插件安装文件分离；检查目录清理不能跟随 junction/symlink 到任意用户路径。
- 自动测试仅针对明确构建的 Fixture 项目，不修改用户原有存档。
- 对工具执行权限依照原有能力边界，任何新的写入/命令能力必须后续另设审批设计，不在本阶段开放。

## 5. 验收命令

在仓库根目录执行：

```powershell
git status --short --branch
node --version
npm run plugin:build
npm run plugin:validate
npm run plugin:stage
npm run plugin:smoke
npm run plugin:test
npm run typecheck
npm test
git status --short --branch
```

注意：`plugin:stage` 和 `plugin:smoke` 为本阶段**拟新增**的脚本，实施之前不存在时不得报告为已有通过。`npm test` 或 `typecheck` 如果受到既存问题影响，保留完整失败摘要并标注“既存/本阶段引入”，不要改写报告掩盖失败。

对真实 Minecraft / Observer 的人工验证为单独选做：
1. 用户明确允许且已具备 JDK21、项目 Wrapper、Observer 和**专用测试世界**；
2. 在隔离 gameDir 中 runClient；
3. 执行一条仅使用已经声明支持的最小游戏断言；
4. 保存源码 Hash / 运行版本 / 报告 / 观察证据；
5. 未执行时在最终报告写“未验证”，禁止写“通过”。

## 6. 可交付物与 Definition of Done

| 编号 | 必须交付 | 验收 |
|---|---|---|
| D1 | 独立 Stage 插件目录与 `plugin:stage` | 从非仓库目录启动 MCP |
| D2 | MCP 真实协议 `plugin:smoke` | initialize / tools/list / tools/call 成功，退出无孤儿进程 |
| D3 | 修正 `--self-test` / 插件测试 | 不再把硬编码工具数量当协议测试 |
| D4 | GameTestSpec 严格校验与无伪 PASS 测试 | 全部最低回归样例通过或如实说明不可模拟部分 |
| D5 | Codex 插件 README | 安装/排障/能力限制完整且指令实测 |
| D6 | 独立 GitHub CI | PR 对插件改动自动验证，无发布权限 |
| D7 | 架构边界与旧 Harness 维护模式文档 | 新增业务不会继续堆积在旧 Harness |
| D8 | `docs/phase-01-implementation-report.md` | 写明文件清单、命令结果、未验证项、剩余风险 |

**结束条件**：D1–D8 全部完成且没有本阶段引入的阻断性回归。任何未完成项需标注 BLOCKED / PARTIAL 并解释，不可伪称全部交付。避免因环境缺失而盲目修改生产逻辑。

## 7. 强制风险检查

| 风险 | 必须采取的应对 |
|---|---|
| Stage 包依赖本地代码 | 在隔离目录、隔离数据根路径执行协议调用 |
| Node/MCP 进程卡住 | 测试硬超时、显式清理子进程与句柄 |
| stdout 输出日志污染协议 | 自动断言每一行都是合法 MCP 报文 |
| 靠固定工具计数“自测通过” | 用真实 tools/list 和关键工具调用取代 |
| 游戏测试旧 HUD 事件导致假 PASS | 要么关联动作后的新证据，要么 INCONCLUSIVE |
| 清理动作未执行却报告 PASS | finally 和 cleanup 状态证据 |
| 依赖游戏或网络的测试阻塞 CI | 离线 Smoke 与真实游戏测试分层 |
| 用户数据意外丢失 | 禁止 git clean/reset；只删除测试专有目录 |
| 过早抽象多个 Agent 插件 | 本阶段只验证 Codex 分发入口 |
| 过早迁移 Desktop Harness | 保留旧架构，新增功能流向 Core/MCP |

## 8. 本阶段明确不做的事情（避免 Codex 扩项）

- 不开发 Pi SDK、Agent Gateway、云端同步或第三方模型配置页。
- 不开发 Minecraft AI 陪伴 Mod、游戏内语音/NPC、聊天 HUD。
- 不开发 MCP Apps、Web Dashboard、WebSocket 服务。
- 不开发 Claude、Qoder、TRAE、WorkBuddy、DSH 的插件包生成器。
- 不做 Minecraft 多版本矩阵、Bridge 多版本适配、知识库多版本下载。
- 不把 Desktop 完整验收引擎一次性移植到 Core。
- 不做线上 Benchmark 榜单、营销站、社区发布和正式版本升级。
- 不新增大型第三方框架、不手写已有 SDK 可以完成的协议栈。

这些属于**后续阶段**，不要为了架构“整洁”提前引入空目录、泛型框架或虚构接口。

## 9. 后续阶段交接条件（只记录，不实施）

进入第二阶段前，必须先完成本阶段 DoD。第二阶段的建议主题是“统一验收 Core + Fabric-Bench MVP”，随后再进行“跨 Agent Installer（Codex / Claude / Qoder 第一批）”，最后才做“游戏内 AI Mod、可视化、版本矩阵”。

第二阶段依赖的关键接口：稳定的 MCP tool schema、可信的 GameTest verdict、独立 Stage 分发形式、可自动运行的 Smoke、清晰的错误代码。第一阶段若未建立这些基础，新增更多 Agent 平台只会把错误放大。

## 10. 直接交给 Codex 的执行提示词

> 本文件就是开发规范；以下可整段复制为 Codex 的首条任务。

```text
请打开并完整阅读 docs/phase-01-mcp-foundation.md，同时阅读 AGENTS.md、
package.json、plugins/modcrafting-fabric、packages/modcrafting-core、
scripts/plugin 和 docs/archive/2026-10-05-harness-repeated-failure-root-causes.md。

你现在执行 ModCrafting 第一阶段（P1）：独立 MCP 底座与可信交付基线。

**开始前完整阅读 docs/phase-00-git-safety.md 与 docs/phase-00-pnpm-worktree.md：确认 P0 Git 安全隔离及 P0.5 pnpm 依赖迁移均完成。未经明确授权不执行 GitHub push 等有状态操作；若 P0/P0.5 未完成，先报告并停止 P1 业务代码修改。进入新的 ModCrafting-mcp-p1 工作区后才能执行本阶段。**

按文档 P1-01 至 P1-06 顺序实施；常规编码细节不需要再征求重复确认。
如果发现项目状态与文档不同，必须以最新源码为准并记录差异，
不要为了满足旧文档去破坏已有实现。

目标：
1. 无 Electron、无完整源码依赖的 Stage 插件目录；
2. 真实 MCP initialize、tools/list、tools/call 烟测；
3. 游戏测试断言不能伪造 PASS，能力不足如实 INCONCLUSIVE；
4. Codex 安装使用说明与单独 CI；
5. 新增 docs/phase-01-implementation-report.md 记录结果。

限制：
- 禁止 git pull/reset/clean/rebase/push、禁止发布、禁止处理用户未跟踪文件；
- 禁止修改 .env、API Key、真实存档、个人配置；
- 不接入 Pi，不开发 Desktop 新功能，不新增游戏内陪伴 Mod；
- 不为六个 Agent 平台提前抽象过度；
- 优先复用现有 SDK/脚本，保持旧 MCP 工具兼容；
- 对任何无法验证的命令如实标记为未验证，不能声称通过；
- 逐任务实现并测试，不扩大缺陷修复范围。

完成后输出：修改文件清单、关键设计决策、已运行命令及结果、
原有失败与新增失败区分、未完成事项、第二阶段前置条件。
不要自动提交或推送。
```

---

**验收说明**：本文件由代码检查形成，但截至编写时并未实施任何 P1 任务；`plugin:stage`、`plugin:smoke`、`plugin.yml` 等仍是计划中的交付物。当前已执行的安全基线仅为 `npm run plugin:validate` 与已构建插件的 `--self-test`；两者通过不等于游戏测试通过。
