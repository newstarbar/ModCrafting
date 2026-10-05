---
name: vanilla-id-lookup
description: 把玩家口语需求转成原版标准 ID 与属性数值，避免凭记忆填参数。
---

# 原版 ID 与属性查询

用户描述通常是口语（「会爆炸的绿色怪物」「比铁还硬的石头」），注册代码需要的是标准 ID 与确切数值。本节讲两跳查询怎么串起来。

## 第 1 跳：语义 → 概念

描述模糊、带百科色彩时先 `mc_wiki_search`（中文 MC 百科向量库）：

- 返回词条含 `standardId`（如 `minecraft:creeper`）与相似度。
- 命中 0 条时不要臆测 ID，改用更通用的关键词（去掉修饰词，保留名词）再查一次。

## 第 2 跳：概念 → 结构化属性

`minecraft_data_lookup` 是写注册代码前的必经一步：

| 参数 | 用法 |
|------|------|
| `query` | 标准 ID、英文名或中文名都接受 |
| `kind` | 明确目标时显式给 `block` / `item` / `entity` / `enchantment`；不确定用 `auto`（按 block→item→entity→enchantment 依次尝试） |
| `includeRecipes` | 需要复刻或改造合成链时设 `true`，一并返回配方 |
| `mcVersion` | 一般省略，自动取项目 `fabric-versions.json` 的版本 |

它给出的硬度、爆炸抗性、堆叠上限、适用工具、耐久、生命值、附魔等级等，就是注册时应写的数值。**禁止**用记忆里的数值替代；原版属性随版本变过。

## 与 Fabric 注册的衔接

- 方块：`hardness` / `resistance` 直接来自 lookup；工具等级要映射成 `FabricBlockSetType` 与 `strength`，用 `fabric_docs_search` 确认 1.21.4 的 API 形态。
- 物品：`stackSize`、`fireResistant` 来自 lookup；装备类要另查 `EquipmentSlot`（`fabric_docs_search`）。
- 实体：lookup 给生命值与门宽等基础值；行为改造通常要靠 Mixin（见 mixin-nested-target）。
- 附魔：查等级上限与适用性，再决定 `EffectComponent` 写法。

## 冲突处理

lookup 结果与用户需求矛盾时（例如要求的硬度原版不存在），以「原版数值做基准 + 明确写出偏离原因」实现，并在总结里报告偏离，不要静默改掉用户要的属性。
