# ModCrafting 文档导航

本目录是 ModCrafting 项目的详细文档库，按主题分类组织。

> 项目根目录的 [README.md](../README.md) 是面向用户的快速入门。
> [AGENTS.md](../AGENTS.md) 与 [CLAUDE.md](../CLAUDE.md) 是 AI Agent 工作时的精简指引（≤150 行），仅包含项目摘要、关键约定、文档索引。

## 文档分类

### 项目架构
- [architecture.md](./architecture.md) — 三进程架构、模块清单、目录结构、维护注意事项

### 开发流程
- [workflow.md](./workflow.md) — Vibecoding 工作流、三模式路由、Plan → Execute 双阶段
- [commands.md](./commands.md) — 完整命令清单、脚本目录结构、发布流程

### Codex 插件

- [architecture.md](./architecture.md) - `modcrafting-fabric` 插件与共享核心架构
- [commands.md](./commands.md) - 插件构建、隔离测试、校验和本地 marketplace 使用方式

### AI Harness 系统
- [harness.md](./harness.md) — Harness 模块清单、工具集、计划阶段门控、护栏机制
- [test-lab-mcp.md](./test-lab-mcp.md) — 真实 Electron 自动化桥、开发专用 MCP、黑盒场景与报告
- [AI_AGENT_GUIDE.md](./AI_AGENT_GUIDE.md) — AI Agent 当前开发入口与强制验证清单

### 工具链
- [toolchain.md](./toolchain.md) — 离线工具链、版本类型、初始化流程、维护注意

### Minecraft 知识库
- [knowledge-base.md](./knowledge-base.md) — minecraft-data 数据集、中文 MC 百科向量库、Fabric 官方文档、构建流程

### 归档机制
- [archiving.md](./archiving.md) — 归档触发时机、命名规范、归档模板
- [archive/](./archive/) — 已归档的工作总结（按时间倒序）

## 快速查找

| 我想了解 | 看哪个文件 |
|---------|-----------|
| 项目整体架构 | [architecture.md](./architecture.md) |
| 常用 npm 命令 | [commands.md](./commands.md) |
| AI Agent 是怎么工作的 | [harness.md](./harness.md) |
| 计划阶段为什么会被锁定 | [harness.md](./harness.md#计划阶段门控) |
| 内置了哪些 AI 工具 | [harness.md](./harness.md#工具集46) |
| 怎么运行应用级 Harness 回归 | [test-lab-mcp.md](./test-lab-mcp.md) |
| 游戏内测试如何裁决 | [harness.md](./harness.md#确定性游戏内测试-v2) |
| 离线工具链怎么工作 | [toolchain.md](./toolchain.md) |
| 知识库怎么构建 | [knowledge-base.md](./knowledge-base.md) |
| Vibecoding 流程 | [workflow.md](./workflow.md) |
| 怎么发布新版本 | [commands.md](./commands.md#发布新版本) |
| 归档机制怎么用 | [archiving.md](./archiving.md) |

## 文档维护原则

1. **精简的根目录文件**：`README.md`、`AGENTS.md`、`CLAUDE.md` 只保留摘要和索引，详细内容在 `docs/` 下
2. **分类清晰**：每个文件对应一个明确主题，避免跨文件重复
3. **随改动同步**：每次大功能改动后，相应文档同步更新；并通过归档机制保留本次工作记录
4. **避免过度文档化**：只在必要时新增文件，优先在现有文件内更新
