---
title: Mixin 访问器
description: 了解如何使用 Mixin 的访问器和调用器来访问方法和字段。
authors:
  - Bawnorton
  - bluebear94
  - cassiancc
  - MildestToucan
---

Mixin 通常用于修改现有代码以生成和调整行为。 然而，Mixin 同样提供了以访问器 Mixin 的形式，来访问无法直接访问的字段和方法的工具。

[类修改器](../class-tweakers) 以 [访问拓宽器](../class-tweakers/access-widening) 的形式提供了类似的工具，但 Mixin 的访问器不需要重新加载 Gradle，并且可以应用于非 Minecraft 目标。

如果需要重写 final 方法、继承 final 类或引用 private 类，仍然需要使用访问拓宽，因为访问器只能针对字段和方法。

## 创建访问器接口 {#creating-the-accessor-interface}

访问器 Mixin 必须始终是一个接口，且只能包含带有 `@Accessor` 或 `@Invoker` 注解的方法。 该接口必须像其他 Mixin 类一样，使用 `@Mixin` 注解进行标记。

按照惯例，访问器接口通常以其目标类名加上 `Accessor` 后缀来命名，并放置在 Mixin 包下的 `accessor` 子包中。
例如 `your.package.mixin.accessor`

## 字段访问器 {#field-accessors}

字段可以通过带有 `@Accessor` 注解的 getter 和/或 setter 方法进行访问：

::: tabs

== 实例字段

Getter/Setter 语法：

实例访问器方法应当带有你的模组 ID 前缀和一个分隔符（通常为 `$` 或 `_`），以确保它不会与任何其他方法发生冲突。

```java
@Accessor("<field name>")
FieldType example_mod$getFieldName();

@Accessor("<field name>")
void example_mod$setFieldName(FieldType value);
```

示例：


```java
// region mixin_accessors_instance_field_accessor_example not found — showing file head
package com.example.docs.mixin.client.accessor;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

import net.minecraft.client.gui.Gui;

//#region mixin_accessors_instance_field_accessor_example
@Mixin(Gui.class)
public interface GuiAccessor {
	@Accessor("overlayMessageTime")
	int example_mod$getOverlayMessageTime();

	@Accessor("overlayMessageTime")
	void example_mod$setOverlayMessageTime(int messageTime);
}
//#endregion mixin_accessors_instance_field_accessor_example

```

用法：


```java
// region mixin_accessors_instance_field_accessor_example_usage not found — showing file head
package com.example.docs.accessor_usage.client;

import net.minecraft.client.gui.Gui;

import com.example.docs.mixin.client.accessor.GuiAccessor;

/*
Class to hold example code for using the example accessor mixins,
which happen to be in the client sourceset
*/
@SuppressWarnings("unused")
final class ExampleModAccessorUsageClient {
	private ExampleModAccessorUsageClient() {
	}

	//#region mixin_accessors_instance_field_accessor_example_usage
	void exampleInstanceFieldAccessorUsage(Gui gui, int newMessageTime) {
		int oldMessageTime = ((GuiAccessor) gui).example_mod$getOverlayMessageTime();

		((GuiAccessor) gui).example_mod$setOverlayMessageTime(newMessageTime);
	}
	//#endregion mixin_accessors_instance_field_accessor_example_usage
}

```

== 静态字段

Getter/Setter 语法：

对于静态字段，模组 ID 前缀不是必需的，因为静态方法之间不会发生冲突。

为了满足 Java 编译器的要求，我们让静态访问器方法的方法体总是抛出异常，不过在应用过程中，Mixin 总是会对其进行实现。

```java
@Accessor("<field name>")
static FieldType getFieldName() {
    throw new AssertionError("Untransformed @Accessor");
}

@Accessor("<field name>")
static void setFieldName(FieldType value) {
}
```

示例：


```java
// region mixin_accessors_static_field_accessor_example not found — showing file head
package com.example.docs.mixin.accessor;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

import net.minecraft.network.protocol.common.ClientboundCustomPayloadPacket;

//#region mixin_accessors_static_field_accessor_example
@Mixin(ClientboundCustomPayloadPacket.class)
public interface ClientboundCustomPayloadPacketAccessor {
	@Accessor("MAX_PAYLOAD_SIZE")
	static int getMaxPayloadSize() {
		throw new AssertionError("Untransformed @Accessor");
	}

	@Accessor("MAX_PAYLOAD_SIZE")
	static void setMaxPayloadSize(int size) {
		throw new AssertionError("Untransformed @Accessor");
	}
}
//#endregion mixin_accessors_static_field_accessor_example

```

用法：


```java
// region mixin_accessors_static_field_accessor_example_usage not found — showing file head
package com.example.docs.accessor_usage;

import net.minecraft.core.BlockPos;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.ShulkerBoxBlockEntity;
import net.minecraft.world.level.block.state.BlockState;

import com.example.docs.mixin.accessor.ClientboundCustomPayloadPacketAccessor;
import com.example.docs.mixin.accessor.IdentifierAccessor;
import com.example.docs.mixin.accessor.InventoryAccessor;
import com.example.docs.mixin.accessor.ShulkerBoxBlockAccessor;

// Class to hold example code for using the example accessor mixins
@SuppressWarnings("unused")
final class ExampleModAccessorUsage {
	private ExampleModAccessorUsage() {
	}

	//#region mixin_accessors_static_field_accessor_example_usage
	void exampleStaticFieldAccessorUsage(int newPayloadSize) {
		int maxPayloadSize = ClientboundCustomPayloadPacketAccessor.getMaxPayloadSize();

		ClientboundCustomPayloadPacketAccessor.setMaxPayloadSize(newPayloadSize);
	}
	//#endregion mixin_accessors_static_field_accessor_example_usage

	@SuppressWarnings("StatementWithEmptyBody")
	//#region mixin_accessors_static_invoker_example_usage
	void exampleStaticMethodInvokerUsage(BlockState state, Level level, BlockPos pos, ShulkerBoxBlockEntity blockEntity) {
		if (ShulkerBoxBlockAccessor.canOpen(state, level, pos, blockEntity)) {
			/* ... */
		}
	}
	//#endregion mixin_accessors_static_invoker_example_usage

	@SuppressWarnings("StatementWithEmptyBody")
	//#region mixin_accessors_instance_invoker_example_usage
```

:::

### 设置 Final 字段 {#setting-final-fields}

如果目标字段是 final 的，请在访问器的 setter 方法上添加 `@Mutable` 注解，以便在应用过程中移除 final 标记：


```java
// region mixin_accessors_mutable_setter_example not found — showing file head
package com.example.docs.mixin.accessor;

import java.util.Map;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Mutable;
import org.spongepowered.asm.mixin.gen.Accessor;

import net.minecraft.world.entity.npc.villager.Villager;
import net.minecraft.world.item.Item;

//#region mixin_accessors_mutable_setter_example
@Mixin(Villager.class)
public interface VillagerAccessor {
	@Accessor("FOOD_POINTS")
	@Mutable
	void example_mod$setItemFoodValues(Map<Item, Integer> items);
}
//#endregion mixin_accessors_mutable_setter_example

```

## 方法调用器 {#method-invokers}

要调用无法直接访问的方法或构造函数，请创建一个签名匹配且带有 `@Invoker` 注解的方法：

::: tabs

== 实例方法

语法：

实例调用器方法应当带有你的模组 ID 前缀和一个分隔符（通常为 `$` 或 `_`），以确保它不会与任何其他方法发生冲突。

调用器方法通常直接以目标方法命名，或者使用 `invoke` 或 `call` 后跟目标方法名。

```java
@Invoker("<method name>")
MethodReturnType example_mod$methodName(/* matching parameters */)
```

示例：


```java
// region mixin_accessors_instance_invoker_example not found — showing file head
package com.example.docs.mixin.accessor;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;

//#region mixin_accessors_instance_invoker_example
@Mixin(Inventory.class)
public interface InventoryAccessor {
	@Invoker("hasRemainingSpaceForItem")
	boolean example_mod$hasRemainingSpaceForItem(ItemStack slotItemStack, ItemStack newItemStack);
}
//#endregion mixin_accessors_instance_invoker_example

```

用法：


```java
// region mixin_accessors_instance_invoker_example_usage not found — showing file head
package com.example.docs.accessor_usage;

import net.minecraft.core.BlockPos;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.ShulkerBoxBlockEntity;
import net.minecraft.world.level.block.state.BlockState;

import com.example.docs.mixin.accessor.ClientboundCustomPayloadPacketAccessor;
import com.example.docs.mixin.accessor.IdentifierAccessor;
import com.example.docs.mixin.accessor.InventoryAccessor;
import com.example.docs.mixin.accessor.ShulkerBoxBlockAccessor;

// Class to hold example code for using the example accessor mixins
@SuppressWarnings("unused")
final class ExampleModAccessorUsage {
	private ExampleModAccessorUsage() {
	}

	//#region mixin_accessors_static_field_accessor_example_usage
	void exampleStaticFieldAccessorUsage(int newPayloadSize) {
		int maxPayloadSize = ClientboundCustomPayloadPacketAccessor.getMaxPayloadSize();

		ClientboundCustomPayloadPacketAccessor.setMaxPayloadSize(newPayloadSize);
	}
	//#endregion mixin_accessors_static_field_accessor_example_usage

	@SuppressWarnings("StatementWithEmptyBody")
	//#region mixin_accessors_static_invoker_example_usage
	void exampleStaticMethodInvokerUsage(BlockState state, Level level, BlockPos pos, ShulkerBoxBlockEntity blockEntity) {
		if (ShulkerBoxBlockAccessor.canOpen(state, level, pos, blockEntity)) {
			/* ... */
		}
	}
	//#endregion mixin_accessors_static_invoker_example_usage

	@SuppressWarnings("StatementWithEmptyBody")
	//#region mixin_accessors_instance_invoker_example_usage
```

== 静态方法

语法：

对于静态方法，模组 ID 前缀不是必需的，因为静态方法之间不会发生冲突。

为了满足 Java 编译器的要求，我们让静态调用器方法的方法体总是抛出异常，不过在应用过程中，Mixin 总是会对其进行实现。

```java
@Invoker("<method name>")
static MethodReturnType invokeMethodName(/* matching parameters */) {
    throw new AssertionError("Untransformed @Accessor");
}
```

示例：


```java
// region mixin_accessors_static_invoker_example not found — showing file head
package com.example.docs.mixin.accessor;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.ShulkerBoxBlock;
import net.minecraft.world.level.block.entity.ShulkerBoxBlockEntity;
import net.minecraft.world.level.block.state.BlockState;

//#region mixin_accessors_static_invoker_example
@Mixin(ShulkerBoxBlock.class)
public interface ShulkerBoxBlockAccessor {
	@Invoker("canOpen")
	static boolean canOpen(BlockState state, Level level, BlockPos pos, ShulkerBoxBlockEntity blockEntity) {
		throw new AssertionError("Untransformed @Accessor");
	}
}
//#endregion mixin_accessors_static_invoker_example

```

用法：


```java
// region mixin_accessors_static_invoker_example_usage not found — showing file head
package com.example.docs.accessor_usage;

import net.minecraft.core.BlockPos;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.ShulkerBoxBlockEntity;
import net.minecraft.world.level.block.state.BlockState;

import com.example.docs.mixin.accessor.ClientboundCustomPayloadPacketAccessor;
import com.example.docs.mixin.accessor.IdentifierAccessor;
import com.example.docs.mixin.accessor.InventoryAccessor;
import com.example.docs.mixin.accessor.ShulkerBoxBlockAccessor;

// Class to hold example code for using the example accessor mixins
@SuppressWarnings("unused")
final class ExampleModAccessorUsage {
	private ExampleModAccessorUsage() {
	}

	//#region mixin_accessors_static_field_accessor_example_usage
	void exampleStaticFieldAccessorUsage(int newPayloadSize) {
		int maxPayloadSize = ClientboundCustomPayloadPacketAccessor.getMaxPayloadSize();

		ClientboundCustomPayloadPacketAccessor.setMaxPayloadSize(newPayloadSize);
	}
	//#endregion mixin_accessors_static_field_accessor_example_usage

	@SuppressWarnings("StatementWithEmptyBody")
	//#region mixin_accessors_static_invoker_example_usage
	void exampleStaticMethodInvokerUsage(BlockState state, Level level, BlockPos pos, ShulkerBoxBlockEntity blockEntity) {
		if (ShulkerBoxBlockAccessor.canOpen(state, level, pos, blockEntity)) {
			/* ... */
		}
	}
	//#endregion mixin_accessors_static_invoker_example_usage

	@SuppressWarnings("StatementWithEmptyBody")
	//#region mixin_accessors_instance_invoker_example_usage
```

== 构造函数

语法：

构造函数调用器方法按照惯例通常命名为 `createTargetClass` 或 `newTargetClass`，且始终为 `static`，并且 `@Invoker` 注解的值始终使用 `<init>`。

```java
@Invoker("<init>")
static TargetClass newTargetClass(/* matching parameters */)
```

示例：


```java
// region mixin_accessors_constructor_invoker_example not found — showing file head
package com.example.docs.mixin.accessor;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

import net.minecraft.resources.Identifier;

//#region mixin_accessors_constructor_invoker_example
@Mixin(Identifier.class)
public interface IdentifierAccessor {
	@Invoker("<init>")
	static Identifier newIdentifier(String namespace, String path) {
		throw new AssertionError("Untransformed @Accessor");
	}
}
//#endregion mixin_accessors_constructor_invoker_example

```

用法：


```java
// region mixin_accessors_constructor_invoker_example_usage not found — showing file head
package com.example.docs.accessor_usage;

import net.minecraft.core.BlockPos;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.ShulkerBoxBlockEntity;
import net.minecraft.world.level.block.state.BlockState;

import com.example.docs.mixin.accessor.ClientboundCustomPayloadPacketAccessor;
import com.example.docs.mixin.accessor.IdentifierAccessor;
import com.example.docs.mixin.accessor.InventoryAccessor;
import com.example.docs.mixin.accessor.ShulkerBoxBlockAccessor;

// Class to hold example code for using the example accessor mixins
@SuppressWarnings("unused")
final class ExampleModAccessorUsage {
	private ExampleModAccessorUsage() {
	}

	//#region mixin_accessors_static_field_accessor_example_usage
	void exampleStaticFieldAccessorUsage(int newPayloadSize) {
		int maxPayloadSize = ClientboundCustomPayloadPacketAccessor.getMaxPayloadSize();

		ClientboundCustomPayloadPacketAccessor.setMaxPayloadSize(newPayloadSize);
	}
	//#endregion mixin_accessors_static_field_accessor_example_usage

	@SuppressWarnings("StatementWithEmptyBody")
	//#region mixin_accessors_static_invoker_example_usage
	void exampleStaticMethodInvokerUsage(BlockState state, Level level, BlockPos pos, ShulkerBoxBlockEntity blockEntity) {
		if (ShulkerBoxBlockAccessor.canOpen(state, level, pos, blockEntity)) {
			/* ... */
		}
	}
	//#endregion mixin_accessors_static_invoker_example_usage

	@SuppressWarnings("StatementWithEmptyBody")
	//#region mixin_accessors_instance_invoker_example_usage
```

:::

## 对 Final 类使用访问器 {#accessors-for-final-classes}

由于 Java 编译器对 final 类的限制更为严格，它不允许我们直接将 final 类的实例强制转换为访问器接口。

为了解决这个问题，我们只需要先将其转换为 `Object`，然后再转换为访问器接口即可：

```java
((TargetClassAccessor) (Object) targetClassInstance).example_mod$accessorMethod(/* ... */)
```
