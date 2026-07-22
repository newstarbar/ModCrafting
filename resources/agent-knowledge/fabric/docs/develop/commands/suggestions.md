---
title: 命令建议
description: 学习如何向用户建议命令参数的值。
authors:
  - IMB11
---

Minecraft 有个强大的命令建议系统，用在很多地方，例如 `/give` 命令中。 该系统允许您向用户建议命令参数的值，然后他们可以从中选择——这是使你的命令更加用户友好且用起来舒适的好办法。

## 建议提供器{#suggestion-providers}

`SuggestionProvider` 用于制作将会发送至客户端的建议的列表。 建议提供器是一个函数式接口，接收一个 `CommandContext` 和 `SuggestionBuilder` 并返回 `Suggestions`。 `SuggestionProvider` 返回 `CompletableFuture`，因为这些建议并不一定立即可用。

## 使用建议提供器{#using-suggestion-providers}

要使用建议提供器，你需要在 argument builder 中调用 `suggests` 方法。 此方法接收一个 `SuggestionProvider`，返回一个附加了新的建议提供器的 argument builder。


```java
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
			dispatcher.register(Commands.literal("command_with_suggestions").then(
					Commands.argument("entity", ResourceArgument.resource(registryAccess, Registries.ENTITY_TYPE))
							.suggests(SuggestionProviders.SUMMONABLE_ENTITIES)
							.executes(FabricDocsReferenceCommands::executeCommandWithSuggestions)
			));
		});
```


```java
	private static int executeCommandWithSuggestions(CommandContext<CommandSourceStack> context) throws CommandSyntaxException {
		var entityType = ResourceArgument.getSummonableEntityType(context, "entity");
		context.getSource().sendSuccess(() -> Component.literal("Called /command_with_suggestions with entity = %s".formatted(entityType.value().toShortString())), false);
		return 1;
	}
```


## 内置的建议提供器{#built-in-suggestion-providers}

你可以使用一些内置的建议提供器：

| 建议提供器                                     | 描述           |
| ----------------------------------------- | ------------ |
| `SuggestionProviders.SUMMONABLE_ENTITIES` | 建议所有可召唤的实体。  |
| `SuggestionProviders.AVAILABLE_SOUNDS`    | 建议所有可播放的声音。  |
| `LootCommand.SUGGESTION_PROVIDER`         | 建议所有可用的战利品表。 |
| `SuggestionProviders.ALL_BIOMES`          | 建议所有可用的生物群系。 |

## 创建自定义的建议提供器{#creating-a-custom-suggestion-provider}

如果内置的建议提供器无法满足你的需要，可以创建自己的建议提供器。 为此，需要创建一个实现 `SuggestionProvider` 接口的类，并重写 `getSuggestions` 方法。

对此示例，我们需要制作一个建议提供器，建议所有在服务器上的玩家的名称。


```java
public class PlayerSuggestionProvider implements SuggestionProvider<CommandSourceStack> {
	@Override
	public CompletableFuture<Suggestions> getSuggestions(CommandContext<CommandSourceStack> context, SuggestionsBuilder builder) throws CommandSyntaxException {
		CommandSourceStack source = context.getSource();

		// Thankfully, the ServerCommandSource has a method to get a list of player names.
		Collection<String> playerNames = source.getOnlinePlayerNames();

		// Add all player names to the builder.
		for (String playerName : playerNames) {
			builder.suggest(playerName);
		}

		// Lock the suggestions after we've modified them.
		return builder.buildFuture();
	}
}
```


要使用这个建议提供器，只需将一个实例传递到参数构造器的 `.suggests` 方法。


```java
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
			dispatcher.register(Commands.literal("command_with_custom_suggestions").then(
					Commands.argument("player_name", StringArgumentType.string())
							.suggests(new PlayerSuggestionProvider())
							.executes(FabricDocsReferenceCommands::executeCommandWithCustomSuggestions)
			));
		});
```


```java
	private static int executeCommandWithCustomSuggestions(CommandContext<CommandSourceStack> context) {
		String name = StringArgumentType.getString(context, "player_name");
		context.getSource().sendSuccess(() -> Component.literal("Called /command_with_custom_suggestions with value = %s".formatted(name)), false);
		return 1;
	}
```


显然，建议提供器能够更复杂，因为还可以读取命令上下文以根据命令的状态（例如已经提供的参数）提供建议。

这可以是读取玩家的物品栏并推荐物品或玩家附近的实体。
