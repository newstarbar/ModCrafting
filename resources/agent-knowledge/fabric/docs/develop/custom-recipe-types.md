---
title: 自定义配方类型
description: 了解如何创建自定义配方类型。
authors:
  - cassiancc
  - skippyall
---

自定义配方类型是一种为你的模组的自定义合成机制创建数据驱动的配方的方法。 例如，我们将创建一个类似于锻造台的升级方块配方类型。

## 创建配方输入类 {#creating-your-recipe-in​​put-class}

在开始创建配方之前，你需要实现一个 `RecipeInput` 接口，用于存放方块物品栏中的输入物品。 我们希望升级配方有两个输入物品：一个是待升级的基础物品，另一个是升级后的物品本身。


```java
public record UpgradingRecipeInput(ItemStack baseItem, ItemStack upgradeItem) implements RecipeInput {
	@Override
	public ItemStack getItem(int index) {
		return switch (index) {
			case 0 -> this.baseItem;
			case 1 -> this.upgradeItem;
			default -> ItemStack.EMPTY;
		};
	}

	@Override
	public int size() {
		return 2;
	}
}
```

## 创建配方类 {#creating-the-recipe-class}

现在我们有了存储输入项的方法，就可以创建 `Recipe` 实现。 此类实现代表数据包中定义的单个配方。 它们负责检查配方的原材料和要求，并将它们组装成结果。

让我们先来定义一下结果和配方中的原材料。


```java
public class UpgradingRecipe implements Recipe<UpgradingRecipeInput> {
	private final ItemStackTemplate result;
	private final Ingredient baseItem;
	private final Ingredient upgradeItem;

	public UpgradingRecipe(ItemStackTemplate result, Ingredient baseItem, Ingredient upgradeItem) {
		this.baseItem = baseItem;
		this.upgradeItem = upgradeItem;
		this.result = result;
	}

	public ItemStackTemplate getResult() {
		return this.result;
	}

	public Ingredient getBaseItem() {
		return this.baseItem;
	}

	public Ingredient getUpgradeItem() {
		return this.upgradeItem;
	}

}
```

请注意我们如何使用 `Ingredient` 对象作为输入。 这使得我们的配方可以互换地接受多种原材料。

## 实现方法 {#implementing-the-methods}

接下来，我们来实现配方接口中的方法。 其中比较有趣的是 `matches` 和 `assemble`。 `matches` 方法用于测试我们 `RecipeInput` 实现中的输入物品是否与我们的原材料匹配。 然后，`assemble` 方法会创建合成的 `ItemStack`。

为了测试原材料是否匹配，我们可以使用原材料的 `test` 方法。


```java
	@Override
	public boolean matches(UpgradingRecipeInput recipeInput, Level level) {
		return this.baseItem.test(recipeInput.baseItem()) && this.upgradeItem.test(recipeInput.upgradeItem());
	}

	@Override
	public ItemStack assemble(UpgradingRecipeInput recipeInput) {
		return this.result.create();
	}
```

## 创建配方序列化器 {#creating-a-recipe-serializer}

配方序列化器使用 [`MapCodec`](./codecs/#mapcodec) 从 JSON 中读取配方，并使用 `StreamCodec` 通过网络发送配方。

我们将使用 `RecordCodecBuilder#mapCodec` 为我们的配方构建一个映射编解码器。 它允许我们将 Minecraft 现有的编解码器整合到我们自己的编解码器中：


```java
	public static final MapCodec<UpgradingRecipe> CODEC = RecordCodecBuilder.mapCodec(instance ->
					instance.group(
									ItemStackTemplate.CODEC.fieldOf("result").forGetter(UpgradingRecipe::getResult),
									Ingredient.CODEC.fieldOf("baseItem").forGetter(UpgradingRecipe::getBaseItem),
									Ingredient.CODEC.fieldOf("upgradeItem").forGetter(UpgradingRecipe::getUpgradeItem)
					).apply(instance, UpgradingRecipe::new)
	);
```

可以使用 `StreamCodec#composite` 以类似的方式创建流编解码器：


```java
	public static final StreamCodec<RegistryFriendlyByteBuf, UpgradingRecipe> STREAM_CODEC = StreamCodec.composite(
					ItemStackTemplate.STREAM_CODEC,
					UpgradingRecipe::getResult,
					Ingredient.CONTENTS_STREAM_CODEC,
					UpgradingRecipe::getBaseItem,
					Ingredient.CONTENTS_STREAM_CODEC,
					UpgradingRecipe::getUpgradeItem,
					UpgradingRecipe::new
	);
```

现在我们将注册配方序列化器以及配方类型。 你可以在模组的初始化器中完成此操作，也可以在一个单独的类中完成，并通过模组初始化器调用该方法：


```java
	public static final RecipeSerializer<UpgradingRecipe> UPGRADING_RECIPE_SERIALIZER = Registry.register(
					BuiltInRegistries.RECIPE_SERIALIZER,
					Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "upgrading"),
					new RecipeSerializer<>(UpgradingRecipe.CODEC, UpgradingRecipe.STREAM_CODEC)
	);

	public static final RecipeType<UpgradingRecipe> UPGRADING_RECIPE_TYPE = Registry.register(
					BuiltInRegistries.RECIPE_TYPE,
					Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "upgrading"),
					new RecipeType<UpgradingRecipe>() { }
	);
```

回到我们的配方类，现在我们可以添加返回我们刚刚注册的对象的方法了：


```java
	@Override
	public RecipeSerializer<? extends Recipe<UpgradingRecipeInput>> getSerializer() {
		return ExampleModRecipes.UPGRADING_RECIPE_SERIALIZER;
	}

	@Override
	public RecipeType<? extends Recipe<UpgradingRecipeInput>> getType() {
		return ExampleModRecipes.UPGRADING_RECIPE_TYPE;
	}
```

为了完成我们的自定义配方类型，我们只需要实现剩余的 `placementInfo`、`showNotification`、`group` 和 `recipeBookCategory` 方法，配方书会使用这些方法将我们的配方放在屏幕上。 目前，我们将只返回 `PlacementInfo.NOT_PLACEABLE` 和 `null`，因为配方书无法轻易扩展到模组的工作站。 我们还要重写 `isSpecial` 函数使其返回真，以防止其他一些与配方书相关的逻辑运行并记录错误。


```java
	@Override
	public @Nullable RecipeBookCategory recipeBookCategory() {
		return null;
	}

	@Override
	public PlacementInfo placementInfo() {
		return PlacementInfo.NOT_PLACEABLE;
	}

	@Override
	public boolean isSpecial() {
		return true;
	}

	@Override
	public boolean showNotification() {
		return true;
	}

	@Override
	public String group() {
		return "upgrading";
	}
```

## 创建配方 {#creating-a-recipe}

我们的配方类型现在已经可以正常工作了，但我们仍然缺少两件重要的东西：一个是适用于我们配方类型的配方，另一个是合成它的方法。

首先，我们来创建一个配方。 在你的 `resources` 文件夹 `data/example-mod/recipe` 目录下，创建一个扩展名为 `.json` 的文件。 每个配方 JSON 文件都有一个 `"type"` 键，指向该配方的序列化器。 其他键则由该序列化器的编解码器定义。

在我们的例子中，一个有效的配方文件如下所示：


```json
{
  "type": "example-mod:upgrading",
  "baseItem": "minecraft:iron_pickaxe",
  "upgradeItem": "minecraft:diamond",
  "result": {
    "id": "minecraft:diamond_pickaxe"
  }
}
```

## 创建菜单 {#creating-a-menu}

::: info

有关创建菜单的更多详细信息，请参阅[容器菜单](blocks/container-menus)。

:::

为了允许我们在 GUI 中创建配方，我们将创建一个带有[菜单](./blocks/container-menus) 的方块：


```java
public class UpgradingMenu extends AbstractContainerMenu {
	private final Container input = new SimpleContainer(2) {
		@Override
		public void setChanged() {
			super.setChanged();
			UpgradingMenu.this.slotsChanged(this);
		}
	};

	private final ResultContainer output = new ResultContainer();

	private final ContainerLevelAccess access;

	@Nullable
	private final Player player;

	public UpgradingMenu(int containerId, Inventory inventory) {
		this(containerId, inventory, ContainerLevelAccess.NULL);
	}

	public UpgradingMenu(int containerId, Inventory inventory, ContainerLevelAccess access) {
		super(ModMenuTypes.UPGRADING_MENU_TYPE, containerId);

		this.access = access;
		this.player = inventory.player;

		addSlot(new Slot(this.input, 0, 27, 47));
		addSlot(new Slot(this.input, 1, 76, 47));

		addSlot(new UpgradingResultSlot(this, this.output, 0, 134, 47));

		addStandardInventorySlots(inventory, 8, 84);
	}

	/**
	 * Called by {@link UpgradingResultSlot#onTake(Player, ItemStack)}.
	 */
	protected void onTake(final Player player, final ItemStack stack) {
		stack.onCraftedBy(player, stack.getCount());
		this.output.awardUsedRecipes(player, List.of(this.input.getItem(0), this.input.getItem(1)));
		this.input.removeItem(0, 1);
		this.input.removeItem(1, 1);
	}

	@Override
	public void slotsChanged(Container container) {
		super.slotsChanged(container);

		this.access.execute((level, blockPos) -> {
			if (level instanceof ServerLevel serverLevel && container == this.input) {
				UpgradingRecipeInput recipeInput = new UpgradingRecipeInput(this.input.getItem(0), this.input.getItem(1));
				Optional<RecipeHolder<UpgradingRecipe>> maybeRecipe = serverLevel.recipeAccess().getRecipeFor(ExampleModRecipes.UPGRADING_RECIPE_TYPE, recipeInput, serverLevel);
				ItemStack result = ItemStack.EMPTY;

				if (maybeRecipe.isPresent()) {
					RecipeHolder<UpgradingRecipe> recipeHolder = maybeRecipe.get();
					UpgradingRecipe recipe = recipeHolder.value();

					if (this.output.setRecipeUsed((ServerPlayer) this.player, recipeHolder)) {
						ItemStack recipeResult = recipe.assemble(recipeInput);

						if (recipeResult.isItemEnabled(level.enabledFeatures())) {
							result = recipeResult;
						}
					}
				} else {
					// We can set the used recipe to null if no recipe was found.
					//noinspection DataFlowIssue
					this.output.setRecipeUsed((ServerPlayer) this.player, null);
				}

				this.output.setItem(0, result);

				/*
				Alternatively, call broadcastChanges instead of setting the remote slot and sending a packet.
				Based on how your Menu is structured, you may not need to manually call any syncing method, but it is recommended that you are very sure of yourself before you remove these calls to avoid server-client desyncs.
				 */
				this.setRemoteSlot(0, result);
				((ServerPlayer) this.player).connection.send(new ClientboundContainerSetSlotPacket(this.containerId, this.incrementStateId(), 0, result));
			}
		});
	}

	@Override
	public ItemStack quickMoveStack(Player player, int slotIndex) {
		return ItemStack.EMPTY;
	}

	@Override
	public boolean stillValid(Player player) {
		return stillValid(this.access, player, ModBlocks.UPGRADING_BLOCK);
	}

	@Override
	public void removed(Player player) {
		super.removed(player);
		this.access.execute((level, blockPos) -> this.clearContainer(player, this.input));
	}

	@Override
	public boolean canTakeItemForPickAll(final ItemStack carried, final Slot target) {
		return target.container != this.output && super.canTakeItemForPickAll(carried, target);
	}
}
```

这里的信息量很大！ 这个菜单有两个输入槽位和一个输出槽位。

输入容器是 `SimpleContainer` 的一个匿名子类，当其物品发生变化时，它会调用菜单的 `slotsChanged` 方法。 在 `slotsChanged` 中，我们创建一个配方输入类的实例，并用两个输入槽位填充它。

为了查看它是否匹配任何配方，我们首先要确保我们位于服务器级别，因为客户端不知道存在哪些配方。 然后，我们将通过 `serverLevel.recipeAccess()` 获取 `RecipeManager`。

我们将调用 `serverLevel.recipeAccess().getRecipeFor` 并传入我们的配方输入，以获取与输入匹配的配方。 如果找到了配方，我们可以将结果添加到结果容器中或从中移除结果。

为了检测用户何时取出结果，我们创建一个 `Slot` 的匿名子类。 然后，菜单的 `onTake` 方法会移除输入物品。

为防止删除物品，屏幕关闭时必须将输入恢复原状，如 `removed` 方法所示。

你还需要将菜单添加到注册表中：


```java
// region upgrading_menu_registration not found — showing file head
package com.example.docs.recipe;

import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.crafting.RecipeBookCategory;
import net.minecraft.world.item.crafting.RecipeSerializer;
import net.minecraft.world.item.crafting.RecipeType;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.recipe.v1.sync.RecipeSynchronization;

import com.example.docs.ExampleMod;
import com.example.docs.recipe.extending.EnchantingSmithingDemoSlotDisplay;
import com.example.docs.recipe.extending.EnchantingSmithingRecipe;
import com.example.docs.recipe.extending.StewSpikingCraftingRecipe;

public class ExampleModRecipes implements ModInitializer {
	// #region registration
	public static final RecipeSerializer<UpgradingRecipe> UPGRADING_RECIPE_SERIALIZER = Registry.register(
					BuiltInRegistries.RECIPE_SERIALIZER,
					Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "upgrading"),
					new RecipeSerializer<>(UpgradingRecipe.CODEC, UpgradingRecipe.STREAM_CODEC)
	);

	public static final RecipeType<UpgradingRecipe> UPGRADING_RECIPE_TYPE = Registry.register(
					BuiltInRegistries.RECIPE_TYPE,
					Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "upgrading"),
					new RecipeType<UpgradingRecipe>() { }
	);
	// #endregion registration

	// TODO: recipe book support, requires enum extensions + screen changes
	public static final RecipeBookCategory UPGRADING_RECIPE_BOOK_CATEGORY = Registry.register(
					BuiltInRegistries.RECIPE_BOOK_CATEGORY,
					Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "upgrading"),
					new RecipeBookCategory()
	);

	@Override
```

## 配方同步 {#recipe-synchronization}

::: info

本部分为可选，仅当你 需要客户端了解配方时才需要。

:::

如前所述，配方完全由逻辑服务器处理。 然而在某些情况下，客户端可能需要知道有哪些配方存在——例如原版中的切石机，它需要显示给定原材料可用的配方选项。 此外，某些配方查看器（包括 [JEI](https://modrinth.com/mod/jei)）的插件运行在逻辑客户端上，这就需要你 使用 Fabric 的配方同步 API。

要同步你的配方，只需在你的模组初始化器中调用`RecipeSynchronization.synchronizeRecipeSerializer`，并提供你的模组的配方序列化器即可：


```java
		RecipeSynchronization.synchronizeRecipeSerializer(UPGRADING_RECIPE_SERIALIZER);
```

同步完成后，可以随时从客户端的配方管理器中检索配方：


```java
		clientLevel.recipeAccess().getSynchronizedRecipes().getAllOfType(ExampleModRecipes.UPGRADING_RECIPE_TYPE);
```
