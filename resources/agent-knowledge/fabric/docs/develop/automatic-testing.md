---
title: 自动化测试
description: 使用 Fabric Loader JUnit 写自动化测试的指南。
authors:
  - kevinthegreat1
---

此页面解释了如何在你的模组中编写自动化测试。 有两种对你的mod进行自动化测试的方法：使用Fabric Loader JUnit进行单元测试或使用Minecraft游戏测试框架进行游戏内测试。

单元测试用于测试你代码中的组件，比如方法和工具类；游戏内测试则启动Minecraft客户端与服务端来运行你的测试，它适用于测试功能和游玩过程。

:::warning
目前，本教程仅涵盖单元测试。
:::

## 单元测试 {#unit-testing}

由于Minecraft mod运行依赖于运行时字节码修改工具比如Mixin，仅仅使用JUnit一般不会生效。 这就是为什么Fabric提供了Fabric Loader JUnit，一个针对Minecraft mod单元测试的JUnit插件。

### 配置Fabric Loader JUnit {#setting-up-fabric-loader-junit}

首先，我们需要将Fabric Loader JUnit添加到开发环境。 将以下依赖添加到你的`build.gradle`：


```groovy
plugins {
	id 'net.fabricmc.fabric-loom' version '1.16-SNAPSHOT' apply false
	id "com.diffplug.spotless" version "6.23.3" apply false
	id 'checkstyle'
}

subprojects {
	apply plugin: 'net.fabricmc.fabric-loom'
	apply plugin: 'checkstyle'
	apply plugin: 'com.diffplug.spotless'

	base {
		archivesName = "example-mod-${project.name}"
	}

	// #region split_sources
	loom {
		splitEnvironmentSourceSets()

		mods {
			"example-mod" {
				sourceSet sourceSets.main
				sourceSet sourceSets.client
			}
		}
	}
	// #endregion split_sources

	loom {
		runs.configureEach {
			ideConfigGenerated = true
		}
	}

	dependencies {
		implementation "net.fabricmc:fabric-loader:${project.loader_version}"

		// #region automatic_testing_1
		testImplementation "net.fabricmc:fabric-loader-junit:${project.loader_version}"
		// #endregion automatic_testing_1
	}

	// #region datagen_setup_configure
	fabricApi {
		configureDataGeneration() {
			client = true
		}
	}
	// #endregion datagen_setup_configure

	tasks.withType(JavaCompile).configureEach {
		it.options.release = 25
	}

	java {
		withSourcesJar()

		sourceCompatibility = JavaVersion.VERSION_25
		targetCompatibility = JavaVersion.VERSION_25
	}

	spotless {
		lineEndings = com.diffplug.spotless.LineEnding.UNIX

		java {
			removeUnusedImports()
			importOrder('java', 'javax', '', 'net.minecraft', 'net.fabricmc', 'com.example.docs')
			indentWithTabs()
			trimTrailingWhitespace()
		}
	}

	checkstyle {
		configFile = rootProject.file('checkstyle.xml')
		toolVersion = "10.12.1"
	}
}
```


然后，我们需要告诉Gradle使用Fabric Loader JUnit来测试。 你可以通过将以下代码添加到`build.gradle`来做到这件事：


```groovy
test {
	useJUnitPlatform()
}
```


### 编写测试 {#writing-tests}

您已重新加载Gradle，您现在已经可以编写测试了。

这些测试的编写方式与常规 JUnit 测试相同，如果您想访问任何依赖于注册表的类（例如`ItemStack`），则需要进行一些额外的设置。 如果您对 JUnit 比较熟悉，那么您可以跳至 [设置注册表](#setting-up-registries)。

#### 设置您的第一个测试类 {#setting-up-your-first-test-class}

测试编写于`src/test/java`目录下。

一种命名约定是镜像您正在测试的类的包结构。 例如，为了测试 `src/main/java/com/example/docs/codec/BeanType.java`，您应在 `src/test/java/com/example/docs/codec/BeanTypeTest.java` 创建一个类。 注意我们是如何将`Test`加入到类名称最后的。 这还允许您轻松访问包私有的方法和字段。

另一个命名约定是有一个 `test` 包，例如 `src/test/java/com/example/docs/test/codec/BeanTypeTest.java`。 如果您使用 Java 模块，这可以避免使用相同包时可能出现的一些问题。

创建测试类后，使用 <kbd>⌘/CTRL</kbd><kbd>N</kbd> 调出生成菜单。 选择测试并开始输入方法名称，通常以 `test` 开头。 完成时请按下 <kbd>ENTER</kbd> 键。 如需更多使用IDE的提示和技巧，见 [IDE提示与技巧](./ide-tips-and-tricks#code-generation)。

![正在生成一个测试方法](/assets/develop/misc/automatic-testing/unit_testing_01.png)

当然，您可以手写方法签名，任何没有参数且返回类型为 void 的实例方法都将被标识为测试方法。 你应该以这样结尾：

![一个带有测试指示的空测试方法](/assets/develop/misc/automatic-testing/unit_testing_02.png)

注意侧边栏中的绿色箭头指引——您可以简单地通过点击它们来运行一个测试。 或者，您的测试将在每次构建时自动运行，包括 GitHub Actions 等 CI 构建。 如果您正在使用 GitHub Actions，请不要忘记阅读[设置 GitHub Actions](#setting-up-github-actions)。

现在，该编写您的实测代码了。 您可以使用 `org.junit.jupiter.api.Assertions` 断言条件。 检查以下测试：


```java
public class BeanTypeTest {
	private static final Gson GSON = new GsonBuilder().create();

	@BeforeAll
	static void beforeAll() {

		BeanTypes.register();
	}

	@Test
	void testBeanCodec() {
		StringyBean expectedBean = new StringyBean("This bean is stringy!");
		Bean actualBean = Bean.BEAN_CODEC.parse(JsonOps.INSTANCE, GSON.fromJson("{\"type\":\"example:stringy_bean\",\"stringy_string\":\"This bean is stringy!\"}", JsonObject.class)).getOrThrow();

		Assertions.assertInstanceOf(StringyBean.class, actualBean);
		Assertions.assertEquals(expectedBean.getType(), actualBean.getType());
		Assertions.assertEquals(expectedBean.getStringyString(), ((StringyBean) actualBean).getStringyString());
	}

	@Test
	void testDiamondItemStack() {
		// I know this isn't related to beans, but I need an example :)
		ItemStack diamondStack = new ItemStack(Items.DIAMOND, 65);

		Assertions.assertTrue(diamondStack.isOf(Items.DIAMOND));
		Assertions.assertEquals(65, diamondStack.getCount());
	}
}
```


有关此代码实际作用的解释，请参阅 [Codecs](./codecs#registry-dispatch)。

#### 设置注册表 {#setting-up-registries}

很好，首次测试运行了！ 但是稍等，第二次测试失败了？ 在日志文件中，我们得到了以下错误之一。


```java
java.lang.ExceptionInInitializerError
	at net.minecraft.item.ItemStack.<clinit>(ItemStack.java:94)
	at com.example.docs.codec.BeanTypeTest.testBeanCodec(BeanTypeTest.java:20)
	at java.base/java.lang.reflect.Method.invoke(Method.java:580)
	at java.base/java.util.ArrayList.forEach(ArrayList.java:1596)
	at java.base/java.util.ArrayList.forEach(ArrayList.java:1596)
Caused by: java.lang.IllegalArgumentException: Not bootstrapped (called from registry ResourceKey[minecraft:root / minecraft:game_event])
	at net.minecraft.Bootstrap.createNotBootstrappedException(Bootstrap.java:118)
	at net.minecraft.Bootstrap.ensureBootstrapped(Bootstrap.java:111)
	at net.minecraft.registry.Registries.create(Registries.java:238)
	at net.minecraft.registry.Registries.create(Registries.java:229)
	at net.minecraft.registry.Registries.<clinit>(Registries.java:139)
	... 5 more

Not bootstrapped (called from registry ResourceKey[minecraft:root / minecraft:game_event])
java.lang.IllegalArgumentException: Not bootstrapped (called from registry ResourceKey[minecraft:root / minecraft:game_event])
	at net.minecraft.Bootstrap.createNotBootstrappedException(Bootstrap.java:118)
	at net.minecraft.Bootstrap.ensureBootstrapped(Bootstrap.java:111)
	at net.minecraft.registry.Registries.create(Registries.java:238)
	at net.minecraft.registry.Registries.create(Registries.java:229)
	at net.minecraft.registry.Registries.<clinit>(Registries.java:139)
	at net.minecraft.item.ItemStack.<clinit>(ItemStack.java:94)
	at com.example.docs.codec.BeanTypeTest.testBeanCodec(BeanTypeTest.java:20)
	at java.base/java.lang.reflect.Method.invoke(Method.java:580)
	at java.base/java.util.ArrayList.forEach(ArrayList.java:1596)
	at java.base/java.util.ArrayList.forEach(ArrayList.java:1596)
```


这是因为我们正在尝试访问注册表或依赖于注册表的类（或者，在极少数情况下，依赖于其他 Minecraft 类，如 `SharedConstants`），但 Minecraft 尚未初始化。 我们只需要初始化以下就能使注册表工作。 在您的`beforeAll`函数前简单地加入以下代码。


```java
		SharedConstants.createGameVersion();
		Bootstrap.initialize();
```


### 配置 GitHub Actions {#setting-up-github-actions}

:::info
本节假设您正在使用包含在示例模组和模组模板中的标准GitHub Action工作流。
:::

您的测试现在将在每个构建上运行，包括由 GitHub Actions 等 CI 提供商构建的构建。 但是如果它构建失败了呢？ 我们需要公开上传日志文件，这样我们就可以查看测试报告了。

将下列文本添加进 `.github/workflows/build.yml` 文件中 `./gradlew build` 步骤的下方。

```yaml
- name: Store reports
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: reports
    path: |
      **/build/reports/
      **/build/test-results/
```
