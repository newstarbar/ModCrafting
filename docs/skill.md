# Skill 技能模块

技能（Skill）是写给 AI Harness 的**可复用流程指令包**：一个带 frontmatter 的 `SKILL.md`，描述"某类任务应该怎么做"。技能只补充专业细节，**不新增工具、不改变门控**——工具集、能力策略、证据门、预算护栏全部照旧。

设计动机：Mixin 嵌套 target、步骤证据推进、datagen 校验链这些专业知识原先硬编码在 `src/renderer/src/harness/controller.ts` 的系统提示词里，每轮全量占 token，用户无法增删。技能把它们变成按需加载的文本包。

## 运行机制

```
resources/skills/<id>/SKILL.md ─┐
                                ├─ skill-service（主进程）→ skills:* IPC
userData/skills/<id>/SKILL.md ──┘            │
                                             ├─ 系统提示词注入「## 可用技能」索引（仅 id + 一句话）
                                             └─ read_skill 工具按需返回完整正文
```

1. **发现**：`buildSystemPrompt()` 调 `window.api.listSkills()`，把已启用技能渲染成索引块（`## 可用技能`），拼在 Fabric 策略之后、项目信息之前。Chat / Plan / Execute 三种模式都注入。
2. **加载**：模型判断需要时调用 `read_skill(id)` 取回正文；不带 `id` 调用则返回索引（上下文被压缩后仍可重新发现）。
3. **执行**：正文进入会话历史，模型按其中步骤继续用现有工具干活。

索引渲染与预算在 `src/renderer/src/harness/skill-tools.ts` 的 `formatSkillIndex()`：按 id 排序、最多 20 条、描述截断 90 字符，超出部分提示用 `read_skill` 取全量。

## read_skill 的关卡归属

`read_skill` 在 `tool-policy.ts` 登记为 `KNOWLEDGE`（capabilities `['knowledge.read']`），因此**无需改动任何门控代码**即可：

| 关卡 | 位置 | 结果 |
|------|------|------|
| Plan 阶段白名单 | `tool-policy.ts` `planToolNames()` | 自动包含 |
| 计划探索锁之后 | `plan-phase-gate.ts` `isPlanPostLockTool()` | 仍可用 |
| 快照阶段门 | `active-tool-snapshot.ts` `phaseAllowed()` | plan / chat 均放行 |
| 只读锁过滤 | `agent.ts` `filterExplorationTools()` | 只摘 `project.read`，不受影响 |
| write/recipe/mixin 步骤 | `step-policy.ts` `commandAllowedForStep()` | 知识工具显式放行 |
| 轮次预算 | `workflow-engine.ts` 纯知识轮 | 不计入 `attempt` |

Chat 模式的固定工具集是 `agent.ts` 的 `CHAT_TOOL_NAMES`（`read_file` / `explain_code` / `fabric_docs_search` / `read_skill`），提示词与门控必须由这一处派生，改动时两处引用一起改。

工具注册始终无条件进行（`registerModCraftingTools`）。**技能启停绝不能通过增删工具实现**：Plan/Execute 向模型广播完整 catalog，逐轮变化的工具列表会打回 prompt-cache 命中率（见 `docs/archive/2026-08-18-*` 与 `agent.ts` 内注释）。启停只影响索引内容与 `read_skill` 的返回。

## 技能文件

```markdown
---
name: mixin-nested-target
description: 目标类是嵌套类（含 $）时的 Mixin 写法、注册与构建失败排查流程。
---

正文：写给模型的第二人称祈使句，说明顺序、参数、失败时怎么办。
```

- `name` 缺省取目录名；`description` 缺省取正文首个非标题行（截 120 字符）。
- frontmatter 解析器是手写的（`src/main/skill-catalog.ts`），只认 `key: value`，不依赖 YAML。
- id 必须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`；布局必须是 `<id>/SKILL.md`，散文件与多层目录会被忽略。

## 存储与解析顺序

内置技能根按三层解析（与 `agent-knowledge` 一致，见 `src/main/skill-service.ts`）：

1. `runtime/skills/`（安装目录，允许整包替换）
2. `process.resourcesPath/skills`（打包后，由 `extraResources` 发布）
3. `app.getAppPath()/resources/skills`（开发态）

用户版本在 `userData/skills/<id>/SKILL.md`，**优先于内置**；设置界面「恢复内置版本」只删除用户副本。文件树与覆盖语义由 `src/main/md-tree-store.ts` 统一实现，`agent-knowledge` 与 `skills` 共用同一份实现（含路径穿越防护）。

## 管理界面

设置 → 技能（`SettingsCenter` 的 `skills` 分区，复用 `ToolsPanel mode="skills"`）：

- 每个技能一张卡：启用开关 + id + 描述；保存写入 `agent-config.json` 的 `disabledSkills`。
- 下方编辑器：下拉选技能 → 编辑整份 `SKILL.md`（含 frontmatter）→「保存为用户技能」或「恢复内置版本」。
- 保存后 `ToolsPanel` 广播 `agent-config-saved`，`ChatPanel` 调用 `SessionRuntimeManager.reloadTools()` 与 `invalidateSkillIndex()`；后者把各会话 controller 的 `lastSystemMode` 置空，下一轮重建 system prompt 以带上新索引。

## 与 Codex 插件技能的区别

`plugins/modcrafting-fabric/skills/*/SKILL.md` 面向**外部 Codex 插件**，正文引用的是插件 MCP 工具名（`minecraft_run_client`、`fabric_build_start` 等），由 `npm run plugin:validate` 校验形状，应用内不会读取。两棵树互不影响：新增应用内技能请写进 `resources/skills/`，并使用本仓库真实工具名。

## 新增一个技能

1. 建目录 `resources/skills/<id>/SKILL.md`，写 frontmatter + 正文。
2. 正文只补充现有硬规则的执行细节，**不要复述** `controller.ts` 已强制的流程（会重复烧 token）。
3. `resources/` 整体在 `.gitignore` 内，需 `git add -f resources/skills/<id>/SKILL.md`。
4. 无需改代码：索引、`read_skill`、设置界面都会自动出现该技能。
