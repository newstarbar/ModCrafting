---
title: 自定义创造标签页
description: 学习如何创建自己的创造标签页，并向其中添加物品。
authors:
  - CelDaemon
  - IMB11
---

创造标签页，也称为物品组，是创造模式物品栏中用于存储物品的标签页。 你可以创建自己的创造标签页，将你的物品存储在单独的标签页中。 如果你的模组添加许多物品，需要保持组织在你的玩家容易访问的一个位置中，这就非常有用。

## 创建创造标签页 {#creating-the-creative-tab}

添加创造标签页非常简单。 在你的物品类中就创建一个新的静态常量字段，存储其创造模式物品栏以及相应的资源键。 你可以使用 `FabricCreativeModeTab.builder` 来创建标签页，并为其添加物品：


```java
// region custom_creative_tab not found — showing file head
package com.example.docs.item;

import java.util.function.Function;
import net.fabricmc.fabric.api.itemgroup.v1.FabricItemGroup;
import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;
import net.fabricmc.fabric.api.registry.CompostingChanceRegistry;
import net.fabricmc.fabric.api.registry.FuelRegistryEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.ArmorItem;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.SwordItem;
import net.minecraft.world.item.ToolMaterial;
import net.minecraft.world.item.component.Consumable;
import net.minecraft.world.item.component.Consumables;
import net.minecraft.world.item.consume_effects.ApplyStatusEffectsConsumeEffect;
import net.minecraft.world.item.equipment.ArmorType;
import com.example.docs.FabricDocsReference;
import com.example.docs.component.ModComponents;
import com.example.docs.item.armor.GuiditeArmorMaterial;
import com.example.docs.item.custom.CounterItem;
import com.example.docs.item.custom.LightningStick;

// :::1
public class ModItems {
	// :::1

	// :::guidite_tool_material
	public static final ToolMaterial GUIDITE_TOOL_MATERIAL = new ToolMaterial(
```


```java
// region register_creative_tab not found — showing file head
package com.example.docs.item;

import java.util.function.Function;
import net.fabricmc.fabric.api.itemgroup.v1.FabricItemGroup;
import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;
import net.fabricmc.fabric.api.registry.CompostingChanceRegistry;
import net.fabricmc.fabric.api.registry.FuelRegistryEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.ArmorItem;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.SwordItem;
import net.minecraft.world.item.ToolMaterial;
import net.minecraft.world.item.component.Consumable;
import net.minecraft.world.item.component.Consumables;
import net.minecraft.world.item.consume_effects.ApplyStatusEffectsConsumeEffect;
import net.minecraft.world.item.equipment.ArmorType;
import com.example.docs.FabricDocsReference;
import com.example.docs.component.ModComponents;
import com.example.docs.item.armor.GuiditeArmorMaterial;
import com.example.docs.item.custom.CounterItem;
import com.example.docs.item.custom.LightningStick;

// :::1
public class ModItems {
	// :::1

	// :::guidite_tool_material
	public static final ToolMaterial GUIDITE_TOOL_MATERIAL = new ToolMaterial(
```

你现在应该可以在创造模式物品栏菜单内看到新的标签页了。 然而还没有翻译——必须给你的翻译文件添加翻译键——类似于翻译你的第一个物品的方式。

![创造模式菜单内没有翻译的创造标签页](/assets/develop/items/itemgroups_0.png)

## 添加翻译键 {#adding-a-translation-key}

如果你在创造标签页 builder 的 `title` 方法中使用了 `Component.translatable`，则需要将翻译添加到语言文件中。

```json
{
  "creativeTab.example-mod": "Example Mod"
}
```

现在如你所见，创造标签页的名称应该已正确命名：

![完全完成的创造标签页，包含翻译和物品](/assets/develop/items/itemgroups_1.png)
