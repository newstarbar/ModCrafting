# Fabric API 常用类名纠正表

Agent 容易用错的实际类名映射。搜索以下任何左列别名时，应立刻映射到正确的右列类名。

## 事件类

| Agent 常见幻觉 | 正确类名 | 说明 |
|---------------|---------|------|
| `PlayerInteractEntityCallback` | `UseEntityCallback` | 玩家与实体交互 |
| `PlayerInteractBlockCallback` | `UseBlockCallback` | 玩家与方块交互 |
| `PlayerInteractItemCallback` | `UseItemCallback` | 玩家使用物品 |
| `PlayerTickEvent` | Mixin `PlayerEntity.tick()` | 没有这个事件，用 Mixin |
| `ServerEntityTickEvents` | `ServerTickEvents` | 服务端 tick 事件 |
| `EntityTickCallback` | `ServerTickEvents` | 没有直接的事件，用 ServerTickEvents |
| `PlayerBlockBreakEvent` | `PlayerBlockBreakEvents` | 注意复数 |
| `PlayerAttackEvent` | `AttackEntityCallback` | 攻击实体事件 |
| `AttackBlockEvent` | `AttackBlockCallback` | 攻击方块事件 |

## 物品类

| Agent 常见幻觉 | 正确类名 | 说明 |
|---------------|---------|------|
| `FabricItemSettings` | `Item.Settings` | Fabric 通过 Mixin 扩展原版 Settings |
| `FabricItem` | `Item` | 直接继承 Item，用 Fabric 扩展方法 |

## 实体类

| Agent 常见幻觉 | 正确类名 | 说明 |
|---------------|---------|------|
| `EntityType.EGG_ENTITY` | `EntityType.EGG` | 鸡蛋实体类型 |
| `EntityType.SNOWBALL_ENTITY` | `EntityType.SNOWBALL` | 雪球实体类型 |
| `new EggEntity(world, player)` | 查 Yarn mappings 的 `m` 行 | EggEntity 构造器需精确签名 |
| `ProjectileEntity` | `PersistentProjectileEntity` 或 `thrown.EggEntity` | 具体类名 |

## 注册类

| Agent 常见幻觉 | 正确类名 | 说明 |
|---------------|---------|------|
| `Registry.registerItem` | `Registry.register(Registries.ITEM, ...)` | 通用注册方法 |
| `ModItems.register` | 静态工厂方法 | 看实际项目代码 |
| `ItemRegistry.register` | `Registry.register(Registries.ITEM, ...)` | 1.21.4 使用 RegistryKey |

## 网络类

| Agent 常见幻觉 | 正确类名 | 说明 |
|---------------|---------|------|
| `PacketByteBuf` | `PacketByteBuf` (正确) | 网络包缓冲区 |
| `CustomPayloadC2SPacket` | 用 Fabric API `ServerPlayNetworking` | 1.21.4 自定义包通过 Fabric API |
| `ServerPlayNetworkHandler.sendPacket` | `ServerPlayNetworking.send` | Fabric API 封装 |
