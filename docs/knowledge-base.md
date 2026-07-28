# Minecraft 知识库

ModCrafting 内置两套本地 Minecraft 离线知识库，agent 在生成 Fabric 模组代码时优先查询本地数据，避免 ID 与属性参数错误。

## 1. minecraft-data 结构化数据集

- **位置**：`resources/minecraft-data/<version>/index.json`（+ 原始 JSON 数据）
- **数据来源**：[PrismarineJS/minecraft-data](https://github.com/PrismarineJS/minecraft-data)，由 `npm run knowledge:fetch-data` 拉取
- **覆盖内容**：全版本原版方块、物品、实体、附魔、合成配方 JSON，包含标准命名空间 ID、方块硬度、爆炸抗性、堆叠大小、工具类型、耐久、生命值、附魔等级等全部属性
- **别名映射**：自动构建中英文别名映射（钻石矿石 ↔ diamond_ore ↔ minecraft:diamond_ore，含"矿石↔矿"等后缀变体）
- **构建命令**：`npm run knowledge:build-data-index`
- **查询工具**：`minecraft_data_lookup`（agent 工具）/ `window.api.mcDataLookupBlock` 等（preload API）
- **运行时服务**：`src/main/minecraft-data-service.ts`

### 服务接口

`minecraft-data-service.ts` 加载 index.json，提供：
- `lookupBlockById` / `lookupBlockByName`
- `lookupItemById` / `lookupItemByName`
- `lookupEntityById` / `lookupEntityByName`
- `lookupEnchantment`
- `searchRecipes`

## 2. 中文 MC 百科向量知识库

- **位置**：
  - `resources/mc-wiki-zh/` — 百科 MD 文档（按 category 子目录组织）
  - `resources/mc-wiki-zh-index/` — 预计算向量索引（`embeddings.bin` + `chunks.json` + `manifest.json`）
  - `resources/mc-wiki-model/` — transformers.js 模型缓存（`Xenova/all-MiniLM-L6-v2` onnx 权重）
- **数据来源**：[zh.minecraft.wiki](https://zh.minecraft.wiki)，由 `npm run knowledge:fetch-wiki` 抓取核心词条集（清单见 `scripts/knowledge/wiki-pages-list.json`）
- **检索方案**：transformers.js + 预计算 embeddings（384 维 all-MiniLM-L6-v2），运行时计算查询向量并执行余弦相似度检索
- **覆盖内容**：覆盖所有游戏机制、红石、生物、模组基础术语；处理模糊、不专业的游戏描述（"会爆炸的绿色怪物" → 苦力怕）
- **构建命令**：`npm run knowledge:build-wiki-embeddings`（需先 `npm run knowledge:fetch-wiki` 抓取文档）
- **查询工具**：`mc_wiki_search`（agent 工具）/ `window.api.mcWikiSearch`（preload API）
- **运行时服务**：`src/main/mc-wiki-vector-service.ts`

## 3. Fabric 官方中文文档

- **位置**：`resources/agent-knowledge/fabric/docs/develop/**`
- **数据来源**：由 `npm run docs:sync-fabric` 从 fabric-docs 同步
- **运行时不联网**：作为本地知识库直接加载
- **查询工具**：`fabric_docs_search`

## 代码生成优先级

agent 在编写 Fabric 模组代码时遵循以下优先级：

1. **用户输入模糊、不专业的游戏描述**（如"会爆炸的绿色怪物"、"挖矿掉的红色石头"）→ 先用 `mc_wiki_search` 检索百科知识库解析需求
2. **编写 Fabric 方块/物品/实体/附魔注册代码** → 必须先调用 `minecraft_data_lookup` 查询标准 ID 与原版属性（硬度、爆炸抗性、堆叠、工具、耐久、生命值、附魔等级等），禁止凭记忆填写原版参数
3. **原版机制/红石/生物/术语解释** → 优先用 `mc_wiki_search` 或 `vanilla_mc_wiki_query`；Fabric API/注册/事件/迁移用 `fabric_docs_search`；标准 ID 与属性参数用 `minecraft_data_lookup`

## 一键构建

```bash
npm run knowledge:build-all
```

依次执行：fetch-minecraft-data → fetch-mc-wiki-zh → build-mc-data-index → build-wiki-embeddings → cache-transformer-model。

支持 `--skip-data`、`--skip-wiki`、`--skip-embeddings`、`--skip-model` 单独跳过某步骤。

## 优雅降级

知识库资源缺失时（未构建或构建失败），agent 工具会返回明确的"服务不可用"提示，并给出构建命令建议。`vanilla_mc_wiki_query` 会自动回退到内置的本地知识文件。`fabric-agent-policy.ts` 中的护栏规则确保 agent 即使在知识库不可用时也不会凭记忆填写原版参数。

## 百科词条扩展

编辑 `scripts/knowledge/wiki-pages-list.json` 添加新词条后：
1. 运行 `npm run knowledge:fetch-wiki` 抓取
2. 运行 `npm run knowledge:build-wiki-embeddings` 重建向量索引

## 测试

知识库相关测试位于 `scripts/test/`：

- `harness-mc-data-lookup.test.ts` — `minecraft_data_lookup` 工具的查询、别名解析、配方附加、未命中提示等行为
- `harness-mc-wiki-search.test.ts` — `mc_wiki_search` 工具的服务可用性检查、懒加载初始化、结果格式化、topK 裁剪等行为
- `harness-knowledge-build.test.ts` — 知识库构建脚本的存在性、`wiki-pages-list.json` 数据结构、`build-mc-data-index.mjs` 端到端构建、`build-all.mjs` 参数解析等
