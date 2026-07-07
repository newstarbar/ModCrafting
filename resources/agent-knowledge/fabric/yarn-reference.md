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
