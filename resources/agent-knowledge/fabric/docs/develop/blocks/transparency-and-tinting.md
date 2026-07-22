---
title: 透明度和着色
description: 学习如何操控方块的外观并对其进行动态着色。
authors:
  - cassiancc
  - dicedpixels
---

有时，你可能希望在游戏中对方块的外观进行特殊处理。 例如，某些方块可能呈现透明效果，而另一些则会应用着色。

我们来看看如何操控方块的外观。

在本例中，我们先来注册一个方块。 如果你不熟悉这个过程，请先阅读[方块注册](./first-block)。


```
// missing reference: reference/latest/src/main/java/com/example/docs/appearance/ExampleModAppearance.java#block
```


请务必添加：

- `/blockstates/waxcap.json` 中的[方块状态](./blockstates)
- `/models/block/waxcap.json` 中的[模型](./block-models)
- `/textures/block/waxcap.png` 中的[纹理](./first-block#models-and-textures)

如果一切正确，你应该能在游戏中看到这个方块。 但是，你会发现放置后，方块看起来不太对劲。

![错误的方块外观](/assets/develop/transparency-and-tinting/block_appearance_0.png)

这是因为带有透明度的纹理需要一些额外的设置。

## 操控方块的外观 {#manipulating-block-appearance}

方块的纹理即使是透明或半透明的，仍然会显示为不透明。 要解决这个问题，你需要设置方块的 _子区块层_。

子区块层是用于对不同类型的方块表面进行分组以进行渲染的类别。 这使得游戏能够针对每种类型使用正确的视觉效果和优化。

我们需要将方块注册到正确的子区块层。 原版游戏提供了以下选项。

- `SOLID`：默认值，一个没有任何透明度的实心方块。
- `CUTOUT` 和 `CUTOUT_MIPPED`：使用透明度的方块，例如玻璃或花。 `CUTOUT_MIPPED` 在远处看起来效果更好。
- `TRANSLUCENT`：使用半透明（部分透明）像素的方块，例如染色玻璃或水。

我们的示例带有透明度，因此将使用 `CUTOUT`。

在你的**客户端初始化器**中，使用 Fabric API 的 `BlockRenderLayerMap` 将方块注册到正确的 `ChunkSectionLayer`。


```java
// region block_render_layer_map not found — showing file head
package com.example.docs.appearance;

import java.util.List;

import net.minecraft.client.color.block.BlockTintSource;
import net.minecraft.client.color.block.BlockTintSources;
import net.minecraft.client.color.item.ItemTintSources;
import net.minecraft.client.renderer.block.BlockAndTintGetter;
import net.minecraft.client.renderer.block.FluidModel;
import net.minecraft.client.resources.model.sprite.Material;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.Identifier;
import net.minecraft.util.ARGB;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.render.fluid.v1.FluidRenderingRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.BlockColorRegistry;

import com.example.docs.ExampleMod;
import com.example.docs.block.ModBlocks;
import com.example.docs.fluid.ModFluids;

public class ExampleModAppearanceClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		// #region register_item_tint_source
		ItemTintSources.ID_MAPPER.put(Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "color"), RainTintSource.MAP_CODEC);
		// #endregion register_item_tint_source
		// #region color_provider
		BlockColorRegistry.register(List.of(new BlockTintSource() {
			@Override
			public int colorInWorld(BlockState state, BlockAndTintGetter level, BlockPos pos) {
				BlockState stateBelow = level.getBlockState(pos.below());

				if (stateBelow.is(Blocks.GRASS_BLOCK)) {
					return ARGB.opaque(0x98FB98); // Color code in hex format
				}

```


现在，你的方块应该具有合适的透明度了。

![正确的方块外观](/assets/develop/transparency-and-tinting/block_appearance_1.png)

## 方块颜色提供器 {#block-color-providers}

我们的方块尽管在游戏中看起来不错，但纹理是灰度的。 我们可以动态地应用颜色着色，就像原版游戏中的树叶会根据生物群系变色一样。

Fabric API 提供了 `ColorProviderRegistry` 来注册一个着色颜色提供器，可以用来来动态地为方块着色。

我们使用这个 API 注册一个颜色，这样当我们的 Waxcap 块放置在草地上时是绿色的，其他情况则是棕色的。

在你的**客户端初始化器**中，将你的代码块注册到 `ColorProviderRegistry`，并附上相应的逻辑。


```java
		BlockColorRegistry.register(List.of(new BlockTintSource() {
			@Override
			public int colorInWorld(BlockState state, BlockAndTintGetter level, BlockPos pos) {
				BlockState stateBelow = level.getBlockState(pos.below());

				if (stateBelow.is(Blocks.GRASS_BLOCK)) {
					return ARGB.opaque(0x98FB98); // Color code in hex format
				}

				return ARGB.opaque(0xFFDAB9); // Color code in hex format
			}

			@Override
			public int color(BlockState state) {
				return ARGB.opaque(0xFFDAB9); // Color code in hex format
			}
		}), ModBlocks.WAXCAP);
```


现在，方块的颜色将根据其放置的位置而变化。

![带颜色提供器的方块](/assets/develop/transparency-and-tinting/block_appearance_2.png)
