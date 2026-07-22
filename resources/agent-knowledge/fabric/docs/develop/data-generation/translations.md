---
title: 翻译生成
description: 使用 Datagen 设置翻译生成的指南。
authors:
  - IMB11
  - MattiDragon
  - skycatminepokie
  - Spinoscythe
authors-nogithub:
  - jmanc3
  - mcrafterzz
  - sjk1949
---

:::info 前提
首先，请确保你已完成 [Datagen 设置](./setup) 。
:::

## 设置 {#setup}

首先，我们要创建**提供程序**。 请记住，提供程序才是为我们生成数据的。 创建一个 `extends FabricLanguageProvider` 的类，填入基本方法：


```java
public class FabricDocsReferenceEnglishLangProvider extends FabricLanguageProvider {
	protected FabricDocsReferenceEnglishLangProvider(FabricDataOutput dataOutput, CompletableFuture<HolderLookup.Provider> registryLookup) {
		// Specifying en_us is optional, as it's the default language code
		super(dataOutput, "en_us", registryLookup);
	}

	@Override
	public void generateTranslations(HolderLookup.Provider wrapperLookup, TranslationBuilder translationBuilder) {

	}
}
```


:::tip
对于想要生成的每种语言，需要不同的提供程序（例如一个 `ExampleEnglishLangProvider` 还有一个 `ExamplePirateLangProvider`）。
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


## 创建翻译 {#creating-translations}

除了创建原始翻译、来自 `ResourceLocation` 的翻译以及从现有的文件复制（通过传递 `Path`）之外，还有用于翻译物品、方块、标签、统计数据、实体、状态效果、物品组、实体属性和魔咒的辅助方法。 只需在 `translationBuilder` 上调用 `add`，添加你想要翻译的内容以及应该翻译成的内容：


```java
		translationBuilder.add("text.fabric_docs_reference.greeting", "Hello there!");
```


## 使用翻译 {#using-translations}

生成的翻译取代了其他教程中添加的许多翻译，但你也可以在任何使用 `Component` 对象的地方使用。 在我们的示例中，如果我们想允许资源包翻译我们的问候语，我们使用 `Component.translatable` 而不是 `Component.nullToEmpty`：

```java
ChatHud chatHud = Minecraft.getInstance().gui.getChat();
chatHud.addMessage(Component.literal("Hello there!")); // [!code --]
chatHud.addMessage(Component.translatable("text.fabric_docs_reference.greeting")); // [!code ++]
```
