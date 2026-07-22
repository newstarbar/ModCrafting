---
title: 配方生成
description: 使用 Datagen 设置配方生成的指南。
authors:
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

首先，我们需要提供程序。 创建一个 `extends FabricRecipeProvider` 的类。 我们所有的配方生成都将在提供程序的 `generate` 方法中进行。


```java
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.datagen.v1.FabricDataOutput;
import net.fabricmc.fabric.api.datagen.v1.provider.FabricRecipeProvider;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.Registries;
import net.minecraft.data.recipes.RecipeCategory;
import net.minecraft.data.recipes.RecipeOutput;
import net.minecraft.data.recipes.RecipeProvider;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.crafting.Ingredient;

public class FabricDocsReferenceRecipeProvider extends FabricRecipeProvider {
	public FabricDocsReferenceRecipeProvider(FabricDataOutput output, CompletableFuture<HolderLookup.Provider> registriesFuture) {
		super(output, registriesFuture);
	}

	@Override
	protected RecipeProvider createRecipeProvider(HolderLookup.Provider registryLookup, RecipeOutput exporter) {
		return new RecipeProvider(registryLookup, exporter) {
			@Override
			public void buildRecipes() {
				HolderLookup.RegistryLookup<Item> itemLookup = registries.lookupOrThrow(Registries.ITEM);

			}
		};
	}

	@Override
	public String getName() {
		return "FabricDocsReferenceRecipeProvider";
	}
}
```


要完成设置，将此提供程序添加到 `onInitializeDataGenerator` 方法中的 `DataGeneratorEntrypoint`。


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


## 无序配方 {#shapeless-recipes}

无序配方相当的简单。 只需将它们添加到提供程序中的 `generate` 方法中：


```java

				shapeless(RecipeCategory.BUILDING_BLOCKS, Items.DIRT) // You can also specify an int to produce more than one
						.requires(Items.COARSE_DIRT) // You can also specify an int to require more than one, or a tag to accept multiple things
						// Create an advancement that gives you the recipe
						.unlockedBy(getHasName(Items.COARSE_DIRT), has(Items.COARSE_DIRT))
						.save(output);
```


## 有序配方 {#shaped-recipes}

对于有序配方，可以使用 `String` 定义有序，然后定义 `String` 中每个 `char` 代表什么。


```java
				shaped(RecipeCategory.MISC, Items.CRAFTING_TABLE, 4)
						.pattern("ll")
						.pattern("ll")
						.define('l', ItemTags.LOGS) // 'l' means "any log"
						.group("multi_bench") // Put it in a group called "multi_bench" - groups are shown in one slot in the recipe book
						.unlockedBy(getHasName(Items.CRAFTING_TABLE), has(Items.CRAFTING_TABLE))
						.save(output);
				shaped(RecipeCategory.MISC, Items.LOOM, 4)
						.pattern("ww")
						.pattern("ll")
						.define('w', ItemTags.WOOL) // 'w' means "any wool"
						.define('l', ItemTags.LOGS)
						.group("multi_bench")
						.unlockedBy(getHasName(Items.LOOM), has(Items.LOOM))
						.save(output);
				doorBuilder(Items.OAK_DOOR, Ingredient.of(Items.OAK_BUTTON)) // Using a helper method!
						.unlockedBy(getHasName(Items.OAK_BUTTON), has(Items.OAK_BUTTON))
						.save(output);
```


:::tip
有很多辅助方法可用于创建普通配方。 查看 `RecipeProvider` 提供的内容！ 在 IntelliJ 中按 `Alt + 7` 打开类的结构，其中包括方法列表。
:::

## 其他配方 {#other-recipes}

其他配方的工作原理类似，但需要一些额外的参数。 比如烧炼配方需要了解奖励多少经验。


```java
				oreSmelting(
						List.of(Items.BREAD, Items.COOKIE, Items.HAY_BLOCK), // Inputs
						RecipeCategory.FOOD, // Category
						Items.WHEAT, // Output
						0.1f, // Experience
						300, // Cooking time
						"food_to_wheat" // group
				);
```


## 自定义配方类型 {#custom-recipe-types}
