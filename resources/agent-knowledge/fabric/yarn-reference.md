# Yarn Mappings 常用参考（MC 1.21.4）

写代码前先查此文件，避免用错字段/方法名。

---

## PlayerEntity（net.minecraft.entity.player.PlayerEntity）

extends LivingEntity

| Yarn 名 | 类型 | 说明 |
|---------|------|------|
| `isOnGround()` | boolean | 是否在地面 |
| `getVelocity()` | Vec3d | 当前速度向量 |
| `setVelocity(Vec3d)` | void | 设置速度 |
| `addVelocity(double,double,double)` | void | 叠加速度 |
| `jump()` | void | 执行跳跃（原版只在地面时触发） |
| `tick()` | void | 每 tick 调用 |
| `tickMovement()` | void | 每 tick 移动逻辑 |
| `getInventory()` | PlayerInventory | 玩家背包 |
| `getAbilities()` | PlayerAbilities | 玩家能力（allowFlying 等） |
| `isCreative()` | boolean | 是否创造模式 |
| `isSpectator()` | boolean | 是否旁观模式 |
| `getMainHandStack()` | ItemStack | 主手物品 |
| `getOffHandStack()` | ItemStack | 副手物品 |
| `sendMessage(Text,boolean)` | void | 发送聊天消息（第二个参数 overlay） |
| `getServer()` | MinecraftServer | 获取服务端实例（服务端专用） |

### 重要：PlayerEntity 没有 `input` 字段！

`input` 是 `ClientPlayerEntity` 的字段，服务端 PlayerEntity 不存在此字段。
检测玩家按键应在服务端用 LivingEntity 的 `jumping` 字段（需 @Accessor）。

---

## LivingEntity（net.minecraft.entity.LivingEntity）

PlayerEntity 的父类。

| Yarn 名 | 类型 | 说明 |
|---------|------|------|
| `jumping` | boolean (protected) | 跳跃键是否按下 → 需 `@Accessor` 访问 |
| `isOnGround()` | boolean | 是否在地面 |
| `getHealth()` | float | 当前生命值 |
| `getMaxHealth()` | float | 最大生命值 |
| `setHealth(float)` | void | 设置生命值 |
| `damage(DamageSource,float)` | boolean | 造成伤害 |
| `isAlive()` | boolean | 是否存活 |
| `getWorld()` | World | 所在世界 |
| `getBlockPos()` | BlockPos | 所在方块坐标 |
| `getRotationVector()` | Vec3d | 视线方向向量 |
| `getYaw()` / `getPitch()` | float | 偏航角/俯仰角 |
| `getMovementSpeed()` | float | 移动速度 |
| `setMovementSpeed(float)` | void | 设置移动速度 |
| `getAttributeInstance(EntityAttribute)` | EntityAttributeInstance | 获取属性实例 |
| `getStatusEffects()` | Map<StatusEffect,StatusEffectInstance> | 当前状态效果 |
| `addStatusEffect(StatusEffectInstance)` | boolean | 添加状态效果 |
| `hasStatusEffect(StatusEffect)` | boolean | 是否有某状态效果 |
| `tick()` | void | 每 tick 调用 |
| `onKilledBy(LivingEntity)` | void | 被击杀时回调 |

### @Accessor 示例

```java
@Mixin(LivingEntity.class)
public interface LivingEntityAccessor {
    @Accessor
    boolean getJumping();
}
```

---

## ClientPlayerEntity（net.minecraft.client.network.ClientPlayerEntity）

extends PlayerEntity。**仅客户端可用！** 不要试图在服务端代码或 common mixin 中引用此类。

| Yarn 名 | 类型 | 说明 |
|---------|------|------|
| `input` | Input | 客户端输入状态（前进/跳跃/潜行等） |

`Input` 类字段：
- `jumping` (boolean) — 跳跃键是否按下
- `sneaking` (boolean) — 潜行键是否按下
- `movementForward` (float) — 前后移动量
- `movementSideways` (float) — 左右移动量

---

## Entity（net.minecraft.entity.Entity）

所有实体的基类。

| Yarn 名 | 类型 | 说明 |
|---------|------|------|
| `getWorld()` | World | 所在世界 |
| `getBlockPos()` | BlockPos | 方块坐标 |
| `getX()` / `getY()` / `getZ()` | double | 坐标 |
| `setPos(double,double,double)` | void | 设置坐标 |
| `getVelocity()` | Vec3d | 速度向量 |
| `setVelocity(double,double,double)` | void | 设置速度 |
| `getUuid()` | UUID | 实体 UUID |
| `getId()` | int | 实体网络 ID |
| `isRemoved()` | boolean | 是否已移除 |
| `discard()` | void | 标记移除 |
| `isOnGround()` | boolean | 是否在地面 |
| `isTouchingWater()` | boolean | 是否触水 |
| `isInLava()` | boolean | 是否在岩浆中 |
| `isSneaking()` | boolean | 是否潜行 |
| `isSprinting()` | boolean | 是否疾跑 |
| `setOnGround(boolean)` | void | 设置地面状态 |
| `fallDistance` | float (public) | 下落距离 |
| `isFireImmune()` | boolean | 是否免疫火焰 |

---

## ServerPlayerEntity（net.minecraft.server.network.ServerPlayerEntity）

extends PlayerEntity。服务端玩家。

| Yarn 名 | 说明 |
|---------|------|
| `getServerWorld()` | 获取 ServerWorld |
| `networkHandler` | ServerPlayNetworkHandler（网络连接） |
| `sendMessage(Text,boolean)` | 发送消息 |
| `sendMessageToClient(Text,boolean)` | 仅发送给此玩家 |
| `teleport(double,double,double)` | 传送 |
| `openHandledScreen(NamedScreenHandlerFactory)` | 打开 GUI |
| `closeHandledScreen()` | 关闭当前 GUI |
| `getStatHandler()` | 统计信息 |

---

## World / ServerWorld

| Yarn 名 | 说明 |
|---------|------|
| `getBlockState(BlockPos)` | 获取方块状态 |
| `setBlockState(BlockPos,BlockState)` | 设置方块状态 |
| `getBlockEntity(BlockPos)` | 获取方块实体 |
| `spawnEntity(Entity)` | 生成实体 |
| `getEntitiesByClass(Class,Box,Predicate)` | 按类型查询实体 |
| `getPlayers()` | 获取所有玩家 |
| `getRandom()` | 获取随机数生成器 |
| `isClient` (boolean) | 是否客户端世界 |
| `getTime()` | 世界时间（tick 数） |
| `getDifficulty()` | 难度 |
| `playSound(...)` | 播放音效 |
| `spawnParticles(...)` | 生成粒子 |
| `breakBlock(BlockPos,boolean)` | 破坏方块 |

---

## ItemStack

| Yarn 名 | 说明 |
|---------|------|
| `getItem()` | 获取物品类型 |
| `getCount()` | 数量 |
| `setCount(int)` | 设置数量 |
| `getDamage()` | 当前耐久消耗值 |
| `setDamage(int)` | 设置耐久消耗值 |
| `getMaxDamage()` | 最大耐久 |
| `isDamaged()` | 是否已损耗 |
| `getNbt()` | 获取 NBT 数据（可能为 null） |
| `getOrCreateNbt()` | 获取或创建 NBT |
| `setNbt(NbtCompound)` | 设置 NBT |
| `getEnchantments()` | 获取附魔 |
| `addEnchantment(Enchantment,int)` | 添加附魔 |
| `isEmpty()` | 是否为空 |
| `copy()` | 复制一份 |
| `getRarity()` | 稀有度 |
| `setCustomName(Text)` | 设置自定义名称 |
| `hasCustomName()` | 是否有自定义名称 |
| `isOf(Item)` | 检查物品类型 |
| `isIn(TagKey<Item>)` | 检查是否在标签中 |

---

## Block / BlockState

| Yarn 名 | 说明 |
|---------|------|
| `state.getBlock()` | 从 BlockState 获取 Block |
| `state.get(Property)` | 获取属性值 |
| `state.with(Property,value)` | 设置属性值 → 新 BlockState |
| `block.getDefaultState()` | 获取默认 BlockState |
| `block.getHardness()` | 硬度 |
| `block.getBlastResistance()` | 爆炸抗性 |
| `block.getLootTableId()` | 战利品表 ID |
| `state.isIn(TagKey)` | 检查方块标签 |
| `state.isOf(Block)` | 检查方块类型 |
| `state.isAir()` | 是否为空气 |
| `state.isSolidBlock(BlockView,BlockPos)` | 是否为固体方块 |

---

## Identifier（net.minecraft.util.Identifier）

| Yarn 名 | 说明 |
|---------|------|
| `new Identifier(namespace,path)` | 构造（如 `new Identifier("mymod","item")`） |
| `Identifier.of(namespace,path)` | 静态工厂（1.21+ 推荐） |
| `id.getNamespace()` | 获取命名空间 |
| `id.getPath()` | 获取路径 |

---

## Registry / Registries

| Yarn 名 | 说明 |
|---------|------|
| `Registries.ITEM` | 物品注册表 |
| `Registries.BLOCK` | 方块注册表 |
| `Registries.ENTITY_TYPE` | 实体类型注册表 |
| `Registries.BLOCK_ENTITY_TYPE` | 方块实体类型注册表 |
| `Registries.ENCHANTMENT` | 附魔注册表 |
| `Registries.STATUS_EFFECT` | 状态效果注册表 |
| `Registries.SOUND_EVENT` | 音效注册表 |
| `Registries.SCREEN_HANDLER` | GUI 注册表 |
| `Registry.register(registry,id,entry)` | 注册条目 |

---

## 常用 Mixin 注入模式

### @Inject — 在方法中插入代码

```java
// 方法头部注入
@Inject(method = "tick", at = @At("HEAD"))
private void onTick(CallbackInfo ci) { ... }

// 方法尾部注入
@Inject(method = "tick", at = @At("TAIL"))
private void onTickEnd(CallbackInfo ci) { ... }

// 可取消的注入（配合 cancellable = true 和 ci.cancel()）
@Inject(method = "jump", at = @At("HEAD"), cancellable = true)
private void onJump(CallbackInfo ci) {
    if (shouldCancel) ci.cancel();
}
```

### @Accessor — 访问 protected/private 字段

```java
@Mixin(LivingEntity.class)
public interface LivingEntityAccessor {
    @Accessor("jumping")
    boolean getJumping();

    @Accessor("jumping")
    void setJumping(boolean jumping);
}
```

### @ModifyArg — 修改方法参数

```java
@ModifyArg(method = "applyDamage", at = @At(value = "INVOKE",
    target = "Lnet/minecraft/entity/LivingEntity;setHealth(F)V"), index = 0)
private float modifyDamage(float original) { return original * 0.5F; }
```

### 注意事项

- Mixin 类名不能与目标类名相同（会导致递归注入失败）
- @Accessor 必须是 interface（或 abstract class）
- @Inject 方法必须是 private void，第一个参数是目标方法的参数，最后一个是 CallbackInfo
- 非 @Accessor 的 Mixin 必须在 mixins JSON 中注册
- common mixin（不指定 client/server）同时应用于两端，不能引用 ClientPlayerEntity 等客户端独有类

---

## 客户端/服务端区分

| 端 | 入口 | 关键类 |
|----|------|--------|
| 服务端 | `ModInitializer` | ServerPlayerEntity, ServerWorld, MinecraftServer |
| 客户端 | `ClientModInitializer` | ClientPlayerEntity, MinecraftClient, RenderSystem |
| 两端共享 | 自动共享 | PlayerEntity, LivingEntity, Entity, ItemStack 等 |

客户端独有类**不能**在 common mixin 或服务端代码中引用。需要客户端 mixin 时，在 mixins JSON 中指定 `"client": [...]`。

---

## 常用 Fabric API 事件

```java
// 服务端 Tick（每 tick 触发一次）
ServerTickEvents.START_SERVER_TICK.register(server -> { ... });
ServerTickEvents.END_SERVER_TICK.register(server -> { ... });

// 世界 Tick
ServerTickEvents.START_WORLD_TICK.register(world -> { ... });

// 玩家 Tick
ServerTickEvents.END_SERVER_TICK.register(server -> {
    for (ServerPlayerEntity player : server.getPlayerManager().getPlayerList()) {
        // 对每个玩家执行逻辑
    }
});

// 实体加载
ServerEntityEvents.ENTITY_LOAD.register((entity, world) -> { ... });

// 方块交互
AttackBlockCallback.EVENT.register((player, world, hand, pos, direction) -> {
    return ActionResult.PASS;
});

// 使用物品
UseBlockCallback.EVENT.register((player, world, hand, hitResult) -> {
    return ActionResult.PASS;
});

// 物品使用完成
UseItemCallback.EVENT.register((player, world, hand) -> {
    return TypedActionResult.pass(player.getStackInHand(hand));
});

// 生物掉落
LootTableLoadingCallback.EVENT.register((key, supplier, setter) -> {
    // 注入战利品表
});
```

注册事件必须在 ModInitializer 或 ClientModInitializer 的入口方法中完成。

---

## Mixin 常见反模式（写代码前必须检查）

以下错误导致构建失败、游戏崩溃、或功能不生效。每写完一个 Mixin，逐条自查。

### 1. ci.cancel() 后不要再调用被注入的方法

```java
// ❌ 错误：cancel 后调用 jump()，此时状态已变，jump() 内部逻辑可能跳过
@Inject(method = "jump", at = @At("HEAD"), cancellable = true)
private void onJump(CallbackInfo ci) {
    ci.cancel();
    player.jump();  // ← 递归风险，且语义矛盾
}

// ✅ 正确：cancel 后直接设置速度，不要回头调原方法
@Inject(method = "jump", at = @At("HEAD"), cancellable = true)
private void onJump(CallbackInfo ci) {
    if (shouldHandle) {
        ci.cancel();
        self.setVelocity(self.getVelocity().x, 0.42, self.getVelocity().z);
        self.velocityDirty = true;  // 标记速度已修改，触发网络同步
    }
}
```

### 2. @Shadow 字段必须在 Mixin 目标类或其父类中存在

```java
// ❌ 错误：target 是 PlayerEntity，但 jumping 在父类 LivingEntity 中
@Mixin(PlayerEntity.class)
public abstract class MyMixin {
    @Shadow protected boolean jumping;  // ← 找不到字段
}

// ✅ 正确：Mixin 目标改为 LivingEntity
@Mixin(LivingEntity.class)
public abstract class MyMixin {
    @Shadow protected boolean jumping;  // ← LivingEntity 有此字段
}
```

### 3. 写新 Mixin 前先检查是否已有同类 Mixin

在执行任何写 Mixin 的操作前，先：
1. 读 `src/main/resources/<modid>.mixins.json` 看已有哪些 mixin
2. 读每个已有 Mixin 的源码，确认功能不重复
3. 如果已有 Mixin 可以扩展，在现有文件中加注入方法，不要新建文件

### 4. 新建 Mixin 类后必须同步注册到 mixins JSON

写完 Mixin Java 文件后，**必须**同时更新 `src/main/resources/<modid>.mixins.json`：
- 在 `"mixins"` 数组中追加类名（不带包名，不带 .java）
- 如果 Mixin 仅在客户端使用，放入 `"client"` 数组
- 不注册 = Mixin 永远不会被加载 = 白写

### 5. 修改 velocity 后必须标记 velocityDirty

```java
// ❌ 错误：修改速度但未标记 dirty，客户端不会同步
self.setVelocity(new Vec3d(vel.x, 0.42, vel.z));

// ✅ 正确
self.setVelocity(new Vec3d(vel.x, 0.42, vel.z));
self.velocityDirty = true;
```

### 6. 不要用 @Unique 字段做跨 Tick 状态机

`@Unique` 字段在 Mixin 注入的类中，但没有持久化机制。如果目标类被重新创建（玩家重生/切换维度），`@Unique` 字段会重置为默认值。对于简单的布尔标记（如 `hasDoubleJumped`）可以接受，但对于需要持久化的状态（如冷却计时器），优先使用 Component（DataComponentType）或 NBT。

### 7. 检查清单

写完 Mixin 后，按顺序检查：

- [ ] `@Mixin` 目标类是否正确（字段/方法是否在目标类中实际存在）
- [ ] 如有 `@Shadow`，确认字段/方法在目标类或其父类中
- [ ] 如用了 `ci.cancel()`，确认没有在 cancel 后调用被注入的方法
- [ ] 如修改了 velocity，确认设置了 `velocityDirty = true`
- [ ] 已确认项目中没有功能重复的 Mixin
- [ ] 已更新 `mixins.json` 注册新 Mixin
- [ ] 如果是客户端 Mixin（引用 ClientPlayerEntity 等），已放入 `"client"` 数组
