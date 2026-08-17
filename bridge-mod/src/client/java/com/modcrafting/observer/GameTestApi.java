package com.modcrafting.observer;

import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.registry.Registries;
import net.minecraft.recipe.RecipeEntry;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.item.ItemStack;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** V2 test-only API: deterministic commands and fresh structured snapshots. */
public final class GameTestApi {
    private static final long SERVER_TIMEOUT_MS = 8_000;
    /**
     * State preparation is a pre-death operation.  Keep the lock at the
     * Observer/JVM boundary so a test cannot respawn and then inject a new
     * state to make a death-rewind assertion look valid.  A fresh Minecraft
     * JVM (the required independent replay boundary) starts unlocked.
     */
    private static volatile boolean playerStatePreparationLocked = false;

    private GameTestApi() {}

    public static Map<String, Object> capabilities() {
        MinecraftClient client = MinecraftClient.getInstance();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("protocolVersion", 2);
        out.put("capabilityRevision", 4);
        out.put("observerSessionId", ModCraftingObserverClient.OBSERVER_SESSION_ID);
        out.put("commandExecution", client != null && client.getServer() != null);
        out.put("snapshot", true);
        out.put("snapshotFields", Map.of(
                "player", List.of("uuid", "name", "x", "y", "z", "width", "height", "eyeHeight", "health", "food", "hunger", "saturation", "selectedSlot", "inventory", "dimension"),
                "serverPlayer", List.of("uuid", "name", "x", "y", "z", "width", "height", "eyeHeight", "health", "hunger", "saturation", "selectedSlot", "inventory", "dimension", "worldTick"),
                "screen", List.of("ok", "inWorld", "className", "simpleName", "title", "kind", "pausesGame", "scaledWidth", "scaledHeight", "windowWidth", "windowHeight", "widgets")
        ));
        out.put("queryKinds", List.of("registry", "block", "entities", "recipe"));
        out.put("observation", Map.of(
                "clientPlayer", true,
                "serverPlayer", client != null && client.getServer() != null,
                "hudTrace", true,
                "hudTraceFields", List.of("sequence", "text", "x", "y", "normalizedX", "normalizedY", "rightMargin", "textWidth", "screenWidth", "screenHeight", "color", "alpha", "shadow", "screen", "worldTick", "observedAt"),
                "renderTrace", true,
                "renderTraceFields", List.of("sequence", "entityUuid", "entityType", "rendererClass", "worldTick", "observedAt"),
                "combatTrace", true,
                "combatTraceFields", List.of("sequence", "victimUuid", "victimType", "victimName", "victimTags", "attackerUuid", "attackerType", "attackerIsPlayer", "damageType", "killed", "worldTick", "observedAt"),
                "traceCapacity", 256,
                "playerStateControl", true
        ));
        out.put("testWorld", "ModCrafting Test World");
        return out;
    }

    public static Map<String, Object> command(String command) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.player == null || client.getServer() == null) {
            return error("NOT_IN_INTEGRATED_WORLD", "需要已进入单人集成服务器世界");
        }
        String normalized = command == null ? "" : command.trim();
        if (normalized.startsWith("/")) normalized = normalized.substring(1);
        if (normalized.isEmpty()) return error("BAD_REQUEST", "命令为空");
        if (isDangerous(normalized)) return error("COMMAND_DENIED", "测试协议禁止该服务器管理命令");

        MinecraftServer server = client.getServer();
        ServerPlayerEntity player = server.getPlayerManager().getPlayer(client.player.getUuid());
        if (player == null) return error("PLAYER_NOT_READY", "服务端玩家尚未就绪");
        CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        String finalCommand = normalized;
        server.execute(() -> {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("requestId", "cmd_" + System.nanoTime());
            out.put("command", finalCommand);
            try {
                ServerCommandSource source = player.getCommandSource().withLevel(4);
                int result = server.getCommandManager().getDispatcher().execute(finalCommand, source);
                out.put("ok", true);
                out.put("accepted", true);
                out.put("executed", true);
                out.put("result", result);
            } catch (Exception error) {
                out.put("ok", false);
                out.put("accepted", true);
                out.put("executed", false);
                out.put("code", "COMMAND_FAILED");
                out.put("error", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
            }
            future.complete(out);
        });
        try {
            return future.get(SERVER_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception error) {
            return error("COMMAND_TIMEOUT", "等待服务端命令结果超时: " + error.getMessage());
        }
    }

    public static Map<String, Object> snapshot(Map<String, Object> body) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.player == null || client.world == null) {
            return error("NOT_IN_WORLD", "玩家尚未进入世界");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("requestId", "snap_" + System.nanoTime());
        out.put("observedAt", System.currentTimeMillis());
        out.put("worldTime", client.world.getTime());
        out.put("worldName", client.getServer() == null ? null : client.getServer().getSaveProperties().getLevelName());
        out.put("player", GameQueries.player());
        out.put("serverPlayer", serverPlayerSnapshot(client));
        out.put("inventory", GameQueries.inventory());
        out.put("screen", GameQueries.screen());
        Map<String, Object> widgetState = GameQueries.widgets();
        out.put("widgets", widgetState.getOrDefault("widgets", List.of()));

        List<Map<String, Object>> blocks = new ArrayList<>();
        Object rawBlocks = body == null ? null : body.get("blocks");
        if (rawBlocks instanceof List<?> list) {
            for (Object entry : list) {
                if (!(entry instanceof Map<?, ?> map)) continue;
                int x = number(map.get("x"));
                int y = number(map.get("y"));
                int z = number(map.get("z"));
                BlockPos pos = new BlockPos(x, y, z);
                Map<String, Object> block = new LinkedHashMap<>();
                block.put("x", x);
                block.put("y", y);
                block.put("z", z);
                block.put("blockId", Registries.BLOCK.getId(client.world.getBlockState(pos).getBlock()).toString());
                blocks.add(block);
            }
        }
        out.put("blocks", blocks);
        double radius = body != null && body.get("entityRadius") != null ? Math.max(1, Math.min(64, doubleValue(body.get("entityRadius")))) : 32;
        Map<String, Object> nearby = GameQueries.nearby(radius);
        out.put("entities", nearby.getOrDefault("entities", List.of()));
        out.put("hudTrace", ObservationTrace.hudSnapshot());
        out.put("renderTrace", ObservationTrace.renderSnapshot());
        out.put("combatTrace", ObservationTrace.combatSnapshot());
        out.put("observerSessionId", ModCraftingObserverClient.OBSERVER_SESSION_ID);
        out.put("capabilityRevision", 4);
        out.put("traceCursors", Map.of(
                "hudTrace", maxSequence(ObservationTrace.hudSnapshot()),
                "renderTrace", maxSequence(ObservationTrace.renderSnapshot()),
                "combatTrace", maxSequence(ObservationTrace.combatSnapshot())
        ));
        List<String> recipes = new ArrayList<>();
        MinecraftServer server = client.getServer();
        if (server != null) {
            for (RecipeEntry<?> entry : server.getRecipeManager().values()) recipes.add(entry.id().toString());
            out.put("recipeQuerySupported", true);
        } else {
            out.put("recipeQuerySupported", false);
        }
        out.put("recipes", recipes);
        return out;
    }

    /** Restricted, structured state controls used only by strict deterministic tests. */
    public static Map<String, Object> playerState(Map<String, Object> body) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.player == null || client.getServer() == null) return error("NOT_IN_INTEGRATED_WORLD", "test world is not ready");
        String worldName = client.getServer().getSaveProperties().getLevelName();
        if (!"ModCrafting Test World".equals(worldName)) return error("WORLD_UNAVAILABLE", "player state control is restricted to ModCrafting Test World");
        String action = String.valueOf(body == null ? "" : body.getOrDefault("action", ""));
        ServerPlayerEntity player = client.getServer().getPlayerManager().getPlayer(client.player.getUuid());
        if (player == null) return error("PLAYER_NOT_READY", "server player is not ready");
        if ("respawn".equals(action)) {
            if (client.currentScreen == null || !client.currentScreen.getClass().getSimpleName().toLowerCase(Locale.ROOT).contains("death")) return error("DEATH_SCREEN_REQUIRED", "respawn requires the death screen");
            try { return ClientTasks.supply(() -> InputActions.handle(Map.of("action", "key_press", "key", "enter"))); }
            catch (Exception error) { return error("STATE_CONTROL_FAILED", error.getMessage()); }
        }
        CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        client.getServer().execute(() -> {
            try {
                if ("set_player_state".equals(action)) {
                    if (playerStatePreparationLocked) { future.complete(error("STATE_PREPARATION_LOCKED", "set_player_state is permanently disabled after the first kill_player in this JVM")); return; }
                    if (player.isDead() || player.getHealth() <= 0) { future.complete(error("STATE_AFTER_DEATH_DENIED", "set_player_state is forbidden after death")); return; }
                    Object raw = body == null ? null : body.get("state");
                    if (!(raw instanceof Map<?, ?> state)) { future.complete(error("BAD_STATE", "state object is required")); return; }
                    double x = doubleValue(state.get("x"));
                    double y = doubleValue(state.get("y"));
                    double z = doubleValue(state.get("z"));
                    if (x < -16 || x > 16 || y < 96 || y > 112 || z < -16 || z > 16) { future.complete(error("STATE_OUTSIDE_TEST_REGION", "coordinates must stay inside the test region")); return; }
                    player.refreshPositionAndAngles(x, y, z, player.getYaw(), player.getPitch());
                    player.setHealth((float) Math.max(1, Math.min(player.getMaxHealth(), doubleValue(state.get("health")))));
                    int hunger = Math.max(0, Math.min(20, number(state.get("hunger"))));
                    player.getHungerManager().setFoodLevel(hunger);
                    if (state.get("saturation") != null) player.getHungerManager().setSaturationLevel((float) Math.max(0, Math.min(20, doubleValue(state.get("saturation")))));
                    player.getInventory().clear();
                    Object rawInventory = state.get("inventory");
                    if (rawInventory instanceof List<?> list) for (Object rawEntry : list) {
                        if (!(rawEntry instanceof Map<?, ?> entry)) { future.complete(error("BAD_INVENTORY", "inventory entry must be an object")); return; }
                        int slot = number(entry.get("slot"));
                        int count = number(entry.get("count"));
                        if (slot < 0 || slot > 40 || count < 1 || count > 64) { future.complete(error("BAD_INVENTORY", "slot/count out of bounds")); return; }
                        Identifier id = Identifier.of(String.valueOf(entry.get("itemId")));
                        if (!Registries.ITEM.containsId(id)) { future.complete(error("ITEM_NOT_REGISTERED", "unknown item: " + id)); return; }
                        if (count > Registries.ITEM.get(id).getMaxCount()) { future.complete(error("BAD_INVENTORY", "count exceeds item stack limit: " + id)); return; }
                        ItemStack stack = new ItemStack(Registries.ITEM.get(id), count);
                        player.getInventory().setStack(slot, stack);
                    }
                    if (state.get("selectedSlot") != null) player.getInventory().selectedSlot = Math.max(0, Math.min(8, number(state.get("selectedSlot"))));
                    player.playerScreenHandler.sendContentUpdates();
                    future.complete(Map.of("ok", true, "executed", true, "action", action));
                } else if ("kill_player".equals(action)) {
                    if (player.isDead() || player.getHealth() <= 0) { future.complete(error("ALREADY_DEAD", "player is already dead")); return; }
                    player.damage(player.getServerWorld(), player.getServerWorld().getDamageSources().generic(), player.getMaxHealth() + 1.0f);
                    playerStatePreparationLocked = true;
                    future.complete(Map.of("ok", true, "executed", true, "action", action));
                } else future.complete(error("BAD_ACTION", "unsupported player state action"));
            } catch (Exception error) {
                future.complete(error("STATE_CONTROL_FAILED", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()));
            }
        });
        try { return future.get(SERVER_TIMEOUT_MS, TimeUnit.MILLISECONDS); }
        catch (Exception error) { return error("STATE_CONTROL_TIMEOUT", error.getMessage()); }
    }

    private static Map<String, Object> serverPlayerSnapshot(MinecraftClient client) {
        MinecraftServer server = client == null ? null : client.getServer();
        if (server == null || client.player == null) return Map.of("available", false);
        ServerPlayerEntity player = server.getPlayerManager().getPlayer(client.player.getUuid());
        if (player == null) return Map.of("available", false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("name", player.getName().getString());
        out.put("uuid", player.getUuidAsString());
        out.put("x", player.getX());
        out.put("y", player.getY());
        out.put("z", player.getZ());
        out.put("yaw", player.getYaw());
        out.put("pitch", player.getPitch());
        out.put("health", player.getHealth());
        out.put("maxHealth", player.getMaxHealth());
        out.put("hunger", player.getHungerManager().getFoodLevel());
        out.put("saturation", player.getHungerManager().getSaturationLevel());
        out.put("selectedSlot", player.getInventory().selectedSlot);
        List<Map<String, Object>> inventory = new ArrayList<>();
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) continue;
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("slot", slot);
            item.put("itemId", Registries.ITEM.getId(stack.getItem()).toString());
            item.put("count", stack.getCount());
            item.put("componentFingerprint", stack.getComponents().toString());
            inventory.add(item);
        }
        out.put("inventory", inventory);
        out.put("width", player.getWidth());
        out.put("height", player.getHeight());
        out.put("eyeHeight", player.getEyeHeight(player.getPose()));
        out.put("dimension", player.getWorld().getRegistryKey().getValue().toString());
        out.put("worldTick", player.getWorld().getTime());
        return out;
    }

    private static long maxSequence(List<Map<String, Object>> trace) {
        long max = 0;
        for (Map<String, Object> entry : trace) {
            Object value = entry.get("sequence");
            if (value instanceof Number number) max = Math.max(max, number.longValue());
        }
        return max;
    }

    public static Map<String, Object> query(Map<String, Object> body) {
        String kind = String.valueOf(body == null ? "" : body.getOrDefault("kind", "")).toLowerCase(Locale.ROOT);
        if ("registry".equals(kind)) {
            String registryKind = String.valueOf(body.getOrDefault("registryKind", ""));
            String id = String.valueOf(body.getOrDefault("id", ""));
            Identifier identifier;
            try { identifier = Identifier.of(id); } catch (Exception e) { return error("BAD_ID", "无效资源 ID: " + id); }
            boolean exists = switch (registryKind) {
                case "item" -> Registries.ITEM.getIds().contains(identifier);
                case "block" -> Registries.BLOCK.getIds().contains(identifier);
                case "entity" -> Registries.ENTITY_TYPE.getIds().contains(identifier);
                default -> false;
            };
            return Map.of("ok", true, "kind", "registry", "exists", exists, "id", id, "registryKind", registryKind);
        }
        if ("recipe".equals(kind)) {
            String id = String.valueOf(body.getOrDefault("id", ""));
            try {
                Identifier identifier = Identifier.of(id);
                MinecraftClient client = MinecraftClient.getInstance();
                MinecraftServer server = client == null ? null : client.getServer();
                if (server == null) return error("NOT_IN_INTEGRATED_WORLD", "需要已进入单人集成服务器世界");
                boolean exists = server.getRecipeManager().values().stream().anyMatch(entry -> entry.id().equals(identifier));
                return Map.of("ok", true, "kind", "recipe", "supported", true, "id", id, "exists", exists);
            } catch (Exception error) {
                return error("BAD_ID", "无效配方 ID: " + id);
            }
        }
        return error("UNSUPPORTED_QUERY", "不支持的 V2 query kind: " + kind);
    }

    private static boolean isDangerous(String command) {
        String head = command.trim().toLowerCase(Locale.ROOT);
        return head.matches("^(?:stop|save-all|op|deop|ban|pardon|kick|whitelist|publish|reload)(?:\\s|$).*");
    }

    private static int number(Object value) {
        return value instanceof Number n ? n.intValue() : Integer.parseInt(String.valueOf(value));
    }

    private static double doubleValue(Object value) {
        return value instanceof Number n ? n.doubleValue() : Double.parseDouble(String.valueOf(value));
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("code", code);
        out.put("error", message);
        return out;
    }
}
