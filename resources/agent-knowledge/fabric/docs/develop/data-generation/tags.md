---
title: 标签生成
description: 使用 Datagen 设置标签生成的指南。
authors:
  - IMB11
  - skycatminepokie
  - Spinoscythe
authors-nogithub:
  - mcrafterzz
---

:::info 前提
首先，请确保你已完成 [Datagen 设置](./setup) 。
:::

## 设置 {#setup}

首先，创建你自己的 `extends FabricTagProvider<T>` 类，其中 `T` 是您希望提供标签的类型。 这是你的**提供程序**。 在这里我们将展示如何创建 `Item` 标签，但同样的原则对其他场景也适用。 让你的 IDE 填充所需的代码，然后用你的类型的 `ResourceKey` 替换 `registryKey` 构造函数参数：


```java
public class FabricDocsReferenceItemTagProvider extends FabricTagProvider<Item> {

	public FabricDocsReferenceItemTagProvider(FabricDataOutput output, CompletableFuture<HolderLookup.Provider> registriesFuture) {
		super(output, Registries.ITEM, registriesFuture);
	}

	@Override
	protected void addTags(HolderLookup.Provider wrapperLookup) {

	}
}
```


:::tip
您需要为每种类型的标签提供不同的提供程序（例如，一个 `FabricTagProvider<EntityType<?>>` 和一个 `FabricTagProvider<Item>`）。
:::

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


## 创建标签 {#creating-a-tag}

现在你创建了提供程序，让我们为其添加一个标签。 首先，创建一个 `TagKey<T>`：


```java
	public static final TagKey<Item> SMELLY_ITEMS = TagKey.create(Registries.ITEM, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "smelly_items"));
```


接下来，在提供程序的 `configure` 方法中调用 `getOrCreateTagBuilder`。 自那里，你可以添加单个物品，添加其他标签，或用此标签替换预先存在的标签。

如果想添加标签，使用 `addOptionalTag`，因为标签的内容可能不会在 datagen 期间加载。 如果你确定标签已加载，调用 `addTag`。

要强制添加标签并忽略损坏的格式，使用 `forceAddTag`。


```java
		getOrCreateTagBuilder(SMELLY_ITEMS)
				.add(Items.SLIME_BALL)
				.add(Items.ROTTEN_FLESH)
				.addOptionalTag(ItemTags.DIRT)
				.add(ResourceLocation.withDefaultNamespace("oak_planks"))
				.forceAddTag(ItemTags.BANNERS)
				.setReplace(true);
```

