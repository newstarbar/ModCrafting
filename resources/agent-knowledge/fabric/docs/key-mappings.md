# key mappings
> 来源: https://docs.fabricmc.net/zh_cn/develop/key-mappings

# 按键映射 26.1.2 ​

创建按键映射并进行反应。

Minecraft 使用按键映射来处理来自像键盘、鼠标之类的外围设置的用户输入， 许多这些按键映射都可以通过设置菜单来配置。

借助 Fabric API 可以创建自己的自定义按键映射，并在自己的模组中进行反应。

按键映射仅存在于客户端， 这意味着按键映射的注册和反应都仅应在客户端完成。 因此可以使用**客户端初始化器**（client initializer）。

#

# 创建按键映射 ​

按键映射包含两部分：按键的映射，以及其属于的分类。

先开始创建一个分类。 分类定义了一组会在设置菜单中显示在一起的按键映射。

```
KeyMapping.Category CATEGORY = KeyMapping.Category.register(
		Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "custom_category")
);
```

然后，创建一个按键映射。 我们将使用 Fabric API 的 `KeyMappingHelper` 来注册按键映射。

```
KeyMapping sendToChatKey = KeyMappingHelper.registerKeyMapping(
	new KeyMapping(
			"key.example-mod.send_to_chat", // The translation key for the key mapping.
			InputConstants.Type.KEYSYM, // The type of the keybinding; KEYSYM for keyboard, MOUSE for mouse.
			GLFW.GLFW_KEY_J, // The GLFW keycode of the key.
			this.CATEGORY // The category of the mapping.
	));
```

INFO

注意按键的名称（`GLFW.GLFW_KEY_*`）会假定我们使用的是[标准美式布局](https://upload.wikimedia.org/wikipedia/commons/d/da/KB_United_States.svg)。

这意味着如果使用的是 AZERTY 布局，按下 A 可能会产生 `GLFW.GLFW_KEY_Q`。

也可以通过传递 `ToggleKeyMapping` 实例而不是 `KeyMapping` 实例，使用 `KeyMappingHelper` 创建粘滞键。

一旦注册，就可以在 *选择* &gt; *控制* &gt; *按键绑定* 中找到你的按键映射。

#

# 翻译 ​

你会需要为按键映射以及分类提供翻译。

分类名称的翻译键是 `key.category.<namespace>.<path>` 的形式。 创建按键映射时，按键映射的翻译键会是你提供的。

可以手动添加翻译键，也可借助[数据生成](./data-generation/translations)。

```java
{
  "key.category.example-mod.custom_category": "Example Mod Custom Category",
  "key.example-mod.send_to_chat": "Send to Chat"
}
```

#

# 对按键映射作出反应 ​

现在有了按键映射，就可以使用客户端刻事件对其反应。

```java
ClientTickEvents.END_CLIENT_TICK.register(client -> {
	while (this.sendToChatKey.consumeClick()) {
		if (client.player != null) {
			client.player.sendSystemMessage(Component.literal("Key Pressed!"));
		}
	}
});
```

这会在每次按下被映射的键时，游戏内聊天栏就会输出“Key Pressed!”。 记住，按住此键会反复向聊天栏输出消息，所以如果这个逻辑只需要触发一次，可能需要实现保护机制。