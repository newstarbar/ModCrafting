---
title: 战利品表生成
description: 使用 Datagen 设置战利品表生成的指南。
authors:
  - Alphagamer47
  - JustinHuPrime
  - matthewperiut
  - skycatminepokie
  - Spinoscythe
authors-nogithub:
  - jmanc3
  - mcrafterzz
---

:::info 前提
首先，请确保你已完成 [Datagen 设置](./setup) 。
:::

需要针对方块、箱子和实体提供不同的提供程序（类）。 请记住在 `onInitializeDataGenerator` 方法中的 `DataGeneratorEntrypoint` 中将它们全部添加到包中。


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


## 战利品表详解 {#loot-tables-explained}

**战利品表**定义了你破坏一个方块（不包括内容，如箱子里的东西）、杀死一个实体或打开一个新生成的容器所能得到的东西。 每个战利品表都有**随机池**，可从中选择物品。 战利品表还具有**函数**，可以通过某种方式修改最终的战利品。

战利品随机池有**抽取项（entries）**、**条件（conditions）**、函数（functions）、**抽取次数（rolls）**和**额外抽取次数（bonus rolls）**。 抽取项是物品的组、序列、可能性，或者仅仅是物品本身。 条件是在世界中需要被测试的事物，例如工具上的附魔或一个随机的概率。 随机池选择的最小抽取项数称为抽取次数（rolls），超过该数目的任何抽取项称为额外抽取次数（bonus rolls）。

## 方块 {#blocks}

为了让方块掉落物品（包括本身），我们需要制作一个战利品表。 创建一个 `extends FabricBlockLootTableProvider` 的类：


```java
public class FabricDocsReferenceBlockLootTableProvider extends FabricBlockLootTableProvider {
	protected FabricDocsReferenceBlockLootTableProvider(FabricDataOutput dataOutput, CompletableFuture<HolderLookup.Provider> registryLookup) {
		super(dataOutput, registryLookup);
	}

	@Override
	public void generate() {

	}
}
```


确保将此提供程序添加到包中！

有很多辅助方法可用于帮助构建战利品表。 我们不会逐一介绍，因此请确保在您的 IDE 中检查它们。

我们在 `generate` 方法中添加一些掉落物：


```java
		// Make condensed dirt drop its block item.
		// Also adds the condition that it survives the explosion that broke it, if applicable,
		dropSelf(ModBlocks.CONDENSED_DIRT);
		// Make prismarine lamps drop themselves with silk touch only
		dropWhenSilkTouch(ModBlocks.PRISMARINE_LAMP);
		// Make condensed oak logs drop between 7 and 9 oak logs
		add(ModBlocks.CONDENSED_OAK_LOG, LootTable.lootTable().withPool(applyExplosionCondition(Items.OAK_LOG, LootPool.lootPool()
				.setRolls(new UniformGenerator(new ConstantValue(7), new ConstantValue(9)))
				.add(LootItem.lootTableItem(Items.OAK_LOG))))
		);
```


## 箱子 {#chests}

箱子的战利品比方块的战利品稍微复杂一些。 创建一个类似于下面示例的 `extends SimpleFabricLootTableProvider` 类**并将其添加到您的包中**。


```java
public class FabricDocsReferenceChestLootTableProvider extends SimpleFabricLootTableProvider {
	public FabricDocsReferenceChestLootTableProvider(FabricDataOutput output, CompletableFuture<HolderLookup.Provider> registryLookup) {
		super(output, registryLookup, LootContextParamSets.CHEST);
	}

	@Override
	public void generate(BiConsumer<ResourceKey<LootTable>, LootTable.Builder> lootTableBiConsumer) {

	}
}
```


我们需要一个 `ResourceKey<LootTable>` 作为战利品表。 我们把它放入一个名为 `ModLootTables` 的新类中。 如果你使用拆分源，请确保它位于你的 `main` 源集中。


```java
public class ModLootTables {
	public static ResourceKey<LootTable> TEST_CHEST_LOOT = ResourceKey.create(Registries.LOOT_TABLE, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "chests/test_loot"));
}
```


然后，我们可以在提供程序的 `generate` 方法中生成一个战利品表。


```java
		lootTableBiConsumer.accept(ModLootTables.TEST_CHEST_LOOT, LootTable.lootTable()
				.withPool(LootPool.lootPool() // One pool
						.setRolls(ConstantValue.exactly(2.0f)) // That has two rolls
						.add(LootItem.lootTableItem(Items.DIAMOND) // With an entry that has diamond(s)
								.apply(SetItemCountFunction.setCount(ConstantValue.exactly(1.0f)))) // One diamond
						.add(LootItem.lootTableItem(Items.DIAMOND_SWORD) // With an entry that has a plain diamond sword
						)
				));
```

