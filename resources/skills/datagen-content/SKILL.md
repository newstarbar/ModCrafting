---
name: datagen-content
description: 配方、战利品表、模型与语言文件的生成顺序，以及每类产物的校验证据。
---

# 内容产物与数据文件

新增方块/物品后要在原版配方与渲染里站得住，需要一组 data/assets 文件。顺序错了会出现「代码没问题但游戏里是紫黑块 / 挖不出东西」。

## 1. 注册顺序

1. Java 注册类（方块/物品）与 `fabric_content_register`。
2. `fabric_data_assets_generate`：`{ namespace, name, kind: "item" | "block", displayName? }` → 生成 lang、item model、blockstate、block model。
3. 需要掉落时写战利品表 `data/<namespace>/loot_table/blocks/<name>.json`（方块类必须有自己的掉落表，否则挖掘无产出）。
4. 配方见下。

## 2. 配方不要手写 JSON

- 无序合成用 `create_recipe`：`{ namespace, name, ingredients, result, count? }`，`ingredients` 支持重复字符串或 `{ item, count }`。
- 有序/熔炼/切割用 `fabric_recipe_generate`：`{ namespace, name, type, result, ... }`，`type` ∈ `shapeless | shaped | smelting | blasting | stonecutting`；`shaped` 需要 `pattern` + `keys`，单料类（smelting/stonecutting）用 `ingredient`。
- 两者都会自动跑结构校验并返回 `recipe` 证据。**校验失败时按报错改参数再调一次，不要改成手搓 `write_file` 写配方 JSON**——那会绕过校验，游戏里静默不生效。
- 1.21.4 的配方目录是 `data/<namespace>/recipe/`（单数）。工具已按版本处理路径，手工写文件时注意别再沿用旧版 `recipes/`。

## 3. 物品 ID 引用格式

配方与掉落表里的 `item` 一律写完整命名空间：原版 `minecraft:diamond`，自己的 `<modid>:<name>`。只写 `diamond` 会被解析为 `minecraft:diamond`，是常见错误来源。

不确定原版 ID 时先 `minecraft_data_lookup`（见 vanilla-id-lookup 技能）。

## 4. 语言与命名

`fabric_data_assets_generate` 会写 `assets/<namespace>/lang/zh_cn.json`，翻译 key 形如 `block.<namespace>.<name>` 或 `item.<namespace>.<name>`。游戏里显示成 `block.<modid>.<name>` 原文，就说明 lang 缺该 key——补语言文件，不要去改注册名。

## 5. 验证

构建通过只证明资源文件是合法 JSON。真正的证据来自游戏内：`mc_test_scenario`（`feature_type` 选 `new_block` / `new_item` / `new_recipe`）+ `mc_run_test`。配方类功能建议断言「合成结果数量与物品 ID」，方块类断言「放置后存在 + 挖掘掉落对应物品」。
