# AGENTS.md

本文件为 Codex (Codex.ai/code) 在此仓库中工作时提供指导。

> 完整指南见 [docs/AI_AGENT_GUIDE.md](docs/AI_AGENT_GUIDE.md)

## 知识库快速参考

ModCrafting 内置两套本地 Minecraft 离线知识库，运行时不联网：

| 知识库 | 位置 | 用途 | 构建命令 |
|--------|------|------|----------|
| minecraft-data 结构化数据集 | `resources/minecraft-data/<version>/` | 全版本原版方块/物品/实体/附魔/合成配方 JSON，含标准 ID、硬度、爆炸抗性等属性 | `npm run knowledge:build-data-index` |
| 中文 MC 百科向量库 | `resources/mc-wiki-zh/` + `resources/mc-wiki-zh-index/` + `resources/mc-wiki-model/` | 中文 MC 游戏百科离线文档（MD 格式），用 transformers.js 向量检索处理模糊描述 | `npm run knowledge:build-wiki-embeddings` |

一键构建：`npm run knowledge:build-all`（含数据抓取、索引构建、模型缓存）。

Agent 工具入口：`minecraft_data_lookup`（结构化数据查询）、`mc_wiki_search`（百科向量检索）、`vanilla_mc_wiki_query`（百科检索，自动使用本地向量库）。
