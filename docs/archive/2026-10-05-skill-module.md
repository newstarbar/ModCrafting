# Skill 技能模块落地（可复用 Agent 指令包）

**归档日期**：2026-10-05
**触发方式**：大功能自动（新增核心模块）
**涉及文件数**：26（新增 12 / 修改 14）
**问题类型**：新功能 / 重构 / 文档

## 背景

ModCrafting 的 AI Harness 原先把 Mixin 嵌套 target、证据门推进、datagen 校验链、GUI 预览流程等专业步骤硬编码在 `src/renderer/src/harness/controller.ts` 的系统提示词里：每轮全量占用 token，用户无法增删，也无法沉淀新的排查经验。`plugins/modcrafting-fabric/skills/*/SKILL.md` 虽已是 SKILL.md 形状，但只服务外部 Codex 插件（正文引用 `minecraft_run_client` 等应用内不存在的 MCP 工具名），`src/` 里没有任何代码读取技能文件。

本次交付应用内 Skill 模块：带 frontmatter 的 `SKILL.md` 指令包，Harness 自动发现（索引进系统提示词）+ 按需读取（`read_skill`），并可在设置里查看、编辑、启停。

四条产品决策（开发者确认）：纯指令包不碰工具与门控；模型自动发现 + 按需读取（v1 不做 @ 选择）；Chat 模式同样可用；内置技能默认全部启用。

## 改动清单

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `src/shared/skills.ts` | 新增 | `SkillDescriptor` / `SkillReadResult` / `SkillWriteResult`，主进程、preload、渲染层共用单一形状 |
| `src/main/md-tree-store.ts` | 新增 | 「内置树 + userData 覆盖层」通用实现：递归列 `.md`、覆盖优先、保存/删除覆盖；`sanitizeRelPath` 拒绝 `..`、盘符与 NUL |
| `src/main/skill-catalog.ts` | 新增 | 不依赖 electron 的技能核心：手写 frontmatter 解析、id 白名单、`listSkillsFromTree` / `loadSkillFromTree`（可直接用 tmpdir 单测） |
| `src/main/skill-service.ts` | 新增 | 三层根解析（`runtime/skills` → `resourcesPath/skills` → `resources/skills`）+ 与 `disabledSkills` 粘合的对外 API |
| `src/main/knowledge-service.ts` | 重构 | 删掉自带的目录遍历/读写/覆盖实现（约 60 行），改用 `md-tree-store`；顺带补上原先缺失的路径穿越防护 |
| `src/main/agent-config.ts` | 修改 | `AgentConfig.disabledSkills`；`saveAgentConfig` 改为按字段合并磁盘原值，避免分区保存互相抹掉 |
| `src/main/ipc-handlers.ts` | 修改 | `skills:list` / `skills:read` / `skills:save` / `skills:resetOverride` |
| `src/preload/index.ts`、`src/renderer/src/vite-env.d.ts` | 修改 | 四个 `window.api` 方法与类型；agent-config 类型补 `disabledSkills` |
| `src/renderer/src/harness/skill-tools.ts` | 新增 | `read_skill` 工具与 `formatSkillIndex()`：按 id 排序、≤20 条、描述截 90 字符，尾部固定「用精确 id 调 read_skill」指令 |
| `src/renderer/src/harness/tool-policy.ts` | 修改 | `read_skill` 登记为 `KNOWLEDGE`（`knowledge.read`） |
| `src/renderer/src/harness/tool-definitions.ts` | 修改 | `readSkillTool` 无条件进入装配清单（47 → 48） |
| `src/renderer/src/harness/agent.ts` | 修改 | Chat 固定工具集抽出 `CHAT_TOOL_NAMES` 并加入 `read_skill`；过滤与快照两处改为引用同一常量 |
| `src/renderer/src/harness/controller.ts` | 修改 | `buildSkillIndex()` + 三种模式的 system prompt 注入；新增 `invalidateSkillIndex()`（置空 `lastSystemMode` 触发重建） |
| `src/renderer/src/harness/session-runtime.ts` | 修改 | `invalidateSkillIndex()` 广播到所有会话 runtime |
| `src/renderer/src/components/ToolsPanel.tsx` | 修改 | 第三种 `mode="skills"`：技能卡开关 + 整份 `SKILL.md` 编辑 + 恢复内置；`saveConfig` 三分支各自保留他分区字段 |
| `src/renderer/src/components/SettingsCenter.tsx` | 修改 | 新增「技能」分区 |
| `src/renderer/src/components/ChatPanel.tsx` | 修改 | 既有 `agent-config-saved` 监听里附带失效技能索引 |
| `resources/skills/{mixin-nested-target,evidence-and-step-completion,datagen-content,client-gui-hud,vanilla-id-lookup}/SKILL.md` | 新增 | 5 条内置技能，全部使用应用内真实工具名 |
| `package.json`、`electron-builder.portable.json` | 修改 | `extraResources` 增加 `resources/skills → skills`（两条打包路径各自持有该数组） |
| `scripts/test/harness-{md-tree-store,skill-catalog,read-skill-tool,skill-policy-gating,skill-index-injection}.test.ts` | 新增 | 见验证方式 |
| `docs/skill.md`、`docs/harness.md`、`docs/README.md`、`AGENTS.md`、`CLAUDE.md`、`README.md` | 修改 | 新增技能文档；工具计数 47 → 48（含 `harness-overfit-boundary` 强制的四份文档） |

## 关键决策

1. **一个工具而不是 `list_skills` + `read_skill` 两个**：索引本身已在系统提示词里，再加一个列表工具纯属重复。`read_skill` 省略 `id` 时返回索引，形成自愈式发现——上下文被压缩掉索引后模型仍能重新列出技能，同时 catalog 只 +1。
2. **技能启停绝不增删工具**：Plan/Execute 向模型广播完整 catalog 以换取逐轮字节一致（`agent.ts` 内注释记录了历史上 60% 命中率的教训）。启停只在 `read_skill` 执行期与索引内容上生效。
3. **`knowledge.read` 策略是本次改动面小的根因**：登记能力后，Plan 白名单、计划探索锁、快照阶段门、只读锁过滤、write/recipe/mixin 步骤门、纯知识免费轮全部自动放行，一行门控代码都不用改。这正是上一轮归档教训「提示词约束与工具白名单必须由同一处派生」的正向兑现。
4. **通用文件树而不是再克隆一份**：`agent-knowledge` 与 `skills` 的「内置 + 覆盖」语义完全同构，抽 `md-tree-store` 共用，顺带把知识库缺失的路径穿越防护补上。
5. **electron-free 的 `skill-catalog`**：主进程模块一旦 `import { app } from 'electron'`，在裸 Node 测试里就无法加载。因此把解析/列表/读取做成接受注入树的纯函数，单测直接跑 tmpdir，不必 mock electron。
6. **内置技能只补充细节、不复述铁律**：`controller.ts` 已强制 Mixin 四步、GUI 预览、`minecraft_data_lookup` 前置。技能写「嵌套 target 用 `targets=`」「缺证据后唯一有效动作」这类增量，重复既有规则只会双倍烧 token。
7. **`plugins/*/skills/` 保持原样**：外部 Codex 插件的技能树与应用内技能树是两回事，`npm run plugin:validate` 依赖其形状，不迁移、不改写。

## 验证方式

```bash
npm test                    # 与改动前失败集逐条一致（本工作树未装 node_modules，既有失败多为依赖缺失）
node scripts/test/run-harness.mjs   # 504 tests / 468 pass / 31 fail / 5 skipped
```

与 HEAD 干净副本（`git archive` + 同环境）逐条比对失败名：**新增失败为零**，且 5 个新套件全部通过或按依赖缺失显式 skip。

单测锁住的边界：

- `harness-md-tree-store`：`.md` 递归收集、覆盖优先、`deleteOverride` 回落、越界路径拒绝且不落盘
- `harness-skill-catalog`：frontmatter 缺失/缺字段/CRLF/BOM/引号/未知字段，非法 id 与多层目录被跳过，停用技能仍可被设置界面读取
- `harness-read-skill-tool`：带 id 返回正文、不带 id 返回索引、禁用被拒、`window.api` 缺失返回服务不可用、索引排序与截断预算
- `harness-skill-policy-gating`：能力声明、Plan/锁定/步骤门放行、装配清单登记、`CHAT_TOOL_NAMES` 两处引用同一常量、三处 system prompt 注入落点
- `harness-skill-index-injection`：三模式索引内容与 cache 语义（同 mode 不重建、失效后带上最新列表）；无依赖环境整组 skip

**未完成的验证**：需要 `npm install` 与生成态 `src/renderer/src/data/items.ts` 后才能跑真实 Electron 冒烟（设置 → 技能 的开关/编辑/恢复内置，以及一次 Plan 会话里 `read_skill` 的实际调用与工具卡展示）。`npm run build:win:portable` 后需确认产物 `resources/skills/` 随包发布。

## 经验教训

1. **能力声明即门控**：新工具只要能落到正确的 `ToolCapability` 上，就不要去门控代码里加白名单；反过来，若一个工具需要改门控才能用，先怀疑它的能力声明是否选错了。
2. **主进程模块一碰到 `electron` 就退出可测范围**：把纯逻辑做成接受依赖注入的独立模块（这里是 `md-tree-store` + `skill-catalog`），electron 只做路径粘合，测试成本立刻下降一个量级。
3. **`resources/` 被整体 ignore，但 121 个文件是强制入库的**：新增内置资源必须 `git add -f`，否则 CI 与本地都能跑通、发布包却是空的。已写进 AGENTS/CLAUDE 维护红线与 `docs/skill.md`。
4. **对比测试必须建同环境基线**：本仓库当前存在与技能无关的既有失败（scaffold 文案与用例不同步、`test_design` 步骤推断等）。用 `git archive HEAD` 复制一份同环境副本逐条 diff 失败名，才能区分「我改坏了」和「本来就红」。
5. **快速排查路径**：新工具在某阶段「看不见/被拒」→ 先看 `tool-policy.ts` 的能力声明，再看 `active-tool-snapshot.ts` 的 `phaseAllowed()` 与 `step-policy.ts`，最后才怀疑门控白名单。
