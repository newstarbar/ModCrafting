# Minecraft 知识库

MCP 工具按需读取 Fabric/Minecraft 开发知识。没有资源时返回缺失状态；除非 Agent 或用户明确调用 `modcrafting_prepare_assets`，启动和环境检查不会下载大型资源。

## 可准备资源

| 名称 | 内容 | 用途 |
|---|---|---|
| `minecraft-data` | Minecraft 1.21.4 的结构化方块、物品、实体、附魔和配方数据 | `minecraft_data_lookup` |
| `mc-wiki-zh` | 中文 Minecraft 百科条目 | `mc_wiki_search` |
| `mc-wiki-zh-index` | 百科检索索引 | 加速关键词查询 |
| `agent-knowledge` | Fabric 官方开发文档 | `fabric_docs_search` |

示例：

```json
{ "names": ["minecraft-data", "agent-knowledge"] }
```

成功、缺失和无效资源按项返回。已存在且健康的资源会复用。`modcrafting_prepare_assets` 支持可选 `projectPath`：传入时资源写入该工程目录下的 `.modcrafting/knowledge`（Fabric 文档在 `.modcrafting/assets`），随工程存放，不占用用户全局目录；未传入时写入当前后端 `MODCRAFTING_DATA` 下的资源目录。`minecraft_data_lookup`、`mc_wiki_search`、`fabric_docs_search` 和配方/内容工作区按相同规则读取：有 `projectPath` 读工程内知识库，否则读后端目录。资源准备不修改 Minecraft 安装、工程源码或其他 session 的游戏目录。新建工程由脚手架自动把 `.modcrafting/` 写入 `.gitignore`；已有工程建议自行加入 `.gitignore`。

## 数据来源与更新

Minecraft 结构化数据、Wiki 文档和索引从 [ModCrafting knowledge-base](https://github.com/newstarbar/ModCrafting-knowledge-base) 的对应版本资源获取。Fabric 官方文档快照位于 `resources/agent-knowledge/fabric/docs/`，用 `pnpm run docs:sync-fabric` 更新源码仓库中的快照。

网络资源只在显式准备时下载。资源准备成功只说明本地资源可读，不代表查询结果一定完整、Minecraft 已启动或游戏测试通过。

## 代码生成规则

新增原版方块、物品、实体或附魔注册代码前，Agent 应先调用 `minecraft_data_lookup` 查询标准 ID 和原版属性。原版规则或玩家描述不明确时，再调用 `mc_wiki_search`；Fabric 注册和 API 细节调用 `fabric_docs_search`。查询不到时应报告缺少依据，不凭记忆补造参数。
