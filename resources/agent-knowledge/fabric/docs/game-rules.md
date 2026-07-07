# game rules
> 来源: https://docs.fabricmc.net/zh_cn/develop/game-rules

# 游戏规则 26.1.2 ​

添加自定义游戏规则的指南。

前置条件

你可能需要先完成[翻译生成](./data-generation/translations)，但这并不是必需的。

游戏规则是特定于世界的配置选项，玩家可以在游戏中使用命令来更改。 这些变量通常控制世界的某些功能，例如 `pvp`、`spawn_monsters` 和 `advance_time` 分别控制 PvP 是否启用、怪物生成和时间流逝。

#

# 创建游戏规则 ​

要创建自定义游戏规则，首先要创建一个 `GameRules` 类；我们将在这里声明我们的游戏规则。 在这个类中，声明两个常量：游戏规则标识符和规则本身。

```java
public class ExampleModGameRules implements ModInitializer {
	// Create and register a boolean gamerule, disabled by default
	public static final GameRule<Boolean> BAD_VISION_BOOLEAN_GAMERULE = GameRuleBuilder
					.forBoolean(false) // Default value declaration
					.category(GameRuleCategory.MISC)
					.buildAndRegister(Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "bad_vision"));
}
```

类别参数（`.category(GameRuleCategory.MISC)`）决定游戏规则在创建世界屏幕中属于哪个类别。 本例使用原版提供的“杂项”类别，但可以通过 `GameRuleCategory.register` 添加其他类别。 在这个示例中，我们创建了一个布尔游戏规则，默认值为 `false`，ID 为 `bad_vision`。 游戏规则中存储的值不仅限于布尔值，其他有效的类型包括 `Double`、`Integer` 和 `Enum`。

游戏规则中存储双精度浮点数的示例：

```
public static final GameRule<Double> DOUBLE_GAMERULE = GameRuleBuilder
				.forDouble(6.7) // Default value declaration
				.category(GameRuleCategory.MISC)
				.buildAndRegister(Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "double_example"));
```

#

# 访问游戏规则 ​

现在我们有了游戏规则及其 `Identifier` 标识符，你可以使用 `serverLevel.getGameRules().get(GAMERULE)` 方法在任何地方访问它，其中 `.get()` 的参数是你的游戏规则常量，而不是游戏规则 ID。

```
// Check for the state of the gamerule
boolean badVisionEnabled = serverLevel.getGameRules().get(ExampleModGameRules.BAD_VISION_BOOLEAN_GAMERULE);
```

你还可以使用这个访问原版游戏规则的值：

```
boolean doMobGriefing = serverLevel.getGameRules().get(GameRules.MOB_GRIEFING);
```

例如，对于一条游戏规则：当为 true 时对所有玩家施加失明效果，其实现方式如下：

```java
// In your mod's onInitialize():
ServerTickEvents.END_LEVEL_TICK.register(serverLevel -> {
	// Runs every tick on the server
	// Check for the state of the gamerule
	boolean badVisionEnabled = serverLevel.getGameRules().get(ExampleModGameRules.BAD_VISION_BOOLEAN_GAMERULE);

	if (badVisionEnabled) {
		// If the gamerule is true
		for (Player player : serverLevel.getPlayers(p -> true)) {
			// Apply blindness to every player
			player.addEffect(new MobEffectInstance(
							MobEffects.BLINDNESS,
							40,
							1,
							false,
							false,
							false
			));
		}
	}
});
```

#

# 翻译 ​

现在，我们需要给游戏规则添加一个显示名，以便在“游戏规则”屏幕中能够轻松理解。 要通过数据生成来实现这一点，将以下代码添加到你的语言提供程序中：

```
translationBuilder.add(Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "bad_vision"), "Bad Vision");
```

最后，我们需要给游戏规则添加描述。 要通过数据生成来实现这一点，将以下代码添加到你的语言提供程序中：

```
translationBuilder.add(
				Util.makeDescriptionId("gamerule", Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "bad_vision")),
				"Gives every player the blindness effect" // A short description of the game rule
);
```

INFO

这些翻译键用于在游戏规则屏幕中显示文本。 若不使用数据生成，也可以在 `assets/example-mod/lang/en_us.json` 中手动编写它们。

```
"example-mod.bad_vision": "Bad Vision",
"gamerule.example-mod.bad_vision": "Gives every player the blindness effect",
```

#

# 游戏内更改游戏规则 ​

现在，你应该可以使用 `/gamerule` 命令在游戏中更改规则的值，如下所示：

```
/gamerule example-mod:bad_vision true
```

现在，该游戏规则也会显示在“编辑游戏规则”屏幕的“杂项”类别中。