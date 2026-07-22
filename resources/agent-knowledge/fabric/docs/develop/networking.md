---
title: 网络通信
description: 使用 Fabric API 进行网络通信的一般指南。
authors:
  - Daomephsta
  - dicedpixels
  - Earthcomputer
  - FlooferLand
  - FxMorin
  - i509VCB
  - modmuss50
  - natanfudge
  - NetUserGet
  - NShak
  - parzivail
  - skycatminepokie
  - SolidBlock-cn
  - Voleil
  - Wxffel
  - YTG123-Mods
  - zulrang
---

Minecraft 中的网络用于使客户端和服务端可以相互通信。 网络通信是个广泛的话题，
因此本页面分为几个类别。

## 为什么网络很重要？ {#why-is-networking-important}

数据包是 Minecraft 网络的核心概念。
数据包由任意数据组成，可以从服务器发送到客户端，也可以从客户端发送到服务器。
请参阅下面的图表，它直观地展示了 Fabric 中的网络架构：

![双端架构](/assets/develop/networking/sides.png)

请留意数据包是如何充当服务器和客户端之间的桥梁的；这是因为你在游戏中所做的几乎一切都以某种方式涉及网络。
例如，当您发送一条聊天消息时，包含内容的数据包会发送到服务器。
然后，服务器会向所有其他客户端发送包含你消息的另一个数据包。

要记住的一件重要事情是始终有一个服务器在运行，即使在单人游戏和局域网中也是如此。 即使没有其他人和你一起玩，数据包仍用于客户端和服务器之间的通信。 在谈论网络中的端时，我们常用术语“**逻辑**客户端”和“**逻辑**服务器”。 集成的单人/局域网服务器和专用服务器都是**逻辑**服务器，但只有专用服务器可以被视为**物理**服务器。

当客户端和服务器之间的状态没有同步时，可能会遇到服务器或其他客户端不承认另一个客户端正在做的事情的问题。 这通常被称为“不同步”。 在编写自己的模组时，你可能需要发送数据包来保持服务器和所有客户端的状态同步。

## 网络通信简介 {#an-introduction-to-networking}

### 定义有效负载 {#defining-a-payload}

:::info
有效负载是在数据包内发送的数据。
:::

这可以通过创建一个带有实现 `CustomPayload` 的 `BlockPos` 参数的 Java `Record` 来实现。


```java
public record SummonLightningS2CPayload(BlockPos pos) implements CustomPacketPayload {
	public static final ResourceLocation SUMMON_LIGHTNING_PAYLOAD_ID = ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "summon_lightning");
	public static final CustomPacketPayload.Type<SummonLightningS2CPayload> ID = new CustomPacketPayload.Type<>(SUMMON_LIGHTNING_PAYLOAD_ID);
	public static final StreamCodec<RegistryFriendlyByteBuf, SummonLightningS2CPayload> CODEC = StreamCodec.composite(BlockPos.STREAM_CODEC, SummonLightningS2CPayload::pos, SummonLightningS2CPayload::new);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return ID;
	}
}
```


同时，我们定义：

- `ResourceLocation`（标识符）用于识别数据包的有效负载。 在本例中，我们的标识符将是 `fabric-docs-reference:summon_lightning`。


```java
package com.example.docs.networking.basic;

import com.example.docs.FabricDocsReference;
import net.minecraft.core.BlockPos;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

// :::summon_Lightning_payload
public record SummonLightningS2CPayload(BlockPos pos) implements CustomPacketPayload {
	public static final ResourceLocation SUMMON_LIGHTNING_PAYLOAD_ID = ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "summon_lightning");
	public static final CustomPacketPayload.Type<SummonLightningS2CPayload> ID = new CustomPacketPayload.Type<>(SUMMON_LIGHTNING_PAYLOAD_ID);
	public static final StreamCodec<RegistryFriendlyByteBuf, SummonLightningS2CPayload> CODEC = StreamCodec.composite(BlockPos.STREAM_CODEC, SummonLightningS2CPayload::pos, SummonLightningS2CPayload::new);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return ID;
	}
}
// :::summon_Lightning_payload
```


- `CustomPayload.Id` 的公共静态实例，用于唯一标识此自定义负载。 我们将在通用代码和客户端代码中引用此 ID。


```java
package com.example.docs.networking.basic;

import com.example.docs.FabricDocsReference;
import net.minecraft.core.BlockPos;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

// :::summon_Lightning_payload
public record SummonLightningS2CPayload(BlockPos pos) implements CustomPacketPayload {
	public static final ResourceLocation SUMMON_LIGHTNING_PAYLOAD_ID = ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "summon_lightning");
	public static final CustomPacketPayload.Type<SummonLightningS2CPayload> ID = new CustomPacketPayload.Type<>(SUMMON_LIGHTNING_PAYLOAD_ID);
	public static final StreamCodec<RegistryFriendlyByteBuf, SummonLightningS2CPayload> CODEC = StreamCodec.composite(BlockPos.STREAM_CODEC, SummonLightningS2CPayload::pos, SummonLightningS2CPayload::new);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return ID;
	}
}
// :::summon_Lightning_payload
```


- `PacketCodec` 的公共静态实例，以便游戏知道如何序列化/反序列化数据包的内容。


```java
package com.example.docs.networking.basic;

import com.example.docs.FabricDocsReference;
import net.minecraft.core.BlockPos;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

// :::summon_Lightning_payload
public record SummonLightningS2CPayload(BlockPos pos) implements CustomPacketPayload {
	public static final ResourceLocation SUMMON_LIGHTNING_PAYLOAD_ID = ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "summon_lightning");
	public static final CustomPacketPayload.Type<SummonLightningS2CPayload> ID = new CustomPacketPayload.Type<>(SUMMON_LIGHTNING_PAYLOAD_ID);
	public static final StreamCodec<RegistryFriendlyByteBuf, SummonLightningS2CPayload> CODEC = StreamCodec.composite(BlockPos.STREAM_CODEC, SummonLightningS2CPayload::pos, SummonLightningS2CPayload::new);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return ID;
	}
}
// :::summon_Lightning_payload
```


我们还重写了 `getId` 来返回我们的有效载荷ID。


```java
package com.example.docs.networking.basic;

import com.example.docs.FabricDocsReference;
import net.minecraft.core.BlockPos;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

// :::summon_Lightning_payload
public record SummonLightningS2CPayload(BlockPos pos) implements CustomPacketPayload {
	public static final ResourceLocation SUMMON_LIGHTNING_PAYLOAD_ID = ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "summon_lightning");
	public static final CustomPacketPayload.Type<SummonLightningS2CPayload> ID = new CustomPacketPayload.Type<>(SUMMON_LIGHTNING_PAYLOAD_ID);
	public static final StreamCodec<RegistryFriendlyByteBuf, SummonLightningS2CPayload> CODEC = StreamCodec.composite(BlockPos.STREAM_CODEC, SummonLightningS2CPayload::pos, SummonLightningS2CPayload::new);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return ID;
	}
}
// :::summon_Lightning_payload
```


### 注册有效载荷 {#registering-a-payload}

在我们发送带有自定义有效负载的数据包之前，我们需要注册它。

:::info
`S2C` 和 `C2S` 是两个常见的后缀，分别表示 _服务器到客户端_ 和 _客户端到服务器_。
:::

这可以在我们的**通用初始化程序**中通过使用 `PayloadTypeRegistry.playS2C().register` 来完成，它接受 `CustomPayload.Id` 和 `PacketCodec`。


```java
package com.example.docs.networking.basic;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.Item;
import com.example.docs.FabricDocsReference;

public class FabricDocsReferenceNetworkingBasic implements ModInitializer {
	public static final ResourceKey<Item> LIGHTNING_TATER_REGISTRY_KEY = ResourceKey.create(Registries.ITEM, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "lightning_tater"));
	public static final Item LIGHTNING_TATER = Registry.register(BuiltInRegistries.ITEM, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "lightning_tater"), new LightningTaterItem(new Item.Properties().setId(LIGHTNING_TATER_REGISTRY_KEY)));

	public void onInitialize() {
		PayloadTypeRegistry.playS2C().register(SummonLightningS2CPayload.ID, SummonLightningS2CPayload.CODEC);
		PayloadTypeRegistry.playC2S().register(GiveGlowingEffectC2SPayload.ID, GiveGlowingEffectC2SPayload.CODEC);

		// :::server_global_receiver
		ServerPlayNetworking.registerGlobalReceiver(GiveGlowingEffectC2SPayload.ID, (payload, context) -> {
			Entity entity = context.player().level().getEntity(payload.entityId());

			if (entity instanceof LivingEntity livingEntity && livingEntity.closerThan(context.player(), 5)) {
				livingEntity.addEffect(new MobEffectInstance(MobEffects.GLOWING, 100));
			}
		});
		// :::server_global_receiver
	}
}
```


存在类似的方法来注册客户端到服务器的有效负载：`PayloadTypeRegistry.playC2S().register`。

### 发送数据包到客户端 {#sending-a-packet-to-the-client}

要发送带有自定义有效负载的数据包，我们可以使用 `ServerPlayNetworking.send`，它接收 `ServerPlayer` 和 `CustomPayload`。

让我们从创建 Lightning Tater 物品开始。 您可以重写 `use` 以在使用该物品时触发操作。
本例中我们向服务器世界的玩家发送数据包。


```java
public class LightningTaterItem extends Item {
	public LightningTaterItem(Properties settings) {
		super(settings);
	}

	@Override
	public InteractionResult use(Level world, Player user, InteractionHand hand) {
		if (world.isClientSide()) {
			return InteractionResult.PASS;
		}

		SummonLightningS2CPayload payload = new SummonLightningS2CPayload(user.blockPosition());

		for (ServerPlayer player : PlayerLookup.world((ServerLevel) world)) {
			ServerPlayNetworking.send(player, payload);
		}

		return InteractionResult.SUCCESS;
	}
}
```


让我们检查一下上面的代码。

我们仅在服务器上启动操作时发送数据包，通过提前返回 `isClient` 检查：


```java
package com.example.docs.networking.basic;

import net.fabricmc.fabric.api.networking.v1.PlayerLookup;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.Level;

// :::lightning_tater_item
public class LightningTaterItem extends Item {
	public LightningTaterItem(Properties settings) {
		super(settings);
	}

	@Override
	public InteractionResult use(Level world, Player user, InteractionHand hand) {
		if (world.isClientSide()) {
			return InteractionResult.PASS;
		}

		SummonLightningS2CPayload payload = new SummonLightningS2CPayload(user.blockPosition());

		for (ServerPlayer player : PlayerLookup.world((ServerLevel) world)) {
			ServerPlayNetworking.send(player, payload);
		}

		return InteractionResult.SUCCESS;
	}
}
// :::lightning_tater_item
```


我们根据用户的位置创建有效负载的实例：


```java
package com.example.docs.networking.basic;

import net.fabricmc.fabric.api.networking.v1.PlayerLookup;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.Level;

// :::lightning_tater_item
public class LightningTaterItem extends Item {
	public LightningTaterItem(Properties settings) {
		super(settings);
	}

	@Override
	public InteractionResult use(Level world, Player user, InteractionHand hand) {
		if (world.isClientSide()) {
			return InteractionResult.PASS;
		}

		SummonLightningS2CPayload payload = new SummonLightningS2CPayload(user.blockPosition());

		for (ServerPlayer player : PlayerLookup.world((ServerLevel) world)) {
			ServerPlayNetworking.send(player, payload);
		}

		return InteractionResult.SUCCESS;
	}
}
// :::lightning_tater_item
```


最后我们通过 `PlayerLookup` 获取服务器世界中的玩家，并向每个玩家发送数据包。


```java
package com.example.docs.networking.basic;

import net.fabricmc.fabric.api.networking.v1.PlayerLookup;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.Level;

// :::lightning_tater_item
public class LightningTaterItem extends Item {
	public LightningTaterItem(Properties settings) {
		super(settings);
	}

	@Override
	public InteractionResult use(Level world, Player user, InteractionHand hand) {
		if (world.isClientSide()) {
			return InteractionResult.PASS;
		}

		SummonLightningS2CPayload payload = new SummonLightningS2CPayload(user.blockPosition());

		for (ServerPlayer player : PlayerLookup.world((ServerLevel) world)) {
			ServerPlayNetworking.send(player, payload);
		}

		return InteractionResult.SUCCESS;
	}
}
// :::lightning_tater_item
```


:::info
Fabric API 提供了 `PlayerLookup`，这是一组辅助函数，用于在服务器中查找玩家。

经常用来描述这些方法的功能的术语是“_跟踪/tracking_”。 这意味着服务器上的某个实体或区块为玩家的客户端所知（在其视野距离内），并且该实体或方块实体应将变化通知跟踪客户端。

跟踪是高效网络通信的一个重要概念，这样只有必要的玩家才能通过发送数据包收到变化的通知。
:::

### 在客户端接收数据包 {#receiving-a-packet-on-the-client}

为了在客户端接收从服务器发送的数据包，您需要指定如何处理传入的数据包。

这可以在**客户端初始化程序**中完成，通过调用 `ClientPlayNetworking.registerGlobalReceiver` 并传递 `CustomPayload.Id` 和 `PlayPayloadHandler`（一个功能接口）。

本例中，我们将在 `PlayPayloadHandler` 实现中定义要触发的操作（作为 lambda 表达式）。


```java
		ClientPlayNetworking.registerGlobalReceiver(SummonLightningS2CPayload.ID, (payload, context) -> {
			ClientLevel world = context.client().level;

			if (world == null) {
				return;
			}

			BlockPos lightningPos = payload.pos();
			LightningBolt entity = EntityType.LIGHTNING_BOLT.create(world, EntitySpawnReason.TRIGGERED);

			if (entity != null) {
				entity.setPos(lightningPos.getX(), lightningPos.getY(), lightningPos.getZ());
				world.addEntity(entity);
			}
		});
```


让我们检查一下上面的代码。

我们可以通过调用 Record 的 getter 方法来访问来自有效负载的数据。 本例为 `payload.pos()`。 然后可以用它来获取 `x`、`y` 和 `z` 位置。


```java
package com.example.docs.network.basic;

import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;

import com.example.docs.networking.basic.GiveGlowingEffectC2SPayload;
import com.example.docs.networking.basic.SummonLightningS2CPayload;

public class FabricDocsReferenceNetworkingBasicClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		// :::client_global_receiver
		ClientPlayNetworking.registerGlobalReceiver(SummonLightningS2CPayload.ID, (payload, context) -> {
			ClientLevel world = context.client().level;

			if (world == null) {
				return;
			}

			BlockPos lightningPos = payload.pos();
			LightningBolt entity = EntityType.LIGHTNING_BOLT.create(world, EntitySpawnReason.TRIGGERED);

			if (entity != null) {
				entity.setPos(lightningPos.getX(), lightningPos.getY(), lightningPos.getZ());
				world.addEntity(entity);
			}
		});
		// :::client_global_receiver

		// :::use_entity_callback
		UseEntityCallback.EVENT.register((player, world, hand, entity, hitResult) -> {
			if (!world.isClientSide()) {
				return InteractionResult.PASS;
			}

			ItemStack usedItemStack = player.getItemInHand(hand);

			if (entity instanceof LivingEntity && usedItemStack.is(Items.POISONOUS_POTATO) && hand == InteractionHand.MAIN_HAND) {
				GiveGlowingEffectC2SPayload payload = new GiveGlowingEffectC2SPayload(hitResult.getEntity().getId());
				ClientPlayNetworking.send(payload);

				return InteractionResult.SUCCESS;
			}

			return InteractionResult.PASS;
		});
		// :::use_entity_callback
	}
}
```


最后，我们创建一个 `LightningEntity` 并将其添加到世界中。


```java
package com.example.docs.network.basic;

import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;

import com.example.docs.networking.basic.GiveGlowingEffectC2SPayload;
import com.example.docs.networking.basic.SummonLightningS2CPayload;

public class FabricDocsReferenceNetworkingBasicClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		// :::client_global_receiver
		ClientPlayNetworking.registerGlobalReceiver(SummonLightningS2CPayload.ID, (payload, context) -> {
			ClientLevel world = context.client().level;

			if (world == null) {
				return;
			}

			BlockPos lightningPos = payload.pos();
			LightningBolt entity = EntityType.LIGHTNING_BOLT.create(world, EntitySpawnReason.TRIGGERED);

			if (entity != null) {
				entity.setPos(lightningPos.getX(), lightningPos.getY(), lightningPos.getZ());
				world.addEntity(entity);
			}
		});
		// :::client_global_receiver

		// :::use_entity_callback
		UseEntityCallback.EVENT.register((player, world, hand, entity, hitResult) -> {
			if (!world.isClientSide()) {
				return InteractionResult.PASS;
			}

			ItemStack usedItemStack = player.getItemInHand(hand);

			if (entity instanceof LivingEntity && usedItemStack.is(Items.POISONOUS_POTATO) && hand == InteractionHand.MAIN_HAND) {
				GiveGlowingEffectC2SPayload payload = new GiveGlowingEffectC2SPayload(hitResult.getEntity().getId());
				ClientPlayNetworking.send(payload);

				return InteractionResult.SUCCESS;
			}

			return InteractionResult.PASS;
		});
		// :::use_entity_callback
	}
}
```


现在，如果你将此模组添加到服务器，当玩家使用我们的 Lightning Tater 物品时，每个玩家都会看到闪电击中用户的位置。

<VideoPlayer src="/assets/develop/networking/summon-lightning.webm">使用 Lightning Tater 召唤闪电</VideoPlayer>

### 发送数据包到服务器 {#sending-a-packet-to-the-server}

就像向客户端发送数据包一样，我们首先创建自定义有效负载。 这次，当玩家对生物实体使用毒马铃薯时，我们会请求服务器对其应用发光效果。


```java
public record GiveGlowingEffectC2SPayload(int entityId) implements CustomPacketPayload {
	public static final ResourceLocation GIVE_GLOWING_EFFECT_PAYLOAD_ID = ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "give_glowing_effect");
	public static final CustomPacketPayload.Type<GiveGlowingEffectC2SPayload> ID = new CustomPacketPayload.Type<>(GIVE_GLOWING_EFFECT_PAYLOAD_ID);
	public static final StreamCodec<RegistryFriendlyByteBuf, GiveGlowingEffectC2SPayload> CODEC = StreamCodec.composite(ByteBufCodecs.INT, GiveGlowingEffectC2SPayload::entityId, GiveGlowingEffectC2SPayload::new);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return ID;
	}
}
```


我们传入适当的编解码器以及方法引用，从 Record 中获取值来构建此编解码器。

然后我们在**通用初始化程序**中注册我们的有效负载。 然而，这次通过使用 `PayloadTypeRegistry.playC2S().register` 作为 _客户端到服务器_ 有效负载。


```java
package com.example.docs.networking.basic;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.Item;
import com.example.docs.FabricDocsReference;

public class FabricDocsReferenceNetworkingBasic implements ModInitializer {
	public static final ResourceKey<Item> LIGHTNING_TATER_REGISTRY_KEY = ResourceKey.create(Registries.ITEM, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "lightning_tater"));
	public static final Item LIGHTNING_TATER = Registry.register(BuiltInRegistries.ITEM, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "lightning_tater"), new LightningTaterItem(new Item.Properties().setId(LIGHTNING_TATER_REGISTRY_KEY)));

	public void onInitialize() {
		PayloadTypeRegistry.playS2C().register(SummonLightningS2CPayload.ID, SummonLightningS2CPayload.CODEC);
		PayloadTypeRegistry.playC2S().register(GiveGlowingEffectC2SPayload.ID, GiveGlowingEffectC2SPayload.CODEC);

		// :::server_global_receiver
		ServerPlayNetworking.registerGlobalReceiver(GiveGlowingEffectC2SPayload.ID, (payload, context) -> {
			Entity entity = context.player().level().getEntity(payload.entityId());

			if (entity instanceof LivingEntity livingEntity && livingEntity.closerThan(context.player(), 5)) {
				livingEntity.addEffect(new MobEffectInstance(MobEffects.GLOWING, 100));
			}
		});
		// :::server_global_receiver
	}
}
```


为了发送数据包，让我们在玩家使用毒马铃薯时添加一个动作。 我们将使用 `UseEntityCallback` 事件来保持简洁。

我们在**客户端初始化程序**中注册该事件，并使用 `isClient()` 来确保该操作仅在逻辑客户端上触发。


```java
		UseEntityCallback.EVENT.register((player, world, hand, entity, hitResult) -> {
			if (!world.isClientSide()) {
				return InteractionResult.PASS;
			}

			ItemStack usedItemStack = player.getItemInHand(hand);

			if (entity instanceof LivingEntity && usedItemStack.is(Items.POISONOUS_POTATO) && hand == InteractionHand.MAIN_HAND) {
				GiveGlowingEffectC2SPayload payload = new GiveGlowingEffectC2SPayload(hitResult.getEntity().getId());
				ClientPlayNetworking.send(payload);

				return InteractionResult.SUCCESS;
			}

			return InteractionResult.PASS;
		});
```


我们使用必要的参数创建 `GiveGlowingEffectC2SPayload` 的实例。 本例为目标实体的网络 ID。


```java
package com.example.docs.network.basic;

import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;

import com.example.docs.networking.basic.GiveGlowingEffectC2SPayload;
import com.example.docs.networking.basic.SummonLightningS2CPayload;

public class FabricDocsReferenceNetworkingBasicClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		// :::client_global_receiver
		ClientPlayNetworking.registerGlobalReceiver(SummonLightningS2CPayload.ID, (payload, context) -> {
			ClientLevel world = context.client().level;

			if (world == null) {
				return;
			}

			BlockPos lightningPos = payload.pos();
			LightningBolt entity = EntityType.LIGHTNING_BOLT.create(world, EntitySpawnReason.TRIGGERED);

			if (entity != null) {
				entity.setPos(lightningPos.getX(), lightningPos.getY(), lightningPos.getZ());
				world.addEntity(entity);
			}
		});
		// :::client_global_receiver

		// :::use_entity_callback
		UseEntityCallback.EVENT.register((player, world, hand, entity, hitResult) -> {
			if (!world.isClientSide()) {
				return InteractionResult.PASS;
			}

			ItemStack usedItemStack = player.getItemInHand(hand);

			if (entity instanceof LivingEntity && usedItemStack.is(Items.POISONOUS_POTATO) && hand == InteractionHand.MAIN_HAND) {
				GiveGlowingEffectC2SPayload payload = new GiveGlowingEffectC2SPayload(hitResult.getEntity().getId());
				ClientPlayNetworking.send(payload);

				return InteractionResult.SUCCESS;
			}

			return InteractionResult.PASS;
		});
		// :::use_entity_callback
	}
}
```


最后，我们通过使用 `GiveGlowingEffectC2SPayload` 实例调用 `ClientPlayNetworking.send` 向服务器发送一个数据包。


```java
package com.example.docs.network.basic;

import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;

import com.example.docs.networking.basic.GiveGlowingEffectC2SPayload;
import com.example.docs.networking.basic.SummonLightningS2CPayload;

public class FabricDocsReferenceNetworkingBasicClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		// :::client_global_receiver
		ClientPlayNetworking.registerGlobalReceiver(SummonLightningS2CPayload.ID, (payload, context) -> {
			ClientLevel world = context.client().level;

			if (world == null) {
				return;
			}

			BlockPos lightningPos = payload.pos();
			LightningBolt entity = EntityType.LIGHTNING_BOLT.create(world, EntitySpawnReason.TRIGGERED);

			if (entity != null) {
				entity.setPos(lightningPos.getX(), lightningPos.getY(), lightningPos.getZ());
				world.addEntity(entity);
			}
		});
		// :::client_global_receiver

		// :::use_entity_callback
		UseEntityCallback.EVENT.register((player, world, hand, entity, hitResult) -> {
			if (!world.isClientSide()) {
				return InteractionResult.PASS;
			}

			ItemStack usedItemStack = player.getItemInHand(hand);

			if (entity instanceof LivingEntity && usedItemStack.is(Items.POISONOUS_POTATO) && hand == InteractionHand.MAIN_HAND) {
				GiveGlowingEffectC2SPayload payload = new GiveGlowingEffectC2SPayload(hitResult.getEntity().getId());
				ClientPlayNetworking.send(payload);

				return InteractionResult.SUCCESS;
			}

			return InteractionResult.PASS;
		});
		// :::use_entity_callback
	}
}
```


### 在服务器接收数据包 {#receiving-a-packet-on-the-server}

这可以在**通用初始化程序**中完成，通过调用 `ServerPlayNetworking.registerGlobalReceiver` 并传递 `CustomPayload.Id` 和 `PlayPayloadHandler`。


```java
		ServerPlayNetworking.registerGlobalReceiver(GiveGlowingEffectC2SPayload.ID, (payload, context) -> {
			Entity entity = context.player().level().getEntity(payload.entityId());

			if (entity instanceof LivingEntity livingEntity && livingEntity.closerThan(context.player(), 5)) {
				livingEntity.addEffect(new MobEffectInstance(MobEffects.GLOWING, 100));
			}
		});
```


:::info
在服务器端验证数据包的内容非常重要。

在这种情况下，我们根据实体的网络 ID 来验证该实体是否存在。


```java
package com.example.docs.networking.basic;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.Item;
import com.example.docs.FabricDocsReference;

public class FabricDocsReferenceNetworkingBasic implements ModInitializer {
	public static final ResourceKey<Item> LIGHTNING_TATER_REGISTRY_KEY = ResourceKey.create(Registries.ITEM, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "lightning_tater"));
	public static final Item LIGHTNING_TATER = Registry.register(BuiltInRegistries.ITEM, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "lightning_tater"), new LightningTaterItem(new Item.Properties().setId(LIGHTNING_TATER_REGISTRY_KEY)));

	public void onInitialize() {
		PayloadTypeRegistry.playS2C().register(SummonLightningS2CPayload.ID, SummonLightningS2CPayload.CODEC);
		PayloadTypeRegistry.playC2S().register(GiveGlowingEffectC2SPayload.ID, GiveGlowingEffectC2SPayload.CODEC);

		// :::server_global_receiver
		ServerPlayNetworking.registerGlobalReceiver(GiveGlowingEffectC2SPayload.ID, (payload, context) -> {
			Entity entity = context.player().level().getEntity(payload.entityId());

			if (entity instanceof LivingEntity livingEntity && livingEntity.closerThan(context.player(), 5)) {
				livingEntity.addEffect(new MobEffectInstance(MobEffects.GLOWING, 100));
			}
		});
		// :::server_global_receiver
	}
}
```


此外，目标实体必须是生物实体，并且我们将目标实体的范围限制在距离玩家 5 的​​范围内。


```java
package com.example.docs.networking.basic;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.Item;
import com.example.docs.FabricDocsReference;

public class FabricDocsReferenceNetworkingBasic implements ModInitializer {
	public static final ResourceKey<Item> LIGHTNING_TATER_REGISTRY_KEY = ResourceKey.create(Registries.ITEM, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "lightning_tater"));
	public static final Item LIGHTNING_TATER = Registry.register(BuiltInRegistries.ITEM, ResourceLocation.fromNamespaceAndPath(FabricDocsReference.MOD_ID, "lightning_tater"), new LightningTaterItem(new Item.Properties().setId(LIGHTNING_TATER_REGISTRY_KEY)));

	public void onInitialize() {
		PayloadTypeRegistry.playS2C().register(SummonLightningS2CPayload.ID, SummonLightningS2CPayload.CODEC);
		PayloadTypeRegistry.playC2S().register(GiveGlowingEffectC2SPayload.ID, GiveGlowingEffectC2SPayload.CODEC);

		// :::server_global_receiver
		ServerPlayNetworking.registerGlobalReceiver(GiveGlowingEffectC2SPayload.ID, (payload, context) -> {
			Entity entity = context.player().level().getEntity(payload.entityId());

			if (entity instanceof LivingEntity livingEntity && livingEntity.closerThan(context.player(), 5)) {
				livingEntity.addEffect(new MobEffectInstance(MobEffects.GLOWING, 100));
			}
		});
		// :::server_global_receiver
	}
}
```

:::

现在，当任何玩家尝试对生物实体使用毒马铃薯时，它就会产生发光效果。

<VideoPlayer src="/assets/develop/networking/use-poisonous-potato.webm">将毒马铃薯用于生物实体时应用发光效果</VideoPlayer>
