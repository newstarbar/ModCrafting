---
title: 命令参数
description: 学习如何创建带有复杂参数的命令。
---

大多数命令都使用了参数。 有时参数是可选的，也就是说如果你不提供此参数，命令仍能运行。 一个节点可以有多个参数类型，但是注意有可能出现二义性，这是需要避免的。


```java
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
			dispatcher.register(Commands.literal("command_with_arg")
					.then(Commands.argument("value", IntegerArgumentType.integer())
							.executes(FabricDocsReferenceCommands::executeCommandWithArg)));
		});
```


```java
	private static int executeCommandWithArg(CommandContext<CommandSourceStack> context) {
		int value = IntegerArgumentType.getInteger(context, "value");
		context.getSource().sendSuccess(() -> Component.literal("Called /command_with_arg with value = %s".formatted(value)), false);
		return 1;
	}
```


在这个例子中，在命令文本 `/command_with_arg` 之后，你需要输入一个整数。 例如，如果运行 `/command_with_arg 3`，会收到反馈消息：

> 调用了 /command_with_arg 其中 value = 3

如果你输入 `/command_with_arg` 不带参数，命令无法正确解析。

接下来我们将添加第二个可选的参数：


```java
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
			dispatcher.register(Commands.literal("command_with_two_args")
					.then(Commands.argument("value_one", IntegerArgumentType.integer())
							.executes(FabricDocsReferenceCommands::executeWithOneArg)
							.then(Commands.argument("value_two", IntegerArgumentType.integer())
									.executes(FabricDocsReferenceCommands::executeWithTwoArgs))));
		});
```


```java
	private static int executeWithOneArg(CommandContext<CommandSourceStack> context) {
		int value1 = IntegerArgumentType.getInteger(context, "value_one");
		context.getSource().sendSuccess(() -> Component.literal("Called /command_with_two_args with value one = %s".formatted(value1)), false);
		return 1;
	}

	private static int executeWithTwoArgs(CommandContext<CommandSourceStack> context) {
		int value1 = IntegerArgumentType.getInteger(context, "value_one");
		int value2 = IntegerArgumentType.getInteger(context, "value_two");
		context.getSource().sendSuccess(() -> Component.literal("Called /argtater2 with value one = %s and value two = %s".formatted(value1, value2)),
				false);
		return 1;
	}
```


现在你可以输入一个或者两个整数了。 如果提供了一个整数，那么会打印单个值的反馈文本。 如果提供了两个整数，那么会打印有两个值的反馈文本。

你可能发现，两次指定类似的执行内容有些不太必要。 因此，我们可以创建一个在两个执行中都使用的方法。


```java
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
			dispatcher.register(Commands.literal("command_with_common_exec")
					.then(Commands.argument("value_one", IntegerArgumentType.integer())
							.executes(context -> executeCommon(IntegerArgumentType.getInteger(context, "value_one"), 0, context))
							.then(Commands.argument("value_two", IntegerArgumentType.integer())
									.executes(context -> executeCommon(
											IntegerArgumentType.getInteger(context, "value_one"),
											IntegerArgumentType.getInteger(context, "value_two"),
											context)))));
		});
```


```java
	private static int executeCommon(int value1, int value2, CommandContext<CommandSourceStack> context) {
		context.getSource().sendSuccess(() -> Component.literal("Called /command_with_common_exec with value 1 = %s and value 2 = %s".formatted(value1, value2)), false);
		return 1;
	}
```


## 自定义参数类型{#custom-argument-types}

如果原版没有你想要的参数类型，可以自己创建一个。 为此，创建一个类并继承 `ArgumentType<T>` 接口，其中 `T` 是参数的类型。

您需要实现 `parse` 这个方法，这个方法会把输入的字符串解析为期望的类型。

举个例子，您可以创建一个可以把格式形如 `{x, y, z}` 的字符串解析为一个 `BlockPos` 参数类型。


```java
public class BlockPosArgumentType implements ArgumentType<BlockPos> {
	/**
	 * Parse the BlockPos from the reader in the {x, y, z} format.
	 */
	@Override
	public BlockPos parse(StringReader reader) throws CommandSyntaxException {
		try {
			// This requires the argument to be surrounded by quotation marks.
			// eg: "{1, 2, 3}"
			String string = reader.readString();

			// Remove the { and } from the string using regex.
			string = string.replace("{", "").replace("}", "");

			// Split the string into the x, y, and z values.
			String[] split = string.split(",");

			// Parse the x, y, and z values from the split string.
			int x = Integer.parseInt(split[0].trim());
			int y = Integer.parseInt(split[1].trim());
			int z = Integer.parseInt(split[2].trim());

			// Return the BlockPos.
			return new BlockPos(x, y, z);
		} catch (Exception e) {
			// Throw an exception if anything fails inside the try block.
			throw CommandSyntaxException.BUILT_IN_EXCEPTIONS.dispatcherParseException().create("Invalid BlockPos format. Expected {x, y, z}");
		}
	}
}
```


### 注册自定义参数类型{#registering-custom-argument-types}

:::warning
您需要在服务端和客户端都注册自定义参数类型，否则命令不会生效！
:::

你可以在你的模组[入口点](./getting-started/project-structure#entrypoints)中的初始化方法 `onInitialize` 中使用 `ArgumentTypeRegistry` 类来注册：


```java
		ArgumentTypeRegistry.registerArgumentType(
				ResourceLocation.fromNamespaceAndPath("fabric-docs", "block_pos"),
				BlockPosArgumentType.class,
				SingletonArgumentInfo.contextFree(BlockPosArgumentType::new)
		);
```


### 使用自定义参数类型{#using-custom-argument-types}

我们可以在命令中使用我们的自定义参数类型──通过在 command builder 中传递实例到 `.argument` 方法。


```java
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
			dispatcher.register(Commands.literal("command_with_custom_arg").then(
					Commands.argument("block_pos", new BlockPosArgumentType())
							.executes(FabricDocsReferenceCommands::executeCustomArgCommand)
			));
		});
```


```java
	private static int executeCustomArgCommand(CommandContext<CommandSourceStack> context) {
		BlockPos arg = context.getArgument("block_pos", BlockPos.class);
		context.getSource().sendSuccess(() -> Component.literal("Called /command_with_custom_arg with block pos = %s".formatted(arg)), false);
		return 1;
	}
```


运行命令，我们可以测试参数类型是否生效：

![无效参数](/assets/develop/commands/custom-arguments_fail.png)

![有效参数](/assets/develop/commands/custom-arguments_valid.png)

![命令结果](/assets/develop/commands/custom-arguments_result.png)
