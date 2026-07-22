---
title: 创建自定义粒子
description: 学习如何使用 Fabric API 创建自定义粒子。
authors:
  - Superkat32
---

粒子是一种强大的工具， 可以为美丽的场景增添氛围，也可以为你的 boss 战添加紧张感。 让我们创建一个自定义粒子吧！

## 注册自定义粒子{#register-a-custom-particle}

我们会添加新的火花粒子，模仿末地烛的粒子移动。

首先，需要在你的[模组初始化器](../../getting-started/project-structure#entrypoints)中，使用你有模组 ID，注册 `ParticleType`。


```java
package com.example.docs;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.particle.v1.FabricParticleTypes;
import net.minecraft.core.Registry;
import net.minecraft.core.particles.SimpleParticleType;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;

//#entrypoint
public class FabricDocsReference implements ModInitializer {
	// This logger is used to write text to the console and the log file.
	// It is considered best practice to use your mod id as the logger's name.
	// That way, it's clear which mod wrote info, warnings, and errors.
	public static final String MOD_ID = "fabric-docs-reference";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	//#entrypoint
	//#particle_register_main
	// This DefaultParticleType gets called when you want to use your particle in code.
	public static final SimpleParticleType SPARKLE_PARTICLE = FabricParticleTypes.simple();

	//#particle_register_main
	//#entrypoint
	@Override
	public void onInitialize() {
		// This code runs as soon as Minecraft is in a mod-load-ready state.
		// However, some things (like resources) may still be uninitialized.
		// Proceed with mild caution.

		LOGGER.info("Hello Fabric world!");
		//#entrypoint

		//#particle_register_main
		// Register our custom particle type in the mod initializer.
		Registry.register(BuiltInRegistries.PARTICLE_TYPE, ResourceLocation.fromNamespaceAndPath(MOD_ID, "sparkle_particle"), SPARKLE_PARTICLE);
		//#particle_register_main
		//#entrypoint
	}
}
```


小写字母“sparkle_particle”是粒子纹理的 JSON 路径。 稍后就会以这个名字，创建新的 JSON 文件。

## 客户端注册{#client-side-registration}

在模组的初始化器中注册粒子后，还需要在客户端的初始化器中注册粒子。


```java
package com.example.docs;

import net.minecraft.client.particle.EndRodParticle;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.particle.v1.ParticleFactoryRegistry;

public class FabricDocsReferenceClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		// This entrypoint is suitable for setting up client-specific logic, such as rendering.

		// #particle_register_client
		// For this example, we will use the end rod particle behaviour.
		ParticleFactoryRegistry.getInstance().register(FabricDocsReference.SPARKLE_PARTICLE, EndRodParticle.Provider::new);
		// #particle_register_client
	}
}
```


在这个例子中，我们在客户端注册我们的粒子。 使用末地烛粒子的 factory，给予粒子一些移动。 这意味着，我们的粒子就会像末地烛那样移动。

::: tip
You can see all the particle factories by looking at all the implementations of the `ParticleProvider` interface. This is helpful if you want to use another particle's behaviour for your own particle.

- IntelliJ 的快捷键：Ctrl+Alt+B
- Visual Studio Code 的快捷键：Ctrl+F12
  :::

## 创建 JSON 文件并添加纹理{#creating-a-json-file-and-adding-textures}

你需要在你的 `resources/assets/mod-id/` 文件夹中创建两个文件夹。

| 文件夹路径                | 说明                            |
| -------------------- | ----------------------------- |
| `/textures/particle` | `particle` 文件夹会包含你的所有粒子的纹理。   |
| `/particles`         | `particle` 文件夹会包含你的所有 json 文件 |

例如，我们在 `textures/particle` 中只有一个纹理，叫做 `sparkle_particle_texture.png`。

然后，在 `particles` 中创建新的 JSON 文件，名称与用于创建你的 ParticleType 的 JSON 路径相同。 例如，我们需要创建 `sparkle_particle.json`。 这个文件很重要，因为让 Minecraft 知道我们的粒子应该使用哪个纹理。


```json
{
  "textures": ["fabric-docs-reference:sparkle_particle_texture"]
}
```


:::tip
可以给 `textures` 数组添加更多纹理以创建粒子动画。 粒子会在这个数组中循环纹理，以第一个纹理开始。
:::

## 测试新的粒子{#testing-the-new-particle}

完成了 JSON 文件并保存你的作品后，就能够载入 Minecraft 并测试好一切了！

可以输入以下命令，看看是否一切正常：

```mcfunction
/particle fabric-docs-reference:sparkle_particle ~ ~1 ~
```

![粒子的展示](/assets/develop/rendering/particles/sparkle-particle-showcase.png)

:::info
用这个命令，粒子会生成在玩家内。 你可能需要往后走才能实际看到。
:::

你也可以使用相同命令，用命令方块召唤粒子。
