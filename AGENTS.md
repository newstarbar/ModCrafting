# AGENTS.md

本文件为 AI Agent（Codex / Claude Code / Cursor / Trae 等）在此仓库中工作时提供精简指引。

> **完整文档**位于 [`docs/`](./docs/) 目录，按主题分类。本文件仅保留摘要与关键约定。

---

## 项目摘要

**ModCrafting** 是面向 Minecraft Fabric 模组开发的 AI 原生 Electron 桌面应用，整合 Vibecoding 对话开发、Fabric 工程脚手架、一键游戏内测试与离线构建环境。

- **技术栈**：Electron 42 · React 19 · TypeScript · Fabric 1.21.4 · JDK 21 · Gradle 9.5
- **目标平台**：Windows x64
- **许可证**：GPL-3.0
- **仓库**：[github.com/newstarbar/ModCrafting](https://github.com/newstarbar/ModCrafting)

## 核心架构

三进程 Electron 应用：
- **主进程**（`src/main/`）：IPC、工具链、游戏实例、终端、知识库服务
- **预加载**（`src/preload/`）：`contextBridge` 安全桥接
- **渲染进程**（`src/renderer/`）：React UI + AI Harness 系统

详见 [docs/architecture.md](./docs/architecture.md)。

## 常用命令

```bash
npm run dev                     # 开发模式（热更新）
npm run test                    # harness 单元测试
npm run build:win               # Windows 构建（Setup + Portable）
npm run toolchain:verify       # 检查 JDK/Gradle 是否齐全
npm run knowledge:download    # 下载所有离线知识库
```

完整命令清单见 [docs/commands.md](./docs/commands.md)。

## AI Harness 关键约定

| 主题 | 说明 | 文档 |
|------|------|------|
| 三模式路由 | Chat / Plan / Execute，每轮独立分类 | [docs/harness.md](./docs/harness.md#三模式路由) |
| 计划阶段门控 | `MAX_READONLY_ROUNDS = 15`，锁定后仍允许只读工具 | [docs/harness.md](./docs/harness.md#计划阶段门控) |
| 工具集（30+） | 文件 / 搜索 / Fabric / 构建 / 知识库 / 流程控制 | [docs/harness.md](./docs/harness.md#工具集30) |
| 关键护栏 | 读门控、重复成功守卫、推理长度 6k/12k | [docs/harness.md](./docs/harness.md#关键护栏) |
| 输出截断 | read_file 默认 400 行；工具输出 32KB；不显示原始大小 | [docs/harness.md](./docs/harness.md#输出截断) |

## Minecraft 知识库

内置两套离线知识库 + Fabric 官方中文文档，运行时不联网。知识库构建已迁移到独立仓库 [ModCrafting-knowledge-base](https://github.com/newstarbar/ModCrafting-knowledge-base)。详见 [docs/knowledge-base.md](./docs/knowledge-base.md)。

| 知识库 | 工具入口 | 下载命令 |
|--------|---------|---------|
| minecraft-data 结构化数据 | `minecraft_data_lookup` | `npm run knowledge:download` |
| 中文 MC 百科向量库 | `mc_wiki_search` | `npm run knowledge:download` |
| Fabric 官方中文文档 | `fabric_docs_search` | `npm run docs:sync-fabric` |

**代码生成铁律**：编写方块/物品/实体/附魔注册代码前**必须**先调用 `minecraft_data_lookup` 查询标准 ID 与原版属性，禁止凭记忆填写参数。

## 维护红线

- **工具链下载逻辑双份**：`scripts/toolchain/toolchain-download.mjs` 与 `src/main/toolchain-download.ts` 需同步修改
- **MC 版本升级**：升级 `resources/fabric-versions.json` 后必须重新运行 `npm run knowledge:download`
- **AGENTS.md / CLAUDE.md ≤ 150 行**：只保留摘要与索引，详细内容写到 `docs/`
- **提交前确认**：未包含 API Key、`.env`、个人路径；未提交 `node_modules/`、`release/`、`runtime/`、`resources/jdk-21/`

## 发布流程

当开发者要求发布新版本时，Agent 按以下步骤执行：

1. 读取 `package.json` version，基于近期 commit 推荐下一迭代版本（`feat:`→minor，`fix:`→patch，破坏性变更→major），说明推荐理由
2. 开发者确认版本后，更新 `package.json` version
3. 运行 `npm run release:publish`，一条命令完成：
   - 生成 `packaging/release-body.md` + 归档 `docs/releases/vX.Y.Z.md`
   - 创建并推送 tag 到 GitHub（触发 CI 自动发布 GitHub Release）
   - 推送 git + tag 到 Gitee 并上传 Release 附件

**前置条件**：本地已构建产物（`npm run build:win` 等）；`.env` 配置 `GITEE_TOKEN`（见 `.env.example`，已 gitignore）。

**幂等**：Gitee 已存在该版本时自动跳过。详见 [RELEASE.md](./RELEASE.md)。

## 归档机制（重要）

AI Agent 必须在以下场景触发归档，将工作总结写入 [`docs/archive/`](./docs/archive/)：

1. **开发者主动触发**：用户说"归档"、"archive"、"沉淀经验"等关键词时立即归档
2. **大功能改动自动触发**：新增核心模块 / 重构主流程 / 修复复杂 bug / 调整 Agent 行为规则 / 修改构建流程
3. **繁琐问题解决后提醒**：复杂问题解决后在总结末尾提醒"可考虑归档"

详见 [docs/archiving.md](./docs/archiving.md)。

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/README.md](./docs/README.md) | 文档导航总索引 |
| [docs/architecture.md](./docs/architecture.md) | 架构、模块、目录结构 |
| [docs/commands.md](./docs/commands.md) | 完整命令清单 |
| [docs/workflow.md](./docs/workflow.md) | Vibecoding 工作流 |
| [docs/harness.md](./docs/harness.md) | AI Harness 系统详细说明 |
| [docs/toolchain.md](./docs/toolchain.md) | 离线工具链 |
| [docs/knowledge-base.md](./docs/knowledge-base.md) | Minecraft 知识库 |
| [docs/archiving.md](./docs/archiving.md) | 归档机制 |
| [docs/archive/](./docs/archive/) | 已归档的工作总结 |
| [docs/AI_AGENT_GUIDE.md](./docs/AI_AGENT_GUIDE.md) | AI Agent 完整指南（综合旧版） |

## 测试

```bash
npm test
```

测试运行器：`scripts/test/run-harness.mjs`，自动收集 `scripts/test/harness-*.test.ts`。新增测试遵循 `harness-*.test.ts` 命名规范。
