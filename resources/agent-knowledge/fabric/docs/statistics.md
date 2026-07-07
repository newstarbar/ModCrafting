# statistics
> 来源: https://docs.fabricmc.net/zh_cn/develop/statistics

# 统计信息 26.1.2 ​

学习如何创建和使用自定义玩家统计信息。

统计信息（Statistics，简称 Stats）是一种用于记录玩家在世界中执行特定操作或消耗时间的方式。 原版游戏会追踪许多常见行为的统计信息，例如跳跃、乘船移动、与方块交互、物品使用等。 你也可以添加自己的统计项来追踪某些自定义交互。

#

# 创建统计信息 ​

要添加一个自定义统计信息，首先创建一个 `Identifier`，它将用于注册和增加该统计信息：

```
public static final Identifier FRIENDSHIPS_MADE = register("friendships_made", StatFormatter.DEFAULT);
```

然后注册该统计信息：

```java
public class ModStats {
	public static final Identifier FRIENDSHIPS_MADE = register("friendships_made", StatFormatter.DEFAULT);

	private static Identifier register(String name, StatFormatter formatter) {
		Identifier id = Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, name);
		Registry.register(BuiltInRegistries.CUSTOM_STAT, name, id);
		Stats.CUSTOM.get(id, formatter);
		return id;
	}
}
```

当通过 `Stats.CUSTOM.get()` 将统计信息添加到统计信息屏幕时，你还可以指定统计格式化器，用于决定统计列表中的数字显示方式。 原版提供了以下格式化器：

- `DEFAULT`：直接显示数字。
- `DIVIDE_BY_TEN`：将数字除以 10 后以小数形式显示。
- `DISTANCE`：将数字显示为距离。根据数值大小，显示为厘米、米或千米。
- `TIME`：将数字显示为时间。 根据数值大小，显示为秒、分钟、小时或天。

不要忘记在你的[模组初始化器](./getting-started/project-structure#entrypoints)中初始化 `ModStats` 类：

```java
public static void initialize() {
}
```

```java
public class ExampleModStats implements ModInitializer {
	@Override
	public void onInitialize() {
		ModStats.initialize();
	}
}
```

#

# 使用统计信息 ​

在本示例中，我们将创建一个 Friends 方块，它会与相邻方块建立友谊关系。 我们将统计玩家通过该方块建立了多少次友谊。

为此，我们使用 `Player#awardStat(stat, amount)` 方法，在放置方块时按照其相邻方块的数量增加统计值：

```java
public class FriendsBlock extends Block {
	@Override
	public void setPlacedBy(Level level, BlockPos pos, BlockState state, @Nullable LivingEntity by, ItemStack itemStack) {
		super.setPlacedBy(level, pos, state, by, itemStack);

		if (!(by instanceof Player player)) return;

		int neighborCount = 0;

		for (Direction dir : Direction.values()) {
			if (!level.isEmptyBlock(pos.relative(dir))) {
				neighborCount++;
			}
		}

		player.awardStat(ModStats.FRIENDSHIPS_MADE, neighborCount);
	}
}
```

你也可以使用 `Player#awardStat(stat)` 将统计值增加 1。

由于 Friends 方块彼此关系十分紧密，破坏其中一个意味着所有友谊都会被打破。 我们可以通过使用 `Player#resetStat()`，使得当玩家破坏一个 Friends 方块时，将该统计值重置为 0：

```java
@Override
public BlockState playerWillDestroy(Level level, BlockPos pos, BlockState state, Player player) {
	player.resetStat(Stats.CUSTOM.get(ModStats.FRIENDSHIPS_MADE));

	return super.playerWillDestroy(level, pos, state, player);
}
```