# setup
> 来源: https://docs.fabricmc.net/zh_cn/develop/data-generation/setup

# 数据生成设置 26.1.2 ​

使用 Fabric API 设置数据生成的指南。

#

# 数据生成是什么？ ​

数据生成 (又称 datagen) 是一种 API，用于以编程方式生成配方、进度、标签、物品模型、语言文件、战利品表以及基本上任何基于 JSON 的内容。

#

# 启用数据生成 ​

#

## 在项目创建时 ​

启用数据生成的最简单方法是在创建项目时。 使用[模板生成器](https://fabricmc.net/develop/template/)时，勾选“启用数据生成”框。

TIP

如果启用了数据生成，应该有一个“Data Generation”运行配置和一个 `runDatagen` Gradle 任务。

#

## 手动 ​

首先，我们需要在 `build.gradle` 文件中启用 datagen。

```java
fabricApi {
	configureDataGeneration() {
		client = true
	}
}
```

接下来，我们需要一个入口点类。 这是我们的数据生成的起点。 将其放在 `client` 包中的某个位置——本示例将其放在 `src/client/java/com/example/docs/datagen/ExampleModDataGenerator.java`。

```java
public class ExampleModDataGenerator implements DataGeneratorEntrypoint {
	@Override
	public void onInitializeDataGenerator(FabricDataGenerator fabricDataGenerator) {
	}
}
```

最后，我们需要告诉 Fabric 我们的 `fabric.mod.json` 中的入口点：

```java
{
  // ...
  "entrypoints": {
    // ...
    "client": [
      // ...
    ],
    "fabric-datagen": [
      "com.example.docs.datagen.ExampleModDataGenerator"
    ]
  }
}
```

WARNING

别忘了在前一个入口点方块后面加一个逗号（`,`）！

关闭并重新打开 IntelliJ 以创建 datagen 的运行配置。

#

# 创建包 ​

在数据生成入口点的 `onInitializeDataGenerator` 方法中，我们需要创建一个 `Pack`。 稍后，你将添加**提供程序**（provider），将生成的数据放入此 `Pack` 中。

```
FabricDataGenerator.Pack pack = fabricDataGenerator.createPack();
```

#

# 运行数据生成 ​

要运行数据生成，请使用 IDE 中的运行配置，或者在控制台中运行 `./gradlew runDatagen`。 生成的文件将创建在 `src/main/generated` 中。

#

# 下一步 ​

现在数据生成已设置完毕，我们需要添加**提供程序**（provider）。 这些提供程序将生成要添加到 `Pack` 的数据。 以下页面概述了如何执行此操作。

- 进度
- 战利品表
- 配方
- 标签
- 翻译
- 方块模型
- 物品模型