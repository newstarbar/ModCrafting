---
name: mixin-nested-target
description: 目标类是嵌套类（含 $）时的 Mixin 写法、注册与构建失败排查流程。
---

# 嵌套类 Mixin 目标

当要注入的目标是某个类的内部类（Yarn 里通常形如 `ShulkerEntity$ShootBulletGoal`、`X$Y`）时，按本节执行。标准四步流程（target_lookup → scaffold/edit → register → validate）不变，本节只处理嵌套目标带来的差异。

## 1. 确认目标形态

先调 `fabric_mixin_target_lookup`。若成员查询落空但符号索引里有 `$` 形态的类，工具会直接给出嵌套类提示——以它返回的类名为准，不要自己拼点号类名。

## 2. 注解必须用 targets=

嵌套类一律写成字符串形式，禁止点号类字面量：

```java
// 正确
@Mixin(targets = "net.minecraft.entity.mob.ShulkerEntity$ShootBulletGoal")

// 错误：Yarn 内部类多为 private，`Outer.Inner.class` 不可编译
@Mixin(ShulkerEntity.ShootBulletGoal.class)
```

`fabric_mixin_scaffold` 已按此规则生成；手写或 `edit_file` 修改时必须保持同样形态。`fabric_mixin_validate` 会把点号类字面量判为失败，这是预期纠错，按提示改成 `targets=` 即可，不要反复提交同一形态。

## 3. import 只到外层类

嵌套类的参数/返回类型需要 import 时，**只 import 外层类**，内部类用 `外层类.Inner` 的限定写法；不要 `import 外层类.Inner;`。判定依据是类名里有没有 `$`，不是访问修饰符——符号索引不记录 access flags。

## 4. 方法签名与描述符

`@Inject` 的 `method` 用 `name + descriptor`（如 `"method$LVZZZ")V"`）而不是裸方法名，避免同名重载被判歧义。descriptor 以 `fabric_mixin_target_lookup` 返回为准。

## 5. 注册与侧别

`fabric_mixin_register` 传 `sourcePath` + `side`（common→`mixins`，client→`client`，server→`server`）。存在多个 config 时必须显式传 `configPath`。

## 6. 构建失败时

只读地看首轮 Gradle 错误原文（`read_error_log`），用 `fabric_log_debugger` 归类。若报 “cannot find symbol” 且符号是内部类，回到第 2/3 步修注解与 import，不要改成反射调用绕开编译。
