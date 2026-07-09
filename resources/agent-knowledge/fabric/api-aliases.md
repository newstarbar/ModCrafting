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
| `useBlockDescriptionPrefix()` | （已移除） | 1.21.4 `Item.Settings` 无此方法，直接 `new Item.Settings().registryKey(itemKey)` |
| `addParticleClient` | `World.addParticle` | 1.21.4 Yarn 客户端粒子方法名为 `addParticle` |

## 客户端渲染

| Agent 常见幻觉 | 正确类名 | 说明 |
|---------------|---------|------|
| `takeScreenshot(File)` 自定义 | `ScreenshotRecorder.takeScreenshot(Framebuffer)` | 见 client-screenshot.md |
| `saveScreenshot` 无 Framebuffer | `ScreenshotRecorder.saveScreenshot(File, String, Framebuffer, Consumer)` | 需传入主帧缓冲 |

## 实体类

| Agent 常见幻觉 | 正确类名 | 说明 |
|---------------|---------|------|
| `EntityType.*_ENTITY` | 查 Yarn `EntityType` 常量 | 如 `EGG`、`SNOWBALL`，无 `_ENTITY` 后缀 |
| `new ThrownEntity(world, player)` | 查 Yarn `thrown.*` 包构造器 | 投掷物实体构造器因类型而异，需查 mappings |
| `ProjectileEntity` | `PersistentProjectileEntity` 或 `thrown.*` 子类 | 具体类名因投掷物类型不同 |

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
| `CustomPayload` / `CustomPayloadC2SPacket` | `CustomPacketPayload` + Fabric Networking API | 1.21.4 自定义包实现 `CustomPacketPayload`，用 `StreamCodec` |
| `CustomPayload.Id` | `CustomPacketPayload.Type` | 载荷类型标识 |
| `PayloadTypeRegistry.serverboundPlay()` | `PayloadTypeRegistry.playC2S()` | C2S 注册 |
| `ServerPlayNetworkHandler.sendPacket` | `ServerPlayNetworking.send` | Fabric API 封装 |
