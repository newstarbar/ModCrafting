---
title: 进度生成
description: 使用 Datagen 设置进度生成的指南。
authors:
  - MattiDragon
  - skycatminepokie
  - Spinoscythe
authors-nogithub:
  - jmanc3
  - mcrafterzz
---

:::info 前提
首先，请确保你已完成 [Datagen 设置](./setup) 。
:::

## 设置 {#setup}

首先，我们需要创建 Provider。 创建一个继承 `FabricAdvancementProvider` 的类，并填入基本方法：


```java
public class FabricDocsReferenceAdvancementProvider extends FabricAdvancementProvider {
	protected FabricDocsReferenceAdvancementProvider(FabricDataOutput output, CompletableFuture<HolderLookup.Provider> registryLookup) {
		super(output, registryLookup);
	}

	@Override
	public void generateAdvancement(HolderLookup.Provider wrapperLookup, Consumer<AdvancementHolder> consumer) {

	}
}
```


要完成设置，请将此提供程序添加到 `onInitializeDataGenerator` 方法中的 `DataGeneratorEntrypoint`。


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


## 进度结构 {#advancement-structure}

一项进度是由几个不同的部分组成的。 除了称为“准则”的要求外，它可能还具有：

- `DisplayInfo` 告诉游戏如何向玩家展示进度，
- `AdvancementRequirements` 是一系列准则的列表，要求每个子列表中至少完成一项准则，
- `AdvancementRewards` 是玩家完成进度后获得的奖励。
- `Strategy` 告诉进度如何处理多个准则，以及
- 父级 `Advancement`，用于组织您在“进度”屏幕上看到的层次结构。

## 简单进度 {#simple-advancements}

以下是获取土块的简单进度：


```java
		AdvancementHolder getDirt = Advancement.Builder.advancement()
				.display(
						Items.DIRT, // The display icon
						Component.literal("Your First Dirt Block"), // The title
						Component.literal("Now make a house from it"), // The description
						ResourceLocation.withDefaultNamespace("textures/gui/advancements/backgrounds/adventure.png"), // Background image for the tab in the advancements page, if this is a root advancement (has no parent)
						AdvancementType.TASK, // TASK, CHALLENGE, or GOAL
						true, // Show the toast when completing it
						true, // Announce it to chat
						false // Hide it in the advancement tab until it's achieved
				)
				// "got_dirt" is the name referenced by other advancements when they want to have "requirements."
				.addCriterion("got_dirt", InventoryChangeTrigger.TriggerInstance.hasItems(Items.DIRT))
				// Give the advancement an id
				.save(consumer, FabricDocsReference.MOD_ID + ":get_dirt");
```


:::warning
当构建你的进度条目时，请记住函数接受 `String` 格式的进度的 `ResourceLocation`！
:::

:::details JSON 输出

```json
{
  "criteria": {
    "got_dirt": {
      "conditions": {
        "items": [
          {
            "items": "minecraft:dirt"
          }
        ]
      },
      "trigger": "minecraft:inventory_changed"
    }
  },
  "display": {
    "background": "minecraft:textures/gui/advancements/backgrounds/adventure.png",
    "description": "Now make a house from it",
    "icon": {
      "count": 1,
      "id": "minecraft:dirt"
    },
    "title": "Your First Dirt Block"
  },
  "requirements": [
    [
      "got_dirt"
    ]
  ],
  "sends_telemetry_event": true
}
```

:::

## 另一个示例 {#one-more-example}

为了掌握要领，我们再添加一项进度。 我们将练习添加奖励、使用多项准则以及指定父级：


```java
		final HolderLookup.RegistryLookup<Item> itemLookup = wrapperLookup.lookupOrThrow(Registries.ITEM);
		AdvancementHolder appleAndBeef = Advancement.Builder.advancement()
				.parent(getDirt)
				.display(
						Items.APPLE,
						Component.literal("Apple and Beef"),
						Component.literal("Ate an apple and beef"),
						null, // Children don't need a background, the root advancement takes care of that
						AdvancementType.CHALLENGE,
						true,
						true,
						false
				)
				.addCriterion("ate_apple", ConsumeItemTrigger.TriggerInstance.usedItem(itemLookup, Items.APPLE))
				.addCriterion("ate_cooked_beef", ConsumeItemTrigger.TriggerInstance.usedItem(itemLookup, Items.COOKED_BEEF))
				.save(consumer, FabricDocsReference.MOD_ID + ":apple_and_beef");
```


## 自定义准则 {#custom-criteria}

:::warning
虽然 datagen 可以在客户端，但是 `Criterion` 和 `Predicate` 位于主源集（双方）中，因为服务器需要触发和评估它们。
:::

### 定义 {#definitions}

**准则**（英语：criterion/criteria）是指玩家可以做的事情（或可能发生在玩家身上的事情），这些事情可以被计入进度的达成。 游戏附带许多[准则](https://zh.minecraft.wiki/w/%E8%BF%9B%E5%BA%A6%E5%AE%9A%E4%B9%89%E6%A0%BC%E5%BC%8F#%E5%87%86%E5%88%99%E8%A7%A6%E5%8F%91%E5%99%A8)，可以在 `net.minecraft.advancement.criterion` 包中找到。 一般来说，仅当您在游戏中实现自定义机制时才需要新的准则。

**条件**是根据准则来评估的。 只有满足所有相关条件时，准则才会被计入。 条件通常用谓词来表达。

**谓词**是一种接受值并返回 `boolean` 的东西。 例如，如果物品是钻石，则 `Predicate<Item>` 可能返回 `true`，而如果实体与村民不敌对，则 `Predicate<LivingEntity>` 可能返回 `true`。

### 创建自定义准则 {#creating-custom-criteria}

首先，我们需要实现一个新的机制。 让我们告诉玩家每次破坏方块时他们使用了什么工具。


```java
public class FabricDocsReferenceDatagenAdvancement implements ModInitializer {
	@Override
	public void onInitialize() {

		HashMap<Item, Integer> tools = new HashMap<>();

		PlayerBlockBreakEvents.AFTER.register(((world, player, blockPos, blockState, blockEntity) -> {
			if (player instanceof ServerPlayer serverPlayer) { // Only triggers on the server side
				Item item = player.getMainHandItem().getItem();

				Integer usedCount = tools.getOrDefault(item, 0);
				usedCount++;
				tools.put(item, usedCount);

				serverPlayer.sendSystemMessage(Component.nullToEmpty("You've used \"" + item + "\" as a tool " + usedCount + " times!"));
			}
		}));
	}
}
```


请注意，这个代码确实很烂。 `HashMap` 没有存储在任何持久位置，因此每次重新启动游戏时它都会被重置。 这只是为了展示 `Criterion`。 开始游戏并且试一下吧！

接下来，让我们创建自定义准则 `UseToolCriterion`。 它将需要自己的 `Conditions` 类来配合它，因此我们将同时创建它们：


```java
public class UseToolCriterion extends SimpleCriterionTrigger<UseToolCriterion.Conditions> {

	@Override
	public Codec<Conditions> codec() {
		return Conditions.CODEC;
	}

	public record Conditions(Optional<ContextAwarePredicate> playerPredicate) implements SimpleCriterionTrigger.SimpleInstance {
		public static Codec<UseToolCriterion.Conditions> CODEC = ContextAwarePredicate.CODEC.optionalFieldOf("player")
				.xmap(Conditions::new, Conditions::player).codec();

		@Override
		public Optional<ContextAwarePredicate> player() {
			return playerPredicate;
		}

	}
}
```


哇，好多呀！ 让我们分解一下。

- `UseToolCriterion` 是一个 `SimpleCriterionTrigger`，`Conditions` 可以应用于它。
- `Conditions` 有一个 `playerPredicate` 字段。 所有的 `Conditions` 都应有一个玩家谓词（技术上来讲是 LootContextPredicate\`）。
- `Conditions` 也有一个 `CODEC`。 这个 `Codec` 只是其一个字段 `playerPredicate` 的 codec，带有在它们之间进行转换的额外指令（`xmap`）。

:::info
要了解有关 codec 的更多信息，请参阅 [Codec](../codecs) 页面。
:::

我们需要一种方法来检查条件是否满足。 我们向 `Conditions` 添加一个辅助方法：


```java
		public boolean requirementsMet() {
			return true; // AbstractCriterion#trigger helpfully checks the playerPredicate for us.
		}
```


现在我们已经有了准则及其条件，我们需要一种触发它的方式。 为 `UseToolCriterion` 添加一个触发方法：


```java
	public void trigger(ServerPlayer player) {
		trigger(player, Conditions::requirementsMet);
	}
```


快完成了！ 接下来，我们需要一个可以使用的准则实例。 我们把它放入一个名为 `ModCriteria` 的新类中。


```java
public class ModCriteria {
	// :::datagen-advancements:mod-criteria-init

	// :::datagen-advancements:new-mod-criteria
	public static final ParameterizedUseToolCriterion PARAMETERIZED_USE_TOOL = CriteriaTriggers.register(FabricDocsReference.MOD_ID + ":parameterized_use_tool", new ParameterizedUseToolCriterion());

}
```


为了确保我们的准则在正确的时间进行初始化，添加一个空白的 `init` 方法：


```java
	// :::datagen-advancements:mod-criteria
	public static final UseToolCriterion USE_TOOL = CriteriaTriggers.register(FabricDocsReference.MOD_ID + ":use_tool", new UseToolCriterion());
	// :::datagen-advancements:mod-criteria
	// :::datagen-advancements:new-mod-criteria
	public static final ParameterizedUseToolCriterion PARAMETERIZED_USE_TOOL = CriteriaTriggers.register(FabricDocsReference.MOD_ID + ":parameterized_use_tool", new ParameterizedUseToolCriterion());

	// :::datagen-advancements:mod-criteria
```


并在你的模组初始化程序中调用它：


```java
		ModCriteria.init();
```


最后，我们需要触发我们的准则。 将其添加到我们在主模组类中向玩家发送消息的地方。


```java
				ModCriteria.USE_TOOL.trigger(serverPlayer);
```


你的崭新准则现已可供使用！ 我们将其添加到我们的提供程序中：


```java
		AdvancementHolder breakBlockWithTool = Advancement.Builder.advancement()
				.parent(getDirt)
				.display(
						Items.DIAMOND_SHOVEL,
						Component.literal("Not a Shovel"),
						Component.literal("That's not a shovel (probably)"),
						null,
						AdvancementType.GOAL,
						true,
						true,
						false
				)
				.addCriterion("break_block_with_tool", ModCriteria.USE_TOOL.createCriterion(new UseToolCriterion.Conditions(Optional.empty())))
				.save(consumer, FabricDocsReference.MOD_ID + ":break_block_with_tool");
```


再次运行 datagen 任务，您就可以获得新的进度了！

## 带参数的条件 {#conditions-with-parameters}

这一切都很好，但是如果我们只想在做了 5 次之后才授予进度该怎么办呢？ 那为什么不再来一个 10 次的呢？ 为此，我们需要为条件提供一个参数。 您可以继续使用 `UseToolCriterion`，也可以遵循新的 `ParameterizedUseToolCriterion`。 实际上，您应该只拥有一个参数化版本，但在本教程中我们将保留这两个版本。

让我们自下而上地开展工作。 我们需要检查要求是否满足，因此让我们编辑 `Conditions#requirementsMet` 方法：


```java
		public boolean requirementsMet(int totalTimes) {
			return totalTimes > requiredTimes; // AbstractCriterion#trigger helpfully checks the playerPredicate for us.
		}
```


`requiredTimes` 不存在，因此将其作为 `Conditions` 的一个参数：


```java
	public record Conditions(Optional<ContextAwarePredicate> playerPredicate, int requiredTimes) implements SimpleCriterionTrigger.SimpleInstance {
```


现在我们的 codec 在报错。 让我们为新的变更编写一个新的 codec：


```java
// region datagen-advancements:new-codec not found — showing file head
package com.example.docs.advancement;

import java.util.Optional;
import net.minecraft.advancements.critereon.ContextAwarePredicate;
import net.minecraft.advancements.critereon.SimpleCriterionTrigger;
import net.minecraft.server.level.ServerPlayer;
import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;

/**
 * {@link UseToolCriterion} but with a parameter. Separated because there was no way to show the process to parameterize
 * in just one class.
 */
public class ParameterizedUseToolCriterion extends SimpleCriterionTrigger<ParameterizedUseToolCriterion.Conditions> {
	// :::datagen-advancements:new-trigger
	public void trigger(ServerPlayer player, int totalTimes) {
		trigger(player, conditions -> conditions.requirementsMet(totalTimes));
	}

	// :::datagen-advancements:new-trigger

	@Override
	public Codec<Conditions> codec() {
		return Conditions.CODEC;
	}

	// :::datagen-advancements:new-parameter
	public record Conditions(Optional<ContextAwarePredicate> playerPredicate, int requiredTimes) implements SimpleCriterionTrigger.SimpleInstance {
		// :::datagen-advancements:new-parameter
		// :::datagen-advancements:new-codec
		public static Codec<ParameterizedUseToolCriterion.Conditions> CODEC = RecordCodecBuilder.create(instance -> instance.group(
				ContextAwarePredicate.CODEC.optionalFieldOf("player").forGetter(Conditions::player),
				Codec.INT.fieldOf("requiredTimes").forGetter(Conditions::requiredTimes)
		).apply(instance, Conditions::new));
		// :::datagen-advancements:new-parameter
		@Override
		public Optional<ContextAwarePredicate> player() {
			return playerPredicate;
		}

```


接下来，我们需要修复我们的 `trigger` 方法：


```java
	public void trigger(ServerPlayer player, int totalTimes) {
		trigger(player, conditions -> conditions.requirementsMet(totalTimes));
	}
```


如果你制定了新准则，我们需要将其添加到 `ModCriteria`


```java
	public static final ParameterizedUseToolCriterion PARAMETERIZED_USE_TOOL = CriteriaTriggers.register(FabricDocsReference.MOD_ID + ":parameterized_use_tool", new ParameterizedUseToolCriterion());

	// :::datagen-advancements:mod-criteria
	// :::datagen-advancements:mod-criteria-init
	public static void init() {
	}
```


然后在主类中调用它，就在原来的位置：


```java
				ModCriteria.PARAMETERIZED_USE_TOOL.trigger(serverPlayer, usedCount);
```


将进度添加到您的提供程序：


```java
		AdvancementHolder breakBlockWithToolFiveTimes = Advancement.Builder.advancement()
				.parent(breakBlockWithTool)
				.display(
						Items.GOLDEN_SHOVEL,
						Component.literal("Not a Shovel Still"),
						Component.literal("That's still not a shovel (probably)"),
						null,
						AdvancementType.GOAL,
						true,
						true,
						false
				)
				.addCriterion("break_block_with_tool_five_times", ModCriteria.PARAMETERIZED_USE_TOOL.createCriterion(new ParameterizedUseToolCriterion.Conditions(Optional.empty(), 5)))
				.save(consumer, FabricDocsReference.MOD_ID + ":break_block_with_tool_five_times");
```


再次运行 datagen，就搞定了！
