# Fabric 网络速查（MC 1.21.4）

## C2S CustomPacketPayload 最小模板

1.21.4 使用 `CustomPacketPayload`（不是旧版 `CustomPayload`）+ `StreamCodec` + `PayloadTypeRegistry`。

```java
public record ExampleC2SPayload() implements CustomPacketPayload {
    public static final Identifier ID_VALUE = Identifier.of(MyMod.MOD_ID, "example_action");
    public static final Type<ExampleC2SPayload> TYPE = new Type<>(ID_VALUE);
    public static final StreamCodec<RegistryFriendlyByteBuf, ExampleC2SPayload> CODEC =
        StreamCodec.unit(new ExampleC2SPayload());

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
```

注册与接收（ModInitializer）：

```java
PayloadTypeRegistry.playC2S().register(ExampleC2SPayload.TYPE, ExampleC2SPayload.CODEC);

ServerPlayNetworking.registerGlobalReceiver(ExampleC2SPayload.TYPE, (payload, context) -> {
    ServerPlayerEntity player = context.player();
    context.server().execute(() -> {
        // server-side handler logic
    });
});
```

客户端发送：

```java
ClientPlayNetworking.send(new ExampleC2SPayload());
```

## 常见类名纠正

| 幻觉 | 1.21.4 正确 |
|------|------------|
| `CustomPayload` | `CustomPacketPayload` |
| `CustomPayload.Id` | `CustomPacketPayload.Type` |
| `PacketCodec<PacketByteBuf, ...>` | `StreamCodec<RegistryFriendlyByteBuf, ...>` |
| `PayloadTypeRegistry.serverboundPlay()` | `PayloadTypeRegistry.playC2S()` |
