---
title: 自定义魔咒效果
description: 学习如何创建自己的魔咒效果。
authors:
  - krizh-p
---

从 1.21 开始，Minecraft 中的自定义魔咒通过”数据驱动“的方式添加。 这让添加一些简单的魔咒（如增加攻击伤害）变得更容易，但创建复杂的魔咒则更具挑战性。 这个过程包括将魔咒分解成 _效果组件_。

效果组件包含定义魔咒特殊效果的代码。 Minecraft 原版已支持一些默认效果，例如物品损害值、击退和经验。

:::tip
来看看 [Minecraft Wiki 的附魔效果组件页面](https://zh.minecraft.wiki/w/%E9%AD%94%E5%92%92%E6%95%B0%E6%8D%AE%E6%A0%BC%E5%BC%8F#%E5%AE%9A%E4%B9%89)，检查 Minecraft 默认效果是否满足你的需求。 本指南假定你了解如何配置“简单”的数据驱动魔咒，并侧重于创建默认不支持的自定义魔咒效果。
:::

## 自定义魔咒效果 {#custom-enchantment-effects}

先创建 `enchantment` 文件夹，然后在里面创建 `effect` 文件夹。 在里面，创建记录类 `LightningEnchantmentEffect`。

现在，创建构造器，并覆盖 `EnchantmentEntityEffect` 接口的方法。 还要创建 `CODEC` 变量以编码解码我们的效果，可以了解更多[关于 codec 的信息](../codecs)。

我们的大部分代码都将进入 `apply()` 事件，当魔咒生效的条件得到满足时，该事件就会被调用。 我们稍后会配置这个 `Effect` 以在实体被击中时调用，但现在，让我们编写简单的代码来实现用闪电击中目标。


```java
package com.example.docs.enchantment.effect;

import com.mojang.serialization.MapCodec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.enchantment.EnchantedItemInUse;
import net.minecraft.world.item.enchantment.LevelBasedValue;
import net.minecraft.world.item.enchantment.effects.EnchantmentEntityEffect;
import net.minecraft.world.phys.Vec3;

//#entrypoint
public record LightningEnchantmentEffect(LevelBasedValue amount) implements EnchantmentEntityEffect {
	public static final MapCodec<LightningEnchantmentEffect> CODEC = RecordCodecBuilder.mapCodec(instance ->
			instance.group(
					LevelBasedValue.CODEC.fieldOf("amount").forGetter(LightningEnchantmentEffect::amount)
			).apply(instance, LightningEnchantmentEffect::new)
	);

	@Override
	public void apply(ServerLevel world, int level, EnchantedItemInUse context, Entity target, Vec3 pos) {
		if (target instanceof LivingEntity victim) {
			if (context.owner() != null && context.owner() instanceof Player player) {
				float numStrikes = this.amount.calculate(level);

				for (float i = 0; i < numStrikes; i++) {
					BlockPos position = victim.blockPosition();
					EntityType.LIGHTNING_BOLT.spawn(world, position, EntitySpawnReason.TRIGGERED);
				}
			}
		}
	}

	@Override
	public MapCodec<? extends EnchantmentEntityEffect> codec() {
		return CODEC;
	}
}
```


这里，变量 `amount` 表示与附魔等级成比例的数值。 我们可以根据等级来修改魔咒的效果。 在上面的代码中，我们使用附魔的等级来决定生成多少闪电。

## 注册魔咒效果 {#registering-the-enchantment-effect}

就像我们的模组中的其他部分，我们将会把我们的 `EnchantmentEffect` 加入到 Minecraft 的注册表中。 为了实现这一点，添加一个叫做 `ModEnchantmentEffects`（或者你想叫什么就叫什么）的类，和一个辅助方法来注册我们的魔咒。 确保在你的主类中调用 `registerModEnchantmentEffects()` 方法，这个主类应该包含 `onInitialize()` 方法。


```java
package com.example.docs.enchantment;

import com.mojang.serialization.MapCodec;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.effects.EnchantmentEntityEffect;
import com.example.docs.FabricDocsReference;
import com.example.docs.enchantment.effect.LightningEnchantmentEffect;

//#entrypoint
public class ModEnchantmentEffects {
	public static final ResourceKey<Enchantment> THUNDERING = of("thundering");
	public static MapCodec<LightningEnchantmentEffect> LIGHTNING_EFFECT = register("lightning_effect", LightningEnchantmentEffect.CODEC);

	private static ResourceKey<Enchantment> of(String path) {
		ResourceLocation id = ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, path);
		return ResourceKey.create(Registries.ENCHANTMENT, id);
	}

	private static <T extends EnchantmentEntityEffect> MapCodec<T> register(String id, MapCodec<T> codec) {
		return Registry.register(BuiltInRegistries.ENCHANTMENT_ENTITY_EFFECT_TYPE, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, id), codec);
	}

	public static void registerModEnchantmentEffects() {
		FabricDocsReference.LOGGER.info("Registering EnchantmentEffects for" + FabricDocsReference.MOD_ID);
	}
}
```


## 创建魔咒 {#creating-the-enchantment}

现在我们有了一个魔咒效果！ 最后一步是创建一个魔咒，应用我们自定义的效果。 这可以通过创建类似于 Minecraft 数据包中的 JSON 文件来实现，在这篇文档中，将向你展示如何使用 Fabric 的数据生成工具来动态生成 JSON。 要开始，请创建一个名为 `EnchantmentGenerator` 的类。

在这个类中，我们先注册我们的魔咒对象，并使用 `configure()` 方法来在程序中创建 JSON。


```java
package com.example.docs.datagen;

import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.datagen.v1.FabricDataOutput;
import net.fabricmc.fabric.api.datagen.v1.provider.FabricDynamicRegistryProvider;
import net.fabricmc.fabric.api.resource.conditions.v1.ResourceCondition;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.entity.EquipmentSlotGroup;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.EnchantmentEffectComponents;
import net.minecraft.world.item.enchantment.EnchantmentTarget;
import net.minecraft.world.item.enchantment.LevelBasedValue;
import com.example.docs.enchantment.ModEnchantmentEffects;
import com.example.docs.enchantment.effect.LightningEnchantmentEffect;

//#entrypoint
public class EnchantmentGenerator extends FabricDynamicRegistryProvider {
	public EnchantmentGenerator(FabricDataOutput output, CompletableFuture<HolderLookup.Provider> registriesFuture) {
		super(output, registriesFuture);
		System.out.println("REGISTERING ENCHANTS");
	}

	@Override
	protected void configure(HolderLookup.Provider registries, Entries entries) {
		// Our new enchantment, "Thundering."
		register(entries, ModEnchantmentEffects.THUNDERING, Enchantment.enchantment(
				Enchantment.definition(
					registries.lookupOrThrow(Registries.ITEM).getOrThrow(ItemTags.WEAPON_ENCHANTABLE),
					// this is the "weight" or probability of our enchantment showing up in the table
					10,
					// the maximum level of the enchantment
					3,
					// base cost for level 1 of the enchantment, and min levels required for something higher
					Enchantment.dynamicCost(1, 10),
					// same fields as above but for max cost
					Enchantment.dynamicCost(1, 15),
					// anvil cost
					5,
					// valid slots
					EquipmentSlotGroup.HAND
				)
			)
					.withEffect(
						// enchantment occurs POST_ATTACK
						EnchantmentEffectComponents.POST_ATTACK,
						EnchantmentTarget.ATTACKER,
						EnchantmentTarget.VICTIM,
						new LightningEnchantmentEffect(LevelBasedValue.perLevel(0.4f, 0.2f)) // scale the enchantment linearly.
					)
		);
	}

	private void register(Entries entries, ResourceKey<Enchantment> key, Enchantment.Builder builder, ResourceCondition... resourceConditions) {
		entries.add(key, builder.build(key.location()), resourceConditions);
	}

	@Override
	public String getName() {
		return "ReferenceDocEnchantmentGenerator";
	}
}
```


在继续之前，应确保你的项目已为数据生成进行了配置。如果您不确定，请 [查看相关文档页面](../data-generation/setup)。

在最后，我们必须要告诉我们的模组去把 `EnchantmentGenerator` 加入到数据生成任务列表中。 为了实现这一点，只需要简单的把 `EnchantmentGenerator` 加入到 `onInitializeDataGenerator` 方法中。


```java
package com.example.docs.datagen;

import static com.example.docs.datagen.FabricDocsReferenceDamageTypesProvider.TATER_DAMAGE_TYPE;

import net.fabricmc.fabric.api.datagen.v1.DataGeneratorEntrypoint;
import net.fabricmc.fabric.api.datagen.v1.FabricDataGenerator;
import net.minecraft.core.RegistrySetBuilder;
import net.minecraft.core.registries.Registries;
import com.example.docs.damage.FabricDocsReferenceDamageTypes;
import com.example.docs.datagen.internal.FabricDocsReferenceInternalModelProvider;
import com.example.docs.network.basic.FabricDocsReferenceNetworkingBasicModelProvider;

// :::datagen-setup:generator
public class FabricDocsReferenceDataGenerator implements DataGeneratorEntrypoint {
	@Override
	public void onInitializeDataGenerator(FabricDataGenerator fabricDataGenerator) {
		// :::datagen-setup:generator
		// :::datagen-setup:pack
		FabricDataGenerator.Pack pack = fabricDataGenerator.createPack();
		// :::datagen-setup:pack

		pack.addProvider(EnchantmentGenerator::new);

		pack.addProvider(FabricDocsReferenceAdvancementProvider::new);

		pack.addProvider(FabricDocsReferenceEnglishLangProvider::new);

		pack.addProvider(FabricDocsReferenceItemTagProvider::new);

		pack.addProvider(FabricDocsReferenceRecipeProvider::new);

		pack.addProvider(FabricDocsReferenceBlockLootTableProvider::new);
		pack.addProvider(FabricDocsReferenceChestLootTableProvider::new);

		pack.addProvider(FabricDocsReferenceDamageTypesProvider.TaterDamageTypesGenerator::new);
		pack.addProvider(FabricDocsReferenceDamageTypesProvider.TaterDamageTypeTagGenerator::new);

		pack.addProvider(FabricDocsReferenceInternalModelProvider::new);

		pack.addProvider(FabricDocsReferenceModelProvider::new);

		pack.addProvider(FabricDocsReferenceNetworkingBasicModelProvider::new);

		// :::datagen-setup:generator
	}

	// :::datagen-setup:generator
	@Override
	public void buildRegistry(RegistrySetBuilder registryBuilder) {
		registryBuilder.add(Registries.DAMAGE_TYPE, registerable -> {
			registerable.register(FabricDocsReferenceDamageTypes.TATER_DAMAGE, TATER_DAMAGE_TYPE);
		});
	}

	// :::datagen-setup:generator
}
// :::datagen-setup:generator
```


现在，当你运行你的模组的数据生成任务，附魔表 JSON 将会生成在 `generated` 文件夹内。 下面是一个例子：


```json
{
  "anvil_cost": 5,
  "description": {
    "translate": "enchantment.fabric-docs-reference.thundering"
  },
  "effects": {
    "minecraft:post_attack": [
      {
        "affected": "victim",
        "effect": {
          "type": "fabric-docs-reference:lightning_effect",
          "amount": {
            "type": "minecraft:linear",
            "base": 0.4,
            "per_level_above_first": 0.2
          }
        },
        "enchanted": "attacker"
      }
    ]
  },
  "max_cost": {
    "base": 1,
    "per_level_above_first": 15
  },
  "max_level": 3,
  "min_cost": {
    "base": 1,
    "per_level_above_first": 10
  },
  "slots": [
    "hand"
  ],
  "supported_items": "#minecraft:enchantable/weapon",
  "weight": 10
}
```


你需要在 `zh_cn.json` 中给你的自定义魔咒添加一个有意义的名字：

```json
"enchantment.FabricDocsReference.thundering": "Thundering",
```

现在你应该有了一个可以正常工作的自定义附魔效果！ 附魔一个武器，然后攻击一个生物试试吧。 下面的视频里有一个例子：

<VideoPlayer src="/assets/develop/enchantment-effects/thunder.webm">使用雷电（Thundering）魔咒</VideoPlayer>
