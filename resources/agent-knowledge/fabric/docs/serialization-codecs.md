# codecs
> 来源: https://docs.fabricmc.net/zh_cn/develop/serialization/codecs

# Codec 26.1.2 ​

一份用于理解和使用 Mojang 的 codec 系统以序列化和反序列化对象的全面指南。

codec 是用于简单地解析 Java 对象的系统，被包含在 Minecraft 所包含的 Mojang 的 DataFixerUpper (DFU) 库中。 在模组环境中，可用作读写 JSON 时 GSON 和 Jankson 的替代方案，尽管因为 Mojang 正在重写许多旧代码以使用 codec，codec 开始变量越来越重要。

codec 与 DFU 的另一个 API `DynamicOps` 一起使用。 一个 codec 定义一个对象的结构，而 dynamic ops 用于定义一个序列化格式，例如 JSON 或 NBT。 这意味着任何 codec 都可以与任何 dynamic ops 一起使用，反之亦然，这样使其极其灵活。

#

# 使用 codec ​

#

## 序列化和反序列化 ​

codec 的基本用法是将对象与特定格式之间进行序列化和反序列化。

由于一些原版的类已经定义了 codec，我们可以将其作为示例进行参考。 Mojang 默认提供了两个 dynamic ops 类，即 `JsonOps` 和 `NbtOps`，它们通常能够涵盖绝大多数使用场景。

现在，假设我们要把一个 `BlockPos` 对象序列化成 JSON 再反序列化回对象。 我们可以分别使用 `BlockPos.CODEC` 中的静态方法 `Codec#encodeStart` 和 `Codec#parse`。 Java Output

```java
BlockPos pos = new BlockPos(1, 2, 3);

// Serialize the BlockPos to a JsonElement
DataResult<JsonElement> serializeResult = BlockPos.CODEC.encodeStart(JsonOps.INSTANCE, pos);

// When actually writing a mod, you'll want to properly handle empty Optionals of course
JsonElement json = serializeResult.resultOrPartial(LOGGER::error).orElseThrow();

// Here we have our JSON value, which should correspond to `[1, 2, 3]`,
// as that's the format used by the BlockPos codec.
LOGGER.info("Serialized BlockPos: {}", json);
```

```
[
  1,
  2,
  3
]
```

使用 codec 时，返回的结果为 `DataResult` 的形式。 这是个包装，可以代表成功或者失败。 有几种方式使用：如果只想要我们序列化的值， `DataResult#result` 会简单返回一个包含我们的值的 `Optional` ，而 `DataResult#resultOrPartial` 还允许我们提供一个函数来处理可能发生的任何错误。 后者对于自定义数据包资源尤其有用，因为我们希望在记录错误的同时避免对其他部分产生干扰。

现在，让我们提取序列化数据，并将其反序列化为 `BlockPos` 对象：

```java
// Now we'll deserialize the JsonElement back into a BlockPos
DataResult<BlockPos> deserializeResult = BlockPos.CODEC.parse(JsonOps.INSTANCE, json);

// Again, we'll just grab our value from the deserializeResult
BlockPos deserializedPos = deserializeResult.resultOrPartial(LOGGER::error).orElseThrow();

// And we can see that we've successfully serialized and deserialized our BlockPos!
LOGGER.info("Deserialized BlockPos: {}", deserializedPos);
```

#

## 内置的 codec ​

正如之前所说，Mojang 已经为几个原版和标准 Java 类定义了 codec，包括但不限于 `BlockPos`、`BlockState`、`ItemStack`、`Identifier`、`Component` 和正则表达式 `Pattern`。 Mojang 自己的 codec 通常可以在类内找到名为 `CODEC` 的静态字段，其他的保持在 `Codecs` 类。 还要注意，所有原版注册表都包含方法来得到 `Codec`，例如，你可以使用 `BuiltInRegistries.BLOCK.byNameCodec()` 获取一个 `Codec<Block>`，可用于序列化为方块 id 或是反过来，以及一个 `holderByNameCodec()` 获取一个 `Codec<Holder<Block>>`。

Codec API 自己也包含一些基础类型的 codec，例如 `Codec.INT` 和 `Codec.STRING`。 这些都在 `Codec` 类中作为静态字段存在，通常用作更多复杂 codec 的基础，会在下方做出解释。

#

# 构建 codec ​

现在我们已经知道如何使用 codec，让我们看看我们如何构建自己的 codec。 假设我们有以下类，希望从 JSON 文件中反序列化其实例：

```java
public class CoolBeansClass {
	private final int beansAmount;
	private final Holder<Item> beanType;
	private final List<BlockPos> beanPositions;

	public CoolBeansClass(int beansAmount, Holder<Item> beanType, List<BlockPos> beanPositions) {
		// ...
	}

	public int getBeansAmount() {
		return this.beansAmount;
	}

	public Holder<Item> getBeanType() {
		return this.beanType;
	}

	public List<BlockPos> getBeanPositions() {
		return this.beanPositions;
	}
}
```

相应的 JSON 文件可能如下所示：

```java
{
  "bean_positions": [
    [
      1,
      2,
      3
    ],
    [
      4,
      5,
      6
    ]
  ],
  "bean_type": "example-mod:lightning_tater",
  "beans_amount": 5
}
```

我们可以通过将多个较小的 codec 组合在一起，为该类构建一个大型 codec。 在这种情况下，我们的每个字段都需要：

- 一个 `Codec<Integer>`
- 一个 `Codec<Item>`
- 一个 `Codec<List<BlockPos>>`

第一个可以从前面提到的 `Codec` 类中的原生 codec 中得到，也就是 `Codec.INT`。 而第二个可以从 `BuiltInRegistries.ITEM` 注册表中获取，该注册表提供 `byNameCodec()` 方法，返回 `Codec<Item>`。 我们没有用于 `List<BlockPos>` 的默认 codec，但我们可以从 `BlockPos.CODEC` 制作一个。

#

## 列表 ​

`Codec#listOf` 可用于创建任意 codec 的列表版本。 Codec Input Output

```
Codec<List<BlockPos>> listCodec = BlockPos.CODEC.listOf();
```

```
List<BlockPos> data = List.of(new BlockPos(10, 5, 7));
```

```
[
  [
    10,
    5,
    7
  ]
]
```

应该注意的是，以这种方式创建的 codec 总是会反序列化为一个 `ImmutableList`。 如果需要的是可变的列表，可以利用 xmap 在反序列化期间转换为可变列表。

#

## 合并用于类似 Record 类的 codec ​

现在每个字段都有了单独的 codec，我们可以使用 `RecordCodecBuilder` 为我们的类将其合并为一个 codec。 假定我们的类有一个包含想序列化的所有字段的构造方法，并且每个字段都有相应的 getter 方法。 这使其非常适合与 record 一起使用，但也可以用于常规类。

来看看如何为我们的 `CoolBeansClass` 创建一个 codec： Codec Input Output

```
public static final Codec<CoolBeansClass> CODEC = RecordCodecBuilder.create(instance -> instance.group(
		// Up to 16 fields can be declared here
		Codec.INT.fieldOf("beans_amount").forGetter(CoolBeansClass::getBeansAmount),
		Item.CODEC.fieldOf("bean_type").forGetter(CoolBeansClass::getBeanType),
		BlockPos.CODEC.listOf().fieldOf("bean_positions").forGetter(CoolBeansClass::getBeanPositions)
)
		.apply(instance, CoolBeansClass::new));
```

```
CoolBeansClass bean = new CoolBeansClass(
		5,
		BuiltInRegistries.ITEM.wrapAsHolder(ModItems.LIGHTNING_TATER),
		List.of(
				new BlockPos(1, 2, 3),
				new BlockPos(4, 5, 6)
		)
);
```

```java
{
  "bean_positions": [
    [
      1,
      2,
      3
    ],
    [
      4,
      5,
      6
    ]
  ],
  "bean_type": "example-mod:lightning_tater",
  "beans_amount": 5
}
```

在 group 中的每一行指定 codec、字段名称和 getter 方法。 调用 `Codec#fieldOf` 是为将 codec 转换为 map codec，调用 `forGetter` 则是指定了从类的实例中检索字段值的 getter 方法。 同时，调用 `apply` 则指定了用于创建新实例的构造函数。 注意 group 中的字段的顺序应与构造函数中参数的顺序相同。

这里也可以使用 `Codec#optionalFieldOf` 使字段可选，在 可选字段 章节会有解释。

#

## 不要将 MapCodec 与 Codec 混淆 ​

调用 `Codec#fieldOf` 会将 `Codec<T>` 转换成 `MapCodec<T>`，这是 `Codec<T>` 的一个变体，但不是直接实现。 正如其名称所示，`MapCodec` 保证序列化为 键到值的映射，或所使用的 `DynamicOps` 类似类型。 一些函数可能需要使用 `MapCodec` 而不是常规的 codec。

这种创建 `MapCodec` 的特殊方式本质上是在一个映射中封装源 codec 的值，并使用给定的字段名作为键。 例如，一个 `Codec<BlockPos>` 序列化为 JSON 时看起来像是这样：

```
[
  1,
  2,
  3
]
```

但当使用 `BlockPos.CODEC.fieldOf("pos")` 转换为 `MapCodec<BlockPos>` 时，看起来像是这样：

```java
{
  "pos": [
    1,
    2,
    3
  ]
}
```

虽然 map codec 最常见的用途是与其他 map codec 合并以构造一个完整类字段的 codec，如前文的合并用于类似 Record 类的 codec 章节所述，但也可以通过使用 `MapCodec#codec` 再次转换成常规的 codec，这将保持封装输入值的相同行为。

#

### 可选字段 ​

`Codec#optionalFieldOf` 可用于创建一个可选的 map codec。 反序列化过程中，当特定字段不存在于容器中时，反序列化为一个空的 `Optional`，或指定的默认值。 Codec Input Output

```
MapCodec<Optional<BlockPos>> optionalCodec = BlockPos.CODEC.optionalFieldOf("pos");
```

```
Optional<BlockPos> optionalBlockPos = Optional.empty();
```

```java
{}
```

`optionalFieldOf` 方法的第二个参数可用于传入默认值。 Codec Input Output

```
MapCodec<BlockPos> defaultCodec = BlockPos.CODEC.optionalFieldOf("pos", BlockPos.ZERO);
```

```
BlockPos defaultBlockPos = BlockPos.ZERO;
```

```java
{}
```

要注意，如果字段存在，但其值无效，若字段的值无效则字段会完全无法反序列化。

#

## 常量、约束和组合 ​

#

### Unit ​

`MapCodec.unitCodec` 可用于创建一个无论输入什么都总是反序列化为常量值的 codec。 序列化时什么也不做。 Codec Output

```
Codec<Integer> theMeaningOfCodec = MapCodec.unitCodec(42);
```

```java
{}
```

#

### 数值范围 ​

`Codec.intRange` 及其伙伴 `Codec.floatRange` 和 `Codec.doubleRange` 可用于创建只接受在指定的**包含两端的**范围内的数字值的 codec， 这适用于序列化和反序列化。 Codec Input Output

```
// Can't be more than 2
Codec<Integer> amountOfFriendsYouHave = Codec.intRange(0, 2);
```

```
int amount = 2;
```

```
2
```

#

### Pair ​

`Codec.pair` 将两个 codec `Codec<A>` 和 `Codec<B>` 合并为 `Codec<Pair<A, B>>`。 请记住，它只能与序列化到特定字段的Codec配合使用，例如转换的`MapCodec`或 记录Codec。 结果的 codec 将序列化为结合了两个使用的 codec 字段的 map。 Codec Input Output

```
// Create two separate boxed codecs
Codec<Integer> firstCodec = Codec.INT.fieldOf("i_am_number").codec();
Codec<Boolean> secondCodec = Codec.BOOL.fieldOf("this_statement_is_false").codec();

// And merge them into a pair codec
Codec<Pair<Integer, Boolean>> pairCodec = Codec.pair(firstCodec, secondCodec);
```

```
Pair<Integer, Boolean> pair = Pair.of(23, true);
```

```java
{
  "i_am_number": 23,
  "this_statement_is_false": true
}
```

#

### Either ​

`Codec.either` 将两个 codec `Codec<A>` 和 `Codec<B>` 组合为 `Codec<Either<A, B>>`。 产生的 codec 会在反序列化过程中尝试使用第一个 codec，并且_仅当失败时_才尝试使用第二个。 如果第二个也失败，则会返回第二个 codec 的错误。

#

### Map ​

要处理有任意键的 map，如 `HashMap`，可以使用 `Codec.unboundedMap`。 这将返回给定 `Codec<K>` 和 `Codec<V>` 的 `Codec<Map<K, V>>`。 生成的 codec 将序列化为 JSON 对象，或当前 dynamic ops 可用的任何等效对象。

由于 JSON 和 NBT 的限制，使用的键的 codec _必须_序列化为字符串。 这包括类型自身不是字符串但会序列化为字符串的 codec，例如 `Identifier.CODEC`。 看看下面的例子： Codec Input Output

```
// Create a codec for a map of Identifiers to integers
Codec<Map<Identifier, Integer>> mapCodec = Codec.unboundedMap(Identifier.CODEC, Codec.INT);
```

```
Map<Identifier, Integer> map = Map.of(
		Identifier.fromNamespaceAndPath("example", "number"), 23,
		Identifier.fromNamespaceAndPath("example", "the_cooler_number"), 42
);
```

```java
{
  "example:number": 23,
  "example:the_cooler_number": 42
}
```

正如你所见，因为 `Identifier.CODEC` 直接序列化到字符串，所以这样做有效。 对于不序列化为字符串的简单对象，可以通过使用 xmap及其相关函数 来转换它们以达到类似的效果。

#

## 相互可转换的类型 ​

#

### `xmap` ​

我们有两个可以互相转换的类，但没有继承关系。 例如，原版的 `BlockPos` 和 `Vec3d`。 如果我们有其中一个 codec，我们可以使用 `Codec#xmap` 创建一个双向的特定转换函数。

`BlockPos` 已有 codec，但让我们假装它不存在。 我们可以基于 `Vec3d` 的 codec 这样为它创建一个： Codec Input Output

```java
Codec<BlockPos> blockPosCodec = Vec3i.CODEC.xmap(
		// Convert Vec3i to BlockPos
		vec -> new BlockPos(vec.getX(), vec.getY(), vec.getZ()),
		// Convert BlockPos to Vec3i
		pos -> new Vec3i(pos.getX(), pos.getY(), pos.getZ())
);

// When converting an existing class (`X` for example)
// to your own class (`Y`) this way, it may be nice to
// add `toX` and static `fromX` methods to `Y` and use
// method references in your `xmap` call.
```

```
BlockPos pos = new BlockPos(1, 2, 3);
```

```
[
  1,
  2,
  3
]
```

#

### flatComapMap、comapFlatMap 与 flatXMap ​

`flatComapMap`、`comapFlatMap` 与 `flatXMap` 类似于 xmap，但允许一个或多个转换函数返回 DataResult。 这在实践中很有用，因为特定的对象实例可能并不总是适合转换。

以原版的 `Identifier` 为例。 虽然所有 Identifier 都能转换为字符串，但并非所有字符串都是有效的 Identifier，因此使用 xmap 意味着在转换失败时会抛出难以处理的异常。 正因如此，其内置 codec 实际上是对 `Codec.STRING` 应用了 `comapFlatMap`，很好地展示了如何使用它：

```java
public class Identifier {
	public static final Codec<Identifier> CODEC = Codec.STRING.comapFlatMap(
			Identifier::read, Identifier::toString
	);

	// ...

	public static DataResult<Identifier> read(String input) {
		try {
			return DataResult.success(Identifier.parse(input));
		} catch (IdentifierException e) {
			return DataResult.error(() -> "Not a valid identifier: " + input + " " + e.getMessage());
		}
	}

	// ...

}
```

虽然这些方法非常有用，但方法名称有点让人困惑，所以这里有一个表格帮助你记住应该使用哪一个： 可重写的方法 解码始终有效？ 编码始终有效？ `xmap` 是 是 `comapFlatMap` 否 是 `flatComapMap` 是 否 `flatXMap` 否 否

#

## 注册表分派 ​

`Codec#dispatch` 让我们可以定义一个 codec 的注册表，并根据序列化数据中字段的值分派到一个特定的 codec。 当反序列化有不同字段的对象，而这些字段依赖于类型，但不同类型仍代表相同的事物时，这非常有用。

例如我们有一个抽象的 `Bean` 接口与两个实现类：`StringyBean` 和 `CountingBean`。 为了用注册表分派序列化这些，我们需要一些东西：

- 每个 bean 类型的独立 codec。
- 一个 `BeanType<T extends Bean>` 类或 record，代表 bean 的类型并可返回它的 codec。
- 一个在 `Bean` 中可以用于检索其 `BeanType<?>` 的函数。
- 一个 `Identifier` 到 `BeanType<?>` 的 map 或注册表
- 一个基于该注册表的 `Codec<BeanType<?>>`。 如果你使用 `net.minecraft.core.Registry`，那么可以简单地调用 `Registry#byNameCodec`。

有了这些，就可以创建一个 bean 的注册表分派 codec。 Codec Bean BeanType StringyBean CountingBean BeanTypes

```
// Now we can create a codec for bean types
// based on the previously created registry
Codec<BeanType<?>> beanTypeCodec = BeanType.REGISTRY.byNameCodec();

// And based on that, here's our registry dispatch codec for beans!
// The first argument is the field name for the bean type.
// When left out, it will default to "type".
Codec<Bean> beanCodec = beanTypeCodec.dispatch("type", Bean::getType, BeanType::codec);
```

```java
// The abstract type we want to create a codec for
public interface Bean {
	// Now we can create a codec for bean types based on the previously created registry.
	Codec<Bean> BEAN_CODEC = BeanType.REGISTRY.byNameCodec()
			// And based on that, here's our registry dispatch codec for beans!
			// The first argument is the field name for the bean type.
			// When left out, it will default to "type".
			.dispatch("type", Bean::getType, BeanType::codec);

	BeanType<?> getType();
}
```

```java
// A record to keep information relating to a specific
// subclass of Bean, in this case only holding a Codec.
public record BeanType<T extends Bean>(MapCodec<T> codec) {
	// Create a registry to map identifiers to bean types
	public static final Registry<BeanType<?>> REGISTRY = new MappedRegistry<>(
			ResourceKey.createRegistryKey(Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "bean_types")), Lifecycle.stable());
}
```

```java
// An implementing class of Bean, with its own codec.
public class StringyBean implements Bean {
	public static final MapCodec<StringyBean> CODEC = RecordCodecBuilder.mapCodec(instance -> instance.group(
			Codec.STRING.fieldOf("stringy_string").forGetter(StringyBean::getStringyString)
	).apply(instance, StringyBean::new));

	private String stringyString;

	// It is important to be able to retrieve the
	// BeanType of a Bean from it's instance.
	@Override
	public BeanType<?> getType() {
		return BeanTypes.STRINGY_BEAN;
	}
}
```

```java
// Another implementation
public class CountingBean implements Bean {
	public static final MapCodec<CountingBean> CODEC = RecordCodecBuilder.mapCodec(instance -> instance.group(
			Codec.INT.fieldOf("counting_number").forGetter(CountingBean::getCountingNumber)
	).apply(instance, CountingBean::new));

	private int countingNumber;

	@Override
	public BeanType<?> getType() {
		return BeanTypes.COUNTING_BEAN;
	}
}
```

```java
// An empty class to hold static references to all BeanTypes
public class BeanTypes {
	// Make sure to register the bean types and leave them accessible to
	// the getType method in their respective subclasses.
	public static final BeanType<StringyBean> STRINGY_BEAN = register("stringy_bean", new BeanType<>(StringyBean.CODEC));
	public static final BeanType<CountingBean> COUNTING_BEAN = register("counting_bean", new BeanType<>(CountingBean.CODEC));

	public static <T extends Bean> BeanType<T> register(String id, BeanType<T> beanType) {
		return Registry.register(BeanType.REGISTRY, Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, id), beanType);
	}
}
```

我们的新 codec 将会像这样将 bean 类序列化为 JSON，仅抓取与特定类型相关的字段：

```java
{
  "type": "example-mod:stringy_bean",
  "stringy_string": "This bean is stringy!"
}
```

```java
{
  "type": "example-mod:counting_bean",
  "counting_number": 42
}
```

#

## 递归 codec ​

有时，使用_自身_来解码特定字段的 codec 很有用，例如在处理某些递归数据结构时。 在原版代码中，这用于 `Component` 对象，可能会存储其他的 `Component` 作为子对象。 可以使用 `Codec#recursive` 构建这样的 codec。

例如，让我们尝试序列化单链列表。 列表是由一组节点的表示的，这些节点既包含一个值，也包含对列表中下一个节点的引用。 然后列表由其第一个节点表示，遍历列表是通过跟随下一个节点来完成的，直到没有剩余节点。 以下是存储整数的节点的简单实现。

```java
public record ListNode(int value, Optional<ListNode> next) {
}
```

我们无法通过普通方法为此构建 codec，因为对 `next` 字段要使用什么 codec？ 我们需要一个 `Codec<ListNode>`，这就是我们还在构建的！ `Codec#recursive` 能让我们使用看上去像魔法的 lambda 来达到这点。 Codec Input Output

```java
Codec<ListNode> codec = Codec.recursive(
		"ListNode", // a name for the codec
		selfCodec -> {
			// Here, `selfCodec` represents the `Codec<ListNode>`, as if it was already constructed
			// This lambda should return the codec we wanted to use from the start,
			// that refers to itself through `selfCodec`
			return RecordCodecBuilder.create(instance ->
					instance.group(
							Codec.INT.fieldOf("value").forGetter(ListNode::value),
							// the `next` field will be handled recursively with the self-codec
							selfCodec.optionalFieldOf("next").forGetter(ListNode::next)
					).apply(instance, ListNode::new)
			);
		}
);
```

```
ListNode linkedList = new ListNode(
		2,
		Optional.of(
				new ListNode(
						3,
						Optional.of(
								new ListNode(
												5,
												Optional.empty()
								)
						)
				)
		)
);
```

```java
{
  "next": {
    "next": {
      "value": 5
    },
    "value": 3
  },
  "value": 2
}
```